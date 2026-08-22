/**
 * 策划稿工具 —— setPlan / getPlan（R-63，docs/16-workflow-redesign.md）
 *
 * 阶段 0 的载体：模型把「想清楚」落成一份结构化方案，kernel 当场校验
 * （`validatePlan` P1–P8），过了才落库、才发给前端渲染成方案卡片。
 *
 * ## 为什么是工具而不是编排层的一步
 *
 * 和 `askTool.ts` 同一个理由：停在哪、方案长什么样，只有模型知道；
 * 而「方案必须写、写错会拒」的规则写在 prompt 的工作顺序里。
 * 做成工具 = 模型自己决定什么时候写方案、什么时候重写方案。
 *
 * ## 为什么落库不在这个文件里
 *
 * `planTool.ts` 经 `db/index.ts` 拉 `bun:sqlite` 的话，import 它的测试
 * 会在 vitest 里加载失败（tools.ts 的教训）。所以落库是 pipeline 注入的
 * `save` 回调 —— 这个文件只做三件事：校验、调用回调、发下行消息。
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { ServerMessage } from '@server/ws/handler'
import { DECK_PLAN_SCHEMA, validatePlan, type DeckPlan } from './plan'

export interface PlanToolsContext {
  /** 当前方案（任务开始时从会话读，之后是这一轮的局部状态） */
  get: () => DeckPlan | null
  /** 落库。pipeline 注入 —— 见文件头注释 */
  save: (plan: DeckPlan) => Promise<void>
  emit: (msg: ServerMessage) => void
}

/** getPlan 的同步读取 —— execute 的 await 只为满足 SDK 的 PromiseLike 签名 */
const renderPlan = (ctx: PlanToolsContext): string => {
  const plan = ctx.get()
  if (!plan) return JSON.stringify({ ok: false, error: '还没有策划稿 —— 用 setPlan 写一份' })
  return JSON.stringify(plan)
}

export const createPlanTools = (ctx: PlanToolsContext) => {
  const setPlan = tool({
    description: [
      '**把整份稿子的方案写成结构化策划稿并落盘。** 建页之前写一次；',
      '方向变了就重写一次（整体覆盖）。写错会被校验当场拒绝（拒绝不收费，改完再写）。',
      '',
      '内容：narrative（一句话叙事线）+ styleIntent（一句话视觉意图）+ sections（段落），',
      '每页一张规划卡：id（将来直接当 slideId）、title、purpose、keyMessage、',
      'pattern（版式名）、variant（仅 title-center/bullets/cards 有 B）、modules（并列模块数）。',
      '',
      '校验规则（写错会被拒）：相邻两页不同版式；单一版式不超过全篇 40%；',
      '节奏页间隔 ≤4 内容页；内容页 modules ≥3 且 keyMessage 非空；',
      '**任意两个段落的版式序列不得完全相同**（模板复制会被拒）；页面 id 全局唯一。',
      '',
      '重要稿件写完方案后停一下：用 askUser 让用户确认方案再往下做。',
    ].join('\n'),
    parameters: z.object({
      plan: DECK_PLAN_SCHEMA.describe('完整策划稿，按 schema 填'),
    }),
    execute: async ({ plan }) => {
      const check = validatePlan(plan)
      if (!check.ok) {
        return JSON.stringify({
          ok: false,
          errors: check.errors,
          hint: '方案被拒 —— 按错误逐条改完，重写一次 setPlan。改方案只是改 JSON，比建完页再返工便宜得多',
        })
      }

      await ctx.save(check.plan)
      ctx.emit({ type: 'agent.plan', plan: check.plan })

      const pageCount = check.plan.sections.reduce((n, s) => n + s.slides.length, 0)
      const patternList = check.plan.sections.map(s => s.slides.map(p => p.pattern).join('→')).join(' · ')
      return JSON.stringify({
        ok: true,
        pageCount,
        sectionCount: check.plan.sections.length,
        patternList,
        hint: '方案已落盘并展示给用户。接下来按方案执行：setTheme 定调 → 逐页 addSlide + applyLayout（pattern / variant 照方案抄）',
      })
    },
  })

  const getPlan = tool({
    description: '取回当前会话已落盘的策划稿。历史被截断、或要确认方案里某一段时用它',
    parameters: z.object({}),
    // SDK 要求 execute 返回 PromiseLike；`renderPlan` 抽成同步纯函数，
    // execute 里的这一个 await 就是它的全部 —— 也顺带满足 require-await
    execute: async () => await renderPlan(ctx),
  })

  return { setPlan, getPlan }
}

export type PlanTools = ReturnType<typeof createPlanTools>
