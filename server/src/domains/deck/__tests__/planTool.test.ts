/**
 * 策划稿工具的判据 —— setPlan / getPlan（R-63）
 *
 * 三件事各测一段：
 *   - 校验：方案不过 P1–P8 时**绝不落库、绝不发下行**（拒错是整套设计的闸门）
 *   - 落库与下行：过了才 save + emit agent.plan，且 save 的是校验后的同一份
 *   - getPlan：取回当前方案；没有方案时明说
 *
 * 落库回调是注入的（planTool 不碰库，见 planTool.ts 头注释），
 * 这里用一个内存数组模拟。
 */

import { describe, it, expect } from 'vitest'
import type { ServerMessage } from '@server/ws/handler'
import { createPlanTools } from '../planTool'
import type { DeckPlan, PlanSection, PlanSlide } from '../plan'

const slide = (over: Partial<PlanSlide> & { id: string; pattern: PlanSlide['pattern'] }): PlanSlide => ({
  title: over.id,
  purpose: 'purpose',
  keyMessage: '记住这一句',
  modules: 4,
  ...over,
})

const goodPlan: DeckPlan = {
  version: 1,
  narrative: '从问题到方案再到落地',
  styleIntent: 'swiss grid minimalism',
  sections: [{
    id: 's01',
    title: '开场',
    purpose: '点题',
    slides: [
      slide({ id: 'cover', pattern: 'title-center', modules: 0 }),
      slide({ id: 'a1', pattern: 'cards' }),
      slide({ id: 'end', pattern: 'end', modules: 0 }),
    ],
  }],
}

const CTX = {} as never
const run = (fn: unknown, args: unknown) =>
  (fn as (a: unknown, c: never) => Promise<string>)(args, CTX)

const makeHarness = (initial: DeckPlan | null = null) => {
  let current = initial
  const saved: DeckPlan[] = []
  const emitted: ServerMessage[] = []
  const tools = createPlanTools({
    get: () => current,
    save: (p) => {
      current = p
      saved.push(p)
      return Promise.resolve()
    },
    emit: (msg) => {
      emitted.push(msg)
    },
  })
  return { tools, saved: () => saved, emitted: () => emitted, current: () => current }
}

describe('setPlan', () => {
  it('合法方案：save 落库 + 发 agent.plan，返回摘要带页数和版式序列', async () => {
    const h = makeHarness()
    const out = await run(h.tools.setPlan.execute, { plan: goodPlan })
    expect(JSON.parse(out).ok).toBe(true)
    expect(JSON.parse(out).pageCount).toBe(3)
    expect(h.saved()).toHaveLength(1)
    expect(h.saved()[0]).toEqual(goodPlan)
    expect(h.emitted()).toHaveLength(1)
    expect(h.emitted()[0].type).toBe('agent.plan')
  })

  it('**负对照**：非法方案（两个段落序列完全相同）—— 不落库、不发下行，错误逐条返回', async () => {
    const h = makeHarness()
    const dup = (id: string): PlanSection => ({
      id,
      title: `${id} 组`,
      purpose: 'x',
      slides: [
        slide({ id: `${id}_cover`, pattern: 'title-center', modules: 0 }),
        slide({ id: `${id}_a1`, pattern: 'cards' }),
        slide({ id: `${id}_a2`, pattern: 'bullets' }),
        slide({ id: `${id}_end`, pattern: 'end', modules: 0 }),
      ],
    })
    const bad = { ...goodPlan, sections: [dup('s1'), dup('s2')] }

    const out = await run(h.tools.setPlan.execute, { plan: bad })
    const parsed = JSON.parse(out)
    expect(parsed.ok).toBe(false)
    expect(parsed.errors.some((e: string) => e.includes('s1 组') && e.includes('s2 组'))).toBe(true)
    expect(h.saved()).toHaveLength(0)
    expect(h.emitted()).toHaveLength(0)
    expect(h.current()).toBeNull()
  })

  it('重写方案：第二次 setPlan 覆盖旧方案（方向变了改的是方案，不是页）', async () => {
    const h = makeHarness()
    await run(h.tools.setPlan.execute, { plan: goodPlan })
    const revised = { ...goodPlan, narrative: '换一条叙事线' }
    await run(h.tools.setPlan.execute, { plan: revised })
    expect(h.saved()).toHaveLength(2)
    expect(h.current()?.narrative).toBe('换一条叙事线')
  })
})

describe('getPlan', () => {
  it('有方案时原样取回', async () => {
    const h = makeHarness(goodPlan)
    const out = await run(h.tools.getPlan.execute, {})
    expect(JSON.parse(out).narrative).toBe('从问题到方案再到落地')
  })

  it('**负对照**：没有方案时明说，不抛异常', async () => {
    const h = makeHarness()
    const out = await run(h.tools.getPlan.execute, {})
    expect(JSON.parse(out).ok).toBe(false)
  })
})
