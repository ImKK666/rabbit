/**
 * 生成装饰层工具 —— `addOrnament`
 *
 * 把 docs/14 那条链路接起来。**这个文件只做接线**，
 * 所有「写错了不会有东西报错」的判断都在有判据的地方：
 *
 * | 判断 | 在哪 | 判据 |
 * |---|---|---|
 * | 负空间提示词怎么拼 | `ornament.ts` | `__tests__/ornament.test.ts` |
 * | 占用矩形内不许有墨（O1） | `ornament.ts` | 同上，阈值拿真样本标定 |
 * | 抠图保色保线（O3/O4/O5） | `runtime/chromaKey.ts` | `runtime/__tests__/chromaKey.test.ts` |
 * | 生成失败怎么认（O2） | `runtime/chromaKey.ts` | 同上 |
 * | 体积（O8） | `runtime/imageCodec.ts` 的 `encodeRgbaPng` | 实测 207 KB/页 |
 *
 * ## 一整条链路上唯一的模型决策是「画什么花纹」
 *
 * 构图（画在哪、哪里必须空）来自 `applyLayout` 已经定好的坐标；
 * 配色来自 theme 的锚点色，由代码注入。**模型只填负空间里的纹样。**
 * 这是 11 号文档那条红线（不往排版层加自由度）在这条路上的落法。
 *
 * ## 失败一律降级，绝不抛
 *
 * 装饰层是**增强不是必需**，而「默认开」意味着每次生成都依赖 N 次外部调用。
 * 一次网络抖动不该毁掉整轮 —— 所以每一步失败都返回一句说得清的话，
 * 让 agent 接着往下走。理由同 `assetTools.ts`：
 * 「一个永远返回『未接入』的工具只会白白消耗步数预算」，
 * 但一个**会抛异常**的工具更糟 —— agent 对失败的反应是重试。
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { Slide } from '@/types/slides'
import type { ServerMessage } from '@server/ws/handler'
import { generateImage as callGenerateImage } from '@server/runtime/imageGenerate'
import { decodeImage, encodeRgbaPng, compressImage } from '@server/runtime/imageCodec'
import { chromaKey, keyedLooksUsable, MIN_TRANSPARENT_RATIO } from '@server/runtime/chromaKey'
import { imageRateLimiter, modelRateKey } from '@server/runtime/rateLimiter'
import {
  openAssetStorage, loadImageModel, loadAssetSourceRow, type ImageModelRuntime,
} from '@server/runtime/assetConfig'
import {
  occupiedRectsOf, buildOrnamentPrompt, lintOrnament, describeOrnamentIssues,
} from './ornament'
import {
  calmZonesOf, buildBackdropPrompt, lintBackdropCalm, describeCalmIssues,
} from './backdrop'

export interface OrnamentToolContext {
  userId: number
  /**
   * **没有 `deckId`，这是刻意的。**
   *
   * `assetTools` 要它是为了往 `assets` 票据表落一行。装饰层不建票据 ——
   * 它不是「用户要的一张图」，是版式的一部分，没有署名/合规/复用的需求。
   * 收一个用不到的字段，就得让装配层一路把它穿进来，而 `runTurn` 那一层
   * 本来就没有 deckId（它在外面那一层）。
   */
  getSlides: () => Slide[]
  /** 三个锚点色。由装配层从 theme 取，工具不自己碰主题 */
  getAnchorColors: () => string[]
  emit: (msg: ServerMessage) => void
}

/** 一次调用最多做几页。默认开 + 每页 15 秒，不设上限会让一个工具跑掉几分钟 */
const MAX_SLIDES_PER_CALL = 6

export interface OrnamentOutcome {
  slideId: string
  ok: boolean
  /** 成功时的 `asset://<hash>` */
  src?: string
  bytes?: number
  reason?: string
}

/**
 * 判据不过时**内部**重试几次。
 *
 * ## 为什么值得重试，而工具描述里却写着「不要重试」
 *
 * 两者说的不是一件事。**agent 不该重试**，因为它分辨不了成败 ——
 * 它看不见像素。而这里能：O1/O2 是机器判的，一次失败可以确定地识别出来。
 *
 * 而失败确实是**随机的**：实测同一段提示词，模型有时老老实实避开留空矩形，
 * 有时画满整页。既然判据能分辨，重抽一次比把这一页丢掉划算。
 *
 * 只重试**判据不过**，不重试网络错误和限流 —— 那两种重试是在给已经拥堵的
 * 上游继续加压，而且 `assetTools` 的教训写得很清楚：撞 429 之后该做的是改用别的路。
 */
const MAX_ATTEMPTS = 2

const attemptOnce = async (
  slide: Slide,
  colors: string[],
  model: ImageModelRuntime,
  store: NonNullable<Awaited<ReturnType<typeof openAssetStorage>>>,
): Promise<OrnamentOutcome & { retriable?: boolean }> => {
  const rects = occupiedRectsOf(slide)
  const prompt = buildOrnamentPrompt({ rects, colors })

  // 限流在**打上游之前**，超限不消耗名额。和 assetTools 走同一个限流器和同一个键 ——
  // 两条路打的是同一个模型，各算各的等于把配额翻倍，实测会撞上游 429
  const decision = imageRateLimiter.tryAcquire(
    modelRateKey(model.modelConfigId), model.rateLimitPerMin,
  )
  if (!decision.allowed) {
    return { slideId: slide.id, ok: false, reason: `被限流，${decision.retryAfterSec} 秒后再试` }
  }

  const out = await callGenerateImage({
    baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.modelName,
    prompt, aspectRatio: '16:9',
  })
  if (!out.ok || !out.bytes) {
    if (out.rateLimited) imageRateLimiter.block(modelRateKey(model.modelConfigId), 60)
    return { slideId: slide.id, ok: false, reason: out.rateLimited ? '上游配额耗尽' : (out.error ?? '生图失败') }
  }

  let decoded
  try { decoded = decodeImage(out.bytes) }
  catch (err) { return { slideId: slide.id, ok: false, reason: `解码失败：${err instanceof Error ? err.message : err}` } }

  const keyed = chromaKey(decoded.rgba, decoded.width, decoded.height)

  // O2：模型没照要求画在纯色底上（棋盘格 / 白底 / 直接画了张照片）
  if (!keyedLooksUsable(keyed)) {
    const ratio = (100 * keyed.transparent / (keyed.width * keyed.height)).toFixed(1)
    return {
      slideId: slide.id, ok: false, retriable: true,
      reason: `产物不是「纯色底 + 稀疏装饰」那个形状（抠完只有 ${ratio}% 透明，要求 ≥${MIN_TRANSPARENT_RATIO * 100}%）`,
    }
  }

  // O1：压到文字或图片上了
  const issues = lintOrnament(keyed, rects)
  if (issues.length > 0) {
    return { slideId: slide.id, ok: false, retriable: true, reason: describeOrnamentIssues(issues) }
  }

  const png = encodeRgbaPng(keyed.rgba, keyed.width, keyed.height)
  try {
    const put = await store.store.put(png, '', 'image/png')
    const hash = put.key.split('/').pop() ?? ''
    return { slideId: slide.id, ok: true, src: `asset://${hash}`, bytes: png.byteLength }
  }
  catch (err) {
    return { slideId: slide.id, ok: false, reason: `上传失败：${err instanceof Error ? err.message : err}` }
  }
}

const runOne = async (
  slide: Slide,
  colors: string[],
  model: ImageModelRuntime,
  store: NonNullable<Awaited<ReturnType<typeof openAssetStorage>>>,
): Promise<OrnamentOutcome> => {
  let last: OrnamentOutcome & { retriable?: boolean } = {
    slideId: slide.id, ok: false, reason: '没有尝试',
  }
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    last = await attemptOnce(slide, colors, model, store)
    if (last.ok || !last.retriable) break
    console.log(`[ornament] ${slide.id} 第 ${i + 1} 次判据不过，重抽：${last.reason?.split('\n')[0]}`)
  }
  const { retriable: _r, ...rest } = last
  return rest
}

/**
 * 底图的一次尝试。
 *
 * 和装饰层是**两条不同的链路**，共用的只有「取模型 / 限流 / 存储」这三样：
 *
 * - **不抠图**。底图垫在内容之下，不透明 —— 抠图的所有风险（褪色、丢线、撞色）
 *   在这条路上根本不存在
 * - **走 JPEG**。不透明图能压，实测 984 KB → **110 KB**；
 *   而装饰层因为要保 alpha 只能走无损 PNG（207 KB）
 * - **判的是「花不花」不是「压没压」**。文字压在底图上是本来就要发生的事，
 *   问题只在于那块地方是不是均匀到文字读得出来
 */
const attemptBackdrop = async (
  slide: Slide,
  colors: string[],
  model: ImageModelRuntime,
  store: NonNullable<Awaited<ReturnType<typeof openAssetStorage>>>,
): Promise<OrnamentOutcome & { retriable?: boolean }> => {
  const zones = calmZonesOf(slide)
  const prompt = buildBackdropPrompt({ rects: zones, colors })

  const decision = imageRateLimiter.tryAcquire(
    modelRateKey(model.modelConfigId), model.rateLimitPerMin,
  )
  if (!decision.allowed) {
    return { slideId: slide.id, ok: false, reason: `被限流，${decision.retryAfterSec} 秒后再试` }
  }

  const out = await callGenerateImage({
    baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.modelName,
    prompt, aspectRatio: '16:9',
  })
  if (!out.ok || !out.bytes) {
    if (out.rateLimited) imageRateLimiter.block(modelRateKey(model.modelConfigId), 60)
    return { slideId: slide.id, ok: false, reason: out.rateLimited ? '上游配额耗尽' : (out.error ?? '生图失败') }
  }

  let decoded
  try { decoded = decodeImage(out.bytes) }
  catch (err) { return { slideId: slide.id, ok: false, reason: `解码失败：${err instanceof Error ? err.message : err}` } }

  const issues = lintBackdropCalm(decoded.rgba, decoded.width, decoded.height, zones)
  if (issues.length > 0) {
    return { slideId: slide.id, ok: false, retriable: true, reason: describeCalmIssues(issues) }
  }

  // 不透明 → 走 JPEG。这一步顺手把长边压到 maxEdgePx 之内
  const packed = compressImage(out.bytes, { maxEdgePx: 1600 })
  try {
    const put = await store.store.put(packed.bytes, '', packed.contentType)
    const hash = put.key.split('/').pop() ?? ''
    return { slideId: slide.id, ok: true, src: `asset://${hash}`, bytes: packed.bytes.byteLength }
  }
  catch (err) {
    return { slideId: slide.id, ok: false, reason: `上传失败：${err instanceof Error ? err.message : err}` }
  }
}

const runBackdrop = async (
  slide: Slide,
  colors: string[],
  model: ImageModelRuntime,
  store: NonNullable<Awaited<ReturnType<typeof openAssetStorage>>>,
): Promise<OrnamentOutcome> => {
  let last: OrnamentOutcome & { retriable?: boolean } = { slideId: slide.id, ok: false, reason: '没有尝试' }
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    last = await attemptBackdrop(slide, colors, model, store)
    if (last.ok || !last.retriable) break
    console.log(`[backdrop] ${slide.id} 第 ${i + 1} 次判据不过，重抽`)
  }
  const { retriable: _r, ...rest } = last
  return rest
}

/** 两个工具共用的前置：取模型 + 取存储。任一不到位就明说，不抛 */
const prepare = async () => {
  const source = await loadAssetSourceRow()
  if (!source?.generateEnabled) return { ok: false as const, reason: '生图开关没开' }
  const resolved = await loadImageModel(source.imageModelConfigId)
  if (!resolved.ok) return { ok: false as const, reason: resolved.error }
  const store = await openAssetStorage()
  if (!store) return { ok: false as const, reason: '对象存储未装配' }
  return { ok: true as const, model: resolved.model, store }
}

export const createOrnamentTools = (ctx: OrnamentToolContext) => ({
  addOrnament: tool({
    description: [
      '为指定的几页生成一层**装饰纹样**（细线、角标、平行条这类），叠在已排好的版面之上增加质感。',
      '',
      '构图不用你决定：工具会读这一页已有元素的坐标，自动告诉生图模型「哪些矩形必须留空」，',
      '配色也自动用当前主题的锚点色。**所以排完版之后再调它**，排版没定的话装饰会躲错地方。',
      '',
      '返回每页一个 asset:// 地址。拿到之后用 addElement 加成图片元素，',
      '位置铺满整页（left 0, top 0, width 1000, height 562.5），并放在最上层。',
      '',
      '慢（每页约 15 秒）且有配额。某一页失败会说明原因并跳过，**不要重试**，整份稿子照常交付。',
    ].join('\n'),
    parameters: z.object({
      slideIds: z.array(z.string()).min(1).max(MAX_SLIDES_PER_CALL)
        .describe(`要加装饰的页，最多 ${MAX_SLIDES_PER_CALL} 页`),
    }),
    execute: async ({ slideIds }) => {
      const prep = await prepare()
      if (!prep.ok) return JSON.stringify({ ok: false, reason: prep.reason })
      const { model, store } = prep

      const slides = ctx.getSlides()
      const targets = slides.filter(s => slideIds.includes(s.id)).slice(0, MAX_SLIDES_PER_CALL)
      if (targets.length === 0) return JSON.stringify({ ok: false, reason: '没有找到这些页' })

      const colors = ctx.getAnchorColors()
      const results: OrnamentOutcome[] = []
      for (const slide of targets) {
        ctx.emit({ type: 'agent.status', status: 'tool_call', message: `生成第 ${slides.indexOf(slide) + 1} 页的装饰层…` })
        results.push(await runOne(slide, colors, model, store))
      }

      const ok = results.filter(r => r.ok)
      return JSON.stringify({
        ok: ok.length > 0,
        // 成功和失败都要说出来 —— 悄悄少做几页会被当成做过了
        done: ok.map(r => ({ slideId: r.slideId, src: r.src, bytes: r.bytes })),
        failed: results.filter(r => !r.ok).map(r => ({ slideId: r.slideId, reason: r.reason })),
        hint: ok.length > 0
          ? '用 addElement 把每个 src 加成铺满整页的图片元素（left 0, top 0, width 1000, height 562.5），放最上层。'
          : '这次一页都没做成。按你自己的判断继续，不要重试。',
      })
    },
  }),

  generateBackdrop: tool({
    description: [
      '为指定的几页生成一张**版面底图**，铺满整页垫在所有内容**下面**，让页面从「干净但平」变成有层次。',
      '',
      '画的是：带阴影的面板、色块分区、极淡的网格纹理、细装饰线、渐变。**不含任何文字**。',
      '工具会读这一页已有元素的坐标，自动要求「内容所在的区域保持安静（均匀浅色）」，',
      '并在生成后**实测**那几块的亮度跨度 —— 太花就重抽，绝不交一张会让文字看不见的底图。',
      '',
      '返回每页一个 asset:// 地址。拿到之后用 setSlideBackground 设成',
      '`{ type: "image", image: { src, size: "cover" } }`。',
      '',
      '**排完版之后再调**，排版没定的话安静区会留错地方。慢（每页约 15 秒）且有配额。',
      '和 addOrnament 是两件事：这个垫在下面给底子，那个压在上面加线条装饰，可以只用一个。',
    ].join('\n'),
    parameters: z.object({
      slideIds: z.array(z.string()).min(1).max(MAX_SLIDES_PER_CALL)
        .describe(`要加底图的页，最多 ${MAX_SLIDES_PER_CALL} 页`),
    }),
    execute: async ({ slideIds }) => {
      const prep = await prepare()
      if (!prep.ok) return JSON.stringify({ ok: false, reason: prep.reason })
      const { model, store } = prep

      const slides = ctx.getSlides()
      const targets = slides.filter(s => slideIds.includes(s.id)).slice(0, MAX_SLIDES_PER_CALL)
      if (targets.length === 0) return JSON.stringify({ ok: false, reason: '没有找到这些页' })

      const colors = ctx.getAnchorColors()
      const results: OrnamentOutcome[] = []
      for (const slide of targets) {
        ctx.emit({ type: 'agent.status', status: 'tool_call', message: `生成第 ${slides.indexOf(slide) + 1} 页的底图…` })
        results.push(await runBackdrop(slide, colors, model, store))
      }

      const ok = results.filter(r => r.ok)
      return JSON.stringify({
        ok: ok.length > 0,
        done: ok.map(r => ({ slideId: r.slideId, src: r.src, bytes: r.bytes })),
        failed: results.filter(r => !r.ok).map(r => ({ slideId: r.slideId, reason: r.reason })),
        hint: ok.length > 0
          ? '用 setSlideBackground 把每个 src 设成 { type:"image", image:{ src, size:"cover" } }。'
          : '这次一页都没做成。按你自己的判断继续，不要重试。',
      })
    },
  }),
})

export type OrnamentTools = ReturnType<typeof createOrnamentTools>
