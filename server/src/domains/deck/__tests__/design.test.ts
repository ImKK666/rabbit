import { describe, it, expect } from 'vitest'
import type { SlideTheme } from '@/types/slides'
import {
  parseHex, toHex, mixHex, luminance, contrastRatio, readableOn,
  buildPalette, richText, escapeHtml, estimateTextHeight,
  TYPE_SCALE, SPACING, SAFE, UNIT, CANVAS_WIDTH, CANVAS_HEIGHT,
  snapY, textBoxHeight, PARAGRAPH_SPACE, stack, fitSteps,
  scrimFor, scrimOpacityFor, ensureContrast, PALETTE_STYLES, isPaletteStyle, describePaletteStyles,
} from '../design'

const theme = (over: Partial<SlideTheme> = {}): SlideTheme => ({
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
  fontColor: '#333333',
  fontName: '',
  backgroundColor: '#ffffff',
  shadow: { h: 3, v: 3, blur: 2, color: '#808080' },
  outline: { width: 2, color: '#525252', style: 'solid' },
  ...over,
})

describe('design · color', () => {
  it('parses 3 and 6 digit hex, with or without #', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255])
    expect(parseHex('000000')).toEqual([0, 0, 0])
    expect(parseHex('#2F6FEB')).toEqual([47, 111, 235])
  })

  it('rejects garbage', () => {
    expect(parseHex('rgb(1,2,3)')).toBeNull()
    expect(parseHex('#12345')).toBeNull()
    expect(parseHex('')).toBeNull()
  })

  it('round-trips through toHex', () => {
    expect(toHex(parseHex('#2f6feb')!)).toBe('#2f6feb')
  })

  it('clamps out-of-range channels instead of emitting bad hex', () => {
    expect(toHex([300, -20, 128])).toBe('#ff0080')
  })

  it('mixes toward the target', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('returns the source colour when a side is unparseable', () => {
    expect(mixHex('#123456', 'not-a-color', 0.5)).toBe('#123456')
  })

  it('orders luminance the way eyes do', () => {
    expect(luminance('#ffffff')).toBeCloseTo(1, 3)
    expect(luminance('#000000')).toBeCloseTo(0, 3)
    expect(luminance('#ffff00')).toBeGreaterThan(luminance('#0000ff'))
  })

  it('computes WCAG contrast symmetrically', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1)
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 3)
  })

  it('picks a readable text colour for any background', () => {
    expect(readableOn('#ffffff')).toBe('#111111')
    expect(readableOn('#0a0e27')).toBe('#ffffff')
    for (const bg of ['#2f6feb', '#ed7d31', '#70ad47', '#ffc000', '#333333']) {
      expect(contrastRatio(bg, readableOn(bg))).toBeGreaterThan(3)
    }
  })
})

describe('design · buildPalette', () => {
  it('derives every role from the theme', () => {
    const p = buildPalette(theme())
    expect(p.background).toBe('#ffffff')
    expect(p.primary).toBe('#5b9bd5')
    expect(p.dark).toBe(false)
    for (const key of ['surface', 'accent', 'text', 'textMuted', 'onPrimary', 'border'] as const) {
      expect(parseHex(p[key]), `${key} = ${p[key]}`).not.toBeNull()
    }
  })

  it('detects dark themes', () => {
    expect(buildPalette(theme({ backgroundColor: '#0a0e27' })).dark).toBe(true)
    expect(buildPalette(theme({ backgroundColor: '#ffffff' })).dark).toBe(false)
  })

  // 主题的 fontColor 可能是浅灰，配深底就读不清了 —— 这时要覆盖掉它
  it('overrides an unreadable theme font colour', () => {
    const p = buildPalette(theme({ backgroundColor: '#111111', fontColor: '#222222' }))
    expect(p.text).toBe('#ffffff')
    expect(contrastRatio(p.text, p.background)).toBeGreaterThan(3)
  })

  it('keeps a readable theme font colour', () => {
    const p = buildPalette(theme({ backgroundColor: '#ffffff', fontColor: '#333333' }))
    expect(p.text).toBe('#333333')
  })

  it('falls back when the theme has no usable colours', () => {
    const p = buildPalette(theme({ themeColors: [], backgroundColor: 'not-a-color' }))
    expect(p.background).toBe('#ffffff')
    expect(parseHex(p.primary)).not.toBeNull()
    expect(parseHex(p.accent)).not.toBeNull()
  })

  // accent 要跟 primary 拉开色相，否则「强调」根本强调不出来
  it('picks an accent that differs from the primary', () => {
    const p = buildPalette(theme())
    expect(p.accent).not.toBe(p.primary)
  })

  it('keeps text legible on the primary colour', () => {
    for (const primary of ['#2f6feb', '#ffc000', '#111111', '#f5f5f5']) {
      const p = buildPalette(theme({ themeColors: [primary] }))
      expect(contrastRatio(p.onPrimary, p.primary), primary).toBeGreaterThan(3)
    }
  })

  it('honours explicit overrides', () => {
    const p = buildPalette(theme(), { primary: '#ff0000', background: '#000000' })
    expect(p.primary).toBe('#ff0000')
    expect(p.background).toBe('#000000')
  })
})

describe('design · text', () => {
  it('escapes html so content cannot break the document', () => {
    expect(escapeHtml('<script>&"')).toBe('&lt;script&gt;&amp;&quot;')
  })

  it('wraps each line in its own <p>', () => {
    const html = richText('一行\n二行', { size: 16, color: '#111111' })
    expect(html.match(/<p[ >]/g)).toHaveLength(2)
    expect(html).toContain('font-size:16px')
    expect(html).toContain('color:#111111')
  })

  it('emits bold, alignment and letter spacing only when asked', () => {
    const plain = richText('x', { size: 16, color: '#111' })
    expect(plain).not.toContain('font-weight')
    expect(plain).not.toContain('text-align')

    const fancy = richText('x', { size: 16, color: '#111', bold: true, align: 'center', letterSpacing: 2 })
    expect(fancy).toContain('font-weight:700')
    expect(fancy).toContain('text-align:center')
    expect(fancy).toContain('letter-spacing:2px')
  })

  it('escapes inside the span, not around it', () => {
    expect(richText('a<b', { size: 12, color: '#000' })).toContain('a&lt;b')
  })
})

describe('design · estimateTextHeight', () => {
  it('grows with the text length', () => {
    const short = estimateTextHeight('短', 16, 400)
    const long = estimateTextHeight('很'.repeat(200), 16, 400)
    expect(long).toBeGreaterThan(short)
  })

  it('grows when the box narrows', () => {
    const wide = estimateTextHeight('字'.repeat(60), 16, 800)
    const narrow = estimateTextHeight('字'.repeat(60), 16, 200)
    expect(narrow).toBeGreaterThan(wide)
  })

  it('counts explicit line breaks', () => {
    expect(estimateTextHeight('a\nb\nc', 16, 800)).toBeGreaterThan(estimateTextHeight('a', 16, 800))
  })

  it('treats half-width characters as half a CJK char', () => {
    expect(estimateTextHeight('a'.repeat(40), 16, 200))
      .toBeLessThan(estimateTextHeight('字'.repeat(40), 16, 200))
  })

  it('never returns zero for non-empty text', () => {
    expect(estimateTextHeight('x', 16, 800)).toBeGreaterThan(0)
    expect(estimateTextHeight('', 16, 800)).toBeGreaterThan(0)
  })
})

describe('design · tokens', () => {
  it('keeps every spacing value on the 8px grid', () => {
    for (const [key, value] of Object.entries(SPACING)) {
      expect(value % UNIT, `${key} = ${value}`).toBe(0)
    }
  })

  it('keeps the type scale strictly ordered', () => {
    expect(TYPE_SCALE.caption).toBeLessThan(TYPE_SCALE.body)
    expect(TYPE_SCALE.body).toBeLessThan(TYPE_SCALE.itemTitle)
    expect(TYPE_SCALE.itemTitle).toBeLessThan(TYPE_SCALE.subtitle)
    expect(TYPE_SCALE.subtitle).toBeLessThan(TYPE_SCALE.title)
    expect(TYPE_SCALE.title).toBeLessThan(TYPE_SCALE.display)
    expect(TYPE_SCALE.display).toBeLessThan(TYPE_SCALE.stat)
  })

  // 相邻层级差得不够多，层次就立不住 —— 这正是「看着像 Word」的来源之一
  it('separates adjacent type steps by at least 15%', () => {
    const ladder = [TYPE_SCALE.caption, TYPE_SCALE.body, TYPE_SCALE.itemTitle,
      TYPE_SCALE.subtitle, TYPE_SCALE.title, TYPE_SCALE.display]
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i] / ladder[i - 1], `${ladder[i - 1]} → ${ladder[i]}`).toBeGreaterThan(1.15)
    }
  })

  it('keeps the safe area inside the canvas', () => {
    expect(SAFE.left).toBeGreaterThan(0)
    expect(SAFE.right).toBeLessThan(CANVAS_WIDTH)
    expect(SAFE.top).toBeGreaterThan(0)
    expect(SAFE.bottom).toBeLessThan(CANVAS_HEIGHT)
    expect(SAFE.width).toBeGreaterThan(CANVAS_WIDTH * 0.7)
    expect(SAFE.height).toBeGreaterThan(CANVAS_HEIGHT * 0.7)
  })
})

// ---------------------------------------------------------------------------
// 第二十轮新增
// ---------------------------------------------------------------------------

describe('design · snapY 基线栅格', () => {
  it('吸附到 8 的整数倍', () => {
    expect(snapY(0)).toBe(0)
    expect(snapY(11)).toBe(8)
    expect(snapY(13)).toBe(16)
    expect(snapY(-3)).toBe(-0)
  })

  it('SAFE.top 本来就在格上，所以顶边对齐天然成立', () => {
    expect(SAFE.top % UNIT).toBe(0)
    expect(snapY(SAFE.top)).toBe(SAFE.top)
  })

  it('底边比顶边多留 8 —— 光学底重', () => {
    const top = SAFE.top
    const bottom = CANVAS_HEIGHT - SAFE.bottom
    expect(bottom).toBeGreaterThan(top)
    expect(bottom - top).toBe(UNIT)
  })
})

describe('design · 文本高度模型', () => {
  it('小于 16px 的字号，行高按 16 算而不是按字号算', () => {
    // 这是量出来的：.element-content 只设了无单位 line-height，没设 font-size，
    // 继承的是根字号 16px，于是 <p> 的 strut 撑着行盒
    const h12 = textBoxHeight('一', 12, 400, 1.6)
    const h16 = textBoxHeight('一', 16, 400, 1.6)
    expect(h12).toBe(h16)
  })

  it('大于 16px 的字号照常按字号算', () => {
    expect(textBoxHeight('一', 32, 400, 1.6)).toBeGreaterThan(textBoxHeight('一', 16, 400, 1.6))
  })

  it('把内边距算进框高', () => {
    const zero = textBoxHeight('一', 20, 400, 1.5, { inset: [0, 0, 0, 0] })
    const padded = textBoxHeight('一', 20, 400, 1.5, { inset: [10, 10, 10, 10] })
    expect(padded - zero).toBe(20)
  })

  it('拉丁词整词不断 —— 窄栏里比按字符平摊要多一行', () => {
    // 「总长度 ÷ 行宽」的老模型对这种内容会少算行数
    const withWords = textBoxHeight('Webhook Webhook Webhook', 12, 120)
    const sameLengthCjk = textBoxHeight('字字字字字字字', 12, 120)
    expect(withWords).toBeGreaterThan(sameLengthCjk)
  })

  it('多个段落要把段间距算进去', () => {
    const one = textBoxHeight('甲', 16, 400, 1.5)
    const three = textBoxHeight('甲\n乙\n丙', 16, 400, 1.5)
    expect(three).toBe(one * 3 + PARAGRAPH_SPACE * 2)
  })
})

describe('design · stack 垂直编排', () => {
  const region = { top: 100, bottom: 500 }

  it('top：从区间顶部往下排', () => {
    const r = stack([{ height: 50 }, { height: 50, gap: 16 }], region, 'top')
    expect(r.tops[0]).toBe(104) // 100/8 = 12.5，JS 的 round 往上取 → 104
    expect(r.tops[1]).toBeGreaterThan(r.tops[0])
  })

  it('middle：整组垂直居中 —— 这一条是第二十轮的主角', () => {
    const r = stack([{ height: 100 }], region, 'middle')
    // 区间 400 高，内容 100 → 上下各留 150
    expect(r.tops[0]).toBeCloseTo(248, -1)
  })

  it('bottom：底端对齐', () => {
    const r = stack([{ height: 100 }], region, 'bottom')
    expect(r.tops[0]).toBeCloseTo(400, -1)
  })

  it('spread 的间距有上限，撑不满就退回居中', () => {
    // 两个 20px 的块放进 400px 的区间：平摊会隔着 360px，那正是改之前的毛病
    const r = stack([{ height: 20 }, { height: 20, gap: 16 }], region, 'spread')
    const gap = r.tops[1] - (r.tops[0] + 20)
    expect(gap).toBeLessThanOrEqual(16 * 2.5)
  })

  it('放不下时如实报 overflow，不假装排下了', () => {
    const r = stack([{ height: 300 }, { height: 300, gap: 16 }], region, 'top')
    expect(r.overflow).toBeGreaterThan(0)
  })

  it('每个 top 都落在 8px 栅格上', () => {
    const r = stack([{ height: 37 }, { height: 41, gap: 13 }, { height: 19, gap: 7 }], region, 'middle')
    for (const t of r.tops) expect(t % UNIT).toBe(0)
  })

  it('空输入不炸', () => {
    expect(stack([], region, 'middle')).toEqual({ tops: [], height: 0, overflow: 0 })
  })
})

describe('design · fitSteps', () => {
  it('挑第一个放得下的', () => {
    expect(fitSteps([10, 8, 6], n => n * 10, 85)).toBe(8)
  })

  it('都放不下就用最紧的那一档 —— 不返回 undefined 让调用方炸', () => {
    expect(fitSteps([10, 8, 6], n => n * 100, 1)).toBe(6)
  })
})

describe('design · 遮罩', () => {
  const p = buildPalette(theme())

  it('照片越接近文字亮度，需要的遮罩越浓', () => {
    // 浅底深字：暗照片才是难题
    const dark = scrimOpacityFor(p.text, p.background, 0.02)
    const light = scrimOpacityFor(p.text, p.background, 0.9)
    expect(dark).toBeGreaterThan(light)
  })

  it('本来就够对比度就不用压', () => {
    expect(scrimOpacityFor('#000000', '#ffffff', 0.95)).toBe(0)
  })

  it('浓度夹在业界区间内，不再是 0.82 那种常量', () => {
    for (const l of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      const spec = scrimFor(p, { luminance: [l, l] })
      expect(spec.opacity).toBeGreaterThanOrEqual(0.28)
      expect(spec.opacity).toBeLessThanOrEqual(0.72)
    }
  })

  it('取 p5 / p95 里离文字亮度更近的那一头', () => {
    const both = scrimFor(p, { luminance: [0.02, 0.95] }).opacity
    const onlyBright = scrimFor(p, { luminance: [0.9, 0.95] }).opacity
    expect(both).toBeGreaterThan(onlyBright)
  })

  it('渐变首末同色只差 alpha —— 导出压平后才等于那个颜色本身', () => {
    const spec = scrimFor(p, { luminance: [0.4, 0.6] }, { direction: 'left', hold: 0.6 })
    const colors = spec.gradient!.colors
    expect(colors[0].color.slice(0, 7)).toBe(colors[colors.length - 1].color.slice(0, 7))
    expect(colors[colors.length - 1].color.slice(7)).toBe('00')
  })

  it('三位 hex 的背景色也能拼出合法的 8 位色值', () => {
    // `#fff` + `ff` = 5 位，SVG 会当非法色直接丢掉 → 遮罩整个消失且不报错
    const spec = scrimFor(buildPalette(theme({ backgroundColor: '#fff' })), { luminance: [0.4, 0.6] })
    for (const c of spec.gradient?.colors ?? []) expect(c.color).toMatch(/^#[0-9a-f]{8}$/i)
  })

  it('hold 覆盖到 85% 以上就不做渐变了 —— 再渐变也只剩一条边', () => {
    expect(scrimFor(p, { luminance: [0.4, 0.6] }, { direction: 'left', hold: 0.9 }).gradient).toBeUndefined()
  })
})

describe('design · ensureContrast', () => {
  it('本来就够就原样返回，不动用户的主题色', () => {
    expect(ensureContrast('#000000', '#ffffff')).toBe('#000000')
  })

  it('不够就往可读方向推到达标', () => {
    const fixed = ensureContrast('#ffd166', '#ffffff')
    expect(contrastRatio(fixed, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })

  it('深底往白推，浅底往黑推', () => {
    expect(luminance(ensureContrast('#333333', '#111111'))).toBeGreaterThan(luminance('#333333'))
    expect(luminance(ensureContrast('#cccccc', '#eeeeee'))).toBeLessThan(luminance('#cccccc'))
  })
})

describe('design · 配色风格包', () => {
  const t = theme()

  it('四个风格都能建出完整调色板', () => {
    for (const style of Object.keys(PALETTE_STYLES) as (keyof typeof PALETTE_STYLES)[]) {
      const p = buildPalette(t, undefined, style)
      for (const key of ['background', 'surface', 'primary', 'accent', 'text', 'textMuted', 'border'] as const) {
        expect(parseHex(p[key]), `${style}.${key}`).not.toBeNull()
      }
    }
  })

  it('**不动用户主题里的背景色和主色** —— 那是品牌资产', () => {
    for (const style of Object.keys(PALETTE_STYLES) as (keyof typeof PALETTE_STYLES)[]) {
      const p = buildPalette(t, undefined, style)
      expect(p.background, style).toBe(t.backgroundColor)
      expect(p.primary, style).toBe(t.themeColors[0])
    }
  })

  it('风格之间真的不一样（否则等于没做）', () => {
    const surfaces = (Object.keys(PALETTE_STYLES) as (keyof typeof PALETTE_STYLES)[])
      .map(s => buildPalette(t, undefined, s).surface)
    expect(new Set(surfaces).size).toBe(surfaces.length)
  })

  it('科技的卡片底和背景拉得比学术开 —— 层次靠面', () => {
    const tech = buildPalette(t, undefined, 'tech')
    const academic = buildPalette(t, undefined, 'academic')
    const sep = (p: ReturnType<typeof buildPalette>) => Math.abs(luminance(p.surface) - luminance(p.background))
    expect(sep(tech)).toBeGreaterThan(sep(academic))
  })

  it('认不出的风格名退回 business，不抛', () => {
    expect(isPaletteStyle('tech')).toBe(true)
    expect(isPaletteStyle('cyberpunk')).toBe(false)
    expect(buildPalette(t, undefined, 'cyberpunk' as never).surface)
      .toBe(buildPalette(t, undefined, 'business').surface)
  })

  it('清单里每个风格各出现一次 —— 进 prompt 的那份', () => {
    const text = describePaletteStyles()
    for (const k of Object.keys(PALETTE_STYLES)) {
      expect(text.split(`- ${k}（`).length - 1, k).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// R-60 · 风格菜单扩容：editorial / soft 两档质感 + 两个新字体 + 一对新配对
// ---------------------------------------------------------------------------

describe('design · R-60 风格菜单扩容', () => {
  it('六档质感都有完整的配方字段', () => {
    for (const [name, recipe] of Object.entries(PALETTE_STYLES)) {
      expect(recipe.label, name).toBeTruthy()
      expect(recipe.usage, name).toBeTruthy()
      expect(recipe.tint, name).toMatch(/^#/)
      expect(recipe.tintAmount, name).toBeGreaterThan(0)
      expect(recipe.surfaceLift, name).toHaveLength(2)
      expect(recipe.borderAmount, name).toBeGreaterThan(0)
      expect(recipe.mutedAmount, name).toBeGreaterThan(0)
    }
  })

  it('editorial 的描边最重、soft 的描边最轻 —— 两档确实站在两端', () => {
    const borders = Object.entries(PALETTE_STYLES)
      .map(([k, v]) => [k, v.borderAmount] as const)
      .sort((a, b) => b[1] - a[1])
    expect(borders[0][0]).toBe('editorial')
    expect(borders[borders.length - 1][0]).toBe('soft')
  })

  it('每档质感都有默认艺术流派（ART_DIRECTIONS）', async () => {
    const { ART_DIRECTIONS } = await import('../design')
    for (const key of Object.keys(PALETTE_STYLES)) {
      expect(ART_DIRECTIONS[key as keyof typeof ART_DIRECTIONS], key).toBeTruthy()
    }
    expect(ART_DIRECTIONS.editorial).toContain('contrast')
    expect(ART_DIRECTIONS.soft).toContain('pastel')
  })

  it('artDirectionFor：模型写了用模型的，没写回落质感档位默认', async () => {
    const { ART_DIRECTIONS, artDirectionFor } = await import('../design')
    expect(artDirectionFor({ artDirection: 'mid-century editorial' }, 'business')).toBe('mid-century editorial')
    expect(artDirectionFor({ artDirection: '  swiss grid  ' }, 'business')).toBe('swiss grid')
    expect(artDirectionFor(undefined, 'vivid')).toBe(ART_DIRECTIONS.vivid)
    expect(artDirectionFor(undefined, 'editorial')).toBe(ART_DIRECTIONS.editorial)
    expect(artDirectionFor(undefined, '不存在的档位')).toBe(ART_DIRECTIONS.business)
  })

  it('describePaletteStyles 自动带上新档位 —— 加风格不用改 prompt', () => {
    const text = describePaletteStyles()
    expect(text).toContain('editorial')
    expect(text).toContain('soft')
    expect(text).toContain('编辑风')
    expect(text).toContain('柔和')
  })

  it('新字体进了字宽表，且新配对 heritage 用的字族都登记过', async () => {
    const { CHAR_WIDTH_BY_FONT, TYPOGRAPHY_PAIRS, FONT_NOTES } = await import('../design')
    expect(CHAR_WIDTH_BY_FONT.ZhuQueFangSong.cjk).toBe(1)
    expect(CHAR_WIDTH_BY_FONT.WenDingPLKaiTi.digit).toBe(0.5)
    expect(FONT_NOTES.ZhuQueFangSong).toContain('仿宋')
    expect(TYPOGRAPHY_PAIRS.heritage.display).toBe('ZhuQueFangSong')
    expect(TYPOGRAPHY_PAIRS.heritage.body).toBe('SourceHanSans')
  })
})
