/**
 * 渲染后反思工具 —— `reflectRender`
 *
 * D3。一次调用里做两件**性质完全不同**的事，这个区分是整件事的关键：
 *
 * | | 靠什么 | 每次结果 | 能不能当判据 |
 * |---|---|---|---|
 * | **几何测量** | 前端量真实渲染高度 + 现有的 `lintSlide` | **一样** | ✅ 能 |
 * | **视觉复核** | 一个**独立配置的**视觉模型看截图 | 不一样 | ❌ 不能 |
 *
 * 所以几何那半永远跑、并且是这个工具存在的主要理由；
 * 视觉那半是可选增强，没配视觉模型就整个不做。
 * 12 号文档 §六② 定的方向原文：
 * **「代码检查每次结果一样，再叫一次模型每次不一样，一个能当验收判据，另一个不能。」**
 *
 * ## 为什么量这件事必须交给前端
 *
 * `design.ts` 的 `estimateTextHeight` 是估的，版式引擎拿估值累加 `y`。
 * 估小了下一个元素就压上来，而现有检查一条都看不见
 * （`Builder.text()` 把框高夹进画布 → 「超出画布」永不响；
 *  重叠比的是声明的框，而溢出发生在框外面）。
 * 实测 66 张样张 **0 告警**，其中好几张肉眼能看到压字。
 *
 * 换个量法就都看见了 —— 而**能量的只有浏览器**。服务端要么装 playwright
 * （chromium 那笔部署面），要么自己写一个字体排版引擎（等于再造一个浏览器）。
 * 而那台浏览器本来就在：用户就是在那儿看这份稿子的。
 *
 * ## 唯一的新风险：阻塞
 *
 * 11 号文档风险表预告过「阻塞式确认在 WebSocket 断线时会死锁」。
 * 这是第一次真踩到。防线有三道：
 *   1. 硬超时（`pendingRequests`），超时返回「没量到」而不是抛异常
 *   2. 取消时主动作废在等的那些，不干等到超时
 *   3. agent 拿到「没量到」能继续往下走 —— 工具描述里写明了
 *
 * ## 这个文件碰库（读模型配置），所以策略不写在这里
 *
 * 和 `assetTools.ts` 同一条：所有「写错了不会有东西报错」的判断都放在有判据的地方 ——
 * 溢出判定与差集在 `renderReflect.ts`，等待与超时在 `runtime/pendingRequests.ts`。
 * 这里只剩接线。
 */

import { tool, generateText } from 'ai'
import { z } from 'zod'
import type { Slide } from '@/types/slides'
import type { ServerMessage } from '@server/ws/handler'
import { createPendingRequests, type PendingRequests } from '@server/runtime/pendingRequests'
import { resolveModelForRole, inspectRoleModel } from '@server/runtime/llm'
import { reflectOnRender, describeReflection, type TextMeasurement } from './renderReflect'
import { reflectOnContrast, describeContrast, type ContrastSample } from './renderContrast'
import { getSystemPrompt } from './roles'

/** 前端回来的那一包 */
export interface RenderResult {
  measurements: TextMeasurement[]
  shots?: { slideId: string, dataUrl: string }[]
  contrast?: ContrastSample[]
  error?: string
}

/**
 * 等前端多久。
 *
 * 20 秒是按「20 页全量渲染 + 截图」定的：单页离屏渲染实测在几十毫秒量级，
 * 截图（html-to-image）要几百毫秒一张，20 页截完约 5~10 秒。
 * 留一倍余量，又不至于让 agent 在一个已经断线的前端上傻等半分钟。
 *
 * **和搜图那个 8 秒不是一个量级，因为做的事不是一个量级** ——
 * 那边是一次网络请求，这边是一次全量渲染。
 */
const RENDER_TIMEOUT_MS = 20_000

/**
 * 视觉复核最多看几页。
 *
 * 一页一次模型调用，一次十几秒。不设上限的话，一份 30 页的稿子
 * 会让这一个工具跑掉几分钟 —— 而 agent 那边是同步等着的。
 *
 * **超出的部分必须说出来。** 悄悄只看前 6 页、报告里却不提，
 * 读的人会以为整份都复核过了。
 */
const MAX_VISUAL_SLIDES = 6

export interface ReflectToolContext {
  userId: number
  /** 拿当前 deck。工具执行时 deck 可能已经被前面几步改过了 */
  getSlides: () => Slide[]
  emit: (msg: ServerMessage) => void
  /** 任务的取消信号。取消时主动作废在等的请求，不干等到超时 */
  signal: AbortSignal
}

/**
 * 这次装配要不要给这个工具，以及给的是哪一档。
 *
 * 几何那档**永远可用**（不需要任何配置）。视觉那档要一个
 * `reflect` 角色的模型，而且它必须 `supportsVision`（**能读图**）——
 * 配了个没视觉的模型比没配更糟：请求发得出去、会返回一段一本正经的胡话，
 * 而没有任何东西会报错。
 *
 * 用的**不是** `supportsImages`（那是「能出图」，生图模型选择器筛的那个）。
 * 一个模型能画图和能看图是两回事，四种组合都真实存在，见 `db/schema.ts`。
 */
export const reflectVisualAvailable = async (userId: number): Promise<boolean> => {
  const info = await inspectRoleModel('reflect', userId)
  if (!info.ok) {
    console.log(`[reflect] 视觉复核未装配：${info.reason}`)
    return false
  }
  if (!info.supportsVision) {
    console.log('[reflect] 视觉复核未装配：reflect 角色配的模型没有勾「能读图」，本次只做几何测量')
    return false
  }
  return true
}

/**
 * requestId → 在等它的那个等待器。
 *
 * **按 requestId 索引，不按 deckId。** 前端回来的 `agent.render.result`
 * 只带 requestId（它也不该关心 deck），而 requestId 在进程内唯一，
 * 路由信息全在里面 —— 再多带一个 deckId 只是多一处可能对不上的东西。
 *
 * 登记与注销都在 `askFrontend` 里成对做，等待一结束就摘掉，
 * 所以这张表的大小等于「此刻正在等的测量次数」，通常是 0 或 1。
 */
const waitingByRequest = new Map<string, PendingRequests<RenderResult>>()

/**
 * 把前端的答复交给在等它的那次测量。
 *
 * 返回是否真的落在一次等待上 —— `false` 表示这个 requestId 不认识
 * （超时之后才回来的、伪造的、重复的）。**这时什么都不做是正确行为**：
 * 接受它会让 agent 拿到一份属于上一次测量的数据，而那份数据看起来完全正常。
 */
export const settleRenderResult = (requestId: string, result: RenderResult): boolean =>
  waitingByRequest.get(requestId)?.settle(requestId, result) ?? false

export const createReflectTools = (
  ctx: ReflectToolContext,
  { visual }: { visual: boolean },
) => {
  const pending = createPendingRequests<RenderResult>({ timeoutMs: RENDER_TIMEOUT_MS })

  // 取消时叫醒所有在等的。光靠闸门回收下行消息是不够的 ——
  // 前端收不到请求就永远不会回答，那次等待只能耗到超时
  ctx.signal.addEventListener('abort', () => {
    const n = pending.cancelAll()
    if (n > 0) console.log(`[reflect] 任务取消，作废 ${n} 次在等的测量`)
  })

  const askFrontend = async (slideIds: string[], wantShots: boolean, wantBackdrop: boolean) => {
    const { id, wait } = pending.open()
    // 登记与注销成对做。漏掉 finally 就是一条永远留在表里的记录 ——
    // 一次泄漏不影响功能，但它会一直攒
    waitingByRequest.set(id, pending)
    try {
      ctx.emit({ type: 'agent.render.request', requestId: id, slideIds, wantShots, wantBackdrop })
      return await wait
    }
    finally {
      waitingByRequest.delete(id)
    }
  }

  /**
   * 一页一次视觉复核。**不抛异常**，但**「失败」和「没问题」必须分得开**。
   *
   * 上一版这两种情况都返回 `null`，于是汇总时都变成一句
   * 「这几页没挑出问题」——**实测第一次跑就踩上了**：中转的 baseUrl
   * 少一层 `/v1beta`，每一次调用都是 404，而工具报告一片祥和。
   *
   * 这正是这个文件头注释里警告过的那个失败模式（「请求发得出去、
   * 会返回一段一本正经的胡话，而没有任何东西会报错」），只是形态更糟：
   * 连请求都没发成，报告却看不出任何异常。
   *
   * 所以现在返回三态：有意见 / 没问题 / 失败（带原因）。
   */
  type ReviewOutcome =
    | { kind: 'finding', slideIndex: number, text: string }
    | { kind: 'clean', slideIndex: number }
    | { kind: 'failed', slideIndex: number, reason: string }

  const reviewOne = async (slideIndex: number, dataUrl: string): Promise<ReviewOutcome> => {
    try {
      const { model } = await resolveModelForRole('reflect', ctx.userId)
      const { text } = await generateText({
        model,
        system: getSystemPrompt('reflect'),
        abortSignal: ctx.signal,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `这是第 ${slideIndex} 页渲染出来的样子。` },
            { type: 'image', image: new URL(dataUrl) },
          ],
        }],
      })
      const trimmed = text.trim()
      // 「无」是 prompt 里约定的「这页没问题」。一个每次都能挑出毛病的复核器
      // 是没有信息量的，它会逼着 agent 去改本来对的地方
      return trimmed && trimmed !== '无'
        ? { kind: 'finding', slideIndex, text: trimmed }
        : { kind: 'clean', slideIndex }
    }
    catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const hint = /not found|404/i.test(raw)
        ? '（404：多半是 baseUrl 少了版本段，或这个模型名不在该 provider 上）'
        : ''
      console.warn(`[reflect] 第 ${slideIndex} 页视觉复核失败：${raw}${hint}`)
      return { kind: 'failed', slideIndex, reason: raw.split('\n')[0].slice(0, 120) + hint }
    }
  }

  const reflectRender = tool({
    description: [
      '把这几页真正渲染一遍，量出每块文字**实际画到了哪里**，报告文字溢出和由此撑出来的重叠。',
      '',
      '这是 lintDeck 查不到的一类问题：版式引擎的文本高度是**估**出来的，估小了文字会画到框外面，',
      '而 lintDeck 比的是声明的框，所以它永远看不见。整份稿子做完之后跑一次。',
      '',
      '同时会量**每块文字底下实际是什么颜色**，报出真正读不出来的那些。',
      '遮罩浓度是照着背景图的亮度算的，它不知道装饰、色块、装饰层盖在了文字上面 —— 这一条专抓那个。',
      visual
        ? '同时会有一个视觉复核模型看一眼渲染结果，指出套话、该画图表却排成文字、视觉失衡这类问题。'
        : '',
      '',
      '**拿不到测量结果（用户页面没开、超时）时会明说，那时按你自己的判断继续，不要重试。**',
    ].filter(Boolean).join('\n'),
    parameters: z.object({
      slideIds: z.array(z.string()).optional()
        .describe('要检查哪几页的 slideId。不传就是全部。整份做完后建议不传'),
    }),
    execute: async ({ slideIds }) => {
      const slides = ctx.getSlides()
      const targets = slideIds?.length
        ? slides.filter(s => slideIds.includes(s.id))
        : slides
      if (targets.length === 0) {
        return { ok: false, reason: '没有找到要检查的页' }
      }

      // 背景采样**永远要**：它不依赖任何配置（和几何那档一样），
      // 而它专抓的那类问题特征是「所有断言都是绿的」，可选就等于不做
      const outcome = await askFrontend(targets.map(s => s.id), visual, true)

      if (!outcome.ok) {
        // **这里绝不抛异常。** 抛了会变成一次工具调用失败，
        // 而 agent 对失败的反应是重试 —— 重试一个断线的前端只会把步数烧光
        const reason = outcome.reason === 'timeout'
          ? `等了 ${RENDER_TIMEOUT_MS / 1000} 秒没等到浏览器的测量结果（页面可能没开着或已断线）`
          : '测量被取消了'
        return {
          ok: false,
          reason,
          hint: '这次没量到。按你自己的判断继续，不要重试这个工具。',
        }
      }

      if (outcome.value.error) {
        return {
          ok: false,
          reason: `浏览器那边测量失败：${outcome.value.error}`,
          hint: '这次没量到。按你自己的判断继续，不要重试这个工具。',
        }
      }

      const report = reflectOnRender(slides, outcome.value.measurements)
      const geometry = describeReflection(report)

      /**
       * 对比度那一档。**和几何一样是代码判的，每次结果一样，能当判据** ——
       * 和下面视觉复核那档的性质完全不同（见文件头那张表）。
       */
      const contrastReport = reflectOnContrast(slides, outcome.value.contrast ?? [])
      const contrast = describeContrast(contrastReport)
      const base = {
        ok: true as const,
        geometry,
        overflowCount: report.overflows.length,
        contrast,
        lowContrastCount: contrastReport.issues.length,
      }

      const shots = outcome.value.shots ?? []
      if (!visual || shots.length === 0) return base

      // 页码要按整份 deck 算，不是按这次检查的子集算 —— 用户看到的是页码
      const indexOf = new Map(slides.map((s, i) => [s.id, i + 1]))
      const reviewed = shots.slice(0, MAX_VISUAL_SLIDES)
      const skipped = shots.length - reviewed.length

      const outcomes = (await Promise.all(
        reviewed.map(s => reviewOne(indexOf.get(s.slideId) ?? 0, s.dataUrl)),
      )).sort((a, b) => a.slideIndex - b.slideIndex)

      const findings = outcomes.filter(
        (o): o is Extract<ReviewOutcome, { kind: 'finding' }> => o.kind === 'finding')
      const failures = outcomes.filter(
        (o): o is Extract<ReviewOutcome, { kind: 'failed' }> => o.kind === 'failed')

      /**
       * **失败必须说出来，而且要和「没问题」分开说。**
       *
       * 全部失败时绝不能回一句「没挑出问题」—— 那是实测踩过的坑：
       * 每次调用都 404，报告却一片祥和。现在这种情况回的是
       * 「一页都没复核成」+ 原因，agent 和用户都看得见。
       */
      const visualText = failures.length === outcomes.length
        ? `视觉复核**一页都没跑成**（${failures.length}/${outcomes.length}）：${failures[0].reason}`
        : [
          findings.length === 0
            ? '视觉复核：看过的这几页没挑出问题。'
            : ['视觉复核意见：', ...findings.map(o => `【第 ${o.slideIndex} 页】\n${o.text}`)].join('\n'),
          ...(failures.length
            ? [`（另有 ${failures.length} 页没复核成：${failures[0].reason}）`]
            : []),
        ].join('\n')

      return {
        ...base,
        visual: visualText,
        /** 看过几页、成了几页。数字比一句话更难被读漏 */
        visualReviewed: outcomes.length - failures.length,
        visualFailed: failures.length,
        // 悄悄截断会让人以为整份都复核过了
        ...(skipped > 0 ? { note: `视觉复核只看了前 ${MAX_VISUAL_SLIDES} 页，还有 ${skipped} 页没看` } : {}),
      }
    },
  })

  return { tools: { reflectRender }, pending }
}

/**
 * 工具键集合。**从工厂的返回类型推**，不手写 ——
 * 手写一份就有两处会漂开，而漂开时 `toolGroups.ts` 的 `satisfies` 才会报，
 * 报的还是一个绕远的错。
 */
export type ReflectTools = ReturnType<typeof createReflectTools>['tools']

/** 等待器类型，装配层要拿它把前端回来的答复交进去 */
export type RenderPending = PendingRequests<RenderResult>
