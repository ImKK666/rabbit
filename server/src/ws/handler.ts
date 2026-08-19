import type { ServerWebSocket } from 'bun'
import { verifyToken, type JwtPayload } from '@server/auth/jwt'
import { runAgentTask, cancelAgentTask } from '@server/agent/orchestrator'

export interface WsUserData {
  userId: number
  username: string
  role: 'admin' | 'user'
}

export type ClientMessage =
  | {
    type: 'agent.task'
    deckId: number
    prompt: string
    selectedElementIds?: string[]
    /** 续哪条会话；不传则新开一条（记忆从零开始） */
    conversationId?: number
  }
  /**
   * 取消任务。**必须带 deckId** —— 活动任务按工作区（`deck:<id>`）登记，
   * 一个用户可以同时在多份演示文稿上跑任务，所以取消要点名取消哪一个。
   */
  | { type: 'agent.cancel', deckId: number }
  | { type: 'agent.confirm', value: boolean }

export type ServerMessage =
  | { type: 'agent.status', status: 'thinking' | 'tool_call' | 'done' | 'error', message?: string }
  | { type: 'agent.tool', tool: string, args: Record<string, unknown>, result?: string }
  | { type: 'agent.text', role: string, content: string }
  /**
   * 模型的思考过程，**逐段流式推送**。
   * 只有开了 reasoning 的模型会产出；没有就一条都不发，前端也就不显示思考块。
   */
  | { type: 'agent.reasoning', role: string, delta: string }
  /** 这一步的思考结束了 —— 前端据此把思考块收起来，腾地方给接下来的工具调用 */
  | { type: 'agent.reasoning.done', role: string }
  /** 告诉前端本次任务落在哪条会话上（新建时前端据此挂进列表） */
  | { type: 'agent.conversation', id: number, title: string }
  | { type: 'agent.ask', question: string }
  | { type: 'agent.deck', slidesJson: string, version: number }
  /**
   * 图片资产的进度叙事。**这三条不改 deck** ——
   * 工具是同步等图的，图拿到之后由 agent 自己调 `addElement` 写进去，
   * 所以权威状态仍然只经 `agent.deck` 一条路（见 `domains/deck/assetTools.ts`）。
   *
   * 它们存在只为填上生图那 14~15 秒的沉默：那段时间里 `agent.tool` 还没发
   * （`onStepFinish` 在工具**返回之后**才触发），面板上什么都没有，看起来像卡死了。
   *
   * 字段和 R-32 当初设计的不一样：原来是 `{elementId, taskId}`，
   * 假设的是「先建元素占位、后台回填」。同步形状下发消息时元素**还不存在**，
   * 所以改成按票据走。
   */
  | { type: 'agent.asset.pending', ticket: string, kind: 'search' | 'generate', prompt: string }
  | { type: 'agent.asset.ready', ticket: string, src: string, width: number, height: number }
  /** 没有这条的话，面板上那个「生成中」会一直转下去 —— 用户看到的是「卡死了」 */
  | { type: 'agent.asset.failed', ticket: string, reason: string }
  | { type: 'error', message: string }

export const authenticateWs = async (url: URL): Promise<JwtPayload | null> => {
  const token = url.searchParams.get('token')
  if (!token) return null
  try {
    return await verifyToken(token)
  }
  catch {
    return null
  }
}

export const handleWsMessage = async (
  ws: ServerWebSocket<WsUserData>,
  raw: string,
) => {
  try {
    const msg: ClientMessage = JSON.parse(raw)

    switch (msg.type) {
      case 'agent.task':
        runAgentTask(ws, msg.deckId, msg.prompt, msg.selectedElementIds, msg.conversationId)
        break

      case 'agent.cancel': {
        const cancelled = cancelAgentTask(msg.deckId)
        ws.send(JSON.stringify({
          type: 'agent.status',
          status: cancelled ? 'error' : 'done',
          message: cancelled ? '任务已取消' : '没有正在执行的任务',
        } satisfies ServerMessage))
        break
      }

      case 'agent.confirm':
        // TODO: 用户确认 agent 提问（需要后续实现 agent 中途暂停等待机制）
        break

      default:
        ws.send(JSON.stringify({ type: 'error', message: '未知消息类型' } satisfies ServerMessage))
    }
  }
  catch {
    ws.send(JSON.stringify({ type: 'error', message: '消息格式错误' } satisfies ServerMessage))
  }
}
