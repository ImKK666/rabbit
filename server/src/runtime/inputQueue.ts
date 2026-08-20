/**
 * 排队输入 —— 域无关
 *
 * 管一件事：**任务在跑的时候用户又发了一句，那句话存哪儿。**
 *
 * ## 为什么需要它
 *
 * `taskRegistry.cancel()` 只 abort 不 release，注销由任务自己收尾时凭收据做。
 * 那份代码的注释自己写着（`taskRegistry.ts:99`）：
 *
 * > 代价是取消之后到任务真正收尾之间，这个键仍然是「占用中」，
 * > 用户此刻重发会收到「已有任务在执行中」。**这是对的**
 *
 * 那句话是对的，但它描述的是一个**没有出口的正确**：用户点了停、立刻改口，
 * 拿到的是一句拒绝。这个文件就是那个出口 —— 不拆闸门，在闸门外面放一个队列。
 *
 * ## 为什么队列在后端，不在前端
 *
 * 因为它必须跨过 BitFun 说的那个 `FINISHING` 窗口（见 docs/10 §1.5），
 * 而**只有后端知道那个窗口什么时候关**。前端只能靠「有没有收到 done」猜，
 * 而 done 发出之后 `channel.drain()` / `touchConversation` 还在跑 ——
 * 那段时间里放新任务进来，就是排队的输入和上一轮的收尾写入抢跑。
 *
 * ## 为什么是泛型，而且不知道 ws 是什么
 *
 * 和 `taskRegistry` 同一条边界：`runtime/` 不许知道域，也不许知道装配层。
 * 排队项里装着 WebSocket 引用是**装配层**的事，这里只知道「一个键对一队东西」。
 * 断线清理因此做成 `dropWhere(谓词)`，由调用方自己判断哪些项归自己。
 *
 * ## 三个刻意的选择
 *
 * **① 满了返回 null，不抛错。** 和 `taskRegistry.acquire` 一致：
 * 手快连发五句是正常的用户操作，调用方要做的是给一句提示，不是当异常处理。
 *
 * **② 清空 / 丢弃都把被丢掉的项**返回**给调用方。**
 * 静默丢掉排队的输入正是这个仓库的典型失败模式 —— 用户发了一句话，
 * 它消失了，没有任何东西报错。返回它们，调用方才有机会说一声。
 *
 * **③ 空队列从 Map 里删掉。** 不删的话 `keys()` 会越攒越多，
 * 一个开过又关掉的 deck 永远留一条空记录。
 */

import type { WorkspaceKey } from './taskRegistry'

export interface EnqueueResult {
  /** 排在第几位，1 表示「下一个就是它」。给用户看的话术用得上 */
  position: number
}

/** 每个工作区最多排几条。拍的值，理由见 docs/13 §八 待确认 */
export const DEFAULT_MAX_PER_KEY = 3

export class InputQueue<T> {
  private readonly queues = new Map<WorkspaceKey, T[]>()

  constructor(private readonly maxPerKey: number = DEFAULT_MAX_PER_KEY) {}

  /**
   * 排到队尾。
   *
   * 满了返回 `null` —— 调用方据此给一句「排队已满」，
   * 而不是把这条输入静默丢掉（见头注释②）。
   */
  enqueue(key: WorkspaceKey, item: T): EnqueueResult | null {
    // **上限检查在建队之前。** 上一版把「队列还不存在」当成一条捷径直接塞进去，
    // 于是 `maxPerKey = 0`（配置成「完全不排队」）时第一条照样进得来 ——
    // 一个设成 0 的上限不起作用，而且不会有任何东西报错。
    // 由 taskGate 的「被拒的那条只有 rejected」一条抓出来的
    const queue = this.queues.get(key) ?? []
    if (queue.length >= this.maxPerKey) return null

    queue.push(item)
    this.queues.set(key, queue)
    return { position: queue.length }
  }

  /**
   * 取队首。空队列返回 `undefined`。
   *
   * **调用方必须在 `taskRegistry.release()` 之后才调它** ——
   * 提前取就是和上一轮的收尾写入抢跑。这条约束没法在本文件里强制，
   * 由 `inputQueue.test.ts` 的「接力时机」一组和端到端判据守着。
   */
  take(key: WorkspaceKey): T | undefined {
    const queue = this.queues.get(key)
    if (!queue || queue.length === 0) {
      this.queues.delete(key)
      return undefined
    }
    const item = queue.shift()
    if (queue.length === 0) this.queues.delete(key)
    return item
  }

  /**
   * 清空某个工作区的队列，**返回被丢掉的全部项**。
   *
   * 用户点「停」时调。取消 = 全停（在跑的那一轮 + 排着的全部），
   * 因为「我明明停了它还在做」比「排队的话丢了」更违反直觉。
   * 要改成保留只需不调这个方法。
   */
  clear(key: WorkspaceKey): T[] {
    const queue = this.queues.get(key) ?? []
    this.queues.delete(key)
    return queue
  }

  /**
   * 丢掉所有满足谓词的项，**返回被丢掉的**。
   *
   * 给断线 / 登出用：那时排队项的宿主（WebSocket）已经没了，
   * 它的产出没有观众。判断「哪些项归我」的是调用方，不是这里 ——
   * 本文件不知道 ws 是什么。
   */
  dropWhere(predicate: (item: T, key: WorkspaceKey) => boolean): T[] {
    const dropped: T[] = []
    for (const [key, queue] of [...this.queues.entries()]) {
      const kept = queue.filter((item) => {
        if (!predicate(item, key)) return true
        dropped.push(item)
        return false
      })
      if (kept.length === 0) this.queues.delete(key)
      else this.queues.set(key, kept)
    }
    return dropped
  }

  /** 某个工作区排着几条 */
  size(key: WorkspaceKey): number {
    return this.queues.get(key)?.length ?? 0
  }

  /** 当前有排队的工作区键。诊断用 */
  keys(): WorkspaceKey[] {
    return [...this.queues.keys()]
  }

  /** 所有工作区一共排着几条。诊断用 */
  total(): number {
    let n = 0
    for (const queue of this.queues.values()) n += queue.length
    return n
  }
}
