import type { AnimationEffect, AnimationType, TurningMode } from '@/types/slides'

/**
 * R-07 / R-25 · 动画词表
 *
 * 原 PPTist 用 animate.css 全集（入场 40 + 退场 40 + 强调 12 = 92），
 * 全部只在网页演示模式生效，导出 PPTX 时静默丢失
 * —— hooks/useExport.ts 里 animation 零匹配，pptxgenjs 也没有动画 API。
 *
 * 现在只保留「网页能演」∩「OOXML 能表达」的交集，每项同时携带：
 *   cssClass —— 网页演示用的类名后缀（拼上 ANIMATION_CLASS_PREFIX）
 *   pptx     —— 导出时写入的 PowerPoint preset
 *
 * ## R-25：25 → 45
 *
 * 第一版只映射到 5 个 presetId（2/5/6/10/31），25 个标签其实只有 5 种行为，
 * 换的只是方向和缩放参数，观感必然雷同（诊断见 docs/08-expressiveness.md）。
 *
 * 扩容的入口是 `<p:animEffect filter="...">` —— OOXML 的**转场滤镜词表**
 * （见下方 OOXML_EFFECT_FILTERS）。这些滤镜是 PowerPoint 原生的，
 * 不需要任何行为树技巧，导出即可播放，且百叶窗 / 棋盘 / 圆形 / 菱形 / 十字
 * 这些硬边几何效果和现有的「淡入 + 位移 + 缩放」在观感上完全不同类。
 *
 * presetId / presetSubtype 取自 ECMA-376 的预设编号表，**不是**从
 * refs/oh-my-ppt 抄的（它覆盖的正好也只有那 5 个）。方向子类型是位掩码：
 *   1=上 · 2=右 · 4=下 · 8=左 · 5=纵向(1|4) · 10=横向(2|8) · 16=向内 · 32=向外
 *
 * ⚠️ 方向命名：**方向指元素「从哪里来」**（与 animate.css 一致）。
 *    presetSubtype 记的也是「来源边」，而 filter 里的方向记的是「擦除去向」，
 *    两者天然相反：自下进入 = presetSubtype 4 + filter wipe(up)。
 */

export const ANIMATION_DEFAULT_DURATION = 1000
export const ANIMATION_DEFAULT_TRIGGER = 'click'
export const ANIMATION_CLASS_PREFIX = 'animate__'

// ---------------------------------------------------------------------------
// OOXML 转场滤镜词表
// ---------------------------------------------------------------------------

/**
 * `<p:animEffect filter="...">` 的合法取值。
 *
 * 语法是 `名字` 或 `名字(子类型)`，多个用 `;` 分隔（我们只用单个）。
 * 这张表就是「哪些效果能导出」的边界 —— 想加新效果先看这里有没有，
 * 没有的话要么走行为树（位移 / 缩放 / 旋转 / 透明度），要么别加。
 *
 * 刻意没有收录的：
 *   barn      语义（inVertical 到底是开还是关）无法从规范文本确认，先不用
 *   image     不是视觉效果，是像素滤镜
 *   pixelate  PowerPoint 新版才有，老版本静默失败
 *   slide     和 <p:anim> 位移重复，位移版可控性更好
 */
export const OOXML_EFFECT_FILTERS = {
  blinds: ['horizontal', 'vertical'],
  box: ['in', 'out'],
  checkerboard: ['across', 'down'],
  circle: ['in', 'out'],
  diamond: ['in', 'out'],
  dissolve: [],
  fade: [],
  plus: ['in', 'out'],
  randombar: ['horizontal', 'vertical'],
  strips: ['downLeft', 'upLeft', 'downRight', 'upRight'],
  wedge: [],
  wheel: ['1', '2', '3', '4', '8'],
  wipe: ['up', 'down', 'left', 'right'],
} as const

type FilterTable = typeof OOXML_EFFECT_FILTERS
export type OoxmlFilterName = keyof FilterTable

/**
 * 名字和子类型绑定的联合类型 —— `{ name: 'wipe', subtype: 'across' }`
 * 这种组合在编译期就会被拒绝，不用等到 PowerPoint 里发现效果没播。
 */
export type OoxmlEffectFilter = {
  [K in OoxmlFilterName]: FilterTable[K][number] extends never
    ? { name: K }
    : { name: K, subtype: FilterTable[K][number] }
}[OoxmlFilterName]

/** `{ name: 'wipe', subtype: 'up' }` → `wipe(up)`；无子类型的 → `dissolve` */
export const formatEffectFilter = (filter: OoxmlEffectFilter): string => {
  const subtype = (filter as { subtype?: string }).subtype
  return subtype ? `${filter.name}(${subtype})` : filter.name
}

// ---------------------------------------------------------------------------
// PPTX preset
// ---------------------------------------------------------------------------

export type PptxPresetClass = 'entr' | 'emph' | 'exit'
export type PptxMotion = 'fromTop' | 'fromBottom' | 'fromLeft' | 'fromRight' | 'fromTrace'

/** 方向子类型（位掩码，见文件头注释） */
const SUB = {
  fromTop: 1,
  fromRight: 2,
  fromBottom: 4,
  fromLeft: 8,
  vertical: 5,
  horizontal: 10,
  in: 16,
  out: 32,
} as const

/** 一整圈 = 360°，OOXML 的角度单位是 1/60000 度 */
const FULL_TURN = 21600000

/** 对应 OOXML 的 <p:animEffect> / <p:par> preset 参数 */
export interface PptxAnimationPreset {
  presetId: number
  presetClass: PptxPresetClass
  presetSubtype?: number
  motion?: PptxMotion
  /** 缩放起止，单位为千分之一百分比（100000 = 100%） */
  scaleFrom?: number
  scaleTo?: number
  /** 旋转起止，单位为六万分之一度（-720000 = -12°） */
  rotateFrom?: number
  rotateTo?: number
  /** 相对旋转量，`<p:animRot by>`。和 rotateFrom/To 二选一，强调类旋转用这个 */
  rotateBy?: number
  /** 透明度脉冲：不透明度掉到这个值再回到 1（0~1）。强调类专用 */
  opacityDip?: number
  fade?: boolean
  effectFilter?: OoxmlEffectFilter
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
   *
   * 判据（R-36 收紧）：**同一种机制、同一个方向、同一条物理量曲线**。
   *   - 只是行程距离不同 → 仍算 exact。animate.css 的 fadeInLeft 位移
   *     100% 自身宽度，PPTX 那边是 w/2，看着是同一个「从左边滑进来」
   *   - 机制多一条或少一条 → 算近似。fly-in 网页侧是 backInUp，
   *     除位移外还带缩放；PPTX 那边只有位移 + 淡入，没有缩放
   *   - 逐块揭示的滤镜（百叶窗 / 棋盘 / 溶解 / 随机线条 / 阶梯）→ 一律近似，
   *     CSS 只能用 mask 拼个形似的，分块数和节奏与 PowerPoint 不会一致
   *
   * **PPTX 侧才是保真的那一边**，网页只是预览，标 false 不是缺陷单。
   *
   * 45 个效果的实测数据见 `npm run lab` + scripts/measure-animation-lab.mjs。
   */
  cssExact: boolean
  pptx: PptxAnimationPreset
}

// ---------------------------------------------------------------------------
// 词表本体
// ---------------------------------------------------------------------------

/**
 * 入场（29）
 *
 * 分四类性格，Generator 选效果时按性格挑，别按名字随机撞：
 *   柔和   fade 系 / scale / zoom —— 正文、大段文字
 *   方向   slide 系 / fly —— 有阅读顺序的列表、卡片
 *   擦除   wipe 系 —— 分隔线、进度条、强调条
 *   几何   blinds / checkerboard / box / circle / diamond / plus / wheel / wedge …
 *          —— 封面、章节转场、图表出场这类需要「事件感」的地方
 */
const ENTER_DEFS: AnimationDef[] = [
  // --- 柔和 ---
  { value: 'fade', name: '淡入', type: 'in', cssClass: 'fadeIn', cssExact: true,
    pptx: { presetId: 10, presetClass: 'entr', fade: true } },

  { value: 'fade-up', name: '自下淡入', type: 'in', cssClass: 'fadeInUp', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: SUB.fromBottom, motion: 'fromBottom', fade: true } },
  { value: 'fade-down', name: '自上淡入', type: 'in', cssClass: 'fadeInDown', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: SUB.fromTop, motion: 'fromTop', fade: true } },
  { value: 'fade-left', name: '自左淡入', type: 'in', cssClass: 'fadeInLeft', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: SUB.fromLeft, motion: 'fromLeft', fade: true } },
  { value: 'fade-right', name: '自右淡入', type: 'in', cssClass: 'fadeInRight', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: SUB.fromRight, motion: 'fromRight', fade: true } },

  { value: 'scale-in', name: '轻缩放进入', type: 'in', cssClass: 'scaleIn', cssExact: true,
    pptx: { presetId: 31, presetClass: 'entr', scaleFrom: 85000, scaleTo: 100000, fade: true } },
  { value: 'zoom-in', name: '放大进入', type: 'in', cssClass: 'zoomInSoft', cssExact: true,
    pptx: { presetId: 31, presetClass: 'entr', scaleFrom: 75000, scaleTo: 100000, fade: true } },
  { value: 'spin-in', name: '旋转进入', type: 'in', cssClass: 'spinIn', cssExact: true,
    pptx: { presetId: 31, presetClass: 'entr', scaleFrom: 92000, scaleTo: 100000,
      rotateFrom: -720000, rotateTo: 0, fade: true } },

  // --- 方向 ---
  { value: 'slide-up', name: '自下滑入', type: 'in', cssClass: 'slideInUp', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: SUB.fromBottom, motion: 'fromBottom' } },
  { value: 'slide-down', name: '自上滑入', type: 'in', cssClass: 'slideInDown', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: SUB.fromTop, motion: 'fromTop' } },
  { value: 'slide-left', name: '自左滑入', type: 'in', cssClass: 'slideInLeft', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: SUB.fromLeft, motion: 'fromLeft' } },
  { value: 'slide-right', name: '自右滑入', type: 'in', cssClass: 'slideInRight', cssExact: true,
    pptx: { presetId: 2, presetClass: 'entr', presetSubtype: SUB.fromRight, motion: 'fromRight' } },

  // 近似：网页用 animate.css 的 backInUp —— 位移 1200px 外还带 scale(0.7)→1，
  // PPTX 侧只有「自下位移 h/2 + 淡入」，没有缩放这一路。
  // 另注：fromTrace 在 buildTimingXml 里走的是和 fromBottom 同一个公式，
  // 所以导出后 fly-in 和 fade-up 在 PowerPoint 里几乎是同一个效果，
  // 网页上却明显不同 —— 差异就在这个缩放和更长的行程上。
  { value: 'fly-in', name: '飞入', type: 'in', cssClass: 'backInUp', cssExact: false,
    pptx: { presetId: 2, presetClass: 'entr', motion: 'fromTrace', fade: true } },

  // --- 擦除 ---
  // presetId 22 = Wipe。第一版误写成 5（Checkerboard），效果能播但动画窗格里显示成棋盘
  { value: 'wipe', name: '自左擦除', type: 'in', cssClass: 'wipeIn', cssExact: true,
    pptx: { presetId: 22, presetClass: 'entr', presetSubtype: SUB.fromLeft,
      effectFilter: { name: 'wipe', subtype: 'right' } } },
  { value: 'wipe-right', name: '自右擦除', type: 'in', cssClass: 'wipeInRight', cssExact: true,
    pptx: { presetId: 22, presetClass: 'entr', presetSubtype: SUB.fromRight,
      effectFilter: { name: 'wipe', subtype: 'left' } } },
  { value: 'wipe-up', name: '自下擦除', type: 'in', cssClass: 'wipeInUp', cssExact: true,
    pptx: { presetId: 22, presetClass: 'entr', presetSubtype: SUB.fromBottom,
      effectFilter: { name: 'wipe', subtype: 'up' } } },
  { value: 'wipe-down', name: '自上擦除', type: 'in', cssClass: 'wipeInDown', cssExact: true,
    pptx: { presetId: 22, presetClass: 'entr', presetSubtype: SUB.fromTop,
      effectFilter: { name: 'wipe', subtype: 'down' } } },

  // --- 几何 ---
  { value: 'blinds-h', name: '百叶窗（横）', type: 'in', cssClass: 'blindsH', cssExact: false,
    pptx: { presetId: 3, presetClass: 'entr', presetSubtype: SUB.horizontal,
      effectFilter: { name: 'blinds', subtype: 'horizontal' } } },
  { value: 'blinds-v', name: '百叶窗（竖）', type: 'in', cssClass: 'blindsV', cssExact: false,
    pptx: { presetId: 3, presetClass: 'entr', presetSubtype: SUB.vertical,
      effectFilter: { name: 'blinds', subtype: 'vertical' } } },
  { value: 'checkerboard', name: '棋盘', type: 'in', cssClass: 'checkerboard', cssExact: false,
    pptx: { presetId: 5, presetClass: 'entr', presetSubtype: SUB.horizontal,
      effectFilter: { name: 'checkerboard', subtype: 'across' } } },
  { value: 'dissolve-in', name: '溶解', type: 'in', cssClass: 'dissolveIn', cssExact: false,
    pptx: { presetId: 9, presetClass: 'entr', effectFilter: { name: 'dissolve' } } },
  { value: 'randombar', name: '随机线条', type: 'in', cssClass: 'randombar', cssExact: false,
    pptx: { presetId: 14, presetClass: 'entr', presetSubtype: SUB.horizontal,
      effectFilter: { name: 'randombar', subtype: 'horizontal' } } },
  { value: 'strips-in', name: '阶梯状', type: 'in', cssClass: 'stripsIn', cssExact: false,
    pptx: { presetId: 18, presetClass: 'entr',
      effectFilter: { name: 'strips', subtype: 'downRight' } } },

  { value: 'box-in', name: '盒状展开', type: 'in', cssClass: 'boxIn', cssExact: true,
    pptx: { presetId: 4, presetClass: 'entr', presetSubtype: SUB.in,
      effectFilter: { name: 'box', subtype: 'in' } } },
  { value: 'circle-in', name: '圆形展开', type: 'in', cssClass: 'circleIn', cssExact: true,
    pptx: { presetId: 6, presetClass: 'entr', presetSubtype: SUB.in,
      effectFilter: { name: 'circle', subtype: 'in' } } },
  { value: 'diamond-in', name: '菱形展开', type: 'in', cssClass: 'diamondIn', cssExact: true,
    pptx: { presetId: 8, presetClass: 'entr', presetSubtype: SUB.in,
      effectFilter: { name: 'diamond', subtype: 'in' } } },
  { value: 'plus-in', name: '十字展开', type: 'in', cssClass: 'plusIn', cssExact: true,
    pptx: { presetId: 13, presetClass: 'entr', presetSubtype: SUB.in,
      effectFilter: { name: 'plus', subtype: 'in' } } },
  { value: 'wedge-in', name: '楔入', type: 'in', cssClass: 'wedgeIn', cssExact: true,
    pptx: { presetId: 20, presetClass: 'entr', effectFilter: { name: 'wedge' } } },
  { value: 'wheel-in', name: '轮辐', type: 'in', cssClass: 'wheelIn', cssExact: true,
    pptx: { presetId: 21, presetClass: 'entr', presetSubtype: 4,
      effectFilter: { name: 'wheel', subtype: '4' } } },
]

/**
 * 强调（8）
 *
 * 前 6 个是缩放分级（presetId 6 = Grow/Shrink），
 * 后 2 个是新加的另外两种物理量：旋转和透明度 —— 强调不该只有「变大一下」。
 */
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

  // presetId 8 emph = Spin，presetId 9 emph = Transparency
  { value: 'spin', name: '陀螺旋转', type: 'attention', cssClass: 'spin', cssExact: true,
    pptx: { presetId: 8, presetClass: 'emph', rotateBy: FULL_TURN } },
  { value: 'blink', name: '闪烁', type: 'attention', cssClass: 'blink', cssExact: true,
    pptx: { presetId: 9, presetClass: 'emph', opacityDip: 0.3 } },
]

/** 退场（8） */
const EXIT_DEFS: AnimationDef[] = [
  { value: 'exit-fade', name: '淡出', type: 'out', cssClass: 'fadeOut', cssExact: true,
    pptx: { presetId: 10, presetClass: 'exit', fade: true, transition: 'out' } },
  { value: 'exit-scale', name: '轻缩放退出', type: 'out', cssClass: 'scaleOut', cssExact: true,
    pptx: { presetId: 31, presetClass: 'exit', scaleFrom: 100000, scaleTo: 85000, fade: true, transition: 'out' } },
  { value: 'exit-zoom', name: '缩小退出', type: 'out', cssClass: 'zoomOutSoft', cssExact: true,
    pptx: { presetId: 31, presetClass: 'exit', scaleFrom: 100000, scaleTo: 75000, fade: true, transition: 'out' } },
  { value: 'exit-wipe', name: '擦除退出', type: 'out', cssClass: 'wipeOut', cssExact: true,
    pptx: { presetId: 22, presetClass: 'exit', presetSubtype: SUB.fromLeft,
      effectFilter: { name: 'wipe', subtype: 'right' }, transition: 'out' } },
  // 近似，和 fly-in 同源：backOutDown 除位移外还有 scale(0.7)，
  // 而且末帧停在 opacity .7 而不是 0 —— 网页上元素是「飞出画布被裁掉」才看不见的
  // （ScreenSlide 有 overflow: hidden 兜底），PPTX 侧是老老实实淡到全透明
  { value: 'exit-fly', name: '飞出', type: 'out', cssClass: 'backOutDown', cssExact: false,
    pptx: { presetId: 2, presetClass: 'exit', motion: 'fromTrace', fade: true, transition: 'out' } },

  { value: 'exit-dissolve', name: '溶解退出', type: 'out', cssClass: 'dissolveOut', cssExact: false,
    pptx: { presetId: 9, presetClass: 'exit', effectFilter: { name: 'dissolve' }, transition: 'out' } },
  { value: 'exit-blinds', name: '百叶窗退出', type: 'out', cssClass: 'blindsOut', cssExact: false,
    pptx: { presetId: 3, presetClass: 'exit', presetSubtype: SUB.horizontal,
      effectFilter: { name: 'blinds', subtype: 'horizontal' }, transition: 'out' } },
  { value: 'exit-circle', name: '圆形收拢', type: 'out', cssClass: 'circleOut', cssExact: true,
    pptx: { presetId: 6, presetClass: 'exit', presetSubtype: SUB.out,
      effectFilter: { name: 'circle', subtype: 'out' }, transition: 'out' } },
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
  group('slide', '滑入', ENTER_DEFS, ['slide-up', 'slide-down', 'slide-left', 'slide-right', 'fly-in']),
  group('zoom', '缩放', ENTER_DEFS, ['scale-in', 'zoom-in', 'spin-in']),
  group('wipe', '擦除', ENTER_DEFS, ['wipe', 'wipe-right', 'wipe-up', 'wipe-down']),
  group('geometry', '几何', ENTER_DEFS, [
    'box-in', 'circle-in', 'diamond-in', 'plus-in', 'wedge-in', 'wheel-in',
  ]),
  group('texture', '分块', ENTER_DEFS, [
    'blinds-h', 'blinds-v', 'checkerboard', 'randombar', 'strips-in', 'dissolve-in',
  ]),
]

export const ATTENTION_ANIMATIONS: AnimationGroup[] = [
  group('pulse', '脉冲', ATTENTION_DEFS, ['pulse-soft', 'pulse', 'pulse-strong']),
  group('growShrink', '缩放强调', ATTENTION_DEFS, ['grow-shrink-soft', 'grow-shrink', 'grow-shrink-strong']),
  group('special', '其他', ATTENTION_DEFS, ['spin', 'blink']),
]

export const EXIT_ANIMATIONS: AnimationGroup[] = [
  group('fade', '淡出', EXIT_DEFS, ['exit-fade', 'exit-dissolve']),
  group('zoom', '缩放', EXIT_DEFS, ['exit-scale', 'exit-zoom', 'exit-circle']),
  group('special', '特殊', EXIT_DEFS, ['exit-wipe', 'exit-blinds', 'exit-fly']),
]

// ---------------------------------------------------------------------------
// 翻页方式
// ---------------------------------------------------------------------------

// 这些是页面切换（Slide.turningMode），网页侧由 PPTist 用 CSS transition 实现，
// 与元素动画是两套东西。PPTX 侧对应 <p:transition>，R-26 已接入导出 ——
// 映射表在 src/utils/ooxml/buildTransitionXml.ts，那里是唯一的翻译处。
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

export const TURNING_MODES: TurningMode[] = SLIDE_ANIMATIONS.map(item => item.value)
