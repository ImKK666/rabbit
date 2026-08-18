/**
 * Agent 编排器
 *
 * 接收 WebSocket 的 agent.task 消息，编排多角色执行流程。
 *
 * MVP 模式：
 *   有 selectedElementIds → Editor 直接处理
 *   否则 → Planner → Generator → Reviewer（不过则 Generator 再修一轮）
 */

import { generateText } from 'ai'
import { eq, and } from 'drizzle-orm'
import type { ServerWebSocket } from 'bun'
import type { Slide, SlideTheme } from '@/types/slides'
import { db } from '@server/db'
import { decks, conversations, messages } from '@server/db/schema'
import type { AgentRole } from '@server/db/schema'
import type { WsUserData, ServerMessage } from '@server/ws/handler'
import { createAgentTools, type DeckState } from './tools'
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

const runRole = async (
  role: AgentRole,
  userId: number,
  prompt: string,
  state: DeckState,
  ws: ServerWebSocket<WsUserData>,
  signal: AbortSignal,
): Promise<{ text: string, state: DeckState }> => {
  const label = ROLE_LABELS[role]
  send(ws, { type: 'agent.status', status: 'thinking', message: `${label} 正在思考...` })
  send(ws, { type: 'agent.text', role, content: `--- ${label} 开始工作 ---` })

  const model = await resolveModelForRole(role, userId)

  const accessor = {
    get: () => state,
    set: (newState: DeckState) => { state = newState },
  }
  const allTools = createAgentTools(accessor)
  const tools = getToolSubset(role, allTools)
  const system = getSystemPrompt(role)

  const result = await generateText({
    model,
    system,
    messages: [{ role: 'user', content: prompt }],
    tools,
    maxSteps: 15,
    abortSignal: signal,
    onStepFinish: ({ text, toolCalls, toolResults }) => {
      if (text) {
        send(ws, { type: 'agent.text', role, content: text })
      }

      if (toolCalls) {
        for (const tc of toolCalls) {
          const toolResult = toolResults?.find((tr: any) => tr.toolCallId === tc.toolCallId)
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
            args: tc.args as Record<string, unknown>,
            result: resultStr,
          })
        }
      }
    },
  })

  return { text: result.text, state }
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

  const conv = await db.insert(conversations)
    .values({ userId, deckId })
    .returning()
    .get()
  await saveMessage(conv.id, 'user', prompt)

  let { state } = loaded

  try {
    if (selectedElementIds?.length) {
      const editorPrompt = `用户选中了元素 ${selectedElementIds.join(', ')}，要求：${prompt}`
      const result = await runRole('editor', userId, editorPrompt, state, ws, abort.signal)
      state = result.state
      await saveMessage(conv.id, 'assistant', result.text)
    }
    else {
      const planResult = await runRole('planner', userId, prompt, state, ws, abort.signal)
      await saveMessage(conv.id, 'assistant', `[Planner] ${planResult.text}`)

      const genPrompt = `按照以下计划执行：\n${planResult.text}\n\n用户原始需求：${prompt}`
      const genResult = await runRole('generator', userId, genPrompt, state, ws, abort.signal)
      state = genResult.state
      await saveMessage(conv.id, 'assistant', `[Generator] ${genResult.text}`)

      try {
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
