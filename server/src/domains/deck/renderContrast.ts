/**
 * 渲染后对比度 —— 纯计算那一半
 *
 * 输入：前端量回来的「每块文字**实际是什么颜色**、它底下**实际是什么颜色**」
 * 输出：真正读不出来的那些文字
 *
 * ## 为什么必须量，不能算
 *
 * `design.ts` 的 `scrimFor` 算的是「遮罩压在**图片解码亮度**上之后，
 * 文字踩在什么颜色上」（`ScrimSpec.effectiveBg`）。那个推算漏掉了一整类东西：
 *
 * | 谁盖在文字底下 | `scrimFor` 知不知道 |
 * |---|---|
 * | 背景图 + 它的遮罩 | ✅ 知道，它算的就是这个 |
 * | **版式自己画的装饰**（光晕 / 装饰环 / 斜块 / 强调色分界线） | ❌ **完全不知道** |
 * | **生成装饰层**（ornament，14 号文档） | ❌ 不可能知道，模型画的 |
 *
 * 第二行是 R-48 判过、R-50 才发现**漏修了整整一轮**的老问题
 * （`docs/04-changes.md` R-50「三件只有看截图才发现的事」第 3 件）。
 * 它的特征正是这个仓库最怕的那种：**所有断言都是绿的**。
 *
 * 第三行是 14 号文档判据 O6 的前置 —— 决策者选了「装饰层允许压在内容之上」，
 * 那一刻静态推算就彻底判不了了，合成后实测成为唯一的地面真相。
 *
 * ## 和 `renderReflect.ts` 是同一个形状
 *
 * **换的是输入，不是检查。** `contrastRatio` 一行不改，
 * `CONTRAST_AA = 4.5` 也不动 —— 改的只是喂给它的背景色：
 * 从 `scrimFor` 推算的 `effectiveBg`，变成前端在真实渲染上采样出来的值。
 *
 * 这是 `renderReflect` 最值钱的那个做法（几何检查一行没重写，只换输入）
 * 在颜色这一维上的复用。
 *
 * ## 「最坏那一头」的判据必须和 `scrimFor` 逐字相同
 *
 * 取 {p5, p95} 里**离文字亮度更近**的那个 —— 对比度在「背景亮度 ≈ 文字亮度」
 * 时最低。`scrimFor` 的注释 ② 把这条推导写全了，而且记着「写那条测试时
 * 我一开始断言反了（以为一律亮图压得更狠），是测试把这个思考错误当场抓住的」。
 *
 * **两处必须用同一条判据。** 用不同的判据会出现「遮罩按 p5 算、检查按 p95 判」，
 * 那时遮罩永远修不好检查报的问题，而没有人知道该信哪个。
 */

import type { Slide, PPTElement } from '@/types/slides'
import { contrastRatio, luminance, CONTRAST_AA } from './design'

/**
 * 前端量回来的一条。
 *
 * 三个字段全都是**只有浏览器知道**的：文字的计算后颜色、
 * 它底下那块区域合成之后的实际像素、以及采到了几个像素。
 */
export interface ContrastSample {
  slideId: string
  elementId: string
  /**
   * `getComputedStyle().color` 换算成 hex。
   *
   * **不从 HTML 里解析。** 文字颜色可能来自内联 style、来自 `defaultColor`、
   * 来自继承 —— 解析 HTML 等于把浏览器的层叠规则再实现一遍，
   * 而那正是 `renderMeasure.ts` 头注释说的「第二实现」。
   */
  textColor: string
  /**
   * 文字矩形下方（**不含文字层**）合成后的第 5 / 95 百分位颜色。
   *
   * 和 `content.image.luminance` 同一个形状，但那个是**图片解码后**的亮度，
   * 这个是**整页合成后**的 —— 差的正是遮罩、装饰和 ornament。
   */
  backdrop: [string, string]
  /** 采到了几个像素 */
  sampled: number
}

/**
 * 采样数低于这个就不判。
 *
 * 太少意味着这块文字的矩形落在画布外、或者截图那一步失败了 ——
 * 拿两三个像素算出来的「对比度」是噪音，而它会以一条正经告警的形式出现。
 * **宁可说「这条没判」，也不要给一个看起来很像结论的数。**
 */
export const MIN_SAMPLED_PIXELS = 64

export interface ContrastIssue {
  slideId: string
  /** 第几页（从 1 起），给用户和 agent 看的 */
  slideIndex: number
  elementId: string
  textColor: string
  /** {p5, p95} 里真正最坏的那一头 */
  worstBg: string
  /** 实测对比度，1~21 */
  ratio: number
  /** 前 40 字，好让 agent 认得出是哪块文字 */
  preview: string
}

export interface ContrastReport {
  /** 实际判了几块文字 */
  measured: number
  /** 采样数不够、判不了的 */
  skipped: number
  issues: ContrastIssue[]
}

/** 把 HTML 剥成纯文本，取前 n 字。和 `renderReflect.ts` 逐字相同 */
const preview = (html: string, n = 40): string => {
  const text = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  return text.length > n ? `${text.slice(0, n)}…` : text
}

/**
 * {p5, p95} 里离文字亮度更近的那个。
 *
 * **和 `scrimFor` 的 `worst` 是同一条判据**，见文件头注释最后一节。
 */
export const worstBackdrop = (textColor: string, backdrop: [string, string]): string => {
  const textLum = luminance(textColor)
  const [lo, hi] = backdrop
  return Math.abs(luminance(lo) - textLum) < Math.abs(luminance(hi) - textLum) ? lo : hi
}

/**
 * 量完之后能说出什么。
 *
 * 没量到的页原样跳过 —— 和 `reflectOnRender` 同一条：
 * 对没量到的什么都不说，比拿推算值冒充实测更诚实。
 */
export const reflectOnContrast = (
  slides: Slide[],
  samples: ContrastSample[],
  target: number = CONTRAST_AA,
): ContrastReport => {
  const bySlide = new Map<string, Map<string, ContrastSample>>()
  for (const s of samples) {
    if (!bySlide.has(s.slideId)) bySlide.set(s.slideId, new Map())
    bySlide.get(s.slideId)!.set(s.elementId, s)
  }

  const issues: ContrastIssue[] = []
  let measured = 0
  let skipped = 0

  slides.forEach((slide, index) => {
    const byElement = bySlide.get(slide.id)
    if (!byElement || byElement.size === 0) return

    for (const el of slide.elements) {
      const sample = byElement.get(el.id)
      if (!sample || el.type !== 'text') continue

      if (sample.sampled < MIN_SAMPLED_PIXELS) { skipped++; continue }

      measured++
      const worstBg = worstBackdrop(sample.textColor, sample.backdrop)
      const ratio = contrastRatio(sample.textColor, worstBg)
      if (ratio >= target) continue

      issues.push({
        slideId: slide.id,
        slideIndex: index + 1,
        elementId: el.id,
        textColor: sample.textColor,
        worstBg,
        ratio: Math.round(ratio * 100) / 100,
        preview: preview((el as Extract<PPTElement, { type: 'text' }>).content),
      })
    }
  })

  // 最不可读的排前面 —— agent 的步数有限，先修最糟的那几条
  issues.sort((a, b) => a.ratio - b.ratio)
  return { measured, skipped, issues }
}

/**
 * 报告 → 给 agent 看的一段话。
 *
 * **改法必须写出来，而且不能是「把文字改成黑色」。**
 * 那会把模型自己设计的配色（R-55）一层层洗成黑白，
 * 而真正的病灶通常在**盖在文字上面的那个东西**，不在文字本身。
 */
export const describeContrast = (report: ContrastReport): string => {
  if (report.measured === 0 && report.skipped === 0) {
    return '没有量到任何文字的背景（可能这几页上没有文本，或者前端没渲染这些页）。'
  }

  const lines: string[] = [`量了 ${report.measured} 块文字底下的实际颜色。`]
  if (report.skipped > 0) {
    lines.push(`（另有 ${report.skipped} 块采样点太少、没判 —— 多半是矩形落在画布外。）`)
  }

  if (report.issues.length === 0) {
    lines.push('对比度全部达标 —— 每块文字压在它实际的背景上都读得出来。')
    return lines.join('\n')
  }

  lines.push('', `**${report.issues.length} 块文字在真实渲染上读不出来**（WCAG AA 要求 4.5:1）：`)
  for (const i of report.issues) {
    lines.push(`- 第 ${i.slideIndex} 页 ${i.elementId}：文字 ${i.textColor} 压在 ${i.worstBg} 上，对比度只有 ${i.ratio}:1`)
    lines.push(`  内容「${i.preview}」`)
  }

  lines.push(
    '',
    '**改法按病灶分三种，别一律去改文字颜色**：',
    '1. **有东西盖在文字上面**（装饰环、光晕、斜块、分界线、装饰层）—— 把它挪开或缩小，',
    '   这是最常见的一种，也是唯一一种改了不损失设计的；',
    '2. **背景图太亮/太暗** —— 换一个把文字放在不透明卡片里的版式（如 `full-figure`），',
    '   它的对比度由卡片保证，和照片有多亮完全无关；',
    '3. **文字颜色本身就不该压在图上** —— 强调色、主色这类颜色是为了跳出来不是为了可读。',
    '',
    '**不要把整份稿子的文字改成黑白** —— 配色是这份稿子被设计过的证据，洗掉它等于把 ⑨ 判据白做了。',
  )
  return lines.join('\n')
}
