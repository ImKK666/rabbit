/**
 * R-29 · 语义版式引擎（纯函数，无 DB / 无 LLM）
 *
 * 08-expressiveness.md 诊断 ④：全流程没有任何「对称 / 非对称 / 大图压字 / 时间轴 /
 * 对比 / 网格」的概念。Planner 输出的是 `{action, target, detail}` —— 操作步骤，
 * 不是版式。于是每一页都是「文本框 + 背景色」，因为那是唯一被描述过的做法。
 *
 * 这里把「一页长什么样」变成**可选的枚举值**：agent 选版式 + 给内容，
 * 坐标、字号、间距、配色、层次全由代码算。模型再怎么偷懒也偷不出一个歪的版面。
 *
 * ## 为什么是整页替换
 *
 * `applyLayout` 会**清空该页原有元素**再重排。版式的价值来自「所有元素同属一套
 * 网格」，保留半页旧元素就等于保留半页旧网格，两套网格叠在一起比没有网格更糟。
 * 要微调请在 applyLayout 之后用 updateElement。
 *
 * ## 动画也在这里定
 *
 * 每个版式带自己的出场编排（封面用几何、列表用依次、时间轴先画轴线再出节点）。
 * 这是「同一份 deck 里动画有变化」最省力的实现 —— 不同版式天然给出不同动画，
 * agent 不需要额外动脑，也就不会每页都套一个 fade-up。
 *
 * ### R-39 · 出场顺序的三条硬规矩
 *
 * 编排不只是「挑个好看的效果」，它决定观众**先看到什么、后看到什么**。三条：
 *
 * 1. **每个元素都必须挂动画。** 漏挂不是「这个元素不动」，是「它在所有动画之前
 *    就已经在画布上」—— 见 `views/Screen/ScreenElement.vue` 的 `needWaitAnimation`：
 *    查不到动画的元素一律 `visible`。一页里漏挂几个文本，观感就是
 *    「内容直接就在那儿了，然后动画才开始播」。
 * 2. **标题领跑。** 标题（含它的 eyebrow / 章节号）不能排在正文层元素后面。
 * 3. **装饰不单独占步。** 斜块 / 光晕 / 装饰环这类纯装饰跟着它修饰的内容一起出场
 *    （`meantime`），不许自己占一整步排在标题前面 —— 那就是「装饰先出来，正文后出来」。
 *
 * 三条都是机器判据，`lintDeckDesign` 和 `layouts.test.ts` 各查一遍；
 * 逐版式的实际序列用 `npm run layout-order` 打出来看。
 */

import type {
  PPTElement, PPTTextElement, PPTShapeElement, PPTLineElement, PPTImageElement,
  PPTAnimation, SlideBackground, SlideType, AnimationEffect,
} from '@/types/slides'
import { buildShapeGeometry } from '@/configs/shapeCatalog'
import {
  CANVAS_WIDTH, CANVAS_HEIGHT, SAFE, SPACING, TYPE_SCALE, LINE_HEIGHT,
  richText, estimateTextHeight, fitFontSize, mixHex, type Palette,
} from './design'

export const LAYOUT_PATTERNS = [
  'title-center',
  'title-split',
  'section',
  'bullets',
  'cards',
  'compare',
  'timeline',
  'stat',
  'quote',
  'end',
] as const

export type LayoutPattern = typeof LAYOUT_PATTERNS[number]

export interface LayoutItem {
  title?: string
  body?: string
  /** 时间轴 / 步骤条上的标签，如 "2024" 或 "第一步" */
  label?: string
}

export interface LayoutContent {
  /** 标题上方的小标签：章节名、分类、日期 */
  eyebrow?: string
  title?: string
  subtitle?: string
  items?: LayoutItem[]
  /** 单点强调用：{ value: '87%', label: '渗透率' } */
  stat?: { value: string, label?: string, note?: string }
  quote?: string
  /** 引用出处 / 图表来源 */
  source?: string
  /**
   * 配图。**只收 `asset://<sha256>`** —— 图库 URL 不许进 deck（合规要求，
   * 见 `runtime/imageSearch.ts` 头注释），`searchImage` / `generateImage`
   * 返回的就是这个形状。
   *
   * `width` / `height` 是**图片的真实像素**，直接把工具返回值抄进来。
   * 用来算 cover 裁剪 —— 少了就只能拉伸变形。
   */
  image?: { src: string, width?: number, height?: number }
}

/** 版式怎么用这张图 */
export type LayoutImageSlot =
  /** 侧栏／色块位换成图片 */
  | 'panel'
  /** 满屏背景图，上面自动压一层遮罩保证文字可读 */
  | 'backdrop'

export interface LayoutResult {
  elements: PPTElement[]
  animations: PPTAnimation[]
  background: SlideBackground
  slideType: SlideType
}

export interface LayoutMeta {
  pattern: LayoutPattern
  name: string
  /** 什么场合用 —— 进 prompt */
  usage: string
  /** items 数量要求，[min, max]；不吃 items 的版式为 null */
  items: [number, number] | null
  /** 除 title 外必须提供的字段 */
  requires: (keyof LayoutContent)[]
  /**
   * 这个版式**吃不吃 `content.image`**，以及怎么用。`null` = 不吃。
   *
   * 这条会自动进 prompt（`describeLayouts`）—— 第十八轮 D1 上线后，agent
   * 搜了 5 张图、生成了 2 张，**一张都没用上**，就是因为它在整个工作流里
   * 找不到能把图放进去的地方：`applyLayout` 是整页替换语义，而 10 个版式
   * 当时一个图片位都没有。能力存在但没有任何路径够得着，等于不存在。
   */
  image: LayoutImageSlot | null
}

export const LAYOUT_META: Record<LayoutPattern, LayoutMeta> = {
  'title-center': { pattern: 'title-center', name: '居中封面', usage: '封面：标题居中，上下留白最大，最正式', items: null, requires: ['title'], image: 'backdrop' },
  'title-split': { pattern: 'title-split', name: '分栏封面', usage: '封面：左文右色块，比居中封面更现代、更有版面感', items: null, requires: ['title'], image: 'panel' },
  'section': { pattern: 'section', name: '章节转场', usage: '章节之间的过渡页：大章节号 + 章节名', items: null, requires: ['title'], image: 'backdrop' },
  'bullets': { pattern: 'bullets', name: '要点列表', usage: '内容页：3~5 条并列要点，每条一句话说明', items: [2, 6], requires: ['title', 'items'], image: 'panel' },
  'cards': { pattern: 'cards', name: '卡片网格', usage: '内容页：2~4 个并列概念，每个有独立底板，最通用', items: [2, 4], requires: ['title', 'items'], image: null },
  'compare': { pattern: 'compare', name: '二栏对比', usage: '内容页：A vs B、优点 vs 缺点、现状 vs 目标', items: [2, 2], requires: ['title', 'items'], image: null },
  'timeline': { pattern: 'timeline', name: '横向时间轴', usage: '内容页：时间顺序、流程步骤、演进过程', items: [3, 5], requires: ['title', 'items'], image: null },
  'stat': { pattern: 'stat', name: '单点强调', usage: '内容页：一个超大数字或一句结论撑满整页，用来制造节奏停顿', items: null, requires: ['stat'], image: 'backdrop' },
  'quote': { pattern: 'quote', name: '引用语', usage: '内容页：引述一段话 + 出处，同样用来制造节奏', items: null, requires: ['quote'], image: 'backdrop' },
  'end': { pattern: 'end', name: '结尾页', usage: '最后一页：致谢 / 联系方式', items: null, requires: ['title'], image: 'backdrop' },
}

/**
 * cards / compare / timeline **刻意不吃图**。
 *
 * 它们的版面已经被 2~5 个并列块占满，再塞一张图只有两个结果：图被挤成邮票，
 * 或者把条目挤出安全区。「哪一页能放图」是排版决策，不该让模型现场判断 ——
 * 它看不见结果。要配图就换一个吃图的版式，这本身就是有意义的信息。
 */

// ---------------------------------------------------------------------------
// 元素工厂
// ---------------------------------------------------------------------------

interface Box { left: number, top: number, width: number, height: number }

const FONT = 'Microsoft YaHei'

class Builder {
  private n = 0
  readonly elements: PPTElement[] = []
  readonly animations: PPTAnimation[] = []

  constructor(private prefix: string, readonly palette: Palette) {}

  private id(): string {
    return `${this.prefix}_${++this.n}`
  }

  text(
    box: Box,
    content: string,
    opts: {
      size: number
      color: string
      bold?: boolean
      align?: 'left' | 'center' | 'right'
      lineHeight?: number
      letterSpacing?: number
      textType?: PPTTextElement['textType']
      vAlign?: PPTTextElement['vAlign']
      fill?: string
      name?: string
    },
  ): PPTTextElement {
    // 兜底：估高再准也可能被超长内容顶穿，统一夹到画布底边。
    // 溢出的文本在 PPTist 里会照常渲染（文本框不裁剪），但元素框本身
    // 留在画布内，lint 就不会对每一页都报「超出画布」把真警告淹掉。
    const clamped = {
      ...box,
      height: Math.max(16, Math.min(box.height, CANVAS_HEIGHT - box.top - 8)),
    }
    const el: PPTTextElement = {
      id: this.id(),
      type: 'text',
      ...clamped,
      rotate: 0,
      content: richText(content, opts),
      defaultFontName: FONT,
      defaultColor: opts.color,
      lineHeight: opts.lineHeight ?? LINE_HEIGHT.body,
      ...(opts.textType ? { textType: opts.textType } : {}),
      ...(opts.vAlign ? { vAlign: opts.vAlign, fixedHeight: true } : {}),
      ...(opts.fill ? { fill: opts.fill } : {}),
      ...(opts.name ? { name: opts.name } : {}),
    }
    this.elements.push(el)
    return el
  }

  shape(
    shapeKey: string,
    box: Box,
    opts: {
      fill: string
      opacity?: number
      outline?: PPTShapeElement['outline']
      shadow?: PPTShapeElement['shadow']
      rotate?: number
      name?: string
    },
  ): PPTShapeElement | null {
    const geometry = buildShapeGeometry(shapeKey, box.width, box.height)
    if (!geometry) return null

    const el: PPTShapeElement = {
      id: this.id(),
      type: 'shape',
      ...box,
      rotate: opts.rotate ?? 0,
      viewBox: geometry.viewBox,
      path: geometry.path,
      // 目录里标了等比的（圆、正多边形、图标）要带下去，否则用户一拖就变形
      fixedRatio: geometry.fixedRatio,
      fill: opts.fill,
      ...(geometry.pathFormula ? { pathFormula: geometry.pathFormula } : {}),
      ...(geometry.keypoints ? { keypoints: geometry.keypoints } : {}),
      ...(opts.opacity !== undefined ? { opacity: opts.opacity } : {}),
      ...(opts.outline ? { outline: opts.outline } : {}),
      ...(opts.shadow ? { shadow: opts.shadow } : {}),
      ...(opts.name ? { name: opts.name } : {}),
    }
    this.elements.push(el)
    return el
  }

  /**
   * 放一张图，按 cover 裁剪填满 box。
   *
   * **必须在别的元素之前调用** —— PPTist 的层级就是数组顺序，图片是底板，
   * 排在文字后面会把整页盖住。所以吃图的版式都在函数第一行处理它。
   */
  image(
    box: Box,
    image: { src: string, width?: number, height?: number },
    opts: { imageType?: 'pageFigure' | 'background', name?: string } = {},
  ): PPTImageElement {
    const clip = coverClip(box.width, box.height, image.width, image.height)
    const el: PPTImageElement = {
      id: this.id(),
      type: 'image',
      ...box,
      rotate: 0,
      src: image.src,
      // cover 裁剪过就不能再让编辑器锁比例，否则拖动时会跳
      fixedRatio: !clip,
      ...(clip ? { clip } : {}),
      ...(opts.imageType ? { imageType: opts.imageType } : {}),
      ...(opts.name ? { name: opts.name } : {}),
    }
    this.elements.push(el)
    return el
  }

  /**
   * 满屏背景图 + 遮罩。返回 `[图, 遮罩]`，都可能为 null（没给图时）。
   *
   * **遮罩不是可选项。** 照片背后压文字，对比度几乎必然不合格 ——
   * 而 `lintDeck` 只检查纯色背景与文字的对比度，它看不见照片，
   * 于是「一页字全糊在图上」会安安静静地通过所有检查。
   * 用背景色本身当遮罩（而不是纯黑/纯白），主题换了它自动跟着换。
   */
  backdrop(
    image: { src: string, width?: number, height?: number } | undefined,
  ): [PPTImageElement | null, PPTShapeElement | null] {
    if (!image?.src) return [null, null]
    const p = this.palette
    const img = this.image(
      { left: 0, top: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
      image,
      { imageType: 'background', name: '背景图' },
    )
    // 深色主题的图往往更压不住，遮罩给厚一点
    const scrim = this.shape('rect', { left: 0, top: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT }, {
      fill: p.background, opacity: p.dark ? 0.78 : 0.82, name: '背景遮罩',
    })
    return [img, scrim]
  }

  line(start: [number, number], end: [number, number], left: number, top: number, color: string, width = 1): PPTLineElement {
    const el: PPTLineElement = {
      id: this.id(),
      type: 'line',
      left,
      top,
      start,
      end,
      style: 'solid',
      color,
      points: ['', ''],
      width,
    }
    this.elements.push(el)
    return el
  }

  /**
   * 挂动画。
   *
   * `el` 为 null 时静默跳过 —— 版式里大量元素是条件创建的（没有 subtitle 就没有
   * 那个文本框），调用方不必每处都写 if。代价是**领跑的那条也可能被跳过**，
   * 于是第一条实际落地的动画未必带着调用方写的 `click`：这里兜底改成 click，
   * 保证整页时间线永远从一个点击步开始，而不是「进页就自动播一半」。
   */
  animate(el: PPTElement | null, effect: AnimationEffect, trigger: PPTAnimation['trigger'], duration = 600) {
    if (!el) return
    this.animations.push({
      id: `${this.prefix}_a${this.animations.length + 1}`,
      elId: el.id,
      effect,
      type: 'in',
      duration,
      trigger: this.animations.length === 0 ? 'click' : trigger,
    })
  }
}

/**
 * cover 裁剪：把原图居中裁到目标框的比例，`clip.range` 是百分比坐标。
 *
 * 拿不到原图宽高就返回 `null`（调用方改用 `fixedRatio` 让编辑器自己等比缩）——
 * **不猜一个比例**：猜错的表现是图被拉变形，而变形比留白难看得多，
 * 且没有任何检查能发现它。
 *
 * 纯函数，导出是为了单测能钉住算术。
 */
export const coverClip = (
  boxW: number, boxH: number, srcW?: number, srcH?: number,
): { shape: 'rect', range: [[number, number], [number, number]] } | null => {
  if (!srcW || !srcH || !boxW || !boxH) return null

  const boxRatio = boxW / boxH
  const srcRatio = srcW / srcH
  // 比例一致就不用裁 —— 裁一个 0% 出来只是给 deck 添一份无意义的数据
  if (Math.abs(boxRatio - srcRatio) < 0.001) return null

  // 原图更宽 → 左右各切掉一条；更高 → 上下各切掉一条
  const [x0, y0, x1, y1] = srcRatio > boxRatio
    ? [(1 - boxRatio / srcRatio) / 2, 0, 1 - (1 - boxRatio / srcRatio) / 2, 1]
    : [0, (1 - srcRatio / boxRatio) / 2, 1, 1 - (1 - srcRatio / boxRatio) / 2]

  const pct = (v: number) => Math.round(v * 1000) / 10
  return { shape: 'rect', range: [[pct(x0), pct(y0)], [pct(x1), pct(y1)]] }
}

/** 封面大标题的候选字号：从 display 往下退，长标题自动降一级而不是溢出 */
const DISPLAY_STEPS = [TYPE_SCALE.display, 52, 44, TYPE_SCALE.title, TYPE_SCALE.subtitle]

/** 卡片底板的统一质感：轻描边 + 轻阴影，深色主题下阴影更深 */
const cardDecor = (p: Palette) => ({
  outline: { style: 'solid' as const, width: 1, color: p.border },
  shadow: { h: 0, v: 4, blur: 12, color: p.dark ? '#00000066' : '#0000001f' },
})

const clampItems = (items: LayoutItem[] | undefined, min: number, max: number): LayoutItem[] =>
  (items ?? []).slice(0, max).concat(
    Array.from({ length: Math.max(0, min - (items?.length ?? 0)) }, () => ({} as LayoutItem)),
  )

// ---------------------------------------------------------------------------
// 版式实现
// ---------------------------------------------------------------------------

type LayoutFn = (b: Builder, c: LayoutContent) => { background: SlideBackground, slideType: SlideType }

const LAYOUTS: Record<LayoutPattern, LayoutFn> = {
  // 居中封面：装饰性斜切块压在角落，标题居中，下方一道强调条
  'title-center': (b, c) => {
    const p = b.palette

    // 背景图必须最先放：PPTist 的层级就是数组顺序
    const [bgImage, scrim] = b.backdrop(c.image)

    const stripe = b.shape('diagStripe', { left: CANVAS_WIDTH - 320, top: 0, width: 320, height: 300 }, {
      fill: p.primary, opacity: 0.14, name: '装饰斜块',
    })
    const stripe2 = b.shape('diagStripe', { left: 0, top: CANVAS_HEIGHT - 220, width: 260, height: 220 }, {
      fill: p.accent, opacity: 0.1, rotate: 180, name: '装饰斜块',
    })

    let y = 176
    let eyebrow: PPTElement | null = null
    if (c.eyebrow) {
      eyebrow = b.text({ left: SAFE.left, top: y, width: SAFE.width, height: 24 }, c.eyebrow, {
        size: TYPE_SCALE.eyebrow, color: p.accent, bold: true, align: 'center',
        letterSpacing: 2, lineHeight: LINE_HEIGHT.tight, textType: 'header',
      })
      y += 34
    }

    const titleSize = fitFontSize(c.title ?? '', SAFE.width, 190, DISPLAY_STEPS)
    const titleH = estimateTextHeight(c.title ?? '', titleSize, SAFE.width, LINE_HEIGHT.heading)
    const title = b.text({ left: SAFE.left, top: y, width: SAFE.width, height: titleH }, c.title ?? '', {
      size: titleSize, color: p.text, bold: true, align: 'center',
      lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })
    y += titleH + SPACING.headingGap

    const bar = b.shape('bar', { left: (CANVAS_WIDTH - 96) / 2, top: y, width: 96, height: 16 }, {
      fill: p.accent, name: '强调条',
    })
    y += 16 + SPACING.headingGap

    let subtitle: PPTElement | null = null
    if (c.subtitle) {
      subtitle = b.text(
        { left: SAFE.left + 80, top: y, width: SAFE.width - 160, height: estimateTextHeight(c.subtitle, TYPE_SCALE.subtitle, SAFE.width - 160) },
        c.subtitle,
        { size: TYPE_SCALE.subtitle, color: p.textMuted, align: 'center', textType: 'subtitle' },
      )
    }

    // 封面用几何效果开场，和内容页的 fade/slide 拉开距离。
    // 但斜块是装饰，不能自己占一步排在标题前面 —— 和标题同步擦入，
    // 「几何开场」的观感一点不少，标题却是第一个立住的东西
    b.animate(title, 'circle-in', 'click', 800)
    b.animate(eyebrow, 'fade', 'meantime', 400)
    b.animate(stripe, 'wipe-down', 'meantime', 700)
    b.animate(stripe2, 'wipe-up', 'meantime', 700)
    b.animate(bar, 'wipe', 'auto', 500)
    b.animate(subtitle, 'fade-up', 'auto', 500)
    // 背景图和遮罩是舞台不是内容，跟标题同步铺开，不单独占一步
    b.animate(bgImage, 'fade', 'meantime', 800)
    b.animate(scrim, 'fade', 'meantime', 800)

    return { background: { type: 'solid', color: p.background }, slideType: 'cover' }
  },

  // 分栏封面：右侧整块主色，左侧文字。给了图就用图顶掉那块主色
  'title-split': (b, c) => {
    const p = b.palette
    const splitX = 600
    const panelBox = { left: splitX, top: 0, width: CANVAS_WIDTH - splitX, height: CANVAS_HEIGHT }

    // 图直接顶掉主色块 —— 不是叠在上面：叠的话主色块永远看不见，
    // 白白多一个元素，用户想换回纯色还得先删图
    const panel = c.image?.src
      ? b.image(panelBox, c.image, { imageType: 'pageFigure', name: '封面图' })
      : b.shape('rect', panelBox, { fill: p.primary, name: '主色块' })
    const panelAccent = b.shape('rect', { left: splitX, top: 0, width: 10, height: CANVAS_HEIGHT }, {
      fill: p.accent, name: '分界线',
    })
    // 装饰环是给**纯色块**加质感用的。照片自带纹理，再叠一个半透明圆环
    // 只会像块污渍 —— 实测截图上一眼就看出来了
    const mark = c.image?.src
      ? null
      : b.shape('donut', { left: splitX + 96, top: 180, width: 200, height: 200 }, {
        fill: mixHex(p.primary, p.onPrimary, 0.28), name: '装饰环',
      })

    const colW = splitX - SAFE.left - SPACING.gutter
    let y = 170
    let eyebrow: PPTElement | null = null
    if (c.eyebrow) {
      eyebrow = b.text({ left: SAFE.left, top: y, width: colW, height: 22 }, c.eyebrow, {
        size: TYPE_SCALE.eyebrow, color: p.accent, bold: true, letterSpacing: 2,
        lineHeight: LINE_HEIGHT.tight, textType: 'header',
      })
      y += 32
    }

    const titleSize = fitFontSize(c.title ?? '', colW, 210, DISPLAY_STEPS)
    const titleH = estimateTextHeight(c.title ?? '', titleSize, colW, LINE_HEIGHT.heading)
    const title = b.text({ left: SAFE.left, top: y, width: colW, height: titleH }, c.title ?? '', {
      size: titleSize, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })
    y += titleH + SPACING.headingGap

    const bar = b.shape('bar', { left: SAFE.left, top: y, width: 72, height: 12 }, { fill: p.accent, name: '强调条' })
    y += 12 + SPACING.headingGap

    let subtitle: PPTElement | null = null
    if (c.subtitle) {
      subtitle = b.text(
        { left: SAFE.left, top: y, width: colW, height: estimateTextHeight(c.subtitle, TYPE_SCALE.subtitle, colW) },
        c.subtitle,
        { size: TYPE_SCALE.subtitle, color: p.textMuted, textType: 'subtitle' },
      )
    }

    // 主色块是舞台不是内容 —— 和标题同时铺开。装饰环挪到最后，
    // 跟着副标题一起点出来（原来它在标题之前，等于让一个圆环抢了封面的第一眼）
    b.animate(title, 'fade-left', 'click', 600)
    b.animate(eyebrow, 'fade-left', 'meantime', 400)
    b.animate(panel, 'wipe-right', 'meantime', 700)
    b.animate(panelAccent, 'wipe-down', 'meantime', 700)
    b.animate(bar, 'wipe', 'auto', 400)
    b.animate(subtitle, 'fade-left', 'auto', 500)
    b.animate(mark, 'zoom-in', 'meantime', 600)

    return { background: { type: 'solid', color: p.background }, slideType: 'cover' }
  },

  // 章节转场：巨大的章节号压在左侧，标题贴着它
  'section': (b, c) => {
    const p = b.palette
    const number = c.eyebrow || '01'

    const [bgImage, scrim] = b.backdrop(c.image)

    const num = b.text({ left: SAFE.left, top: 150, width: 260, height: 180 }, number, {
      size: TYPE_SCALE.stat, color: p.accent, bold: true, lineHeight: LINE_HEIGHT.tight,
      textType: 'partNumber', name: '章节号',
    })

    const rule = b.line([0, 0], [0, 180], SAFE.left + 280, 150, p.border, 2)

    const titleSize = fitFontSize(c.title ?? '', SAFE.width - 340, 180, [TYPE_SCALE.title, TYPE_SCALE.subtitle, TYPE_SCALE.itemTitle])
    const titleH = estimateTextHeight(c.title ?? '', titleSize, SAFE.width - 340, LINE_HEIGHT.heading)
    const title = b.text(
      { left: SAFE.left + 316, top: 160, width: SAFE.width - 316, height: titleH },
      c.title ?? '',
      { size: titleSize, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title' },
    )

    let subtitle: PPTElement | null = null
    if (c.subtitle) {
      subtitle = b.text(
        { left: SAFE.left + 316, top: 160 + titleH + SPACING.paragraphGap, width: SAFE.width - 316, height: estimateTextHeight(c.subtitle, TYPE_SCALE.body, SAFE.width - 316) },
        c.subtitle,
        { size: TYPE_SCALE.body, color: p.textMuted, textType: 'content' },
      )
    }

    // 章节号是这一页的主角（partNumber 属于标题块），它领跑；
    // 竖线只是号与题之间的分隔，跟着章节号一起画出来，不单独占一步
    b.animate(num, 'wedge-in', 'click', 800)
    b.animate(rule, 'wipe-down', 'meantime', 500)
    b.animate(title, 'fade-left', 'auto', 500)
    b.animate(subtitle, 'fade-left', 'auto', 400)
    b.animate(bgImage, 'fade', 'meantime', 800)
    b.animate(scrim, 'fade', 'meantime', 800)

    return { background: { type: 'solid', color: p.background }, slideType: 'transition' }
  },

  // 要点列表：标题带竖强调条，每条要点前一个圆点序号
  'bullets': (b, c) => {
    const p = b.palette
    const items = clampItems(c.items, 2, 6)

    /**
     * 给了图就让出右侧 40%，整页文字缩进左栏；没给图则一切照旧。
     *
     * 图**贴着右边和上下出血**（不留白边）：一张四周留白的照片在版面里
     * 会显得像贴纸，出血才是版面感的来源。
     */
    const hasImage = !!c.image?.src
    const figureW = Math.round(CANVAS_WIDTH * 0.4)
    const colW = hasImage ? CANVAS_WIDTH - figureW - SAFE.left - SPACING.gutter : SAFE.width

    const figure = hasImage
      ? b.image(
        { left: CANVAS_WIDTH - figureW, top: 0, width: figureW, height: CANVAS_HEIGHT },
        c.image!,
        { imageType: 'pageFigure', name: '配图' },
      )
      : null

    const accentBar = b.shape('bar', { left: SAFE.left, top: SAFE.top + 6, width: 8, height: 40 }, {
      fill: p.accent, rotate: 90, name: '标题强调条',
    })
    const title = b.text(
      { left: SAFE.left + 28, top: SAFE.top, width: colW - 28, height: 52 },
      c.title ?? '', { size: TYPE_SCALE.title, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title' },
    )

    let y = SAFE.top + 52 + SPACING.headingGap
    let subtitle: PPTElement | null = null
    if (c.subtitle) {
      const h = estimateTextHeight(c.subtitle, TYPE_SCALE.body, colW - 28)
      subtitle = b.text({ left: SAFE.left + 28, top: y, width: colW - 28, height: h }, c.subtitle, {
        size: TYPE_SCALE.body, color: p.textMuted, textType: 'content',
      })
      y += h + SPACING.paragraphGap
    }

    const available = SAFE.bottom - y
    const rowGap = SPACING.paragraphGap
    const rowH = Math.max(48, (available - rowGap * (items.length - 1)) / items.length)
    const markerSize = Math.min(30, rowH * 0.5)

    b.animate(title, 'fade-left', 'click', 500)
    b.animate(accentBar, 'wipe-down', 'meantime', 400)
    // 配图跟标题同步擦入 —— 它是版面的一半，不该等要点讲完才出现。
    // 图在右侧，用「自右擦除」朝画面内推，方向和它的位置一致
    b.animate(figure, 'wipe-right', 'meantime', 700)
    b.animate(subtitle, 'fade-up', 'auto', 400)

    items.forEach((item, i) => {
      const top = y + i * (rowH + rowGap)
      const marker = b.shape('ellipse', { left: SAFE.left, top: top + 4, width: markerSize, height: markerSize }, {
        fill: i === 0 ? p.accent : p.primary, name: `序号 ${i + 1}`,
      })
      // 数字压在圆点上，两者必须同一步出场 —— 圆点飞入而数字早就在那儿，
      // 看着就是「数字浮在半空等圆点来接」
      const markerNum = b.text({ left: SAFE.left, top: top + 4, width: markerSize, height: markerSize }, String(i + 1), {
        size: TYPE_SCALE.caption, color: p.onPrimary, bold: true, align: 'center',
        lineHeight: LINE_HEIGHT.tight, vAlign: 'middle', textType: 'itemNumber',
      })

      const textLeft = SAFE.left + markerSize + SPACING.paragraphGap
      const textWidth = colW - markerSize - SPACING.paragraphGap
      const head = b.text({ left: textLeft, top, width: textWidth, height: 26 }, item.title ?? '', {
        size: TYPE_SCALE.itemTitle, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'itemTitle',
      })
      let body: PPTElement | null = null
      if (item.body) {
        body = b.text(
          { left: textLeft, top: top + 28, width: textWidth, height: Math.max(22, rowH - 28) },
          item.body,
          { size: TYPE_SCALE.body, color: p.textMuted, textType: 'item' },
        )
      }

      b.animate(marker, 'zoom-in', i === 0 ? 'click' : 'auto', 400)
      b.animate(markerNum, 'zoom-in', 'meantime', 400)
      b.animate(head, 'fade-left', 'meantime', 400)
      b.animate(body, 'fade-left', 'meantime', 400)
    })

    return { background: { type: 'solid', color: p.background }, slideType: 'content' }
  },

  // 卡片网格：2~4 栏等宽卡片，每张带序号标签
  'cards': (b, c) => {
    const p = b.palette
    const items = clampItems(c.items, 2, 4)
    const n = items.length

    const title = b.text({ left: SAFE.left, top: SAFE.top, width: SAFE.width, height: 52 }, c.title ?? '', {
      size: TYPE_SCALE.title, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })
    const bar = b.shape('bar', { left: SAFE.left, top: SAFE.top + 56, width: 64, height: 10 }, {
      fill: p.accent, name: '强调条',
    })

    let y = SAFE.top + 56 + 10 + SPACING.headingGap
    let subtitle: PPTElement | null = null
    if (c.subtitle) {
      const h = estimateTextHeight(c.subtitle, TYPE_SCALE.body, SAFE.width)
      subtitle = b.text({ left: SAFE.left, top: y, width: SAFE.width, height: h }, c.subtitle, {
        size: TYPE_SCALE.body, color: p.textMuted, textType: 'content',
      })
      y += h + SPACING.paragraphGap
    }

    const gap = SPACING.gutter
    const cardW = (SAFE.width - gap * (n - 1)) / n
    const cardH = SAFE.bottom - y
    const pad = SPACING.cardPadding

    b.animate(title, 'fade-down', 'click', 500)
    b.animate(bar, 'wipe', 'meantime', 400)
    b.animate(subtitle, 'fade-up', 'auto', 400)

    items.forEach((item, i) => {
      const left = SAFE.left + i * (cardW + gap)
      const card = b.shape('roundRect', { left, top: y, width: cardW, height: cardH }, {
        fill: p.surface, ...cardDecor(p), name: `卡片 ${i + 1}`,
      })

      const tag = b.shape('pill', { left: left + pad, top: y + pad, width: 44, height: 24 }, {
        fill: i === 0 ? p.accent : p.primary, name: `编号 ${i + 1}`,
      })
      const tagNum = b.text({ left: left + pad, top: y + pad, width: 44, height: 24 }, String(i + 1).padStart(2, '0'), {
        size: TYPE_SCALE.caption, color: p.onPrimary, bold: true, align: 'center',
        lineHeight: LINE_HEIGHT.tight, vAlign: 'middle', textType: 'itemNumber',
      })

      const innerW = cardW - pad * 2
      const headTop = y + pad + 24 + SPACING.paragraphGap
      const headH = estimateTextHeight(item.title ?? '', TYPE_SCALE.itemTitle, innerW, LINE_HEIGHT.heading)
      const head = b.text({ left: left + pad, top: headTop, width: innerW, height: headH }, item.title ?? '', {
        size: TYPE_SCALE.itemTitle, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'itemTitle',
      })

      let body: PPTElement | null = null
      if (item.body) {
        const bodyTop = headTop + headH + SPACING.paragraphGap / 2
        body = b.text(
          { left: left + pad, top: bodyTop, width: innerW, height: Math.max(24, y + cardH - pad - bodyTop) },
          item.body,
          { size: TYPE_SCALE.body, color: p.textMuted, textType: 'item' },
        )
      }

      // 一张卡片是一个整体：底板、编号、标题、正文同一步出场。
      // 原来只动底板和编号，卡片里的文字从头到尾都在 —— 底板淡入等于
      // 「一块板子从早就摆好的文字底下升上来」，恰好是最扎眼的那种穿帮
      b.animate(card, 'fade-up', i === 0 ? 'click' : 'auto', 500)
      b.animate(tag, 'zoom-in', 'meantime', 400)
      b.animate(tagNum, 'zoom-in', 'meantime', 400)
      b.animate(head, 'fade-up', 'meantime', 400)
      b.animate(body, 'fade-up', 'meantime', 400)
    })

    return { background: { type: 'solid', color: p.background }, slideType: 'content' }
  },

  // 二栏对比：左右两块不同底色，中间一条分界线
  'compare': (b, c) => {
    const p = b.palette
    const items = clampItems(c.items, 2, 2)

    const title = b.text({ left: SAFE.left, top: SAFE.top, width: SAFE.width, height: 52 }, c.title ?? '', {
      size: TYPE_SCALE.title, color: p.text, bold: true, align: 'center', lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })

    const y = SAFE.top + 52 + SPACING.headingGap
    const colH = SAFE.bottom - y
    const gap = SPACING.gutter * 2
    const colW = (SAFE.width - gap) / 2
    const pad = SPACING.cardPadding
    const fills = [mixHex(p.background, p.primary, 0.14), mixHex(p.background, p.accent, 0.14)]
    const heads = [p.primary, p.accent]

    const divider = b.line([0, 0], [0, colH], CANVAS_WIDTH / 2, y, p.border, 2)

    // 元素先全部建出来再统一编排 —— 这一页的节奏是「两栏一起动」，
    // 在 forEach 里边建边挂会把左右两栏的动画交叉排进序列，编排读不出来
    const cols = items.map((item, i) => {
      const left = SAFE.left + i * (colW + gap)
      const panel = b.shape('roundRect', { left, top: y, width: colW, height: colH }, {
        fill: fills[i], outline: { style: 'solid', width: 1, color: p.border }, name: `对比栏 ${i + 1}`,
      })

      const headH = 34
      const underline = b.shape('bar', { left: left + pad, top: y + pad + headH + 4, width: 40, height: 8 }, {
        fill: heads[i], name: `栏 ${i + 1} 下划条`,
      })
      const head = b.text({ left: left + pad, top: y + pad, width: colW - pad * 2, height: headH }, item.title ?? '', {
        size: TYPE_SCALE.subtitle, color: heads[i], bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'itemTitle',
      })

      let body: PPTElement | null = null
      if (item.body) {
        const bodyTop = y + pad + headH + 8 + SPACING.headingGap
        body = b.text(
          { left: left + pad, top: bodyTop, width: colW - pad * 2, height: Math.max(24, y + colH - pad - bodyTop) },
          item.body,
          { size: TYPE_SCALE.body, color: p.text, textType: 'item' },
        )
      }

      return { panel, underline, head, body }
    })

    // 三拍：标题 → 两块底板从各自外侧擦入（对比感来自方向本身）→ 两栏文字一起落
    b.animate(title, 'fade-down', 'click', 500)

    cols.forEach((col, i) => {
      b.animate(col.panel, i === 0 ? 'wipe' : 'wipe-right', i === 0 ? 'click' : 'meantime', 600)
    })
    b.animate(divider, 'wipe-down', 'meantime', 500)

    cols.forEach((col, i) => {
      b.animate(col.head, 'fade-down', i === 0 ? 'auto' : 'meantime', 400)
      b.animate(col.underline, 'wipe', 'meantime', 300)
      b.animate(col.body, 'fade-up', 'meantime', 400)
    })

    return { background: { type: 'solid', color: p.background }, slideType: 'content' }
  },

  // 横向时间轴：一条轴线 + 等距节点，标签在轴下
  'timeline': (b, c) => {
    const p = b.palette
    const items = clampItems(c.items, 3, 5)
    const n = items.length

    const title = b.text({ left: SAFE.left, top: SAFE.top, width: SAFE.width, height: 52 }, c.title ?? '', {
      size: TYPE_SCALE.title, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })
    const bar = b.shape('bar', { left: SAFE.left, top: SAFE.top + 56, width: 64, height: 10 }, {
      fill: p.accent, name: '强调条',
    })

    const axisY = 300
    const nodeSize = 24
    const colW = SAFE.width / n
    const axis = b.shape('bar', { left: SAFE.left, top: axisY - 6, width: SAFE.width, height: 12 }, {
      fill: p.border, name: '时间轴',
    })

    b.animate(title, 'fade-down', 'click', 500)
    b.animate(bar, 'wipe', 'meantime', 400)
    b.animate(axis, 'wipe', 'auto', 700)

    items.forEach((item, i) => {
      const centerX = SAFE.left + colW * (i + 0.5)

      const node = b.shape('ellipse', { left: centerX - nodeSize / 2, top: axisY - nodeSize / 2, width: nodeSize, height: nodeSize }, {
        fill: i === 0 ? p.accent : p.primary, name: `节点 ${i + 1}`,
      })

      // 标签在轴上方，正文在轴下方 —— 上下分置比全塞一边更好读
      const label = b.text(
        { left: centerX - colW / 2 + 8, top: axisY - 76, width: colW - 16, height: 40 },
        item.label ?? item.title ?? '',
        { size: TYPE_SCALE.subtitle, color: p.text, bold: true, align: 'center', lineHeight: LINE_HEIGHT.tight, textType: 'itemTitle' },
      )

      const bodyText = item.label ? [item.title, item.body].filter(Boolean).join('\n') : (item.body ?? '')
      const body = bodyText
        ? b.text(
          { left: centerX - colW / 2 + 8, top: axisY + 32, width: colW - 16, height: SAFE.bottom - axisY - 32 },
          bodyText,
          { size: TYPE_SCALE.body, color: p.textMuted, align: 'center', textType: 'item' },
        )
        : null

      // 每个节点自成一步（auto 依次接续），标签与正文跟着自己那个节点一起出
      b.animate(node, 'zoom-in', 'auto', 350)
      b.animate(label, 'fade-down', 'meantime', 350)
      b.animate(body, 'fade-up', 'meantime', 350)
    })

    return { background: { type: 'solid', color: p.background }, slideType: 'content' }
  },

  // 单点强调：一个超大数字撑满整页
  'stat': (b, c) => {
    const p = b.palette
    const stat = c.stat ?? { value: '' }

    const [bgImage, scrim] = b.backdrop(c.image)

    // 装饰元素也要留在画布内 —— 出血一点点在网页上看不出来，
    // 但 lintSlide 会对每一页报「超出画布」，把真正的越界警告淹掉
    const halo = b.shape('ellipse', { left: 600, top: 60, width: 400, height: 400 }, {
      fill: p.primary, opacity: 0.12, name: '装饰光晕',
    })

    let y = 150
    let eyebrow: PPTElement | null = null
    if (c.eyebrow || c.title) {
      eyebrow = b.text({ left: SAFE.left, top: y, width: SAFE.width - 300, height: 24 }, c.eyebrow || c.title || '', {
        size: TYPE_SCALE.eyebrow, color: p.accent, bold: true, letterSpacing: 2,
        lineHeight: LINE_HEIGHT.tight, textType: 'header',
      })
      y += 36
    }

    const value = b.text({ left: SAFE.left, top: y, width: SAFE.width - 300, height: 120 }, stat.value, {
      size: TYPE_SCALE.stat, color: p.primary, bold: true, lineHeight: LINE_HEIGHT.tight, textType: 'title',
      name: '关键数字',
    })
    y += 120 + SPACING.paragraphGap / 2

    let label: PPTElement | null = null
    if (stat.label) {
      label = b.text({ left: SAFE.left, top: y, width: SAFE.width - 300, height: 34 }, stat.label, {
        size: TYPE_SCALE.subtitle, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'subtitle',
      })
      y += 34 + SPACING.paragraphGap
    }

    const barEl = b.shape('bar', { left: SAFE.left, top: y, width: 72, height: 10 }, { fill: p.accent, name: '强调条' })
    y += 10 + SPACING.paragraphGap

    let note: PPTElement | null = null
    if (stat.note || c.subtitle) {
      const noteText = stat.note || c.subtitle || ''
      note = b.text(
        { left: SAFE.left, top: y, width: SAFE.width - 300, height: estimateTextHeight(noteText, TYPE_SCALE.body, SAFE.width - 300) },
        noteText,
        { size: TYPE_SCALE.body, color: p.textMuted, textType: 'content' },
      )
    }

    // 这一页的主角就是那个数字，它必须是第一眼。
    // 光晕是它的背景，同步张开；eyebrow 是它的小标签，一起来
    b.animate(value, 'blinds-v', 'click', 800)
    b.animate(eyebrow, 'fade-left', 'meantime', 400)
    b.animate(halo, 'zoom-in', 'meantime', 800)
    b.animate(label, 'fade-up', 'auto', 400)
    b.animate(barEl, 'wipe', 'meantime', 400)
    b.animate(note, 'fade-up', 'auto', 400)
    b.animate(bgImage, 'fade', 'meantime', 800)
    b.animate(scrim, 'fade', 'meantime', 800)

    return { background: { type: 'solid', color: p.background }, slideType: 'content' }
  },

  // 引用语：巨大的引号 + 一段话 + 出处
  'quote': (b, c) => {
    const p = b.palette

    const [bgImage, scrim] = b.backdrop(c.image)

    const mark = b.text({ left: SAFE.left - 8, top: 110, width: 120, height: 120 }, '“', {
      size: 140, color: p.accent, bold: true, lineHeight: LINE_HEIGHT.tight, name: '引号',
    })

    const quoteText = c.quote ?? ''
    const quoteW = SAFE.width - 120
    // 引述长度完全不可控，字号跟着内容走：短句撑满，长段自动降级
    const quoteSize = fitFontSize(quoteText, quoteW, 260, [
      TYPE_SCALE.title, TYPE_SCALE.subtitle, TYPE_SCALE.itemTitle, TYPE_SCALE.body,
    ])
    const quoteH = Math.min(260, estimateTextHeight(quoteText, quoteSize, quoteW, LINE_HEIGHT.heading))
    const quote = b.text({ left: SAFE.left + 96, top: 160, width: quoteW, height: quoteH }, quoteText, {
      size: quoteSize, color: p.text, lineHeight: LINE_HEIGHT.heading, textType: 'content',
    })

    const y = 160 + quoteH + SPACING.headingGap
    const rule = b.shape('bar', { left: SAFE.left + 96, top: y, width: 48, height: 8 }, { fill: p.border, name: '分隔条' })

    const source = c.source || c.subtitle
      ? b.text({ left: SAFE.left + 160, top: y - 6, width: SAFE.width - 220, height: 28 }, c.source || c.subtitle || '', {
        size: TYPE_SCALE.body, color: p.textMuted, textType: 'footer',
      })
      : null

    b.animate(mark, 'zoom-in', 'click', 600)
    b.animate(quote, 'fade-up', 'auto', 700)
    b.animate(rule, 'wipe', 'auto', 400)
    b.animate(source, 'fade-left', 'meantime', 400)
    b.animate(bgImage, 'fade', 'meantime', 800)
    b.animate(scrim, 'fade', 'meantime', 800)

    return { background: { type: 'solid', color: p.background }, slideType: 'content' }
  },

  // 结尾页：居中致谢
  'end': (b, c) => {
    const p = b.palette

    const [bgImage, scrim] = b.backdrop(c.image)

    const ring = b.shape('donut', { left: (CANVAS_WIDTH - 260) / 2, top: 120, width: 260, height: 260 }, {
      fill: p.primary, opacity: 0.12, name: '装饰环',
    })

    const titleSize = fitFontSize(c.title ?? '', SAFE.width, 140, DISPLAY_STEPS)
    const titleH = estimateTextHeight(c.title ?? '', titleSize, SAFE.width, LINE_HEIGHT.heading)
    const title = b.text({ left: SAFE.left, top: 210, width: SAFE.width, height: titleH }, c.title ?? '', {
      size: titleSize, color: p.text, bold: true, align: 'center',
      lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })

    const bar = b.shape('bar', { left: (CANVAS_WIDTH - 72) / 2, top: 210 + titleH + SPACING.headingGap, width: 72, height: 12 }, {
      fill: p.accent, name: '强调条',
    })

    const subtitle = c.subtitle
      ? b.text(
        { left: SAFE.left, top: 210 + titleH + SPACING.headingGap + 12 + SPACING.headingGap, width: SAFE.width, height: estimateTextHeight(c.subtitle, TYPE_SCALE.subtitle, SAFE.width) },
        c.subtitle,
        { size: TYPE_SCALE.subtitle, color: p.textMuted, align: 'center', textType: 'subtitle' },
      )
      : null

    // 装饰环绕着标题转起来，不是绕着一页空白转起来
    b.animate(title, 'scale-in', 'click', 600)
    b.animate(ring, 'spin-in', 'meantime', 800)
    b.animate(bar, 'wipe', 'auto', 400)
    b.animate(subtitle, 'fade-up', 'auto', 400)
    b.animate(bgImage, 'fade', 'meantime', 800)
    b.animate(scrim, 'fade', 'meantime', 800)

    return { background: { type: 'solid', color: p.background }, slideType: 'end' }
  },
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export const isLayoutPattern = (v: unknown): v is LayoutPattern =>
  typeof v === 'string' && (LAYOUT_PATTERNS as readonly string[]).includes(v)

/** 内容够不够撑起这个版式 —— 缺内容时给出可执行的错误信息，而不是排出一页空框 */
export const validateLayoutContent = (pattern: LayoutPattern, content: LayoutContent): string | null => {
  const meta = LAYOUT_META[pattern]

  for (const field of meta.requires) {
    const value = content[field]
    if (field === 'items') continue
    if (field === 'stat' && (!content.stat || !content.stat.value?.trim())) {
      return `版式 "${pattern}" 需要 stat.value（要强调的那个数字或短句）`
    }
    if (field !== 'stat' && (typeof value !== 'string' || !value.trim())) {
      return `版式 "${pattern}" 需要 ${field}`
    }
  }

  if (meta.items) {
    const [min, max] = meta.items
    const n = content.items?.length ?? 0
    if (n < min || n > max) {
      return `版式 "${pattern}" 需要 ${min}~${max} 个 items，收到 ${n} 个`
    }
    const empty = (content.items ?? []).findIndex(it => !it.title?.trim() && !it.body?.trim() && !it.label?.trim())
    if (empty !== -1) return `items[${empty}] 是空的，每一项至少要有 title 或 body`
  }

  if (content.image?.src) {
    if (!meta.image) {
      // 静默忽略是最糟的处置：模型花了 15 秒生成一张图，交上来石沉大海，
      // 而它永远学不到该换个版式
      const usable = LAYOUT_PATTERNS.filter(x => LAYOUT_META[x].image).join(' / ')
      return `版式 "${pattern}" 不放图（版面已被并列块占满）。要配图请改用：${usable}`
    }
    // 合规：图库 URL 绝不许进 deck，只收内容寻址的 asset://
    if (!ASSET_SRC.test(content.image.src)) {
      return `image.src 必须是 searchImage / generateImage 返回的 asset:// 地址，收到 "${content.image.src.slice(0, 60)}"`
    }
  }

  return null
}

/** `asset://` + 64 位十六进制。和 `domains/deck/assetResults.ts` 的 `ASSET_SRC_PATTERN` 是同一条规矩 */
const ASSET_SRC = /^asset:\/\/[0-9a-f]{64}$/

/**
 * 生成一页的完整元素与动画。
 *
 * @param idPrefix 元素 id 前缀，调用方保证全 deck 唯一（kernel 用 slideId + 版本号）
 */
export const buildLayout = (
  pattern: LayoutPattern,
  content: LayoutContent,
  palette: Palette,
  idPrefix: string,
  options: { animate?: boolean } = {},
): LayoutResult => {
  const builder = new Builder(idPrefix, palette)
  const { background, slideType } = LAYOUTS[pattern](builder, content)

  return {
    elements: builder.elements,
    animations: options.animate === false ? [] : builder.animations,
    background,
    slideType,
  }
}

/**
 * 给 prompt 用的版式清单。
 *
 * 图片位是从 `LAYOUT_META.image` 自动带出来的 —— 加一个吃图的版式，
 * prompt 里自动就有了，不需要有人记得去改文案。第十八轮 agent
 * 「搜了图不知道往哪放」，根子就是这份清单里当时一个字都没提图。
 */
export const describeLayouts = (): string =>
  LAYOUT_PATTERNS.map(p => {
    const m = LAYOUT_META[p]
    const items = m.items ? `，items ${m.items[0]}~${m.items[1]} 项` : ''
    const image = m.image === 'backdrop'
      ? '，**可配图**（满屏背景图，自动压遮罩保证文字可读）'
      : m.image === 'panel'
        ? '，**可配图**（占右侧的整幅配图，文字自动缩到左栏）'
        : ''
    return `- ${p}（${m.name}）：${m.usage}${items}${image}`
  }).join('\n')
