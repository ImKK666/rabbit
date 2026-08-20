/**
 * 渲染后反思 —— 纯计算那一半
 *
 * 输入：deck 里声明的元素 + **前端量回来的真实渲染高度**
 * 输出：只有渲染之后才看得见的那些问题
 *
 * ## 为什么必须量，不能算
 *
 * `design.ts` 的 `estimateTextHeight` 是**估**的：按 CJK 全宽算字数、除以框宽得行数。
 * 版式引擎拿这个估值往下累加 `y`，决定下一个元素放哪。估小了，下一个元素就压上来。
 *
 * 而这件事**现有的检查一条都看不见**（`scripts/measure-layout-text.mjs` 头注释实测过）：
 *
 * | 检查 | 为什么看不见 |
 * |---|---|
 * | `lintSlide` 的「超出画布」 | `Builder.text()` 把框高夹进了画布，框永远在里面 |
 * | `lintSlide` 的「文本重叠」 | 比的是**声明的框**，而溢出发生在框**外面**（PPTist 不裁剪文本） |
 *
 * 于是 66 张样张跑下来 **0 告警**，其中好几张肉眼就能看到文字压在一起。
 * 换个量法就都看见了：**不问「框在哪」，问「字画到哪了」**。
 *
 * ## 为什么只报「新增」的问题
 *
 * 拿真实高度重跑一次 `lintSlide`，把结果和用**声明高度**跑的那次相减 ——
 * 差集才是「渲染之后才暴露的」。不做这个减法的话，`lintDeck` 已经报过的
 * 每一条都会再报一遍，agent 收到一堆重复项，真正的新信息被淹掉。
 *
 * **几何检查一行都没重写**，换的只是输入。这是这个做法最值钱的地方：
 * 重叠 / 越界 / 安全区的判定逻辑仍然只有一份。
 */

import type { Slide, PPTElement } from '@/types/slides'
import { lintSlide, type LintIssue } from './kernel'

/** 前端量回来的一条 */
export interface TextMeasurement {
  slideId: string
  elementId: string
  /** `.text` 节点的 offsetHeight，逻辑像素。不受祖先 CSS transform 影响 */
  actualHeight: number
}

/**
 * 差多少才算「真的溢出」。
 *
 * 4px 抄的是 `scripts/measure-layout-text.mjs` 的 `--tolerance` 默认值 ——
 * 1~2px 是行高取整的正常抖动，报出来全是噪音。
 * 两处必须用同一个数，否则「工具说没事、脚本说有事」这种事会发生，
 * 而那时没人知道该信哪个（判据 R3 就是为了防这个）。
 */
export const OVERFLOW_TOLERANCE_PX = 4

export interface TextOverflow {
  slideId: string
  /** 第几页（从 1 起），给用户和 agent 看的 */
  slideIndex: number
  elementId: string
  /** 元素声明的 height —— 版式引擎估出来的那个 */
  declared: number
  /** 真正渲染出来的高度 */
  actual: number
  /** 溢出了多少像素 */
  overflow: number
  /** 前 40 字，好让 agent 认得出是哪块文字 */
  preview: string
}

export interface ReflectionReport {
  /** 实际量到了几个文本元素 */
  measured: number
  /** 溢出的文本 */
  overflows: TextOverflow[]
  /** 用真实高度重跑 lint 之后**新冒出来**的问题 */
  newIssues: LintIssue[]
}

/** 把 HTML 剥成纯文本，取前 n 字 */
const preview = (html: string, n = 40): string => {
  const text = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  return text.length > n ? `${text.slice(0, n)}…` : text
}

/** 这条 issue 的身份。比对差集用 —— 同一个元素同一句话就是同一条 */
const issueKey = (i: LintIssue) => `${i.slideId}|${i.elementId ?? ''}|${i.message}`

/**
 * 把量到的真实高度贴回元素上，得到「渲染后的那份 slide」。
 *
 * **只改 height，别的一个字段不动。** 位置是版式引擎定的，
 * 我们要看的正是「按原位置摆、但用真实高度」会撞成什么样。
 */
const applyMeasurements = (slide: Slide, byElement: Map<string, number>): Slide => ({
  ...slide,
  elements: slide.elements.map((el): PPTElement => {
    const actual = byElement.get(el.id)
    if (actual === undefined || el.type !== 'text') return el
    return { ...el, height: actual }
  }),
})

/**
 * 量完之后能说出什么。
 *
 * 没量到的页原样跳过 —— 前端只渲染了一部分（视口懒加载）时，
 * 对没量到的页什么都不说，比拿声明高度冒充实测更诚实。
 */
export const reflectOnRender = (
  slides: Slide[],
  measurements: TextMeasurement[],
): ReflectionReport => {
  const bySlide = new Map<string, Map<string, number>>()
  for (const m of measurements) {
    if (!bySlide.has(m.slideId)) bySlide.set(m.slideId, new Map())
    bySlide.get(m.slideId)!.set(m.elementId, m.actualHeight)
  }

  const overflows: TextOverflow[] = []
  const newIssues: LintIssue[] = []
  let measured = 0

  slides.forEach((slide, index) => {
    const byElement = bySlide.get(slide.id)
    if (!byElement || byElement.size === 0) return

    for (const el of slide.elements) {
      const actual = byElement.get(el.id)
      if (actual === undefined || el.type !== 'text') continue
      measured++
      const overflow = actual - el.height
      if (overflow <= OVERFLOW_TOLERANCE_PX) continue
      overflows.push({
        slideId: slide.id,
        slideIndex: index + 1,
        elementId: el.id,
        declared: Math.round(el.height),
        actual: Math.round(actual),
        overflow: Math.round(overflow),
        preview: preview(el.content),
      })
    }

    // 差集：用真实高度跑出来、而用声明高度跑不出来的那些
    const before = new Set(lintSlide(slide).map(issueKey))
    for (const issue of lintSlide(applyMeasurements(slide, byElement))) {
      if (!before.has(issueKey(issue))) newIssues.push(issue)
    }
  })

  return { measured, overflows, newIssues }
}

/**
 * 报告 → 给 agent 看的一段话。
 *
 * **每条都带上「怎么改」**：只说「第 3 页第 2 个文本溢出了 37px」，
 * agent 的第一反应是把框调高，而框调高只会去压下一个元素。
 * 真正的修法是减字数或降一档字号 —— 这句必须写出来。
 */
export const describeReflection = (report: ReflectionReport): string => {
  if (report.measured === 0) {
    return '没有量到任何文本元素（可能这几页上没有文本，或者前端没渲染这些页）。'
  }

  const lines: string[] = [`量了 ${report.measured} 个文本元素。`]

  if (report.overflows.length === 0) {
    lines.push('没有文本溢出 —— 每块文字都画在它自己的框里。')
  }
  else {
    lines.push('', `**${report.overflows.length} 处文本画到框外面去了**（估出来的高度不够）：`)
    for (const o of report.overflows) {
      lines.push(`- 第 ${o.slideIndex} 页 ${o.elementId}：框高 ${o.declared}，实际画了 ${o.actual}，溢出 ${o.overflow}px`)
      lines.push(`  内容「${o.preview}」`)
    }
    lines.push(
      '',
      '**改法**：减字数，或者把字号降一档（从设计规范的阶梯里取下一档，别自己编数值），',
      '或者换一个容得下这么多字的版式。**不要直接把框调高** —— 框在版式里是算出来的，',
      '调高它只会去压下面那个元素，问题从「文字出框」变成「两块文字叠在一起」。',
    )
  }

  if (report.newIssues.length > 0) {
    lines.push('', `**按真实高度重算，多出 ${report.newIssues.length} 个几何问题**（这些用声明高度是查不出来的）：`)
    for (const i of report.newIssues) {
      lines.push(`- [${i.level}] ${i.message}`)
    }
  }

  return lines.join('\n')
}
