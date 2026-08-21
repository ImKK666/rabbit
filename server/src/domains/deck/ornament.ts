/**
 * 生成装饰层（ornament）—— 纯函数那一半
 *
 * 判据见 docs/14 的 O1/O2/O8。这个文件里没有一行碰网络或库，
 * 所以每一条都测得到 —— 「写错了不会有东西报错」的判断必须待在有判据的地方。
 *
 * ## 它凭什么不违反红线
 *
 * 11 号文档 §一的红线是「不往排版层加自由度」。让图像模型画一整页装饰，
 * 默认就是违反这条的 —— 除非**构图决策不交给模型**。
 *
 * 做法是把 `applyLayout` 已经定好的元素坐标翻译成一张**负空间图**：
 * 告诉模型「这几块矩形必须完全留空」，它只填剩下的地方。
 * 这是 Gorden B4 那条去重门禁（`source_icon_inventory − already_in_frame`）
 * 的**反向用法** —— 不是减去已经画过的，是减去**已经被占用的**。
 *
 * 实测这一招是成立的（docs/14 事实 ③）：模型老老实实避开了指定矩形，
 * 把装饰全放到右边距、底栏和四角。**这是「每页满幅 + 允许压在内容之上」
 * 还能守住红线的那个支点。**
 *
 * ## 跨页一致性靠代码，不靠模型记忆
 *
 * 锚点色 hex 由代码从 theme 注入每一页的 prompt，质感档位同理。
 * 「每页现出」的固有代价是风格漂移，而 Gorden 的 `image-prompt-guide.md` §2
 * 那条「提示词必须**自包含**（颜色写死、可复现、单页可重出）」正是治这个的 ——
 * 只是在他们那儿靠人写，在这儿靠代码拼。
 *
 * 这一条同时还掉了 04-changes 待完成表里那笔：
 * 「生图 prompt 模板化 —— 产出风格一致性全靠模型自觉，红线在这里还没落实」。
 */

import type { Slide, PPTElement } from '@/types/slides'
import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT } from './kernel'

/** O1 只需要像素 —— 收窄成最小形状，绿幕产物与原生透明产物都能喂 */
export type RgbaImage = { rgba: Uint8Array, width: number, height: number }

/** 归一化到 0~1 的占用矩形 */
export interface OccupiedRect {
  /** 文字和图片都不许被压，但报告里要分得开 —— 病灶不同，改法也不同 */
  kind: 'text' | 'image'
  x: number
  y: number
  w: number
  h: number
}

/**
 * 一页里哪些地方不许画装饰。
 *
 * **只收 text 和 image。** 形状、线条、图表是版式自己画的结构，
 * 装饰压在它们上面正是「框架层」想要的效果（决策者选了「允许压在内容之上」）。
 * 而文字被压住是排版事故，装饰叠在照片上是 R-48 判过的「像块污渍」。
 */
export const occupiedRectsOf = (slide: Slide): OccupiedRect[] => {
  const out: OccupiedRect[] = []
  for (const el of slide.elements) {
    if (el.type !== 'text' && el.type !== 'image') continue
    const e = el as Extract<PPTElement, { left: number, top: number, width: number, height: number }>
    out.push({
      kind: el.type,
      x: e.left / VIEWPORT_WIDTH,
      y: e.top / VIEWPORT_HEIGHT,
      w: e.width / VIEWPORT_WIDTH,
      h: e.height / VIEWPORT_HEIGHT,
    })
  }
  return out
}

export interface OrnamentPromptInput {
  rects: OccupiedRect[]
  /** 从 theme 来的三个锚点色，代码注入，不让模型每页重编 */
  colors: string[]
  /** 键色，默认纯绿。撞色时换（仅 keyed 路径用） */
  keyHex?: string
  /**
   * R-60: 艺术流派（theme 的 `artDirection`，没写时回落质感档位默认）。
   * 只调「纹样长什么样」，不碰 (A)(B) 两条硬约束 —— 覆盖密度和实心度
   * 是拿真样本标定的，默认路径一个字都不许漂。
   */
  artDirection?: string
  /**
   * R-62: 底图形式。
   * - `keyed`（默认）：纯色键底 + 本地抠图 —— 绿幕阈值是拿真样本标定的，默认路径一个字都不许漂
   * - `native`：模型原生透明背景（openai 形状 `background=transparent`），
   *   不再需要键色，褪色/丢线/撞色三类风险从结构上消失
   */
  alpha?: 'keyed' | 'native'
}

/**
 * 键色的**名字**。
 *
 * ## 这一条是端到端实测抓出来的，值得记
 *
 * 第一版为了支持任意键色，把措辞泛化成 `the exact color ${keyHex}` ——
 * 把「pure green」这个词丢了。**实测立刻回归**：
 * 带色名的 3 次全部照做（底色 92~95% 透明），
 * 换成只给 hex 的 2 次全部翻车（一次画满整页 32.79% 不透明、一次 91.97%）。
 *
 * **模型对色名的遵守远强于对 hex 的遵守。** 所以 hex 要给（精确），
 * 名字也必须给（它才是真正起作用的那个词）。
 */
const KEY_NAMES: Record<string, string> = {
  '#00FF00': 'pure green',
  '#FF00FF': 'pure magenta',
  '#FF7A00': 'pure orange',
  '#FF0033': 'pure red',
  '#00FFFF': 'pure cyan',
}

export const keyColorName = (hex: string): string =>
  KEY_NAMES[hex.toUpperCase()] ?? 'flat solid'

const pct = (v: number) => `${Math.round(v * 100)}%`

/**
 * 拼出这一页的生图提示词。
 *
 * 措辞是**实测收敛出来的**，三版的数据在 docs/14 §七：
 *
 * | 版本 | 覆盖率 | 墨中实心占比 | 判读 |
 * |---|---:|---:|---|
 * | thin line | 7.65% | 6.8% | 克制但颜色全靠反混合重建，会偏色 |
 * | bold blocks | 33.08% | 92% | 好抠但太重，是海报不是装饰 |
 * | **当前这版** | **5.04%** | **80%** | 两个旋钮都到位 |
 *
 * 关键是把**笔画实心度**和**覆盖密度**写成两个**正交**的约束（下面的 A 和 B）。
 * 上一版把它们混在一句话里（"bold flat vector shapes and thick bars"），
 * 结果要到实心的同时把覆盖密度也拉满了。
 */
export const buildOrnamentPrompt = ({ rects, colors, keyHex = '#00FF00', artDirection, alpha = 'keyed' }: OrnamentPromptInput): string => {
  const occupied = rects.length
    ? rects.map(r => `  - x ${pct(r.x)}, y ${pct(r.y)}, w ${pct(r.w)}, h ${pct(r.h)}`).join('\n')
    : '  (none)'

  const keyName = keyColorName(keyHex)

  // R-60：纹样语言跟着稿子的艺术流派走，但必须钉死在 (A)(B) 的约束之内
  const motif = artDirection?.trim()
    ? `\nMOTIF LANGUAGE — arrange the marks in this design language, within the stroke and coverage rules above: ${artDirection.trim()}.`
    : ''

  // R-62：原生透明版本 —— 键色句整个消失，(A)(B) 约束与负空间原样保留
  if (alpha === 'native') {
    return `Generate a decorative ornament layer for a 16:9 presentation slide,
on a FULLY TRANSPARENT background. Output as a PNG image with a real alpha
channel — the background must be completely transparent, not white, not black,
not a solid colour.

TWO SEPARATE REQUIREMENTS — satisfy BOTH:

(A) STROKE QUALITY — every mark must be SOLID and fully saturated:
    stroke width 4 to 8 pixels, hard edges, 100% opaque color.
    No hairlines, no 1px lines, no thin grids, no semi-transparent or faded strokes,
    no soft edges, no glow, no gradient fills.

(B) COVERAGE — the ornament must stay SPARSE and RESTRAINED:
    the marks must cover AT MOST 12% of the canvas. The rest stays fully transparent.
    Use a small number of separate line elements: a few thick rules, a couple of
    right-angle corner brackets, one narrow stack of parallel bars.
    Do NOT fill large areas. Do NOT create solid blocks or filled rectangles
    bigger than a small bar. This is line work, not poster graphics.
${motif}
Palette for the strokes (use only these): ${colors.join(', ')}.

These rectangles are OCCUPIED and must stay COMPLETELY EMPTY:
${occupied}
Place the marks only in the margins, the bottom band, and the corners.

No text, no letters, no numbers, no icons, no logos, no page numbers, no watermark.`
  }

  return `Generate a decorative ornament layer for a 16:9 presentation slide,
drawn on a COMPLETELY FLAT, UNIFORM ${keyName} background, hex ${keyHex}.
The ${keyName} must be perfectly even — no gradient, no texture, no vignette, no shading.

TWO SEPARATE REQUIREMENTS — satisfy BOTH:

(A) STROKE QUALITY — every mark must be SOLID and fully saturated:
    stroke width 4 to 8 pixels, hard edges, 100% opaque color.
    No hairlines, no 1px lines, no thin grids, no semi-transparent or faded strokes,
    no soft edges, no glow, no gradient fills.

(B) COVERAGE — the ornament must stay SPARSE and RESTRAINED:
    the marks must cover AT MOST 12% of the canvas. The rest stays the flat background color.
    Use a small number of separate line elements: a few thick rules, a couple of
    right-angle corner brackets, one narrow stack of parallel bars.
    Do NOT fill large areas. Do NOT create solid blocks or filled rectangles
    bigger than a small bar. This is line work, not poster graphics.
${motif}
Palette for the strokes (use only these): ${colors.join(', ')}.

These rectangles are OCCUPIED and must stay COMPLETELY EMPTY:
${occupied}
Place the marks only in the margins, the bottom band, and the corners.

No text, no letters, no numbers, no icons, no logos, no page numbers, no watermark.
The strokes must never use ${keyName} or anything close to it.`
}

// ---------------------------------------------------------------------------
// O1 · 占用矩形内不许有墨
// ---------------------------------------------------------------------------

/**
 * 占用矩形内的平均 alpha 上限（0~255）。
 *
 * **不是「一个像素都不许落进来」。** 实测的目标形态会在矩形**边界**画描边
 * （卡片轮廓那种），那是想要的效果 —— 决策者选的就是「允许压在内容之上」。
 * 所以判的是**矩形内部的平均浓度**：细描边拉不高均值，一块盖上来的色块会。
 *
 * 12/255 ≈ 4.7%。按目标形态实测，干净的矩形均值在 0~2 之间。
 */
export const MAX_MEAN_ALPHA_IN_RECT = 12

export interface OrnamentIssue {
  kind: 'text' | 'image'
  /** 该矩形内的平均 alpha，0~255 */
  meanAlpha: number
  rect: OccupiedRect
}

/**
 * 抠完的装饰层有没有压到不该压的地方。
 *
 * 纯 `Uint8Array` 统计，**不起浏览器**。这是两层判据里廉价的那一层 ——
 * 它挡掉绝大多数事故，贵的那层（合成后实测对比度，`renderContrast.ts`）兜底。
 */
export const lintOrnament = (
  keyed: RgbaImage,
  rects: OccupiedRect[],
  maxMeanAlpha: number = MAX_MEAN_ALPHA_IN_RECT,
): OrnamentIssue[] => {
  const { rgba, width, height } = keyed
  const issues: OrnamentIssue[] = []

  for (const rect of rects) {
    const x0 = Math.max(0, Math.round(rect.x * width))
    const y0 = Math.max(0, Math.round(rect.y * height))
    const x1 = Math.min(width, Math.round((rect.x + rect.w) * width))
    const y1 = Math.min(height, Math.round((rect.y + rect.h) * height))
    if (x1 <= x0 || y1 <= y0) continue

    let sum = 0
    for (let y = y0; y < y1; y++) {
      const row = y * width
      for (let x = x0; x < x1; x++) sum += rgba[(row + x) * 4 + 3]
    }
    const meanAlpha = sum / ((x1 - x0) * (y1 - y0))
    if (meanAlpha > maxMeanAlpha) {
      issues.push({ kind: rect.kind, meanAlpha: Math.round(meanAlpha * 10) / 10, rect })
    }
  }

  // 压得最狠的排前面
  issues.sort((a, b) => b.meanAlpha - a.meanAlpha)
  return issues
}

/** 给日志/报告的一句话 */
export const describeOrnamentIssues = (issues: OrnamentIssue[]): string => {
  if (issues.length === 0) return '装饰层没有压到文字或图片。'
  return [
    `装饰层压到了 ${issues.length} 块不该压的区域（平均浓度上限 ${MAX_MEAN_ALPHA_IN_RECT}/255）：`,
    ...issues.map(i =>
      `- ${i.kind === 'text' ? '文字' : '图片'}区 (${pct(i.rect.x)}, ${pct(i.rect.y)})`
      + ` ${pct(i.rect.w)}×${pct(i.rect.h)}：平均浓度 ${i.meanAlpha}`),
  ].join('\n')
}
