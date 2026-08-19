/**
 * R-39 · 网页分步 ≡ PPTX 分步
 *
 * 同一份 `animations` 数组要被两套代码解释成时间线：
 *
 *   网页放映  `useSlidesStore().formatedAnimations`（本文件旁边的 slides.ts）
 *             → 一串「格」，每格一组同时播的动画，autoNext 表示播完自动接下一格
 *   PPTX 导出 `groupTriggersIntoSteps`（`@/utils/animationSteps`，buildTimingXml 用它）
 *             → 点击步 → 子步 → 效果的三层树
 *
 * 两边算出来的东西必须逐格相同，否则就是「网页上看着对，导出后不对」——
 * 而这种偏差不会报错、不会崩，只会让放映的节奏悄悄变一个样。
 *
 * 这里不是抽查几个例子，是**穷举长度 1~5 的全部 trigger 序列**（3+9+27+81+243 = 363 条）
 * 逐条比对。分步只取决于 trigger，所以穷举 trigger 就是穷举全部输入。
 *
 * `formatedAnimations` 保持原样没有被重构掉：它是上游 PPTist 的播放路径，
 * 返回的是动画对象而不是下标。与其为了「共用一份」去动放映逻辑，不如把等价性钉死在这里。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSlidesStore } from '@/store/slides'
import {
  groupTriggersIntoSteps, flattenTriggerSteps, type AnimationTrigger,
} from '@/utils/animationSteps'
import type { PPTAnimation, PPTElement, Slide } from '@/types/slides'

const TRIGGERS: AnimationTrigger[] = ['click', 'auto', 'meantime']

const el = (i: number): PPTElement => ({
  id: `el${i}`, type: 'text', left: 0, top: i * 20, width: 100, height: 20, rotate: 0,
  content: '<p>x</p>', defaultFontName: 'Microsoft YaHei', defaultColor: '#111111',
} as unknown as PPTElement)

const anim = (i: number, trigger: AnimationTrigger, elId = `el${i}`): PPTAnimation => ({
  id: `a${i}`, elId, effect: 'fade', type: 'in', duration: 500, trigger,
})

/** 所有长度为 n 的 trigger 序列 */
const sequences = (n: number): AnimationTrigger[][] =>
  n === 0
    ? [[]]
    : sequences(n - 1).flatMap(prefix => TRIGGERS.map(t => [...prefix, t]))

/** 网页侧：把 formatedAnimations 压成 [{elIds, autoNext}] */
const webCells = (triggers: AnimationTrigger[]) => {
  const store = useSlidesStore()
  const slide: Slide = {
    id: 's1',
    elements: triggers.map((_, i) => el(i)),
    animations: triggers.map((t, i) => anim(i, t)),
  }
  store.setSlides([slide])
  store.updateSlideIndex(0)
  return store.formatedAnimations.map(cell => ({
    elIds: cell.animations.map(a => a.elId),
    autoNext: cell.autoNext,
  }))
}

/** 导出侧：把 groupTriggersIntoSteps 压成同一个形状 */
const pptxCells = (triggers: AnimationTrigger[]) => {
  const steps = groupTriggersIntoSteps(triggers)
  return steps.flatMap(step => step.subSteps.map((group, i) => ({
    elIds: group.map(idx => `el${idx}`),
    // 同一个点击步里还有后续子步 = 播完自动接上，正是网页的 autoNext
    autoNext: i < step.subSteps.length - 1,
  })))
}

describe('分步规则 · 网页与 PPTX 逐格一致', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  const all = [1, 2, 3, 4, 5].flatMap(sequences)

  it(`穷举 ${all.length} 条 trigger 序列，两侧分格完全相同`, () => {
    for (const triggers of all) {
      expect(pptxCells(triggers), triggers.join('/')).toEqual(webCells(triggers))
    }
  })

  it('穷举全部序列，「进页是否自动播」两侧结论相同', () => {
    for (const triggers of all) {
      const store = useSlidesStore()
      const slide: Slide = {
        id: 's1',
        elements: triggers.map((_, i) => el(i)),
        animations: triggers.map((t, i) => anim(i, t)),
      }
      store.setSlides([slide])
      store.updateSlideIndex(0)

      // 网页：useExecPlay 的 onMounted 判据 —— 第一格全是 auto/meantime 才自动播
      const first = store.formatedAnimations[0]
      const webAutoPlays = first.animations.every(a => a.trigger === 'auto' || a.trigger === 'meantime')

      // PPTX：第一个点击步的 stCondLst 是 delay=0 还是 indefinite
      const pptxAutoPlays = !groupTriggersIntoSteps(triggers)[0].waitsForClick

      expect(pptxAutoPlays, triggers.join('/')).toBe(webAutoPlays)
    }
  })

  it('空动画表两侧都给空', () => {
    expect(webCells([])).toEqual([])
    expect(pptxCells([])).toEqual([])
    expect(groupTriggersIntoSteps([])).toEqual([])
  })
})

describe('分步规则 · 语义', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('click 开新的点击步，auto 开子步，meantime 并进当前子步', () => {
    const steps = groupTriggersIntoSteps(['click', 'meantime', 'auto', 'meantime', 'click', 'auto'])
    expect(steps).toEqual([
      { waitsForClick: true, subSteps: [[0, 1], [2, 3]] },
      { waitsForClick: true, subSteps: [[4], [5]] },
    ])
  })

  it('第一条不是 click 时整页第一步进页即播', () => {
    expect(groupTriggersIntoSteps(['auto', 'auto'])[0].waitsForClick).toBe(false)
    expect(groupTriggersIntoSteps(['meantime'])[0].waitsForClick).toBe(false)
    expect(groupTriggersIntoSteps(['click'])[0].waitsForClick).toBe(true)
  })

  // 第一条没有「上一条」可以接，auto / meantime 都只能退化成「自己起一步」
  it('第一条的 auto / meantime 不会凭空并进不存在的上一步', () => {
    expect(groupTriggersIntoSteps(['auto', 'click'])).toHaveLength(2)
    expect(groupTriggersIntoSteps(['meantime', 'meantime'])[0].subSteps).toEqual([[0, 1]])
  })

  it('flattenTriggerSteps 把子步摊成「第几眼看到」', () => {
    const steps = groupTriggersIntoSteps(['click', 'auto', 'meantime', 'click'])
    expect(flattenTriggerSteps(steps)).toEqual([[0], [1, 2], [3]])
  })

  /**
   * 已知且刻意保留的一处差异：同一个元素在同一格里挂两条动画时，
   * 网页侧会把先来的那条挤掉（slides.ts 的 meantime 分支有一句 filter），
   * 导出侧两条都写进去。
   *
   * 不改的理由：谁改都是在改一条**没有产品含义**的输入 ——
   * 一个元素在同一瞬间播两个入场动画本身就没意义。版式引擎不会产出这种输入
   * （每条动画一个元素），agent 手工挂重了 lint 也不会拦。
   * 钉在这里是为了让它是「记录在案」而不是「哪天有人发现的惊喜」。
   */
  it('同格重复元素：网页去重、PPTX 不去重（已知差异，非缺陷）', () => {
    const store = useSlidesStore()
    store.setSlides([{
      id: 's1',
      elements: [el(0)],
      animations: [anim(0, 'click', 'el0'), anim(1, 'meantime', 'el0')],
    }])
    store.updateSlideIndex(0)

    expect(store.formatedAnimations[0].animations.map(a => a.id)).toEqual(['a1'])
    expect(groupTriggersIntoSteps(['click', 'meantime'])[0].subSteps).toEqual([[0, 1]])
  })
})
