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

/**
 * 面板日志条目。
 *
 * messageId 只有从数据库还原的条目才有 —— 分叉需要它当锚点，
 * 实时流进来的条目在任务结束前拿不到 id（工具调用是流式落库的）。
 */
export type AgentLogEntry =
  | { type: 'text', role: string, content: string, messageId?: number }
  | { type: 'tool', tool: string, args: Record<string, unknown>, result?: string, messageId?: number }
  | { type: 'status', status: string, message: string }
  /**
   * 模型思考过程。`done` 之前一直在追加，面板展开显示；
   * `done` 之后收起来 —— 思考是过程，做完了就不该继续占屏。
   * 只存在于实时流里，**不落库**（重开会话看不到），所以没有 messageId。
   */
  | { type: 'reasoning', role: string, content: string, done: boolean }
  /**
   * 图片资产的进度。
   *
   * 生图要 14~15 秒，而那段时间里工具还没返回 —— 后端的 `onStepFinish`
   * 是在工具**返回之后**才触发的，所以连一条 `agent.tool` 都不会有。
   * 没有这条日志，面板上就是十几秒的纯空白，看起来和卡死一模一样。
   *
   * 同一张图的三个阶段共用**一条**日志（按 ticket 原地改 state），
   * 不是三条独立记录 —— 否则一次配六张图的任务会刷出十八条流水。
   * 也**不落库**（它是叙事不是结果），所以没有 messageId。
   */
  | {
    type: 'asset'
    ticket: string
    kind: 'search' | 'generate'
    prompt: string
    state: 'pending' | 'ready' | 'failed'
    /** ready 时的 `asset://<hash>` */
    src?: string
    /** ready 时是尺寸，failed 时是原因 */
    detail?: string
  }

export interface ConversationMeta {
  id: number
  deckId: number
  title: string
  forkedFromId?: number | null
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface AgentState {
  status: 'idle' | 'thinking' | 'tool_call' | 'done' | 'error'
  statusMessage: string
  log: AgentLogEntry[]
  currentDeckId: number | null
  historyLoading: boolean
  conversations: ConversationMeta[]
  activeConversationId: number | null
}

export const useAgentStore = defineStore('agent', {
  state: (): AgentState => ({
    status: 'idle',
    statusMessage: '',
    log: [],
    currentDeckId: null,
    historyLoading: false,
    conversations: [],
    activeConversationId: null,
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
      // 追加而不是覆盖 —— 同一条会话里多轮对话要能连起来看
      this.log.push({ type: 'text', role: 'user', content: prompt })
      this.currentDeckId = deckId
      // agent 接过这份文稿的所有权：画布锁住，直到任务终止或用户点「接管」。
      // 在**发出请求时**就转移，不等后端回第一条消息 —— 中间那段空窗期
      // 用户照样能拖元素，而那正是要防的丢失
      useSlidesStore().setDeckOwner('agent')
      send({
        type: 'agent.task',
        deckId,
        prompt,
        selectedElementIds,
        // 为 null 表示「新会话」，让后端新建一条，记忆从零开始
        conversationId: this.activeConversationId ?? undefined,
      })
    },

    cancelTask() {
      // 没有 deckId 就没有任务在跑（runTask 一开始就会设它），直接返回。
      // 后端按工作区键登记任务，取消必须点名是哪一份演示文稿
      if (this.currentDeckId === null) return
      send({ type: 'agent.cancel', deckId: this.currentDeckId })
    },

    /**
     * 用户接管这份演示文稿：停掉 agent，画布解锁。
     *
     * **本地先转移所有权，不等后端确认。** 反过来的话，WebSocket 一断
     * `send` 就是空转，画布会永久锁死 —— 一个用鼠标解不开的锁比丢一次改动更糟。
     *
     * 代价是后端任务还在收尾、还会推几条 `agent.deck`。
     * 它们由 `applyAgentDeck` 的对称守卫挡住（所有权已经不在 agent 手上）。
     */
    takeOver() {
      this.cancelTask()
      useSlidesStore().setDeckOwner('user')
      this.status = 'idle'
      this.statusMessage = ''
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
          // 终止事件上把所有权还回来 —— 每次任务恰好收到一条 done 或 error
          // （取消的回执由后端 ws/handler 当场发，正常收尾和出错各一条），
          // 所以这里转移一次、且只转移一次
          if (msg.status === 'done' || msg.status === 'error') {
            useSlidesStore().setDeckOwner('user')
          }
          break

        case 'agent.tool':
          this.status = 'tool_call'
          this.log.push({ type: 'tool', tool: msg.tool, args: msg.args, result: msg.result })
          break

        case 'agent.text':
          this.log.push({ type: 'text', role: msg.role, content: msg.content })
          break

        case 'agent.reasoning': {
          // 同一步的思考往同一个块里追加 —— 一个 delta 一条日志的话，
          // 面板会被几百条一两个字的记录淹掉
          const last = this.log[this.log.length - 1]
          if (last?.type === 'reasoning' && !last.done && last.role === msg.role) {
            last.content += msg.delta
          }
          else {
            this.log.push({ type: 'reasoning', role: msg.role, content: msg.delta, done: false })
          }
          break
        }

        case 'agent.reasoning.done': {
          const last = this.log[this.log.length - 1]
          if (last?.type === 'reasoning') last.done = true
          break
        }

        case 'agent.conversation': {
          // 后端告诉我们本次任务落在哪条会话上。
          // 新会话（前端没传 id）或 id 对不上被纠正时，都走这里。
          this.activeConversationId = msg.id
          const known = this.conversations.find(cv => cv.id === msg.id)
          if (known) {
            known.title = msg.title
            known.updatedAt = new Date().toISOString()
          }
          else if (this.currentDeckId !== null) {
            this.conversations.unshift({
              id: msg.id,
              deckId: this.currentDeckId,
              title: msg.title,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              messageCount: 0,
            })
          }
          break
        }

        case 'agent.deck': {
          // 走权威写入而不是 setSlides：用户点过「接管」之后，
          // 还在路上的这几条属于上一任写者，必须丢掉
          useSlidesStore().applyAgentDeck(JSON.parse(msg.slidesJson))
          break
        }

        case 'agent.asset.pending':
          this.log.push({
            type: 'asset',
            ticket: msg.ticket,
            kind: msg.kind,
            prompt: msg.prompt,
            state: 'pending',
          })
          break

        case 'agent.asset.ready': {
          const entry = this.findAssetEntry(msg.ticket)
          if (entry) {
            entry.state = 'ready'
            entry.src = msg.src
            entry.detail = `${msg.width}×${msg.height}`
          }
          break
        }

        case 'agent.asset.failed': {
          const entry = this.findAssetEntry(msg.ticket)
          if (entry) {
            entry.state = 'failed'
            entry.detail = msg.reason
          }
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

    /**
     * 按票据找回那条资产日志。
     *
     * **从后往前找**：票据是唯一的，但日志可以有几百条，而刚发出 pending
     * 的那条几乎总在末尾。找不到就返回 undefined，什么都不做 ——
     * 取消之后 `pending` 被闸门回收、`ready` 却已经在路上时就是这个情形，
     * 那时凭空补一条「已完成」只会让面板显示一件用户已经叫停的事。
     */
    findAssetEntry(ticket: string) {
      for (let i = this.log.length - 1; i >= 0; i--) {
        const entry = this.log[i]
        if (entry.type === 'asset' && entry.ticket === ticket) return entry
      }
      return undefined
    },

    /** 切换演示文稿时把面板清空 —— log 是全局单例，不清会串台 */
    reset() {
      this.status = 'idle'
      this.statusMessage = ''
      this.log = []
      this.currentDeckId = null
      this.conversations = []
      this.activeConversationId = null
      // 兜底解锁。正常路径上终止事件已经还过所有权了，但 reset 会在
      // 切换文稿、登出、清空历史时调用 —— 那些时刻要是还锁着，
      // 新打开的文稿会带着一把没有任何任务与之对应的锁，谁也解不开
      useSlidesStore().setDeckOwner('user')
    },

    /**
     * 打开某份演示文稿：载入它的会话列表，并展开最近活动的那条。
     *
     * 会话按 deck 隔离，切到别的演示文稿只会看到那一份的记录。
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
        this.conversations = res.conversations || []
        this.activeConversationId = res.activeId ?? null
        this.log = hydrateLog(res.messages || [])
      }
      catch {
        this.conversations = []
        this.activeConversationId = null
        this.log = []
      }
      finally {
        this.historyLoading = false
      }
    },

    /** 切到另一条会话线：换掉日志，agent 的记忆也随之换成那条的 */
    async switchConversation(conversationId: number) {
      if (conversationId === this.activeConversationId) return
      if (this.isRunning) this.cancelTask()

      this.historyLoading = true
      try {
        const res = await conversationApi.get(conversationId) as any
        this.activeConversationId = conversationId
        this.log = hydrateLog(res.messages || [])
        this.status = 'idle'
        this.statusMessage = ''
      }
      finally {
        this.historyLoading = false
      }
    },

    /**
     * 新开一条会话线 —— 记忆从零开始。
     *
     * 不预先建库记录：直接把 activeConversationId 置空，
     * 等用户真正发出第一条消息时后端才建，标题也才有内容可取。
     * 否则点一下「新建」就留一条永远空着的会话。
     */
    startNewConversation() {
      if (this.isRunning) this.cancelTask()
      this.activeConversationId = null
      this.log = []
      this.status = 'idle'
      this.statusMessage = ''
    },

    async renameConversation(conversationId: number, title: string) {
      await conversationApi.rename(conversationId, title)
      const target = this.conversations.find(cv => cv.id === conversationId)
      if (target) target.title = title
    },

    async deleteConversation(conversationId: number) {
      await conversationApi.delete(conversationId)
      this.conversations = this.conversations.filter(cv => cv.id !== conversationId)

      if (this.activeConversationId !== conversationId) return
      // 删掉的正是当前这条：退到剩下最近的一条，没有就进入「新会话」空态
      const next = this.conversations[0]
      if (next) await this.switchConversation(next.id)
      else this.startNewConversation()
    },

    /**
     * 从某条消息分叉出新会话并切过去。
     *
     * 只复制该点之前的对话，**演示文稿不回退** ——
     * 会话是聊天线程，deck 是单一可变文档。
     */
    async forkFrom(messageId: number) {
      if (this.activeConversationId === null) return
      if (this.isRunning) this.cancelTask()

      const res = await conversationApi.fork(this.activeConversationId, messageId) as any
      const forked: ConversationMeta = res.conversation
      this.conversations.unshift(forked)
      await this.switchConversation(forked.id)
    },

    /** 清空当前演示文稿的全部会话，agent 的记忆一并归零 */
    async clearHistory() {
      if (this.currentDeckId === null) return
      await conversationApi.clearDeck(this.currentDeckId)
      this.conversations = []
      this.activeConversationId = null
      this.log = []
      this.status = 'idle'
      this.statusMessage = ''
    },
  },
})

interface StoredMessage {
  id: number
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
}

const hydrateLog = (msgs: StoredMessage[]): AgentLogEntry[] =>
  msgs.map(toLogEntry).filter((e): e is AgentLogEntry => e !== null)

/**
 * DB 里的一条消息 → 面板日志条目。
 *
 * 后端存 assistant 消息时按 `[Planner] xxx` 的形式带了角色前缀，
 * 这里还原成角色标注，好让重新打开时的样式和实时流一致。
 */
const toLogEntry = (msg: StoredMessage): AgentLogEntry | null => {
  if (msg.role === 'user') {
    return { type: 'text', role: 'user', content: msg.content, messageId: msg.id }
  }

  if (msg.role === 'system') {
    return { type: 'status', status: 'error', message: msg.content }
  }

  if (msg.role === 'tool') {
    try {
      const parsed = JSON.parse(msg.content)
      if (typeof parsed?.tool !== 'string') return null
      return {
        type: 'tool',
        tool: parsed.tool,
        args: (parsed.args && typeof parsed.args === 'object') ? parsed.args : {},
        result: typeof parsed.result === 'string' ? parsed.result : undefined,
        messageId: msg.id,
      }
    }
    catch {
      // 脏数据跳过，不能让一条坏记录把整个面板炸掉
      return null
    }
  }

  const matched = msg.content.match(/^\[(Planner|Generator|Reviewer|Generator 修正)\]\s*/)
  if (matched) {
    const role = matched[1].startsWith('Generator') ? 'generator' : matched[1].toLowerCase()
    return { type: 'text', role, content: msg.content.slice(matched[0].length), messageId: msg.id }
  }

  // 没有前缀的是 Editor 路径的产出
  return { type: 'text', role: 'editor', content: msg.content, messageId: msg.id }
}
