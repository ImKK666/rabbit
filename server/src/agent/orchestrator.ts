/**
 * 装配层 —— 把域接进 runtime
 *
 * 三层结构（见 docs/11-agent-roadmap.md 阶段 A）：
 *   server/src/runtime/       域无关：任务注册表 / 预算 / LLM provider / 历史转换
 *   server/src/domains/deck/  PPT 域：kernel / 版式 / 设计系统 / 工具 / 角色 / 编排剧本
 *   server/src/agent/         装配层：本文件
 *
 * **本文件是唯一允许同时 import runtime/ 和 domains/ 的地方。**
 * 反方向（runtime/ import domains/ 或 agent/）是边界破损，
 * 由 `server/src/runtime/__tests__/boundary.test.ts` 守着。
 *
 * 装配层只做两件事：
 *   1. 持有跨域共享的任务注册表实例
 *   2. 把 ws 消息路由到对应域的剧本，并管好占坑 / 注销
 *
 * 剧本本身、deck 的持久化、会话与消息落库全部在 `domains/deck/pipeline.ts`。
 *
 * ── 目录为什么还叫 `agent/` ──
 * 等第二个域接进来、这里真的开始「路由到不同域」时再改名。
 * 现在只有一个域，改名除了制造一次 import 变更没有别的作用。
 */

import type { ServerWebSocket } from 'bun'
import type { WsUserData, ServerMessage } from '@server/ws/handler'
import { ActiveTaskRegistry, workspaceKey } from '@server/runtime/taskRegistry'
import { runDeckTask } from '@server/domains/deck/pipeline'

/**
 * 活动任务注册表。**按工作区键登记，不是按 userId** ——
 * 一个用户可以同时在多份演示文稿上跑任务，但同一份 deck 必须串行
 * （画布是单一权威，并行改一份 deck 就是改动丢失）。
 *
 * 注册表跨域共享：research 域进来时用 `research:<id>` 键，占用互不干扰，
 * 而「一个工作区一个任务」这条约束由同一份代码保证。
 */
const activeTasks = new ActiveTaskRegistry()

/** deck 域的工作区键。各域自造前缀，不会撞 */
const deckWorkspace = (deckId: number) => workspaceKey('deck', deckId)

const send = (ws: ServerWebSocket<WsUserData>, msg: ServerMessage) => {
  ws.send(JSON.stringify(msg))
}

export const runAgentTask = async (
  ws: ServerWebSocket<WsUserData>,
  deckId: number,
  prompt: string,
  selectedElementIds?: string[],
  conversationId?: number,
) => {
  // 先占坑再进剧本：反过来的话，两个并发请求会同时读到 deck、同时通过占用检查。
  // 占用失败不抛错 —— 手快点两次是正常操作，给一句提示就够
  const lease = activeTasks.acquire(deckWorkspace(deckId))
  if (!lease) {
    send(ws, { type: 'error', message: '这份演示文稿已有任务在执行中，请等待完成或取消' })
    return
  }

  try {
    await runDeckTask({
      ws, deckId, prompt, selectedElementIds, conversationId, signal: lease.signal,
    })
  }
  finally {
    // 凭收据注销。**每一条退出路径都会走到这里**，包括剧本里提前 return 的分支
    // （「演示文稿不存在」那条）—— 拆层前那个分支要手动记得还坑位，
    // 现在放进 finally 就不可能漏。
    // 迟到的注销删不掉后来者的注册，见 taskRegistry.ts 的 ABA 说明
    activeTasks.release(lease)
  }
}

/**
 * 取消某份演示文稿正在跑的任务。
 *
 * **只 abort，不注销** —— 注销由任务自己在 finally 里凭收据做。
 * 原来在这里顺手 delete 会造成 ABA：取消后用户立刻重发，
 * 上一个任务的 finally 会把新任务的注册删掉。判据见
 * `runtime/__tests__/taskRegistry.test.ts` 的「ABA 竞态」一组。
 */
export const cancelAgentTask = (deckId: number): boolean =>
  activeTasks.cancel(deckWorkspace(deckId))
