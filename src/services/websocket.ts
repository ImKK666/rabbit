import { ref, readonly } from 'vue'
import { getToken } from './index'

export type ClientMessage =
  | { type: 'agent.task', deckId: number, prompt: string, selectedElementIds?: string[] }
  | { type: 'agent.cancel' }
  | { type: 'agent.confirm', value: boolean }

export type ServerMessage =
  | { type: 'agent.status', status: 'thinking' | 'tool_call' | 'done' | 'error', message?: string }
  | { type: 'agent.tool', tool: string, args: Record<string, unknown>, result?: string }
  | { type: 'agent.text', role: string, content: string }
  | { type: 'agent.ask', question: string }
  | { type: 'agent.deck', slidesJson: string, version: number }
  | { type: 'agent.asset.pending', elementId: string, taskId: string }
  | { type: 'agent.asset.ready', elementId: string, assetUrl: string }
  | { type: 'error', message: string }

type MessageHandler = (msg: ServerMessage) => void

const RECONNECT_DELAY = 3000
const MAX_RECONNECT_ATTEMPTS = 10

let ws: WebSocket | null = null
let reconnectTimer: number | null = null
let reconnectAttempts = 0

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

const scheduleReconnect = () => {
  if (reconnectTimer !== null) return
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return
  reconnectAttempts++
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    connect()
  }, RECONNECT_DELAY)
}

export const connect = () => {
  const token = getToken()
  if (!token) return
  if (ws && ws.readyState === WebSocket.OPEN) return

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
  reconnectAttempts = MAX_RECONNECT_ATTEMPTS
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
