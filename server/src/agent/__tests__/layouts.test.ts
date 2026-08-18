import { describe, it, expect } from 'vitest'
import type { PPTElement, SlideTheme } from '@/types/slides'
import { ANIMATION_DEFS } from '@/configs/animation'
import {
  LAYOUT_PATTERNS, LAYOUT_META, buildLayout, validateLayoutContent,
  isLayoutPattern, describeLayouts,
  type LayoutPattern, type LayoutContent,
} from '../layouts'
import { buildPalette, CANVAS_WIDTH, CANVAS_HEIGHT, SAFE, contrastRatio } from '../design'

const THEME: SlideTheme = {
  themeColors: ['#2f6feb', '#f2596b', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
  fontColor: '#1a1a1a',
  fontName: '',
  backgroundColor: '#ffffff',
  shadow: { h: 3, v: 3, blur: 2, color: '#808080' },
  outline: { width: 2, color: '#525252', style: 'solid' },
}

const PALETTE = buildPalette(THEME)

/** 每个版式一份能通过校验的内容 */
const CONTENT: Record<LayoutPattern, LayoutContent> = {
  'title-center': { title: '年度产品回顾', subtitle: '2026 上半年', eyebrow: 'ANNUAL REVIEW' },
  'title-split': { title: '重新定义协作', subtitle: '一个更快的工作方式', eyebrow: '产品发布' },
  'section': { title: '市场表现', subtitle: '三个季度的关键数据', eyebrow: '02' },
  'bullets': {
    title: '三个核心结论',
    items: [
      { title: '响应更快', body: '端到端时延从 800ms 降到 200ms' },
      { title: '成本更低', body: '单位成本下降 40%' },
      { title: '零运维', body: '不再需要专职值班' },
    ],
  },
  'cards': {
    title: '产品能力',
    subtitle: '三块能力互相独立又能组合',
    items: [
      { title: '实时协作', body: '多人同时编辑同一份文稿' },
      { title: '版本回溯', body: '任意时点可回滚' },
      { title: '权限分级', body: '按组织架构继承' },
    ],
  },
  'compare': {
    title: '迁移前后',
    items: [
      { title: '迁移前', body: '三套系统各自维护，数据对不上' },
      { title: '迁移后', body: '单一数据源，口径统一' },
    ],
  },
  'timeline': {
    title: '演进路线',
    items: [
      { label: '2024', title: '立项', body: '完成技术选型' },
      { label: '2025', title: '内测', body: '首批 20 家客户' },
      { label: '2026', title: '正式发布', body: '全量开放' },
    ],
  },
  'stat': { stat: { value: '87%', label: '客户续约率', note: '同比提升 12 个百分点' }, eyebrow: '关键指标' },
  'quote': { quote: '最好的界面是没有界面。', source: '—— 某产品负责人' },
  'end': { title: '谢谢', subtitle: 'hello@example.com' },
}

const box = (el: PPTElement) =>
  'width' in el && 'height' in el && 'left' in el && 'top' in el
    ? { left: el.left, top: el.top, width: el.width, height: el.height }
    : null

describe('layouts · metadata', () => {
  it('every pattern has metadata and content fixtures', () => {
    for (const p of LAYOUT_PATTERNS) {
      expect(LAYOUT_META[p], p).toBeDefined()
      expect(LAYOUT_META[p].pattern).toBe(p)
      expect(CONTENT[p], `缺少 ${p} 的测试内容`).toBeDefined()
    }
  })

  it('isLayoutPattern rejects anything not in the list', () => {
    expect(isLayoutPattern('cards')).toBe(true)
    expect(isLayoutPattern('CARDS')).toBe(false)
    expect(isLayoutPattern('grid-9')).toBe(false)
    expect(isLayoutPattern(42)).toBe(false)
  })

  it('describeLayouts mentions every pattern once', () => {
    const text = describeLayouts()
    for (const p of LAYOUT_PATTERNS) {
      expect(text.split(`- ${p}（`).length - 1, p).toBe(1)
    }
  })
})

describe('layouts · content validation', () => {
  it('accepts the fixtures', () => {
    for (const p of LAYOUT_PATTERNS) {
      expect(validateLayoutContent(p, CONTENT[p]), p).toBeNull()
    }
  })

  it('rejects a missing title', () => {
    expect(validateLayoutContent('cards', { items: CONTENT.cards.items })).toContain('title')
  })

  it('rejects blank-only strings', () => {
    expect(validateLayoutContent('end', { title: '   ' })).toContain('title')
  })

  it('rejects the wrong number of items', () => {
    expect(validateLayoutContent('compare', { title: 't', items: [{ title: 'a' }] })).toContain('2~2')
    expect(validateLayoutContent('cards', {
      title: 't',
      items: Array.from({ length: 5 }, (_, i) => ({ title: `${i}` })),
    })).toContain('2~4')
  })

  it('rejects an empty item', () => {
    expect(validateLayoutContent('compare', { title: 't', items: [{ title: 'a' }, {}] }))
      .toContain('items[1]')
  })

  it('requires stat.value for the stat layout', () => {
    expect(validateLayoutContent('stat', {})).toContain('stat.value')
    expect(validateLayoutContent('stat', { stat: { value: '' } })).toContain('stat.value')
  })

  it('requires quote text for the quote layout', () => {
    expect(validateLayoutContent('quote', {})).toContain('quote')
  })
})

describe('layouts · geometry', () => {
  const built = Object.fromEntries(
    LAYOUT_PATTERNS.map(p => [p, buildLayout(p, CONTENT[p], PALETTE, `t_${p}`)]),
  ) as Record<LayoutPattern, ReturnType<typeof buildLayout>>

  it.each(LAYOUT_PATTERNS)('%s produces elements', p => {
    expect(built[p].elements.length).toBeGreaterThanOrEqual(3)
  })

  it.each(LAYOUT_PATTERNS)('%s gives every element a unique id', p => {
    const ids = built[p].elements.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(LAYOUT_PATTERNS)('%s keeps every element inside the canvas', p => {
    for (const el of built[p].elements) {
      const b = box(el)
      if (!b) continue
      expect(b.left, `${p} / ${el.id} left`).toBeGreaterThanOrEqual(0)
      expect(b.top, `${p} / ${el.id} top`).toBeGreaterThanOrEqual(0)
      expect(b.left + b.width, `${p} / ${el.id} right`).toBeLessThanOrEqual(CANVAS_WIDTH + 1)
      expect(b.top + b.height, `${p} / ${el.id} bottom`).toBeLessThanOrEqual(CANVAS_HEIGHT + 1)
    }
  })

  it.each(LAYOUT_PATTERNS)('%s never emits a zero-sized element', p => {
    for (const el of built[p].elements) {
      const b = box(el)
      if (!b) continue
      expect(b.width, `${p} / ${el.id}`).toBeGreaterThan(0)
      expect(b.height, `${p} / ${el.id}`).toBeGreaterThan(0)
    }
  })

  // 「每页至少一个非文本元素」是验收标准之一，版式必须自己就满足
  it.each(LAYOUT_PATTERNS)('%s includes a non-text element', p => {
    expect(built[p].elements.some(el => el.type !== 'text'), p).toBe(true)
  })

  it.each(LAYOUT_PATTERNS)('%s produces a valid shape path wherever it uses shapes', p => {
    for (const el of built[p].elements) {
      if (el.type !== 'shape') continue
      expect(el.path, `${p} / ${el.id}`).not.toMatch(/NaN|Infinity|undefined/)
      expect(el.viewBox[0]).toBeGreaterThan(0)
      expect(el.viewBox[1]).toBeGreaterThan(0)
    }
  })

  it.each(LAYOUT_PATTERNS)('%s writes real HTML into text elements', p => {
    for (const el of built[p].elements) {
      if (el.type !== 'text') continue
      expect(el.content, `${p} / ${el.id}`).toMatch(/^<p[ >]/)
      expect(el.defaultFontName.length).toBeGreaterThan(0)
      expect(el.defaultColor).toMatch(/^#/)
    }
  })

  it.each(LAYOUT_PATTERNS)('%s keeps content inside the safe area', p => {
    const contentful = built[p].elements.filter(el => el.type === 'text')
    for (const el of contentful) {
      const b = box(el)!
      // 装饰性元素可以出血，文字不行
      expect(b.left, `${p} / ${el.id}`).toBeGreaterThanOrEqual(SAFE.left - 12)
      expect(b.left + b.width, `${p} / ${el.id}`).toBeLessThanOrEqual(SAFE.right + 12)
    }
  })

  it('marks the right slide type', () => {
    expect(built['title-center'].slideType).toBe('cover')
    expect(built['title-split'].slideType).toBe('cover')
    expect(built.section.slideType).toBe('transition')
    expect(built.end.slideType).toBe('end')
    expect(built.cards.slideType).toBe('content')
  })

  it('sets a background on every layout', () => {
    for (const p of LAYOUT_PATTERNS) {
      expect(built[p].background.type, p).toBe('solid')
      expect(built[p].background.color, p).toBe(PALETTE.background)
    }
  })
})

describe('layouts · animation choreography', () => {
  const built = Object.fromEntries(
    LAYOUT_PATTERNS.map(p => [p, buildLayout(p, CONTENT[p], PALETTE, `t_${p}`)]),
  ) as Record<LayoutPattern, ReturnType<typeof buildLayout>>

  it.each(LAYOUT_PATTERNS)('%s animates, and every animation targets a real element', p => {
    const ids = new Set(built[p].elements.map(e => e.id))
    expect(built[p].animations.length, p).toBeGreaterThan(0)
    for (const a of built[p].animations) {
      expect(ids.has(a.elId), `${p} / ${a.id} → ${a.elId}`).toBe(true)
    }
  })

  it.each(LAYOUT_PATTERNS)('%s uses unique animation ids', p => {
    const ids = built[p].animations.map(a => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(LAYOUT_PATTERNS)('%s only uses effects that exist and are entrances', p => {
    for (const a of built[p].animations) {
      const def = ANIMATION_DEFS[a.effect]
      expect(def, `${p}: 未知效果 ${a.effect}`).toBeDefined()
      expect(def.type, `${p} / ${a.effect}`).toBe('in')
      expect(a.type).toBe('in')
    }
  })

  it.each(LAYOUT_PATTERNS)('%s starts its timeline with a click', p => {
    expect(built[p].animations[0].trigger, p).toBe('click')
  })

  // 版式自带编排的意义就在这里：不同版式天然给出不同动画，
  // agent 什么都不做，整份 deck 的动画种类也不会只剩一种
  it('gives different layouts visibly different choreography', () => {
    const signatures = LAYOUT_PATTERNS.map(
      p => [...new Set(built[p].animations.map(a => a.effect))].sort().join(','),
    )
    expect(new Set(signatures).size).toBeGreaterThanOrEqual(7)
  })

  it('covers more than the fade family across the layout set', () => {
    const all = new Set(LAYOUT_PATTERNS.flatMap(p => built[p].animations.map(a => a.effect)))
    expect(all.size).toBeGreaterThanOrEqual(8)
    expect([...all].some(e => !e.startsWith('fade'))).toBe(true)
  })

  it('can be turned off', () => {
    const r = buildLayout('cards', CONTENT.cards, PALETTE, 'x', { animate: false })
    expect(r.animations).toHaveLength(0)
    expect(r.elements.length).toBeGreaterThan(0)
  })
})

describe('layouts · robustness', () => {
  it('survives a dark palette', () => {
    const dark = buildPalette({ ...THEME, backgroundColor: '#0a0e27', fontColor: '#eeeeee' })
    for (const p of LAYOUT_PATTERNS) {
      const r = buildLayout(p, CONTENT[p], dark, `d_${p}`)
      expect(r.elements.length, p).toBeGreaterThan(0)
      for (const el of r.elements) {
        if (el.type !== 'text') continue
        expect(contrastRatio(el.defaultColor, dark.background), `${p} / ${el.id}`).toBeGreaterThan(2.5)
      }
    }
  })

  it('survives very long text without going off-canvas', () => {
    const long = '很长的一段说明文字'.repeat(12)
    const r = buildLayout('cards', {
      title: long,
      items: [{ title: long, body: long }, { title: long, body: long }],
    }, PALETTE, 'long')
    for (const el of r.elements) {
      const b = box(el)
      if (!b) continue
      expect(b.left + b.width).toBeLessThanOrEqual(CANVAS_WIDTH + 1)
      expect(b.width).toBeGreaterThan(0)
    }
  })

  // 引述长度完全不可控 —— 固定字号的话，长引述会把元素顶出画布底边
  it('shrinks the quote instead of overflowing', () => {
    const short = buildLayout('quote', { quote: '少即是多。' }, PALETTE, 'q1')
    const long = buildLayout('quote', { quote: '很长的一段引述文字'.repeat(20) }, PALETTE, 'q2')

    const sizeOf = (r: ReturnType<typeof buildLayout>) => {
      const el = r.elements.find(e => e.type === 'text' && e.textType === 'content')!
      return Number(/font-size:(\d+)px/.exec((el as { content: string }).content)![1])
    }
    expect(sizeOf(long)).toBeLessThan(sizeOf(short))

    for (const el of long.elements) {
      const b = box(el)
      if (!b) continue
      expect(b.top + b.height, el.id).toBeLessThanOrEqual(CANVAS_HEIGHT + 1)
    }
  })

  it('shrinks an over-long cover title', () => {
    const long = buildLayout('title-center', { title: '一个特别特别长的主标题'.repeat(6) }, PALETTE, 'c1')
    for (const el of long.elements) {
      const b = box(el)
      if (!b) continue
      expect(b.top + b.height, el.id).toBeLessThanOrEqual(CANVAS_HEIGHT + 1)
    }
  })

  it('survives minimum item counts', () => {
    const r = buildLayout('timeline', {
      title: 't',
      items: [{ title: 'a' }, { title: 'b' }, { title: 'c' }],
    }, PALETTE, 'min')
    expect(r.elements.length).toBeGreaterThan(3)
  })

  it('survives maximum item counts', () => {
    const r = buildLayout('bullets', {
      title: 't',
      items: Array.from({ length: 6 }, (_, i) => ({ title: `第 ${i + 1} 条`, body: '说明' })),
    }, PALETTE, 'max')
    for (const el of r.elements) {
      const b = box(el)
      if (!b) continue
      expect(b.top + b.height, el.id).toBeLessThanOrEqual(CANVAS_HEIGHT + 1)
    }
  })

  it('keeps ids stable for the same prefix and input', () => {
    const a = buildLayout('cards', CONTENT.cards, PALETTE, 'same')
    const b = buildLayout('cards', CONTENT.cards, PALETTE, 'same')
    expect(a.elements.map(e => e.id)).toEqual(b.elements.map(e => e.id))
  })

  it('keeps ids distinct for different prefixes', () => {
    const a = buildLayout('cards', CONTENT.cards, PALETTE, 'p1')
    const b = buildLayout('cards', CONTENT.cards, PALETTE, 'p2')
    const overlap = a.elements.map(e => e.id).filter(id => b.elements.some(e => e.id === id))
    expect(overlap).toHaveLength(0)
  })
})
