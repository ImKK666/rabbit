/**
 * 状态提交 —— 把「写库」和「推前端」合成一次操作
 *
 * ## 为什么要有这个文件
 *
 * 之前 deck 的持久化和画布推送是两件独立的事：`saveDeckState` 在剧本
 * **最后调一次**，而 `agent.deck` **每次 mutation 都实时推**。中途失败就变成
 * 「画布上有改动、库里没有」，刷新即丢。
 *
 * 这比「留半成品」更隐蔽 —— 它是前后端不一致，界面上完全看不出来，
 * 用户只有在刷新之后才发现活白干了。
 *
 * 修法**不是**「在更多地方记得调 saveDeckState」。那是把「两件事各自做对」
 * 当解法，而它已经错过一次了。这里把两者合成一次 `commit`，
 * 让它们**不可能不同步**。
 *
 * ## 三个刻意的决定
 *
 * **① 先落库，再推前端。** 反过来的话，写库失败会留下「画布已经变了、库没变」——
 * 正是要修的那个形状。现在写库失败就整次 commit 失败，画布不动，两边仍然一致。
 *
 * **② 内部串行。** 模型可以在一步里发多个工具调用，SDK 会并发执行它们。
 * 两次 commit 同时在飞时，写库完成的先后可能和调用先后相反，
 * 结果是库停在 state1、画布停在 state2 —— 一个只在并发下出现、手测撞不到的偏差。
 * 用一条尾巴 promise 排队，保证**落库顺序 = 调用顺序 = 推送顺序**。
 *
 * **③ 写库失败向调用方抛。** 不吞掉，也不「记个日志继续跑」：
 * 这一次修改没有durable 地落下去，而工具马上就要回一句 `{ ok: true }` 给 agent。
 * 骗它改成功了，它就不会重试，这条修改从此谁也不知道丢了。
 *
 * 本文件域无关：不知道 deck 是什么，也不知道「推前端」是一条 WebSocket 消息。
 */

export interface CommitterOptions<S> {
  /**
   * 把状态写进持久层。抛错则整次 commit 失败，`publish` 不会被调用。
   *
   * 允许返回 `void`：提交器对它做的是 `await persist(state)`，
   * 同步实现照样成立。写死 `Promise<void>` 会逼着每个同步实现
   * 挂一个空 `async`（测试里的假持久层就全是这种），
   * 而那对调用方没有任何约束力 —— 类型该说的是「我会等你」，不是「你必须是异步的」。
   */
  persist: (state: S) => Promise<void> | void
  /** 把状态推给前端。在 `persist` 成功之后才调 */
  publish: (state: S) => void
}

export interface Committer<S> {
  /**
   * 提交一次状态变更。**调用方必须 await** ——
   * 不等它落地就返回，等于工具告诉 agent「改好了」而那次写入还在飞。
   */
  commit: (state: S) => Promise<void>
  /**
   * 等待所有已排队的提交落地。
   *
   * 收尾时调，保证「剧本返回时库里已经是最终态」。
   * **永不 reject** —— 单次失败是那次 commit 调用方的事，
   * drain 的职责只是「等干净」。
   */
  drain: () => Promise<void>
  /** 已成功提交的次数。诊断与判据用 */
  committed: () => number
}

export const createCommitter = <S>({ persist, publish }: CommitterOptions<S>): Committer<S> => {
  let tail: Promise<void> = Promise.resolve()
  let committed = 0

  const runOne = async (state: S) => {
    await persist(state) // ① 顺序本身是契约：先落库
    publish(state) //        ② 落定之后才推画布
    committed++
  }

  return {
    commit(state) {
      const done = tail.then(() => runOne(state))
      // 链条自己必须吞掉异常，否则一次写库失败会让**后续每一次** commit 都直接
      // reject —— 一个瞬时错误就把整条任务的落库永久停掉了。
      // 异常照样交给本次调用方：返回的是 done，不是 tail。
      tail = done.catch(() => {})
      return done
    },
    drain: () => tail,
    committed: () => committed,
  }
}
