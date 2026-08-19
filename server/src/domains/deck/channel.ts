/**
 * deck 域的下行通道 —— 闸门 + 提交器接在一起的那一小段
 *
 * ## 为什么单独一个文件
 *
 * `cancellation.ts` 和 `commit.ts` 各自都有判据，但**「它们被接对了没有」是另一回事**。
 * 这段接线原来写在 `runDeckTask` 里，而 `pipeline.ts` 经 `db/index.ts` 拉进
 * `bun:sqlite`，在 vitest 里 import 不进来 —— 于是零件全绿、装配无人验。
 *
 * 这个仓库被这一类坑过不止一次：R-36 静态核过「45 个 cssClass 都有定义」，
 * 但没有一个在浏览器里被看过；A2 那条「防空跑」断言防的也是同一件事。
 * **零件对 ≠ 装配对。**
 *
 * 把接线挪进来之后，`pipeline.ts` 里只剩两处真正无法测的东西：
 * `ws.send` 和 `saveDeckState` —— 它们是纯粹的 IO 端点，各自一行。
 *
 * ## 接线里唯一的判断
 *
 * `publish` 走 `gate.send` 而不是直接 `deliver`：`agent.deck` 也要过闸门。
 * 看着多余（策略表里它本来就永远放行），但**放行是策略表说了算，不是这里说了算** ——
 * 哪天 `events.ts` 改了主意，改一处就够，不会留下一条绕过闸门的暗路。
 */

import type { ServerMessage } from '@server/ws/handler'
import { createEventGate } from '@server/runtime/cancellation'
import { createCommitter } from '@server/runtime/commit'
import { survivesCancel } from './events'
import type { DeckState } from './tools'

export interface DeckChannelOptions {
  /** 取消信号。置位后除 `agent.deck` 外的事件不再投递 */
  signal: AbortSignal
  /** 真正把消息发出去（生产环境是 `ws.send`） */
  deliver: (msg: ServerMessage) => void
  /**
   * 真正把状态写进库（生产环境是 `saveDeckState`）。
   *
   * 类型跟 `CommitterOptions.persist` 保持一致 —— 这里只是原样转交，
   * 收得比它严只会让同步实现（测试里的假库）平白挂一个空 async
   */
  persist: (state: DeckState) => Promise<void> | void
}

export interface DeckChannel {
  /** 发一条下行事件。取消之后只有 `agent.deck` 还出得去 */
  emit: (msg: ServerMessage) => void
  /** 提交一次状态变更：先落库，再推画布。**必须 await** */
  commit: (state: DeckState) => Promise<void>
  /** 等所有排队的提交落地。收尾时调 */
  drain: () => Promise<void>
  stats: () => { delivered: number, reclaimed: number, committed: number }
}

export const createDeckChannel = (
  { signal, deliver, persist }: DeckChannelOptions,
): DeckChannel => {
  const gate = createEventGate<ServerMessage>({ signal, survivesCancel, deliver })

  const committer = createCommitter<DeckState>({
    persist,
    publish: (next) => {
      gate.send({
        type: 'agent.deck',
        slidesJson: JSON.stringify(next.slides),
        version: next.version,
      })
    },
  })

  return {
    emit: (msg) => {
      gate.send(msg)
    },
    commit: committer.commit,
    drain: committer.drain,
    stats: () => ({ ...gate.stats(), committed: committer.committed() }),
  }
}
