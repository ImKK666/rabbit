import { describe, it, expect } from 'vitest'
import type { SlideTheme } from '@/types/slides'
import {
  parseHex, toHex, mixHex, luminance, contrastRatio, readableOn,
  buildPalette, richText, escapeHtml, estimateTextHeight,
  TYPE_SCALE, SPACING, SAFE, UNIT, CANVAS_WIDTH, CANVAS_HEIGHT,
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
