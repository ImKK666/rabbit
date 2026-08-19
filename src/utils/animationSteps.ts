/**
 * R-39 · trigger → 「步」的分组规则（纯函数，零运行时依赖）
 *
 * 一页的 `animations` 是**有序数组**，`trigger` 把条目串成时间线：
 *
 *   click    新开一个「点击步」，播放时停在这里等用户点
 *   auto     在当前点击步里新开一个「子步」，上一子步结束后自动接上
 *   meantime 并进当前子步，与同组的效果一起播
 *
 * 第一条动画特殊：它没有「上一条」，所以 auto / meantime 都退化成「进页即播」——
 * 点击步照开，只是不等点击。
 *
 * ## 为什么单独一个文件
 *
 * 这条规则原来有两份实现：网页播放走 `src/store/slides.ts` 的 `formatedAnimations`，
 * PPTX 导出走 `src/utils/ooxml/buildTimingXml.ts` 的 `groupIntoSteps`。两边算出来的
 * 分步必须逐格相同，否则「网页上看着对，导出后不对」——而这种偏差没有任何东西在守。
 *
 * 现在导出侧和 kernel 的出场顺序 lint 都用这一份；`formatedAnimations` 保持原样
 * （它是上游 PPTist 的播放路径，返回的是动画对象而不是下标），
 * 两者的等价性由 `src/store/__tests__/animationSteps.test.ts` 穷举 trigger 序列逐条比对。
 *
 * 只吃 trigger 序列，不碰 effect / preset / 元素 —— 分步是纯粹的时间线语义。
 */

import type { PPTAnimation } from '@/types/slides'

export type AnimationTrigger = PPTAnimation['trigger']

/** 一个点击步。下标指回输入数组 */
export interface TriggerStep {
  /** true = 等用户点击；false = 进页即播（只可能是整页第一步） */
  waitsForClick: boolean
  /** 每个子步是一组「同时播」的下标；子步之间自动接续 */
  subSteps: number[][]
}

export const groupTriggersIntoSteps = (triggers: readonly AnimationTrigger[]): TriggerStep[] => {
  const steps: TriggerStep[] = []

  triggers.forEach((trigger, i) => {
    if (!steps.length) {
      steps.push({ waitsForClick: trigger === 'click', subSteps: [[i]] })
      return
    }

    const current = steps[steps.length - 1]
    if (trigger === 'click') steps.push({ waitsForClick: true, subSteps: [[i]] })
    else if (trigger === 'auto') current.subSteps.push([i])
    else current.subSteps[current.subSteps.length - 1].push(i)
  })

  return steps
}

/**
 * 摊平成「格」—— 一格 = 一次连续播放的动画组，等价于网页侧 `formatedAnimations` 的一项。
 *
 * 点击步的第一个子步之外，其余子步都是「上一格播完自动接上」，
 * 所以摊平后「第几格」就是观众**第几眼**看到这组元素，正是出场顺序要比的那个量。
 */
export const flattenTriggerSteps = (steps: TriggerStep[]): number[][] =>
  steps.flatMap(step => step.subSteps)
