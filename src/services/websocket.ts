import { ref, readonly } from 'vue'
import { getToken } from './index'

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
   * 取消任务。**必须带 deckId** —— 后端的活动任务按工作区（`deck:<id>`）登记，
   * 不再是「一个用户一个任务」，所以取消要点名取消哪一份演示文稿的任务。
   */
  | { type: 'agent.cancel', deckId: number }
  | { type: 'agent.confirm', value: boolean }

export type ServerMessage =
  | { type: 'agent.status', status: 'thinking' | 'tool_call' | 'done' | 'error', message?: string }
  | { type: 'agent.tool', tool: string, args: Record<string, unknown>, result?: string }
  | { type: 'agent.text', role: string, content: string }
  /** 模型思考过程，逐段流进来。不开 reasoning 的模型一条都不发 */
  | { type: 'agent.reasoning', role: string, delta: string }
  /** 这一步思考结束 —— 收起思考块，接下来是工具调用 */
  | { type: 'agent.reasoning.done', role: string }
  /** 本次任务落在哪条会话上 —— 新建时前端据此挂进列表 */
  | { type: 'agent.conversation', id: number, title: string }
  | { type: 'agent.ask', question: string }
  | { type: 'agent.deck', slidesJson: string, version: number }
  /**
   * 图片资产的进度叙事。**这三条不改画布** —— 后端的图片工具是同步等图的，
   * 图拿到之后由 agent 自己调 addElement 写进 deck，
   * 所以画布仍然只被 `agent.deck` 一条路改（单一权威写者不受影响）。
   *
   * 它们存在只为填上生图那 14~15 秒的沉默：那段时间 `agent.tool` 还没发
   * （后端 onStepFinish 在工具**返回之后**才触发），面板上什么都没有，像卡死了。
   */
  | { type: 'agent.asset.pending', ticket: string, kind: 'search' | 'generate', prompt: string }
  | { type: 'agent.asset.ready', ticket: string, src: string, width: number, height: number }
  | { type: 'agent.asset.failed', ticket: string, reason: string }
  | { type: 'error', message: string }

type MessageHandler = (msg: ServerMessage) => void

const RECONNECT_BASE_DELAY = 1000
const RECONNECT_MAX_DELAY = 30_000

let ws: WebSocket | null = null
let reconnectTimer: number | null = null
let reconnectAttempts = 0
/** 主动登出后不再自动重连，等下次登录显式 connect() */
let stopped = false

const connected = ref(false)
const handlers = new Set<MessageHandler>()

const getWsUrl = (): string => {
  const token = getToken()
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/ws?token=${token}`
}

const cleanup = () => {
  if (ws) {
    ws.onopen = null
    ws.onclose = null
    ws.onmessage = null
    ws.onerror = null
    ws = null
  }
  connected.value = false
}

/**
 * 指数退避重连，不设次数上限。
 *
 * 原来是固定 3 秒重试 10 次，**30 秒后就永久放弃** ——
 * 后端重启一次，编辑器里的 AI 面板从此静默失联，用户完全看不出来。
 * 没有 token（已登出）时不重连。
 */
const scheduleReconnect = () => {
  if (reconnectTimer !== null || stopped) return
  if (!getToken()) return

  const delay = Math.min(RECONNECT_BASE_DELAY * 2 ** reconnectAttempts, RECONNECT_MAX_DELAY)
  reconnectAttempts++
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

export const connect = () => {
  const token = getToken()
  if (!token) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  stopped = false
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  cleanup()

  const socket = new WebSocket(getWsUrl())

  socket.onopen = () => {
    connected.value = true
    reconnectAttempts = 0
  }

  socket.onclose = () => {
    cleanup()
    scheduleReconnect()
  }

  socket.onerror = () => {
    socket.close()
  }

  socket.onmessage = (event) => {
    try {
      const msg: ServerMessage = JSON.parse(event.data)
      handlers.forEach(fn => fn(msg))
    }
    catch {
      // ignore malformed messages
    }
  }

  ws = socket
}

export const disconnect = () => {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  stopped = true
  reconnectAttempts = 0
  if (ws) {
    ws.close()
    cleanup()
  }
}

export const send = (msg: ClientMessage) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

export const onMessage = (handler: MessageHandler) => {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

export const isConnected = readonly(connected)
