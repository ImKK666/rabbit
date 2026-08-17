import type { ServerWebSocket } from 'bun'
import { verifyToken, type JwtPayload } from '@server/auth/jwt'
import { runAgentTask, cancelAgentTask } from '@server/agent/orchestrator'

export interface WsUserData {
  userId: number
  username: string
  role: 'admin' | 'user'
}

export type ClientMessage =
  | { type: 'agent.task', deckId: number, prompt: string, selectedElementIds?: string[] }
  | { type: 'agent.cancel' }
  | { type: 'agent.confirm', value: boolean }

export type ServerMessage =
  | { type: 'agent.status', status: 'thinking' | 'tool_call' | 'done' | 'error', message?: string }
  | { type: 'agent.tool', tool: string, args: Record<string, unknown> }
  | { type: 'agent.ask', question: string }
  | { type: 'agent.deck', slidesJson: string, version: number }
  | { type: 'agent.asset.pending', elementId: string, taskId: string }
  | { type: 'agent.asset.ready', elementId: string, assetUrl: string }
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
        runAgentTask(ws, msg.deckId, msg.prompt, msg.selectedElementIds)
        break

      case 'agent.cancel': {
        const cancelled = cancelAgentTask(ws.data.userId)
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
