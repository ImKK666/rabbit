import { describe, it, expect } from 'vitest'
import type { PPTElement, PPTAnimation, SlideTheme } from '@/types/slides'
import { ANIMATION_DEFS } from '@/configs/animation'
import { groupTriggersIntoSteps, flattenTriggerSteps } from '@/utils/animationSteps'
import {
  LAYOUT_PATTERNS, LAYOUT_META, buildLayout, validateLayoutContent,
  isLayoutPattern, describeLayouts, signatureVariant,
  type LayoutPattern, type LayoutContent,
} from '../layouts'
import {
  buildPalette, CANVAS_WIDTH, CANVAS_HEIGHT, SAFE, contrastRatio, PALETTE_STYLES,
  type Palette, type PaletteStyle,
} from '../design'

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
  'image-grid': {
    title: '三块核心能力',
    subtitle: '每一块都可以单独采购',
    items: [
      { title: '实时协作', body: '多人同时编辑同一份文稿' },
      { title: '版本回溯', body: '任意时点可回滚' },
      { title: '权限分级', body: '按组织架构继承' },
    ],
  },
  'split-figure': {
    title: '为什么是现在',
    subtitle: '三个条件同时成熟',
    items: [
      { title: '算力便宜了', body: '单位推理成本三年降到 1/40' },
      { title: '模型能用了', body: '长上下文与工具调用都已可靠' },
    ],
  },
  'full-figure': { title: '把复杂留给自己', subtitle: '把简单留给用户', eyebrow: '产品理念' },
}

/**
 * 只给必填字段的一份内容。
 *
 * 版式里大量元素是条件创建的（没有 subtitle 就没有那个文本框），
 * 而 `Builder.animate` 遇到 null 会静默跳过 —— 于是「谁领跑」这件事在两种输入下
 * 可能落到不同的元素身上。出场顺序的检查必须两份都跑。
 */
const MINIMAL: Record<LayoutPattern, LayoutContent> = {
  'title-center': { title: '年度产品回顾' },
  'title-split': { title: '重新定义协作' },
  'section': { title: '市场表现' },
  'bullets': { title: '三个核心结论', items: [{ title: '甲' }, { title: '乙' }] },
  'cards': { title: '产品能力', items: [{ title: '甲' }, { title: '乙' }] },
  'compare': { title: '迁移前后', items: [{ title: '甲' }, { title: '乙' }] },
  'timeline': { title: '演进路线', items: [{ title: '甲' }, { title: '乙' }, { title: '丙' }] },
  'stat': { stat: { value: '87%' } },
  'quote': { quote: '少即是多。' },
  'end': { title: '谢谢' },
  'image-grid': { title: '三块能力', items: [{ title: '甲' }, { title: '乙' }] },
  'split-figure': { title: '为什么是现在', items: [{ title: '甲' }, { title: '乙' }] },
  'full-figure': { title: '把复杂留给自己' },
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

// ---------------------------------------------------------------------------
// R-39 · 出场顺序
//
// 「一页里先看到什么、后看到什么」由 b.animate 的调用顺序 + trigger 决定，
// 和效果本身无关。layouts.ts 顶部那三条硬规矩在这里逐版式钉死：
// 覆盖（不漏挂）· 标题领跑 · 装饰不单独抢跑。
//
// 两份内容都要过：给满的和只给必填的。条件元素缺席时领跑的会换人，
// 修 bug 那次正是「只给必填」的 stat 暴露出装饰单独占一步。
// ---------------------------------------------------------------------------

describe('layouts · 出场顺序', () => {
  /** 标题块：eyebrow / 章节号总是紧贴标题，互相之间谁先谁后都算合理 */
  const TITLE_BLOCK = new Set(['title', 'header', 'partNumber'])

  const textTypeOf = (el: PPTElement) => (el.type === 'text' ? el.textType ?? '' : null)

  /** 元素 id → 它第一次被看到的「格」序号；没挂动画的不在表里 */
  const cellIndex = (elements: PPTElement[], animations: PPTAnimation[]) => {
    const cells = flattenTriggerSteps(groupTriggersIntoSteps(animations.map(a => a.trigger)))
    const at = new Map<string, number>()
    cells.forEach((cell, i) => {
      for (const idx of cell) if (!at.has(animations[idx].elId)) at.set(animations[idx].elId, i)
    })
    return { cells, at }
  }

  const cases = LAYOUT_PATTERNS.flatMap(p => [
    { pattern: p, variant: '内容给满', content: CONTENT[p] },
    { pattern: p, variant: '只给必填', content: MINIMAL[p] },
  ])

  // A · 覆盖。漏挂不是「这个元素不动」，是「它在第一次点击之前就已经在画布上」——
  // views/Screen/ScreenElement.vue 的 needWaitAnimation 查不到动画就一律 visible
  it.each(cases)('$pattern（$variant）给每一个元素都挂了动画', ({ content, pattern }) => {
    const { elements, animations, signatureIds } = buildLayout(pattern, content, PALETTE, 't')
    const { at } = cellIndex(elements, animations)
    // signature（配色风格的记号）**刻意**不挂动画：它该在第一次点击之前
    // 就已经在画布上，而不是跟内容一起飞进来。豁免按 id，不按名字 ——
    // 见 layouts.ts 的 Builder.signatureIds
    const exempt = new Set(signatureIds)
    const naked = elements.filter(el => !at.has(el.id) && !exempt.has(el.id))
    expect(naked.map(el => el.name ?? el.id), pattern).toEqual([])
  })

  // signature 的豁免不能变成一张万能通行证：它必须真的画在版心之外，
  // 否则「不挂动画」就会变成「一块压着正文、还提前显形的色块」
  it.each(cases)('$pattern（$variant）signature 全部落在版心之外', ({ content, pattern }) => {
    const { elements, signatureIds } = buildLayout(pattern, content, PALETTE, 't')
    const byId = new Map(elements.map(el => [el.id, el]))
    for (const id of signatureIds) {
      const el = byId.get(id)!
      // line 元素有 left/top/width（线宽）但没有 height —— 收窄成「有框的元素」TS 才认
      if (!('left' in el) || !('top' in el) || !('height' in el)) continue
      const outside = el.left + el.width <= SAFE.left
        || el.left >= SAFE.right
        || el.top + el.height <= SAFE.top
        || el.top >= SAFE.bottom
      expect(outside, `${pattern}: ${el.name ?? id} 伸进了版心`).toBe(true)
    }
  })

  // B · 标题领跑
  it.each(cases)('$pattern（$variant）标题不排在正文之后', ({ content, pattern }) => {
    const { elements, animations } = buildLayout(pattern, content, PALETTE, 't')
    const { at } = cellIndex(elements, animations)

    const title = elements.find(el => textTypeOf(el) === 'title')
    if (!title) return // quote 这类没有标题元素的版式

    const titleCell = at.get(title.id)!
    const bodies = elements.filter(el => {
      const t = textTypeOf(el)
      return t !== null && !TITLE_BLOCK.has(t) && el.id !== title.id
    })
    for (const el of bodies) {
      expect(at.get(el.id), `${pattern}: ${el.name ?? el.id} 比标题先出场`).toBeGreaterThanOrEqual(titleCell)
    }
  })

  // C · 装饰不抢跑
  it.each(cases)('$pattern（$variant）标题之前没有纯装饰的一格', ({ content, pattern }) => {
    const { elements, animations } = buildLayout(pattern, content, PALETTE, 't')
    const { cells, at } = cellIndex(elements, animations)
    const byId = new Map(elements.map(el => [el.id, el]))

    const title = elements.find(el => textTypeOf(el) === 'title')
    if (!title) return

    for (let i = 0; i < at.get(title.id)!; i++) {
      const inCell = cells[i].map(idx => byId.get(animations[idx].elId)!)
      expect(
        inCell.some(el => el.type === 'text'),
        `${pattern}: 第 ${i + 1} 格只有 ${inCell.map(el => el.name ?? el.id).join('、')} 在动，标题还没出来`,
      ).toBe(true)
    }
  })

  // 时间线永远从一个点击步开始 —— 否则进页就自动播掉半页，演讲者没法控制节奏
  it.each(cases)('$pattern（$variant）第一条动画是 click', ({ content, pattern }) => {
    const { animations } = buildLayout(pattern, content, PALETTE, 't')
    expect(animations[0].trigger, pattern).toBe('click')
    expect(groupTriggersIntoSteps(animations.map(a => a.trigger))[0].waitsForClick).toBe(true)
  })

  // 挂 null 会被静默跳过，领跑的那条也可能被跳过 —— 兜底逻辑必须真的兜住
  it('缺了领跑元素时，第一条实际落地的动画仍然是 click', () => {
    // stat 不给 eyebrow / label / note，只剩数字、光晕、强调条
    const { animations } = buildLayout('stat', { stat: { value: '1' } }, PALETTE, 't')
    expect(animations[0].trigger).toBe('click')
    expect(animations.filter(a => a.trigger === 'click')).toHaveLength(1)
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

  it('条目多且正文长时，字号/行距会真的降级', () => {
    /**
     * 「先量后排」解决了内容少时版面空洞，但内容多的时候必须有退路 ——
     * 六条带长正文的要点按三条的字号排，量出来比版心还高，多出来的会掉到画布外。
     *
     * 这条盯的是**退路真的走了**。原来只有一条 `survives maximum item counts`，
     * 但它用的是「第 N 条 / 说明」这种短内容，任何一档都放得下，
     * 于是降级阶梯是死的也测不出来 —— 负对照跑批时才发现这个洞。
     */
    // 三重压力叠加：六条 + 副标题 + 配图（配图会把文字栏压到 60% 宽）。
    // 少任何一样都还放得下 15px —— 这个组合是实测出来的，不是编的
    const long = buildLayout('bullets', {
      title: '本季度复盘得出的六条核心结论',
      subtitle: '结论按影响面从大到小排列，每条都附了对应的量化指标与责任团队',
      image: { src: `asset://${'c'.repeat(64)}`, width: 1280, height: 853 },
      items: Array.from({ length: 6 }, (_, i) => ({
        title: `第 ${i + 1} 条结论`,
        body: '从 800ms 降到 200ms，P99 由 2.4s 收敛到 610ms，覆盖全部核心链路',
      })),
    }, PALETTE, 'long')

    const short = buildLayout('bullets', {
      title: '三条结论',
      items: [{ title: '甲', body: '短' }, { title: '乙', body: '短' }],
    }, PALETTE, 'short')

    const bodySize = (r: ReturnType<typeof buildLayout>) => {
      const el = r.elements.find(e => e.type === 'text' && e.textType === 'item')!
      return Number(/font-size:(\d+)px/.exec((el as { content: string }).content)![1])
    }

    expect(bodySize(long), '六条长正文应该降级到更小的字号').toBeLessThan(bodySize(short))
    // 降级之后必须真的放得下 —— 兜底夹高度是最后一道，不该被用到
    expect(long.clampedIds).toEqual([])
  })

  it.each(LAYOUT_PATTERNS)('%s 的产物不依赖兜底截断（clampedIds 为空）', (pattern) => {
    /**
     * `Builder.text` 会把超出画布的框夹回来。夹完之后 `lintSlide` 的「超出画布」
     * 结构上就不可能响 —— 第二十轮之前 66 张样张跑出 0 告警，
     * 其中好几张肉眼可见文字压在一起，就是被这道兜底盖住的。
     *
     * 所以兜底必须留痕，而这条断言它**从来不该被用到**。
     */
    expect(buildLayout(pattern, CONTENT[pattern], PALETTE, 'c').clampedIds).toEqual([])
    expect(buildLayout(pattern, MINIMAL[pattern], PALETTE, 'm').clampedIds).toEqual([])
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

// ---------------------------------------------------------------------------
// R-60 · signature 变体
//
// 每档质感风格两个变体，按主题锚点色的哈希稳定选一个 ——
// 同一份稿子所有页同一个记号，不同配色的稿子自然分散。
// ---------------------------------------------------------------------------

describe('layouts · signature 变体（R-60）', () => {
  /** 从一批候选配色里找出哈希为指定变体的调色板 */
  const paletteWithVariant = (target: number): Palette => {
    for (let i = 0; i < 300; i++) {
      const hex = (0x100000 + i * 0x0a1b2d).toString(16).slice(1)
      const p = buildPalette({ ...THEME, backgroundColor: `#${hex}` })
      if (signatureVariant(p) === target) return p
    }
    throw new Error(`找不到哈希为 ${target} 的调色板 —— 要么 hash 坏了，要么撞了`)
  }

  it('同一个调色板哈希稳定，不同调色板会分散到两个变体', () => {
    expect(signatureVariant(PALETTE)).toBe(signatureVariant(PALETTE))
    expect(signatureVariant(paletteWithVariant(0))).toBe(0)
    expect(signatureVariant(paletteWithVariant(1))).toBe(1)
  })

  it.each(Object.keys(PALETTE_STYLES) as PaletteStyle[])(
    '%s 的两个变体都画得出来、都在版心之外、且互不相同', (style: PaletteStyle) => {
      const a = buildLayout('cards', CONTENT.cards, paletteWithVariant(0), 'a', { style })
      const b = buildLayout('cards', CONTENT.cards, paletteWithVariant(1), 'b', { style })
      const names = (r: ReturnType<typeof buildLayout>) =>
        r.elements.filter(e => r.signatureIds.includes(e.id)).map(e => e.name ?? e.id).sort()
      // 两个变体都真的画了记号
      expect(names(a).length, `${style} v0`).toBeGreaterThan(0)
      expect(names(b).length, `${style} v1`).toBeGreaterThan(0)
      // 两个变体长得不一样 —— 否则「变体」只是换了个名字
      expect(names(a), style).not.toEqual(names(b))
      // 全部落在版心之外（SAFE 之外的页边距里）
      for (const r of [a, b]) {
        for (const id of r.signatureIds) {
          const el = r.elements.find(e => e.id === id)!
          // line 元素有 left/top/width（线宽）但没有 height —— 收窄成「有框的元素」TS 才认
      if (!('left' in el) || !('top' in el) || !('height' in el)) continue
          const outside = el.left + el.width <= SAFE.left
            || el.left >= SAFE.right
            || el.top + el.height <= SAFE.top
            || el.top >= SAFE.bottom
          expect(outside, `${style}: ${('name' in el && el.name) || id} 伸进了版心`).toBe(true)
        }
      }
    },
  )
})

// ---------------------------------------------------------------------------
// R-60 · 版式结构变体 B
//
// cards / bullets / title-center 各有一个 B 变体（分栏无卡 / 大编号 / 左对齐封面）。
// 它们是同版式的另一种成熟结构，必须过和 A 同一套判据。
// ---------------------------------------------------------------------------

describe('layouts · 结构变体 B（R-60）', () => {
  const WITH_B: LayoutPattern[] = ['cards', 'bullets', 'title-center']

  const longContent: Record<string, LayoutContent> = {
    cards: {
      title: '四大支柱，一项都不能少',
      items: [
        { title: '极致的响应速度', body: '端到端时延从 800ms 压缩到 200ms，P99 波动控制在 15% 以内' },
        { title: '硬核的成本控制', body: '单位成本在规模翻倍的同时下降 40%，毛利结构显著改善' },
        { title: '彻底的零运维', body: '不再需要专职值班团队，告警自动闭环处理' },
        { title: '持续的模型迭代', body: '每周两次全量评测，线上效果只升不降' },
      ],
    },
    bullets: {
      title: '六条结论，从数据到组织',
      items: [
        { title: '响应更快', body: '端到端时延从 800ms 降到 200ms，P99 不再抖动' },
        { title: '成本更低', body: '单位成本下降 40%，规模翻倍成本不涨' },
        { title: '零运维', body: '不再需要专职值班，告警自动闭环' },
        { title: '模型更强', body: '每周两次评测，线上效果只升不降' },
        { title: '组织更扁', body: '三个团队合成一个平台组' },
        { title: '生态更宽', body: '开放平台接口，第三方可以接入' },
      ],
    },
    'title-center': { title: '一个超长的标题需要自动降级到更小的字号仍然排得下', subtitle: '副标题也不能太短，不然看不出自动折行的边界' },
  }

  it('三个版式有 B 变体，且与 A 的结构不同', () => {
    for (const p of WITH_B) {
      const a = buildLayout(p, CONTENT[p], PALETTE, 'va', { variant: 'A' })
      const b = buildLayout(p, CONTENT[p], PALETTE, 'vb', { variant: 'B' })
      const kinds = (r: ReturnType<typeof buildLayout>) =>
        r.elements.map(e => `${e.type}:${e.name ?? ''}`).sort().join('|')
      expect(kinds(b), p).not.toEqual(kinds(a))
    }
  })

  it('B 变体内容给满 / 只给必填都不依赖兜底截断', () => {
    for (const p of WITH_B) {
      expect(buildLayout(p, longContent[p], PALETTE, 'l', { variant: 'B' }).clampedIds, p).toEqual([])
      expect(buildLayout(p, MINIMAL[p], PALETTE, 'm', { variant: 'B' }).clampedIds, p).toEqual([])
    }
  })

  it('B 变体给每一个元素都挂了动画（signature 除外）', () => {
    const cellIndex2 = (elements: PPTElement[], animations: PPTAnimation[]) => {
      const cells = flattenTriggerSteps(groupTriggersIntoSteps(animations.map(a => a.trigger)))
      const at = new Map<string, number>()
      cells.forEach((cell, i) => {
        for (const idx of cell) if (!at.has(animations[idx].elId)) at.set(animations[idx].elId, i)
      })
      return at
    }
    for (const p of WITH_B) {
      const r = buildLayout(p, longContent[p], PALETTE, 'an', { variant: 'B' })
      const at = cellIndex2(r.elements, r.animations)
      const exempt = new Set(r.signatureIds)
      const naked = r.elements.filter(el => !at.has(el.id) && !exempt.has(el.id))
      expect(naked.map(el => el.name ?? el.id), p).toEqual([])
    }
  })

  it('B 变体时间线同样从 click 开始、标题领跑', () => {
    for (const p of WITH_B) {
      const r = buildLayout(p, CONTENT[p], PALETTE, 'cl', { variant: 'B' })
      expect(r.animations[0].trigger, p).toBe('click')
      const titleId = r.elements.find(e => e.type === 'text' && e.textType === 'title')?.id
      expect(titleId, p).toBeTruthy()
      const titleIdx = r.animations.findIndex(a => a.elId === titleId)
      // 标题必须是第一个 click 步或与之同时 —— 绝不能排在正文后面
      const stepOf = flattenTriggerSteps(groupTriggersIntoSteps(r.animations.map(a => a.trigger)))
      const titleStep = stepOf.findIndex(cell => cell.includes(titleIdx))
      expect(titleStep, p).toBeLessThanOrEqual(0)
    }
  })

  it('B 变体 id 稳定、前缀不同不撞', () => {
    for (const p of WITH_B) {
      const a = buildLayout(p, CONTENT[p], PALETTE, 'same', { variant: 'B' })
      const b = buildLayout(p, CONTENT[p], PALETTE, 'same', { variant: 'B' })
      expect(a.elements.map(e => e.id), p).toEqual(b.elements.map(e => e.id))
      const c = buildLayout(p, CONTENT[p], PALETTE, 'other', { variant: 'B' })
      const overlap = a.elements.map(e => e.id).filter(id => c.elements.some(e => e.id === id))
      expect(overlap, p).toHaveLength(0)
    }
  })

  it('没有 B 变体的版式传了 B 也落回 A —— 变体不是随便一个字母', () => {
    const r = buildLayout('timeline', CONTENT.timeline, PALETTE, 'tv', { variant: 'B' })
    const a = buildLayout('timeline', CONTENT.timeline, PALETTE, 'ta', { variant: 'A' })
    expect(r.elements.map(e => `${e.type}:${e.name ?? ''}`)).toEqual(
      a.elements.map(e => `${e.type}:${e.name ?? ''}`),
    )
  })
})
