/**
 * Deck Kernel — 纯函数库
 *
 * 不依赖 Vue / HTTP / DB / LLM。
 * agent 永远不直接写 deck JSON，只能调工具，工具全部经 kernel 校验。
 */

import { z } from 'zod'
import type {
  Slide, PPTElement, PPTAnimation, SlideTheme, AnimationEffect, TurningMode,
} from '@/types/slides'
import { ANIMATION_DEFS, TURNING_MODES } from '@/configs/animation'
import { buildShapeGeometry, getCatalogShape, SHAPE_CATALOG_KEYS } from '@/configs/shapeCatalog'
import { lintSlideAnimationOrder } from './animationOrder'
import {
  buildPalette, parseHex, CANVAS_WIDTH as DESIGN_W, CANVAS_HEIGHT as DESIGN_H, DEFAULT_BODY_FONT,
  TYPOGRAPHY_PAIRS, PALETTE_FORMALITY, FORMALITY_GAP_LIMIT,
  type PaletteStyle, type TypographyPair, type FontFamily,
} from './design'
import {
  buildLayout, validateLayoutContent, isLayoutPattern, LAYOUT_META, LAYOUT_PATTERNS,
  type LayoutPattern, type LayoutContent, type LayoutPace,
} from './layouts'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 画布尺寸的单一真相源在 design.ts —— 版式引擎和 lint 必须用同一组数 */
export const VIEWPORT_WIDTH = DESIGN_W
export const VIEWPORT_HEIGHT = DESIGN_H

/** 元素超出画布多少逻辑像素才算越界（留一点浮点容差） */
const OVERFLOW_TOLERANCE = 1

/** 面积占画布这个比例以上的元素视为背景板 —— 它跟谁都重叠，报了全是噪音 */
const BACKDROP_AREA_RATIO = 0.6

/** 交集面积占较小元素的比例超过这个值，才算「压住了」 */
const OVERLAP_RATIO_THRESHOLD = 0.6

/**
 * 内置默认主题 —— lint ⑨ 判断「颜色真的被改过」时的参照物。
 *
 * ## 为什么需要一个常量参照物（R-60）
 *
 * 判据 ⑨ 原本只查 `designNote` 非空。实测数据库里躺着一份反例
 * （「星耀影视」）：designNote 写了一长串点茶取色的理由，而主题仍是
 * 出厂默认的白底 + `#5b9bd5` 蓝 + `#ed7d31` 橙 —— **写了说明，没做决定**。
 * 之前「不拿默认主题当参照物」的理由是「默认主题一改判据就悄悄失准」；
 * 把默认值收成**一个代码常量**、两处共用（这里和 `pipeline.ts`），
 * 失准问题就不存在了 —— 它不再是散落两处的魔法值。
 */
export const DEFAULT_THEME: SlideTheme = {
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
  fontColor: '#333',
  fontName: '',
  backgroundColor: '#fff',
  shadow: { h: 3, v: 3, blur: 2, color: '#808080' },
  outline: { width: 2, color: '#525252', style: 'solid' },
}

/**
 * 规范化 hex 比较（`#fff` ≡ `#FFFFFF` ≡ `#FFF`）。
 *
 * 第一版手写「去 # + 小写」比较，`#fff` 与 `#FFFFFF` 被当场判成不同 ——
 * 是「同色异写不构成改过」那条测试抓出来的。改走 `parseHex`，
 * 三位的短写法先展开成三位 RGB 再比，语义交给已经在用的解析器。
 */
const sameHex = (a?: string, b?: string): boolean => {
  if (!a || !b) return false
  const ra = parseHex(a), rb = parseHex(b)
  return !!ra && !!rb && ra[0] === rb[0] && ra[1] === rb[1] && ra[2] === rb[2]
}

/**
 * 主题的三个锚点（底色 / 主色 / 强调色）是不是仍与内置默认完全一致。
 *
 * 只比前两个 themeColors：默认主题的第三项起是图表用的灰/黄/蓝/绿，
 * 那部分与「这份稿子的配色设计」无关。
 */
const themeAnchorsChanged = (theme?: SlideTheme): boolean => {
  if (!theme) return false
  const changed = !sameHex(theme.backgroundColor, DEFAULT_THEME.backgroundColor)
    || !sameHex(theme.themeColors?.[0], DEFAULT_THEME.themeColors[0])
    || !sameHex(theme.themeColors?.[1], DEFAULT_THEME.themeColors[1])
    || !sameHex(theme.fontColor, DEFAULT_THEME.fontColor)
  return changed
}

// ---------------------------------------------------------------------------
// Zod Schemas（agent 产出的 JSON 运行时校验）
// ---------------------------------------------------------------------------

const elementShadowSchema = z.object({
  h: z.number(), v: z.number(), blur: z.number(), color: z.string(),
})

const elementOutlineSchema = z.object({
  style: z.enum(['solid', 'dashed', 'dotted']).optional(),
  width: z.number().optional(),
  color: z.string().optional(),
})

const elementLinkSchema = z.object({
  type: z.enum(['web', 'slide']),
  target: z.string(),
})

const textTypeSchema = z.enum([
  'title', 'subtitle', 'content', 'item', 'itemTitle',
  'notes', 'header', 'footer', 'partNumber', 'itemNumber',
])

const imageTypeSchema = z.enum(['pageFigure', 'itemFigure', 'background'])

const gradientSchema = z.object({
  type: z.enum(['linear', 'radial']),
  colors: z.array(z.object({ pos: z.number(), color: z.string() })),
  rotate: z.number(),
})

const baseElementSchema = z.object({
  id: z.string().min(1),
  left: z.number(),
  top: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  rotate: z.number(),
  lock: z.boolean().optional(),
  groupId: z.string().optional(),
  link: elementLinkSchema.optional(),
  name: z.string().optional(),
})

export const textElementSchema = baseElementSchema.extend({
  type: z.literal('text'),
  content: z.string(),
  defaultFontName: z.string(),
  defaultColor: z.string(),
  outline: elementOutlineSchema.optional(),
  fill: z.string().optional(),
  lineHeight: z.number().optional(),
  wordSpace: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
  shadow: elementShadowSchema.optional(),
  paragraphSpace: z.number().optional(),
  vertical: z.boolean().optional(),
  textType: textTypeSchema.optional(),
  inset: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  fixedHeight: z.boolean().optional(),
  vAlign: z.enum(['top', 'middle', 'bottom']).optional(),
})

export const imageElementSchema = baseElementSchema.extend({
  type: z.literal('image'),
  fixedRatio: z.boolean(),
  src: z.string(),
  outline: elementOutlineSchema.optional(),
  filters: z.record(z.string()).optional(),
  clip: z.object({
    range: z.tuple([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()])]),
    shape: z.string(),
  }).optional(),
  flipH: z.boolean().optional(),
  flipV: z.boolean().optional(),
  shadow: elementShadowSchema.optional(),
  radius: z.number().optional(),
  colorMask: z.string().optional(),
  imageType: imageTypeSchema.optional(),
})

export const shapeElementSchema = baseElementSchema.extend({
  type: z.literal('shape'),
  viewBox: z.tuple([z.number(), z.number()]),
  path: z.string(),
  fixedRatio: z.boolean(),
  fill: z.string(),
  gradient: gradientSchema.optional(),
  pattern: z.string().optional(),
  outline: elementOutlineSchema.optional(),
  opacity: z.number().min(0).max(1).optional(),
  flipH: z.boolean().optional(),
  flipV: z.boolean().optional(),
  shadow: elementShadowSchema.optional(),
  special: z.boolean().optional(),
  text: z.object({
    content: z.string(),
    defaultFontName: z.string(),
    defaultColor: z.string(),
    align: z.enum(['top', 'middle', 'bottom']),
    lineHeight: z.number().optional(),
    wordSpace: z.number().optional(),
    paragraphSpace: z.number().optional(),
    inset: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    type: textTypeSchema.optional(),
  }).optional(),
})

const lineElementSchema = baseElementSchema.omit({ height: true, rotate: true }).extend({
  type: z.literal('line'),
  start: z.tuple([z.number(), z.number()]),
  end: z.tuple([z.number(), z.number()]),
  style: z.enum(['solid', 'dashed', 'dotted']),
  color: z.string(),
  points: z.tuple([z.enum(['', 'arrow', 'dot']), z.enum(['', 'arrow', 'dot'])]),
  shadow: elementShadowSchema.optional(),
})

export const elementSchema = z.discriminatedUnion('type', [
  textElementSchema,
  imageElementSchema,
  shapeElementSchema,
  lineElementSchema,
])

// --- 图表 ---

export const CHART_TYPES = ['bar', 'column', 'line', 'pie', 'ring', 'area', 'radar', 'scatter'] as const

export const chartElementSchema = baseElementSchema.extend({
  type: z.literal('chart'),
  chartType: z.enum(CHART_TYPES),
  data: z.object({
    labels: z.array(z.string()).min(1),
    legends: z.array(z.string()).min(1),
    series: z.array(z.array(z.number().finite())).min(1),
  }),
  options: z.object({
    lineSmooth: z.boolean().optional(),
    stack: z.boolean().optional(),
  }).optional(),
  themeColors: z.array(z.string()).min(1),
  textColor: z.string().optional(),
  lineColor: z.string().optional(),
  fill: z.string().optional(),
  outline: elementOutlineSchema.optional(),
})
  // 系列数和图例数对不上、某个系列的点数和标签数对不上 —— 画布上只是少画一根线，
  // 导出到 PPTX 则会写出一份数据错位的内嵌表格，比不画更糟
  .refine(el => el.data.series.length === el.data.legends.length, {
    message: 'data.series 的条数必须等于 data.legends 的条数',
    path: ['data', 'series'],
  })
  .refine(el => el.data.series.every(s => s.length === el.data.labels.length), {
    message: '每条 series 的数据点数必须等于 data.labels 的个数',
    path: ['data', 'series'],
  })

// --- 表格 ---

const tableCellSchema = z.object({
  id: z.string().min(1),
  colspan: z.number().int().min(1),
  rowspan: z.number().int().min(1),
  text: z.string(),
  style: z.object({
    bold: z.boolean().optional(),
    em: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    color: z.string().optional(),
    backcolor: z.string().optional(),
    fontsize: z.string().optional(),
    fontname: z.string().optional(),
    align: z.enum(['left', 'center', 'right', 'justify']).optional(),
    vAlign: z.enum(['top', 'middle', 'bottom']).optional(),
  }).optional(),
}).passthrough()

export const tableElementSchema = baseElementSchema.extend({
  type: z.literal('table'),
  outline: elementOutlineSchema,
  theme: z.object({
    color: z.string(),
    rowHeader: z.boolean(),
    rowFooter: z.boolean(),
    colHeader: z.boolean(),
    colFooter: z.boolean(),
  }).optional(),
  colWidths: z.array(z.number().positive()).min(1),
  cellMinHeight: z.number().positive(),
  data: z.array(z.array(tableCellSchema).min(1)).min(1),
})
  .refine(el => el.data.every(row => row.length === el.data[0].length), {
    message: '每一行的单元格数必须相同（合并单元格用 colspan/rowspan 表达，不要少写格子）',
    path: ['data'],
  })
  .refine(el => el.colWidths.length === el.data[0].length, {
    message: 'colWidths 的长度必须等于列数',
    path: ['colWidths'],
  })
  .refine(el => Math.abs(el.colWidths.reduce((a, b) => a + b, 0) - 1) < 0.02, {
    message: 'colWidths 是各列占总宽的比例，加起来必须约等于 1',
    path: ['colWidths'],
  })

/**
 * 严格校验的元素类型。
 *
 * R-30 把 chart / table 从「只查基础几何」的放行名单挪到了这里 ——
 * 它们现在是 agent 会主动产出的类型，再放行就等于给自己开后门
 * （08-expressiveness.md 第五节点名的那条风险）。
 */
const STRICT_ELEMENT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  text: textElementSchema,
  image: imageElementSchema,
  shape: shapeElementSchema,
  line: lineElementSchema,
  chart: chartElementSchema,
  table: tableElementSchema,
}

/**
 * agent 不产出、但导入的 deck 里可能存在的类型。
 * 只校验基础几何字段其余放行 —— 否则一份带公式的 deck 会在 updateSlide 时被整体拒收。
 */
const PASSTHROUGH_ELEMENT_TYPES = new Set(['latex', 'video', 'audio'])

const formatZodError = (err: z.ZodError): string =>
  err.issues.map(i => `${i.path.join('.') || '(根)'}: ${i.message}`).join('; ')

/**
 * 单个元素的运行时校验。
 *
 * 这是「agent 永远不直接写 deck JSON」那条硬规则的实际闸门 ——
 * 在此之前 elementSchema 只是定义了没人调，addElement 收到什么就 push 什么。
 */
export const validateElement = (el: unknown): { ok: true } | { ok: false, error: string } => {
  const type = (el as { type?: unknown } | null)?.type
  if (typeof type !== 'string') return { ok: false, error: '元素缺少 type 字段' }

  const strict = STRICT_ELEMENT_SCHEMAS[type]
  if (strict) {
    const r = strict.safeParse(el)
    return r.success ? { ok: true } : { ok: false, error: `${type} 元素校验失败 —— ${formatZodError(r.error)}` }
  }

  if (PASSTHROUGH_ELEMENT_TYPES.has(type)) {
    const r = baseElementSchema.safeParse(el)
    return r.success ? { ok: true } : { ok: false, error: `${type} 元素基础字段校验失败 —— ${formatZodError(r.error)}` }
  }

  return { ok: false, error: `不支持的元素类型 "${type}"（agent 可用：text / image / shape / line / chart / table）` }
}

/** 批量校验，返回第一条错误信息（带下标和 id，方便 agent 定位）；全部合法返回 null */
const validateElements = (elements: unknown[]): string | null => {
  for (let i = 0; i < elements.length; i++) {
    const r = validateElement(elements[i])
    if (r.ok) continue
    const id = (elements[i] as { id?: string } | null)?.id
    return `elements[${i}]${id ? ` (id=${id})` : ''} ${r.error}`
  }
  return null
}

/** 收集整份 deck 已用的元素 id —— addElement / addSlide 查重用 */
const collectElementIds = (slides: Slide[]): Set<string> =>
  new Set(slides.flatMap(s => s.elements.map(e => e.id)))

/**
 * 25 个动画效果 —— 单一真相源是 `configs/animation.ts`，这里不再抄一份。
 * （之前 types/slides.ts、kernel.ts、tools.ts 各维护一份，改一个词表要动三处。）
 */
export const ANIMATION_EFFECTS = Object.keys(ANIMATION_DEFS) as [AnimationEffect, ...AnimationEffect[]]

const animationEffectSchema = z.enum(ANIMATION_EFFECTS)

export const animationSchema = z.object({
  id: z.string().min(1),
  elId: z.string().min(1),
  effect: animationEffectSchema,
  type: z.enum(['in', 'out', 'attention']),
  duration: z.number().int().min(100).max(10000),
  trigger: z.enum(['click', 'meantime', 'auto']),
  exportBehavior: z.enum(['native', 'web-only', 'flatten']).optional(),
}).refine(
  a => ANIMATION_DEFS[a.effect].type === a.type,
  a => ({
    // effect 和 type 对不上会让 PPTX 导出把入场动画写进退场时间线
    message: `动画效果 "${a.effect}" 属于 ${ANIMATION_DEFS[a.effect].type}，不能标成 type="${a.type}"`,
    path: ['type'],
  }),
)

const backgroundSchema = z.object({
  type: z.enum(['solid', 'image', 'gradient']),
  color: z.string().optional(),
  image: z.object({
    src: z.string(),
    size: z.enum(['cover', 'contain', 'repeat']),
  }).optional(),
  gradient: gradientSchema.optional(),
})

export const slideSchema = z.object({
  id: z.string().min(1),
  // 元素不在这里校验 —— 走 validateElements() 才能给出带下标和 id 的可读错误
  elements: z.array(z.unknown()),
  remark: z.string().optional(),
  background: backgroundSchema.optional(),
  animations: z.array(animationSchema).optional(),
  turningMode: z.enum(TURNING_MODES as [TurningMode, ...TurningMode[]]).optional(),
  type: z.enum(['cover', 'contents', 'transition', 'content', 'end']).optional(),
  layout: z.string().optional(),
  layoutVariant: z.string().optional(),
  paletteStyle: z.string().optional(),
  typography: z.string().optional(),
  paletteAnchors: z.array(z.string()).optional(),
})

export const themeSchema = z.object({
  backgroundColor: z.string(),
  themeColors: z.array(z.string()),
  fontColor: z.string(),
  fontName: z.string(),
  outline: elementOutlineSchema,
  shadow: elementShadowSchema,
  designNote: z.string().optional(),
  artDirection: z.string().optional(),
})

// ---------------------------------------------------------------------------
// 几何 Lint
// ---------------------------------------------------------------------------

export interface LintIssue {
  level: 'error' | 'warning'
  elementId?: string
  slideId: string
  message: string
}

type Rect = { left: number, top: number, width: number, height: number }

const rectsOverlap = (a: Rect, b: Rect): boolean => {
  return a.left < b.left + b.width
    && a.left + a.width > b.left
    && a.top < b.top + b.height
    && a.top + a.height > b.top
}

const intersectionArea = (a: Rect, b: Rect): number => {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? w * h : 0
}

export const lintSlide = (slide: Slide): LintIssue[] => {
  const issues: LintIssue[] = []

  for (const el of slide.elements) {
    if (el.type === 'line') continue

    const fullyOutside = el.left + el.width < 0 || el.left > VIEWPORT_WIDTH
      || el.top + el.height < 0 || el.top > VIEWPORT_HEIGHT

    if (fullyOutside) {
      issues.push({
        level: 'warning',
        elementId: el.id,
        slideId: slide.id,
        message: `元素 "${el.name || el.id}" 完全在画布外`,
      })
    }
    else {
      // 部分出界 —— agent 最常犯的是「右边/底边超出一点」，
      // 而原来只报「完全在画布外」，这类错误全部漏掉了
      const over: string[] = []
      if (el.left < -OVERFLOW_TOLERANCE) over.push(`左 ${Math.round(-el.left)}px`)
      if (el.top < -OVERFLOW_TOLERANCE) over.push(`上 ${Math.round(-el.top)}px`)
      if (el.left + el.width > VIEWPORT_WIDTH + OVERFLOW_TOLERANCE) {
        over.push(`右 ${Math.round(el.left + el.width - VIEWPORT_WIDTH)}px`)
      }
      if (el.top + el.height > VIEWPORT_HEIGHT + OVERFLOW_TOLERANCE) {
        over.push(`下 ${Math.round(el.top + el.height - VIEWPORT_HEIGHT)}px`)
      }
      if (over.length) {
        issues.push({
          level: 'warning',
          elementId: el.id,
          slideId: slide.id,
          message: `元素 "${el.name || el.id}" 超出画布：${over.join('、')}`,
        })
      }
    }

    // 空文本检测
    if (el.type === 'text' && !el.content.replace(/<[^>]*>/g, '').trim()) {
      issues.push({
        level: 'warning',
        elementId: el.id,
        slideId: slide.id,
        message: `文本元素 "${el.name || el.id}" 内容为空`,
      })
    }

    // 零尺寸检测
    if (el.width <= 0 || el.height <= 0) {
      issues.push({
        level: 'error',
        elementId: el.id,
        slideId: slide.id,
        message: `元素 "${el.name || el.id}" 尺寸为零或负值`,
      })
    }
  }

  // 文本重叠检测（03-architecture 把「矩形求交」列为选 JSON 路线的头号收益，
  // 但 rectsOverlap 此前是死代码，从未被调用过）
  //
  // 只查 text ↔ text：文字压文字几乎一定是排版事故，
  // 而文字压图片 / 压形状是正常设计（标题盖在主视觉上），报了全是噪音。
  const canvasArea = VIEWPORT_WIDTH * VIEWPORT_HEIGHT
  const texts = slide.elements.filter(
    el => el.type === 'text' && el.width * el.height < canvasArea * BACKDROP_AREA_RATIO,
  )
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i] as PPTElement & Rect
      const b = texts[j] as PPTElement & Rect
      if (!rectsOverlap(a, b)) continue

      const ratio = intersectionArea(a, b) / Math.min(a.width * a.height, b.width * b.height)
      if (ratio < OVERLAP_RATIO_THRESHOLD) continue

      issues.push({
        level: 'warning',
        elementId: a.id,
        slideId: slide.id,
        message: `文本元素 "${a.name || a.id}" 与 "${b.name || b.id}" 重叠 ${Math.round(ratio * 100)}%`,
      })
    }
  }

  // 孤儿动画检测
  if (slide.animations?.length) {
    const elIds = new Set(slide.elements.map(el => el.id))
    for (const anim of slide.animations) {
      if (!elIds.has(anim.elId)) {
        issues.push({
          level: 'error',
          elementId: anim.elId,
          slideId: slide.id,
          message: `动画 "${anim.id}" 引用了不存在的元素 "${anim.elId}"`,
        })
      }
    }
  }

  return issues
}

// ---------------------------------------------------------------------------
// Deck 级 lint —— 「有没有新意」的机器判据
//
// 08-expressiveness.md 第四节列了五条验收标准，前三条落在这里。
// 主观的东西没法自动判，但「相邻两页一模一样」「整份 deck 只有文字」
// 「45 个效果里只用了一个」这三件事是客观的，而且正是雷同感的直接来源。
//
// 全部是 warning 而不是 error：它们是设计建议，不是结构错误。
// 拿来当硬闸门会把「刻意的极简」也拦掉。
// ---------------------------------------------------------------------------

/** 一页的结构指纹 —— 没有 layout 标记时用它判「是不是同一个版式」 */
const structuralSignature = (slide: Slide): string => {
  const counts: Record<string, number> = {}
  for (const el of slide.elements) counts[el.type] = (counts[el.type] ?? 0) + 1

  // 元素类型构成 + 前三个元素的粗粒度位置（按 1/8 画布取格）
  const shape = Object.keys(counts).sort().map(k => `${k}${counts[k]}`).join('')
  const grid = slide.elements
    .filter((el): el is PPTElement & { left: number, top: number } => 'left' in el && 'top' in el)
    .slice()
    .sort((a, b) => (a.top - b.top) || (a.left - b.left))
    .slice(0, 3)
    .map(el => `${Math.round(el.left / (VIEWPORT_WIDTH / 8))},${Math.round(el.top / (VIEWPORT_HEIGHT / 8))}`)
    .join('|')

  return `${shape}@${grid}`
}

/** 非文本元素：形状 / 图表 / 表格 / 线条 / 图片 */
const NON_TEXT_TYPES = new Set(['shape', 'chart', 'table', 'line', 'image', 'latex'])

const hasNonTextElement = (slide: Slide): boolean =>
  slide.elements.some(el => NON_TEXT_TYPES.has(el.type))

/**
 * 一页在整份稿子的节奏里扮演什么角色。
 *
 * 手工搭的页（没有 `layout` 标记）返回 `undefined` —— lint 不知道它长什么样，
 * 既不该把它算成内容页，也不该让它冒充节奏页去打断一串 cards。
 */
const paceOf = (slide: Slide): LayoutPace | undefined =>
  slide.layout && isLayoutPattern(slide.layout) ? LAYOUT_META[slide.layout].pace : undefined

/** 单页元素太少，基本等同于「一个标题一段正文」 */
const MIN_ELEMENTS_PER_SLIDE = 3

/** 一份 deck 至少该用到几种不同的动画效果 */
const MIN_EFFECT_VARIETY = 3

/**
 * 版式分布判据的起查页数。
 *
 * 四页以下谈「分布」没有意义 —— 封面 + 两页内容 + 结尾，本来就没有多少可分布的。
 */
const SPREAD_MIN_SLIDES = 5

/**
 * 单个版式占全篇的比例上限。
 *
 * 取 0.4 而不是更严：十页的稿子里四页 cards 仍在合理区间（cards 本来就是
 * `LAYOUT_META` 里标着「最通用」的那个），五页才开始像是「一个模板填了五遍」。
 */
const SPREAD_TOP_RATIO = 0.4

/**
 * 触发分布告警的最少页数。
 *
 * 光有比例不够：五页的稿子里 `0.4 × 5 = 2`，于是两页 cards 就会报 ——
 * 而相邻页判据已经保证了这两页不挨着，两页同版式在五页里完全正常。
 * 加这条下限之后，**至少三页同版式**才可能触发。
 */
const SPREAD_MIN_COUNT = 2

/**
 * 连续多少页内容页没有节奏页就告警。
 *
 * prompt（`roles.ts`）写的是「每 3~4 页内容页插一页节奏页」。判据取 5 而不是 4：
 * **护栏要比指导宽一档** —— 指导说的是「怎么做才好」，判据说的是「这样已经不行了」，
 * 两者取同一个数会让「按指导做到边界」的稿子也变红。
 */
const MAX_CONTENT_RUN = 5

/**
 * 「这份稿子被设计过吗」这条判据的起查页数。
 *
 * 取 3 是为了把**生成一份稿子**和**改一页**分开：用户说「这页重排一下」时
 * agent 只会调一次 `applyLayout`，那一次它没有义务重新设计整份的配色 ——
 * 在那里报「你没有设计」是纯噪音。
 */
const DESIGN_INTENT_MIN_SLIDES = 3

export interface DeckLintOptions {
  /** 关掉设计类检查，只留几何 —— 用户明确要极简风格时 */
  designChecks?: boolean
  /** 判据 ⑨ 要看 `theme.designNote`。生产路径必须传，见 `lintDeckDesign` 的说明 */
  theme?: SlideTheme
}

/**
 * `theme` 是可选的：判据 ⑨（这份稿子被设计过吗）要看 `theme.designNote`，
 * 而 deck 级的主题不在 `slides` 里。不传就退回只看 `paletteAnchors` ——
 * **少了一个信号会让 ⑨ 偏严**（走 setTheme 的稿子会被误报），
 * 所以生产路径（`lintDeck` 工具）必须传，不传只出现在只关心几何的单测里。
 */
export const lintDeckDesign = (slides: Slide[], theme?: SlideTheme): LintIssue[] => {
  const issues: LintIssue[] = []
  if (slides.length === 0) return issues

  // ① 版式多样性：相邻页不得用同一版式（同一变体）
  //
  // R-60：键从「版式名」扩成「版式名 + 变体」—— cards A / cards B 是两种
  // 明显不同的结构，并排放并不雷同；真正雷同的是「同版式且同变体」。
  for (let i = 1; i < slides.length; i++) {
    const prev = slides[i - 1]
    const cur = slides[i]

    const keyOf = (s: Slide): string => s.layout
      ? `${s.layout}|${s.layoutVariant ?? 'A'}`
      : structuralSignature(s)
    const prevKey = keyOf(prev)
    const curKey = keyOf(cur)
    // 空页之间的雷同没有意义
    if (!prev.elements.length || !cur.elements.length) continue

    if (prevKey === curKey) {
      issues.push({
        level: 'warning',
        slideId: cur.id,
        message: cur.layout
          ? `第 ${i + 1} 页与上一页用了同一个版式 "${cur.layout}"（同变体），换一个（applyLayout 有 ${LAYOUT_PATTERNS.length} 种，cards / bullets / title-center 还有 B 变体）`
          : `第 ${i + 1} 页与上一页结构完全相同，读者会觉得在原地踏步 —— 换个版式或换个信息组织方式`,
      })
    }
  }

  // ② 每页至少一个非文本元素
  for (const [i, slide] of slides.entries()) {
    if (!slide.elements.length) continue
    if (!hasNonTextElement(slide)) {
      issues.push({
        level: 'warning',
        slideId: slide.id,
        message: `第 ${i + 1} 页只有文字，没有任何形状 / 图表 / 线条 —— 纯文字排得再好也像 Word 大纲，至少加一条强调条或一个卡片底板`,
      })
    }
    if (slide.elements.length < MIN_ELEMENTS_PER_SLIDE) {
      issues.push({
        level: 'warning',
        slideId: slide.id,
        message: `第 ${i + 1} 页只有 ${slide.elements.length} 个元素，信息密度太低`,
      })
    }
  }

  // ③ 动画多样性
  const effects = slides.flatMap(s => (s.animations ?? []).map(a => a.effect))
  if (effects.length) {
    const kinds = new Set(effects)
    if (kinds.size < MIN_EFFECT_VARIETY && slides.length > 2) {
      issues.push({
        level: 'warning',
        slideId: slides[0].id,
        message: `整份文稿只用了 ${kinds.size} 种动画效果（${[...kinds].join(', ')}），至少用 ${MIN_EFFECT_VARIETY} 种 —— 词表里有 ${Object.keys(ANIMATION_DEFS).length} 个`,
      })
    }

    const fadeFamily = [...kinds].every(e => e.startsWith('fade') || e === 'exit-fade')
    if (fadeFamily && kinds.size > 0) {
      issues.push({
        level: 'warning',
        slideId: slides[0].id,
        message: '所有动画都是淡入系，观感必然雷同 —— 擦除（wipe）、几何（circle-in / box-in / wedge-in）、分块（blinds-h / checkerboard）都是 PowerPoint 原生效果，导出后照样能播',
      })
    }
  }

  // ④ 配色风格与字体配对：整份文稿各只该有一套
  //
  // prompt 里写着「整份文稿只选一个，每页都传同一个」。在 `paletteStyle` /
  // `typography` 落盘之前，**这句话没有任何东西在验** —— agent 每页换一个，
  // 产出的就是一份东拼西凑的稿子，而所有检查都是绿的。
  //
  // 只看真正套过版式的页（`layout` 非空）：手工搭的页没有这两个字段，
  // 把它们算进来会让「一份手工页 + 一份版式页」永远报警。
  for (const [field, label, hint] of [
    ['paletteStyle', '配色风格', 'applyLayout 的 style 参数'],
    ['typography', '字体配对', 'applyLayout 的 typography 参数'],
  ] as const) {
    const used = new Map<string, number[]>()
    slides.forEach((s, i) => {
      if (!s.layout) return
      const v = s[field]
      if (!v) return
      used.set(v, [...(used.get(v) ?? []), i + 1])
    })
    if (used.size > 1) {
      const detail = [...used].map(([v, pages]) => `${v}（第 ${pages.join('/')} 页）`).join('，')
      issues.push({
        level: 'warning',
        slideId: slides[0].id,
        message: `整份文稿用了 ${used.size} 种${label}：${detail} —— 换来换去等于没有${label}，统一成一个（${hint}）`,
      })
    }
  }

  // ⑤ 配色风格与字体配对的正式度差得太远
  //
  // 这条**刻意只报 warning、不硬拦**：「学术配色 + 温暖手写」是个奇怪的组合，
  // 但奇怪不等于错 —— 一份写给小学生的科普论文就该是那样。
  // 护栏是判据，不是禁令。
  {
    const styled = slides.find(s => s.layout && s.paletteStyle && s.typography)
    const pal = styled?.paletteStyle as PaletteStyle | undefined
    const typ = styled?.typography as TypographyPair | undefined
    if (pal && typ && pal in PALETTE_FORMALITY && typ in TYPOGRAPHY_PAIRS) {
      const gap = Math.abs(PALETTE_FORMALITY[pal] - TYPOGRAPHY_PAIRS[typ].formality)
      if (gap > FORMALITY_GAP_LIMIT) {
        issues.push({
          level: 'warning',
          slideId: styled!.id,
          message: `配色「${pal}」和字体「${TYPOGRAPHY_PAIRS[typ].label}」的正式度差 ${gap} 档 —— 一个很正式一个很随意，凑在一起会显得没想清楚给谁看。确认是有意的就忽略`,
        })
      }
    }
  }

  // ⑥ 出场顺序：先标题、再内容、装饰不抢跑
  //
  // 放在 deck 级而不是 lintSlide 里，是因为 lintSlide 的结果会跟在**每一次**
  // 元素改动后面返回给 agent。手工搭页时元素和动画是分两步加的，
  // 中间那一刻必然「有元素没挂动画」——在那里报警等于每加一个元素就催一次，
  // 白烧步数还催不出正确结果。lintDeck 是收尾时才跑的，那时候页面已经成型。
  for (const [i, slide] of slides.entries()) {
    issues.push(...lintSlideAnimationOrder(slide, i))
  }

  // ⑦ 版式分布：一份稿子不该被一个版式占满
  //
  // ① 只比相邻两页。它挡得住「连着两页 cards」，**挡不住 cards / compare 交替二十页** ——
  // 每一对相邻页都不同，全绿，而读者看到的是同两张脸轮流出现。
  //
  // 判据按「最多的那个版式占了多少」算，不按「一共用了几种」：
  // 二十页里十四页是 cards 才是真的雷同，而「只用了三种版式」在一份五页的稿子里
  // 完全正常 —— 种类数会把短稿子一律判负，占比不会。
  {
    const laidOut = slides.filter(
      (s): s is Slide & { layout: string } => !!s.layout && s.elements.length > 0,
    )
    if (laidOut.length >= SPREAD_MIN_SLIDES) {
      const counts = new Map<string, number>()
      for (const s of laidOut) counts.set(s.layout, (counts.get(s.layout) ?? 0) + 1)

      const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0]
      if (n > Math.max(SPREAD_MIN_COUNT, laidOut.length * SPREAD_TOP_RATIO)) {
        const label = isLayoutPattern(top) ? LAYOUT_META[top].name : top
        issues.push({
          level: 'warning',
          slideId: slides[0].id,
          message: `${laidOut.length} 页里有 ${n} 页用了「${label}」`
            + `（${Math.round((n / laidOut.length) * 100)}%）—— 相邻页没重复不等于整份有变化。`
            + `版式库有 ${LAYOUT_PATTERNS.length} 种，按内容挑：有对比用 compare，`
            + `有先后用 timeline，有图用 split-figure / image-grid`
            + `（cards / bullets / title-center 还有 B 变体可换）`,
        })
      }
    }
  }

  // ⑧ 节奏：连着太多页内容页，中间没有喘气的地方
  //
  // prompt（`roles.ts`）写着「每 3~4 页内容页插一页节奏页」，而在这条之前
  // **没有任何东西在验** —— 和 ④ 那条配色/字体统一的处境逐字相同：
  // 写在 prompt 里的规矩，模型照做与否无人知晓，而所有检查都是绿的。
  //
  // **封面 / 结尾（`pace: 'structural'`）和节奏页一样能打断连续段**，这是对的：
  // 它们本来就是低密度大留白的页，视觉上确实让人喘了一口气。把它们归成
  // `structural` 而不是 `rhythm`，只是因为它们的位置是固定的 ——
  // agent 不能靠多加两页封面来凑节奏，一份稿子里它们只会出现在两头。
  //
  // 手工页（没有 `layout`）则**既不算内容页也不打断**：lint 不知道它长什么样，
  // 让它冒充节奏页去截断一串 cards 是在放过真问题。
  {
    const runs: number[][] = []
    let cur: number[] = []
    for (const [i, slide] of slides.entries()) {
      const pace = paceOf(slide)
      if (pace === 'content') {
        cur.push(i + 1)
        continue
      }
      // 手工页：既不算内容页，也不打断连续段
      if (pace === undefined) continue
      if (cur.length) runs.push(cur)
      cur = []
    }
    if (cur.length) runs.push(cur)

    for (const run of runs) {
      if (run.length <= MAX_CONTENT_RUN) continue
      issues.push({
        level: 'warning',
        slideId: slides[run[0] - 1].id,
        message: `第 ${run[0]}~${run[run.length - 1]} 页连着 ${run.length} 页都是内容页，`
          + `中间一页喘气的地方都没有 —— 每 3~4 页插一页 section / stat / quote / full-figure，`
          + `一路平铺读者会走神`,
      })
    }
  }

  // ⑨ 这份稿子被设计过吗
  //
  // ## 它解的是什么
  //
  // `applyLayout` 一直收 `primaryColor` / `accentColor` / `backgroundColor`，
  // 也就是说「模型自己设计配色」这条路**早就通了**。但 prompt 里提到这三个参数的
  // 次数是 0，反而教它「不给你调色盘，只给几个名字」。于是模型永远走那几个名字，
  // 而不传 `style` 时又落到 `?? 'business'` —— **每一份 deck 都是同一套配色**。
  //
  // 这和第十八轮那个图片 bug 是同一个形状（见 `LAYOUT_META.image` 的注释）：
  // 能力存在但没有任何路径够得着，等于不存在。
  //
  // ## 为什么这条能顺手解掉「跨份雷同」
  //
  // 一开始我以为跨份雷同要存历史（这个用户上一份用了什么），落点在 DB。
  // 不用 —— **那个问题的根子从来不是「两份撞色」，是「模型压根没做决定」**。
  // 只要判「有没有做决定」，多样性是白送的：真设计过的两份稿子撞成
  // 一模一样的概率本来就极低，而没设计过的一百份必然全等。
  //
  // ## 怎么判「做了决定」—— 让模型自己说，不让代码去猜
  //
  // 第一版判的是 `paletteAnchors`（applyLayout 显式传了哪几个覆盖色）。
  // **那一版把正确做法判成了错的**：颜色的正路是 `setTheme` 一次定死
  // （形状 / 图表 / 表格 / getDesignTokens 全读 `state.theme`，
  // 只有 applyLayout 的 paletteOverride 绕开它），而走 setTheme 时
  // `paletteAnchors` 恰恰是空的 —— 判据于是奖励了会把稿子配色劈成两半的那条路。
  //
  // 第二个念头是拿 `store/slides.ts` 的默认色当参照物比对。也不行：
  // 那是**代码在猜**，而且默认主题一改，判据就悄悄失准。
  //
  // 现在判 `theme.designNote` —— 模型自己写的一句「这套色是被什么驱动的」。
  // 它本来就该答（prompt 一直这么要求），只是以前没地方写。
  // `paletteAnchors` 留作第二信号：个别页真的要覆盖时，那也是做了决定。
  //
  // ## R-60 补上的洞：写了说明 ≠ 做了决定
  //
  // 旧判据只看 designNote 非空，而库里实测出一份反例：designNote 写满
  // 点茶取色，主题仍是出厂默认的白底蓝橙。所以现在**必须两条同时成立**：
  // 说了（note 非空）而且做了（锚点色偏离内置 `DEFAULT_THEME`）。
  // 参照物是代码常量而非「哪一次启动时的默认」，旧注释担心的失准不成立。
  {
    const laidOut = slides.filter(s => s.layout && s.elements.length)
    const declared = !!theme?.designNote?.trim()
    const changed = themeAnchorsChanged(theme)
    const anchored = laidOut.some(s => (s.paletteAnchors ?? []).length > 0)
    // 设计过的判据 = 说了（designNote）**而且**做了（锚点色真的偏离默认）。
    // 只说没做的那一半是「星耀影视」实测抓出来的：note 写满一页、颜色一个没动。
    const designed = anchored || (declared && changed)
    if (laidOut.length >= DESIGN_INTENT_MIN_SLIDES && !designed) {
      issues.push({
        level: 'warning',
        slideId: slides[0].id,
        message: declared
          ? 'designNote 写了，但主题的锚点色仍是内置默认（白底 + 蓝 + 橙）—— '
            + '写说明不等于做了决定。用 setTheme 把 backgroundColor / themeColors / fontColor '
            + '改成这份稿子该有的颜色，让写下的理由落在颜色上'
          : '整份稿子的配色没有被设计过 —— 这不是「选了默认」，是没有选。'
            + '用 setTheme 把 backgroundColor / themeColors 定成这份稿子该有的颜色'
            + '（讲什么就从什么里取色），并在 designNote 里写一句它是被什么驱动的。'
            + 'setTheme 走一次，形状 / 图表 / 表格全都跟着走；'
            + '每页传 applyLayout 的覆盖色只改得动版式那一层，其余还留在旧主题上',
      })
    }
  }

  // ⑩ 标题和正文用了同一个字族
  //
  // 预设配对里没有一套这样（最接近的 `scholarly` 也是思源宋 + 思源黑）——
  // 字族对比是排版层级的第一道，两边同字就只剩字号在扛。
  // 只有自配一对字（`applyLayout` 的 `displayFont` / `bodyFont`）之后才可能出现，
  // 所以这条**只对自配的情况有意义**，预设配对永远不会踩。
  for (const slide of slides) {
    const typ = slide.typography
    if (!typ?.startsWith('custom:')) continue
    const [display, body] = typ.slice('custom:'.length).split('+')
    if (display && display === body) {
      issues.push({
        level: 'warning',
        slideId: slide.id,
        message: `标题和正文都用了 ${display} —— 字族对比是层级的第一道，`
          + '两边同字就只剩字号在扛。挑一个和它性格不同的做正文（衬线配非衬线是最稳的一组）',
      })
      break
    }
  }

  return issues
}

export const lintDeck = (slides: Slide[], opts: DeckLintOptions = {}): LintIssue[] => {
  const geometry = slides.flatMap(lintSlide)
  if (opts.designChecks === false) return geometry
  return [...geometry, ...lintDeckDesign(slides, opts.theme)]
}

// ---------------------------------------------------------------------------
// 变更操作（纯函数）
// ---------------------------------------------------------------------------

export interface KernelResult<T = Slide[]> {
  ok: true
  data: T
  issues: LintIssue[]
}

export interface KernelError {
  ok: false
  error: string
}

export type KernelOutcome<T = Slide[]> = KernelResult<T> | KernelError

const cloneSlides = (slides: Slide[]): Slide[] => JSON.parse(JSON.stringify(slides))

export const findElement = (slides: Slide[], elementId: string): { slide: Slide, element: PPTElement, slideIndex: number } | null => {
  for (let i = 0; i < slides.length; i++) {
    const el = slides[i].elements.find(e => e.id === elementId)
    if (el) return { slide: slides[i], element: el, slideIndex: i }
  }
  return null
}

export const findElementsByType = (
  slides: Slide[],
  slideId: string | undefined,
  textType: string | undefined,
): PPTElement[] => {
  const targetSlides = slideId ? slides.filter(s => s.id === slideId) : slides
  let elements = targetSlides.flatMap(s => s.elements)
  if (textType) {
    elements = elements.filter(el =>
      (el.type === 'text' && el.textType === textType)
      || (el.type === 'shape' && el.text?.type === textType)
    )
  }
  return elements
}

export const applyUpdateElement = (
  slides: Slide[],
  elementId: string,
  props: Record<string, unknown>,
): KernelOutcome => {
  const found = findElement(slides, elementId)
  if (!found) return { ok: false, error: `元素 "${elementId}" 不存在` }

  // id / type 是寻址和动画引用的锚点，改了会让整份 deck 的引用错位
  if ('id' in props && props.id !== elementId) {
    return { ok: false, error: '不允许修改元素 id' }
  }
  if ('type' in props && props.type !== found.element.type) {
    return { ok: false, error: `不允许把元素 type 从 "${found.element.type}" 改成 "${String(props.type)}"，请删除后重建` }
  }

  const newSlides = cloneSlides(slides)
  const slide = newSlides[found.slideIndex]
  const elIndex = slide.elements.findIndex(e => e.id === elementId)
  const merged = { ...slide.elements[elIndex], ...props }

  // 校验的是**合并后**的结果 —— 单看 props 无法判断元素是否还合法
  const valid = validateElement(merged)
  if (!valid.ok) return { ok: false, error: valid.error }

  slide.elements[elIndex] = merged as PPTElement

  return { ok: true, data: newSlides, issues: lintSlide(slide) }
}

export const applyAddElement = (
  slides: Slide[],
  slideId: string,
  element: PPTElement,
): KernelOutcome => {
  const slideIndex = slides.findIndex(s => s.id === slideId)
  if (slideIndex === -1) return { ok: false, error: `幻灯片 "${slideId}" 不存在` }

  const valid = validateElement(element)
  if (!valid.ok) return { ok: false, error: valid.error }

  // id 撞车会让后续 updateElement / 动画引用悄悄指向另一个元素
  const dup = findElement(slides, element.id)
  if (dup) {
    return { ok: false, error: `元素 id "${element.id}" 已存在于第 ${dup.slideIndex + 1} 页，请换一个唯一 id` }
  }

  const newSlides = cloneSlides(slides)
  newSlides[slideIndex].elements.push(JSON.parse(JSON.stringify(element)))

  return { ok: true, data: newSlides, issues: lintSlide(newSlides[slideIndex]) }
}

export const applyDeleteElement = (
  slides: Slide[],
  elementId: string,
): KernelOutcome => {
  const found = findElement(slides, elementId)
  if (!found) return { ok: false, error: `元素 "${elementId}" 不存在` }

  const newSlides = cloneSlides(slides)
  const slide = newSlides[found.slideIndex]
  slide.elements = slide.elements.filter(e => e.id !== elementId)
  if (slide.animations) {
    slide.animations = slide.animations.filter(a => a.elId !== elementId)
  }

  return { ok: true, data: newSlides, issues: lintSlide(slide) }
}

export const applyAddSlide = (
  slides: Slide[],
  slide: Slide,
  afterIndex?: number,
): KernelOutcome => {
  const parseResult = slideSchema.safeParse(slide)
  if (!parseResult.success) {
    return { ok: false, error: `幻灯片数据校验失败: ${formatZodError(parseResult.error)}` }
  }

  if (slides.some(s => s.id === slide.id)) {
    return { ok: false, error: `幻灯片 id "${slide.id}" 已存在，请换一个唯一 id` }
  }

  const elemError = validateElements(slide.elements ?? [])
  if (elemError) return { ok: false, error: `幻灯片数据校验失败 —— ${elemError}` }

  // 页内元素 id 自身不能重复，也不能和已有页面撞车
  const used = collectElementIds(slides)
  const seen = new Set<string>()
  for (const el of slide.elements ?? []) {
    if (seen.has(el.id)) return { ok: false, error: `页内元素 id "${el.id}" 重复` }
    if (used.has(el.id)) return { ok: false, error: `元素 id "${el.id}" 已被其他页面占用，请换一个` }
    seen.add(el.id)
  }

  // 动画引用完整性 —— 在入口就堵死孤儿动画，
  // 否则一份带 animations 的 slide 可以直接把孤儿写进 deck
  for (const anim of slide.animations ?? []) {
    if (!seen.has(anim.elId)) {
      return { ok: false, error: `动画 "${anim.id}" 引用了本页不存在的元素 "${anim.elId}"` }
    }
  }

  const newSlides = cloneSlides(slides)
  const insertAt = afterIndex !== undefined ? afterIndex + 1 : newSlides.length
  newSlides.splice(insertAt, 0, JSON.parse(JSON.stringify(slide)))

  return { ok: true, data: newSlides, issues: lintSlide(newSlides[insertAt]) }
}

export const applyUpdateSlide = (
  slides: Slide[],
  slideId: string,
  props: Partial<Slide>,
): KernelOutcome => {
  const slideIndex = slides.findIndex(s => s.id === slideId)
  if (slideIndex === -1) return { ok: false, error: `幻灯片 "${slideId}" 不存在` }

  if ('id' in props && props.id !== slideId) {
    return { ok: false, error: '不允许修改幻灯片 id' }
  }

  // updateSlide 能整体替换 elements —— 这是绕过 addElement 校验的后门，堵上
  if ('elements' in props) {
    const elemError = validateElements((props.elements ?? []) as unknown[])
    if (elemError) return { ok: false, error: `元素校验失败 —— ${elemError}` }
  }

  const newSlides = cloneSlides(slides)
  newSlides[slideIndex] = { ...newSlides[slideIndex], ...props }

  if ('elements' in props && newSlides[slideIndex].animations?.length) {
    const elIds = new Set(newSlides[slideIndex].elements.map(e => e.id))
    newSlides[slideIndex].animations = newSlides[slideIndex].animations!.filter(a => elIds.has(a.elId))
  }

  return { ok: true, data: newSlides, issues: lintSlide(newSlides[slideIndex]) }
}

export const applyDeleteSlide = (
  slides: Slide[],
  slideId: string,
): KernelOutcome => {
  const slideIndex = slides.findIndex(s => s.id === slideId)
  if (slideIndex === -1) return { ok: false, error: `幻灯片 "${slideId}" 不存在` }
  if (slides.length <= 1) return { ok: false, error: '不能删除最后一页幻灯片' }

  const newSlides = cloneSlides(slides)
  newSlides.splice(slideIndex, 1)

  return { ok: true, data: newSlides, issues: [] }
}

export const applySetTheme = (
  theme: SlideTheme,
  props: Partial<SlideTheme>,
): KernelOutcome<SlideTheme> => {
  const newTheme = { ...theme, ...props }
  const parseResult = themeSchema.safeParse(newTheme)
  if (!parseResult.success) {
    return { ok: false, error: `主题数据校验失败: ${formatZodError(parseResult.error)}` }
  }
  return { ok: true, data: newTheme, issues: [] }
}

// ---------------------------------------------------------------------------
// 动画时间线
//
// animations 是**有序数组**，trigger 把条目串成序列：
//   click = 新起一步 · meantime = 与上条同时 · auto = 上条结束后自动
// 所以插入位置有语义，不能当集合处理。
// ---------------------------------------------------------------------------

/** 能挂动画的元素类型（line 没有 width/height，动画无意义） */
const ANIMATABLE_TYPES = new Set(['text', 'image', 'shape', 'chart', 'table', 'latex'])

export const applyAddAnimations = (
  slides: Slide[],
  slideId: string,
  animations: unknown[],
): KernelOutcome => {
  const slideIndex = slides.findIndex(s => s.id === slideId)
  if (slideIndex === -1) return { ok: false, error: `幻灯片 "${slideId}" 不存在` }
  if (!animations.length) return { ok: false, error: '没有要添加的动画' }

  const slide = slides[slideIndex]
  const elIds = new Set(slide.elements.map(e => e.id))
  const existingAnimIds = new Set((slide.animations ?? []).map(a => a.id))

  const parsed: PPTAnimation[] = []
  for (let i = 0; i < animations.length; i++) {
    const r = animationSchema.safeParse(animations[i])
    if (!r.success) {
      return { ok: false, error: `animations[${i}] 校验失败 —— ${formatZodError(r.error)}` }
    }
    const anim = r.data as PPTAnimation
    if (!elIds.has(anim.elId)) {
      return { ok: false, error: `animations[${i}] 引用了本页不存在的元素 "${anim.elId}"` }
    }
    if (existingAnimIds.has(anim.id)) {
      return { ok: false, error: `动画 id "${anim.id}" 已存在，请换一个` }
    }
    existingAnimIds.add(anim.id)
    parsed.push(anim)
  }

  const newSlides = cloneSlides(slides)
  const target = newSlides[slideIndex]
  target.animations = [...(target.animations ?? []), ...parsed]

  return { ok: true, data: newSlides, issues: lintSlide(target) }
}

export const applyRemoveAnimations = (
  slides: Slide[],
  slideId: string,
  filter: { animationIds?: string[], elementIds?: string[], all?: boolean },
): KernelOutcome => {
  const slideIndex = slides.findIndex(s => s.id === slideId)
  if (slideIndex === -1) return { ok: false, error: `幻灯片 "${slideId}" 不存在` }

  const newSlides = cloneSlides(slides)
  const slide = newSlides[slideIndex]
  const before = slide.animations?.length ?? 0

  if (!before) return { ok: false, error: `第 ${slideIndex + 1} 页没有动画` }

  if (filter.all) {
    slide.animations = []
  }
  else {
    const animIds = new Set(filter.animationIds ?? [])
    const elementIds = new Set(filter.elementIds ?? [])
    if (!animIds.size && !elementIds.size) {
      return { ok: false, error: '必须指定 animationIds / elementIds 之一，或传 all=true' }
    }
    slide.animations = slide.animations!.filter(
      a => !animIds.has(a.id) && !elementIds.has(a.elId),
    )
  }

  if (before === (slide.animations?.length ?? 0)) {
    return { ok: false, error: '没有匹配到任何动画，检查 animationIds / elementIds 是否正确' }
  }

  return { ok: true, data: newSlides, issues: lintSlide(slide) }
}

/**
 * R-16 · 动画语义 preset
 *
 * 「让这页元素依次淡入」不该要求 agent 吐 6 条顺序和 trigger 都正确的条目 ——
 * agent 选意图，kernel 保证展开成合法的时间线。
 * 顺带把 N 次 addAnimation 压成 1 次调用，对 maxSteps 预算是实打实的节省。
 */
export type AnimationPresetName =
  | 'sequential'          // 按阅读顺序依次入场（第一个点击触发，其余自动接续）
  | 'title-then-content'  // 标题先入场，其余内容随后同时入场
  | 'all-at-once'         // 全部同时入场
  | 'none'                // 清空本页动画

export const applyAnimationPreset = (
  slides: Slide[],
  slideId: string,
  preset: AnimationPresetName,
  opts: { effect?: AnimationEffect, duration?: number } = {},
): KernelOutcome => {
  const slideIndex = slides.findIndex(s => s.id === slideId)
  if (slideIndex === -1) return { ok: false, error: `幻灯片 "${slideId}" 不存在` }

  const newSlides = cloneSlides(slides)
  const slide = newSlides[slideIndex]

  if (preset === 'none') {
    slide.animations = []
    return { ok: true, data: newSlides, issues: lintSlide(slide) }
  }

  const effect = opts.effect ?? 'fade-up'
  const duration = opts.duration ?? 600

  // 阅读顺序：先上后下，同一行（top 差 <8px）内先左后右
  const ordered = slide.elements
    .filter(el => ANIMATABLE_TYPES.has(el.type))
    .slice()
    .sort((a, b) => {
      const at = 'top' in a ? a.top : 0
      const bt = 'top' in b ? b.top : 0
      if (Math.abs(at - bt) > 8) return at - bt
      const al = 'left' in a ? a.left : 0
      const bl = 'left' in b ? b.left : 0
      return al - bl
    })

  if (!ordered.length) {
    return { ok: false, error: `第 ${slideIndex + 1} 页没有可加动画的元素` }
  }

  const isHeading = (el: PPTElement) =>
    el.type === 'text' && (el.textType === 'title' || el.textType === 'subtitle')

  const mk = (el: PPTElement, key: string, trigger: PPTAnimation['trigger'], eff: AnimationEffect): PPTAnimation => ({
    id: `anim_${slideId}_${key}`,
    elId: el.id,
    effect: eff,
    type: 'in',
    duration,
    trigger,
  })

  const animations: PPTAnimation[] = []

  if (preset === 'sequential') {
    ordered.forEach((el, i) => {
      animations.push(mk(el, String(i), i === 0 ? 'click' : 'auto', effect))
    })
  }
  else if (preset === 'all-at-once') {
    ordered.forEach((el, i) => {
      animations.push(mk(el, String(i), i === 0 ? 'click' : 'meantime', effect))
    })
  }
  else {
    const headings = ordered.filter(isHeading)
    const rest = ordered.filter(el => !isHeading(el))
    headings.forEach((el, i) => {
      animations.push(mk(el, `t${i}`, i === 0 ? 'click' : 'meantime', 'fade-down'))
    })
    rest.forEach((el, i) => {
      const trigger = i === 0 ? (headings.length ? 'auto' : 'click') : 'meantime'
      animations.push(mk(el, `c${i}`, trigger, effect))
    })
  }

  // preset 是「整页重排」语义，不是追加 —— 覆盖而非 concat
  slide.animations = animations

  return { ok: true, data: newSlides, issues: lintSlide(slide) }
}

// ---------------------------------------------------------------------------
// R-29 / R-30 · 结构化元素构造
//
// 这一节的共同点：**agent 不再拼元素 JSON**。
// 它给语义参数（形状叫什么、图表是什么类型、表格几行几列），
// 几何和样式由这里算出来，再走同一套 validateElement 闸门。
//
// 08-expressiveness.md 诊断 ③ 的症结是 prompt 劝退形状，
// 但真正的根因是「让模型写 SVG path」这个要求本身不合理。
// 换成按名字选，问题就不存在了。
// ---------------------------------------------------------------------------

/** 生成在整份 deck 里唯一的元素 id（纯函数：同样的输入给同样的输出） */
export const mintElementId = (slides: Slide[], prefix: string): string => {
  const used = collectElementIds(slides)
  let n = 1
  while (used.has(`${prefix}_${n}`)) n++
  return `${prefix}_${n}`
}

export interface ShapeSpec {
  shape: string
  left: number
  top: number
  width: number
  height: number
  fill: string
  opacity?: number
  rotate?: number
  outlineColor?: string
  outlineWidth?: number
  shadow?: boolean
  text?: string
  textColor?: string
  textSize?: number
  name?: string
}

export const applyAddShape = (
  slides: Slide[],
  slideId: string,
  spec: ShapeSpec,
): KernelOutcome => {
  const slideIndex = slides.findIndex(s => s.id === slideId)
  if (slideIndex === -1) return { ok: false, error: `幻灯片 "${slideId}" 不存在` }

  const geometry = buildShapeGeometry(spec.shape, spec.width, spec.height)
  if (!geometry) {
    return {
      ok: false,
      error: `未知形状 "${spec.shape}"，可用：${SHAPE_CATALOG_KEYS.join(' / ')}`,
    }
  }

  const element = {
    id: mintElementId(slides, 'shp'),
    type: 'shape' as const,
    left: spec.left,
    top: spec.top,
    width: spec.width,
    height: spec.height,
    rotate: spec.rotate ?? 0,
    viewBox: geometry.viewBox,
    path: geometry.path,
    // 目录里标了等比的形状（圆、正多边形、全部图标）要把这个标记带下去，
    // 否则用户在画布上拖一下就把它拖变形了。原来这里写死 false，
    // shapeCatalog 那一列 fixedRatio 等于白写
    fixedRatio: geometry.fixedRatio,
    fill: spec.fill,
    ...(geometry.pathFormula ? { pathFormula: geometry.pathFormula } : {}),
    ...(geometry.keypoints ? { keypoints: geometry.keypoints } : {}),
    ...(spec.opacity !== undefined ? { opacity: spec.opacity } : {}),
    ...(spec.outlineColor
      ? { outline: { style: 'solid' as const, width: spec.outlineWidth ?? 1, color: spec.outlineColor } }
      : {}),
    ...(spec.shadow ? { shadow: { h: 0, v: 4, blur: 12, color: '#00000029' } } : {}),
    ...(spec.name ? { name: spec.name } : {}),
    ...(spec.text
      ? {
        text: {
          content: `<p style="text-align:center"><span style="font-size:${spec.textSize ?? 16}px;color:${spec.textColor ?? '#ffffff'}">${
            spec.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          }</span></p>`,
          defaultFontName: DEFAULT_BODY_FONT,
          defaultColor: spec.textColor ?? '#ffffff',
          align: 'middle' as const,
        },
      }
      : {}),
  }

  const outcome = applyAddElement(slides, slideId, element as unknown as PPTElement)

  // 图标被拉长就不是那个图标了 —— 渲染是裸的 scale(w/1024, h/1024)
  // （views/components/element/ShapeElement/BaseShapeElement.vue），
  // 给云一个 120×40 的框，出来的是一条云状的面条。
  //
  // 只查 icon 分类：ellipse 的名字就叫「椭圆 / 圆」，把椭圆画成椭圆不是错。
  const catalog = getCatalogShape(spec.shape)
  if (outcome.ok && catalog?.category === 'icon') {
    const ratio = Math.max(spec.width, spec.height) / Math.min(spec.width, spec.height)
    if (ratio > ICON_ASPECT_TOLERANCE) {
      outcome.issues = [...outcome.issues, {
        level: 'warning',
        slideId,
        elementId: element.id,
        message: `图标 "${catalog.name}" 用了 ${Math.round(spec.width)}×${Math.round(spec.height)} 的框（长宽比 ${ratio.toFixed(1)}:1），`
          + '会被拉变形 —— 图标是等比图形，给它一个正方形的框（比如 40×40），要占更大空间就整体放大',
      }]
    }
  }

  return outcome
}

/** 图标长宽比超过这个值就算拉变形了 */
const ICON_ASPECT_TOLERANCE = 1.3

export interface ChartSpec {
  chartType: typeof CHART_TYPES[number]
  left: number
  top: number
  width: number
  height: number
  labels: string[]
  legends: string[]
  series: number[][]
  themeColors?: string[]
  textColor?: string
  stack?: boolean
  lineSmooth?: boolean
  name?: string
}

export const applyAddChart = (
  slides: Slide[],
  slideId: string,
  theme: SlideTheme,
  spec: ChartSpec,
): KernelOutcome => {
  const palette = buildPalette(theme)
  const element = {
    id: mintElementId(slides, 'cht'),
    type: 'chart' as const,
    left: spec.left,
    top: spec.top,
    width: spec.width,
    height: spec.height,
    rotate: 0,
    chartType: spec.chartType,
    data: { labels: spec.labels, legends: spec.legends, series: spec.series },
    themeColors: spec.themeColors?.length ? spec.themeColors : [palette.primary, palette.accent],
    textColor: spec.textColor ?? palette.textMuted,
    ...(spec.stack || spec.lineSmooth
      ? { options: { ...(spec.stack ? { stack: true } : {}), ...(spec.lineSmooth ? { lineSmooth: true } : {}) } }
      : {}),
    ...(spec.name ? { name: spec.name } : {}),
  }

  return applyAddElement(slides, slideId, element as unknown as PPTElement)
}

export interface TableSpec {
  left: number
  top: number
  width: number
  rows: string[][]
  /** 首行是不是表头 */
  header?: boolean
  themeColor?: string
  colWidths?: number[]
  rowHeight?: number
  name?: string
}

export const applyAddTable = (
  slides: Slide[],
  slideId: string,
  theme: SlideTheme,
  spec: TableSpec,
): KernelOutcome => {
  if (!spec.rows.length) return { ok: false, error: 'rows 不能为空' }

  const cols = spec.rows[0].length
  if (!cols) return { ok: false, error: '第一行没有单元格' }
  const ragged = spec.rows.findIndex(r => r.length !== cols)
  if (ragged !== -1) {
    return { ok: false, error: `rows[${ragged}] 有 ${spec.rows[ragged].length} 列，与首行的 ${cols} 列对不上` }
  }

  const palette = buildPalette(theme)
  const rowHeight = spec.rowHeight ?? 40
  const colWidths = spec.colWidths?.length === cols
    ? normalizeWeights(spec.colWidths)
    : new Array(cols).fill(1 / cols)

  const slideIndex = slides.findIndex(s => s.id === slideId)
  if (slideIndex === -1) return { ok: false, error: `幻灯片 "${slideId}" 不存在` }

  const id = mintElementId(slides, 'tbl')
  const element = {
    id,
    type: 'table' as const,
    left: spec.left,
    top: spec.top,
    width: spec.width,
    height: rowHeight * spec.rows.length,
    rotate: 0,
    outline: { style: 'solid' as const, width: 1, color: palette.border },
    theme: {
      color: spec.themeColor ?? palette.primary,
      rowHeader: spec.header !== false,
      rowFooter: false,
      colHeader: false,
      colFooter: false,
    },
    colWidths,
    cellMinHeight: rowHeight,
    data: spec.rows.map((row, r) => row.map((text, c) => ({
      id: `${id}_${r}_${c}`,
      colspan: 1,
      rowspan: 1,
      text,
      style: {
        fontname: theme.fontName || DEFAULT_BODY_FONT,
        color: r === 0 && spec.header !== false ? palette.onPrimary : palette.text,
        ...(r === 0 && spec.header !== false ? { bold: true } : {}),
      },
    }))),
    ...(spec.name ? { name: spec.name } : {}),
  }

  return applyAddElement(slides, slideId, element as unknown as PPTElement)
}

const normalizeWeights = (weights: number[]): number[] => {
  const sum = weights.reduce((a, b) => a + b, 0)
  return sum > 0 ? weights.map(w => w / sum) : weights.map(() => 1 / weights.length)
}

export interface LineSpec {
  left: number
  top: number
  end: [number, number]
  color: string
  style?: 'solid' | 'dashed' | 'dotted'
  width?: number
  startPoint?: '' | 'arrow' | 'dot'
  endPoint?: '' | 'arrow' | 'dot'
  name?: string
}

export const applyAddLine = (
  slides: Slide[],
  slideId: string,
  spec: LineSpec,
): KernelOutcome => {
  // 线条的 start 恒为 [0,0]，end 是相对 left/top 的偏移 —— PPTist 的约定
  if (spec.end[0] === 0 && spec.end[1] === 0) {
    return { ok: false, error: 'end 不能是 [0, 0]，那是一条零长度的线' }
  }

  const element = {
    id: mintElementId(slides, 'lin'),
    type: 'line' as const,
    left: spec.left,
    top: spec.top,
    start: [0, 0] as [number, number],
    end: spec.end,
    style: spec.style ?? 'solid',
    color: spec.color,
    points: [spec.startPoint ?? '', spec.endPoint ?? ''] as ['' | 'arrow' | 'dot', '' | 'arrow' | 'dot'],
    width: spec.width ?? 2,
    ...(spec.name ? { name: spec.name } : {}),
  }

  return applyAddElement(slides, slideId, element as unknown as PPTElement)
}

// ---------------------------------------------------------------------------
// R-31 · 排版几何（对齐 / 分布）
//
// 纯算术，但对观感的杠杆率极高：元素差 3px 没对齐，人眼看不出差在哪，
// 只会觉得「这页有点脏」。让 agent 靠目测填坐标永远解决不了这个问题。
// ---------------------------------------------------------------------------

export type AlignMode = 'left' | 'right' | 'hcenter' | 'top' | 'bottom' | 'vcenter'
export type DistributeMode = 'horizontal' | 'vertical'

interface Positioned { id: string, left: number, top: number, width: number, height: number }

const positioned = (el: PPTElement): Positioned | null =>
  'width' in el && 'height' in el && 'left' in el && 'top' in el
    ? { id: el.id, left: el.left, top: el.top, width: el.width, height: el.height }
    : null

export const applyArrangeElements = (
  slides: Slide[],
  elementIds: string[],
  opts: { align?: AlignMode, distribute?: DistributeMode, gap?: number },
): KernelOutcome => {
  if (!opts.align && !opts.distribute) {
    return { ok: false, error: '必须至少指定 align 或 distribute 之一' }
  }
  if (elementIds.length < 2) return { ok: false, error: '至少要选 2 个元素' }

  const found = elementIds.map(id => findElement(slides, id))
  const missing = elementIds.filter((_, i) => !found[i])
  if (missing.length) return { ok: false, error: `找不到元素：${missing.join(', ')}` }

  const slideIndexes = new Set(found.map(f => f!.slideIndex))
  if (slideIndexes.size > 1) return { ok: false, error: '所选元素不在同一页，无法一起排列' }

  // line 元素没有 height，几何语义和矩形不同，排列会把它挪歪
  const skipped = found.filter(f => !positioned(f!.element)).map(f => f!.element.id)
  if (skipped.length) {
    return { ok: false, error: `线条元素不参与对齐/分布：${skipped.join(', ')}` }
  }

  const newSlides = cloneSlides(slides)
  const slide = newSlides[found[0]!.slideIndex]
  const targets = elementIds.map(id => slide.elements.find(e => e.id === id)!) as (PPTElement & Positioned)[]

  if (opts.align) {
    const lefts = targets.map(t => t.left)
    const rights = targets.map(t => t.left + t.width)
    const tops = targets.map(t => t.top)
    const bottoms = targets.map(t => t.top + t.height)

    switch (opts.align) {
      case 'left': { const v = Math.min(...lefts); targets.forEach(t => { t.left = v }); break }
      case 'right': { const v = Math.max(...rights); targets.forEach(t => { t.left = v - t.width }); break }
      case 'hcenter': {
        const v = (Math.min(...lefts) + Math.max(...rights)) / 2
        targets.forEach(t => { t.left = v - t.width / 2 })
        break
      }
      case 'top': { const v = Math.min(...tops); targets.forEach(t => { t.top = v }); break }
      case 'bottom': { const v = Math.max(...bottoms); targets.forEach(t => { t.top = v - t.height }); break }
      case 'vcenter': {
        const v = (Math.min(...tops) + Math.max(...bottoms)) / 2
        targets.forEach(t => { t.top = v - t.height / 2 })
        break
      }
      default:
        break
    }
  }

  if (opts.distribute) {
    const horizontal = opts.distribute === 'horizontal'
    const sorted = [...targets].sort((a, b) => (horizontal ? a.left - b.left : a.top - b.top))

    if (opts.gap !== undefined) {
      // 指定间距：首元素不动，其余按固定间距依次排开
      let cursor = horizontal ? sorted[0].left + sorted[0].width : sorted[0].top + sorted[0].height
      for (let i = 1; i < sorted.length; i++) {
        cursor += opts.gap
        if (horizontal) { sorted[i].left = cursor; cursor += sorted[i].width }
        else { sorted[i].top = cursor; cursor += sorted[i].height }
      }
    }
    else {
      // 不指定：保持首尾不动，中间等间隙铺开（PPT 的「横向分布」语义）
      const first = sorted[0]
      const last = sorted[sorted.length - 1]
      const span = horizontal
        ? (last.left + last.width) - first.left
        : (last.top + last.height) - first.top
      const totalSize = sorted.reduce((sum, t) => sum + (horizontal ? t.width : t.height), 0)
      const gap = (span - totalSize) / (sorted.length - 1)

      let cursor = horizontal ? first.left : first.top
      for (const t of sorted) {
        if (horizontal) { t.left = cursor; cursor += t.width + gap }
        else { t.top = cursor; cursor += t.height + gap }
      }
    }
  }

  // 浮点尾数会让「已经对齐」的元素下次 lint 时差 0.0000001，四舍五入到 0.1px
  for (const t of targets) {
    t.left = Math.round(t.left * 10) / 10
    t.top = Math.round(t.top * 10) / 10
  }

  return { ok: true, data: newSlides, issues: lintSlide(slide) }
}

// ---------------------------------------------------------------------------
// R-29 · 版式应用
// ---------------------------------------------------------------------------

export const applyLayoutToSlide = (
  slides: Slide[],
  slideId: string,
  theme: SlideTheme,
  pattern: string,
  content: LayoutContent,
  opts: {
    animate?: boolean
    paletteOverride?: { primary?: string, accent?: string, background?: string }
    /** 配色风格。选哪个是内容决策（模型定），风格里的色值是排版决策（代码定） */
    style?: PaletteStyle
    /**
     * 字体配对。预设之一，当作**起点**用 —— 见 `design.ts` 的
     * `TYPOGRAPHY_PAIRS` 头注释。想自己配就用下面的 `fonts`。
     */
    typography?: TypographyPair
    /**
     * R-55: 自己配一对字，优先级高于 `typography`。
     *
     * **只能从 `CHAR_WIDTH_BY_FONT` 登记过的字族里挑，这是硬约束不是偏好** ——
     * 表外的字体没有实测字宽，`estimateTextHeight` 会退回「取全部字体里最宽的」
     * 兜底表（`WIDEST`），于是每一行都按最坏情况估，白白浪费版面。
     * 自由配对是 N×N，比预设宽得多，已经够用了。
     */
    fonts?: { display: FontFamily, body: FontFamily }
    /** R-60: 结构变体。A 是默认构图，B 是另一种成熟结构（见 layouts.ts 的 LAYOUT_VARIANTS） */
    variant?: 'A' | 'B'
  } = {},
): KernelOutcome => {
  const slideIndex = slides.findIndex(s => s.id === slideId)
  if (slideIndex === -1) return { ok: false, error: `幻灯片 "${slideId}" 不存在` }

  if (!isLayoutPattern(pattern)) return { ok: false, error: `未知版式 "${pattern}"` }

  const contentError = validateLayoutContent(pattern, content)
  if (contentError) return { ok: false, error: contentError }

  const palette = buildPalette(theme, opts.paletteOverride, opts.style)

  /**
   * 自配的一对字合成一个 `TypeRecipe`。
   *
   * `formality` 给 `-1`：它只服务 lint ⑤（配色与字体的正式度差太远），
   * 而自配的一对**没有正式度可言** —— 那个分是给预设配对人工标的。
   * 给个假分会让 lint ⑤ 拿一个编出来的数去判，比不判更糟；
   * 下面记 `slide.typography` 时也不会写成预设名，⑤ 那边的
   * `typ in TYPOGRAPHY_PAIRS` 自然就跳过了。
   */
  const recipe = opts.fonts
    ? { label: '自定义', usage: '', display: opts.fonts.display, body: opts.fonts.body, formality: -1 }
    : opts.typography ? TYPOGRAPHY_PAIRS[opts.typography] : undefined

  // id 前缀带上页序号和当前元素数，重复套版式不会撞 id
  const prefix = `ly${slideIndex + 1}x${slides[slideIndex].elements.length}`
  const result = buildLayout(pattern as LayoutPattern, content, palette, prefix, {
    animate: opts.animate,
    typography: recipe,
    style: opts.style,
    variant: opts.variant,
  })

  const elemError = validateElements(result.elements)
  if (elemError) return { ok: false, error: `版式生成的元素不合法（这是 bug，请报告）—— ${elemError}` }

  const newSlides = cloneSlides(slides)
  const slide = newSlides[slideIndex]
  // 整页替换：版式的价值来自「所有元素同属一套网格」，留半页旧元素等于留半套旧网格
  slide.elements = JSON.parse(JSON.stringify(result.elements))
  slide.animations = JSON.parse(JSON.stringify(result.animations))
  slide.background = result.background
  slide.type = result.slideType
  slide.layout = pattern
  slide.layoutVariant = opts.variant ?? 'A'
  // 落盘只为让 lint 看得见 —— 见 types/slides.ts 上的说明
  slide.paletteStyle = opts.style ?? 'business'
  slide.typography = opts.fonts
    ? `custom:${opts.fonts.display}+${opts.fonts.body}`
    : opts.typography ?? 'classic'
  // 记的是**显式给了哪几个**，不是最终用了什么颜色 —— 见 types/slides.ts 上的说明。
  // 排过序，好让 lint ④ 的「整份是不是同一套」用字符串相等就能判
  slide.paletteAnchors = Object.keys(opts.paletteOverride ?? {}).sort()

  return { ok: true, data: newSlides, issues: lintSlide(slide) }
}

// ---------------------------------------------------------------------------
// R-26 · 页面转场
// ---------------------------------------------------------------------------

export const applySetSlideTransition = (
  slides: Slide[],
  slideId: string,
  turningMode: string,
): KernelOutcome => {
  const slideIndex = slides.findIndex(s => s.id === slideId)
  if (slideIndex === -1) return { ok: false, error: `幻灯片 "${slideId}" 不存在` }

  if (!(TURNING_MODES as string[]).includes(turningMode)) {
    return { ok: false, error: `未知转场 "${turningMode}"，可用：${TURNING_MODES.join(' / ')}` }
  }

  const newSlides = cloneSlides(slides)
  newSlides[slideIndex].turningMode = turningMode as TurningMode

  return { ok: true, data: newSlides, issues: [] }
}
