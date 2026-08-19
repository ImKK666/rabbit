/**
 * R-28 · 设计系统（纯函数，无依赖）
 *
 * 08-expressiveness.md 诊断 ④：全流程没有字号阶梯、间距节奏、颜色角色分配，
 * prompt 里那个「36px 标题 / 20px 卡片标题 / 14px 正文」的示例，
 * 模型会照抄到天荒地老 —— 于是每一份 deck 的排版参数都一模一样。
 *
 * 把这些**从 prompt 里搬进代码**：模型抄不到，因为它根本不再决定这些数值。
 * 版式引擎（layouts.ts）按这里的阶梯排，agent 只提供内容和版式选择。
 *
 * 单位一律是画布逻辑像素（1000 × 562.5）。
 */

import type { SlideTheme } from '@/types/slides'

export const CANVAS_WIDTH = 1000
export const CANVAS_HEIGHT = 562.5

// ---------------------------------------------------------------------------
// 间距栅格
// ---------------------------------------------------------------------------

/**
 * 8px 基准栅格。所有间距都是它的整数倍 ——
 * 「随手填个 17px」正是版面显得业余的主要来源之一。
 */
export const UNIT = 8

export const SPACING = {
  /** 页边距：内容不许越过这条线 */
  margin: UNIT * 9, // 72
  /** 栏间距 */
  gutter: UNIT * 4, // 32
  /** 标题与正文之间 */
  headingGap: UNIT * 3, // 24
  /** 段落之间 */
  paragraphGap: UNIT * 2, // 16
  /** 卡片内边距 */
  cardPadding: UNIT * 3, // 24
} as const

/** 安全区：左右上下都留出页边距之后的可用区域 */
export const SAFE = {
  left: SPACING.margin,
  top: UNIT * 7, // 56
  right: CANVAS_WIDTH - SPACING.margin,
  bottom: CANVAS_HEIGHT - UNIT * 7,
  get width() {
    return this.right - this.left 
  },
  get height() {
    return this.bottom - this.top 
  },
}

// ---------------------------------------------------------------------------
// 字号阶梯
// ---------------------------------------------------------------------------

/**
 * 阶梯而不是连续值：相邻两级差得足够多，层次才立得住。
 * 比例接近 1.33（完全四度），在 16:9 投影上层级清晰又不至于跳跃。
 */
export const TYPE_SCALE = {
  /** 封面主标题 */
  display: 64,
  /** 超大数字 / 单点强调 */
  stat: 88,
  /** 页面标题 */
  title: 38,
  /** 副标题、引言 */
  subtitle: 22,
  /** 卡片 / 条目标题 */
  itemTitle: 19,
  /** 正文 */
  body: 15,
  /** 注释、来源、页码 */
  caption: 12,
  /** 章节号、eyebrow 小标签 */
  eyebrow: 13,
} as const

export const LINE_HEIGHT = {
  tight: 1.15,
  heading: 1.25,
  body: 1.6,
} as const

// ---------------------------------------------------------------------------
// 颜色角色
// ---------------------------------------------------------------------------

/**
 * 颜色不按「好看的六个色」用，按**角色**用。
 * 一页里每个角色只有一个取值，是版面统一的最低成本做法。
 */
export interface Palette {
  /** 页面背景 */
  background: string
  /** 卡片 / 分区底色，与背景拉开一点点 */
  surface: string
  /** 主色：标题强调、关键图形 */
  primary: string
  /** 强调色：需要跳出来的第二个声音，与主色不同色相 */
  accent: string
  /** 正文文字 */
  text: string
  /** 次要文字：说明、来源、被弱化的信息 */
  textMuted: string
  /** 压在主色上的文字 */
  onPrimary: string
  /** 分隔线 / 细边框 */
  border: string
  /** 背景是深色吗 */
  dark: boolean
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)))

export const parseHex = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const h = m[1]
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ]
  }
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

export const toHex = (rgb: [number, number, number]): string =>
  `#${rgb.map(v => clamp255(v).toString(16).padStart(2, '0')).join('')}`

export const mixHex = (a: string, b: string, t: number): string => {
  const ra = parseHex(a), rb = parseHex(b)
  if (!ra || !rb) return a
  return toHex([
    ra[0] + (rb[0] - ra[0]) * t,
    ra[1] + (rb[1] - ra[1]) * t,
    ra[2] + (rb[2] - ra[2]) * t,
  ])
}

/** WCAG 相对亮度 */
export const luminance = (hex: string): number => {
  const rgb = parseHex(hex)
  if (!rgb) return 1
  const [r, g, b] = rgb.map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 对比度，1 ~ 21 */
export const contrastRatio = (a: string, b: string): number => {
  const la = luminance(a), lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** 压在 bg 上时该用黑字还是白字 */
export const readableOn = (bg: string): string =>
  contrastRatio(bg, '#ffffff') >= contrastRatio(bg, '#111111') ? '#ffffff' : '#111111'

/**
 * 从 SlideTheme 推出一套完整的颜色角色。
 *
 * 主题只给了 backgroundColor / fontColor / themeColors[]，
 * 剩下的（surface / border / textMuted / accent）都是推出来的 ——
 * 让 agent 逐个挑颜色，挑出来的必然是随机的六个色。
 */
export const buildPalette = (theme: SlideTheme, override?: Partial<Palette>): Palette => {
  const background = parseHex(theme.backgroundColor) ? theme.backgroundColor : '#ffffff'
  const dark = luminance(background) < 0.4

  const themeColors = (theme.themeColors ?? []).filter(c => !!parseHex(c))
  const primary = themeColors[0] ?? (dark ? '#4f7df3' : '#2f6feb')
  // 强调色取主题里离主色最远的那个，退化时用主色偏移
  const accent = themeColors.slice(1).sort(
    (a, b) => hueDistance(primary, b) - hueDistance(primary, a),
  )[0] ?? mixHex(primary, dark ? '#ffd166' : '#f2596b', 0.7)

  const text = parseHex(theme.fontColor) && contrastRatio(theme.fontColor, background) >= 3
    ? theme.fontColor
    : readableOn(background)

  return {
    background,
    surface: mixHex(background, dark ? '#ffffff' : '#000000', dark ? 0.08 : 0.04),
    primary,
    accent,
    text,
    textMuted: mixHex(text, background, 0.42),
    onPrimary: readableOn(primary),
    border: mixHex(background, text, 0.18),
    dark,
    ...override,
  }
}

/** 粗略色相距离，只用来在主题色里挑一个「和主色不像」的 */
const hueDistance = (a: string, b: string): number => {
  const ra = parseHex(a), rb = parseHex(b)
  if (!ra || !rb) return 0
  const ha = hue(ra), hb = hue(rb)
  const d = Math.abs(ha - hb) % 360
  return d > 180 ? 360 - d : d
}

const hue = ([r, g, b]: [number, number, number]): number => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  if (max === min) return 0
  const d = max - min
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return (h * 60 + 360) % 360
}

// ---------------------------------------------------------------------------
// HTML 文本
// ---------------------------------------------------------------------------

export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export interface TextStyle {
  size: number
  color: string
  bold?: boolean
  align?: 'left' | 'center' | 'right'
  lineHeight?: number
  letterSpacing?: number
}

/**
 * 生成 PPTist 的文本 HTML。
 *
 * 换行拆成多个 `<p>` —— PPTist 的富文本解析和导出都按块级元素断行，
 * 塞 `\n` 进一个 span 里在画布上不换行，导出后更是挤成一坨。
 */
export const richText = (text: string, style: TextStyle): string => {
  const css = [
    `font-size:${style.size}px`,
    `color:${style.color}`,
    style.bold ? 'font-weight:700' : '',
    style.letterSpacing ? `letter-spacing:${style.letterSpacing}px` : '',
  ].filter(Boolean).join(';')

  const pStyle = style.align && style.align !== 'left' ? ` style="text-align:${style.align}"` : ''

  return String(text)
    .split('\n')
    .map(line => `<p${pStyle}><span style="${css}">${escapeHtml(line)}</span></p>`)
    .join('')
}

/**
 * 文本高度估算 —— 版式引擎排完之后自己得知道有没有溢出。
 *
 * 按 CJK 全宽字符算，英文会偏保守（估高了），保守的方向是安全的：
 * 宁可留白多一点，也不要压到下一个元素。
 */
export const estimateTextHeight = (
  text: string,
  fontSize: number,
  boxWidth: number,
  lineHeight: number = LINE_HEIGHT.body,
): number => {
  const charsPerLine = Math.max(1, Math.floor(boxWidth / fontSize))
  const lines = String(text).split('\n').reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(visualLength(line) / charsPerLine)),
    0,
  )
  return Math.ceil(lines * fontSize * lineHeight)
}

/**
 * 在候选字号里挑最大的一个，使文本能塞进给定的框。
 *
 * 版式引擎不能假设内容长度 —— 同一个「引用语」版式，一句十个字的话和
 * 一段两百字的引述都得排得下。固定字号的做法只有两种结局：
 * 短文本浪费版面，长文本溢出画布。
 */
export const fitFontSize = (
  text: string,
  boxWidth: number,
  maxHeight: number,
  candidates: number[],
  lineHeight: number = LINE_HEIGHT.heading,
): number => {
  const sorted = [...candidates].sort((a, b) => b - a)
  for (const size of sorted) {
    if (estimateTextHeight(text, size, boxWidth, lineHeight) <= maxHeight) return size
  }
  return sorted[sorted.length - 1]
}

/** CJK 与全角标点。写成码点区间而不是把全角字符直接放进正则，省得肉眼分不清空格宽度 */
const CJK_RANGE = /[\u3000-\u9fff\uff00-\uffef]/

/** 半角算 0.5 个字宽，全角算 1 个 */
const visualLength = (text: string): number => {
  let n = 0
  for (const ch of text) n += CJK_RANGE.test(ch) ? 1 : 0.5
  return n
}
