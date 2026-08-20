/**
 * 「后端问、前端答」的等待器 —— 域无关
 *
 * 后端发一个带 `requestId` 的请求出去，挂起等前端回一条带同一个 id 的答复。
 *
 * ## 它同时是 `agent.confirm` 缺的那个零件
 *
 * `ws/handler.ts` 里 `agent.confirm` 是个空分支，注释写着
 * 「需要后续实现 agent 中途暂停等待机制」。渲染后反思要的正是同一个东西，
 * 所以这个文件放 `runtime/`、做成泛型，不放 deck 域。
 *
 * ## 三条硬规矩
 *
 * **① 永远不 reject，返回 outcome。** 调用方是一个 AI 工具，它必须能
 * 回一句「这次没量到」让 agent 接着往下走。抛异常会变成一次工具调用失败，
 * 而 agent 对失败的反应是重试 —— 重试一个断线的前端只会把步数烧光。
 * 和 `imageSearch.searchImages` / `budget.ts` 对非法环境变量的处置是同一条。
 *
 * **② 超时必须有，而且是硬的。** 11 号文档风险表预告过这条：
 * 「阻塞式确认在 WebSocket 断线时会死锁」。这一版是第一次真的踩到它 ——
 * 没有超时，一次测量会把 agent 永久挂在那儿，表现是任务再无下文、没有任何报错。
 *
 * **③ 对不上的 id 一律丢掉。** 迟到的答复（上一次超时之后才回来的）、
 * 伪造的 id、重复的答复，都不能污染当前这一次。抄 `taskRegistry`
 * 的收据思路：只有仍持有这次登记的那一方才 settle 得了。
 *
 * ## 时钟为什么要能注入
 *
 * 不注入就没法测「超时那一刻」—— 只能真的等几秒，而那种测试要么慢要么脆。
 * `assetTools` 的缓存过期、`rateLimiter` 的滑动窗口都是同一个做法。
 */

export type PendingOutcome<T> =
  | { ok: true, value: T }
  /** 超时。前端没在窗口内回答 —— 断线、页面关掉、渲染卡住都长这样 */
  | { ok: false, reason: 'timeout' }
  /** 被外部作废：任务取消，或者这个连接没了 */
  | { ok: false, reason: 'cancelled' }

export interface PendingRequestsOptions {
  /** 等多久放弃。**必须给**，没有默认值 —— 忘了设就是死锁 */
  timeoutMs: number
  /** 注入定时器。测试里换成假时钟 */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** 注入 id 生成。测试里换成可预测的序列 */
  newId?: () => string
}

export interface OpenedRequest<T> {
  id: string
  /** 等答复。**永远 resolve**，不 reject */
  wait: Promise<PendingOutcome<T>>
}

export interface PendingRequests<T> {
  /** 登记一次请求，拿到 id 和等待句柄 */
  open: () => OpenedRequest<T>
  /**
   * 交答复。返回是否真的落在一次等待上 ——
   * `false` 表示这个 id 不认识（迟到 / 伪造 / 重复），调用方据此打日志
   */
  settle: (id: string, value: T) => boolean
  /** 作废全部在等的（任务取消 / 连接断开）。返回作废了几个 */
  cancelAll: () => number
  /** 还有几个在等。诊断用 */
  size: () => number
}

let seq = 0
const defaultNewId = () => `req_${++seq}_${Math.random().toString(36).slice(2, 8)}`

export const createPendingRequests = <T>({
  timeoutMs,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = h => clearTimeout(h as ReturnType<typeof setTimeout>),
  newId = defaultNewId,
}: PendingRequestsOptions): PendingRequests<T> => {
  interface Entry {
    resolve: (outcome: PendingOutcome<T>) => void
    timer: unknown
  }
  const waiting = new Map<string, Entry>()

  /** 收尾：删登记 + 停表 + resolve。**三件事必须一起做**，漏一件就是泄漏 */
  const finish = (id: string, entry: Entry, outcome: PendingOutcome<T>) => {
    waiting.delete(id)
    clearTimer(entry.timer)
    entry.resolve(outcome)
  }

  return {
    open() {
      const id = newId()
      let resolve!: (outcome: PendingOutcome<T>) => void
      const wait = new Promise<PendingOutcome<T>>((res) => {
        resolve = res
      })

      const timer = setTimer(() => {
        const entry = waiting.get(id)
        if (entry) finish(id, entry, { ok: false, reason: 'timeout' })
      }, timeoutMs)

      waiting.set(id, { resolve, timer })
      return { id, wait }
    },

    settle(id, value) {
      const entry = waiting.get(id)
      // 对不上就什么都不做。**这是正确行为，不是错误** ——
      // 超时之后才回来的答复正是这个情形，此刻接受它会让 agent
      // 拿到一份属于上一次测量的数据
      if (!entry) return false
      finish(id, entry, { ok: true, value })
      return true
    },

    cancelAll() {
      const n = waiting.size
      for (const [id, entry] of [...waiting.entries()]) {
        finish(id, entry, { ok: false, reason: 'cancelled' })
      }
      return n
    },

    size: () => waiting.size,
  }
}
