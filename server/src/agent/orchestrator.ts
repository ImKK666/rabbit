/**
 * 装配层 —— 把域接进 runtime
 *
 * 三层结构（见 docs/11-agent-roadmap.md 阶段 A）：
 *   server/src/runtime/       域无关：准入闸门 / 预算 / LLM provider / 历史转换
 *   server/src/domains/deck/  PPT 域：kernel / 版式 / 设计系统 / 工具 / 角色 / 编排剧本
 *   server/src/agent/         装配层：本文件
 *
 * **本文件是唯一允许同时 import runtime/ 和 domains/ 的地方。**
 * 反方向（runtime/ import domains/ 或 agent/）是边界破损，
 * 由 `server/src/runtime/__tests__/boundary.test.ts` 守着。
 *
 * 装配层只做两件事：
 *   1. 持有跨域共享的准入闸门实例
 *   2. 把 ws 消息路由到对应域的剧本，并把闸门的回调翻译成下行消息
 *
 * 剧本本身、deck 的持久化、会话与消息落库全部在 `domains/deck/pipeline.ts`。
 *
 * ── 占坑 / 排队 / 接力为什么不在这里 ──
 * 它们在 `runtime/taskGate.ts`。本文件经 `pipeline.ts` → `db/index.ts`
 * 拉进 `bun:sqlite`，**在 vitest 里 import 不进来** —— 接线逻辑写在这里
 * 就等于没有判据，而 11 号文档那条「零件对 ≠ 装配对」正是栽在接线上。
 * 这里剩下的只有「翻译」：闸门说排队了，翻成一条 `agent.input`。
 *
 * ── 目录为什么还叫 `agent/` ──
 * 等第二个域接进来、这里真的开始「路由到不同域」时再改名。
 * 现在只有一个域，改名除了制造一次 import 变更没有别的作用。
 */

import type { ServerWebSocket } from 'bun'
import type { WsUserData, ServerMessage } from '@server/ws/handler'
import { workspaceKey } from '@server/runtime/taskRegistry'
import { createTaskGate } from '@server/runtime/taskGate'
import { runDeckTask } from '@server/domains/deck/pipeline'

/**
 * 前端的渲染测量答复走这里回到域里。
 *
 * 转出一手而不是让 `ws/handler` 直接 import deck 域：
 * **ws 层只跟装配层说话**，这样第二个域进来时路由改这一处就够了。
 */
export { settleRenderResult } from '@server/domains/deck/reflectTool'

/**
 * R-61：确认闸门（`askUser`）的回答走这里回 deck 域。理由同上。
 */
export { settleUserAnswer } from '@server/domains/deck/askTool'

/** 排队项。**它持有 ws** —— 所以断线清理的谓词写在这一层，不在 runtime */
interface PendingTask {
  ws: ServerWebSocket<WsUserData>
  deckId: number
  prompt: string
  selectedElementIds?: string[]
  conversationId?: number
}

/** deck 域的工作区键。各域自造前缀，不会撞 */
const deckWorkspace = (deckId: number) => workspaceKey('deck', deckId)

const send = (ws: ServerWebSocket<WsUserData>, msg: ServerMessage) => {
  ws.send(JSON.stringify(msg))
}

/**
 * 这个连接还活着吗。
 *
 * 取排队项时要看一眼：宿主已经关掉的那条，跑出来没有任何人看得到，
 * 而它还会占着工作区、把后面排着的挡住。
 *
 * 用字面量 1（OPEN）而不是 `WebSocket.OPEN` —— 后者在 bun 的服务端类型里
 * 不是一个可用的常量。
 */
const isAlive = (ws: ServerWebSocket<WsUserData>) => ws.readyState === 1

/**
 * 准入闸门。**跨域共享**：research 域进来时用 `research:<id>` 键，
 * 占用互不干扰，而「一个工作区一个任务」由同一份代码保证。
 *
 * 按工作区键登记而不是按 userId：一个用户可以同时在多份演示文稿上跑任务，
 * 但同一份 deck 必须串行（画布是单一权威，并行改一份就是改动丢失）。
 */
const gate = createTaskGate<PendingTask>({
  run: (task, signal) => runDeckTask({ ...task, signal }),

  /**
   * **每一句输入都恰好收到一个终局回执**（`started` 或 `rejected`），
   * 排队的那些前面再多一条 `queued`。
   *
   * 这条对称性是前端配对的全部依据：面板在**发出请求时**就把用户那句
   * push 进日志了，它需要一个明确的信号才能决定那条要不要标记。
   * 只给排队的发回执的话，前端就得靠「没收到消息 == 已经在跑」来猜，
   * 而那正是猜错了也不会有任何东西报错的那类约定。
   */
  onStarted: t => send(t.ws, { type: 'agent.input', deckId: t.deckId, state: 'started' }),

  onQueued: (t, position) =>
    send(t.ws, { type: 'agent.input', deckId: t.deckId, state: 'queued', position }),

  // **回的是 agent.input 而不是 error。** 前端在发出请求时就把这句话
  // push 进日志了，回一条泛泛的 error 会让那句话留在面板上像是被受理了
  onRejected: (t, limit) => send(t.ws, {
    type: 'agent.input',
    deckId: t.deckId,
    state: 'rejected',
    reason: `排队已满（最多 ${limit} 条）—— 等前面的跑完，或者取消当前任务`,
  }),

  isAlive: t => isAlive(t.ws),
  onDropped: t => console.log(`[agent] deck:${t.deckId} 丢弃一条排队输入：宿主连接已断开`),

  onRelayError: (t, err) => {
    console.error('[agent] 排队任务异常退出:', err)
    if (!isAlive(t.ws)) return
    send(t.ws, {
      type: 'agent.status',
      status: 'error',
      message: err instanceof Error ? err.message : '排队任务异常退出',
    })
  },
})

export const runAgentTask = (
  ws: ServerWebSocket<WsUserData>,
  deckId: number,
  prompt: string,
  selectedElementIds?: string[],
  conversationId?: number,
): Promise<void> =>
  gate.submit(deckWorkspace(deckId), { ws, deckId, prompt, selectedElementIds, conversationId })

/**
 * 取消某份演示文稿的任务 —— **在跑的那一轮 + 排着的全部**。
 *
 * 取消 = 全停是刻意的：用户点「停」的心智就是停，
 * 留着队列会出现「我明明停了它还在做」。要改成保留只需不清队列。
 *
 * 返回被丢弃的排队条数：**静默丢掉用户发过的话是不可接受的**，
 * 调用方要能说一声。
 */
export const cancelAgentTask = (deckId: number): { cancelled: boolean, dropped: number } => {
  const { cancelled, dropped } = gate.cancel(deckWorkspace(deckId))
  return { cancelled, dropped: dropped.length }
}

/**
 * 连接断开时的清理。
 *
 * **只丢这个连接的排队项，不取消正在跑的任务。** 两个理由：
 *
 * ① 排队项持有 ws，宿主没了就没有观众，留着只会占位置；
 * ② 但**正在跑的任务不能按 ws 取消** —— 闸门按 `deck:<id>` 键登记，
 *    不记是哪个连接发起的。同一份 deck 可能在另一个标签页里也开着，
 *    按连接取消会误杀。而且任务的 deck 改动是落库的，
 *    用户刷新回来仍然拿得到 —— 断线不等于白跑。
 *
 * 真要做「登出时全部取消」得先让注册表记住发起者，那是另一件事，
 * `taskRegistry.cancelAllMatching` 已经为它留好了口子（目前无人调用）。
 */
export const releaseWsResources = (ws: ServerWebSocket<WsUserData>): number =>
  gate.dropQueued(task => task.ws === ws).length
