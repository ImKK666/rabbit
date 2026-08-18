/**
 * Deck Kernel — 纯函数库
 *
 * 不依赖 Vue / HTTP / DB / LLM。
 * agent 永远不直接写 deck JSON，只能调工具，工具全部经 kernel 校验。
 */

import { z } from 'zod'
import type { Slide, PPTElement, PPTAnimation, SlideTheme, AnimationEffect } from '@/types/slides'
import { ANIMATION_DEFS } from '@/configs/animation'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const VIEWPORT_WIDTH = 1000
export const VIEWPORT_HEIGHT = 562.5

/** 元素超出画布多少逻辑像素才算越界（留一点浮点容差） */
const OVERFLOW_TOLERANCE = 1

/** 面积占画布这个比例以上的元素视为背景板 —— 它跟谁都重叠，报了全是噪音 */
const BACKDROP_AREA_RATIO = 0.6

/** 交集面积占较小元素的比例超过这个值，才算「压住了」 */
const OVERLAP_RATIO_THRESHOLD = 0.6

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

/** agent 会主动产出的 4 种元素 —— 严格校验 */
const STRICT_ELEMENT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  text: textElementSchema,
  image: imageElementSchema,
  shape: shapeElementSchema,
  line: lineElementSchema,
}

/**
 * agent 不产出、但导入的 deck 里可能存在的类型。
 * 只校验基础几何字段其余放行 —— 否则一份带表格的 deck 会在 updateSlide 时被整体拒收。
 */
const PASSTHROUGH_ELEMENT_TYPES = new Set(['chart', 'table', 'latex', 'video', 'audio'])

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

  return { ok: false, error: `不支持的元素类型 "${type}"（agent 可用：text / image / shape / line）` }
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
  turningMode: z.string().optional(),
  type: z.enum(['cover', 'contents', 'transition', 'content', 'end']).optional(),
})

export const themeSchema = z.object({
  backgroundColor: z.string(),
  themeColors: z.array(z.string()),
  fontColor: z.string(),
  fontName: z.string(),
  outline: elementOutlineSchema,
  shadow: elementShadowSchema,
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

export const lintDeck = (slides: Slide[]): LintIssue[] => {
  return slides.flatMap(lintSlide)
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
