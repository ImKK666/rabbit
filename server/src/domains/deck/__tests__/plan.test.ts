/**
 * 策划稿校验（P1–P8）与 lint ⑫ 一致性的判据 —— R-63，docs/16-workflow-redesign.md
 *
 * 这一组的锚是两件事：
 *   - P5 的负对照**直接复刻会话 76 的实测病**：五个部门分组的版式序列整组复制
 *     （section→cards→bullets→…→stat 出现五遍），方案层必须拒掉它
 *   - 三条从 lintDeck 前置的判据（P2/P3/P4）与 kernel 同口径，
 *     方案过了、建成之后 lint ①⑦⑧ 一定不红
 */

import { describe, it, expect } from 'vitest'
import type { Slide } from '@/types/slides'
import {
  validatePlan, lintPlanAdherence, planSectionSignature,
  type DeckPlan, type PlanSection, type PlanSlide,
} from '../plan'

/** 一行规划卡的最小构造。缺的字段给默认值，测的字段逐个覆盖 */
const slide = (over: Partial<PlanSlide> & { id: string; pattern: PlanSlide['pattern'] }): PlanSlide => ({
  title: over.id,
  purpose: 'purpose',
  keyMessage: '记住这一句',
  modules: 4,
  ...over,
})

const section = (over: Partial<PlanSection> & { slides: PlanSlide[] }): PlanSection => ({
  id: `s_${Math.random().toString(36).slice(2, 8)}`,
  title: '段落',
  purpose: '这段要干什么',
  ...over,
})

const plan = (sections: PlanSection[], over: Partial<DeckPlan> = {}): DeckPlan => ({
  version: 1,
  narrative: '从问题到方案再到落地',
  styleIntent: 'swiss grid minimalism',
  sections,
  ...over,
})

/**
 * 会话 76 那套部门分组模板（把 stat 提前一格，保证内容页连排 ≤4，
 * 让 P4 与 P5 各测各的）：七个版式整组复制
 */
const DEPT_TEMPLATE = [
  'section', 'cards', 'bullets', 'funnel', 'stat', 'bullets', 'compare',
] as const

const deptSection = (id: string): PlanSection => section({
  id,
  title: `${id} 组`,
  slides: DEPT_TEMPLATE.map((pattern, i) => slide({ id: `${id}_p${i}`, pattern, modules: pattern === 'section' || pattern === 'stat' ? 0 : 4 })),
})

describe('validatePlan · 正样本', () => {
  it('一份合理的小稿子通过', () => {
    const result = validatePlan(plan([
      section({
        title: '开场',
        slides: [
          slide({ id: 'cover', pattern: 'title-center', modules: 0 }),
          slide({ id: 'why', pattern: 'stat', modules: 0 }),
        ],
      }),
      section({
        title: '主体',
        slides: [
          slide({ id: 'a1', pattern: 'cards' }),
          slide({ id: 'a2', pattern: 'timeline' }),
          slide({ id: 'a3', pattern: 'compare' }),
          slide({ id: 'a4', pattern: 'stat', modules: 0 }),
          slide({ id: 'end', pattern: 'end', modules: 0 }),
        ],
      }),
    ]))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.plan.sections).toHaveLength(2)
  })

  it('同版式不同变体相邻不算雷同（B 变体是另一种结构）', () => {
    const result = validatePlan(plan([
      section({
        slides: [
          slide({ id: 'cover', pattern: 'title-center', modules: 0 }),
          slide({ id: 'a1', pattern: 'cards', variant: 'A' }),
          slide({ id: 'a2', pattern: 'cards', variant: 'B' }),
          slide({ id: 'end', pattern: 'end', modules: 0 }),
        ],
      }),
    ]))
    expect(result.ok).toBe(true)
  })
})

describe('validatePlan · P1 变体只属于三个版式', () => {
  it('compare 没有 B 变体 —— 报错', () => {
    const result = validatePlan(plan([
      section({
        slides: [
          slide({ id: 'cover', pattern: 'title-center', modules: 0 }),
          slide({ id: 'a1', pattern: 'compare', variant: 'B' }),
          slide({ id: 'end', pattern: 'end', modules: 0 }),
        ],
      }),
    ]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.includes('a1'))).toBe(true)
  })
})

describe('validatePlan · P2 相邻雷同', () => {
  it('相邻两页同版式同变体 —— 报错', () => {
    const result = validatePlan(plan([
      section({
        slides: [
          slide({ id: 'cover', pattern: 'title-center', modules: 0 }),
          slide({ id: 'a1', pattern: 'cards' }),
          slide({ id: 'a2', pattern: 'cards' }),
          slide({ id: 'end', pattern: 'end', modules: 0 }),
        ],
      }),
    ]))
    expect(result.ok).toBe(false)
  })
})

describe('validatePlan · P3 单一版式占比', () => {
  it('12 页里 9 页 cards —— 报错', () => {
    const slides: PlanSlide[] = [slide({ id: 'cover', pattern: 'title-center', modules: 0 })]
    for (let i = 0; i < 9; i++) slides.push(slide({ id: `c${i}`, pattern: 'cards' }))
    slides.push(slide({ id: 'a1', pattern: 'bullets' }))
    slides.push(slide({ id: 'end', pattern: 'end', modules: 0 }))
    const result = validatePlan(plan([section({ slides })]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.includes('cards'))).toBe(true)
  })
})

describe('validatePlan · P4 节奏间隔', () => {
  it('连着 5 页内容页 —— 报错', () => {
    const result = validatePlan(plan([
      section({
        slides: [
          slide({ id: 'cover', pattern: 'title-center', modules: 0 }),
          slide({ id: 'a1', pattern: 'cards' }),
          slide({ id: 'a2', pattern: 'bullets' }),
          slide({ id: 'a3', pattern: 'timeline' }),
          slide({ id: 'a4', pattern: 'compare' }),
          slide({ id: 'a5', pattern: 'funnel' }),
          slide({ id: 'end', pattern: 'end', modules: 0 }),
        ],
      }),
    ]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.includes('连着 5 页'))).toBe(true)
  })

  it('中间插一页 stat 就通过', () => {
    const result = validatePlan(plan([
      section({
        slides: [
          slide({ id: 'cover', pattern: 'title-center', modules: 0 }),
          slide({ id: 'a1', pattern: 'cards' }),
          slide({ id: 'a2', pattern: 'bullets' }),
          slide({ id: 'r1', pattern: 'stat', modules: 0 }),
          slide({ id: 'a3', pattern: 'timeline' }),
          slide({ id: 'a4', pattern: 'compare' }),
          slide({ id: 'end', pattern: 'end', modules: 0 }),
        ],
      }),
    ]))
    expect(result.ok).toBe(true)
  })
})

describe('validatePlan · P5 段落序列去重（会话 76 的病）', () => {
  it('**负对照**：两个部门分组版式序列一模一样 —— 报错', () => {
    const result = validatePlan(plan([deptSection('ops'), deptSection('design')]))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some(e => e.includes('ops 组') && e.includes('design 组'))).toBe(true)
    }
  })

  it('签名函数把序列压成一段可比的字符串', () => {
    expect(planSectionSignature(deptSection('ops'))).toBe(
      'section|A+cards|A+bullets|A+funnel|A+stat|A+bullets|A+compare|A',
    )
  })

  it('用 B 变体拉开就通过 —— 这就是给模型的出路', () => {
    const design = deptSection('design')
    // 把 design 组的 cards 和 bullets 换成 B 变体
    design.slides = design.slides.map((s, i) => (i === 1 || i === 2 ? { ...s, variant: 'B' as const } : s))
    const result = validatePlan(plan([deptSection('ops'), design]))
    expect(result.ok).toBe(true)
  })

  it('单页段落不参与比较 —— 三段各一页、首尾同版式也不判复制', () => {
    // 刻意让第 1、3 段都是单页 cards：P5 对单页段落豁免，
    // 而 P2 也不触发（中间隔了一页 stat）
    const result = validatePlan(plan([
      section({ slides: [slide({ id: 'a1', pattern: 'cards' })] }),
      section({ slides: [slide({ id: 'b1', pattern: 'stat', modules: 0 })] }),
      section({ slides: [slide({ id: 'c1', pattern: 'cards' })] }),
    ]))
    expect(result.ok).toBe(true)
  })
})

describe('validatePlan · P6 内容密度', () => {
  it('内容页模块数不足 —— 报错', () => {
    const result = validatePlan(plan([
      section({
        slides: [
          slide({ id: 'cover', pattern: 'title-center', modules: 0 }),
          slide({ id: 'a1', pattern: 'cards', modules: 2 }),
          slide({ id: 'end', pattern: 'end', modules: 0 }),
        ],
      }),
    ]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.includes('a1') && e.includes('模块'))).toBe(true)
  })

  it('keyMessage 只有空白 —— 报错', () => {
    const result = validatePlan(plan([
      section({
        slides: [
          slide({ id: 'cover', pattern: 'title-center', modules: 0, keyMessage: 'x' }),
          slide({ id: 'a1', pattern: 'cards', keyMessage: '   ' }),
          slide({ id: 'end', pattern: 'end', modules: 0, keyMessage: 'x' }),
        ],
      }),
    ]))
    expect(result.ok).toBe(false)
  })

  it('节奏页不要求模块数', () => {
    const result = validatePlan(plan([
      section({
        slides: [
          slide({ id: 'cover', pattern: 'title-center', modules: 0 }),
          slide({ id: 'r1', pattern: 'quote', modules: 0 }),
          slide({ id: 'end', pattern: 'end', modules: 0 }),
        ],
      }),
    ]))
    expect(result.ok).toBe(true)
  })
})

describe('validatePlan · P7/P8 与形状', () => {
  it('页面 id 重复 —— 报错', () => {
    const result = validatePlan(plan([
      section({ slides: [slide({ id: 'cover', pattern: 'title-center', modules: 0 }), slide({ id: 'a1', pattern: 'cards' })] }),
      section({ slides: [slide({ id: 'a1', pattern: 'bullets' }), slide({ id: 'end', pattern: 'end', modules: 0 })] }),
    ]))
    expect(result.ok).toBe(false)
  })

  it('只有一页 —— 报错', () => {
    const result = validatePlan(plan([section({ slides: [slide({ id: 'cover', pattern: 'title-center', modules: 0 })] })]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.includes('至少 2 页'))).toBe(true)
  })

  it('**负对照**：不是对象 / 缺叙事线 —— 形状错误直接拒，不抛异常', () => {
    expect(validatePlan(null).ok).toBe(false)
    expect(validatePlan('一串字符串').ok).toBe(false)
    const noNarrative = plan([section({ slides: [slide({ id: 'a', pattern: 'cards' })] })])
    delete (noNarrative as { narrative?: string }).narrative
    const result = validatePlan(noNarrative)
    expect(result.ok).toBe(false)
  })
})

describe('lintPlanAdherence · lint ⑫', () => {
  const thePlan = plan([
    section({
      slides: [
        slide({ id: 'cover', pattern: 'title-center', modules: 0 }),
        slide({ id: 'a1', pattern: 'cards' }),
      ],
    }),
  ])

  const deckSlide = (id: string, layout: string, layoutVariant?: string): Slide =>
    ({ id, elements: [], layout, layoutVariant }) as Slide

  it('版式偏离方案 —— 报 warning', () => {
    const issues = lintPlanAdherence(thePlan, [deckSlide('cover', 'title-center'), deckSlide('a1', 'bullets')])
    expect(issues.some(i => i.slideId === 'a1' && i.level === 'warning' && i.message.includes('策划稿'))).toBe(true)
  })

  it('变体不一致也算偏离', () => {
    const issues = lintPlanAdherence(thePlan, [deckSlide('cover', 'title-center'), deckSlide('a1', 'cards', 'B')])
    expect(issues.some(i => i.slideId === 'a1' && i.message.includes('cards|B'))).toBe(true)
  })

  it('方案里声明了、deck 里连页都没有 —— 报「还没建」', () => {
    const issues = lintPlanAdherence(thePlan, [deckSlide('cover', 'title-center')])
    expect(issues.some(i => i.slideId === 'a1' && i.message.includes('还没有建'))).toBe(true)
  })

  it('照方案建的就是全绿（不挑刺）', () => {
    const issues = lintPlanAdherence(thePlan, [deckSlide('cover', 'title-center'), deckSlide('a1', 'cards')])
    expect(issues).toEqual([])
  })

  it('deck 里多出来的页不算漂移（局部调整 / 用户后加都合法）', () => {
    const issues = lintPlanAdherence(thePlan, [
      deckSlide('cover', 'title-center'),
      deckSlide('a1', 'cards'),
      deckSlide('extra', 'stat'),
    ])
    expect(issues).toEqual([])
  })
})
