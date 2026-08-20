/**
 * R-37 · 角色步数预算（纯函数，无依赖）
 *
 * ## 为什么把小数字换成大数字
 *
 * 历史上这里是 15 → 48 → 60，每次都是「实测不够，往上抬一点」。
 * 60 是按「10 页各排一次版式再各精修两下」估的 —— 估得不算错，
 * 实测一份 12 页的稿子正好停在第 10 页。错的是**这个数量级本身**。
 *
 * 实测 60 步产生 96 条工具调用、约 13 万 token。现役模型是 1M 上下文，
 * 也就是说旧上限只用掉了 **13%** 就把 agent 掐停了 —— 掐它的从来不是
 * 模型的能力边界，是一个 2024 年的保守估值。
 *
 * 按 1M 上下文倒推，真正的容量在 400~500 步。所以默认给 512：
 * 不是「大到跑不到」，而是**正好卡在上下文真的开始吃紧的地方**。
 * 512 步之前，收口的应该只有两件事 ——
 *
 *   1. 模型自己做完了（正常情况下唯一会发生的那个）
 *   2. 用户点「取消」（AgentPanel → agent.cancel → AbortController）
 *
 * 而且触顶也不再等于失败：编排器会带着当前 deck **续作**（见 orchestrator
 * 的 MAX_CONTINUATIONS）。续作不传 history，等于**把上下文清零重来**，
 * agent 自己 getDeck 就知道做到哪了。所以任务的真实上限是
 * 512 × 4 轮，而每一轮都从干净的上下文起步 —— 上下文根本不会成为天花板。
 *
 * **代价**：上限抬高后，一个陷在重试里的 agent 会烧掉多得多的 token 才停。
 * 取消按钮是唯一的实时刹车，不能坏。
 *
 * ## 想调回去
 *
 *   AGENT_MAX_STEPS=60       # 一次管住所有 agent
 *   AGENT_MAX_STEPS_DECK=200 # 只改某一个，优先级更高
 *
 * 非法值（负数 / 非数字 / 0）一律忽略并回退到默认，**不报错** ——
 * 一个打错的环境变量不该让整个 agent 起不来。
 */

import type { AgentRole } from '@server/db/schema'

/**
 * 默认上限。数量级的依据（每步实测约 2k token，按 1M 上下文倒推）：
 * 一份 14 页的稿子实测 80~120 步，留四倍余量后正好落在上下文真正吃紧的位置。
 *
 * **R-51 之前这里有四行**（generator 512 / editor 256 / planner 64 / reviewer 64），
 * 四个角色各一份预算。合并成一个 agent 之后取原来 generator 那档 ——
 * 局部微调用不到 512 步，但它**本来就不会跑满**：真正的收口是
 * 「模型自己做完了」，上限只是护栏。给局部调整单设一档小的，
 * 反而会让「一次微调顺手把整页重排了」这种正常操作撞上限。
 */
export const DEFAULT_ROLE_MAX_STEPS: Record<AgentRole, number> = {
  deck: 512,

  /**
   * 视觉复核**只跑一步**。
   *
   * 它没有任何工具（`toolGroups.ts` 里 `reflect: []`），一次调用就是
   * 「看一张图 → 说出哪里不对」，没有第二步可走。写成 1 而不是随便给个大数，
   * 是让「它不该有多步」这件事在代码里有个明确的位置 ——
   * 哪天有人给它加了工具，这个 1 会立刻把问题暴露出来。
   */
  reflect: 1,
}

/** 环境变量名：`AGENT_MAX_STEPS_DECK` 这种单 agent 覆盖，比全局的优先 */
const roleEnvKey = (role: AgentRole): string => `AGENT_MAX_STEPS_${role.toUpperCase()}`

export const resolveMaxSteps = (
  role: AgentRole,
  env: Record<string, string | undefined> = process.env,
): number => {
  for (const key of [roleEnvKey(role), 'AGENT_MAX_STEPS']) {
    const raw = env[key]
    if (raw === undefined || raw.trim() === '') continue
    const n = Number(raw)
    // 只接受 ≥1 的有限整数；小数向下取整（maxSteps=2.7 对 SDK 没意义）
    if (Number.isFinite(n) && n >= 1) return Math.floor(n)
  }
  return DEFAULT_ROLE_MAX_STEPS[role]
}
