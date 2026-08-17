/**
 * Deck Kernel — 纯函数库
 *
 * 不依赖 Vue / HTTP / DB / LLM。
 * agent 永远不直接写 deck JSON，只能调工具，工具全部经 kernel 校验。
 */

import { z } from 'zod'
import type { Slide, PPTElement, SlideTheme, SlideBackground } from '@/types/slides'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const VIEWPORT_WIDTH = 1000
export const VIEWPORT_HEIGHT = 562.5

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

const animationEffectSchema = z.enum([
  'fade', 'fade-up', 'fade-down', 'fade-left', 'fade-right',
  'slide-up', 'slide-down', 'slide-left', 'slide-right',
  'scale-in', 'zoom-in', 'spin-in', 'fly-in', 'wipe',
  'pulse-soft', 'pulse', 'pulse-strong',
  'grow-shrink-soft', 'grow-shrink', 'grow-shrink-strong',
  'exit-fade', 'exit-scale', 'exit-zoom', 'exit-wipe', 'exit-fly',
])

export const animationSchema = z.object({
  id: z.string().min(1),
  elId: z.string().min(1),
  effect: animationEffectSchema,
  type: z.enum(['in', 'out', 'attention']),
  duration: z.number().int().min(100).max(10000),
  trigger: z.enum(['click', 'meantime', 'auto']),
  exportBehavior: z.enum(['native', 'web-only', 'flatten']).optional(),
})

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
  elements: z.array(z.any()),
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

const rectsOverlap = (
  a: { left: number, top: number, width: number, height: number },
  b: { left: number, top: number, width: number, height: number },
): boolean => {
  return a.left < b.left + b.width
    && a.left + a.width > b.left
    && a.top < b.top + b.height
    && a.top + a.height > b.top
}

export const lintSlide = (slide: Slide): LintIssue[] => {
  const issues: LintIssue[] = []

  for (const el of slide.elements) {
    if (el.type === 'line') continue

    // 越界检测
    if (el.left + el.width < 0 || el.left > VIEWPORT_WIDTH
      || el.top + el.height < 0 || el.top > VIEWPORT_HEIGHT) {
      issues.push({
        level: 'warning',
        elementId: el.id,
        slideId: slide.id,
        message: `元素 "${el.name || el.id}" 完全在画布外`,
      })
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

  const newSlides = cloneSlides(slides)
  const slide = newSlides[found.slideIndex]
  const elIndex = slide.elements.findIndex(e => e.id === elementId)
  slide.elements[elIndex] = { ...slide.elements[elIndex], ...props } as PPTElement

  return { ok: true, data: newSlides, issues: lintSlide(slide) }
}

export const applyAddElement = (
  slides: Slide[],
  slideId: string,
  element: PPTElement,
): KernelOutcome => {
  const slideIndex = slides.findIndex(s => s.id === slideId)
  if (slideIndex === -1) return { ok: false, error: `幻灯片 "${slideId}" 不存在` }

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
    return { ok: false, error: `幻灯片数据校验失败: ${parseResult.error.issues.map(i => i.message).join('; ')}` }
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
    return { ok: false, error: `主题数据校验失败: ${parseResult.error.issues.map(i => i.message).join('; ')}` }
  }
  return { ok: true, data: newTheme, issues: [] }
}
