/**
 * deck 域的下行事件策略 —— 取消之后哪些还必须送达
 *
 * 单独一个文件，不写在 `pipeline.ts` 里，理由只有一个：**这是本轮唯一的策略决定，
 * 必须测得到**。`pipeline.ts` 经 `db/index.ts` 拉进 `bun:sqlite`，
 * 在 vitest 里 import 不进来（和当初 `budget.ts` 被拆出去是同一个原因）。
 *
 * 本文件只有一处 `import type`，编译期就抹掉了，所以它是干净的纯函数模块。
 *
 * ## 边界划在哪
 *
 * **叙事类事件可回收，权威状态不可回收。**
 *
 * 叙事（文本 / 思考 / 工具流水 / 状态提示）是讲给人看的过程，取消之后继续吐，
 * 用户看到的就是「点了取消它还在跑」。
 *
 * 而 `agent.deck` 和一次库写入是**配对**的（见 runtime/commit.ts）——
 * 丢掉它，画布就比库少一步，正好把 commit 刚建立起来的
 * 「库与画布不可能不同步」拆掉。BitFun 的 `is_reclaimable_stream_data`
 * 回收的也正是 `TextChunk` / `ThinkingChunk`，不是权威状态（docs/10 第 1.4 节）。
 *
 * 取消的**回执**不从剧本发 —— `ws/handler.ts` 收到 `agent.cancel` 当场就回了一条。
 * 所以剧本这边彻底静音是对的，不会让用户失去反馈。
 */

import type { ServerMessage } from '@server/ws/handler'

/**
 * 每一种下行事件在取消之后的去留。
 *
 * **写成 `Record<ServerMessage['type'], …>` 是刻意的**：协议里加一种新消息却忘了
 * 决定它的取消策略时，这里会**编译不过**。
 *
 * 换成 `survivesCancel = msg => msg.type === 'agent.deck'` 一行也能跑，
 * 但新消息会默认落进「可回收」而没有任何东西提醒 ——
 * 而如果那条新消息恰好是权威状态，表现就是「取消之后画布悄悄少了一块」。
 * 和 `toolGroups.ts` 的 `satisfies` 防的是同一类病：
 * 加了东西忘了归类，编译过、测试过，然后静默出错。
 */
const CANCEL_POLICY: Record<ServerMessage['type'], 'survives' | 'reclaimable'> = {
  // 唯一放行的：它和一次库写入配对，丢了就是库与画布不一致
  'agent.deck': 'survives',

  // 以下全是叙事，取消即止
  'agent.status': 'reclaimable',
  'agent.tool': 'reclaimable',
  'agent.text': 'reclaimable',
  'agent.reasoning': 'reclaimable',
  'agent.reasoning.done': 'reclaimable',
  'agent.conversation': 'reclaimable',
  'agent.ask': 'reclaimable',
  'error': 'reclaimable',

  // 图片能力（D1 工具层，第十八轮接上）。
  //
  // 上一版这里写着「真接上之后 asset.ready 会改元素的 src —— 那时它就是权威状态了，
  // 要连同一次 commit 一起走」。**实装时走了另一条路，所以这个担心没有发生**：
  // 工具是同步等图的，图拿到后由 agent 自己调 addElement 写进 deck，
  // 走的仍是 applyMutation → channel.commit 那一条路。
  //
  // 于是这三条消息**一个字节的 deck 都不改**，纯粹是进度叙事
  // （填上生图那 14~15 秒的沉默）。取消之后没必要再吐，分类保持「可回收」是对的。
  // 详见 domains/deck/assetTools.ts 头注释里那张冲突表。
  'agent.asset.pending': 'reclaimable',
  'agent.asset.ready': 'reclaimable',
  'agent.asset.failed': 'reclaimable',
}

/** 这条事件在取消之后是否仍必须送达 */
export const survivesCancel = (msg: ServerMessage): boolean =>
  CANCEL_POLICY[msg.type] === 'survives'

/** 取消后仍会放行的事件类型。判据用 —— 让「放行清单」本身可断言 */
export const SURVIVING_EVENT_TYPES = Object.entries(CANCEL_POLICY)
  .filter(([, policy]) => policy === 'survives')
  .map(([type]) => type)
  .sort()
