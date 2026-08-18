/**
 * Agent 编排器
 *
 * 接收 WebSocket 的 agent.task 消息，编排多角色执行流程。
 *
 * MVP 模式：
 *   有 selectedElementIds → Editor 直接处理
 *   否则 → Planner → Generator → Reviewer（不过则 Generator 再修一轮）
 */

import { generateText, type LanguageModel } from 'ai'
import { eq, and, desc } from 'drizzle-orm'
import type { ServerWebSocket } from 'bun'
import type { Slide, SlideTheme } from '@/types/slides'
import { db } from '@server/db'
import { decks, conversations, messages } from '@server/db/schema'
import type { AgentRole } from '@server/db/schema'
import type { WsUserData, ServerMessage } from '@server/ws/handler'
import { createAgentTools, type DeckState } from './tools'
import { toHistoryTurns, type HistoryTurn } from './history'
import { resolveModelForRole } from './llm'
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
 * 每个角色的工具调用步数预算。
 *
 * 原来全角色固定 15 —— Generator 做一份 5 页 deck，光 addSlide 就吃掉 5 步，
 * 再加元素和动画必然中途截断，且截断是静默的（没有任何提示）。
 * 按职责分开给：只读角色不需要多，写角色需要充足余量。
 */
const ROLE_MAX_STEPS: Record<AgentRole, number> = {
  planner: 12,
  generator: 48,
  reviewer: 12,
  editor: 24,
}

interface StepToolCall { toolCallId: string, toolName: string, args: Record<string, unknown> }
interface StepToolResult { toolCallId: string, result: unknown }

const activeTasks = new Map<number, AbortController>()

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

const saveMessage = async (conversationId: number, role: 'user' | 'assistant' | 'system', content: string) => {
  await db.insert(messages).values({ conversationId, role, content })
}

/**
 * 一个 deck 一条会话线。
 *
 * 原来每提交一次任务就新建一条 conversation —— 同一份演示文稿的历史被切成互不相干的碎片，
 * 前端按 deckId 查会拿到一堆各含一轮对话的记录，agent 也无从「记得上次做过什么」。
 */
const getOrCreateConversation = async (userId: number, deckId: number) => {
  const existing = await db.select().from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.deckId, deckId)))
    .orderBy(conversations.id)
    .get()
  if (existing) return existing

  return db.insert(conversations).values({ userId, deckId }).returning().get()
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
): Promise<{ text: string, state: DeckState, truncated: boolean }> => {
  const label = ROLE_LABELS[role]
  send(ws, { type: 'agent.status', status: 'thinking', message: `${label} 正在思考...` })
  send(ws, { type: 'agent.text', role, content: `--- ${label} 开始工作 ---` })

  let model: LanguageModel
  try {
    model = await resolveModelForRole(role, userId)
    console.log(`[agent] ${role} → model resolved: ${typeof model === 'string' ? model : model.modelId}`)
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

  const maxSteps = ROLE_MAX_STEPS[role]
  console.log(`[agent] ${role} → calling generateText (maxSteps=${maxSteps}, history=${history.length})...`)
  const result = await withModelContext(role, model, () => generateText({
    model,
    system,
    messages: [...history, { role: 'user', content: prompt }],
    tools,
    maxSteps,
    abortSignal: signal,
    onStepFinish: ({ text, toolCalls, toolResults }) => {
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
      }
    },
  }))

  // 步数耗尽是静默的：SDK 直接返回，agent 以为自己做完了。
  // 不提示的话，用户看到的就是「莫名其妙做了一半」。
  const truncated = result.steps.length >= maxSteps && result.finishReason === 'tool-calls'
  if (truncated) {
    const warn = `${label} 达到步数上限（${maxSteps} 步）后被截断，任务可能未完成`
    console.warn(`[agent] ${role} truncated at maxSteps=${maxSteps}`)
    send(ws, { type: 'agent.text', role, content: `⚠ ${warn}` })
  }

  return { text: result.text, state, truncated }
}

export const runAgentTask = async (
  ws: ServerWebSocket<WsUserData>,
  deckId: number,
  prompt: string,
  selectedElementIds?: string[],
) => {
  const { userId } = ws.data

  if (activeTasks.has(userId)) {
    send(ws, { type: 'error', message: '已有任务在执行中，请等待完成或取消' })
    return
  }

  const loaded = await loadDeckState(deckId, userId)
  if (!loaded) {
    send(ws, { type: 'error', message: '演示文稿不存在' })
    return
  }

  const abort = new AbortController()
  activeTasks.set(userId, abort)

  const conv = await getOrCreateConversation(userId, deckId)
  // 先读历史再存当前这条，否则当前 prompt 会重复出现在 messages 里
  const history = await loadHistory(conv.id)
  await saveMessage(conv.id, 'user', prompt)

  let { state } = loaded

  try {
    if (selectedElementIds?.length) {
      const editorPrompt = `${describeSelection(state, selectedElementIds)}\n\n用户的要求：${prompt}`
      const result = await runRole('editor', userId, editorPrompt, state, ws, abort.signal, history)
      state = result.state
      await saveMessage(conv.id, 'assistant', result.text)
    }
    else {
      const planResult = await runRole('planner', userId, prompt, state, ws, abort.signal, history)
      await saveMessage(conv.id, 'assistant', `[Planner] ${planResult.text}`)

      const genPrompt = `按照以下计划执行：\n${planResult.text}\n\n用户原始需求：${prompt}`
      const genResult = await runRole('generator', userId, genPrompt, state, ws, abort.signal, history)
      state = genResult.state
      await saveMessage(conv.id, 'assistant', `[Generator] ${genResult.text}`)

      try {
        // Reviewer 不给历史：它的职责是拿当前 deck 对照本轮需求，
        // 喂历史只会让它翻出上几轮已经解决的问题
        const reviewPrompt = `请审查 Generator 刚才对演示文稿所做的修改。用户的原始需求是：${prompt}`
        const reviewResult = await runRole('reviewer', userId, reviewPrompt, state, ws, abort.signal)
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
          const fixResult = await runRole('generator', userId, fixPrompt, state, ws, abort.signal)
          state = fixResult.state
          await saveMessage(conv.id, 'assistant', `[Generator 修正] ${fixResult.text}`)
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
    if (abort.signal.aborted) {
      send(ws, { type: 'agent.status', status: 'error', message: '任务已取消' })
    }
    else {
      const msg = err instanceof Error ? err.message : '未知错误'
      send(ws, { type: 'agent.status', status: 'error', message: msg })
    }
    await saveMessage(conv.id, 'system', `错误: ${err instanceof Error ? err.message : '未知错误'}`)
  }
  finally {
    activeTasks.delete(userId)
  }
}

export const cancelAgentTask = (userId: number): boolean => {
  const ctrl = activeTasks.get(userId)
  if (!ctrl) return false
  ctrl.abort()
  activeTasks.delete(userId)
  return true
}
