/**
 * 准入闸门 —— 占坑 · 排队 · 接力，三件事的**接线**
 *
 * 域无关。`ActiveTaskRegistry` 和 `InputQueue` 各自都有判据，
 * 但**「它们被接对了没有」是另一回事** —— 11 号文档 §五 记过这条教训：
 *
 * > 实测负对照 ⑦⑧ 证明了这一点 —— 把 signal 接错、把 publish 改成绕过闸门，
 * > 两个零件的判据都是全绿的。**零件对 ≠ 装配对。**
 *
 * 所以接线单独成文件，而不是写在 `agent/orchestrator.ts` 里：
 * 那个文件经 `domains/deck/pipeline.ts` → `db/index.ts` 拉进 `bun:sqlite`，
 * **在 vitest 里 import 不进来**，写在里面等于没有判据。
 * `domains/deck/channel.ts` 当初拆出去是同一个理由。
 *
 * ## 这里唯一的时序约束
 *
 * **接力必须在 `release()` 之后。** 提前一步就是排队的输入和上一轮的
 * 收尾写入抢跑 —— BitFun 状态机里 `FINISHING` 防的正是这件事（docs/10 §1.5）。
 *
 * 而且整段接力是**同步**的：`isBusy` 判断、`take` 取出、下一次 `acquire`
 * 全在同一个 tick 内完成，中间插不进第二个调用。改成 await 版本就会出现
 * 「两条排队项同时看到空闲」。判据见 `taskGate.test.ts` 的「接力时机」一组。
 */

import { ActiveTaskRegistry, type WorkspaceKey } from './taskRegistry'
import { InputQueue, DEFAULT_MAX_PER_KEY } from './inputQueue'

export interface TaskGateHandlers<T> {
  /** 真正跑这个任务。抛出的异常由闸门接住（接力路径上没有别人接得住） */
  run: (item: T, signal: AbortSignal) => Promise<void>
  /** 开跑了 */
  onStarted: (item: T) => void
  /** 排进队列了，`position` 从 1 起 */
  onQueued: (item: T, position: number) => void
  /** 队列满，没收下 */
  onRejected: (item: T, limit: number) => void
  /**
   * 这一项还有人在等吗。返回 false 的会在接力时被跳过并丢弃 ——
   * 宿主（WebSocket）已经断开的任务跑出来没有任何人看得到，
   * 却还会占着工作区把后面排着的挡住。
   */
  isAlive?: (item: T) => boolean
  /** 因为宿主没了而被跳过 */
  onDropped?: (item: T) => void
  /** 接力任务抛异常了。立即路径上的异常直接往上抛，不走这里 */
  onRelayError?: (item: T, err: unknown) => void
}

export interface TaskGate<T> {
  /**
   * 交一个任务进来。
   *
   * 空闲 → 立即跑，返回的 promise 在任务结束时 settle（异常照常抛出）。
   * 忙 → 排队或拒绝，返回的 promise 立即 settle。
   */
  submit: (key: WorkspaceKey, item: T) => Promise<void>
  /** 取消：在跑的那一轮 + 排着的全部。返回被丢掉的排队项 */
  cancel: (key: WorkspaceKey) => { cancelled: boolean, dropped: T[] }
  /** 丢掉满足谓词的排队项（断线 / 登出）。**不碰正在跑的** */
  dropQueued: (predicate: (item: T, key: WorkspaceKey) => boolean) => T[]
  /** 诊断用 */
  isBusy: (key: WorkspaceKey) => boolean
  queueDepth: (key: WorkspaceKey) => number
}

export const createTaskGate = <T>(
  handlers: TaskGateHandlers<T>,
  { maxQueued = DEFAULT_MAX_PER_KEY }: { maxQueued?: number } = {},
): TaskGate<T> => {
  const registry = new ActiveTaskRegistry()
  const queue = new InputQueue<T>(maxQueued)
  const alive = handlers.isAlive ?? (() => true)

  /**
   * 取队首接着跑。**只在 release 之后调**。
   *
   * 别人抢先占了坑就什么都不做 —— 那条排队项留在队里，
   * 由抢先那一轮收尾时再叫一次。**不能在这里等**，等就是把接力变成阻塞。
   */
  const startNext = (key: WorkspaceKey): void => {
    if (registry.isBusy(key)) return

    // 宿主断开的直接丢，接着看下一条
    let next = queue.take(key)
    while (next !== undefined && !alive(next)) {
      handlers.onDropped?.(next)
      next = queue.take(key)
    }
    if (next === undefined) return

    // **必须自己接住 rejection。** 接力这条路不是从请求处理器进来的，
    // 没有那里的 catch 兜着 —— 少了它，任何逃出来的异常都是未捕获的
    // Promise 拒绝，bun 会把整个进程带走
    const item = next
    void run(key, item).catch(err => handlers.onRelayError?.(item, err))
  }

  const run = async (key: WorkspaceKey, item: T): Promise<void> => {
    const lease = registry.acquire(key)
    // 走到这里说明调用方刚判过 isBusy 且中间没有 await，acquire 不可能失败。
    // 真失败了也不能静默丢掉这一项 —— 退回队首，让下一次接力捡起来
    if (!lease) {
      queue.enqueue(key, item)
      return
    }

    handlers.onStarted(item)
    try {
      await handlers.run(item, lease.signal)
    }
    finally {
      // 凭收据注销。迟到的注销删不掉后来者的注册（taskRegistry 的 ABA 防护）
      registry.release(lease)
      // **接力在 release 之后。** 见文件头注释那条时序约束
      startNext(key)
    }
  }

  return {
    submit(key, item) {
      if (!registry.isBusy(key)) return run(key, item)

      const queued = queue.enqueue(key, item)
      if (!queued) handlers.onRejected(item, maxQueued)
      else handlers.onQueued(item, queued.position)
      return Promise.resolve()
    },

    cancel(key) {
      // **只 abort，不注销** —— 注销由任务自己在 finally 里凭收据做。
      // 在这里顺手删会造成 ABA：取消后用户立刻重发，
      // 上一个任务的 finally 会把新任务的注册删掉
      const cancelled = registry.cancel(key)
      return { cancelled, dropped: queue.clear(key) }
    },

    dropQueued: predicate => queue.dropWhere(predicate),
    isBusy: key => registry.isBusy(key),
    queueDepth: key => queue.size(key),
  }
}
