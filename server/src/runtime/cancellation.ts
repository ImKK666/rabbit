/**
 * 取消回收 —— 取消之后不再往前端吐在途事件
 *
 * ## 治的是什么
 *
 * `cancelAgentTask` 只做 `abort()`。而 abort 掐的是 LLM 那条 fetch，
 * **正在执行的工具函数一个都不看 signal** —— 它们会跑完，
 * 然后照常往 WebSocket 上发 `agent.text` / `agent.tool` / `agent.reasoning`。
 * 用户看到的是「点了取消，面板还在自己往下滚」。
 *
 * 抄 BitFun 的 `is_reclaimable_stream_data`（docs/10 第 1.4 节）：
 * 收到某个 turn 的中断之后，队列里该 turn 尚未投递的分片直接扔掉。
 *
 * ## 可回收的边界划在哪 —— 这是本文件唯一要想清楚的事
 *
 * **叙事类事件可回收，权威状态不可回收。**
 *
 * 叙事（文本 / 思考 / 工具流水 / 状态提示）是「讲给人看的过程」，
 * 丢掉只是少看几行；而状态事件是和一次库写入**配对**的 ——
 * 丢掉它，画布就比库少一步，正好把 `commit.ts` 刚建立的
 * 「库与画布不可能不同步」拆掉。
 *
 * BitFun 回收的也正是 `TextChunk` / `ThinkingChunk`，不是权威状态。
 *
 * 判定由**调用方**给（`survivesCancel`）：`runtime/` 不知道
 * `agent.deck` 是什么，也不该知道 —— 那是 deck 域的协议。
 *
 * ## 为什么没有世代号
 *
 * BitFun 要 `execution_generation` 是因为事件先进优先级队列、可能延迟出队，
 * 出队时得回头问「这还是当前那一轮吗」。我们的 send 在调用点同步发，
 * `signal.aborted` 一置位，之后每一次 send 都看得见 —— 世代号在这里是纯开销。
 *
 * **唯一会让它变必要的路径是 `taskRegistry.cancelAllMatching`**：
 * 它立刻删注册，于是新任务能在旧任务收尾之前占住同一个键，
 * 此时旧任务的在途事件会流向新任务的观众。它**目前零调用方**
 * （A4 给「登出 / 断线取消」留的接口）。接那条路时要连世代号一起补。
 *
 * ## 为什么要数被丢掉的事件
 *
 * BitFun 的视口登记处那条注释点破了这件事：
 * 「一个『拒绝』移动视口的写者也要说出来 —— 没发生的写入在别处完全不可见，
 * 而『什么都没发生』才是更常见的报障。」
 * 闸门坏掉的表现恰恰是**静默**：要么该丢的没丢（用户看到取消后还在刷），
 * 要么不该丢的丢了（画布停在半路）。两种都只有计数看得见。
 */

export interface EventGateOptions<M> {
  /** 取消信号。置位之后可回收事件不再投递 */
  signal: AbortSignal
  /**
   * 这条事件在取消之后是否仍必须送达。
   *
   * 由调用方定，因为「哪些是权威状态」是域的协议，不是 runtime 的知识。
   */
  survivesCancel: (msg: M) => boolean
  /** 真正的投递动作 */
  deliver: (msg: M) => void
}

export interface EventGateStats {
  /** 实际投递出去的条数 */
  delivered: number
  /** 取消后被回收（丢弃）的条数 */
  reclaimed: number
}

export interface EventGate<M> {
  /** 投递一条事件。返回是否真的送出去了 */
  send: (msg: M) => boolean
  stats: () => EventGateStats
}

export const createEventGate = <M>(
  { signal, survivesCancel, deliver }: EventGateOptions<M>,
): EventGate<M> => {
  let delivered = 0
  let reclaimed = 0

  return {
    send(msg) {
      if (signal.aborted && !survivesCancel(msg)) {
        reclaimed++
        return false
      }
      deliver(msg)
      delivered++
      return true
    },
    stats: () => ({ delivered, reclaimed }),
  }
}
