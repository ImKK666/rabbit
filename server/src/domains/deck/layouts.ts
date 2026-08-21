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
  richText, textBoxHeight, fitFontSize, fitSteps, mixHex, snapY, stack, scrimFor, ensureContrast, UNIT, LAYOUT_INSET,
  fontForSize, TYPOGRAPHY_PAIRS,
  type Palette, type TypeRecipe, type PaletteStyle,
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
  'image-grid',
  'split-figure',
  'full-figure',
] as const

export type LayoutPattern = typeof LAYOUT_PATTERNS[number]

/** 一张配图。工具返回值原样抄进来即可 */
export interface LayoutImage {
  src: string
  width?: number
  height?: number
  /** `[p5, p95]` 亮度，算遮罩浓度用 */
  luminance?: [number, number]
}

export interface LayoutItem {
  title?: string
  body?: string
  /** 时间轴 / 步骤条上的标签，如 "2024" 或 "第一步" */
  label?: string
  /**
   * **这一条自己的配图**（只有 `image-grid` 吃）。
   *
   * 整页一张图（`content.image`）解决的是「这一页配张图」，
   * 但「三个概念各配一张图」是另一回事 —— 第十九轮把 cards / compare / timeline
   * 判为「版面已满、塞不下图」，结论没错，错在**没有第二种图文关系可选**。
   * 一页三张小图的网格是标准做法，它不该挤进 cards，而该是一个自己的版式。
   */
  image?: LayoutImage
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
   *
   * `luminance` 是图片的 **p95 亮度**（0~1），同样直接抄工具返回值。
   * 用来算背景遮罩该多浓 —— 少了就退回一个中位数常量，
   * 表现是深色照片被压得过狠、浅色照片压不住。取 p95 而不是均值，
   * 因为一行字只要压在**最亮那一小块**上就看不见了（见 `scrimFor`）。
   */
  image?: LayoutImage
}

/** 版式怎么用这张图 */
export type LayoutImageSlot =
  /** 侧栏／色块位换成图片 */
  | 'panel'
  /**
   * 满屏背景图，上面自动压一层遮罩保证文字可读。
   * **文字直接压在照片上**，所以遮罩浓度必须按图片亮度算。
   */
  | 'backdrop'
  /**
   * 满屏图 + **不透明浮层卡片**，文字装在卡片里。
   *
   * 和 `backdrop` 的区别不是程度而是种类：`backdrop` 的可读性由遮罩承担，
   * 所以浓度得跟着照片亮度走；`overlay` 的可读性由那块实心卡片承担，
   * **和照片有多亮完全无关**，遮罩只是让卡片浮起来的装饰。
   *
   * 分成两个名字是因为测试按 slot 分组断言 —— 混用一个名字，
   * 「遮罩必须随亮度变化」那条判据就会套到一个根本不靠遮罩的版式上。
   */
  | 'overlay'

export interface LayoutResult {
  elements: PPTElement[]
  animations: PPTAnimation[]
  background: SlideBackground
  slideType: SlideType
  /**
   * 被兜底夹过高度的元素 id —— **正常应该永远是空数组**。
   *
   * 非空 = 某个版式算出来的版面比画布还高，兜底把框截了，而框一截
   * `lintSlide` 的「超出画布」就永远不会响（它比的是框，不是渲染出来的字）。
   * 第二十轮之前这件事完全无声：66 张样张 0 告警，其中好几张肉眼可见文字压在一起。
   *
   * 现在它至少留下痕迹，`layouts.test.ts` 对全部样本断言它为空。
   */
  clampedIds: string[]
  /** signature 元素的 id —— 它们刻意不挂动画，见 `Builder.signatureIds` */
  signatureIds: string[]
}

/**
 * 这个版式在**整份稿子的节奏**里扮演什么角色。
 *
 * - `structural` 封面 / 结尾：每份固定有一两页，不参与节奏计算
 * - `rhythm`     节奏页：章节转场、单点强调、引用、满屏图 —— 让读者喘一口气的地方
 * - `content`    内容页：并列要点、卡片、对比、时间轴 —— 信息密集，连着看会累
 *
 * **必填而不是可选**，是为了让「新加一个版式」这件事必须停下来想一次它属于哪类。
 * 给成可选的话，漏标就默认落进 `content`，而漏标的表现是节奏判据悄悄失准 ——
 * 和头注释里 `signatureIds` 那条「用 id 不用名字前缀」是同一个理由。
 */
export type LayoutPace = 'structural' | 'rhythm' | 'content'

export interface LayoutMeta {
  pattern: LayoutPattern
  name: string
  /** 什么场合用 —— 进 prompt */
  usage: string
  /** 在整份稿子的节奏里扮演什么角色，`lintDeckDesign` 的节奏判据按它算 */
  pace: LayoutPace
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
  /**
   * 这个版式吃不吃**每一条自己的图**（`items[].image`）。
   *
   * 和 `image` 是两回事：`image` 是「整页一张图」，这个是「三个概念各一张图」。
   * 只有 `image-grid` 是后者 —— 它的 `image` 反而是 null，
   * 因为整页再压一张背景图会和三张小图打架。
   */
  itemImage?: boolean
  /**
   * R-60: 结构变体 B 的一句话说明。有 B 变体的版式，`applyLayout` 收
   * `variant: 'A' | 'B'` —— 同版式的另一种成熟结构。说明自动进 prompt
   * （`describeLayouts`），所以加变体时这里必须写。
   */
  variantB?: string
}

export const LAYOUT_META: Record<LayoutPattern, LayoutMeta> = {
  'title-center': { pattern: 'title-center', name: '居中封面', usage: '封面：标题居中，上下留白最大，最正式', pace: 'structural', items: null, requires: ['title'], image: 'backdrop', variantB: '左对齐封面：文字靠左、右侧大色块装饰，比居中更有刊物感' },
  'title-split': { pattern: 'title-split', name: '分栏封面', usage: '封面：左文右色块，比居中封面更现代、更有版面感', pace: 'structural', items: null, requires: ['title'], image: 'panel' },
  'section': { pattern: 'section', name: '章节转场', usage: '章节之间的过渡页：大章节号 + 章节名', pace: 'rhythm', items: null, requires: ['title'], image: 'backdrop' },
  'bullets': { pattern: 'bullets', name: '要点列表', usage: '内容页：3~5 条并列要点，每条一句话说明', pace: 'content', items: [2, 6], requires: ['title', 'items'], image: 'panel', variantB: '大编号列表：序号换成大号数字、去圆点，更干净' },
  'cards': { pattern: 'cards', name: '卡片网格', usage: '内容页：2~4 个并列概念，每个有独立底板，最通用', pace: 'content', items: [2, 4], requires: ['title', 'items'], image: null, variantB: '分栏无卡：去卡片底板，栏间竖线分隔，杂志分栏感' },
  'compare': { pattern: 'compare', name: '二栏对比', usage: '内容页：A vs B、优点 vs 缺点、现状 vs 目标', pace: 'content', items: [2, 2], requires: ['title', 'items'], image: null },
  'timeline': { pattern: 'timeline', name: '横向时间轴', usage: '内容页：时间顺序、流程步骤、演进过程', pace: 'content', items: [3, 5], requires: ['title', 'items'], image: null },
  'stat': { pattern: 'stat', name: '单点强调', usage: '内容页：一个超大数字或一句结论撑满整页，用来制造节奏停顿', pace: 'rhythm', items: null, requires: ['stat'], image: 'backdrop' },
  'quote': { pattern: 'quote', name: '引用语', usage: '内容页：引述一段话 + 出处，同样用来制造节奏', pace: 'rhythm', items: null, requires: ['quote'], image: 'backdrop' },
  'end': { pattern: 'end', name: '结尾页', usage: '最后一页：致谢 / 联系方式', pace: 'structural', items: null, requires: ['title'], image: 'backdrop' },
  'image-grid': { pattern: 'image-grid', name: '图文网格', usage: '内容页：2~3 个概念**各配一张图**，图在上文字在下。产品特性、案例展示、团队介绍', pace: 'content', items: [2, 3], requires: ['title', 'items'], image: null, itemImage: true },
  'split-figure': { pattern: 'split-figure', name: '左图右列', usage: '内容页：左边一张大图，右边 2~4 条要点。既要配图又要讲清条目时用它，是 cards / bullets 的配图替身', pace: 'content', items: [2, 4], requires: ['title', 'items'], image: 'panel' },
  'full-figure': { pattern: 'full-figure', name: '满屏图 + 浮层卡片', usage: '内容页：整幅照片当背景，文字装在一块实心浮层卡片里。视觉冲击最强，适合章节开场、金句、单一论断', pace: 'rhythm', items: null, requires: ['title'], image: 'overlay' },
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

class Builder {
  private n = 0
  readonly elements: PPTElement[] = []
  readonly animations: PPTAnimation[] = []
  /**
   * 被兜底夹过高度的元素 —— **正常情况下应该永远是空的**。
   *
   * 它非空就说明某个版式算出来的版面比画布还高，兜底把它截了。
   * 改之前这件事完全无声：夹完之后元素框永远在画布内，
   * `lintSlide` 的「超出画布」结构上就不可能响，于是 66 张样张跑出 0 告警，
   * 而其中好几张肉眼可见文字压在一起。现在它至少留下痕迹，
   * `layouts.test.ts` 对全部样本断言这个数组为空。
   */
  readonly clampedIds: string[] = []

  /**
   * signature（配色风格的记忆点）的元素 id。
   *
   * **它们刻意不挂动画** —— 记忆点应该在第一次点击之前就已经在画布上，
   * 而不是跟着内容飞进来。`animationOrder.ts` 的规则 A 本来就只查文本
   * （原话：「一块从头铺到尾的背景板不挂动画是正常设计，报了全是噪音」），
   * 所以 lint 不会报；但 `layouts.test.ts` 的「每一个元素都挂了动画」
   * 比 lint 严，需要一份**精确**的豁免名单。
   *
   * 用 id 而不是按 `name` 前缀匹配：名字是给人看的文案，改一次文案
   * 就会让豁免悄悄失效，而失效的表现是测试变红（还算好）或者
   * 有人顺手把 signature 也挂上动画（那就没人知道了）。
   */
  readonly signatureIds: string[] = []

  constructor(
    private prefix: string,
    readonly palette: Palette,
    readonly type: TypeRecipe,
  ) {}

  private id(): string {
    return `${this.prefix}_${++this.n}`
  }

  /**
   * 量一段文字在给定**元素框宽**下需要多高。
   *
   * 版式一律「先量后排」：把每一块的高度量出来交给 `stack`，由它决定整组放哪。
   * 直接 `y += 常量` 的写法是第二十轮之前版面又挤又空的总根源。
   *
   * **字族是从 `size` 推的，不是从调用方传的**（`fontForSize`）。
   * 下面的 `text()` 用同一个函数、同一个 `size` 推一次 —— 于是
   * 「按哪个字族量」和「按哪个字族渲染」在构造上就不可能对不上。
   * 让调用方各传一次的话，45 个调用点里漏一个就是一处安静的估错。
   */
  measure(
    text: string,
    size: number,
    width: number,
    lineHeight: number = LINE_HEIGHT.body,
    bold = false,
  ): number {
    return textBoxHeight(text, size, width, lineHeight, {
      bold, font: fontForSize(size, this.type),
    })
  }

  /**
   * 在候选字号里挑放得下的最大那个。`fitFontSize` 的方法版 ——
   * 存在的唯一理由是**它得知道字族**，而字族在 `this` 上。
   *
   * 有个先有鸡还是先有蛋：字族由字号定，而这里正是在挑字号。
   * 解法是按**候选里最大的那个**定字族 —— 挑字号这件事只发生在标题上
   * （8 个调用点全是 title / stat / quote），候选区间不会跨过 `DISPLAY_MIN`。
   * 万一以后跨了，按最大值选出的是 display 字族，而 display 通常更宽 ——
   * 估宽是安全那一侧。
   */
  fit(
    text: string,
    boxWidth: number,
    maxHeight: number,
    candidates: number[],
    lineHeight: number = LINE_HEIGHT.heading,
    opts: { bold?: boolean } = {},
  ): number {
    return fitFontSize(text, boxWidth, maxHeight, candidates, lineHeight, {
      ...opts, font: fontForSize(Math.max(...candidates), this.type),
    })
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
    const maxH = CANVAS_HEIGHT - box.top - 8
    const clamped = {
      ...box,
      height: Math.max(16, Math.min(box.height, maxH)),
    }
    if (box.height > maxH + 0.5) this.clampedIds.push(`${this.prefix}_${this.n + 1}`)
    const el: PPTTextElement = {
      id: this.id(),
      type: 'text',
      ...clamped,
      rotate: 0,
      content: richText(content, opts),
      // 和 `measure` 同一个函数、同一个 size —— 量的和渲染的必然是同一个字族
      defaultFontName: fontForSize(opts.size, this.type),
      defaultColor: opts.color,
      // 必须真的写到元素上：`measure` 是按 LAYOUT_INSET 算的，
      // 不写就等于按一个框算、按另一个框渲染。导出侧 useExport 也读它（转成 margin）
      inset: [...LAYOUT_INSET],
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
      gradient?: PPTShapeElement['gradient']
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
      ...(opts.gradient ? { gradient: opts.gradient } : {}),
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
    opts: { imageType?: 'pageFigure' | 'itemFigure' | 'background', name?: string } = {},
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
   *
   * ## 第二十轮：从「一个常量」换成「按图算 + 渐变」
   *
   * 改之前是 `opacity: dark ? 0.78 : 0.82` 两个拍出来的常量。实测下来那不是
   * 「照片偏淡」，是**照片没了** —— 白底亮图那张压完只剩一点点人影，
   * 搜图/生图的钱白花。业界通行区间是 40~60%，我们高出去 20 个点还带反方向。
   *
   * 现在浓度由 `scrimFor` 按**图片实际亮度**算（`content.image.luminance`，
   * 解码时顺手量的 p95 亮度），并且是**渐变**：文字那一侧压住，另一侧照片留着。
   * 导出 PPTX 时渐变会被压平成均匀遮罩 —— 那恰好就是业界那种平铺遮罩，见 `scrimFor` 的说明。
   *
   * `direction` 跟着文字在哪一侧走：文字在左就从左压。
   */
  backdrop(
    image: { src: string, width?: number, height?: number, luminance?: [number, number] } | undefined,
    direction: 'left' | 'right' | 'down' | 'none' = 'left',
    /** 文字在 `direction` 方向上占到画布的哪里（0~1）—— 遮罩要一直罩到那儿 */
    hold = 0.55,
  ): [PPTImageElement | null, PPTShapeElement | null] {
    if (!image?.src) return [null, null]
    const img = this.image(
      { left: 0, top: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
      image,
      { imageType: 'background', name: '背景图' },
    )
    const spec = scrimFor(this.palette, image, { direction, hold })
    const scrim = this.shape('rect', { left: 0, top: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT }, {
      fill: spec.color,
      gradient: spec.gradient,
      opacity: spec.opacity,
      name: '背景遮罩',
    })
    // 记下文字实际踩在什么颜色上，供 `onPhoto` 给彩色文字兜底
    this.scrimBg = spec.effectiveBg
    return [img, scrim]
  }

  /**
   * 背景图压完遮罩之后，文字踩在什么颜色上；没有背景图时是 null。
   * 只由 `backdrop()` 写，`onPhoto()` 读。
   */
  private scrimBg: string | null = null

  /**
   * 彩色文字压在照片上时的兜底颜色。
   *
   * `scrimFor` 是照着 `palette.text` 算遮罩浓度的，但一页上还有别的颜色在当文字用：
   * stat 的大数字是 `primary`（蓝）、eyebrow 是 `accent`（黄）。
   * **实测截图上「关键指标」那行黄字压在照片上几乎看不见，而所有断言都是绿的** ——
   * 因为 lint 只看纯色背景，它看不见照片。
   *
   * 没有背景图时原样返回：纯色背景上的对比度有 lint 守着，不该在这里二次加工，
   * 那会把用户主题色悄悄改掉。
   */
  onPhoto(color: string): string {
    return this.scrimBg ? ensureContrast(color, this.scrimBg) : color
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

// ---------------------------------------------------------------------------
// Signature —— 每套配色风格的「记忆点」
// ---------------------------------------------------------------------------

/**
 * ## 这段替换的是什么
 *
 * 旧 `CANVAS_CONTEXT` 里有一段「高频组合」，教模型：
 * 卡片用 `roundRect` + `shadow: true`、卡片左上角配 32~48px 图标、
 * 标题下面一条 accent 色的 bar（原话是「**最省力的『有设计感』**」）。
 *
 * 那三条逐条对上了业界那份 AI 设计特征清单的 P1 项
 * （统一圆角+统一阴影糊全身 / 图标塞圆角方块 / 彩色边条），
 * 而且因为写在 prompt 里，它们成了**每一页的默认长相** ——
 * 一份稿子里每页都有那条 bar，二十页看下来就是一个模板填了二十遍。
 *
 * 这一版把决策挪进代码：模型不再决定「卡片长什么样」，
 * 由配色风格决定整份稿子有**一个**记忆点。这条分工和字号、配色、字族
 * 是同一条 —— prompt 只留「什么时候用哪个」。
 *
 * ## 为什么只画在页边距里
 *
 * `lintSlide` 的重叠判定是「交集面积占较小元素的 60%」，而面积超过画布 60%
 * 的元素才被当成背景板放过。**一块半页大的色块正好卡在中间**：
 * 它压住正文会被报重叠，面积又够不到背景板的门槛。
 *
 * 所以 signature 一律画在版心之外（`SAFE` 之外那一圈），
 * 那里本来就没有内容。这不是妥协 —— 版心外的装饰是古典书籍排版的正经做法，
 * 而且它天然不会和任何版式打架。
 *
 * ## 强度按风格分化
 *
 * business / academic 只到「几何母题」级别（一条线、一列刻度）；
 * tech / vivid 可以上大动作（点阵、通栏色条）。学术稿子配一条通栏亮色
 * 会和它「极简、去饱和、信息优先」的定位自相矛盾。
 *
 * ## R-60：每档风格两个变体，按主题的锚点色稳定选一个
 *
 * 改之前每档风格只有**一个**记号 —— 两份都用 tech 的稿子，
 * 角框和点阵长得一模一样，签名没有为跨稿差异出任何力。
 * 现在每档两个变体（`SIGNATURES[style][0|1]`），由主题锚点色的哈希决定：
 * 同一份稿子里所有页稳定同一个记号，不同稿子按配色自然分散。
 * **选变体是代码的事，模型照旧一个参数都不碰。**
 */
type SignatureFn = (b: Builder, p: Palette, mark: (el: PPTShapeElement | null) => void) => void

const SIGNATURES: Record<PaletteStyle, SignatureFn[]> = {
  // 商务 v1：左边距一条贯通的细竖线。最克制的一种「这份稿子有人管过版面」
  business: [
    (b, p, mark) => {
      mark(b.shape('rect', { left: 40, top: SAFE.top, width: 2, height: SAFE.height }, {
        fill: p.accent, opacity: 0.55, name: '版式记号·边线',
      }))
    },
    // v2：左下角三条渐近横线 + 左上角一个小方点，同样是克制的几何母题。
    // **只住左 / 上页边距**：吃图的版式里配图贴右出血（bullets / split-figure），
    // 右页边距会被照片占满，记号压上去就是污渍 —— layoutImage.test.ts 钉着这条
    (b, p, mark) => {
      const y0 = 522
      for (const [i, w] of [52, 36, 20].entries()) {
        mark(b.shape('rect', {
          left: 64 - w, top: y0 + i * 10, width: w, height: 2,
        }, { fill: p.accent, opacity: 0.5, name: `版式记号·横线 ${i + 1}` }))
      }
      mark(b.shape('rect', { left: 24, top: 24, width: 8, height: 8 }, {
        fill: p.primary, opacity: 0.35, name: '版式记号·角点',
      }))
    },
  ],

  // 学术 v1：左边距一列刻度短线，像书籍页边的标尺。无彩色，只用描边色
  academic: [
    (b, p, mark) => {
      const n = 5
      const gap = SAFE.height / (n - 1)
      for (let i = 0; i < n; i++) {
        mark(b.shape('rect', { left: 36, top: snapY(SAFE.top + gap * i), width: 16, height: 2 }, {
          fill: p.border, name: `版式记号·刻度 ${i + 1}`,
        }))
      }
    },
    // v2：页边双线（细 + 粗）+ 左下角一段书脊线。同样只住左页边距（配图贴右出血）
    (b, p, mark) => {
      mark(b.shape('rect', { left: 36, top: SAFE.top, width: 2, height: SAFE.height }, {
        fill: p.border, opacity: 0.5, name: '版式记号·细线',
      }))
      mark(b.shape('rect', { left: 44, top: SAFE.top, width: 6, height: SAFE.height }, {
        fill: p.border, opacity: 0.8, name: '版式记号·粗线',
      }))
      mark(b.shape('rect', { left: 36, top: 530, width: 240, height: 2 }, {
        fill: p.border, opacity: 0.6, name: '版式记号·书脊线',
      }))
    },
  ],

  // 科技 v1：左上角一个 L 形角框 + 右下角一片点阵。两处呼应，够显眼又不吵
  tech: [
    (b, p, mark) => {
      mark(b.shape('corner', { left: 28, top: 16, width: 30, height: 30 }, {
        fill: p.accent, opacity: 0.8, name: '版式记号·角框',
      }))
      const cols = 6, rows = 3, d = 5, step = 14
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          mark(b.shape('ellipse', {
            left: 872 + c * step, top: 516 + r * step, width: d, height: d,
          }, { fill: p.accent, opacity: 0.45, name: '版式记号·点阵' }))
        }
      }
    },
    // v2：左上角两条平行短横 + 左下角一列三个小方点，更安静的「信号条」母题。
    // 只住左 / 上页边距 —— 配图贴右出血时右页边距是照片（同上一条理由）
    (b, p, mark) => {
      for (const [i, top] of [16, 26].entries()) {
        mark(b.shape('rect', { left: 28, top, width: 28, height: 3 }, {
          fill: p.primary, opacity: 0.8, name: `版式记号·信号条 ${i + 1}`,
        }))
      }
      ;[522, 532, 542].forEach((top, i) => {
        mark(b.shape('rect', { left: 40 + i * 16, top, width: 4, height: 4 }, {
          fill: p.accent, opacity: 0.6, name: `版式记号·方点 ${i + 1}`,
        }))
      })
    },
  ],

  // 活泼 v1：底部通栏色条 + 右上角一个实心圆。最外放的一套
  vivid: [
    (b, p, mark) => {
      mark(b.shape('rect', { left: 0, top: CANVAS_HEIGHT - 10, width: CANVAS_WIDTH, height: 10 }, {
        fill: p.accent, name: '版式记号·底栏',
      }))
      mark(b.shape('ellipse', { left: 952, top: 20, width: 20, height: 20 }, {
        fill: p.accent, opacity: 0.85, name: '版式记号·角点',
      }))
    },
    // v2：左上角 L 形色块 + 左下角三个渐变色点。只住左 / 上页边距（配图贴右出血）
    (b, p, mark) => {
      mark(b.shape('rect', { left: 0, top: 16, width: 64, height: 8 }, {
        fill: p.accent, opacity: 0.8, name: '版式记号·L 横',
      }))
      mark(b.shape('rect', { left: 16, top: 0, width: 8, height: 64 }, {
        fill: p.accent, opacity: 0.8, name: '版式记号·L 竖',
      }))
      const dots: Array<[string, number]> = [[p.accent, 0.85], [p.primary, 0.7], [p.accent, 0.45]]
      dots.forEach(([fill, opacity], i) => {
        mark(b.shape('ellipse', { left: 16 + i * 20, top: 534, width: 12, height: 12 }, {
          fill, opacity, name: `版式记号·色点 ${i + 1}`,
        }))
      })
    },
  ],

  // 编辑风（R-60 新增）：记号用墨色（正文色），高对比本身就是它的表达
  editorial: [
    // v1：左边距一条 3px 的墨线 + 左上角一个墨方块
    (b, p, mark) => {
      mark(b.shape('rect', { left: 40, top: SAFE.top, width: 3, height: SAFE.height }, {
        fill: p.text, opacity: 0.8, name: '版式记号·墨线',
      }))
      mark(b.shape('rect', { left: 24, top: 24, width: 10, height: 10 }, {
        fill: p.text, opacity: 0.35, name: '版式记号·墨块',
      }))
    },
    // v2：左上角两条平行墨横 + 左下角一段粗墨线
    (b, p, mark) => {
      for (const [i, top] of [16, 26].entries()) {
        mark(b.shape('rect', { left: 24, top, width: 32, height: 4 }, {
          fill: p.text, opacity: 0.8, name: `版式记号·墨横 ${i + 1}`,
        }))
      }
      mark(b.shape('rect', { left: 24, top: 528, width: 180, height: 4 }, {
        fill: p.text, opacity: 0.55, name: '版式记号·墨底线',
      }))
    },
  ],

  // 柔和（R-60 新增）：记号也跟着柔 —— 低饱和、小尺寸、淡透明度
  soft: [
    // v1：左上角一个小圆 + 左边距一条淡竖线
    (b, p, mark) => {
      mark(b.shape('ellipse', { left: 28, top: 24, width: 16, height: 16 }, {
        fill: p.accent, opacity: 0.25, name: '版式记号·柔圆',
      }))
      mark(b.shape('rect', { left: 44, top: SAFE.top, width: 2, height: SAFE.height }, {
        fill: p.accent, opacity: 0.16, name: '版式记号·淡线',
      }))
    },
    // v2：左上角两个渐淡圆点 + 左下角一段淡横线
    (b, p, mark) => {
      for (const [i, opacity] of [0.3, 0.18].entries()) {
        mark(b.shape('ellipse', { left: 24 + i * 20, top: 24, width: 12, height: 12 }, {
          fill: p.accent, opacity, name: `版式记号·柔点 ${i + 1}`,
        }))
      }
      mark(b.shape('rect', { left: 36, top: 532, width: 160, height: 2 }, {
        fill: p.border, opacity: 0.5, name: '版式记号·淡底线',
      }))
    },
  ],
}

/**
 * 按主题锚点色稳定选一个 signature 变体。
 *
 * 哈希的是这一页调色板里**模型定的那三个锚点**（background / primary / accent，
 * 再带上 text 做扰动）—— 同一份稿子每页传同一套主题，变体必然稳定；
 * 两份不同配色的稿子自然分散。djb2 就够：这里要的是确定性不是密码学。
 */
export const signatureVariant = (p: Palette): number => {
  let h = 5381
  for (const s of [p.background, p.primary, p.accent, p.text]) {
    for (const ch of s) h = ((h << 5) + h + ch.charCodeAt(0)) | 0
  }
  return Math.abs(h) % 2
}

const drawSignature = (b: Builder, style: PaletteStyle, variant: number): void => {
  const p = b.palette
  // 每个 signature 元素都登记 id —— 见 Builder.signatureIds 的说明
  const mark = (el: PPTShapeElement | null) => {
    if (el) b.signatureIds.push(el.id)
  }
  const variants = SIGNATURES[style]
  variants[Math.abs(variant) % variants.length](b, p, mark)
}

/**
 * 满屏背景图的页不画 signature。
 *
 * 页边距在那种页面上被照片占满了 —— 画上去要么被压在图下面看不见，
 * 要么浮在照片上像个污点。而且那种页本身视觉已经够强，不需要再加记忆点。
 */
const wantsSignature = (pattern: LayoutPattern, c: LayoutContent): boolean => {
  const slot = LAYOUT_META[pattern].image
  return !((slot === 'backdrop' || slot === 'overlay') && !!c.image?.src)
}

type LayoutFn = (b: Builder, c: LayoutContent) => { background: SlideBackground, slideType: SlideType }

/**
 * R-60: 版式的**结构变体 B**。
 *
 * 改之前一个版式只有一种构图 —— 两份不同稿子用同一个版式，
 * 页面的几何结构一模一样，换的只有字和颜色。变体给最高频的三个版式
 * 加第二种结构（封面左对齐 / 大编号列表 / 分栏无卡），模型用
 * `applyLayout` 的 `variant` 参数选，构图仍然全由代码算 ——
 * 红线（不往排版层加自由度）不动。
 *
 * 只有 A / B 两档：变体不是「无限风格」，是同版式的另一种成熟结构。
 * 每个 B 变体都必须过同一套判据（最大条数不溢出、动画全覆盖、栅格对齐）。
 */
const LAYOUT_VARIANTS: Partial<Record<LayoutPattern, LayoutFn>> = {
  // 左对齐封面（B）：文字靠左，右侧大色块装饰。比居中的 A 更「刊物」，
  // 又和 title-split 不一样 —— 那一个是右半页实色栏，这里是留白上的浮饰
  'title-center': (b, c) => {
    const p = b.palette

    const colW = 600
    // 有照片就不放装饰块 —— 半透明色块叠在照片上像污渍（R-48 判过的同一条）
    const hasImage = !!c.image?.src
    const [bgImage, scrim] = b.backdrop(c.image, 'left', (SAFE.left + colW + 40) / CANVAS_WIDTH)

    const disc = hasImage ? null : b.shape('ellipse', {
      left: SAFE.left + colW + 40, top: 120, width: 240, height: 240,
    }, { fill: p.primary, opacity: 0.1, name: '装饰圆' })
    const dot = hasImage ? null : b.shape('ellipse', {
      left: 940, top: 60, width: 28, height: 28,
    }, { fill: p.accent, opacity: 0.8, name: '装饰角点' })

    const titleSize = b.fit(c.title ?? '', colW, 220, DISPLAY_STEPS)
    const titleH = b.measure(c.title ?? '', titleSize, colW, LINE_HEIGHT.heading, true)
    const eyebrowH = b.measure(c.eyebrow ?? '', TYPE_SCALE.eyebrow, colW, LINE_HEIGHT.tight, true)
    const subH = b.measure(c.subtitle ?? '', TYPE_SCALE.subtitle, colW - 80)

    const rows = stack([
      ...(c.eyebrow ? [{ height: eyebrowH }] : []),
      { height: titleH, gap: c.eyebrow ? SPACING.paragraphGap : 0 },
      { height: 12, gap: SPACING.headingGap },
      ...(c.subtitle ? [{ height: subH, gap: SPACING.headingGap }] : []),
    ], SAFE, 'middle')

    let i = 0
    const eyebrow = c.eyebrow
      ? b.text({ left: SAFE.left, top: rows.tops[i++], width: colW, height: eyebrowH }, c.eyebrow, {
        size: TYPE_SCALE.eyebrow, color: b.onPhoto(p.accent), bold: true, letterSpacing: 2,
        lineHeight: LINE_HEIGHT.tight, textType: 'header',
      })
      : null

    const title = b.text({ left: SAFE.left, top: rows.tops[i++], width: colW, height: titleH }, c.title ?? '', {
      size: titleSize, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })

    const bar = b.shape('bar', { left: SAFE.left, top: rows.tops[i++], width: 72, height: 12 }, {
      fill: p.accent, name: '强调条',
    })

    const subtitle = c.subtitle
      ? b.text(
        { left: SAFE.left, top: rows.tops[i++], width: colW - 80, height: subH },
        c.subtitle,
        { size: TYPE_SCALE.subtitle, color: b.onPhoto(p.textMuted), textType: 'subtitle' },
      )
      : null

    // 装饰块和标题同步出场，不单独占一步；背景图是舞台，同样同步铺开
    b.animate(title, 'fade-left', 'click', 600)
    b.animate(eyebrow, 'fade-left', 'meantime', 400)
    b.animate(disc, 'scale-in', 'meantime', 900)
    b.animate(dot, 'zoom-in', 'meantime', 600)
    b.animate(bar, 'wipe', 'auto', 400)
    b.animate(subtitle, 'fade-left', 'auto', 500)
    b.animate(bgImage, 'fade', 'meantime', 800)
    b.animate(scrim, 'fade', 'meantime', 800)

    return { background: { type: 'solid', color: p.background }, slideType: 'cover' }
  },

  // 大编号列表（B）：序号从「圆点 + 小数字」换成大号数字 ——
  // 去掉图形标记之后版面更干净，靠数字本身撑起「第几条」的结构感
  'bullets': (b, c) => {
    const p = b.palette
    const items = clampItems(c.items, 2, 6)

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

    const titleH = b.measure(c.title ?? '', TYPE_SCALE.title, colW - 28, LINE_HEIGHT.heading, true)
    const accentBar = b.shape('bar', { left: SAFE.left, top: SAFE.top + 8, width: 8, height: Math.min(44, titleH - 16) }, {
      fill: p.accent, name: '标题强调条',
    })
    const title = b.text(
      { left: SAFE.left + 28, top: SAFE.top, width: colW - 28, height: titleH },
      c.title ?? '', { size: TYPE_SCALE.title, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title' },
    )

    let y = snapY(SAFE.top + titleH + SPACING.headingGap)
    let subtitle: PPTElement | null = null
    if (c.subtitle) {
      const h = b.measure(c.subtitle, TYPE_SCALE.body, colW - 28)
      subtitle = b.text({ left: SAFE.left + 28, top: y, width: colW - 28, height: h }, c.subtitle, {
        size: TYPE_SCALE.body, color: b.onPhoto(p.textMuted), textType: 'content',
      })
      y = snapY(y + h + SPACING.paragraphGap)
    }

    // B 变体的核心差异：没有圆点，序号是 30px 的大数字
    const numW = 56
    const numH = 40
    const textLeft = SAFE.left + numW + SPACING.paragraphGap
    const textWidth = colW - numW - SPACING.paragraphGap

    // 降级策略和 A 变体同一条：字号成组降 + 行距压缩，降到放得下为止
    const budget = SAFE.bottom - y
    const step = fitSteps(
      [
        { head: TYPE_SCALE.itemTitle, body: TYPE_SCALE.body, gap: SPACING.paragraphGap, lh: LINE_HEIGHT.body },
        { head: TYPE_SCALE.itemTitle, body: TYPE_SCALE.body, gap: 12, lh: 1.45 },
        { head: 17, body: 14, gap: UNIT, lh: 1.35 },
        { head: 16, body: TYPE_SCALE.caption, gap: UNIT, lh: LINE_HEIGHT.tight },
      ],
      s => items.reduce((sum, it, i) => {
        const h = b.measure(it.title ?? '', s.head, textWidth, LINE_HEIGHT.heading, true)
        const bh = it.body ? b.measure(it.body, s.body, textWidth, s.lh) : 0
        return sum + Math.max(numH + 8, h + bh) + (i === 0 ? 0 : s.gap)
      }, 0),
      budget,
    )

    const headHs = items.map(it => b.measure(it.title ?? '', step.head, textWidth, LINE_HEIGHT.heading, true))
    const bodyHs = items.map(it => (it.body ? b.measure(it.body, step.body, textWidth, step.lh) : 0))
    const rowHs = items.map((_, i) => Math.max(numH + 8, headHs[i] + bodyHs[i]))

    const rows = stack(
      rowHs.map((h, i) => ({ height: h, gap: i === 0 ? 0 : step.gap })),
      { top: y, bottom: SAFE.bottom },
      'spread',
      { maxGapFactor: 2.2 },
    )

    b.animate(title, 'fade-left', 'click', 500)
    b.animate(accentBar, 'wipe-down', 'meantime', 400)
    b.animate(figure, 'wipe-right', 'meantime', 700)
    b.animate(subtitle, 'fade-up', 'auto', 400)

    items.forEach((item, i) => {
      const top = rows.tops[i]
      // 大数字和条目标题第一行基线对齐
      const numTop = snapY(top + 2)
      const markerNum = b.text(
        { left: SAFE.left, top: numTop, width: numW, height: numH },
        String(i + 1).padStart(2, '0'),
        {
          size: 30, color: b.onPhoto(i === 0 ? p.accent : p.primary), bold: true,
          lineHeight: LINE_HEIGHT.tight, vAlign: 'middle', textType: 'itemNumber',
        },
      )

      const head = b.text({ left: textLeft, top, width: textWidth, height: headHs[i] }, item.title ?? '', {
        size: step.head, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'itemTitle',
      })
      const body = item.body
        ? b.text(
          { left: textLeft, top: snapY(top + headHs[i]), width: textWidth, height: bodyHs[i] },
          item.body,
          { size: step.body, color: b.onPhoto(p.textMuted), lineHeight: step.lh, textType: 'item' },
        )
        : null

      b.animate(markerNum, 'fade-left', i === 0 ? 'click' : 'auto', 400)
      b.animate(head, 'fade-left', 'meantime', 400)
      b.animate(body, 'fade-left', 'meantime', 400)
    })

    return { background: { type: 'solid', color: p.background }, slideType: 'content' }
  },

  // 分栏无卡（B）：去卡片底板和编号胶囊，栏间竖线分隔 —— 杂志分栏感。
  // 和 bullets 的区别是**并排**而非纵向列表，栏数是它的结构
  'cards': (b, c) => {
    const p = b.palette
    const items = clampItems(c.items, 2, 4)
    const n = items.length

    const titleH = b.measure(c.title ?? '', TYPE_SCALE.title, SAFE.width, LINE_HEIGHT.heading, true)
    const title = b.text({ left: SAFE.left, top: SAFE.top, width: SAFE.width, height: titleH }, c.title ?? '', {
      size: TYPE_SCALE.title, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })
    const bar = b.shape('bar', { left: SAFE.left, top: snapY(SAFE.top + titleH + 4), width: 64, height: 10 }, {
      fill: p.accent, name: '强调条',
    })

    let y = snapY(SAFE.top + titleH + 14 + SPACING.headingGap)
    let subtitle: PPTElement | null = null
    if (c.subtitle) {
      const h = b.measure(c.subtitle, TYPE_SCALE.body, SAFE.width)
      subtitle = b.text({ left: SAFE.left, top: y, width: SAFE.width, height: h }, c.subtitle, {
        size: TYPE_SCALE.body, color: b.onPhoto(p.textMuted), textType: 'content',
      })
      y = snapY(y + h + SPACING.paragraphGap)
    }

    const gap = SPACING.gutter
    const colW = (SAFE.width - gap * (n - 1)) / n
    const available = SAFE.bottom - y

    // 没有卡片底板兜着，放不下就得真的降级（行距压缩），不能靠底板截断
    const bodySize = n >= 4 ? TYPE_SCALE.caption : TYPE_SCALE.body
    const step = fitSteps(
      [
        { body: bodySize, lh: LINE_HEIGHT.body },
        { body: TYPE_SCALE.caption, lh: 1.45 },
        { body: TYPE_SCALE.caption, lh: LINE_HEIGHT.tight },
      ],
      s => Math.max(...items.map(it => {
        const hh = b.measure(it.title ?? '', TYPE_SCALE.itemTitle, colW, LINE_HEIGHT.heading, true)
        const bh = it.body ? b.measure(it.body, s.body, colW, s.lh) : 0
        return 16 + SPACING.paragraphGap + hh + bh
      })),
      available,
    )

    const headHs = items.map(it => b.measure(it.title ?? '', TYPE_SCALE.itemTitle, colW, LINE_HEIGHT.heading, true))
    const bodyHs = items.map(it => (it.body ? b.measure(it.body, step.body, colW, step.lh) : 0))

    // 栏间竖线：结构线随第一栏同步画出
    const dividers = Array.from({ length: n - 1 }, (_, i) =>
      b.line(
        [0, 0], [0, SAFE.bottom - y],
        SAFE.left + (i + 1) * colW + i * gap + gap / 2, y,
        p.border, 1,
      ),
    )

    b.animate(title, 'fade-down', 'click', 500)
    b.animate(bar, 'wipe', 'meantime', 400)
    b.animate(subtitle, 'fade-up', 'auto', 400)
    dividers.forEach(d => b.animate(d, 'wipe-down', 'meantime', 500))

    items.forEach((item, i) => {
      const left = SAFE.left + i * (colW + gap)
      const num = b.text({ left, top: y, width: colW, height: 16 }, String(i + 1).padStart(2, '0'), {
        size: TYPE_SCALE.eyebrow, color: b.onPhoto(p.accent), bold: true,
        lineHeight: LINE_HEIGHT.tight, textType: 'itemNumber',
      })
      const headTop = snapY(y + 16 + SPACING.paragraphGap)
      const head = b.text({ left, top: headTop, width: colW, height: headHs[i] }, item.title ?? '', {
        size: TYPE_SCALE.itemTitle, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'itemTitle',
      })
      const body = item.body
        ? b.text(
          { left, top: snapY(headTop + headHs[i]), width: colW, height: bodyHs[i] },
          item.body,
          { size: step.body, color: b.onPhoto(p.textMuted), lineHeight: step.lh, textType: 'item' },
        )
        : null

      b.animate(num, 'fade-up', i === 0 ? 'click' : 'auto', 400)
      b.animate(head, 'fade-up', 'meantime', 400)
      b.animate(body, 'fade-up', 'meantime', 400)
    })

    return { background: { type: 'solid', color: p.background }, slideType: 'content' }
  },
}

const LAYOUTS: Record<LayoutPattern, LayoutFn> = {
  // 居中封面：装饰性斜切块压在角落，标题居中，下方一道强调条
  'title-center': (b, c) => {
    const p = b.palette

    // 背景图必须最先放：PPTist 的层级就是数组顺序。
    //
    // 居中构图**用均匀遮罩**（direction: 'none'）：文字横跨整幅、上下也居中，
    // 任何方向的渐变都会有一头压不住。封面本来就是「整张图当舞台」，
    // 均匀压反而对 —— 关键是浓度现在按图算，不再是那个 0.82
    const [bgImage, scrim] = b.backdrop(c.image, 'none')

    // 有照片就不放斜块。理由和 R-48 去掉 title-split 那个装饰环一模一样：
    // 半透明色块叠在照片上像块污渍，照片自带纹理，不需要再加「质感」
    const hasImage = !!c.image?.src
    const stripe = hasImage ? null : b.shape('diagStripe', { left: CANVAS_WIDTH - 320, top: 0, width: 320, height: 300 }, {
      fill: p.primary, opacity: 0.14, name: '装饰斜块',
    })
    const stripe2 = hasImage ? null : b.shape('diagStripe', { left: 0, top: CANVAS_HEIGHT - 220, width: 260, height: 220 }, {
      fill: p.accent, opacity: 0.1, rotate: 180, name: '装饰斜块',
    })

    const subW = SAFE.width - 160
    const titleSize = b.fit(c.title ?? '', SAFE.width, 200, DISPLAY_STEPS)
    const titleH = b.measure(c.title ?? '', titleSize, SAFE.width, LINE_HEIGHT.heading, true)
    const eyebrowH = b.measure(c.eyebrow ?? '', TYPE_SCALE.eyebrow, SAFE.width, LINE_HEIGHT.tight, true)
    const subH = b.measure(c.subtitle ?? '', TYPE_SCALE.subtitle, subW)

    // 整组垂直居中 —— 封面的内容量天然少，顶端对齐就是下面空一大片
    const rows = stack([
      ...(c.eyebrow ? [{ height: eyebrowH }] : []),
      { height: titleH, gap: c.eyebrow ? SPACING.paragraphGap : 0 },
      { height: 16, gap: SPACING.headingGap },
      ...(c.subtitle ? [{ height: subH, gap: SPACING.headingGap }] : []),
    ], SAFE, 'middle')

    let i = 0
    const eyebrow = c.eyebrow
      ? b.text({ left: SAFE.left, top: rows.tops[i++], width: SAFE.width, height: eyebrowH }, c.eyebrow, {
        size: TYPE_SCALE.eyebrow, color: b.onPhoto(p.accent), bold: true, align: 'center',
        letterSpacing: 2, lineHeight: LINE_HEIGHT.tight, textType: 'header',
      })
      : null

    const title = b.text({ left: SAFE.left, top: rows.tops[i++], width: SAFE.width, height: titleH }, c.title ?? '', {
      size: titleSize, color: p.text, bold: true, align: 'center',
      lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })

    const bar = b.shape('bar', { left: (CANVAS_WIDTH - 96) / 2, top: rows.tops[i++], width: 96, height: 16 }, {
      fill: p.accent, name: '强调条',
    })

    const subtitle = c.subtitle
      ? b.text(
        { left: SAFE.left + 80, top: rows.tops[i++], width: subW, height: subH },
        c.subtitle,
        { size: TYPE_SCALE.subtitle, color: b.onPhoto(p.textMuted), align: 'center', textType: 'subtitle' },
      )
      : null

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
    const hasImage = !!c.image?.src

    // 图直接顶掉主色块 —— 不是叠在上面：叠的话主色块永远看不见，
    // 白白多一个元素，用户想换回纯色还得先删图
    const panel = hasImage
      ? b.image(panelBox, c.image!, { imageType: 'pageFigure', name: '封面图' })
      : b.shape('rect', panelBox, { fill: p.primary, name: '主色块' })
    // 那条 10px 的强调色分界线是给**纯色块**用的：两块纯色相接需要一条边来收口。
    // 贴在照片边上就成了一条突兀的彩色描边 —— 照片自己的边缘就是边界，
    // 实测样张上一眼看出来它像贴纸。和下面的装饰环是同一条理由
    const panelAccent = hasImage ? null : b.shape('rect', { left: splitX, top: 0, width: 10, height: CANVAS_HEIGHT }, {
      fill: p.accent, name: '分界线',
    })
    // 装饰环是给**纯色块**加质感用的。照片自带纹理，再叠一个半透明圆环
    // 只会像块污渍 —— 实测截图上一眼就看出来了
    const mark = hasImage
      ? null
      : b.shape('donut', { left: splitX + 96, top: 180, width: 200, height: 200 }, {
        fill: mixHex(p.primary, p.onPrimary, 0.28), name: '装饰环',
      })

    const colW = splitX - SAFE.left - SPACING.gutter
    const titleSize = b.fit(c.title ?? '', colW, 220, DISPLAY_STEPS)
    const titleH = b.measure(c.title ?? '', titleSize, colW, LINE_HEIGHT.heading, true)
    const eyebrowH = b.measure(c.eyebrow ?? '', TYPE_SCALE.eyebrow, colW, LINE_HEIGHT.tight, true)
    const subH = b.measure(c.subtitle ?? '', TYPE_SCALE.subtitle, colW)

    const rows = stack([
      ...(c.eyebrow ? [{ height: eyebrowH }] : []),
      { height: titleH, gap: c.eyebrow ? SPACING.paragraphGap : 0 },
      { height: 12, gap: SPACING.headingGap },
      ...(c.subtitle ? [{ height: subH, gap: SPACING.headingGap }] : []),
    ], SAFE, 'middle')

    let i = 0
    const eyebrow = c.eyebrow
      ? b.text({ left: SAFE.left, top: rows.tops[i++], width: colW, height: eyebrowH }, c.eyebrow, {
        size: TYPE_SCALE.eyebrow, color: b.onPhoto(p.accent), bold: true, letterSpacing: 2,
        lineHeight: LINE_HEIGHT.tight, textType: 'header',
      })
      : null

    const title = b.text({ left: SAFE.left, top: rows.tops[i++], width: colW, height: titleH }, c.title ?? '', {
      size: titleSize, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })

    const bar = b.shape('bar', { left: SAFE.left, top: rows.tops[i++], width: 72, height: 12 }, { fill: p.accent, name: '强调条' })

    const subtitle = c.subtitle
      ? b.text(
        { left: SAFE.left, top: rows.tops[i++], width: colW, height: subH },
        c.subtitle,
        { size: TYPE_SCALE.subtitle, color: b.onPhoto(p.textMuted), textType: 'subtitle' },
      )
      : null

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

    // 号码栏宽度跟着位数走：「02」和「12」一样宽，但「第二部分」那种就得让开
    const numW = Math.max(180, Math.min(300, number.length * TYPE_SCALE.stat * 0.62 + 40))
    const numH = b.measure(number, TYPE_SCALE.stat, numW, LINE_HEIGHT.tight, true)

    const textLeft = SAFE.left + numW + SPACING.gutter + 24
    // 有图时右边留出 22% 给照片，理由同 quote / stat
    const textRight = c.image?.src ? SAFE.left + Math.round(SAFE.width * 0.78) : SAFE.right
    const textW = Math.max(160, textRight - textLeft)
    const [bgImage, scrim] = b.backdrop(c.image, 'left', (textRight + 40) / CANVAS_WIDTH)
    const titleSize = b.fit(c.title ?? '', textW, 180, [TYPE_SCALE.title, TYPE_SCALE.subtitle, TYPE_SCALE.itemTitle], LINE_HEIGHT.heading, { bold: true })
    const titleH = b.measure(c.title ?? '', titleSize, textW, LINE_HEIGHT.heading, true)
    // 副标题从 body(15) 提到 subtitle(22)：章节页上 15px 小得像脚注，
    // 和 38px 的标题之间层次直接断掉。转场页信息少，正该把这一行放大
    const subH = b.measure(c.subtitle ?? '', TYPE_SCALE.subtitle, textW)

    // 文字块（标题 + 副标题）和号码各自成组，整体垂直居中
    const textBlock = titleH + (c.subtitle ? subH + SPACING.paragraphGap : 0)
    const groupH = Math.max(numH, textBlock)
    const top = snapY(SAFE.top + (SAFE.height - groupH) / 2)

    // 号码和文字块各自在组内居中 —— 改之前号码顶对齐、标题往下 10px、
    // 竖线又比两者都长，三样东西三个基准，看着就是没对齐
    const num = b.text(
      { left: SAFE.left, top: snapY(top + (groupH - numH) / 2), width: numW, height: numH },
      number,
      {
        size: TYPE_SCALE.stat, color: b.onPhoto(p.accent), bold: true, lineHeight: LINE_HEIGHT.tight,
        textType: 'partNumber', name: '章节号',
      },
    )

    // 竖线高度 = 内容组高度，不再是写死的 180
    const rule = b.line([0, 0], [0, groupH], SAFE.left + numW + SPACING.gutter, top, p.border, 2)

    const textTop = snapY(top + (groupH - textBlock) / 2)
    const title = b.text(
      { left: textLeft, top: textTop, width: textW, height: titleH },
      c.title ?? '',
      { size: titleSize, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title' },
    )

    const subtitle = c.subtitle
      ? b.text(
        { left: textLeft, top: snapY(textTop + titleH + SPACING.paragraphGap), width: textW, height: subH },
        c.subtitle,
        { size: TYPE_SCALE.subtitle, color: b.onPhoto(p.textMuted), textType: 'content' },
      )
      : null

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

    // 标题左边那条竖强调条。**改之前写的是 `rotate: 90`** ——
    // 一个 8×40 的框转 90° 之后是**横**的 40×8，注释说「竖强调条」，
    // 画出来是标题左边一个孤零零的小横杠。去掉 rotate 就是它本来该有的样子
    const titleH = b.measure(c.title ?? '', TYPE_SCALE.title, colW - 28, LINE_HEIGHT.heading, true)
    const accentBar = b.shape('bar', { left: SAFE.left, top: SAFE.top + 8, width: 8, height: Math.min(44, titleH - 16) }, {
      fill: p.accent, name: '标题强调条',
    })
    const title = b.text(
      { left: SAFE.left + 28, top: SAFE.top, width: colW - 28, height: titleH },
      c.title ?? '', { size: TYPE_SCALE.title, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title' },
    )

    let y = snapY(SAFE.top + titleH + SPACING.headingGap)
    let subtitle: PPTElement | null = null
    if (c.subtitle) {
      const h = b.measure(c.subtitle, TYPE_SCALE.body, colW - 28)
      subtitle = b.text({ left: SAFE.left + 28, top: y, width: colW - 28, height: h }, c.subtitle, {
        size: TYPE_SCALE.body, color: b.onPhoto(p.textMuted), textType: 'content',
      })
      y = snapY(y + h + SPACING.paragraphGap)
    }

    const markerSize = 30
    const textLeft = SAFE.left + markerSize + SPACING.paragraphGap
    const textWidth = colW - markerSize - SPACING.paragraphGap

    /**
     * 先把每条要点实际需要多高量出来，再交给 `stack` 撑开 ——
     * 改之前是 `(可用高 - 间距) / 条数` 平均分，三条短要点就隔着 120px 空气。
     *
     * 但按内容排就必须自己处理「放不下」：六条带正文的要点按 19/15 量出来 608px，
     * 而版心只有 442px。所以字号成组降级，**降到放得下为止**。
     */
    /**
     * 降级的杠杆是**行距**，不只是字号。
     *
     * 因为行盒高度是 `max(字号, 16) × 行距`（见 `design.ts` 的 `ROOT_FONT_SIZE`）——
     * **字号降到 16 以下一点高度都省不出来**，只能减少折行数。
     * 正文本来就是 15px，再往下降对「排不排得下」几乎没有帮助。
     * 真正能压缩纵向的是行距：正文 1.6 → 1.35 → 1.15，每行省 4~7px，
     * 六条要点就是 25~45px，而这正好是差的那一截。
     *
     * 行距不再往 1.15 以下压：中文在那个密度会糊成一片，
     * 那时候「排下了」和「读不了」是一回事。
     */
    const budget = SAFE.bottom - y
    const step = fitSteps(
      [
        { head: TYPE_SCALE.itemTitle, body: TYPE_SCALE.body, gap: SPACING.paragraphGap, lh: LINE_HEIGHT.body },
        { head: TYPE_SCALE.itemTitle, body: TYPE_SCALE.body, gap: SPACING.paragraphGap, lh: LINE_HEIGHT.body },
        { head: TYPE_SCALE.itemTitle, body: TYPE_SCALE.body, gap: 12, lh: 1.45 },
        { head: 17, body: 14, gap: UNIT, lh: 1.35 },
        { head: 16, body: TYPE_SCALE.caption, gap: UNIT, lh: LINE_HEIGHT.tight },
      ],
      s => items.reduce((sum, it, i) => {
        const h = b.measure(it.title ?? '', s.head, textWidth, LINE_HEIGHT.heading, true)
        const bh = it.body ? b.measure(it.body, s.body, textWidth, s.lh) : 0
        return sum + Math.max(markerSize + 8, h + bh) + (i === 0 ? 0 : s.gap)
      }, 0),
      budget,
    )

    const headHs = items.map(it => b.measure(it.title ?? '', step.head, textWidth, LINE_HEIGHT.heading, true))
    const bodyHs = items.map(it => (it.body ? b.measure(it.body, step.body, textWidth, step.lh) : 0))
    const rowHs = items.map((_, i) => Math.max(markerSize + 8, headHs[i] + bodyHs[i]))

    const rows = stack(
      rowHs.map((h, i) => ({ height: h, gap: i === 0 ? 0 : step.gap })),
      { top: y, bottom: SAFE.bottom },
      'spread',
      { maxGapFactor: 2.2 },
    )

    b.animate(title, 'fade-left', 'click', 500)
    b.animate(accentBar, 'wipe-down', 'meantime', 400)
    // 配图跟标题同步擦入 —— 它是版面的一半，不该等要点讲完才出现。
    // 图在右侧，用「自右擦除」朝画面内推，方向和它的位置一致
    b.animate(figure, 'wipe-right', 'meantime', 700)
    b.animate(subtitle, 'fade-up', 'auto', 400)

    items.forEach((item, i) => {
      const top = rows.tops[i]
      // 圆点对齐条目标题的**第一行中线**，不是对齐整块的顶 ——
      // 标题换成两行时，对齐块顶的圆点会浮在半空
      const markerTop = snapY(top + Math.max(0, (Math.min(headHs[i], step.head * 2) - markerSize) / 2))
      const marker = b.shape('ellipse', { left: SAFE.left, top: markerTop, width: markerSize, height: markerSize }, {
        fill: i === 0 ? p.accent : p.primary, name: `序号 ${i + 1}`,
      })
      // 数字压在圆点上，两者必须同一步出场 —— 圆点飞入而数字早就在那儿，
      // 看着就是「数字浮在半空等圆点来接」
      const markerNum = b.text({ left: SAFE.left, top: markerTop, width: markerSize, height: markerSize }, String(i + 1), {
        size: TYPE_SCALE.caption, color: p.onPrimary, bold: true, align: 'center',
        lineHeight: LINE_HEIGHT.tight, vAlign: 'middle', textType: 'itemNumber',
      })

      const head = b.text({ left: textLeft, top, width: textWidth, height: headHs[i] }, item.title ?? '', {
        size: step.head, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'itemTitle',
      })
      const body = item.body
        ? b.text(
          { left: textLeft, top: snapY(top + headHs[i]), width: textWidth, height: bodyHs[i] },
          item.body,
          { size: step.body, color: b.onPhoto(p.textMuted), lineHeight: step.lh, textType: 'item' },
        )
        : null

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

    const titleH = b.measure(c.title ?? '', TYPE_SCALE.title, SAFE.width, LINE_HEIGHT.heading, true)
    const title = b.text({ left: SAFE.left, top: SAFE.top, width: SAFE.width, height: titleH }, c.title ?? '', {
      size: TYPE_SCALE.title, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })
    const bar = b.shape('bar', { left: SAFE.left, top: snapY(SAFE.top + titleH + 4), width: 64, height: 10 }, {
      fill: p.accent, name: '强调条',
    })

    let y = snapY(SAFE.top + titleH + 14 + SPACING.headingGap)
    let subtitle: PPTElement | null = null
    if (c.subtitle) {
      const h = b.measure(c.subtitle, TYPE_SCALE.body, SAFE.width)
      subtitle = b.text({ left: SAFE.left, top: y, width: SAFE.width, height: h }, c.subtitle, {
        size: TYPE_SCALE.body, color: b.onPhoto(p.textMuted), textType: 'content',
      })
      y = snapY(y + h + SPACING.paragraphGap)
    }

    const gap = SPACING.gutter
    const cardW = (SAFE.width - gap * (n - 1)) / n
    const pad = SPACING.cardPadding
    const innerW = cardW - pad * 2
    const available = SAFE.bottom - y

    /**
     * 四栏时正文降到 caption(12)。
     *
     * 1000px 画布上四栏的栏内宽只有 142px，15px 正文一行放不下 9 个字，
     * 读起来是一条竖着的字带。字号降一级换来每行多两个字 ——
     * 这不是「变小更好看」，是**四栏本来就不该塞长正文**，降级是止损。
     */
    const bodySize = n >= 4 ? TYPE_SCALE.caption : TYPE_SCALE.body
    const headHs = items.map(it => b.measure(it.title ?? '', TYPE_SCALE.itemTitle, innerW, LINE_HEIGHT.heading, true))
    const bodyHs = items.map(it => (it.body ? b.measure(it.body, bodySize, innerW) : 0))

    // 卡片高度按**内容最多的那一张**定，所有卡片同高（并列块不等高就散了），
    // 但不再无条件撑到页底 —— 改之前卡片永远是「从这里到 SAFE.bottom」，
    // 于是三张短卡片下面各挂着 2/3 张空白板，那是版面空洞最扎眼的一处
    const cardBody = Math.max(...items.map((_, i) => headHs[i] + bodyHs[i]))
    const cardH = Math.min(available, pad * 2 + 24 + SPACING.paragraphGap + cardBody)
    // 卡片组在剩余空间里垂直居中
    const cardTop = snapY(y + Math.max(0, (available - cardH) / 2))

    b.animate(title, 'fade-down', 'click', 500)
    b.animate(bar, 'wipe', 'meantime', 400)
    b.animate(subtitle, 'fade-up', 'auto', 400)

    items.forEach((item, i) => {
      const left = SAFE.left + i * (cardW + gap)
      const card = b.shape('roundRect', { left, top: cardTop, width: cardW, height: cardH }, {
        fill: p.surface, ...cardDecor(p), name: `卡片 ${i + 1}`,
      })

      const tag = b.shape('pill', { left: left + pad, top: cardTop + pad, width: 44, height: 24 }, {
        fill: i === 0 ? p.accent : p.primary, name: `编号 ${i + 1}`,
      })
      const tagNum = b.text({ left: left + pad, top: cardTop + pad, width: 44, height: 24 }, String(i + 1).padStart(2, '0'), {
        size: TYPE_SCALE.caption, color: p.onPrimary, bold: true, align: 'center',
        lineHeight: LINE_HEIGHT.tight, vAlign: 'middle', textType: 'itemNumber',
      })

      const headTop = snapY(cardTop + pad + 24 + SPACING.paragraphGap)
      const head = b.text({ left: left + pad, top: headTop, width: innerW, height: headHs[i] }, item.title ?? '', {
        size: TYPE_SCALE.itemTitle, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'itemTitle',
      })

      const body = item.body
        ? b.text(
          { left: left + pad, top: snapY(headTop + headHs[i]), width: innerW, height: bodyHs[i] },
          item.body,
          { size: bodySize, color: b.onPhoto(p.textMuted), textType: 'item' },
        )
        : null

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

    const titleH = b.measure(c.title ?? '', TYPE_SCALE.title, SAFE.width, LINE_HEIGHT.heading, true)
    const title = b.text({ left: SAFE.left, top: SAFE.top, width: SAFE.width, height: titleH }, c.title ?? '', {
      size: TYPE_SCALE.title, color: p.text, bold: true, align: 'center', lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })

    const y = snapY(SAFE.top + titleH + SPACING.headingGap)
    const gap = SPACING.gutter * 2
    const colW = (SAFE.width - gap) / 2
    const pad = SPACING.cardPadding
    const innerW = colW - pad * 2
    const fills = [mixHex(p.background, p.primary, 0.14), mixHex(p.background, p.accent, 0.14)]
    const heads = [p.primary, p.accent]

    // 两栏等高（并列块不等高就散了），高度按**内容多的那一栏**定，
    // 但不再无条件撑到页底 —— 短内容时下面留一截，整组在剩余空间里居中
    const headHs = items.map(it => b.measure(it.title ?? '', TYPE_SCALE.subtitle, innerW, LINE_HEIGHT.heading, true))
    const bodyHs = items.map(it => (it.body ? b.measure(it.body, TYPE_SCALE.body, innerW) : 0))
    const maxRoom = SAFE.bottom - y
    const needed = Math.max(...items.map((_, i) => pad * 2 + headHs[i] + 8 + SPACING.headingGap + bodyHs[i]))
    const colH = Math.min(maxRoom, needed)
    const colTop = snapY(y + Math.max(0, (maxRoom - colH) / 2))

    const divider = b.line([0, 0], [0, colH], CANVAS_WIDTH / 2, colTop, p.border, 2)

    // 元素先全部建出来再统一编排 —— 这一页的节奏是「两栏一起动」，
    // 在 forEach 里边建边挂会把左右两栏的动画交叉排进序列，编排读不出来
    const cols = items.map((item, i) => {
      const left = SAFE.left + i * (colW + gap)
      const panel = b.shape('roundRect', { left, top: colTop, width: colW, height: colH }, {
        fill: fills[i], outline: { style: 'solid', width: 1, color: p.border }, name: `对比栏 ${i + 1}`,
      })

      const underline = b.shape('bar', { left: left + pad, top: snapY(colTop + pad + headHs[i] + 4), width: 40, height: 8 }, {
        fill: heads[i], name: `栏 ${i + 1} 下划条`,
      })
      const head = b.text({ left: left + pad, top: colTop + pad, width: innerW, height: headHs[i] }, item.title ?? '', {
        size: TYPE_SCALE.subtitle, color: heads[i], bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'itemTitle',
      })

      const body = item.body
        ? b.text(
          {
            left: left + pad,
            top: snapY(colTop + pad + headHs[i] + 8 + SPACING.headingGap),
            width: innerW,
            height: bodyHs[i],
          },
          item.body,
          { size: TYPE_SCALE.body, color: p.text, textType: 'item' },
        )
        : null

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

    const titleH = b.measure(c.title ?? '', TYPE_SCALE.title, SAFE.width, LINE_HEIGHT.heading, true)
    const title = b.text({ left: SAFE.left, top: SAFE.top, width: SAFE.width, height: titleH }, c.title ?? '', {
      size: TYPE_SCALE.title, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })
    const bar = b.shape('bar', { left: SAFE.left, top: snapY(SAFE.top + titleH + 4), width: 64, height: 10 }, {
      fill: p.accent, name: '强调条',
    })

    const nodeSize = 24
    const colW = SAFE.width / n
    const itemW = colW - 16

    /**
     * 轴线位置由**上下两侧实际需要多高**推出来，不再是写死的 `axisY = 300`。
     *
     * 标签在轴上、正文在轴下，两侧高度都跟着内容走。写死 300 的后果是
     * 标签长了就往上顶穿标题、正文长了就往下捅出页底，而两者都不报错。
     */
    const labelHs = items.map(it => b.measure(it.label ?? it.title ?? '', TYPE_SCALE.subtitle, itemW, LINE_HEIGHT.tight, true))
    const bodyTexts = items.map(it => (it.label ? [it.title, it.body].filter(Boolean).join('\n') : (it.body ?? '')))
    const bodyHs = bodyTexts.map(t => (t ? b.measure(t, TYPE_SCALE.body, itemW) : 0))

    const labelBand = Math.max(...labelHs)
    const bodyBand = Math.max(...bodyHs)
    const trackTop = snapY(SAFE.top + titleH + 14 + SPACING.headingGap)
    const trackH = SAFE.bottom - trackTop
    // 轴线放在「标签带 + 间距」之后，整条轨道再在剩余空间里居中
    const needed = labelBand + SPACING.paragraphGap + nodeSize + SPACING.paragraphGap + bodyBand
    const axisY = snapY(trackTop + Math.max(0, (trackH - needed) / 2) + labelBand + SPACING.paragraphGap + nodeSize / 2)

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

      // 标签在轴上方，正文在轴下方 —— 上下分置比全塞一边更好读。
      // 标签底部对齐（贴着轴），所以 top 要减掉自己的高度
      const label = b.text(
        {
          left: centerX - colW / 2 + 8,
          top: snapY(axisY - nodeSize / 2 - SPACING.paragraphGap - labelHs[i]),
          width: itemW,
          height: labelHs[i],
        },
        item.label ?? item.title ?? '',
        { size: TYPE_SCALE.subtitle, color: p.text, bold: true, align: 'center', lineHeight: LINE_HEIGHT.tight, textType: 'itemTitle' },
      )

      const body = bodyTexts[i]
        ? b.text(
          {
            left: centerX - colW / 2 + 8,
            top: snapY(axisY + nodeSize / 2 + SPACING.paragraphGap),
            width: itemW,
            height: bodyHs[i],
          },
          bodyTexts[i],
          { size: TYPE_SCALE.body, color: b.onPhoto(p.textMuted), align: 'center', textType: 'item' },
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

    const hasImage = !!c.image?.src

    /**
     * 文字栏宽。
     *
     * 改之前是雷打不动的 `SAFE.width - 300` —— 右边 300px 是**永久死区**，
     * 里面只有一个装饰光晕，内容再少也占不到那块地方。
     *
     * 现在两种情况都收窄，但理由不同：没图时留 240 给光晕；
     * **有图时留 38% 给照片** —— 一开始我给的是「有图就用全宽」，
     * 看截图才发现那样文字会压到照片最亮的部分，而且照片等于没露脸。
     * 配了图的版面就该把地方让给图，这是配图的意义所在。
     */
    const halo = hasImage ? null : b.shape('ellipse', { left: 620, top: 96, width: 340, height: 340 }, {
      fill: p.primary, opacity: 0.12, name: '装饰光晕',
    })
    const colW = hasImage ? Math.round(SAFE.width * 0.58) : SAFE.width - 240
    const [bgImage, scrim] = b.backdrop(c.image, 'left', (SAFE.left + colW + 40) / CANVAS_WIDTH)

    const eyebrowText = c.eyebrow || c.title || ''
    const noteText = stat.note || c.subtitle || ''
    // 数字本身也要能降级：「87%」和「87.4%」放得下，「1,284,309」按 88px 就出界了
    const valueSize = b.fit(stat.value, colW, 150, [TYPE_SCALE.stat, 72, TYPE_SCALE.display, 52], LINE_HEIGHT.tight, { bold: true })
    const valueH = b.measure(stat.value, valueSize, colW, LINE_HEIGHT.tight, true)
    const eyebrowH = b.measure(eyebrowText, TYPE_SCALE.eyebrow, colW, LINE_HEIGHT.tight, true)
    const labelH = b.measure(stat.label ?? '', TYPE_SCALE.subtitle, colW, LINE_HEIGHT.heading, true)
    const noteH = b.measure(noteText, TYPE_SCALE.body, colW)

    const rows = stack([
      ...(eyebrowText ? [{ height: eyebrowH }] : []),
      { height: valueH, gap: eyebrowText ? SPACING.paragraphGap / 2 : 0 },
      ...(stat.label ? [{ height: labelH, gap: SPACING.paragraphGap / 2 }] : []),
      { height: 10, gap: SPACING.paragraphGap },
      ...(noteText ? [{ height: noteH, gap: SPACING.paragraphGap }] : []),
    ], SAFE, 'middle')

    let i = 0
    const eyebrow = eyebrowText
      ? b.text({ left: SAFE.left, top: rows.tops[i++], width: colW, height: eyebrowH }, eyebrowText, {
        size: TYPE_SCALE.eyebrow, color: b.onPhoto(p.accent), bold: true, letterSpacing: 2,
        lineHeight: LINE_HEIGHT.tight, textType: 'header',
      })
      : null

    const value = b.text({ left: SAFE.left, top: rows.tops[i++], width: colW, height: valueH }, stat.value, {
      size: valueSize, color: b.onPhoto(p.primary), bold: true, lineHeight: LINE_HEIGHT.tight, textType: 'title',
      name: '关键数字',
    })

    const label = stat.label
      ? b.text({ left: SAFE.left, top: rows.tops[i++], width: colW, height: labelH }, stat.label, {
        size: TYPE_SCALE.subtitle, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'subtitle',
      })
      : null

    const barEl = b.shape('bar', { left: SAFE.left, top: rows.tops[i++], width: 72, height: 10 }, { fill: p.accent, name: '强调条' })

    const note = noteText
      ? b.text(
        { left: SAFE.left, top: rows.tops[i++], width: colW, height: noteH },
        noteText,
        { size: TYPE_SCALE.body, color: b.onPhoto(p.textMuted), textType: 'content' },
      )
      : null

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

    const quoteText = c.quote ?? ''
    const sourceText = c.source || c.subtitle || ''
    const quoteLeft = SAFE.left + 96
    /**
     * 有背景图时文字栏收窄到 62%，把右边让给照片。
     *
     * 这是**看截图改的**：第一版文字照旧横跨到 93% 宽，而渐变遮罩在那之前
     * 就淡完了，于是「没有界面」四个字正好压在亮蓝色机柜上，糊得看不清。
     * 当时的第一反应是「把渐变拉长」，但拉到 93% 就等于全屏均匀压，
     * 渐变白做了 —— **真正的问题不是遮罩太短，是文字太宽**：
     * 一个配了照片的版面本来就该给照片留出地方，那才是配图的意义。
     */
    const hasImage = !!c.image?.src
    const quoteRight = hasImage ? SAFE.left + Math.round(SAFE.width * 0.62) : SAFE.right
    const quoteW = quoteRight - quoteLeft

    // 遮罩一路罩到文字右边缘之后再淡出
    const [bgImage, scrim] = b.backdrop(c.image, 'left', (quoteRight + 40) / CANVAS_WIDTH)

    /**
     * 引述字号的候选从 display(64) 起跳，不再是 title(38) 封顶。
     *
     * 引用页是「呼吸页」，它的全部作用就是让一句话占住整个视觉中心。
     * 改之前一句十个字的引言按 38px 排在页面上方，下面空 253px ——
     * 实测 66 张样张里这一档的内容占比只有 18%，全场最低。
     * **不是留白，是没排完。** 短句就该放大到撑住版面。
     */
    const quoteSize = b.fit(quoteText, quoteW, 300, [
      TYPE_SCALE.display, 52, 44, TYPE_SCALE.title, TYPE_SCALE.subtitle, TYPE_SCALE.itemTitle,
    ], LINE_HEIGHT.heading)
    const quoteH = b.measure(quoteText, quoteSize, quoteW, LINE_HEIGHT.heading)
    // 引号跟着引述字号走，不再是写死的 140px 挤在 120px 的框里
    // （那个框实测渲染出来 161px，八个变体全部溢出，八次全都没人发现）
    const markSize = Math.round(quoteSize * 1.9)
    const markH = b.measure('“', markSize, 140, LINE_HEIGHT.tight, true)
    const sourceH = b.measure(sourceText, TYPE_SCALE.subtitle, quoteW - 64)

    const rows = stack([
      { height: quoteH },
      ...(sourceText ? [{ height: Math.max(sourceH, 28), gap: SPACING.headingGap }] : []),
    ], SAFE, 'middle')

    // 引号压在引述**第一行的左上角**，是排版记号不是独立元素
    const mark = b.text(
      { left: SAFE.left - 8, top: snapY(rows.tops[0] - markH * 0.42), width: 140, height: markH },
      '“',
      { size: markSize, color: b.onPhoto(p.accent), bold: true, lineHeight: LINE_HEIGHT.tight, name: '引号' },
    )

    const quote = b.text({ left: quoteLeft, top: rows.tops[0], width: quoteW, height: quoteH }, quoteText, {
      size: quoteSize, color: p.text, lineHeight: LINE_HEIGHT.heading, textType: 'content',
    })

    // 分隔条和出处在同一条基线上：条子高 8，出处框高 28，
    // 条子往下挪 10 才和文字的视觉中线对齐（改之前是出处往上挪 6，两者差着一截）
    const sourceTop = sourceText ? rows.tops[1] : 0
    const rule = sourceText
      ? b.shape('bar', { left: quoteLeft, top: snapY(sourceTop + 10), width: 48, height: 8 }, { fill: p.border, name: '分隔条' })
      : b.shape('bar', { left: quoteLeft, top: snapY(rows.tops[0] + quoteH + SPACING.headingGap), width: 48, height: 8 }, { fill: p.border, name: '分隔条' })

    const source = sourceText
      ? b.text({ left: quoteLeft + 64, top: sourceTop, width: quoteW - 64, height: Math.max(sourceH, 28) }, sourceText, {
        size: TYPE_SCALE.subtitle, color: b.onPhoto(p.textMuted), textType: 'footer',
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

    // 居中构图，理由同 title-center
    const [bgImage, scrim] = b.backdrop(c.image, 'none')
    const hasImage = !!c.image?.src

    const titleSize = b.fit(c.title ?? '', SAFE.width, 160, DISPLAY_STEPS, LINE_HEIGHT.heading, { bold: true })
    const titleH = b.measure(c.title ?? '', titleSize, SAFE.width, LINE_HEIGHT.heading, true)
    const subH = b.measure(c.subtitle ?? '', TYPE_SCALE.subtitle, SAFE.width)

    const rows = stack([
      { height: titleH },
      { height: 12, gap: SPACING.headingGap },
      ...(c.subtitle ? [{ height: subH, gap: SPACING.headingGap }] : []),
    ], SAFE, 'middle')

    /**
     * 装饰环绕着标题，而且有图时不画。
     *
     * 有图不画：和 title-split 的装饰环、stat 的光晕同一条 —— 半透明圆环叠在
     * 照片上像块污渍。R-48 只修了 title-split 那一处，另外两处漏了整整一轮。
     *
     * 位置：改之前是写死的 `top: 120`，标题在 210，于是环的中心（250）
     * 和标题中心差着几十像素 —— 注释写着「绕着标题转」，画出来是绕着标题上方转
     */
    const ringSize = 260
    const ring = hasImage ? null : b.shape('donut', {
      left: (CANVAS_WIDTH - ringSize) / 2,
      top: snapY(rows.tops[0] + titleH / 2 - ringSize / 2),
      width: ringSize,
      height: ringSize,
    }, { fill: p.primary, opacity: 0.12, name: '装饰环' })

    const title = b.text({ left: SAFE.left, top: rows.tops[0], width: SAFE.width, height: titleH }, c.title ?? '', {
      size: titleSize, color: p.text, bold: true, align: 'center',
      lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })

    const bar = b.shape('bar', { left: (CANVAS_WIDTH - 72) / 2, top: rows.tops[1], width: 72, height: 12 }, {
      fill: p.accent, name: '强调条',
    })

    const subtitle = c.subtitle
      ? b.text(
        { left: SAFE.left, top: rows.tops[2], width: SAFE.width, height: subH },
        c.subtitle,
        { size: TYPE_SCALE.subtitle, color: b.onPhoto(p.textMuted), align: 'center', textType: 'subtitle' },
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

  /**
   * 图文网格：2~3 个「图 + 标题 + 说明」块并排。
   *
   * 第十九轮判过 cards / compare / timeline「版面已被并列块占满，塞不下图」——
   * 那个结论是对的，但它缺了下半句：**并列块本来就该有一种自带图位的形态**。
   * 硬把图塞进 cards 会挤成邮票，而图文网格是从一开始就按「图占上半、字占下半」
   * 分配版面的，两者不是同一个版式。
   */
  'image-grid': (b, c) => {
    const p = b.palette
    const items = clampItems(c.items, 2, 3)
    const n = items.length

    const titleH = b.measure(c.title ?? '', TYPE_SCALE.title, SAFE.width, LINE_HEIGHT.heading, true)
    const title = b.text({ left: SAFE.left, top: SAFE.top, width: SAFE.width, height: titleH }, c.title ?? '', {
      size: TYPE_SCALE.title, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })
    const bar = b.shape('bar', { left: SAFE.left, top: snapY(SAFE.top + titleH + 4), width: 64, height: 10 }, {
      fill: p.accent, name: '强调条',
    })

    let y = snapY(SAFE.top + titleH + 14 + SPACING.headingGap)
    let subtitle: PPTElement | null = null
    if (c.subtitle) {
      const h = b.measure(c.subtitle, TYPE_SCALE.body, SAFE.width)
      subtitle = b.text({ left: SAFE.left, top: y, width: SAFE.width, height: h }, c.subtitle, {
        size: TYPE_SCALE.body, color: p.textMuted, textType: 'content',
      })
      y = snapY(y + h + SPACING.paragraphGap)
    }

    const gap = SPACING.gutter
    const colW = (SAFE.width - gap * (n - 1)) / n
    const available = SAFE.bottom - y

    const headHs = items.map(it => b.measure(it.title ?? '', TYPE_SCALE.itemTitle, colW, LINE_HEIGHT.heading, true))
    const bodyHs = items.map(it => (it.body ? b.measure(it.body, TYPE_SCALE.body, colW) : 0))
    const textBand = Math.max(...items.map((_, i) => headHs[i] + bodyHs[i]))

    /**
     * 图片带的高度 = 剩下的全部，但**不低于 120**。
     *
     * 低于这个高度的「配图」在投影上就是一条彩色横带，看不出画的是什么 ——
     * 那种图不如不配。放不下就让文字挤一点，图必须像张图。
     */
    const figureH = Math.max(120, available - textBand - SPACING.paragraphGap)
    const textTop = snapY(y + figureH + SPACING.paragraphGap)

    b.animate(title, 'fade-down', 'click', 500)
    b.animate(bar, 'wipe', 'meantime', 400)
    b.animate(subtitle, 'fade-up', 'auto', 400)

    items.forEach((item, i) => {
      const left = SAFE.left + i * (colW + gap)
      const box = { left, top: y, width: colW, height: figureH }

      // 有图放图，没图放一块主色板 —— 三个格子里两个有图一个没有时，
      // 空着那个会让整排看起来像加载失败
      const figure = item.image?.src
        ? b.image(box, item.image, { imageType: 'itemFigure', name: `配图 ${i + 1}` })
        : b.shape('roundRect', box, {
          fill: mixHex(p.background, i === 0 ? p.accent : p.primary, 0.16), name: `图位 ${i + 1}`,
        })

      const head = b.text({ left, top: textTop, width: colW, height: headHs[i] }, item.title ?? '', {
        size: TYPE_SCALE.itemTitle, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'itemTitle',
      })
      const body = item.body
        ? b.text({ left, top: snapY(textTop + headHs[i]), width: colW, height: bodyHs[i] }, item.body, {
          size: TYPE_SCALE.body, color: p.textMuted, textType: 'item',
        })
        : null

      // 一格是一个整体：图和它下面的字同一步出场
      b.animate(figure, 'fade-up', i === 0 ? 'click' : 'auto', 500)
      b.animate(head, 'fade-up', 'meantime', 400)
      b.animate(body, 'fade-up', 'meantime', 400)
    })

    return { background: { type: 'solid', color: p.background }, slideType: 'content' }
  },

  /**
   * 左图右列：左边一张出血大图，右边标题 + 2~4 条要点。
   *
   * 这是 `bullets` / `cards` 想配图时的正解 —— 图不去挤条目的地方，
   * 而是各占半壁。第十九轮「cards / compare / timeline 不吃图」留下的缺口，
   * 内容上大半由它接住。
   */
  'split-figure': (b, c) => {
    const p = b.palette
    const items = clampItems(c.items, 2, 4)
    const figureW = Math.round(CANVAS_WIDTH * 0.42)
    const colLeft = figureW + SPACING.gutter
    const colW = SAFE.right - colLeft

    // 图先放：PPTist 的层级就是数组顺序。左侧四周出血，不留白边 ——
    // 四周留白的照片在版面里像贴纸，出血才是版面感的来源
    const figure = c.image?.src
      ? b.image({ left: 0, top: 0, width: figureW, height: CANVAS_HEIGHT }, c.image, {
        imageType: 'pageFigure', name: '配图',
      })
      : b.shape('rect', { left: 0, top: 0, width: figureW, height: CANVAS_HEIGHT }, {
        fill: p.primary, name: '主色块',
      })

    const titleH = b.measure(c.title ?? '', TYPE_SCALE.title, colW, LINE_HEIGHT.heading, true)
    const subH = c.subtitle ? b.measure(c.subtitle, TYPE_SCALE.body, colW) : 0
    const headHs = items.map(it => b.measure(it.title ?? '', TYPE_SCALE.itemTitle, colW - 24, LINE_HEIGHT.heading, true))
    const bodyHs = items.map(it => (it.body ? b.measure(it.body, TYPE_SCALE.body, colW - 24) : 0))

    const rows = stack([
      { height: titleH },
      { height: 10, gap: 12 },
      ...(c.subtitle ? [{ height: subH, gap: SPACING.paragraphGap }] : []),
      ...items.map((_, i) => ({
        height: Math.max(28, headHs[i] + bodyHs[i]),
        gap: SPACING.paragraphGap,
      })),
    ], SAFE, 'middle')

    let i = 0
    const title = b.text({ left: colLeft, top: rows.tops[i++], width: colW, height: titleH }, c.title ?? '', {
      size: TYPE_SCALE.title, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })
    const bar = b.shape('bar', { left: colLeft, top: rows.tops[i++], width: 56, height: 10 }, {
      fill: p.accent, name: '强调条',
    })
    const subtitle = c.subtitle
      ? b.text({ left: colLeft, top: rows.tops[i++], width: colW, height: subH }, c.subtitle, {
        size: TYPE_SCALE.body, color: p.textMuted, textType: 'content',
      })
      : null

    b.animate(title, 'fade-left', 'click', 500)
    b.animate(bar, 'wipe', 'meantime', 400)
    // 图和标题同步擦入 —— 它是版面的一半，不该等条目讲完才出现
    b.animate(figure, 'wipe', 'meantime', 700)
    b.animate(subtitle, 'fade-up', 'auto', 400)

    const rowStart = i
    items.forEach((item, k) => {
      const top = rows.tops[rowStart + k]
      const dot = b.shape('ellipse', { left: colLeft, top: snapY(top + 6), width: 10, height: 10 }, {
        fill: k === 0 ? p.accent : p.primary, name: `圆点 ${k + 1}`,
      })
      const head = b.text({ left: colLeft + 24, top, width: colW - 24, height: headHs[k] }, item.title ?? '', {
        size: TYPE_SCALE.itemTitle, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'itemTitle',
      })
      const body = item.body
        ? b.text({ left: colLeft + 24, top: snapY(top + headHs[k]), width: colW - 24, height: bodyHs[k] }, item.body, {
          size: TYPE_SCALE.body, color: p.textMuted, textType: 'item',
        })
        : null

      b.animate(dot, 'zoom-in', k === 0 ? 'auto' : 'auto', 300)
      b.animate(head, 'fade-left', 'meantime', 400)
      b.animate(body, 'fade-left', 'meantime', 400)
    })

    return { background: { type: 'solid', color: p.background }, slideType: 'content' }
  },

  /**
   * 满屏图 + 浮层卡片：整幅照片当背景，文字装在一块**实心**卡片里。
   *
   * 和 backdrop 那几个版式的区别是关键：backdrop 靠半透明遮罩压住照片，
   * 文字直接压在图上；这一页把文字关进一块不透明的卡片 ——
   * **对比度由卡片保证，和照片有多亮完全无关**。
   *
   * 所以它是「照片很花、很亮、或者亮度信息缺失」时的稳妥选择，
   * 视觉冲击又比纯色页强得多。遮罩仍然上一层薄的，让卡片浮起来而不是贴上去。
   */
  'full-figure': (b, c) => {
    const p = b.palette

    // 薄遮罩：这里不承担可读性（卡片承担），只负责把照片压暗一点让卡片浮起来。
    // 所以固定 0.3 而不是按亮度算 —— 它不是对比度手段
    const bgImage = c.image?.src
      ? b.image({ left: 0, top: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT }, c.image, {
        imageType: 'background', name: '背景图',
      })
      : null
    const scrim = bgImage
      ? b.shape('rect', { left: 0, top: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT }, {
        fill: p.background, opacity: 0.3, name: '背景遮罩',
      })
      : null

    const cardW = Math.round(CANVAS_WIDTH * 0.52)
    const pad = SPACING.cardPadding + 8
    const innerW = cardW - pad * 2

    const eyebrowH = c.eyebrow ? b.measure(c.eyebrow, TYPE_SCALE.eyebrow, innerW, LINE_HEIGHT.tight, true) : 0
    const titleSize = b.fit(c.title ?? '', innerW, 200, [TYPE_SCALE.display, 52, 44, TYPE_SCALE.title], LINE_HEIGHT.heading, { bold: true })
    const titleH = b.measure(c.title ?? '', titleSize, innerW, LINE_HEIGHT.heading, true)
    const subH = c.subtitle ? b.measure(c.subtitle, TYPE_SCALE.subtitle, innerW) : 0

    const inner = (c.eyebrow ? eyebrowH + SPACING.paragraphGap : 0)
      + titleH
      + (c.subtitle ? subH + SPACING.headingGap : 0)
    const cardH = Math.min(SAFE.height + 32, inner + pad * 2)
    const cardTop = snapY((CANVAS_HEIGHT - cardH) / 2)

    // 卡片是实心的：文字的对比度全靠它，所以**不能半透明**
    const card = b.shape('rect', { left: SAFE.left, top: cardTop, width: cardW, height: cardH }, {
      fill: p.background,
      shadow: { h: 0, v: 8, blur: 28, color: p.dark ? '#00000088' : '#00000029' },
      name: '浮层卡片',
    })
    const edge = b.shape('rect', { left: SAFE.left, top: cardTop, width: 8, height: cardH }, {
      fill: p.accent, name: '卡片边条',
    })

    let y = snapY(cardTop + pad)
    const eyebrow = c.eyebrow
      ? b.text({ left: SAFE.left + pad, top: y, width: innerW, height: eyebrowH }, c.eyebrow, {
        size: TYPE_SCALE.eyebrow, color: p.accent, bold: true, letterSpacing: 2,
        lineHeight: LINE_HEIGHT.tight, textType: 'header',
      })
      : null
    if (c.eyebrow) y = snapY(y + eyebrowH + SPACING.paragraphGap)

    const title = b.text({ left: SAFE.left + pad, top: y, width: innerW, height: titleH }, c.title ?? '', {
      size: titleSize, color: p.text, bold: true, lineHeight: LINE_HEIGHT.heading, textType: 'title',
    })
    y = snapY(y + titleH + SPACING.headingGap)

    const subtitle = c.subtitle
      ? b.text({ left: SAFE.left + pad, top: y, width: innerW, height: subH }, c.subtitle, {
        size: TYPE_SCALE.subtitle, color: p.textMuted, textType: 'subtitle',
      })
      : null

    // 卡片和标题同一步：卡片先飞进来再等文字出现，就是「一块板子从文字底下升上来」
    b.animate(title, 'fade-left', 'click', 600)
    b.animate(card, 'wipe', 'meantime', 600)
    b.animate(edge, 'wipe-down', 'meantime', 500)
    b.animate(eyebrow, 'fade-left', 'meantime', 400)
    b.animate(bgImage, 'fade', 'meantime', 800)
    b.animate(scrim, 'fade', 'meantime', 800)
    b.animate(subtitle, 'fade-up', 'auto', 400)

    return { background: { type: 'solid', color: p.background }, slideType: 'content' }
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

  for (const [i, it] of (content.items ?? []).entries()) {
    if (!it.image?.src) continue
    if (!meta.itemImage) {
      const usable = LAYOUT_PATTERNS.filter(x => LAYOUT_META[x].itemImage).join(' / ')
      return `版式 "${pattern}" 的条目不吃图（items[].image）。要每条配图请改用：${usable}`
    }
    if (!ASSET_SRC.test(it.image.src)) {
      return `items[${i}].image.src 必须是 searchImage / generateImage 返回的 asset:// 地址，收到 "${it.image.src.slice(0, 60)}"`
    }
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
  options: {
    animate?: boolean, typography?: TypeRecipe, style?: PaletteStyle,
    /** R-60: 结构变体。'B' 且有变体的版式走 `LAYOUT_VARIANTS`，其余一律 A */
    variant?: 'A' | 'B',
  } = {},
): LayoutResult => {
  /**
   * 没传字体配对时用「宋黑经典」。
   *
   * 默认值放在这里而不是 `Builder` 的构造参数上：`Builder` 是内部类，
   * 给它默认值等于让「忘了传」变成一个没人会发现的分支；而 `buildLayout`
   * 是对外那一层，在这里默认是一条**产品决策**（不选就给最稳的那套），
   * 写在这儿才有人看得见。
   */
  const builder = new Builder(idPrefix, palette, options.typography ?? TYPOGRAPHY_PAIRS.classic)

  /**
   * signature 先画 —— 它必须排在元素数组最前面才会渲染在最底层。
   *
   * 它**刻意不挂动画**：记忆点应该一开场就在那儿，而不是跟着内容一起飞进来。
   * `lintSlideAnimationOrder` 只管文本有没有挂动画，形状没挂不会被报。
   */
  if (wantsSignature(pattern, content)) {
    // R-60：变体由主题锚点色的哈希决定 —— 同一份稿子稳定、不同稿子分散
    drawSignature(builder, options.style ?? 'business', signatureVariant(palette))
  }

  // R-60：B 变体走 LAYOUT_VARIANTS（没有变体的版式传了 B 也落回 A ——
  // 变体是「同版式的另一种结构」，不是随便一个字母）
  const layoutFn = options.variant === 'B' && LAYOUT_VARIANTS[pattern]
    ? LAYOUT_VARIANTS[pattern]!
    : LAYOUTS[pattern]
  const { background, slideType } = layoutFn(builder, content)

  return {
    elements: builder.elements,
    animations: options.animate === false ? [] : builder.animations,
    background,
    slideType,
    clampedIds: builder.clampedIds,
    signatureIds: builder.signatureIds,
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
      : m.image === 'overlay'
        ? '，**可配图**（满屏背景图 + 实心浮层卡片装文字，照片再花也读得清）'
        : m.image === 'panel'
          ? '，**可配图**（占一侧的整幅配图，文字自动缩到另一栏）'
          : m.itemImage
            ? '，**每条各配一张图**（填 items[].image，不是 content.image）'
            : ''
    const variantB = m.variantB ? `，**变体 B**：${m.variantB}` : ''
    return `- ${p}（${m.name}）：${m.usage}${items}${image}${variantB}`
  }).join('\n')
