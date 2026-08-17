import type { AnimationEffect, AnimationType, TurningMode } from '@/types/slides'

/**
 * R-07 · 动画词表（92 → 25）
 *
 * 原 PPTist 用 animate.css 全集（入场 40 + 退场 40 + 强调 12 = 92），
 * 全部只在网页演示模式生效，导出 PPTX 时静默丢失
 * —— hooks/useExport.ts 里 animation 零匹配，pptxgenjs 也没有动画 API。
 *
 * 现在只保留「网页能演」∩「OOXML 能表达」的交集，每项同时携带：
 *   cssClass —— 网页演示用的类名后缀（拼上 ANIMATION_CLASS_PREFIX）
 *   pptx     —— 导出时写入的 PowerPoint preset
 *
 * OOXML preset 数值取自 refs/oh-my-ppt/src/main/animation/pptx-animation-map.ts。
 *
 * ⚠️ 方向命名：**方向指元素「从哪里来」**（与 animate.css 一致）。
 *    参考实现 oh-my-ppt 的命名是「往哪里去」，左右与本表相反 ——
 *    对照它的表时 fade-left / fade-right 的 presetSubtype 需要互换。
 */

export const ANIMATION_DEFAULT_DURATION = 1000
export const ANIMATION_DEFAULT_TRIGGER = 'click'
export const ANIMATION_CLASS_PREFIX = 'animate__'

// ---------------------------------------------------------------------------
// PPTX preset
// ---------------------------------------------------------------------------

export type PptxPresetClass = 'entr' | 'emph' | 'exit'
export type PptxMotion = 'fromTop' | 'fromBottom' | 'fromLeft' | 'fromRight' | 'fromTrace'

/** 对应 OOXML 的 <p:animEffect> / <p:par> preset 参数 */
export interface PptxAnimationPreset {
  presetId: number
  presetClass: PptxPresetClass
  presetSubtype?: number
  motion?: PptxMotion
  /** 缩放起止，单位为千分之一百分比（100000 = 100%） */
  scaleFrom?: number
  scaleTo?: number
  /** 旋转起止，单位为六万分之一度（-720000 = -12°×...，沿用 OOXML 惯例） */
  rotateFrom?: number
  rotateTo?: number
  fade?: boolean
  effectFilter?: 'wipe'
  transition?: 'in' | 'out'
}

export interface AnimationDef {
  value: AnimationEffect
  name: string
  type: AnimationType
  /** 网页演示用的 animate.css 类名后缀（自定义效果见 assets/styles/animation-extra.scss） */
  cssClass: string
  /**
   * 网页表现是否与 PPTX 精确一致。
   * false 表示网页侧是近似（animate.css 无法表达该强度/形态），PPTX 侧才精确。
   * 目前全部为 true —— 缺失的 7 个效果已在 animation-extra.scss 里自定义补齐。
   */
  cssExact: boolean
  pptx: PptxAnimationPreset
}

// ---------------------------------------------------------------------------
// 词表本体
// ---------------------------------------------------------------------------

const ENTER_DEFS: AnimationDef[] = [
  { value: 'fade', name: '淡入', type: 'in', cssClass: 'fadeIn', cssExact: true,
    pptx: { presetId: 10, presetClass: 'entr', fade: true } },

  { value: 'fade-up', name: '自下淡入', type: 'in', cssClass: 'fadeInUp', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: 8, motion: 'fromBottom', fade: true } },
  { value: 'fade-down', name: '自上淡入', type: 'in', cssClass: 'fadeInDown', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: 1, motion: 'fromTop', fade: true } },
  { value: 'fade-left', name: '自左淡入', type: 'in', cssClass: 'fadeInLeft', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: 2, motion: 'fromLeft', fade: true } },
  { value: 'fade-right', name: '自右淡入', type: 'in', cssClass: 'fadeInRight', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: 3, motion: 'fromRight', fade: true } },

  { value: 'slide-up', name: '自下滑入', type: 'in', cssClass: 'slideInUp', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: 8, motion: 'fromBottom' } },
  { value: 'slide-down', name: '自上滑入', type: 'in', cssClass: 'slideInDown', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: 1, motion: 'fromTop' } },
  { value: 'slide-left', name: '自左滑入', type: 'in', cssClass: 'slideInLeft', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: 2, motion: 'fromLeft' } },
  { value: 'slide-right', name: '自右滑入', type: 'in', cssClass: 'slideInRight', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: 3, motion: 'fromRight' } },

  { value: 'scale-in', name: '轻缩放进入', type: 'in', cssClass: 'scaleIn', cssExact: true,
    pptx: { presetId: 31, presetClass: 'entr', scaleFrom: 85000, scaleTo: 100000, fade: true } },
  { value: 'zoom-in', name: '放大进入', type: 'in', cssClass: 'zoomInSoft', cssExact: true,
    pptx: { presetId: 31, presetClass: 'entr', scaleFrom: 75000, scaleTo: 100000, fade: true } },
  { value: 'spin-in', name: '旋转进入', type: 'in', cssClass: 'spinIn', cssExact: true,
    pptx: { presetId: 31, presetClass: 'entr', scaleFrom: 92000, scaleTo: 100000,
      rotateFrom: -720000, rotateTo: 0, fade: true } },

  { value: 'fly-in', name: '飞入', type: 'in', cssClass: 'backInUp', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', motion: 'fromTrace', fade: true } },
  { value: 'wipe', name: '擦除进入', type: 'in', cssClass: 'wipeIn', cssExact: true,
    pptx: { presetId: 5, presetClass: 'entr', effectFilter: 'wipe' } },
]

const ATTENTION_DEFS: AnimationDef[] = [
  { value: 'pulse-soft', name: '脉冲（弱）', type: 'attention', cssClass: 'pulseSoft', cssExact: true,
    pptx: { presetId: 6, presetClass: 'emph', scaleFrom: 100000, scaleTo: 103000 } },
  { value: 'pulse', name: '脉冲', type: 'attention', cssClass: 'pulse', cssExact: true,
    pptx: { presetId: 6, presetClass: 'emph', scaleFrom: 100000, scaleTo: 106000 } },
  { value: 'pulse-strong', name: '脉冲（强）', type: 'attention', cssClass: 'pulseStrong', cssExact: true,
    pptx: { presetId: 6, presetClass: 'emph', scaleFrom: 100000, scaleTo: 110000 } },

  { value: 'grow-shrink-soft', name: '缩放强调（弱）', type: 'attention', cssClass: 'growShrinkSoft', cssExact: true,
    pptx: { presetId: 6, presetClass: 'emph', scaleFrom: 95000, scaleTo: 104000 } },
  { value: 'grow-shrink', name: '缩放强调', type: 'attention', cssClass: 'growShrink', cssExact: true,
    pptx: { presetId: 6, presetClass: 'emph', scaleFrom: 90000, scaleTo: 108000 } },
  { value: 'grow-shrink-strong', name: '缩放强调（强）', type: 'attention', cssClass: 'growShrinkStrong', cssExact: true,
    pptx: { presetId: 6, presetClass: 'emph', scaleFrom: 85000, scaleTo: 112000 } },
]

const EXIT_DEFS: AnimationDef[] = [
  { value: 'exit-fade', name: '淡出', type: 'out', cssClass: 'fadeOut', cssExact: true,
    pptx: { presetId: 10, presetClass: 'exit', fade: true, transition: 'out' } },
  { value: 'exit-scale', name: '轻缩放退出', type: 'out', cssClass: 'scaleOut', cssExact: true,
    pptx: { presetId: 31, presetClass: 'exit', scaleFrom: 100000, scaleTo: 85000, fade: true, transition: 'out' } },
  { value: 'exit-zoom', name: '缩小退出', type: 'out', cssClass: 'zoomOutSoft', cssExact: true,
    pptx: { presetId: 31, presetClass: 'exit', scaleFrom: 100000, scaleTo: 75000, fade: true, transition: 'out' } },
  { value: 'exit-wipe', name: '擦除退出', type: 'out', cssClass: 'wipeOut', cssExact: true,
    pptx: { presetId: 5, presetClass: 'exit', effectFilter: 'wipe', transition: 'out' } },
  { value: 'exit-fly', name: '飞出', type: 'out', cssClass: 'backOutDown', cssExact: true,
    pptx: { presetId: 2, presetClass: 'exit', motion: 'fromTrace', fade: true, transition: 'out' } },
]

/** 扁平查找表 —— 导出、校验、agent 工具都用这个 */
export const ANIMATION_DEFS: Record<AnimationEffect, AnimationDef> = Object.fromEntries(
  [...ENTER_DEFS, ...ATTENTION_DEFS, ...EXIT_DEFS].map(def => [def.value, def])
) as Record<AnimationEffect, AnimationDef>

/** 网页演示用的完整类名。未知 effect 回退到淡入，避免脏数据导致演示直接白屏 */
export const getAnimationCssClass = (effect: AnimationEffect | string): string => {
  const def = ANIMATION_DEFS[effect as AnimationEffect]
  return `${ANIMATION_CLASS_PREFIX}${def ? def.cssClass : 'fadeIn'}`
}

export const isAnimationEffect = (value: unknown): value is AnimationEffect =>
  typeof value === 'string' && value in ANIMATION_DEFS

// ---------------------------------------------------------------------------
// 面板用的分组结构（保持原有 { type, name, children } 两层形状，UI 不用改结构）
// ---------------------------------------------------------------------------

interface AnimationGroup {
  type: string
  name: string
  children: { name: string; value: AnimationEffect }[]
}

const group = (
  type: string,
  name: string,
  defs: AnimationDef[],
  values: AnimationEffect[]
): AnimationGroup => ({
  type,
  name,
  children: values.map(v => {
    const def = defs.find(d => d.value === v)!
    return { name: def.name, value: def.value }
  }),
})

export const ENTER_ANIMATIONS: AnimationGroup[] = [
  group('fade', '淡入', ENTER_DEFS, ['fade', 'fade-up', 'fade-down', 'fade-left', 'fade-right']),
  group('slide', '滑入', ENTER_DEFS, ['slide-up', 'slide-down', 'slide-left', 'slide-right']),
  group('zoom', '缩放', ENTER_DEFS, ['scale-in', 'zoom-in', 'spin-in']),
  group('special', '特殊', ENTER_DEFS, ['fly-in', 'wipe']),
]

export const ATTENTION_ANIMATIONS: AnimationGroup[] = [
  group('pulse', '脉冲', ATTENTION_DEFS, ['pulse-soft', 'pulse', 'pulse-strong']),
  group('growShrink', '缩放强调', ATTENTION_DEFS, ['grow-shrink-soft', 'grow-shrink', 'grow-shrink-strong']),
]

export const EXIT_ANIMATIONS: AnimationGroup[] = [
  group('fade', '淡出', EXIT_DEFS, ['exit-fade']),
  group('zoom', '缩放', EXIT_DEFS, ['exit-scale', 'exit-zoom']),
  group('special', '特殊', EXIT_DEFS, ['exit-wipe', 'exit-fly']),
]

// ---------------------------------------------------------------------------
// 翻页方式
// ---------------------------------------------------------------------------

// 注：这些是页面切换（Slide.turningMode），由 PPTist 自己用 CSS transition 实现，
// 与元素动画是两套东西。PPTX 的幻灯片切换是另一组 OOXML 特性（<p:transition>），
// 要不要一并导出留待 R-17 处理，本次不动。
interface SlideAnimation {
  label: string
  value: TurningMode
}

export const SLIDE_ANIMATIONS: SlideAnimation[] = [
  { label: '无', value: 'no' },
  { label: '随机', value: 'random' },
  { label: '左右推移', value: 'slideX' },
  { label: '上下推移', value: 'slideY' },
  { label: '左右推移（3D）', value: 'slideX3D' },
  { label: '上下推移（3D）', value: 'slideY3D' },
  { label: '淡入淡出', value: 'fade' },
  { label: '旋转', value: 'rotate' },
  { label: '上下展开', value: 'scaleY' },
  { label: '左右展开', value: 'scaleX' },
  { label: '放大', value: 'scale' },
  { label: '缩小', value: 'scaleReverse' },
]
