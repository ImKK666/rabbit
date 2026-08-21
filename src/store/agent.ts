import { defineStore } from 'pinia'
import { send, onMessage, type ServerMessage } from '@/services/websocket'
import { conversationApi } from '@/services'
import { measureRenderedSlides } from '@/utils/renderMeasure'
import { useSlidesStore } from './slides'

/**
 * 一条用户输入的去向。
 *
 * `pending` 是**前端自己造的**，后端没有这个状态：它表示「已经发出去、
 * 还没收到回执」。存在的理由是配对 —— 每一句输入都会恰好收到一个终局回执
 * （`started` / `rejected`），前端按 FIFO 作用在最早那条 `pending` 上。
 *
 * 按顺序配而不是按文本配：同一句话可以连发两次（「继续」「继续」），
 * 按文本会配错；WebSocket 保序，按顺序天然是对的。
 */
export type DeliveryState =
  | { state: 'pending' }
  | { state: 'queued', position: number }
  | { state: 'rejected', reason: string }

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
  | {
    type: 'text'
    role: string
    content: string
    messageId?: number
    /**
     * 这条用户输入的去向。**只有 `role === 'user'` 的实时条目才有。**
     *
     * 不带这个字段的时候面板会撒谎：`submitTask` 在**发出请求时**
     * 就把用户那句 push 进日志了，工作区忙的话后端只回一条泛泛的 error，
     * 那句话就留在面板上，看起来像是被受理了。
     *
     * `undefined` = 已经在跑或已经跑完（历史里的条目一律是这个）。
     */
    delivery?: DeliveryState
  }
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
  /**
   * R-61：agent 的确认闸门提问。等用户点「是 / 否」，答案经
   * `agent.confirm` 原样带回 requestId。只存在于实时流里，不落库。
   */
  | { type: 'ask', question: string, requestId: string, answer?: boolean }

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
  /**
   * 这个客户端有几个任务真的在跑。
   *
   * 只为一件事存在：**输入被拒时判断要不要收手。** 队列满意味着这份 deck
   * 上有任务在跑，但**不一定是这个客户端发起的**（另一个标签页也能占着）。
   * 那种情况下我们收不到任何 `agent.status`，`submitTask` 设的 `thinking`
   * 会永远转下去，画布也会永远锁着 —— 一把没有任何任务与之对应的锁。
   */
  runningTasks: number
  /**
   * R-61：日志里正在等回答的那条 ask 的下标。null = 没有在等的提问。
   * 面板据此渲染「是 / 否」按钮；回答后置回 null。
   */
  pendingAskIndex: number | null
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
    runningTasks: 0,
    pendingAskIndex: null,
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
      // 追加而不是覆盖 —— 同一条会话里多轮对话要能连起来看。
      // **带 pending 标记**：这句话此刻只是发出去了，还不知道是开跑、
      // 排队还是被拒。收到回执前不许把它显示成已受理
      this.log.push({ type: 'text', role: 'user', content: prompt, delivery: { state: 'pending' } })
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
     * R-61：回答 agent 的确认闸门提问。
     *
     * 本地先落答案再发消息 —— 用户点完按钮那一刻 UI 就该定住，
     * 等后端回执再改状态会让按钮在弱网下显得「点了没反应」。
     * 超时后服务器会把迟到的答复丢掉（那边按 requestId 认领），无害。
     */
    answerAsk(value: boolean) {
      if (this.pendingAskIndex === null) return
      const entry = this.log[this.pendingAskIndex]
      if (!entry || entry.type !== 'ask' || entry.answer !== undefined) return
      entry.answer = value
      send({ type: 'agent.confirm', requestId: entry.requestId, value })
      this.pendingAskIndex = null
      this.statusMessage = ''
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
          /**
           * **只有终止状态进日志。**
           *
           * `thinking` / `tool_call` 是**进度**不是**记录**：它们在跑的时候
           * 由底部那条带动画的进度条显示（读的就是 statusMessage），
           * 跑完之后还留在日志里就纯是噪声 —— 一条「Agent 正在思考...」
           * 挂在已经写完的回答上面，只会让人以为它还在转。
           *
           * 唯一一条有信息量的 thinking（「达到步数上限，正在收尾…」）
           * 不会因此丢掉：收尾轮结束后 pipeline 会补一条 `agent.text`
           * 把同一件事写成永久记录。
           */
          if (msg.status === 'done' || msg.status === 'error') {
            this.log.push({ type: 'status', status: msg.status, message: msg.message || '' })
          }
          // 终止事件上把所有权还回来 —— 每次任务恰好收到一条 done 或 error
          // （取消的回执由后端 ws/handler 当场发，正常收尾和出错各一条），
          // 所以这里转移一次、且只转移一次
          if (msg.status === 'done' || msg.status === 'error') {
            useSlidesStore().setDeckOwner('user')
            this.runningTasks = Math.max(0, this.runningTasks - 1)
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
          // **不为空增量新开一个块。** 后端已经挡了一道（deepseek 会在最后
          // 发一个空 reasoning 分片），这里是第二道 —— 老的后端还连着的时候
          // 也不该在面板上画出「思考完成 0 字」这种空壳
          else if (msg.delta.trim()) {
            this.log.push({ type: 'reasoning', role: msg.role, content: msg.delta, done: false })
          }
          break
        }

        case 'agent.reasoning.done': {
          const last = this.log[this.log.length - 1]
          if (last?.type === 'reasoning') last.done = true
          break
        }

        case 'agent.input': {
          // 按 FIFO 配对，且**要分状态找** —— 理由见 oldestInDelivery 的注释
          if (msg.state === 'started') {
            const entry = this.oldestInDelivery(['pending', 'queued'])
            if (!entry) break
            entry.delivery = undefined
            this.runningTasks++
          }
          else if (msg.state === 'queued') {
            const entry = this.oldestInDelivery(['pending'])
            if (!entry) break
            entry.delivery = { state: 'queued', position: msg.position ?? 1 }
            this.statusMessage = msg.position && msg.position > 1
              ? `已排队，前面还有 ${msg.position - 1} 条`
              : '已排队，下一个就是它'
          }
          else {
            const entry = this.oldestInDelivery(['pending'])
            if (!entry) break
            entry.delivery = { state: 'rejected', reason: msg.reason ?? '未送达' }
            this.settleIfNothingLive()
          }
          break
        }

        case 'agent.render.request':
          /**
           * 后端要量一次真实渲染。**故意不 await** ——
           * handleMessage 是同步的消息分发口，在这里等几秒会把这条连接上
           * 后续的所有消息一起堵住（`agent.deck` 是权威状态，堵住就是画布卡死）。
           *
           * 而且**必须回一条**：后端那边挂着等，不回它只能耗到超时。
           * 所以异常也要变成一条带 error 的答复，而不是一个没人接的 rejection。
           */
          measureRenderedSlides(msg.slideIds, msg.wantShots, msg.wantBackdrop ?? false)
            .then(out => send({ type: 'agent.render.result', requestId: msg.requestId, ...out }))
            .catch(err => send({
              type: 'agent.render.result',
              requestId: msg.requestId,
              measurements: [],
              error: err instanceof Error ? err.message : '测量失败',
            }))
          break

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
          // R-61：确认闸门。进日志并记下下标，面板据此渲染「是 / 否」按钮。
          // 一次任务里最多一条在等 —— 后端每次只挂起一个提问
          this.pendingAskIndex = this.log.push({
            type: 'ask', question: msg.question, requestId: msg.requestId,
          }) - 1
          this.statusMessage = `等待确认：${msg.question}`
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
     * 最早那条处于指定状态的用户消息。
     *
     * **从前往后找**（和 `findAssetEntry` 相反）：回执是 FIFO 的，
     * 最早发出去的那句最先有着落。同一句话连发两次时，按顺序配才配得对。
     *
     * **要分状态找，这一点是实测撞出来的。** 只按「还没有终局回执」找的话：
     *
     * ```
     * A 已开跑  B 排队中  C 刚发出（pending）
     * 收到 C 的 queued → 找到的是 B（它也还没终局），C 永远停在 pending
     * ```
     *
     * 分工是：
     *   - `queued` / `rejected` 只作用在 **pending** 上（一条刚发出去的话有了着落）
     *   - `started` 作用在 **pending 或 queued** 上（可能是直接开跑，也可能是排完队轮到了）
     */
    oldestInDelivery(states: DeliveryState['state'][]) {
      for (const entry of this.log) {
        if (entry.type !== 'text' || entry.role !== 'user') continue
        if (entry.delivery && states.includes(entry.delivery.state)) return entry
      }
      return undefined
    },

    /**
     * 确实没有任何东西在跑了，就收手。
     *
     * 「收手」包括**把画布所有权还回去** —— `submitTask` 在发出请求那一刻
     * 就把所有权交给了 agent，而输入被拒时根本没有任务与之对应。
     * 不还的话画布会一直锁着，且用鼠标解不开。
     */
    settleIfNothingLive() {
      if (this.runningTasks > 0) return
      if (this.oldestInDelivery(['pending', 'queued'])) return
      this.status = 'idle'
      this.statusMessage = ''
      useSlidesStore().setDeckOwner('user')
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
      // 日志清空了，那些 pending / queued 标记指向的条目也没了，
      // 计数不归零的话下一份文稿会带着一个永远减不回 0 的账
      this.runningTasks = 0
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
  /**
   * 模型视角的完整 content 数组（后端 `runtime/turnMemory.ts` 的形状）。
   * 老会话没有这一列，那些行走下面的 `toLogEntry` 文本路径。
   */
  blocksJson?: string | null
}

/** 后端存下来的一块内容。只列面板用得上的字段，其余原样忽略 */
type StoredBlock =
  | { type: 'reasoning', text: string }
  | { type: 'redacted-reasoning', data: string }
  | { type: 'text', text: string }
  | { type: 'tool-call', toolCallId: string, toolName: string, args: Record<string, unknown> }
  | { type: 'tool-result', toolCallId: string, toolName: string, result: unknown }

const parseBlocks = (json: string | null | undefined): StoredBlock[] | null => {
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed as StoredBlock[] : null
  }
  catch {
    return null
  }
}

const stringifyResult = (result: unknown): string =>
  typeof result === 'string' ? result : JSON.stringify(result, null, 2)

/**
 * 库里的消息 → 面板日志。
 *
 * 一次工具调用在存储里是**两条消息**：参数在 assistant 的 `tool-call` 块里，
 * 结果在紧跟着的 tool 消息里。面板要显示成一条，所以这里跨行配对。
 *
 * 存储不提前合并这两样，是因为它必须逐块等于模型看到的东西
 * （后端 `saveModelMessage` 的说明）—— 合并了就对不上，而对得上正是那一版的全部意义。
 * **代价就是这里要配一次对**，这笔账划算：错在这里只是面板显示不好看，
 * 错在那边是下一轮请求 400。
 */
export const hydrateLog = (msgs: StoredMessage[]): AgentLogEntry[] => {
  const out: AgentLogEntry[] = []
  /** 已经看到参数、还在等结果的工具调用 */
  let pending: { toolCallId: string, tool: string, args: Record<string, unknown>, messageId: number }[] = []

  /** 没等到结果的（任务被取消 / 进程退出），照样显示出来，只是没有 result */
  const flushPending = () => {
    for (const p of pending) {
      out.push({ type: 'tool', tool: p.tool, args: p.args, messageId: p.messageId })
    }
    pending = []
  }

  for (const msg of msgs) {
    const blocks = parseBlocks(msg.blocksJson)

    // 没有 blocks 的是这一版之前的老数据，按原来的方式还原
    if (!blocks) {
      flushPending()
      const entry = toLogEntry(msg)
      if (entry) out.push(entry)
      continue
    }

    if (msg.role === 'assistant') {
      flushPending()
      for (const b of blocks) {
        if (b.type === 'reasoning') {
          // 历史里的思考一律是收起状态 —— 它是过程，回看时不该占屏
          out.push({ type: 'reasoning', role: 'deck', content: b.text, done: true })
        }
        else if (b.type === 'text' && b.text) {
          out.push({ type: 'text', role: 'deck', content: b.text, messageId: msg.id })
        }
        else if (b.type === 'tool-call') {
          pending.push({
            toolCallId: b.toolCallId,
            tool: b.toolName,
            args: b.args ?? {},
            messageId: msg.id,
          })
        }
        // redacted-reasoning 是 provider 加密的，看不懂也没法显示，跳过
      }
      continue
    }

    if (msg.role === 'tool') {
      for (const p of pending) {
        const hit = blocks.find(
          (b): b is Extract<StoredBlock, { type: 'tool-result' }> =>
            b.type === 'tool-result' && b.toolCallId === p.toolCallId,
        )
        out.push({
          type: 'tool',
          tool: p.tool,
          args: p.args,
          result: hit ? stringifyResult(hit.result) : undefined,
          // 锚点用 tool 行的 id：从这条分叉时，发起调用的 assistant 也要留下
          messageId: msg.id,
        })
      }
      pending = []
      continue
    }

    // user / system 行没有 blocks 的概念，走文本路径
    flushPending()
    const entry = toLogEntry(msg)
    if (entry) out.push(entry)
  }

  flushPending()
  return out
}

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
