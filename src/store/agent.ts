import { defineStore } from 'pinia'
import { send, onMessage, type ServerMessage } from '@/services/websocket'
import { conversationApi } from '@/services'
import { useSlidesStore } from './slides'

export interface ToolCallRecord {
  tool: string
  args: Record<string, unknown>
  result?: string
}

export interface TextRecord {
  role: string
  content: string
}

export type AgentLogEntry =
  | { type: 'text', role: string, content: string }
  | { type: 'tool', tool: string, args: Record<string, unknown>, result?: string }
  | { type: 'status', status: string, message: string }

export interface AgentState {
  status: 'idle' | 'thinking' | 'tool_call' | 'done' | 'error'
  statusMessage: string
  log: AgentLogEntry[]
  currentDeckId: number | null
}

export const useAgentStore = defineStore('agent', {
  state: (): AgentState => ({
    status: 'idle',
    statusMessage: '',
    log: [],
    currentDeckId: null,
  }),

  getters: {
    isRunning(state) {
      return state.status === 'thinking' || state.status === 'tool_call'
    },
    toolCalls(state): ToolCallRecord[] {
      return state.log.filter((e): e is AgentLogEntry & { type: 'tool' } => e.type === 'tool')
    },
  },

  actions: {
    init() {
      if ((this as any)._wsInitialized) return
      ;(this as any)._wsInitialized = true
      onMessage((msg: ServerMessage) => this.handleMessage(msg))
    },

    submitTask(deckId: number, prompt: string, selectedElementIds?: string[]) {
      this.status = 'thinking'
      this.statusMessage = '正在处理...'
      this.log = [{ type: 'text', role: 'user', content: prompt }]
      this.currentDeckId = deckId
      send({ type: 'agent.task', deckId, prompt, selectedElementIds })
    },

    cancelTask() {
      send({ type: 'agent.cancel' })
    },

    confirmAsk(value: boolean) {
      send({ type: 'agent.confirm', value })
    },

    handleMessage(msg: ServerMessage) {
      switch (msg.type) {
        case 'agent.status':
          this.status = msg.status
          this.statusMessage = msg.message || ''
          this.log.push({ type: 'status', status: msg.status, message: msg.message || '' })
          break

        case 'agent.tool':
          this.status = 'tool_call'
          this.log.push({ type: 'tool', tool: msg.tool, args: msg.args, result: msg.result })
          break

        case 'agent.text':
          this.log.push({ type: 'text', role: msg.role, content: msg.content })
          break

        case 'agent.deck': {
          const slidesStore = useSlidesStore()
          const slides = JSON.parse(msg.slidesJson)
          slidesStore.setSlides(slides)
          break
        }

        case 'agent.ask':
          this.statusMessage = msg.question
          break

        case 'error':
          this.status = 'error'
          this.statusMessage = msg.message
          this.log.push({ type: 'status', status: 'error', message: msg.message })
          break

        default:
          break
      }
    },

    async loadConversations(deckId: number) {
      const res = await conversationApi.list(deckId) as any
      return res.conversations || []
    },

    async loadMessages(conversationId: number) {
      const res = await conversationApi.get(conversationId) as any
      return res.messages || []
    },
  },
})
