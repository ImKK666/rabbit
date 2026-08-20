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

import type { SlideTheme, Gradient } from '@/types/slides'

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

/**
 * 安全区：左右上下都留出页边距之后的可用区域。
 *
 * **上下不对称是故意的**（56 / 64）。古典书籍排版里叫「光学底重」：
 * 版心正中在视觉上偏低，底边留得比顶边多一点，整页才显得「立住了」而不是往下坠。
 * 严格居中反而看着像掉下去。差 8px 说不出哪里不一样，但并排一看就是它。
 */
export const SAFE = {
  left: SPACING.margin,
  top: UNIT * 7, // 56
  right: CANVAS_WIDTH - SPACING.margin,
  bottom: CANVAS_HEIGHT - UNIT * 8, // 498.5 —— 比顶边多 8，光学底重
  get width() {
    return this.right - this.left
  },
  get height() {
    return this.bottom - this.top
  },
}

/**
 * 把纵坐标吸附到 8px 基线栅格。
 *
 * **只吸附纵向，横向不动。** 纵向是「基线栅格」——所有文本块落在同一套刻度上，
 * 版面才有节奏；横向的居中是光学的，`(1000-96)/2 = 452` 吸附成 456 就真的偏了。
 *
 * 为什么需要它：版式引擎里位置是 `y += 估出来的高度 + 间距` 一路累加的，
 * 而估出来的高度是任意实数，于是**第一个元素之后的所有元素都飘离栅格**。
 * 实测第二十轮之前 511 个元素里 388 个（76%）不落在栅格上 ——
 * 而 `design.ts` 的注释从第一天起就写着「所有间距都是 8 的整数倍」。
 * 注释描述的是意图，`snapY` 才是执行。
 *
 * 栅格锚在 0，而 `SAFE.top = 56 = 7×8` 本来就在格上，所以顶边对齐天然成立。
 * 画布高 562.5 不是 8 的整数倍，底边对不齐 —— 基线栅格本来就只锚一头。
 */
export const snapY = (v: number): number => Math.round(v / UNIT) * UNIT

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

/** 正文对比度目标。WCAG AA 对普通字号要求 4.5:1 */
export const CONTRAST_AA = 4.5

/** 压在 bg 上时该用黑字还是白字 */
export const readableOn = (bg: string): string =>
  contrastRatio(bg, '#ffffff') >= contrastRatio(bg, '#111111') ? '#ffffff' : '#111111'

/**
 * 配色风格包。
 *
 * ## 为什么风格是「模型选」而具体色值是「代码定」
 *
 * 这条分工和第十七轮「搜图还是生图由模型决定」是同一条：
 * **选哪个风格是内容决策**（一份学术汇报和一份产品发布会本来就该长得不一样，
 * 而只有模型知道这份稿子是什么），**风格里的九个色值是排版决策**
 * （交给模型就是随机挑六个色，那正是第六轮诊断 ④ 说的事）。
 *
 * 所以这里不给模型调色盘，只给四个名字。
 *
 * ## 每个包改的是什么
 *
 * 风格包**不换主色** —— 主色来自用户的主题，换掉就是把用户的品牌色扔了。
 * 它调的是那些「推导出来的」角色：底色的冷暖、卡片与背景的分离度、
 * 描边的轻重、次要文字的弱化程度。这几样正好是「看着高级 / 看着廉价」的分水岭。
 */
export type PaletteStyle = 'business' | 'tech' | 'academic' | 'vivid'

interface StyleRecipe {
  label: string
  /** 什么场合用 —— 进 prompt */
  usage: string
  /**
   * 冷暖基调：**只染 surface / border / textMuted 这些推导出来的角色，不碰背景色**。
   *
   * 第一版写的是「背景往这个色偏一点点」，被 `design.test.ts` 当场挡下来了 ——
   * 那条测试断言「主题给什么背景色就用什么」。测试是对的，而我在同一次改动的
   * 注释里还写着「不动用户主题里的背景色」：**注释说的是原则，代码做的是另一回事**。
   * 页面底色是用户的品牌资产，风格包无权改；卡片底、描边、弱化文字才是它的地盘。
   */
  tint: string
  tintAmount: number
  /** surface 与 background 拉开多少（浅色主题 / 深色主题） */
  surfaceLift: [number, number]
  /** 描边浓度 */
  borderAmount: number
  /** 次要文字被冲淡多少 */
  mutedAmount: number
  /** 强调色的饱和方向：往这个色混一点 */
  accentShift?: { color: string, amount: number }
}

export const PALETTE_STYLES: Record<PaletteStyle, StyleRecipe> = {
  /** 商务：中性偏暖灰，分离度低、描边细 —— 克制是它的全部 */
  business: {
    label: '商务',
    usage: '汇报、提案、董事会材料。克制、稳重，不抢内容',
    tint: '#8a7f72',
    tintAmount: 0.02,
    surfaceLift: [0.035, 0.07],
    borderAmount: 0.16,
    mutedAmount: 0.4,
  },
  /** 科技：冷调，卡片与背景拉得更开，描边更亮 —— 层次靠「面」而不是靠线 */
  tech: {
    label: '科技',
    usage: '产品发布、技术方案、数据看板。冷调、对比强、有层次',
    tint: '#3b6ea8',
    tintAmount: 0.04,
    surfaceLift: [0.06, 0.11],
    borderAmount: 0.22,
    mutedAmount: 0.36,
    accentShift: { color: '#22d3ee', amount: 0.18 },
  },
  /** 学术：几乎纯中性，分离度最低，强调色去饱和 —— 论文风不要花 */
  academic: {
    label: '学术',
    usage: '论文汇报、研究综述、教学讲义。极简、去饱和、信息优先',
    tint: '#000000',
    tintAmount: 0.01,
    surfaceLift: [0.025, 0.05],
    borderAmount: 0.14,
    mutedAmount: 0.45,
    accentShift: { color: '#6b7280', amount: 0.3 },
  },
  /** 活泼：暖调，强调色更饱和，描边更重 —— 用在内部分享、宣讲 */
  vivid: {
    label: '活泼',
    usage: '内部分享、宣讲、面向大众的介绍。暖调、饱和、有情绪',
    tint: '#ff8a4c',
    tintAmount: 0.045,
    surfaceLift: [0.07, 0.12],
    borderAmount: 0.2,
    mutedAmount: 0.32,
    accentShift: { color: '#f97316', amount: 0.22 },
  },
}

export const isPaletteStyle = (v: unknown): v is PaletteStyle =>
  typeof v === 'string' && v in PALETTE_STYLES

// ---------------------------------------------------------------------------
// 字体配对
// ---------------------------------------------------------------------------

/**
 * ## 为什么字体是「模型选」而配对是「代码定」
 *
 * 和上面 `PALETTE_STYLES` 那条分工逐字相同：**选哪套字是内容决策**
 * （一份讲书法的稿子该用楷体、一份讲芯片的该用 MiSans，而只有模型知道
 * 这份稿子是什么），**display 配哪个 body、字宽表是多少，是排版决策**
 * （给模型 21 个字体自由组合，组出来的就是随机两个字）。
 *
 * 所以这里不给模型字体库，只给六个名字。
 *
 * ## 为什么和 `PaletteStyle` 拆成两维而不是绑在一起
 *
 * 绑在一起只有 4 种长相，而且把两个不同的判断挤进了一个选择：
 * 「这份稿子的**场合**」（决定配色的冷暖克制）和「这份稿子的**题材**」
 * （决定字的性格）本来就是两件事。拆开之后是 4 × 6 —— 学术配色 + 朱雀仿宋
 * 是一份文史论文，学术配色 + MiSans 是一份理工论文，这个区别是真实存在的。
 *
 * 组合不做硬拦（模型选了就是选了），只在 `lintDeckDesign` 里按
 * `formality` 差值报 warning —— 护栏是判据，不是禁令。
 */
export type TypographyPair
  = 'classic' | 'scholarly' | 'editorial' | 'minimal' | 'impact' | 'warm'

export interface TypeRecipe {
  label: string
  /** 什么场合用 —— 进 prompt */
  usage: string
  /** 标题字族：字号 ≥ `DISPLAY_MIN` 的元素用它 */
  display: FontFamily
  /** 正文字族 */
  body: FontFamily
  /**
   * 正式度 0~10。只用来和 `PALETTE_STYLES` 的同名分做差值 lint ——
   * 「学术配色 + 温暖手写」这种组合不该硬拦，但值得提一句。
   */
  formality: number
}

export const TYPOGRAPHY_PAIRS: Record<TypographyPair, TypeRecipe> = {
  /** 宋体标题 + 黑体正文，中文排版里最稳的「有设计感」组合 */
  classic: {
    label: '宋黑经典',
    usage: '汇报、提案、董事会材料。标题有分量，正文干净',
    display: 'SourceHanSerif',
    body: 'AlibabaPuHuiTi',
    formality: 8,
  },
  /** 全思源，去性格，信息优先 */
  scholarly: {
    label: '学术克制',
    usage: '论文汇报、研究综述、教学讲义。不抢内容',
    display: 'SourceHanSerif',
    body: 'SourceHanSans',
    formality: 9,
  },
  /** 现代宋做标题，有编辑部那种「这是一篇文章」的味道 */
  editorial: {
    label: '编辑部',
    usage: '行业观察、深度分享、长文改稿。像一篇有观点的文章',
    display: 'LXGWNeoZhiSong',
    body: 'SourceHanSans',
    formality: 6,
  },
  /** 无衬线到底，几何感 */
  minimal: {
    label: '纯黑体极简',
    usage: '数据看板、技术方案、极简风。结构优先',
    display: 'MiSans',
    body: 'SourceHanSans',
    formality: 6,
  },
  /**
   * 得意黑做标题。
   *
   * **它的字身比别家窄两成**（cjk 0.800，见 `CHAR_WIDTH_BY_FONT`）——
   * 同样 64px 字号，视觉上比思源小一圈。这是它的设计，不是 bug；
   * 版式引擎按实测表排，不用补偿。但调字号时要知道这回事。
   */
  impact: {
    label: '几何科技',
    usage: '产品发布、技术方案、对外宣讲。标题要有冲击力',
    display: 'DeYiHei',
    body: 'MiSans',
    formality: 5,
  },
  /** 楷体的手写感，最不像 PPT 的一套 */
  warm: {
    label: '温暖手写',
    usage: '内部分享、面向大众的介绍、教学。想显得亲切',
    display: 'LXGWWenKai',
    body: 'LXGWNeoXiHei',
    formality: 3,
  },
}

/** 字号到了这一档就用 display 字族。`measure` 和 `text` 必须用同一条规则 */
export const DISPLAY_MIN = TYPE_SCALE.title

/**
 * 走不到版式引擎的那些地方用的字族 —— 形状里的文字、表格单元格。
 *
 * 它们是 agent 直接调 `addShape` / `addTable` 加的，不经过 `buildLayout`，
 * 所以拿不到这一页选的 `TypeRecipe`。取 `classic.body` 和 `buildLayout`
 * 的默认对齐，至少「什么都不选」时整份是一致的。
 *
 * **已知缺口**：agent 选了别的配对时，形状文字和表格仍是这一个 ——
 * 一份 `impact`（得意黑 / MiSans）的稿子里，表格会是阿里普惠体。
 * 补法是让 `theme.fontName` 承载配对的 body 字族（它已经被表格读了，
 * 而且一直是空字符串没人写过），但那是 deck 级状态，得单独立判据。
 */
export const DEFAULT_BODY_FONT: FontFamily = TYPOGRAPHY_PAIRS.classic.body

/** 一个元素该用哪个字族 —— 唯一的判据是字号 */
export const fontForSize = (size: number, recipe: TypeRecipe): FontFamily =>
  size >= DISPLAY_MIN ? recipe.display : recipe.body

export const isTypographyPair = (v: unknown): v is TypographyPair =>
  typeof v === 'string' && v in TYPOGRAPHY_PAIRS

/** 给 prompt 用的配对清单 —— 和 `describePaletteStyles` 一样，加一个配对 prompt 里自动就有 */
export const describeTypographyPairs = (): string =>
  (Object.keys(TYPOGRAPHY_PAIRS) as TypographyPair[])
    .map(k => `- ${k}（${TYPOGRAPHY_PAIRS[k].label}）：${TYPOGRAPHY_PAIRS[k].usage}`)
    .join('\n')

/**
 * 配色风格的正式度，和 `TypeRecipe.formality` 同一把尺子。
 *
 * 单独一张表而不是加进 `StyleRecipe`：`PALETTE_STYLES` 的每个字段都在
 * 参与配色推导，而这个数只服务 lint，混进去会让人以为它也影响颜色。
 */
export const PALETTE_FORMALITY: Record<PaletteStyle, number> = {
  business: 8,
  academic: 9,
  tech: 5,
  vivid: 3,
}

/** 正式度差多少算「值得提一句」。4 是刚好放过「商务 + 几何科技」（差 3）的那条线 */
export const FORMALITY_GAP_LIMIT = 4

/** 给 prompt 用的风格清单 —— 和 `describeLayouts` 一样，加一个风格 prompt 里自动就有 */
export const describePaletteStyles = (): string =>
  (Object.keys(PALETTE_STYLES) as PaletteStyle[])
    .map(k => `- ${k}（${PALETTE_STYLES[k].label}）：${PALETTE_STYLES[k].usage}`)
    .join('\n')

/**
 * 从 SlideTheme 推出一套完整的颜色角色。
 *
 * 主题只给了 backgroundColor / fontColor / themeColors[]，
 * 剩下的（surface / border / textMuted / accent）都是推出来的 ——
 * 让 agent 逐个挑颜色，挑出来的必然是随机的六个色。
 *
 * `style` 只影响推导出来的那几个角色，**不动用户主题里的 primary 和背景色**。
 */
export const buildPalette = (
  theme: SlideTheme,
  override?: Partial<Palette>,
  style: PaletteStyle = 'business',
): Palette => {
  const recipe = PALETTE_STYLES[style] ?? PALETTE_STYLES.business
  const background = parseHex(theme.backgroundColor) ? theme.backgroundColor : '#ffffff'
  const dark = luminance(background) < 0.4

  const themeColors = (theme.themeColors ?? []).filter(c => !!parseHex(c))
  const primary = themeColors[0] ?? (dark ? '#4f7df3' : '#2f6feb')
  // 强调色取主题里离主色最远的那个，退化时用主色偏移
  const baseAccent = themeColors.slice(1).sort(
    (a, b) => hueDistance(primary, b) - hueDistance(primary, a),
  )[0] ?? mixHex(primary, dark ? '#ffd166' : '#f2596b', 0.7)
  const accent = recipe.accentShift
    ? mixHex(baseAccent, recipe.accentShift.color, recipe.accentShift.amount)
    : baseAccent

  const text = parseHex(theme.fontColor) && contrastRatio(theme.fontColor, background) >= 3
    ? theme.fontColor
    : readableOn(background)

  // 先按风格把 surface 与背景拉开，再染一点冷暖 —— 顺序不能反：
  // 先染色再拉开的话，拉开那一步会把刚染上的色又冲淡回去
  const surface = mixHex(
    mixHex(background, dark ? '#ffffff' : '#000000', recipe.surfaceLift[dark ? 1 : 0]),
    recipe.tint,
    recipe.tintAmount,
  )

  return {
    background,
    surface,
    primary,
    accent,
    text,
    textMuted: mixHex(text, background, recipe.mutedAmount),
    onPrimary: readableOn(primary),
    border: mixHex(mixHex(background, text, recipe.borderAmount), recipe.tint, recipe.tintAmount),
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
 * PPTist 文本元素的默认内边距（`BaseTextElement.vue` 的 `inset` 默认 `[10,10,10,10]`）。
 *
 * **这 20px 以前从来没被算进去过**，是第二十轮查出的文字互压的头号原因之一：
 * 估算拿的是元素框宽，而文字实际只能用 `框宽 - 20`。在四栏卡片
 * 142px 的栏内宽上，20px 是 14% —— 每行少放一个多字，长文案必然多出一行。
 */
export const TEXT_INSET = 10

/**
 * 版式引擎自己用的内边距（上、右、下、左）。
 *
 * **纵向 0、横向 6**，而不是沿用 PPTist 的默认 `[10,10,10,10]`。
 *
 * 那个默认值是给**手工编辑**用的：留一圈边好让人抓得住框、拖得动。
 * 版式引擎不需要 —— 它自己用 `stack` 显式算间距，再叠一层不可见的内边距
 * 只会让「框有多高」和「字有多高」永远差 20px，而**那 20px 是会累加的**：
 * 六条要点是 12 个文本框，光内边距就吃掉 240px，而版心一共只有 442px。
 * 改造过程中六条要点排不下、只能一路降字号到 11px，根子就在这里。
 *
 * 横向留 6 不留 0：文字贴着框边在带 `fill` 的文本上会直接糊到边缘，
 * 而且和旁边的形状对齐时视觉上会偏 —— 光学边距不是浪费。
 */
export const LAYOUT_INSET: [number, number, number, number] = [0, 6, 0, 6]

/**
 * 段间距（`prosemirror.scss` 里 `p { margin-top: var(--paragraphSpace) }`，默认 5px，
 * 首段除外）。`richText` 把每个 `\n` 拆成一个 `<p>`，所以多行文本每多一行就多 5px。
 * 同样从来没被算进去过。
 */
export const PARAGRAPH_SPACE = 5

/**
 * 各类字符的实测宽度（em）。
 *
 * **是量出来的，不是估的** —— 在真实字体栈（`variable.scss` 的 `$textElementFont`）
 * 下用 100px 字号измер了一遍，见第二十轮记录。原来的模型只有「全角 1、半角 0.5」两档，
 * 而实测：
 *
 * | | 实测 | 旧模型 | |
 * |---|---|---|---|
 * | 汉字 | 1.000 | 1.0 | ✓ |
 * | 小写字母 | 0.471 | 0.5 | 偏保守，安全 |
 * | **大写字母** | **0.630** | 0.5 | **低估 26%** |
 * | **数字** | **0.577** | 0.5 | **低估 15%** |
 * | ASCII 标点 | 0.299 | 0.5 | 偏保守，安全 |
 * | 全角标点 | 0.778 | 1.0 | 偏保守，安全 |
 *
 * 低估的两类正好是这类文稿里最密的东西 ——「800ms」「P99 2.4s」「SOC2 Type II」「87%」。
 * 一句话里数字和大写一多，估出来就比实际短一大截，下一个元素就压上来了。
 */
export interface CharWidthTable {
  cjk: number
  cjkPunct: number
  upper: number
  digit: number
  lower: number
  asciiPunct: number
  space: number
}

/**
 * 逐字体的字宽表，单位 em。**由 `npm run char-width` 在真浏览器里量出，勿手改。**
 * 量法见 `scripts/char-width-probe.ts`，原始数据在 `samples/char-width.json`。
 *
 * ## 为什么必须一个字体一张表
 *
 * 改之前这里是**一张常量表**，注释说它是在 `variable.scss` 的 `$textElementFont`
 * 栈下量的。那个栈是系统 fallback —— Mac 落 PingFang SC、Windows 落 Microsoft YaHei，
 * **两台机器的字宽本来就不一样**。而 `layouts.ts` 当时写死的
 * `defaultFontName: 'Microsoft YaHei'` 根本不在 `configs/font.ts` 白名单里，
 * 匹配不到任何 `@font-face`，于是也落进那个栈。
 *
 * 换用登记字体之后一张表就不够了，实测差异大到不可忽略：
 *
 * | | cjk | upper | digit |
 * |---|---|---|---|
 * | 思源黑体 | 1.000 | 0.621 | 0.555 |
 * | 霞鹜新致宋 | 1.000 | **0.688** | **0.618** |
 * | **得意黑** | **0.800** | **0.464** | **0.424** |
 *
 * 得意黑是紧凑展示体，整体比别家窄两成。拿统一表估它会**高估 25%** ——
 * 白白浪费四分之一版面；反过来拿它的表估思源宋体就会压字。
 *
 * ## 这里存的是**原始实测值**，余量在 `WIDTH_SAFETY`
 *
 * 这样源码里的数能和 `npm run char-width` 的输出逐行对上 ——
 * 表漂了当场看得出来。旧表把余量揉进了数值里（实测 0.471 写成 0.56），
 * 于是没人说得清哪一部分是测量、哪一部分是余量。
 */
export const CHAR_WIDTH_BY_FONT = {
  SourceHanSans: { cjk: 1.000, cjkPunct: 0.821, upper: 0.621, digit: 0.555, lower: 0.511, asciiPunct: 0.389, space: 0.224 },
  SourceHanSerif: { cjk: 1.000, cjkPunct: 0.821, upper: 0.672, digit: 0.548, lower: 0.535, asciiPunct: 0.390, space: 0.252 },
  AlibabaPuHuiTi: { cjk: 0.984, cjkPunct: 0.984, upper: 0.604, digit: 0.575, lower: 0.522, asciiPunct: 0.408, space: 0.257 },
  MiSans: { cjk: 1.000, cjkPunct: 1.000, upper: 0.638, digit: 0.562, lower: 0.498, asciiPunct: 0.364, space: 0.290 },
  DeYiHei: { cjk: 0.800, cjkPunct: 0.800, upper: 0.464, digit: 0.424, lower: 0.386, asciiPunct: 0.321, space: 0.190 },
  LXGWNeoZhiSong: { cjk: 1.000, cjkPunct: 0.826, upper: 0.688, digit: 0.618, lower: 0.512, asciiPunct: 0.365, space: 0.290 },
  LXGWWenKai: { cjk: 1.000, cjkPunct: 1.000, upper: 0.646, digit: 0.600, lower: 0.503, asciiPunct: 0.408, space: 0.350 },
  LXGWNeoXiHei: { cjk: 1.000, cjkPunct: 0.826, upper: 0.646, digit: 0.630, lower: 0.506, asciiPunct: 0.387, space: 0.270 },
} as const satisfies Record<string, CharWidthTable>

export type FontFamily = keyof typeof CHAR_WIDTH_BY_FONT

export const FONT_FAMILIES = Object.keys(CHAR_WIDTH_BY_FONT) as FontFamily[]

export const isFontFamily = (v: unknown): v is FontFamily =>
  typeof v === 'string' && v in CHAR_WIDTH_BY_FONT

/**
 * 字宽安全余量，只乘在**非 CJK** 分量上。
 *
 * CJK 不乘：汉字是 em 方块，1.000 就是 1.000，加余量纯浪费版面。
 * 非 CJK 乘 1.08：拉丁字形受 hinting、字距调整（kerning）、以及
 * 「卡在边界上的那一个词」影响，实测值本身是准的，但准不等于没有抖动。
 *
 * 旧表的余量是逐项拍的（upper +4.8%、digit +9.2%、lower +18.9%、
 * asciiPunct +7.0%），没有理由能解释为什么这四个数不一样。统一成一个常量，
 * 而**它是不是够，由 `npm run layout-text` 在真浏览器里判**，不由我拍。
 */
const WIDTH_SAFETY = 1.08

/**
 * 没指定字体时用的表：**每一类取全部登记字体里最宽的那个**。
 *
 * 不用「默认字体的表」而用逐项最大值，是因为漏传 `font` 的后果不对称：
 * 估宽只是浪费一点留白，估窄是文字直接压在一起。取最大值让漏传永远落在安全那侧。
 */
const WIDEST: CharWidthTable = (() => {
  const keys = ['cjk', 'cjkPunct', 'upper', 'digit', 'lower', 'asciiPunct', 'space'] as const
  const out = {} as CharWidthTable
  for (const k of keys) out[k] = Math.max(...FONT_FAMILIES.map(f => CHAR_WIDTH_BY_FONT[f][k]))
  return out
})()

const tableFor = (font?: FontFamily): CharWidthTable =>
  font ? CHAR_WIDTH_BY_FONT[font] : WIDEST

/** 粗体只让**非汉字**变宽（实测小写 0.471→0.520、数字 0.577→0.616，汉字不变） */
const BOLD_FACTOR = 1.1

/**
 * 行盒的最小字号基准 —— **这是量出来的，而且很反直觉**。
 *
 * PPTist 的文本元素把 `line-height` 作为**无单位倍数**设在 `.element-content` 上，
 * 而那个节点**自己没有 font-size**，继承的是浏览器根字号 16px。
 * 字号写在里层的 `<span>` 上（`richText` 生成的）。
 *
 * 结果：一个 `<p>` 里只有 12px 的 span，行盒高度仍然是 `16 × line-height = 25.6px`，
 * 而不是 `12 × 1.6 = 19.2px` —— `<p>` 自己的 strut 按 16px 算，行盒取两者最大值。
 *
 * 所以**凡是小于 16px 的字号，实际行高都比 `字号 × 行距` 高**：
 * 正文 15px 高 6.7%，注释 12px 高 33%。而这两档正是页面上最密的文字。
 *
 * 是 DOM 上量出来的：`cards` 那个 128px 的正文框正好是 `5 × 25.6`，
 * `bullets` 那个 26px 正好是 `1 × 25.6`。两处都对得上，不是巧合。
 *
 * **改 `BaseTextElement.vue` 的 line-height 写法时要回来看这条。**
 */
const ROOT_FONT_SIZE = 16

/**
 * 参差余量。
 *
 * 折行本身已经用贪心排版真算了（`wrapLines`），这里留 6% 兜两件事：
 * 字体度量的机器间差异，以及**卡在边界上的那一个词**。
 *
 * 实测最后一个溢出就是这么来的：`Webhook` 算出来占 10.41 em、行宽 10.42 em，
 * 差 0.01 em「刚好放得下」，而浏览器判定放不下 —— 一个词的去留就是一整行的高度。
 * 这种边界不可能靠把字宽表调得更准来消除，只能留余量。
 *
 * **余量往哪边留是有讲究的**：估高了浪费一点留白，估低了文字直接压在一起。
 * 所以这个数只上调不下调。
 *
 * **它是判据的一部分**：`npm run layout-text` 会在真浏览器里核对
 * 「声明框 ≥ 实际渲染」，不够就当场变红，而不是等到某一页悄悄压在一起。
 */
const RAGGED_SLACK = 1.06

/**
 * CJK 与全角标点。**必须写成 \\uXXXX 转义**，不能把全角字符直接放进正则 ——
 * 全角空格 U+3000 肉眼和普通空格分不出来，eslint 的 no-irregular-whitespace 会报，
 * 而且 grep 也搜不到。这一轮改的时候就直接把字面量写进去了，被 lint 当场逮住。
 */
const CJK_RANGE = /[\u3400-\u9fff\uf900-\ufaff]/
const CJK_PUNCT_RANGE = /[\u3000-\u303f\uff00-\uffef]/

/**
 * \u300c\u5b64\u513f\u6807\u70b9\u300d\u2014\u2014 \u4e2d\u6587\u6587\u7a3f\u91cc\u5230\u5904\u90fd\u662f\uff0c\u4f46\u7801\u4f4d**\u4e0d\u5728** `CJK_PUNCT_RANGE` \u91cc\uff1a
 * \u5f2f\u5f15\u53f7 `\u201c\u201d\u2018\u2019`\uff08U+2018/9\u3001U+201C/D\uff09\u3001\u7834\u6298\u53f7 `\u2014`\uff08U+2014\uff09\u3001
 * \u7701\u7565\u53f7 `\u2026`\uff08U+2026\uff09\u3001\u95f4\u9694\u53f7 `\u00b7`\uff08U+00B7\uff09\u3002
 *
 * \u6ca1\u6709\u8fd9\u6761\u6b63\u5219\u65f6\u5b83\u4eec\u5168\u90e8\u843d\u5230\u6700\u540e\u90a3\u4e2a `asciiPunct` \u5206\u652f\u3002\u800c `npm run char-width`
 * \u5b9e\u6d4b\u5b83\u4eec\u5728\u4e2d\u6587\u5b57\u4f53\u91cc\u6839\u672c\u4e0d\u662f ASCII \u5bbd\u5ea6\uff1a
 *
 * | \u5b57\u4f53 | \u5b9e\u9645 | \u6309 asciiPunct \u4f30 | \u4f4e\u4f30 |
 * |---|---|---|---|
 * | \u601d\u6e90\u9ed1\u4f53 | 0.913 | 0.389 | **2.35\u00d7** |
 * | \u601d\u6e90\u5b8b\u4f53 | 0.817 | 0.390 | 2.10\u00d7 |
 * | \u963f\u91cc\u666e\u60e0\u4f53 | 0.605 | 0.408 | 1.48\u00d7 |
 *
 * \u4e00\u884c 40 \u5b57\u7684\u6b63\u6587\u91cc\u6709\u56db\u4e2a\u5f15\u53f7\uff0c\u5c31\u5c11\u7b97\u4e24\u4e2a\u591a\u5b57\u5bbd \u2014\u2014 \u8db3\u591f\u8ba9\u4e00\u884c\u5c11\u65ad\u4e00\u6b21\uff0c
 * \u800c\u5c11\u65ad\u4e00\u6b21\u5c31\u662f\u4e00\u6574\u884c\u7684\u9ad8\u5ea6\u5dee\u3002
 *
 * \u5f52\u5230 `cjkPunct` \u800c\u4e0d\u662f\u65b0\u5f00\u4e00\u7c7b\uff1a`cjkPunct` \u7684\u5b9e\u6d4b\u503c\uff08\u601d\u6e90\u9ed1\u4f53 0.821\uff09
 * \u79bb\u771f\u503c 0.913 \u53ea\u5dee 11%\uff0c\u800c `WIDTH_SAFETY` \u7684 8% \u53c8\u8865\u56de\u6765\u4e00\u622a\uff1b
 * \u65b0\u5f00\u4e00\u7c7b\u8981\u91cd\u91cf\u5168\u90e8\u516b\u5f20\u8868\u3001\u52a8\u6d4b\u8bd5\u57fa\u51c6\u6587\u4ef6\uff0c\u6536\u76ca\u4e0d\u62b5\u6539\u52a8\u9762\u3002
 * **\u4ecd\u7136\u662f\u7565\u5fae\u4f4e\u4f30\u7684**\uff0c\u771f\u8981\u8865\u9f50\u5f97\u7ed9\u5b83\u81ea\u5df1\u4e00\u6863 \u2014\u2014 \u90a3\u662f\u53e6\u4e00\u4ef6\u4e8b\u3002
 */
const CJK_PUNCT_EXTRA = /[\u00b7\u2014\u2018\u2019\u201c\u201d\u2026]/

/** 单个字符的视觉宽度，单位是 em。`font` 省略时按最宽的那张表算（见 `WIDEST`） */
const charWidth = (ch: string, bold: boolean, font?: FontFamily): number => {
  const t = tableFor(font)
  // 非 CJK 才乘余量与粗体系数 —— 汉字是 em 方块，加了纯浪费
  const b = (bold ? BOLD_FACTOR : 1) * WIDTH_SAFETY
  if (CJK_RANGE.test(ch)) return t.cjk
  if (CJK_PUNCT_RANGE.test(ch) || CJK_PUNCT_EXTRA.test(ch)) return t.cjkPunct
  if (ch >= 'A' && ch <= 'Z') return t.upper * b
  if (ch >= '0' && ch <= '9') return t.digit * b
  if (ch >= 'a' && ch <= 'z') return t.lower * b
  if (ch === ' ' || ch === '\t') return t.space * WIDTH_SAFETY
  return t.asciiPunct * b
}

/** 一行文字的视觉长度，单位是 em。导出只为单测能钉住字宽模型 */
export const visualLength = (text: string, bold = false, font?: FontFamily): number => {
  let n = 0
  for (const ch of text) n += charWidth(ch, bold, font)
  return n
}

/**
 * 把一段文字切成「可以在这里换行」的块。
 *
 * - 汉字、全角标点：**每个字自成一块**（中文可以在任意字之间断行）
 * - 拉丁字母 / 数字连成的词：**整块不可断**（`word-break: break-word` 优先在词边界断）
 * - 空格并入前一块的尾巴（行尾空格不占位）
 *
 * 分块是折行算得准的前提。原来的模型是「总长度 ÷ 每行长度」，
 * 那等于假设任何位置都能断 —— 对纯中文碰巧成立，一遇到
 * 「REST / Webhook / SDK」这种词就少算行数，而这类词在技术文稿里到处都是。
 */
const chunk = (line: string): string[] => {
  const out: string[] = []
  let word = ''
  const flush = () => {
    if (word) {
      out.push(word); word = '' 
    }
  }
  for (const ch of line) {
    const isWordChar = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
      || (ch >= '0' && ch <= '9') || ch === '.' || ch === '-' || ch === '/' || ch === '%'
    if (isWordChar) {
      word += ch; continue 
    }
    flush()
    if (ch === ' ' || ch === '\t') {
      // 空格粘在上一块尾巴上：行尾的空格不换行、不占宽
      if (out.length) out[out.length - 1] += ch
      else out.push(ch)
    }
    else out.push(ch)
  }
  flush()
  return out
}

/**
 * 贪心折行，返回行数。浏览器就是这么排的：逐块放，放不下就换行。
 *
 * 单块比整行还宽时（超长英文词、窄栏）**独占一行**再继续 ——
 * 对应 CSS 的 `break-word` 会把它硬断开，行数至少是 1，这里按 1 算是保守的。
 */
const wrapLines = (line: string, emPerLine: number, bold: boolean, font?: FontFamily): number => {
  const blocks = chunk(line)
  if (!blocks.length) return 1

  let lines = 1
  let used = 0
  for (const block of blocks) {
    /**
     * 两个宽度：`full` 含尾随空格、`trimmed` 不含。
     *
     * **判断放不放得下要用 `trimmed`，累加要用 `full`** ——
     * 行尾的空格在浏览器里是折叠掉的（不占宽、不换行），但行中间的空格占宽。
     *
     * 第一版两处都用 trimmed，等于把**所有**空格都当成不占宽，
     * 于是「第二部分 · 市场表现与竞争格局分析」少算了两个空格的宽度，
     * 刚好卡在一行的边缘上 —— 估出来 1 行，浏览器排出来 2 行。
     */
    const full = visualLength(block, bold, font)
    const trimmed = visualLength(block.replace(/[ \t]+$/, ''), bold, font)
    if (used === 0) {
      used = full; continue 
    }
    if (used + trimmed <= emPerLine) used += full
    else {
      lines++; used = full 
    }
  }
  return lines
}

/**
 * 文本**内容**高度估算（不含 inset）。
 *
 * `boxWidth` 收的是**可排字的宽度**。大多数调用方手上只有元素框宽，
 * 那个该用 `textBoxHeight` —— 它会替你减掉 inset 再加回来。
 */
export const estimateTextHeight = (
  text: string,
  fontSize: number,
  boxWidth: number,
  lineHeight: number = LINE_HEIGHT.body,
  opts: { bold?: boolean, font?: FontFamily } = {},
): number => {
  // 一行能放多少 em
  const emPerLine = Math.max(1, boxWidth / fontSize) / RAGGED_SLACK
  const paragraphs = String(text).split('\n')
  const lines = paragraphs.reduce(
    (sum, line) => sum + wrapLines(line, emPerLine, !!opts.bold, opts.font),
    0,
  )
  // 行高按 max(字号, 16) 算 —— 见 ROOT_FONT_SIZE 的说明，这是量出来的
  const lineBox = Math.max(fontSize, ROOT_FONT_SIZE) * lineHeight
  return Math.ceil(lines * lineBox + (paragraphs.length - 1) * PARAGRAPH_SPACE)
}

/**
 * 一段文字要放进宽 `boxWidth` 的**元素框**时，这个框至少得多高。
 *
 * 版式引擎一律用这个，不要直接用 `estimateTextHeight` ——
 * 差的就是内边距，而少算内边距的表现是「看着刚好，实际压住下一个元素」。
 *
 * `inset` 默认取 `LAYOUT_INSET`（版式引擎给每个文本元素设的那一份）。
 * 传别的值时**必须和元素上真正写的 inset 一致**，否则这个函数就是在算另一个框。
 */
export const textBoxHeight = (
  text: string,
  fontSize: number,
  boxWidth: number,
  lineHeight: number = LINE_HEIGHT.body,
  opts: { bold?: boolean, inset?: [number, number, number, number], font?: FontFamily } = {},
): number => {
  const [top, right, bottom, left] = opts.inset ?? LAYOUT_INSET
  return estimateTextHeight(text, fontSize, Math.max(1, boxWidth - left - right), lineHeight, opts)
    + top + bottom
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
  opts: { bold?: boolean, font?: FontFamily } = {},
): number => {
  const sorted = [...candidates].sort((a, b) => b - a)
  for (const size of sorted) {
    // 比的是**元素框**高度（含 inset），因为调用方拿到字号之后建的就是元素框
    if (textBoxHeight(text, size, boxWidth, lineHeight, opts) <= maxHeight) return size
  }
  return sorted[sorted.length - 1]
}

// ---------------------------------------------------------------------------
// 垂直构图
// ---------------------------------------------------------------------------

/**
 * 一组块在纵向上怎么摆。
 *
 * - `top`     顶端对齐（标题页那种「从上往下讲」）
 * - `middle`  整组垂直居中（内容少的页面 —— **这一条是第二十轮的主角**）
 * - `bottom`  底端对齐
 * - `spread`  撑开填满，但间距有上限（见 `stack` 的说明）
 */
export type StackAlign = 'top' | 'middle' | 'bottom' | 'spread'

export interface StackBlock {
  height: number
  /** 与**上一块**之间的间距；第一块忽略 */
  gap?: number
}

export interface StackResult {
  /** 每一块的 top，与入参一一对应，已吸附到 8px 栅格 */
  tops: number[]
  /** 整组实际占的高度 */
  height: number
  /** 放不下时超出多少像素（≤0 表示放得下）—— 调用方据此降字号或截内容 */
  overflow: number
}

/**
 * 把一组块排进一个纵向区间。
 *
 * ## 为什么需要它（第二十轮的核心）
 *
 * 改之前每个版式都是这么写的：
 *
 * ```
 * let y = 150                 // ← 拍出来的常量
 * y += titleH + headingGap
 * y += 16 + headingGap
 * ```
 *
 * 这套写法把「一页有多高」当成已知量。于是内容多了元素就压在一起，
 * 内容少了下面就空一大片 —— 实测 66 张样张里 26 张底部空档超过 90px，
 * `section` 是雷打不动的 177px。**那不是留白，是没排完。**
 *
 * `stack` 反过来：先量完所有块，再决定整组放哪。
 * 内容少 → `middle` 让它居中，版面自然收拢；内容多 → `overflow` 告诉调用方要降级。
 *
 * ## `spread` 的间距上限
 *
 * 「撑开填满」最容易写成「可用高度 ÷ 条数」，那正是改之前 `bullets` 的写法，
 * 结果是三条要点之间隔着 120px 的空气。所以 `spread` 的间距有上限
 * （默认 2.5 倍自然间距），撑不满的部分**退回居中**，而不是硬摊平。
 */
export const stack = (
  blocks: StackBlock[],
  region: { top: number, bottom: number },
  align: StackAlign = 'top',
  opts: { maxGapFactor?: number } = {},
): StackResult => {
  if (!blocks.length) return { tops: [], height: 0, overflow: 0 }

  const gaps = blocks.map((b, i) => (i === 0 ? 0 : b.gap ?? SPACING.paragraphGap))
  const contentH = blocks.reduce((s, b) => s + b.height, 0)
  const naturalGapH = gaps.reduce((s, g) => s + g, 0)
  const available = region.bottom - region.top
  const natural = contentH + naturalGapH

  // 撑开：把富余摊进各个间距，但每个间距最多长到 maxGapFactor 倍
  let used = gaps
  if (align === 'spread' && blocks.length > 1 && natural < available) {
    const factor = opts.maxGapFactor ?? 2.5
    const slack = available - natural
    const room = gaps.reduce((s, g, i) => s + (i === 0 ? 0 : g * (factor - 1)), 0)
    const take = Math.min(slack, room)
    used = gaps.map((g, i) => (i === 0 || room === 0 ? g : g + (g * (factor - 1) / room) * take))
  }

  const total = contentH + used.reduce((s, g) => s + g, 0)

  // spread 撑不满剩下的那部分退回居中 —— 硬摊平就是改之前 bullets 那个毛病
  const start = align === 'top'
    ? region.top
    : align === 'bottom'
      ? region.bottom - total
      : region.top + Math.max(0, (available - total) / 2)

  const tops: number[] = []
  let y = start
  blocks.forEach((b, i) => {
    y += used[i]
    tops.push(snapY(y))
    y += b.height
  })

  return { tops, height: total, overflow: Math.round(total - available) }
}

/**
 * 在一组「从宽松到紧凑」的候选参数里挑第一个放得下的，都放不下就用最紧的那个。
 *
 * ## 为什么要它
 *
 * 「先量后排」解决了内容少时版面空洞，但**内容多的时候必须有退路**：
 * 六条要点按三条要点的字号排，量出来 608px 而版心只有 442px，
 * 多出来的两条直接掉到画布外面 —— 改造过程中真的这么翻车了一次，
 * 是 `layouts.test.ts` 的 `survives maximum item counts` 当场抓住的。
 *
 * 老代码用「可用高度 ÷ 条数」平均分，那个写法**不会溢出**（代价是内容少时版面空洞）。
 * 换成按内容排之后，溢出这条路就得自己补上 —— 这是同一个改动的两面，
 * 只做一半比不做更糟。
 *
 * 退路是**降字号**而不是压行距：行距压到 1.2 以下中文会糊成一片，
 * 而字号从 15 降到 12 仍然读得清，投影上的差别远小于「有两条看不见」。
 */
export const fitSteps = <T>(steps: T[], measure: (step: T) => number, budget: number): T =>
  steps.find(s => measure(s) <= budget) ?? steps[steps.length - 1]

// ---------------------------------------------------------------------------
// 背景图遮罩
// ---------------------------------------------------------------------------

/** 把相对亮度反解成一个等效灰度的 sRGB 分量（`luminance` 的逆运算，灰度时三通道相同） */
const grayFromLuminance = (l: number): number => {
  const c = Math.max(0, Math.min(1, l))
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
  return clamp255(s * 255)
}

/** 在 sRGB 空间里把 fg 以 alpha 叠在 bg 上 —— 浏览器和 PowerPoint 都在这个空间合成 */
const compositeOver = (fg: string, alpha: number, bgGray: number): string => {
  const f = parseHex(fg) ?? [0, 0, 0]
  return toHex([
    f[0] * alpha + bgGray * (1 - alpha),
    f[1] * alpha + bgGray * (1 - alpha),
    f[2] * alpha + bgGray * (1 - alpha),
  ])
}

/**
 * 压住一张亮度为 `photoLuminance` 的照片、让 `textColor` 达到目标对比度，
 * 最少需要多浓的遮罩。
 *
 * 二分求解而不是解析解：合成发生在 sRGB 空间、而对比度定义在线性亮度空间，
 * 中间隔着一个 gamma，解析式又长又容易写错，而二分 20 次就精确到 1e-6，
 * 且**读代码的人一眼能确认它在算什么**。
 */
export const scrimOpacityFor = (
  textColor: string,
  scrimColor: string,
  photoLuminance: number,
  target: number = CONTRAST_AA,
): number => {
  const bgGray = grayFromLuminance(photoLuminance)
  const ok = (a: number) => contrastRatio(textColor, compositeOver(scrimColor, a, bgGray)) >= target

  if (ok(0)) return 0
  if (!ok(1)) return 1

  let lo = 0, hi = 1
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (ok(mid)) hi = mid
    else lo = mid
  }
  return hi
}

export interface ScrimSpec {
  /** 遮罩底色（不含 alpha） */
  color: string
  /**
   * 元素级不透明度。
   *
   * **导出 PPTX 之后整块就是这个浓度** —— 见下面 `gradient` 的说明。
   */
  opacity: number
  /** 渐变：网页侧从 `opacity` 衰减到 0，把照片放出来一半 */
  gradient?: Gradient
  /**
   * 压完遮罩之后，文字实际踩在什么颜色上（最坏那一头）。
   *
   * 版式拿它给**彩色文字**兜底：`scrimFor` 是照着 `palette.text` 算浓度的，
   * 但 stat 那个大数字用的是 `primary`、eyebrow 用的是 `accent` ——
   * 实测截图上「关键指标」那行黄字压在照片上几乎看不见，而所有断言都是绿的。
   * 有了它就能用 `ensureContrast` 把彩色文字拉回可读区间。
   */
  effectiveBg: string
}

/**
 * 把 `color` 往可读的方向推，直到它对 `bg` 的对比度达标。
 *
 * 用途是**彩色文字压在照片上**：主色蓝、强调色黄这类颜色本身就是为了跳出来，
 * 不是为了可读 —— 放在纯色背景上有 lint 兜着，放在照片上就没人管了。
 *
 * 推的方向按 `bg` 定（浅底往黑推、深底往白推），最多推到纯黑/纯白。
 * 推不到目标就返回能推到的最好结果 —— **宁可给一个偏离主题色但读得出来的颜色，
 * 也不要一个忠于主题但看不见的**。
 */
export const ensureContrast = (color: string, bg: string, target: number = CONTRAST_AA): string => {
  if (contrastRatio(color, bg) >= target) return color
  const anchor = luminance(bg) > 0.5 ? '#000000' : '#ffffff'
  let best = color
  // 20 档足够：每档 5%，肉眼分不出更细的差别
  for (let i = 1; i <= 20; i++) {
    const candidate = mixHex(color, anchor, i / 20)
    best = candidate
    if (contrastRatio(candidate, bg) >= target) return candidate
  }
  return best
}

/**
 * 没有亮度信息时的兜底浓度。
 *
 * 改之前是 0.82 / 0.78 的常量，**实测把照片压成了一层幽灵** ——
 * 白底亮图那张照片几乎完全消失，付了搜图/生图的成本却等于没有图。
 * 业界通行区间是 40~60%，这里取 0.55 当「不知道图多亮」时的中位数。
 */
const SCRIM_FALLBACK = 0.55

/** 遮罩浓度的下限：低于这个值等于没压，照片上的局部亮斑随时能把字吃掉 */
const SCRIM_MIN = 0.28

/** 上限：再高就不是「压一下」而是「盖掉」，那还不如别配图 */
const SCRIM_MAX = 0.72

/**
 * 算一层背景图遮罩。
 *
 * ## 三件事一起解决
 *
 * **① 浓度不再是拍脑袋的常量。** 传进来的 `luminance` 是图片**实际解码后**
 * 量出来的亮度（`runtime/imageCodec.ts` 顺手算，存进 `assets` 表，
 * 经工具返回值到 `content.image.luminance`）。深色照片只需要薄薄一层，
 * 白底照片才需要压狠。一个常量同时服务这两种图，只能取最狠的那个 ——
 * 于是所有深色照片都被冤枉。
 *
 * **② 对着最坏情况算，而「最坏」是哪一头要看文字颜色。** 照片不均匀，
 * 平均值达标不代表每个字都达标。但**不是「取最亮那一头」那么简单**：
 *
 * - 浅色主题（深色字）：危险的是照片的**暗部** —— 深字压在暗处才看不见，
 *   遮罩要把它**提亮**，所以binding 的是 p5（最暗那 5%）
 * - 深色主题（浅色字）：危险的是照片的**亮部**，遮罩要压暗，binding 的是 p95
 *
 * 统一的说法是：**取 {p5, p95} 里离文字亮度更近的那个** —— 对比度就是在
 * 「背景亮度 ≈ 文字亮度」时最低。写这条测试的时候我一开始断言反了
 * （以为一律「亮图压得更狠」），是测试把这个思考错误当场抓住的。
 *
 * **③ 渐变，让照片活下来。** 全屏均匀压是把整张照片一起变灰；
 * 只压文字那一侧，另一侧照片原样。
 *
 * ## 导出会把渐变压平 —— 而这次压平的结果恰好是对的
 *
 * `useExport.ts:704` 对带渐变的形状做 `tinycolor.mix(首色, 末色).toHexString()`，
 * **`toHexString()` 会丢掉 alpha**，于是两个同色不同 alpha 的端点合出来就是那个颜色本身，
 * 再乘元素级 `opacity`。所以：
 *
 * - 网页：`opacity` → 0 的渐变，照片保住
 * - PPTX：`opacity` 的**均匀**遮罩，也就是业界标准那种平铺遮罩
 *
 * 两边都是成立的设计，PPTX 那边更保守（整张压暗）但保证读得出来。
 * 这不是巧合被发现的，是照着 export 那段代码推出来再实测确认的 ——
 * 换句话说，**改 `useExport.ts` 的渐变处理时要回来看这条**。
 */
export const scrimFor = (
  palette: Palette,
  image: { luminance?: [number, number] } | undefined,
  opts: { direction?: 'left' | 'right' | 'down' | 'none', target?: number, hold?: number } = {},
): ScrimSpec => {
  // 必须先规范成 6 位 —— 主题里写 `#fff` 是合法的，而下面要拼 8 位带 alpha 的色值，
  // `#fff` + `ff` = `#fffff`，5 位，SVG 直接当非法色丢掉 → 遮罩整个消失
  const rgb = parseHex(palette.background)
  const color = rgb ? toHex(rgb) : '#ffffff'

  // 最坏情况：{p5, p95} 里离文字亮度更近的那个（对比度在两者相等时最低）。
  // 没给区间就退回单个亮度值
  const textLum = luminance(palette.text)
  const worst = (() => {
    if (!image?.luminance) return undefined
    const [lo, hi] = image.luminance
    return Math.abs(lo - textLum) < Math.abs(hi - textLum) ? lo : hi
  })()

  const opacity = worst === undefined
    ? SCRIM_FALLBACK
    : Math.max(
      SCRIM_MIN,
      Math.min(SCRIM_MAX, scrimOpacityFor(palette.text, color, worst, opts.target)),
    )

  // 文字实际踩在什么颜色上：遮罩以 opacity 叠在最坏那一头的照片灰度上
  const effectiveBg = compositeOver(color, opacity, grayFromLuminance(worst ?? 0.5))

  const direction = opts.direction ?? 'left'
  if (direction === 'none') return { color, opacity, effectiveBg }

  /**
   * `hold`：遮罩在这个位置之前保持满强度，之后才开始淡出。
   *
   * **这条是看截图看出来的。** 第一版是 `0%→满、55%→85%、100%→0`，
   * 结果引用页那行字横跨到 93% 宽，后半句正好落在渐变已经淡掉的地方 ——
   * 「没有界面」四个字压在亮蓝色机柜上，糊了。
   *
   * 所以 hold 必须**覆盖文字实际占到的位置**，调用方把文字范围传进来。
   * 覆盖到 85% 以上就没必要渐变了，直接均匀压（再渐变也只剩一条边）。
   */
  const hold = Math.max(0, Math.min(0.85, opts.hold ?? 0.55))
  if (hold >= 0.85) return { color, opacity, effectiveBg }

  // rotate 是 GradientDefs 里 linearGradient 的角度，0 = 从左到右
  const rotate = direction === 'left' ? 0 : direction === 'right' ? 180 : 90

  return {
    color,
    opacity,
    effectiveBg,
    gradient: {
      type: 'linear',
      rotate,
      // 同一个颜色、alpha 从 1 到 0：导出压平后就是这个颜色本身（见上文）
      colors: [
        { pos: 0, color: `${color}ff` },
        { pos: Math.round(hold * 100), color: `${color}ff` },
        { pos: 100, color: `${color}00` },
      ],
    },
  }
}

