/**
 * 活动任务注册表 —— 域无关
 *
 * 管的是一件事：**同一个工作区同时只允许一个任务在跑**，并且能从外部取消它。
 *
 * ## 为什么不是原来那个 Map
 *
 * 拆层前是 `orchestrator.ts` 里一行 `new Map<number, AbortController>()`，按 `userId` 键。
 * 两个问题：
 *
 * **① 键错了。** 按 userId 意味着一个用户全局只能跑一个任务，
 * 打开两份演示文稿也不能各跑各的。而真正需要串行的是「同一份 deck」——
 * 画布是单一权威，两个任务同时改一份 deck 就是改动丢失。
 * 现在改成按工作区键（`deck:42`），跨 deck 并行、同 deck 串行。
 *
 * **② 注销存在 ABA 竞态。** 原来取消和收尾都执行 `activeTasks.delete(userId)`：
 *
 * ```
 * 任务 A 在跑         → registry = { u1: ctrlA }
 * 用户取消            → ctrlA.abort() + delete   → registry = {}
 * 用户立刻发起任务 B  → registry = { u1: ctrlB }
 * 任务 A 的 finally   → delete                   → registry = {}   ← 把 B 的注册删掉了
 * ```
 *
 * 此后 B 在跑但没登记：取消找不到它，而且还能再并发起第三个任务。
 * 表现是「取消之后偶尔会有两个 agent 同时改同一份 deck」，
 * 且**只在用户取消后马上重发时出现**，极难复现。
 *
 * 修法抄 BitFun 的 `UserInputRegistration`（见 docs/10 第 1.2 节）：
 * 注册时发一张收据，注销必须出示收据，**只有仍持有当前注册的那一方才删得掉**。
 *
 * ## 为什么工作区键是字符串
 *
 * `deck:42` 这种形式，而不是 `{ kind, id }` 对象或纯数字：
 * 字符串能直接当 Map 的键，且第二个域进来时（`research:7`）这个文件一行都不用改。
 * 构造键的是域，不是这里 —— 本文件不知道 deck 是什么。
 */

/** 工作区键。约定 `<域>:<id>`，构造由域负责 */
export type WorkspaceKey = string

/**
 * 注册收据。持有它才能注销自己那一次注册。
 *
 * 刻意不暴露构造函数式的字段：调用方只该把它原样传回 `release`，
 * 不该去读 `seq` 做判断 —— 那等于把 ABA 的判定逻辑复制到调用点。
 */
export interface TaskLease {
  readonly key: WorkspaceKey
  readonly signal: AbortSignal
  /** @internal 注册序号，用于分辨「同一个键的第 N 次注册」 */
  readonly seq: number
}

interface Entry {
  controller: AbortController
  seq: number
}

export class ActiveTaskRegistry {
  private readonly entries = new Map<WorkspaceKey, Entry>()
  private nextSeq = 0

  /**
   * 尝试占用一个工作区。
   *
   * 已被占用时返回 `null` 而不是抛错 —— 「已有任务在跑」是**正常的用户操作结果**
   * （手快点了两次），调用方要做的是给一句提示，不是当异常处理。
   */
  acquire(key: WorkspaceKey): TaskLease | null {
    if (this.entries.has(key)) return null

    const controller = new AbortController()
    const seq = this.nextSeq++
    this.entries.set(key, { controller, seq })
    return { key, signal: controller.signal, seq }
  }

  /**
   * 释放自己那一次注册。
   *
   * **收据对不上就什么都不做** —— 这是 ABA 防护的全部：
   * 一个迟到的 finally 拿着旧收据来注销，此时键上已经是别人的注册，
   * 静默跳过是正确行为，不是错误。
   *
   * 返回是否真的释放了，仅供测试和诊断用。
   */
  release(lease: TaskLease): boolean {
    const entry = this.entries.get(lease.key)
    if (!entry || entry.seq !== lease.seq) return false
    this.entries.delete(lease.key)
    return true
  }

  /**
   * 取消某个工作区正在跑的任务。
   *
   * **只 abort，不注销** —— 注销是任务自己收尾时凭收据做的事。
   * 原来的实现在这里顺手 delete，正是上面那个 ABA 竞态的来源：
   * 取消方和收尾方都去删，中间插进来的新任务就被删掉了。
   *
   * 代价是取消之后到任务真正收尾之间，这个键仍然是「占用中」，
   * 用户此刻重发会收到「已有任务在执行中」。**这是对的** ——
   * 上一轮的收尾写入（保存 deck、推送状态）还没跑完，
   * 此时放新任务进来就是 BitFun 状态机里 `FINISHING` 要防的那件事：
   * 排队的输入和上一轮的收尾写入抢跑（见 docs/10 第 1.5 节）。
   */
  cancel(key: WorkspaceKey): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    entry.controller.abort()
    return true
  }

  /** 该工作区是否有任务在跑（含已取消但尚未收尾的） */
  isBusy(key: WorkspaceKey): boolean {
    return this.entries.has(key)
  }

  /** 当前占用中的工作区键，按注册先后排序。诊断用 */
  activeKeys(): WorkspaceKey[] {
    return [...this.entries.entries()]
      .sort(([, a], [, b]) => a.seq - b.seq)
      .map(([key]) => key)
  }

  /**
   * 取消并注销一批工作区，返回被取消的数量。
   *
   * 给「用户登出」「连接断开」这类场景用：那时候没有收据可用，
   * 而任务的宿主（WebSocket）已经没了，留着注册只会让这个键永远占用。
   */
  cancelAllMatching(predicate: (key: WorkspaceKey) => boolean): number {
    let cancelled = 0
    for (const [key, entry] of [...this.entries.entries()]) {
      if (!predicate(key)) continue
      entry.controller.abort()
      this.entries.delete(key)
      cancelled++
    }
    return cancelled
  }
}

/** 构造工作区键。域各自调用，保证前缀不撞 */
export const workspaceKey = (domain: string, id: number | string): WorkspaceKey =>
  `${domain}:${id}`
