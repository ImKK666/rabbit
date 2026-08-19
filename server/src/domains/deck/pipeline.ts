/**
 * deck 域的编排剧本
 *
 * 从 `agent/orchestrator.ts` 整体搬过来（A4b，见 docs/11-agent-roadmap.md）。
 * 搬的理由是分层：这些代码全部是 deck 专属的 —— 剧本、deck 持久化、
 * 会话与消息落库、角色循环 —— 放在装配层里，`domains/deck/` 反而没有 deck 的编排。
 *
 * 留在装配层的只有两样：**任务注册表实例**（跨域共享）和**占坑 / 注销**。
 * 那是「同一份 deck 同时只跑一个任务」这条并发约束，与域无关。
 *
 * ── 为什么没有顺手抽一个泛型的 runTask 骨架 ──
 * 抽骨架要先知道「第二个域会共用什么」，而 research 域还不存在，
 * 现在抽等于照着想象划接缝。08-expressiveness 第九节的教训是
 * 别为想象中的需求建抽象。等 research 落地、能看见真正共用的部分再抽。
 *
 * ── 会话为什么留在 deck 域 ──
 * `conversations.deckId` 是指向 `decks` 的硬外键，会话在**表结构层面**就绑死了 deck。
 * 真正解耦要一次数据迁移（加 `workspace_kind`，默认 `'deck'`），
 * 而在第二个域真的需要会话之前，那次迁移是纯粹的风险。
 * 迁移发生时改的是 schema 和这里的查询，`runtime/` 不受影响 —— 判据 2 仍然成立。
 */

import { streamText, type LanguageModel } from 'ai'
import { eq, and, desc } from 'drizzle-orm'
import type { ServerWebSocket } from 'bun'
import type { Slide, SlideTheme } from '@/types/slides'
import { db } from '@server/db'
import { decks, conversations, messages } from '@server/db/schema'
import type { AgentRole } from '@server/db/schema'
import type { WsUserData, ServerMessage } from '@server/ws/handler'
// 域 → runtime 是允许的方向（反过来不行，由 runtime/__tests__/boundary.test.ts 守）
import { resolveMaxSteps } from '@server/runtime/budget'
import {
  toHistoryTurns,
  makeConversationTitle,
  serializeToolCall,
  type HistoryTurn,
} from '@server/runtime/history'
import { resolveModelForRole, type ResolvedModel } from '@server/runtime/llm'
import { createAgentTools, type DeckState } from './tools'
import { getSystemPrompt, getToolSubset } from './roles'

const DEFAULT_THEME: SlideTheme = {
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
  fontColor: '#333',
  fontName: '',
  backgroundColor: '#fff',
  shadow: { h: 3, v: 3, blur: 2, color: '#808080' },
  outline: { width: 2, color: '#525252', style: 'solid' },
}

const ROLE_LABELS: Record<AgentRole, string> = {
  planner: 'Planner 规划者',
  generator: 'Generator 生成者',
  reviewer: 'Reviewer 审查者',
  editor: 'Editor 编辑者',
}

/**
 * 步数上限触顶后最多再续几轮。
 *
 * 默认上限已经调到实际碰不到的量级（见 budget.ts），所以这个循环正常情况下
 * 一轮都不会跑 —— 它是给「有人把 AGENT_MAX_STEPS 调回小数字」和
 * 「真的遇到超长任务」兜底的。
 *
 * 不设成无限：截断反复发生通常意味着 agent 陷在重试里，
 * 让它无限续下去只是把钱烧得更久。
 */
const MAX_CONTINUATIONS = 3

interface StepToolCall { toolCallId: string, toolName: string, args: Record<string, unknown> }
interface StepToolResult { toolCallId: string, result: unknown }

const send = (ws: ServerWebSocket<WsUserData>, msg: ServerMessage) => {
  ws.send(JSON.stringify(msg))
}

const loadDeckState = async (deckId: number, userId: number): Promise<{ deckRow: typeof decks.$inferSelect, state: DeckState } | null> => {
  const row = await db.select().from(decks)
    .where(and(eq(decks.id, deckId), eq(decks.userId, userId)))
    .get()
  if (!row) return null

  const slides: Slide[] = JSON.parse(row.slidesJson)
  const theme: SlideTheme = row.themeJson ? JSON.parse(row.themeJson) : { ...DEFAULT_THEME }

  return {
    deckRow: row,
    state: { slides, theme, version: row.version },
  }
}

const saveDeckState = async (deckId: number, state: DeckState) => {
  await db.update(decks).set({
    slidesJson: JSON.stringify(state.slides),
    themeJson: JSON.stringify(state.theme),
    version: state.version,
    updatedAt: new Date(),
  }).where(eq(decks.id, deckId))
}

const saveMessage = async (
  conversationId: number,
  role: 'user' | 'assistant' | 'system' | 'tool',
  content: string,
) => {
  await db.insert(messages).values({ conversationId, role, content })
}

/**
 * 定位本次任务写进哪条会话。
 *
 * 前端带 conversationId → 续那条（记忆也从那条载入）
 * 不带                  → 新开一条，标题取首句输入，记忆为空
 *
 * 带了但对不上（多标签页里被删掉之类）不报错，自动新开一条并把新 id 推回前端 ——
 * 让前端自愈，比甩一个错误让用户手动刷新体面。
 */
const resolveConversation = async (
  userId: number,
  deckId: number,
  conversationId: number | undefined,
  prompt: string,
) => {
  if (conversationId !== undefined) {
    const found = await db.select().from(conversations)
      .where(and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
        eq(conversations.deckId, deckId),
      ))
      .get()
    if (found) return found
    console.warn(`[agent] conversation #${conversationId} 不属于 deck #${deckId}，改为新建`)
  }

  return db.insert(conversations)
    .values({ userId, deckId, title: makeConversationTitle(prompt) })
    .returning()
    .get()
}

const touchConversation = async (conversationId: number) => {
  await db.update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
}

/** 带进 LLM 的历史条数上限 */
const HISTORY_LIMIT = 24

/** 取本 deck 的对话历史，作为 agent 的记忆带进下一轮 */
const loadHistory = async (conversationId: number): Promise<HistoryTurn[]> => {
  const rows = await db.select().from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.id))
    .limit(HISTORY_LIMIT)
    .all()

  return toHistoryTurns(rows.reverse())
}

/**
 * 给模型调用的异常补上「是哪个角色、哪个 provider、哪个模型、哪个 baseUrl」。
 *
 * 上游 SDK 对 404 只抛一句 "Not Found"，落到用户界面上完全无从排查
 * （04-changes.md 待确认里那条 Reviewer "Not Found" 就是这么来的）。
 */
const withModelContext = async <T>(
  role: AgentRole,
  model: LanguageModel,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run()
  }
  catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    const desc = (model as { __rabbitDescribe?: string }).__rabbitDescribe
      ?? `model="${typeof model === 'string' ? model : model.modelId}"`
    const raw = err instanceof Error ? err.message : String(err)
    const hint = /not found|404/i.test(raw)
      ? '\n提示：404 通常是模型名不在该 provider 上，或 baseUrl 少了/多了版本段（如 /v1）。'
      : ''
    throw new Error(`[${role}] 模型调用失败：${raw}\n${desc}${hint}`, { cause: err })
  }
}

/**
 * 把选中元素的完整数据直接写进 prompt。
 *
 * 之前只传 id，Editor 必须先 findElements / getSlide 才知道自己在改什么 ——
 * 一次局部微调白白多两轮 LLM 往返。
 */
const describeSelection = (state: DeckState, selectedElementIds: string[]): string => {
  const lines: string[] = []
  for (const id of selectedElementIds) {
    const slide = state.slides.find(s => s.elements.some(e => e.id === id))
    const el = slide?.elements.find(e => e.id === id)
    if (!slide || !el) {
      lines.push(`- ${id}：未找到（可能已被删除）`)
      continue
    }
    const index = state.slides.indexOf(slide)
    lines.push(`- 位于第 ${index + 1} 页（slideId=${slide.id}）：\n${JSON.stringify(el, null, 2)}`)
  }
  return `用户在画布上选中了以下元素，这是它们此刻的完整数据（不必再查）：\n${lines.join('\n')}`
}

const runRole = async (
  role: AgentRole,
  userId: number,
  prompt: string,
  state: DeckState,
  ws: ServerWebSocket<WsUserData>,
  signal: AbortSignal,
  history: HistoryTurn[] = [],
  conversationId?: number,
): Promise<{ text: string, state: DeckState, truncated: boolean }> => {
  const label = ROLE_LABELS[role]
  send(ws, { type: 'agent.status', status: 'thinking', message: `${label} 正在思考...` })
  send(ws, { type: 'agent.text', role, content: `--- ${label} 开始工作 ---` })

  let resolved: ResolvedModel
  try {
    resolved = await resolveModelForRole(role, userId)
    const { model: m } = resolved
    console.log(`[agent] ${role} → model resolved: ${typeof m === 'string' ? m : m.modelId}`)
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : '模型解析失败'
    console.error(`[agent] ${role} model resolution failed:`, msg)
    throw err
  }

  const accessor = {
    get: () => state,
    set: (newState: DeckState) => { state = newState },
    onChange: () => {
      send(ws, {
        type: 'agent.deck',
        slidesJson: JSON.stringify(state.slides),
        version: state.version,
      })
    },
  }
  const allTools = createAgentTools(accessor)
  const tools = getToolSubset(role, allTools)
  const system = getSystemPrompt(role)

  const maxSteps = resolveMaxSteps(role)
  console.log(`[agent] ${role} → calling streamText (maxSteps=${maxSteps}, history=${history.length})...`)

  // 思考块是否处于「打开」状态 —— 只有真收到过 reasoning 才需要在步末发收拢信号。
  // 不开 reasoning 的模型一条都不会发，前端也就不会画出一个空思考块
  let reasoningOpen = false

  const { model, providerOptions } = resolved
  const result = await withModelContext(role, model, async () => {
    const stream = streamText({
      model,
      // 让模型把思考带回来。哪个 provider 需要什么参数见 reasoning.ts；
      // 不需要的 provider 这里是空对象，等于没传
      providerOptions,
      system,
      messages: [...history, { role: 'user', content: prompt }],
      tools,
      maxSteps,
      abortSignal: signal,
      onStepFinish: async ({ text, toolCalls, toolResults }) => {
        if (reasoningOpen) {
          send(ws, { type: 'agent.reasoning.done', role })
          reasoningOpen = false
        }

        if (text) {
          send(ws, { type: 'agent.text', role, content: text })
        }

        // tools 是 Partial<AgentTools>（角色只拿工具子集），
        // SDK 因此把这两个数组的元素推断成 never —— 在这里收窄回可用形状
        const calls = (toolCalls ?? []) as unknown as StepToolCall[]
        const results = (toolResults ?? []) as unknown as StepToolResult[]

        for (const tc of calls) {
          const toolResult = results.find(tr => tr.toolCallId === tc.toolCallId)
          let resultStr: string | undefined
          if (toolResult) {
            try {
              const parsed = typeof toolResult.result === 'string'
                ? JSON.parse(toolResult.result)
                : toolResult.result
              resultStr = JSON.stringify(parsed, null, 2)
            }
            catch {
              resultStr = String(toolResult.result)
            }
          }

          send(ws, {
            type: 'agent.tool',
            tool: tc.toolName,
            args: tc.args,
            result: resultStr,
          })

          // 落库，重开演示文稿时能还原完整的工具流。
          // 不落的话历史里只剩对话文本，看不出 agent 到底动了什么。
          if (conversationId !== undefined) {
            await saveMessage(conversationId, 'tool', serializeToolCall({
              tool: tc.toolName,
              args: tc.args,
              result: resultStr,
            }))
          }
        }
      },
    })

    // **必须把流读干**。text / steps / finishReason 都是 promise，但它们只在流
    // 跑完后才 settle —— 光 await 它们不会驱动流，整个 agent 会永久挂起，
    // 表现就是「XX 开始工作」之后再无下文，没有任何报错。
    //
    // 用 for-await 而不是 consumeStream()：后者会把错误**吞掉**再返回，
    // 之后那三个 promise 就再也不 settle 了 —— 换来的是同一种挂起，只是更难查。
    // 实测坏 API key：for-await 1 秒抛出 AI_APICallError，consumeStream 静静挂死。
    //
    // 思考增量也在这里转发。原来挂 onChunk 也能收到，但流总要读一遍，
    // 读的时候顺手发比多挂一个回调更好懂。
    for await (const part of stream.fullStream) {
      if (part.type === 'reasoning') {
        reasoningOpen = true
        send(ws, { type: 'agent.reasoning', role, delta: part.textDelta })
      }
      else if (part.type === 'error') throw part.error
    }

    const [text, steps, finishReason] = await Promise.all([
      stream.text, stream.steps, stream.finishReason,
    ])
    return { text, steps, finishReason }
  })

  // 步数耗尽是静默的：SDK 直接返回，agent 以为自己做完了。
  // 不提示的话，用户看到的就是「莫名其妙做了一半」。
  const truncated = result.steps.length >= maxSteps && result.finishReason === 'tool-calls'
  if (truncated) {
    console.warn(`[agent] ${role} truncated at maxSteps=${maxSteps}`)
    send(ws, {
      type: 'agent.text',
      role,
      content: `⚠ ${label} 达到步数上限（${maxSteps} 步），未做完 —— 带着当前进度继续`,
    })
  }

  return { text: result.text, state, truncated }
}

/**
 * 跑一个写角色，**直到它自己停下来**。
 *
 * 原来编排器拿到 `truncated` 只发一条警告就往下走了 —— Generator 做到一半，
 * Reviewer 就开始审一份没做完的稿子，然后理所当然地报一堆「缺这缺那」。
 * 截断不是完成，是「还没做完」，该做的是接着做。
 *
 * 续作**不传 history**：要接着做的信息全在 deck 里，agent 自己 getDeck 就看得到。
 * 把上一轮几十条工具调用再塞回去，只会让新一轮从一个已经很满的上下文起步 ——
 * 而清零重来正是「任务长度不受单轮上下文限制」的原因。
 */
const runRoleToCompletion = async (
  role: AgentRole,
  userId: number,
  prompt: string,
  state: DeckState,
  ws: ServerWebSocket<WsUserData>,
  signal: AbortSignal,
  history: HistoryTurn[],
  conversationId: number,
  originalRequest: string,
  /**
   * 落库时的标签，如 `Generator` / `Generator 修正`。传 undefined 则原样存文本。
   * **必须和原来的字符串一致** —— history.ts 的 toHistoryTurns 是按
   * `[Planner]` / `[Reviewer]` 前缀过滤的，标签一改，过滤就漏。
   */
  tag?: string,
): Promise<{ text: string, state: DeckState }> => {
  const save = (text: string, suffix = '') =>
    saveMessage(conversationId, 'assistant', tag ? `[${tag}${suffix}] ${text}` : text)

  let result = await runRole(role, userId, prompt, state, ws, signal, history, conversationId)
  await save(result.text)

  for (let round = 1; result.truncated && round <= MAX_CONTINUATIONS; round++) {
    if (signal.aborted) break

    send(ws, {
      type: 'agent.status',
      status: 'thinking',
      message: `${ROLE_LABELS[role]} 还没做完，继续第 ${round} 轮…`,
    })

    const contPrompt = [
      '你上一轮因为触到步数上限被中断，任务**还没做完**。改动已经保存下来了。',
      '',
      '先 getDeck 看清楚做到哪一步了，然后**接着往下做**：',
      '- 不要从头重来，也不要重复已经建好的页',
      '- 缺哪几页就补哪几页，该精修的再精修',
      '- 全部做完再跑一次 lintDeck',
      '',
      `用户的原始需求：${originalRequest}`,
    ].join('\n')

    result = await runRole(role, userId, contPrompt, result.state, ws, signal, [], conversationId)
    await save(result.text, ` 续作 ${round}`)
  }

  if (result.truncated) {
    send(ws, {
      type: 'agent.text',
      role,
      content: `⚠ 续作 ${MAX_CONTINUATIONS} 轮后仍未做完，先交付当前进度。`
        + '再发一句「接着做完」可以继续，或把需求拆小一点。',
    })
  }

  return { text: result.text, state: result.state }
}

export interface DeckTaskInput {
  ws: ServerWebSocket<WsUserData>
  deckId: number
  prompt: string
  selectedElementIds?: string[]
  conversationId?: number
  /**
   * 取消信号，由装配层从任务注册表拿。
   *
   * 剧本不自己 new AbortController，也不碰注册表：
   * 「同一份 deck 同时只跑一个任务」是**跨域的并发约束**，归 runtime 管；
   * 这里只负责在收到信号时停下来。
   */
  signal: AbortSignal
}

/**
 * deck 域的编排剧本。
 *
 * 有选中元素 → Editor 直接处理
 * 否则       → Planner → Generator → Reviewer（不过则 Generator 再修一轮）
 *
 * 占坑 / 注销由装配层（`agent/orchestrator.ts`）负责，这里进来时已经持有坑位。
 */
export const runDeckTask = async ({
  ws, deckId, prompt, selectedElementIds, conversationId, signal,
}: DeckTaskInput) => {
  const { userId } = ws.data

  const loaded = await loadDeckState(deckId, userId)
  if (!loaded) {
    send(ws, { type: 'error', message: '演示文稿不存在' })
    return
  }

  const conv = await resolveConversation(userId, deckId, conversationId, prompt)
  // 前端据此把新建的会话挂进列表，也用来纠正对不上的 conversationId
  send(ws, { type: 'agent.conversation', id: conv.id, title: conv.title })

  // 先读历史再存当前这条，否则当前 prompt 会重复出现在 messages 里
  const history = await loadHistory(conv.id)
  await saveMessage(conv.id, 'user', prompt)

  let { state } = loaded

  try {
    if (selectedElementIds?.length) {
      const editorPrompt = `${describeSelection(state, selectedElementIds)}\n\n用户的要求：${prompt}`
      const result = await runRoleToCompletion(
        'editor', userId, editorPrompt, state, ws, signal, history, conv.id, prompt,
      ) // 无 tag：Editor 的产物原样落库，和改动前一致
      state = result.state
    }
    else {
      const planResult = await runRole('planner', userId, prompt, state, ws, signal, history, conv.id)
      await saveMessage(conv.id, 'assistant', `[Planner] ${planResult.text}`)

      const genPrompt = `按照以下计划执行：\n${planResult.text}\n\n用户原始需求：${prompt}`
      // 做完才轮到 Reviewer —— 拿一份没做完的稿子去审，报出来的全是「缺这缺那」，
      // 既浪费一轮 Reviewer，又会把 Generator 的修正轮引去补它本来就要补的东西
      const genResult = await runRoleToCompletion(
        'generator', userId, genPrompt, state, ws, signal, history, conv.id, prompt, 'Generator',
      )
      state = genResult.state

      try {
        // Reviewer 不给历史：它的职责是拿当前 deck 对照本轮需求，
        // 喂历史只会让它翻出上几轮已经解决的问题
        const reviewPrompt = `请审查 Generator 刚才对演示文稿所做的修改。用户的原始需求是：${prompt}`
        const reviewResult = await runRole('reviewer', userId, reviewPrompt, state, ws, signal, [], conv.id)
        await saveMessage(conv.id, 'assistant', `[Reviewer] ${reviewResult.text}`)

        let reviewPassed = true
        try {
          const parsed = JSON.parse(reviewResult.text)
          if (parsed.passed === false && parsed.issues?.length) {
            reviewPassed = false
          }
        }
        catch {
          // Reviewer 输出不是 JSON，当做通过
        }

        if (!reviewPassed) {
          send(ws, { type: 'agent.status', status: 'thinking', message: 'Reviewer 发现问题，Generator 正在修正...' })
          const fixPrompt = `Reviewer 发现了以下问题，请修正：\n${reviewResult.text}`
          // 修正轮同样要跑到自己停 —— 修到一半就交付，和没修一样
          const fixResult = await runRoleToCompletion(
            'generator', userId, fixPrompt, state, ws, signal, [], conv.id, prompt, 'Generator 修正',
          )
          state = fixResult.state
        }
      }
      catch (reviewErr) {
        const msg = reviewErr instanceof Error ? reviewErr.message : '审查阶段出错'
        send(ws, { type: 'agent.text', role: 'reviewer', content: `⚠ 审查跳过: ${msg}` })
        await saveMessage(conv.id, 'system', `Reviewer 跳过: ${msg}`)
      }
    }

    await saveDeckState(deckId, state)

    send(ws, {
      type: 'agent.deck',
      slidesJson: JSON.stringify(state.slides),
      version: state.version,
    })
    send(ws, { type: 'agent.status', status: 'done', message: '任务完成' })
  }
  catch (err) {
    console.error('[agent] task failed:', err)
    if (signal.aborted) {
      send(ws, { type: 'agent.status', status: 'error', message: '任务已取消' })
    }
    else {
      const msg = err instanceof Error ? err.message : '未知错误'
      send(ws, { type: 'agent.status', status: 'error', message: msg })
    }
    await saveMessage(conv.id, 'system', `错误: ${err instanceof Error ? err.message : '未知错误'}`)
  }
  finally {
    // 无论成败都刷新时间戳，会话列表按「最近活动」排序才准
    await touchConversation(conv.id)
  }
}

