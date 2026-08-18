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
  historyLoading: boolean
}

export const useAgentStore = defineStore('agent', {
  state: (): AgentState => ({
    status: 'idle',
    statusMessage: '',
    log: [],
    currentDeckId: null,
    historyLoading: false,
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
      // 追加而不是覆盖 —— 同一份演示文稿里多轮对话要能连起来看
      this.log.push({ type: 'text', role: 'user', content: prompt })
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

    /** 切换演示文稿时把面板清空 —— log 是全局单例，不清会串台 */
    reset() {
      this.status = 'idle'
      this.statusMessage = ''
      this.log = []
      this.currentDeckId = null
    },

    /**
     * 打开某份演示文稿时载入它自己的会话历史。
     *
     * 会话按 deck 隔离：切到别的演示文稿只会看到那一份的记录。
     */
    async openDeck(deckId: number) {
      // 任务跑到一半切走演示文稿，旧任务的 agent.deck 会把新打开的这份整份覆盖掉
      if (this.isRunning && this.currentDeckId !== null && this.currentDeckId !== deckId) {
        this.cancelTask()
      }
      this.reset()
      this.currentDeckId = deckId
      this.historyLoading = true
      try {
        const res = await conversationApi.byDeck(deckId) as any
        this.log = (res.messages || [])
          .map(toLogEntry)
          .filter((e: AgentLogEntry | null): e is AgentLogEntry => e !== null)
      }
      catch {
        this.log = []
      }
      finally {
        this.historyLoading = false
      }
    },

    /** 清空当前演示文稿的会话历史，agent 的记忆一并归零 */
    async clearHistory() {
      if (this.currentDeckId === null) return
      await conversationApi.clearDeck(this.currentDeckId)
      this.log = []
      this.status = 'idle'
      this.statusMessage = ''
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

interface StoredMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/**
 * DB 里的一条消息 → 面板日志条目。
 *
 * 后端存 assistant 消息时按 `[Planner] xxx` 的形式带了角色前缀，
 * 这里还原成角色标注，好让重新打开时的样式和实时流一致。
 */
const toLogEntry = (msg: StoredMessage): AgentLogEntry | null => {
  if (msg.role === 'user') return { type: 'text', role: 'user', content: msg.content }

  if (msg.role === 'system') {
    return { type: 'status', status: 'error', message: msg.content }
  }

  const matched = msg.content.match(/^\[(Planner|Generator|Reviewer|Generator 修正)\]\s*/)
  if (matched) {
    const role = matched[1].startsWith('Generator') ? 'generator' : matched[1].toLowerCase()
    return { type: 'text', role, content: msg.content.slice(matched[0].length) }
  }

  // 没有前缀的是 Editor 路径的产出
  return { type: 'text', role: 'editor', content: msg.content }
}
