/**
 * 确认闸门工具 —— `askUser`（R-61）
 *
 * 抄 workflow-san 的 review-gate 规则：重要稿件在「大纲/方向已想清楚、
 * 还没开始建页」时停下来让用户确认一次，再继续。Gorden 的流程里
 * 也有一模一样的一步（A1 确认风格/受众/页数）。
 *
 * ## 为什么是「工具」而不是编排层的一步
 *
 * 停在哪、问什么，只有模型知道（它刚把叙事线和视觉方案想完）；
 * 而「什么时候该问」的判据写进 prompt（见 roles.ts「确认闸门」）。
 * 做成工具 = 模型自己决定问不问，和「选哪个版式」是同一层决策。
 *
 * ## 等待机制复用 `runtime/pendingRequests`
 *
 * 它就是 R-52 给渲染后反思建的那套（docs/13 §三），`ws/handler.ts`
 * 里 `agent.confirm` 那个空分支等的正是这里。接线方式和
 * `reflectTool.ts` 的 `settleRenderResult` 逐字相同：
 *
 * - 硬超时：用户 90 秒没答（断线 / 走开 / 关页面），工具回
 *   「没回答」，agent 按自己的判断继续 —— 绝不抛异常逼它重试
 * - 取消时主动作废在等的，不干等到超时
 * - 对不上的 requestId 一律丢掉（迟到 / 伪造 / 重复）
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { ServerMessage } from '@server/ws/handler'
import { createPendingRequests, type PendingRequests } from '@server/runtime/pendingRequests'

/**
 * 等用户多久。
 *
 * 比渲染测量（20 秒）长得多：那次是「机器在量」，这次是「人在想」。
 * 90 秒够用户看完一份大纲样例并点一个按钮，又不至于让断线的前端
 * 把任务拖死。
 */
const ASK_TIMEOUT_MS = 90_000

/**
 * requestId → 在等它的等待器。登记与注销在工具里成对做，
 * 表的大小等于「此刻正在等的提问数」，通常是 0 或 1。
 */
const waitingByRequest = new Map<string, PendingRequests<boolean>>()

/**
 * 把前端点下的答复交给在等它的那次提问。
 *
 * 返回是否真的落在一次等待上 —— `false` 表示这个 requestId 不认识
 * （超时之后才回来的、伪造的、重复的），那时什么都不做是正确行为。
 */
export const settleUserAnswer = (requestId: string, value: boolean): boolean =>
  waitingByRequest.get(requestId)?.settle(requestId, value) ?? false

export interface AskToolContext {
  emit: (msg: ServerMessage) => void
  /** 任务的取消信号。取消时主动作废在等的提问，不干等到超时 */
  signal: AbortSignal
}

export const createAskTool = (
  ctx: AskToolContext,
  /** 测试注入用；生产一律用默认 90 秒 */
  { timeoutMs = ASK_TIMEOUT_MS }: { timeoutMs?: number } = {},
) => {
  const pending = createPendingRequests<boolean>({ timeoutMs })

  // 和 reflectTool 同一条：光靠闸门回收下行消息不够 ——
  // 前端收不到提问就永远不会回答，那次等待只能耗到超时
  ctx.signal.addEventListener('abort', () => {
    const n = pending.cancelAll()
    if (n > 0) console.log(`[ask] 任务取消，作废 ${n} 次在等的确认`)
  })

  const askUser = tool({
    description: [
      '**停下来问用户一个问题，等用户点「是」或「否」再继续。**',
      '',
      '重要稿件（对外 / 管理层 / 销售 / 技术密集 / 方向有分岔）在「大纲与方向已经想清楚、',
      '还没开始建页」时用它确认一次。问题要具体、二选一 ——',
      '如「这份稿子走数据报告路线还是故事叙事路线？是 = 数据报告，否 = 故事叙事」。',
      '不要问「可以开始了吗」这种废话。',
      '',
      '用户没回答（超时 90 秒 / 页面没开）时会明说，那时按你自己的判断继续，不要重试。',
      '普通稿子不要问 —— 每个任务最多一次。',
    ].join('\n'),
    parameters: z.object({
      question: z.string().describe('要问用户的问题，一句话，必须是二选一（是/否），并说清「是」代表哪个方向'),
    }),
    execute: async ({ question }) => {
      const { id, wait } = pending.open()
      waitingByRequest.set(id, pending)
      try {
        ctx.emit({ type: 'agent.ask', requestId: id, question })
        const outcome = await wait
        if (!outcome.ok) {
          return JSON.stringify({
            ok: false,
            reason: outcome.reason === 'timeout' ? '用户没有回答（超时）' : '任务已取消',
            hint: '按你自己的判断继续，不要重试',
          })
        }
        return JSON.stringify({
          ok: true,
          answer: outcome.value,
          hint: '用户回答「是」= 按问题里说的第一个方向继续；「否」= 先按第二个方向，或停下来听用户补充',
        })
      }
      finally {
        waitingByRequest.delete(id)
      }
    },
  })

  return { askUser }
}

export type AskTools = ReturnType<typeof createAskTool>
