import { describe, it, expect } from 'vitest'
import type { Slide, SlideTheme, PPTElement } from '@/types/slides'
import { LAYOUT_PATTERNS } from '../layouts'
import {
  validateElement, lintDeck, lintDeckDesign, lintSlide,
  applyAddShape, applyAddChart, applyAddTable, applyAddLine,
  applyArrangeElements, applyLayoutToSlide, applySetSlideTransition,
  mintElementId,
} from '../kernel'
import { lintSlideAnimationOrder } from '../animationOrder'

const THEME: SlideTheme = {
  themeColors: ['#2f6feb', '#f2596b', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
  fontColor: '#1a1a1a',
  fontName: '',
  backgroundColor: '#ffffff',
  shadow: { h: 3, v: 3, blur: 2, color: '#808080' },
  outline: { width: 2, color: '#525252', style: 'solid' },
}

const emptySlide = (id = 's1'): Slide => ({ id, elements: [] })

const textEl = (id: string, over: Partial<Record<string, unknown>> = {}): PPTElement => ({
  id, type: 'text', left: 0, top: 0, width: 100, height: 40, rotate: 0,
  content: '<p>x</p>', defaultFontName: 'Microsoft YaHei', defaultColor: '#111111',
  ...over,
} as unknown as PPTElement)

const ok = <T, >(r: { ok: boolean, data?: T, error?: string }): T => {
  if (!r.ok) throw new Error(`预期成功但失败了：${r.error}`)
  return r.data as T
}

/** 一份能喂给任意版式的内容 —— items 条数按各版式的要求裁到位 */
const contentFor = (pattern: string) => ({
  title: '标题', subtitle: '副标题', eyebrow: '01',
  quote: '一句引述', source: '出处',
  stat: { value: '87%', label: '续约率', note: '同比 +12pt' },
  items: [
    { label: '2024', title: '甲', body: '甲的说明' },
    { label: '2025', title: '乙', body: '乙的说明' },
    { label: '2026', title: '丙', body: '丙的说明' },
  ].slice(0, pattern === 'compare' ? 2 : 3),
})

describe('kernel · mintElementId', () => {
  it('returns a fresh id', () => {
    expect(mintElementId([emptySlide()], 'shp')).toBe('shp_1')
  })

  it('skips ids already used anywhere in the deck', () => {
    const slides: Slide[] = [
      { id: 'a', elements: [textEl('shp_1'), textEl('shp_2')] },
      { id: 'b', elements: [textEl('shp_3')] },
    ]
    expect(mintElementId(slides, 'shp')).toBe('shp_4')
  })

  it('is deterministic', () => {
    const slides = [emptySlide()]
    expect(mintElementId(slides, 'x')).toBe(mintElementId(slides, 'x'))
  })
})

describe('kernel · addShape', () => {
  it('builds a shape from a catalog name', () => {
    const slides = ok(applyAddShape([emptySlide()], 's1', {
      shape: 'roundRect', left: 100, top: 100, width: 300, height: 120, fill: '#2f6feb',
    })) as Slide[]

    const el = slides[0].elements[0]
    expect(el.type).toBe('shape')
    expect((el as { path: string }).path).toMatch(/^M /)
    expect((el as { path: string }).path).not.toMatch(/NaN/)
    // pathFormula 形状的 viewBox 必须换成实际宽高，否则圆角会被拉成椭圆角
    expect((el as { viewBox: number[] }).viewBox).toEqual([300, 120])
  })

  it('rejects an unknown shape and lists the options', () => {
    const r = applyAddShape([emptySlide()], 's1', {
      shape: 'dodecahedron', left: 0, top: 0, width: 10, height: 10, fill: '#000',
    })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('roundRect')
  })

  it('rejects an unknown slide', () => {
    const r = applyAddShape([emptySlide()], 'nope', {
      shape: 'rect', left: 0, top: 0, width: 10, height: 10, fill: '#000',
    })
    expect(r.ok).toBe(false)
  })

  it('carries optional decoration through', () => {
    const slides = ok(applyAddShape([emptySlide()], 's1', {
      shape: 'rect', left: 0, top: 0, width: 100, height: 100, fill: '#000',
      opacity: 0.2, outlineColor: '#fff', outlineWidth: 3, shadow: true, rotate: 45, name: '装饰',
    })) as Slide[]

    const el = slides[0].elements[0] as unknown as Record<string, unknown>
    expect(el.opacity).toBe(0.2)
    expect(el.outline).toEqual({ style: 'solid', width: 3, color: '#fff' })
    expect(el.shadow).toBeDefined()
    expect(el.rotate).toBe(45)
    expect(el.name).toBe('装饰')
  })

  it('escapes shape text so markup cannot leak in', () => {
    const slides = ok(applyAddShape([emptySlide()], 's1', {
      shape: 'pill', left: 0, top: 0, width: 100, height: 40, fill: '#000',
      text: '<b>&x</b>',
    })) as Slide[]
    const content = (slides[0].elements[0] as unknown as { text: { content: string } }).text.content
    expect(content).toContain('&lt;b&gt;&amp;x&lt;/b&gt;')
    expect(content).not.toContain('<b>')
  })

  it('produces an element that passes validateElement', () => {
    const slides = ok(applyAddShape([emptySlide()], 's1', {
      shape: 'chevron', left: 0, top: 0, width: 200, height: 80, fill: '#2f6feb',
    })) as Slide[]
    expect(validateElement(slides[0].elements[0])).toEqual({ ok: true })
  })
})

describe('kernel · addChart', () => {
  const spec = {
    chartType: 'bar' as const, left: 100, top: 100, width: 500, height: 300,
    labels: ['2024', '2025', '2026'], legends: ['营收'], series: [[1, 2, 3]],
  }

  it('builds a chart with theme colours', () => {
    const slides = ok(applyAddChart([emptySlide()], 's1', THEME, spec)) as Slide[]
    const el = slides[0].elements[0] as unknown as Record<string, any>
    expect(el.type).toBe('chart')
    expect(el.chartType).toBe('bar')
    expect(el.themeColors.length).toBeGreaterThan(0)
    expect(el.data.series).toEqual([[1, 2, 3]])
  })

  // 系列数和图例数对不上，画布上只是少画一根线，导出到 PPTX 是一份错位的内嵌表
  it('rejects a series/legend count mismatch', () => {
    const r = applyAddChart([emptySlide()], 's1', THEME, { ...spec, legends: ['营收', '利润'] })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('legends')
  })

  it('rejects a series/label length mismatch', () => {
    const r = applyAddChart([emptySlide()], 's1', THEME, { ...spec, series: [[1, 2]] })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('labels')
  })

  it('rejects empty data', () => {
    expect(applyAddChart([emptySlide()], 's1', THEME, { ...spec, labels: [], series: [[]] }).ok).toBe(false)
  })

  it('passes chart options through', () => {
    const slides = ok(applyAddChart([emptySlide()], 's1', THEME, { ...spec, stack: true })) as Slide[]
    expect((slides[0].elements[0] as unknown as Record<string, any>).options).toEqual({ stack: true })
  })

  // R-30：chart 从 PASSTHROUGH 后门挪进严格校验
  it('is no longer a passthrough type', () => {
    const bad = { id: 'c1', type: 'chart', left: 0, top: 0, width: 100, height: 100, rotate: 0 }
    expect(validateElement(bad).ok).toBe(false)
  })
})

describe('kernel · addTable', () => {
  const spec = {
    left: 100, top: 100, width: 700,
    rows: [['指标', '2025', '2026'], ['营收', '1.2 亿', '1.8 亿'], ['毛利率', '42%', '47%']],
  }

  it('builds a table with a header row', () => {
    const slides = ok(applyAddTable([emptySlide()], 's1', THEME, spec)) as Slide[]
    const el = slides[0].elements[0] as unknown as Record<string, any>
    expect(el.type).toBe('table')
    expect(el.data).toHaveLength(3)
    expect(el.data[0]).toHaveLength(3)
    expect(el.theme.rowHeader).toBe(true)
    expect(el.data[0][0].style.bold).toBe(true)
    expect(el.data[1][0].style.bold).toBeUndefined()
  })

  it('gives every cell a unique id', () => {
    const slides = ok(applyAddTable([emptySlide()], 's1', THEME, spec)) as Slide[]
    const el = slides[0].elements[0] as unknown as { data: { id: string }[][] }
    const ids = el.data.flat().map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('normalises column widths to sum to 1', () => {
    const slides = ok(applyAddTable([emptySlide()], 's1', THEME, { ...spec, colWidths: [2, 1, 1] })) as Slide[]
    const el = slides[0].elements[0] as unknown as { colWidths: number[] }
    expect(el.colWidths.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    expect(el.colWidths[0]).toBeCloseTo(0.5, 6)
  })

  it('rejects ragged rows with the offending index', () => {
    const r = applyAddTable([emptySlide()], 's1', THEME, {
      ...spec, rows: [['a', 'b'], ['c']],
    })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('rows[1]')
  })

  it('rejects empty input', () => {
    expect(applyAddTable([emptySlide()], 's1', THEME, { ...spec, rows: [] }).ok).toBe(false)
    expect(applyAddTable([emptySlide()], 's1', THEME, { ...spec, rows: [[]] }).ok).toBe(false)
  })

  it('sizes height from the row count', () => {
    const slides = ok(applyAddTable([emptySlide()], 's1', THEME, { ...spec, rowHeight: 50 })) as Slide[]
    expect((slides[0].elements[0] as unknown as { height: number }).height).toBe(150)
  })
})

describe('kernel · addLine', () => {
  it('builds a line with a relative endpoint', () => {
    const slides = ok(applyAddLine([emptySlide()], 's1', {
      left: 72, top: 300, end: [856, 0], color: '#dddddd',
    })) as Slide[]
    const el = slides[0].elements[0] as unknown as Record<string, any>
    expect(el.type).toBe('line')
    expect(el.start).toEqual([0, 0])
    expect(el.end).toEqual([856, 0])
    expect(el.width).toBe(2)
  })

  it('rejects a zero-length line', () => {
    const r = applyAddLine([emptySlide()], 's1', { left: 0, top: 0, end: [0, 0], color: '#000' })
    expect(r.ok).toBe(false)
  })

  it('supports arrow endpoints', () => {
    const slides = ok(applyAddLine([emptySlide()], 's1', {
      left: 0, top: 0, end: [100, 100], color: '#000', endPoint: 'arrow', style: 'dashed',
    })) as Slide[]
    const el = slides[0].elements[0] as unknown as Record<string, any>
    expect(el.points).toEqual(['', 'arrow'])
    expect(el.style).toBe('dashed')
  })
})

describe('kernel · arrangeElements', () => {
  const threeBoxes = (): Slide[] => [{
    id: 's1',
    elements: [
      textEl('a', { left: 10, top: 10, width: 100, height: 50 }),
      textEl('b', { left: 200, top: 30, width: 80, height: 40 }),
      textEl('c', { left: 500, top: 70, width: 120, height: 60 }),
    ],
  }]

  const at = (slides: Slide[], id: string) =>
    slides[0].elements.find(e => e.id === id) as unknown as { left: number, top: number, width: number, height: number }

  it('requires at least one operation', () => {
    expect(applyArrangeElements(threeBoxes(), ['a', 'b'], {}).ok).toBe(false)
  })

  it('requires at least two elements', () => {
    expect(applyArrangeElements(threeBoxes(), ['a'], { align: 'left' }).ok).toBe(false)
  })

  it('reports missing elements by id', () => {
    const r = applyArrangeElements(threeBoxes(), ['a', 'zzz'], { align: 'left' })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('zzz')
  })

  it('refuses to arrange across slides', () => {
    const slides: Slide[] = [
      { id: 's1', elements: [textEl('a')] },
      { id: 's2', elements: [textEl('b')] },
    ]
    const r = applyArrangeElements(slides, ['a', 'b'], { align: 'left' })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('同一页')
  })

  // line 没有 height，按矩形语义排列会把它挪歪
  it('refuses to arrange line elements', () => {
    const slides: Slide[] = [{
      id: 's1',
      elements: [
        textEl('a'),
        { id: 'l', type: 'line', left: 0, top: 0, start: [0, 0], end: [10, 0], style: 'solid', color: '#000', points: ['', ''], width: 2 } as unknown as PPTElement,
      ],
    }]
    const r = applyArrangeElements(slides, ['a', 'l'], { align: 'left' })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('线条')
  })

  it.each([
    ['left', (s: Slide[]) => [at(s, 'a').left, at(s, 'b').left, at(s, 'c').left], [10, 10, 10]],
    ['top', (s: Slide[]) => [at(s, 'a').top, at(s, 'b').top, at(s, 'c').top], [10, 10, 10]],
  ] as [string, (s: Slide[]) => number[], number[]][])('aligns %s', (mode, read, expected) => {
    const slides = ok(applyArrangeElements(threeBoxes(), ['a', 'b', 'c'], { align: mode as 'left' })) as Slide[]
    expect(read(slides)).toEqual(expected)
  })

  it('aligns right edges', () => {
    const slides = ok(applyArrangeElements(threeBoxes(), ['a', 'b', 'c'], { align: 'right' })) as Slide[]
    for (const id of ['a', 'b', 'c']) {
      expect(at(slides, id).left + at(slides, id).width).toBe(620)
    }
  })

  it('aligns horizontal centres', () => {
    const slides = ok(applyArrangeElements(threeBoxes(), ['a', 'b', 'c'], { align: 'hcenter' })) as Slide[]
    const centres = ['a', 'b', 'c'].map(id => at(slides, id).left + at(slides, id).width / 2)
    expect(new Set(centres).size).toBe(1)
  })

  it('distributes horizontally keeping the ends fixed', () => {
    const before = threeBoxes()
    const slides = ok(applyArrangeElements(before, ['a', 'b', 'c'], { distribute: 'horizontal' })) as Slide[]
    expect(at(slides, 'a').left).toBe(10)
    expect(at(slides, 'c').left + at(slides, 'c').width).toBeCloseTo(620, 1)

    const gap1 = at(slides, 'b').left - (at(slides, 'a').left + at(slides, 'a').width)
    const gap2 = at(slides, 'c').left - (at(slides, 'b').left + at(slides, 'b').width)
    expect(gap1).toBeCloseTo(gap2, 1)
  })

  it('distributes with a fixed gap from the first element', () => {
    const slides = ok(applyArrangeElements(threeBoxes(), ['a', 'b', 'c'], { distribute: 'horizontal', gap: 20 })) as Slide[]
    expect(at(slides, 'a').left).toBe(10)
    expect(at(slides, 'b').left).toBe(130) // 10 + 100 + 20
    expect(at(slides, 'c').left).toBe(230) // 130 + 80 + 20
  })

  it('combines align and distribute in one call', () => {
    const slides = ok(applyArrangeElements(threeBoxes(), ['a', 'b', 'c'], {
      align: 'top', distribute: 'horizontal', gap: 10,
    })) as Slide[]
    expect(['a', 'b', 'c'].map(id => at(slides, id).top)).toEqual([10, 10, 10])
    expect(at(slides, 'b').left).toBe(120)
  })

  it('rounds away floating point dust', () => {
    const slides = ok(applyArrangeElements(threeBoxes(), ['a', 'b', 'c'], { distribute: 'horizontal' })) as Slide[]
    for (const id of ['a', 'b', 'c']) {
      expect(at(slides, id).left * 10 % 1).toBe(0)
    }
  })

  it('leaves the input untouched', () => {
    const before = threeBoxes()
    applyArrangeElements(before, ['a', 'b', 'c'], { align: 'left' })
    expect(at(before, 'b').left).toBe(200)
  })
})

describe('kernel · applyLayout', () => {
  it('rejects an unknown pattern', () => {
    const r = applyLayoutToSlide([emptySlide()], 's1', THEME, 'mosaic', { title: 'x' })
    expect(r.ok).toBe(false)
  })

  it('rejects content that cannot fill the layout', () => {
    const r = applyLayoutToSlide([emptySlide()], 's1', THEME, 'cards', { title: 'x' })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('items')
  })

  it('stamps layout, type and background on the slide', () => {
    const slides = ok(applyLayoutToSlide([emptySlide()], 's1', THEME, 'title-center', {
      title: '标题', subtitle: '副标题',
    })) as Slide[]
    expect(slides[0].layout).toBe('title-center')
    expect(slides[0].type).toBe('cover')
    expect(slides[0].background).toEqual({ type: 'solid', color: '#ffffff' })
  })

  // 版式的价值来自「所有元素同属一套网格」，留半页旧元素等于留半套旧网格
  it('replaces the whole page', () => {
    const before: Slide[] = [{ id: 's1', elements: [textEl('old')], animations: [] }]
    const slides = ok(applyLayoutToSlide(before, 's1', THEME, 'quote', { quote: '一句话' })) as Slide[]
    expect(slides[0].elements.some(e => e.id === 'old')).toBe(false)
  })

  it.each(LAYOUT_PATTERNS)('%s produces a lint-clean slide', pattern => {
    const slides = ok(applyLayoutToSlide([emptySlide()], 's1', THEME, pattern, contentFor(pattern))) as Slide[]
    const issues = lintSlide(slides[0])
    expect(issues, `${pattern}: ${issues.map(i => i.message).join(' / ')}`).toHaveLength(0)
  })

  it.each(LAYOUT_PATTERNS)('%s produces elements that all pass validateElement', pattern => {
    const slides = ok(applyLayoutToSlide([emptySlide()], 's1', THEME, pattern, contentFor(pattern))) as Slide[]
    for (const el of slides[0].elements) {
      expect(validateElement(el), `${pattern} / ${el.id}`).toEqual({ ok: true })
    }
  })

  it('does not collide ids when re-applied to the same slide', () => {
    let slides = ok(applyLayoutToSlide([emptySlide()], 's1', THEME, 'quote', { quote: 'a' })) as Slide[]
    slides = ok(applyLayoutToSlide(slides, 's1', THEME, 'end', { title: 'b' })) as Slide[]
    const ids = slides[0].elements.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('honours palette overrides', () => {
    const slides = ok(applyLayoutToSlide([emptySlide()], 's1', THEME, 'title-center', { title: 'x' }, {
      paletteOverride: { background: '#0a0e27' },
    })) as Slide[]
    expect(slides[0].background).toEqual({ type: 'solid', color: '#0a0e27' })
  })

  it('can skip animations', () => {
    const slides = ok(applyLayoutToSlide([emptySlide()], 's1', THEME, 'end', { title: 'x' }, {
      animate: false,
    })) as Slide[]
    expect(slides[0].animations).toHaveLength(0)
  })
})

describe('kernel · setSlideTransition', () => {
  it('sets a known transition', () => {
    const slides = ok(applySetSlideTransition([emptySlide()], 's1', 'fade')) as Slide[]
    expect(slides[0].turningMode).toBe('fade')
  })

  it('rejects an unknown one and lists the options', () => {
    const r = applySetSlideTransition([emptySlide()], 's1', 'cube')
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('fade')
  })

  it('rejects an unknown slide', () => {
    expect(applySetSlideTransition([emptySlide()], 'nope', 'fade').ok).toBe(false)
  })
})

describe('kernel · deck-level design lint', () => {
  const withLayout = (id: string, layout: string): Slide =>
    ok(applyLayoutToSlide([{ id, elements: [] }], id, THEME, layout, contentFor(layout)))[0] as Slide

  it('flags two adjacent slides sharing a layout', () => {
    const issues = lintDeckDesign([withLayout('s1', 'cards'), withLayout('s2', 'cards')])
    expect(issues.some(i => i.message.includes('同一个版式'))).toBe(true)
  })

  it('accepts alternating layouts', () => {
    const issues = lintDeckDesign([withLayout('s1', 'cards'), withLayout('s2', 'compare')])
    expect(issues.some(i => i.message.includes('版式'))).toBe(false)
  })

  // 没有 layout 标记的页（手工搭的）靠结构指纹判重
  it('falls back to a structural signature when layout is unset', () => {
    const page = (id: string): Slide => ({
      id,
      elements: [
        textEl(`${id}_1`, { left: 72, top: 56, width: 800, height: 60 }),
        textEl(`${id}_2`, { left: 72, top: 160, width: 800, height: 200 }),
        textEl(`${id}_3`, { left: 72, top: 400, width: 800, height: 60 }),
      ],
    })
    const issues = lintDeckDesign([page('a'), page('b')])
    expect(issues.some(i => i.message.includes('结构完全相同'))).toBe(true)
  })

  it('flags a text-only slide', () => {
    const slide: Slide = {
      id: 's1',
      elements: [textEl('a'), textEl('b'), textEl('c')],
    }
    const issues = lintDeckDesign([slide])
    expect(issues.some(i => i.message.includes('只有文字'))).toBe(true)
  })

  it('does not flag a slide that has a shape', () => {
    const slide = withLayout('s1', 'cards')
    expect(lintDeckDesign([slide]).some(i => i.message.includes('只有文字'))).toBe(false)
  })

  it('flags a nearly empty slide', () => {
    const issues = lintDeckDesign([{ id: 's1', elements: [textEl('a')] }])
    expect(issues.some(i => i.message.includes('元素'))).toBe(true)
  })

  it('ignores completely empty slides', () => {
    expect(lintDeckDesign([emptySlide('a'), emptySlide('b')])).toHaveLength(0)
  })

  it('flags low animation variety', () => {
    const slides = [withLayout('s1', 'cards'), withLayout('s2', 'compare'), withLayout('s3', 'bullets')]
    for (const s of slides) {
      s.animations = s.elements.slice(0, 2).map((el, i) => ({
        id: `${s.id}_a${i}`, elId: el.id, effect: 'fade' as const, type: 'in' as const,
        duration: 500, trigger: 'click' as const,
      }))
    }
    const issues = lintDeckDesign(slides)
    expect(issues.some(i => i.message.includes('种动画效果'))).toBe(true)
    expect(issues.some(i => i.message.includes('淡入系'))).toBe(true)
  })

  it('accepts a varied animation set', () => {
    const slides = [withLayout('s1', 'cards'), withLayout('s2', 'compare'), withLayout('s3', 'timeline')]
    const issues = lintDeckDesign(slides)
    expect(issues.some(i => i.message.includes('种动画效果'))).toBe(false)
    expect(issues.some(i => i.message.includes('淡入系'))).toBe(false)
  })

  it('reports design issues as warnings, never errors', () => {
    const issues = lintDeckDesign([
      { id: 's1', elements: [textEl('a')] },
      { id: 's2', elements: [textEl('b')] },
    ])
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every(i => i.level === 'warning')).toBe(true)
  })

  it('can be switched off in lintDeck', () => {
    const slides = [{ id: 's1', elements: [textEl('a')] }]
    expect(lintDeck(slides, { designChecks: false })).toHaveLength(0)
    expect(lintDeck(slides).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// R-39 · 出场顺序 lint
//
// 这条规则守的是**手工搭页**那条路：agent 用 addElement + addAnimation 自己拼时间线，
// 就可能拼出一个读不通的顺序。版式那条路由 layouts.ts 保证，
// 所以第一条测试是「applyLayout 的产物必须零告警」——
// 它一旦报警，agent 每跑一份 deck 都会收到一条自己修不掉的意见，
// Reviewer → Generator 就会白白多绕一圈（08-expressiveness.md 第四节）。
// ---------------------------------------------------------------------------

describe('kernel · 出场顺序 lint', () => {
  const anim = (
    id: string, elId: string, trigger: 'click' | 'auto' | 'meantime',
    over: Partial<{ type: 'in' | 'out' | 'attention', effect: string }> = {},
  ) => ({
    id, elId, effect: 'fade', type: 'in', duration: 500, trigger, ...over,
  } as unknown as NonNullable<Slide['animations']>[number])

  const shapeEl = (id: string, name: string): PPTElement => ({
    id, type: 'shape', left: 0, top: 0, width: 100, height: 100, rotate: 0,
    viewBox: [200, 200], path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z', fixedRatio: false,
    fill: '#2f6feb', name,
  } as unknown as PPTElement)

  it.each(LAYOUT_PATTERNS)('%s 的 applyLayout 产物零告警', pattern => {
    const slides = ok(applyLayoutToSlide([emptySlide()], 's1', THEME, pattern, contentFor(pattern))) as Slide[]
    const issues = lintSlideAnimationOrder(slides[0], 0)
    expect(issues.map(i => i.message), pattern).toEqual([])
  })

  it('A · 报出没挂动画的文本', () => {
    const slide: Slide = {
      id: 's1',
      elements: [textEl('t', { textType: 'title', name: '标题' }), textEl('b', { textType: 'item', name: '正文' })],
      animations: [anim('a1', 't', 'click')],
    }
    const issues = lintSlideAnimationOrder(slide, 2)
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('第 3 页')
    expect(issues[0].message).toContain('"正文"')
    expect(issues[0].message).toContain('没有入场动画')
  })

  it('A · 不管没挂动画的形状 —— 一块常驻底板是正常设计', () => {
    const slide: Slide = {
      id: 's1',
      elements: [shapeEl('bg', '底板'), textEl('t', { textType: 'title' })],
      animations: [anim('a1', 't', 'click')],
    }
    expect(lintSlideAnimationOrder(slide)).toHaveLength(0)
  })

  it('B · 报出排在正文之后的标题', () => {
    const slide: Slide = {
      id: 's1',
      elements: [textEl('body', { textType: 'item', name: '正文' }), textEl('t', { textType: 'title', name: '标题' })],
      animations: [anim('a1', 'body', 'click'), anim('a2', 't', 'auto')],
    }
    const issues = lintSlideAnimationOrder(slide)
    expect(issues.some(i => i.message.includes('排在正文之后出场'))).toBe(true)
  })

  // eyebrow 和章节号总是紧贴标题排版，它们先出来是建场不是抢跑
  it('B · 放过标题块内部的先后（eyebrow / 章节号）', () => {
    const slide: Slide = {
      id: 's1',
      elements: [
        textEl('eb', { textType: 'header', name: 'eyebrow' }),
        textEl('num', { textType: 'partNumber', name: '章节号' }),
        textEl('t', { textType: 'title', name: '标题' }),
      ],
      animations: [anim('a1', 'eb', 'click'), anim('a2', 'num', 'auto'), anim('a3', 't', 'auto')],
    }
    expect(lintSlideAnimationOrder(slide)).toHaveLength(0)
  })

  it('C · 报出标题之前那一整格纯装饰', () => {
    const slide: Slide = {
      id: 's1',
      elements: [shapeEl('ring', '装饰环'), textEl('t', { textType: 'title', name: '标题' })],
      animations: [anim('a1', 'ring', 'click'), anim('a2', 't', 'auto')],
    }
    const issues = lintSlideAnimationOrder(slide)
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('只有装饰性图形')
    expect(issues[0].message).toContain('装饰环')
  })

  it('C · 装饰与标题同格（meantime）不报', () => {
    const slide: Slide = {
      id: 's1',
      elements: [shapeEl('ring', '装饰环'), textEl('t', { textType: 'title', name: '标题' })],
      animations: [anim('a1', 't', 'click'), anim('a2', 'ring', 'meantime')],
    }
    expect(lintSlideAnimationOrder(slide)).toHaveLength(0)
  })

  it('整页一条入场动画都没有 —— 全静态页是合法的，不报', () => {
    const slide: Slide = {
      id: 's1',
      elements: [textEl('a'), textEl('b'), shapeEl('c', '底板')],
    }
    expect(lintSlideAnimationOrder(slide)).toHaveLength(0)
    expect(lintSlideAnimationOrder({ ...slide, animations: [] })).toHaveLength(0)
  })

  it('孤儿动画不参与分步（它指向的元素已经不在了）', () => {
    const slide: Slide = {
      id: 's1',
      elements: [textEl('t', { textType: 'title', name: '标题' })],
      animations: [anim('a1', 'ghost', 'click'), anim('a2', 't', 'click')],
    }
    expect(lintSlideAnimationOrder(slide)).toHaveLength(0)
  })

  // lintSlide 的结果跟在每一次元素改动后面返回给 agent。
  // 手工搭页时元素和动画是分两步加的，中间那一刻必然「有元素没挂动画」——
  // 在那里报警等于每加一个元素就催一次，白烧步数还催不出正确结果
  it('不进 lintSlide，只进 lintDeck', () => {
    const slide: Slide = {
      id: 's1',
      elements: [textEl('t', { textType: 'title', name: '标题' }), textEl('b', { textType: 'item', name: '正文' })],
      animations: [anim('a1', 't', 'click')],
    }
    expect(lintSlide(slide).some(i => i.message.includes('入场动画'))).toBe(false)
    expect(lintDeck([slide]).some(i => i.message.includes('入场动画'))).toBe(true)
  })

  it('随 designChecks:false 一起关掉', () => {
    const slide: Slide = {
      id: 's1',
      elements: [textEl('t', { textType: 'title' }), textEl('b', { textType: 'item' })],
      animations: [anim('a1', 't', 'click')],
    }
    expect(lintDeck([slide], { designChecks: false }).some(i => i.message.includes('入场动画'))).toBe(false)
  })

  it('全是 warning，不会把 deck 判成结构错误', () => {
    const slide: Slide = {
      id: 's1',
      elements: [shapeEl('ring', '环'), textEl('t', { textType: 'title' }), textEl('b', { textType: 'item' })],
      animations: [anim('a1', 'ring', 'click'), anim('a2', 't', 'auto')],
    }
    const issues = lintSlideAnimationOrder(slide)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every(i => i.level === 'warning')).toBe(true)
  })
})
