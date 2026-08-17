import type { ServerWebSocket } from 'bun'
import { verifyToken, type JwtPayload } from '@server/auth/jwt'

export interface WsUserData {
  userId: number
  username: string
  role: 'admin' | 'user'
}

// TODO: agent 消息协议
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
  raw: string | Buffer,
) => {
  try {
    const msg: ClientMessage = JSON.parse(typeof raw === 'string' ? raw : raw.toString())

    switch (msg.type) {
      case 'agent.task':
        // TODO: 启动 agent 编排
        ws.send(JSON.stringify({
          type: 'agent.status',
          status: 'thinking',
          message: '正在处理...',
        } satisfies ServerMessage))
        break

      case 'agent.cancel':
        // TODO: 取消当前任务
        break

      case 'agent.confirm':
        // TODO: 用户确认 agent 提问
        break

      default:
        ws.send(JSON.stringify({ type: 'error', message: '未知消息类型' } satisfies ServerMessage))
    }
  }
  catch {
    ws.send(JSON.stringify({ type: 'error', message: '消息格式错误' } satisfies ServerMessage))
  }
}
