import { describe, it, expect } from 'vitest'
import type { PPTElement, PPTImageElement, SlideTheme } from '@/types/slides'
import {
  LAYOUT_PATTERNS, LAYOUT_META, buildLayout, validateLayoutContent, describeLayouts, coverClip,
  type LayoutPattern, type LayoutContent,
} from '../layouts'
import { buildPalette, CANVAS_WIDTH, CANVAS_HEIGHT } from '../design'

/**
 * 版式的图片位。
 *
 * 这一组守的是第十八轮那个 bug：agent 搜了 5 张图、生成了 2 张，
 * **一张都没用上** —— 因为 `applyLayout` 是整页替换语义，而 10 个版式
 * 一个图片位都没有，它在整个工作流里找不到能把图放进去的地方。
 * 「能力存在但没有任何路径够得着」等于不存在，而且不会有人报错。
 */

const THEME: SlideTheme = {
  themeColors: ['#2f6feb', '#f2596b', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
  fontColor: '#1a1a1a',
  fontName: '',
  backgroundColor: '#ffffff',
  shadow: { h: 3, v: 3, blur: 2, color: '#808080' },
  outline: { width: 2, color: '#525252', style: 'solid' },
}
const PALETTE = buildPalette(THEME)

const HASH = 'b'.repeat(64)
const IMAGE = { src: `asset://${HASH}`, width: 1280, height: 853 }

/** 各版式一份最小可用内容 */
const CONTENT: Record<LayoutPattern, LayoutContent> = {
  'title-center': { title: '标题' },
  'title-split': { title: '标题' },
  'section': { title: '章节', eyebrow: '02' },
  'bullets': { title: '标题', items: [{ title: 'A', body: 'a' }, { title: 'B', body: 'b' }] },
  'cards': { title: '标题', items: [{ title: 'A', body: 'a' }, { title: 'B', body: 'b' }] },
  'compare': { title: '标题', items: [{ title: 'A', body: 'a' }, { title: 'B', body: 'b' }] },
  'timeline': { title: '标题', items: [{ label: '1', title: 'A' }, { label: '2', title: 'B' }, { label: '3', title: 'C' }] },
  'stat': { stat: { value: '87%', label: '渗透率' } },
  'quote': { quote: '一句引述' },
  'end': { title: '谢谢' },
}

const build = (pattern: LayoutPattern, extra: Partial<LayoutContent> = {}) =>
  buildLayout(pattern, { ...CONTENT[pattern], ...extra }, PALETTE, `t_${pattern}`)

const images = (els: PPTElement[]) => els.filter((e): e is PPTImageElement => e.type === 'image')

const IMAGE_PATTERNS = LAYOUT_PATTERNS.filter(p => LAYOUT_META[p].image)
const NO_IMAGE_PATTERNS = LAYOUT_PATTERNS.filter(p => !LAYOUT_META[p].image)

// ---------------------------------------------------------------------------

describe('coverClip · 裁剪算术', () => {
  it('拿不到原图尺寸就返回 null，不猜比例', () => {
    // 猜错的表现是图被拉变形，而变形没有任何检查能发现
    expect(coverClip(400, 200)).toBeNull()
    expect(coverClip(400, 200, 1280, undefined)).toBeNull()
    expect(coverClip(400, 200, undefined, 853)).toBeNull()
  })

  it('比例本来就一致 → 不裁', () => {
    expect(coverClip(400, 200, 1600, 800)).toBeNull()
  })

  it('原图更宽 → 左右各切一条，上下不动', () => {
    // 期望手算：box 2:1，源 4:1 → 保留宽度的 2/4 = 50%，左右各切 25%
    const clip = coverClip(400, 200, 800, 200)
    expect(clip).toEqual({ shape: 'rect', range: [[25, 0], [75, 100]] })
  })

  it('原图更高 → 上下各切一条，左右不动', () => {
    // box 2:1，源 1:1 → 保留高度的 1/2 = 50%，上下各切 25%
    const clip = coverClip(400, 200, 500, 500)
    expect(clip).toEqual({ shape: 'rect', range: [[0, 25], [100, 75]] })
  })

  it('裁剪框永远居中且落在 0~100 之内', () => {
    for (const [bw, bh, sw, sh] of [[400, 300, 1280, 853], [1000, 562, 853, 1280], [200, 700, 1376, 768]]) {
      const clip = coverClip(bw, bh, sw, sh)!
      const [[x0, y0], [x1, y1]] = clip.range
      expect(x0 + x1).toBeCloseTo(100, 1) // 居中
      expect(y0 + y1).toBeCloseTo(100, 1)
      for (const v of [x0, y0, x1, y1]) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(100)
      }
    }
  })
})

describe('不给图时，一切照旧', () => {
  it.each(LAYOUT_PATTERNS)('%s 不产生任何图片元素', (pattern) => {
    expect(images(build(pattern).elements)).toHaveLength(0)
  })
})

describe('backdrop 版式 · 满屏背景图 + 遮罩', () => {
  const backdropPatterns = LAYOUT_PATTERNS.filter(p => LAYOUT_META[p].image === 'backdrop')

  it('至少有一个 backdrop 版式 —— 防空跑', () => {
    expect(backdropPatterns.length).toBeGreaterThanOrEqual(3)
  })

  it.each(backdropPatterns)('%s：图铺满整个画布', (pattern) => {
    const img = images(build(pattern, { image: IMAGE }).elements)
    expect(img).toHaveLength(1)
    expect(img[0]).toMatchObject({ left: 0, top: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT })
    expect(img[0].src).toBe(IMAGE.src)
    expect(img[0].imageType).toBe('background')
  })

  it.each(backdropPatterns)('%s：图是第一个元素，遮罩紧随其后', (pattern) => {
    // PPTist 的层级就是数组顺序。图排在文字后面会把整页盖住
    const els = build(pattern, { image: IMAGE }).elements
    expect(els[0].type).toBe('image')
    expect(els[1].type).toBe('shape')
    expect(els[1].name).toBe('背景遮罩')
  })

  it.each(backdropPatterns)('%s：遮罩必须存在且半透明', (pattern) => {
    /**
     * 遮罩不是可选项：照片背后压文字，对比度几乎必然不合格 ——
     * 而 lintDeck 只检查纯色背景与文字的对比度，**它看不见照片**，
     * 于是「一页字全糊在图上」会安安静静地通过所有检查。
     */
    const els = build(pattern, { image: IMAGE }).elements
    const scrim = els.find(e => e.name === '背景遮罩')!
    expect(scrim).toBeDefined()
    expect(scrim.type).toBe('shape')
    const opacity = (scrim as { opacity?: number }).opacity!
    expect(opacity).toBeGreaterThan(0.6) // 压得住照片
    expect(opacity).toBeLessThan(1) // 又不是完全盖死
    expect(scrim).toMatchObject({ left: 0, top: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT })
  })

  it.each(backdropPatterns)('%s：给了图不影响原有元素数量（只是多了图和遮罩）', (pattern) => {
    const plain = build(pattern).elements.length
    const withImage = build(pattern, { image: IMAGE }).elements.length
    expect(withImage).toBe(plain + 2)
  })
})

describe('panel 版式 · 侧栏配图', () => {
  it('title-split：图顶掉主色块，而不是叠在上面', () => {
    // 叠的话主色块永远看不见，白白多一个元素，用户想换回纯色还得先删图
    const withImage = build('title-split', { image: IMAGE }).elements
    const img = images(withImage)
    expect(img).toHaveLength(1)
    expect(img[0].imageType).toBe('pageFigure')
    expect(withImage.find(e => e.name === '主色块')).toBeUndefined()

    const without = build('title-split').elements
    expect(without.find(e => e.name === '主色块')).toBeDefined()
    // 图**顶掉**主色块（不是叠加），同时装饰环也不画了 → 正好少一个元素。
    // 断言相对数量而不是绝对值：版式里加一个新装饰时这条不该跟着红
    expect(withImage).toHaveLength(without.length - 1)
  })

  it('title-split：有图时不再画装饰环', () => {
    // 装饰环是给纯色块加质感的，叠在照片上像块污渍（实测截图上一眼看出来）
    expect(build('title-split').elements.find(e => e.name === '装饰环')).toBeDefined()
    expect(build('title-split', { image: IMAGE }).elements.find(e => e.name === '装饰环')).toBeUndefined()
  })

  it('title-split：图占右半边，且上下出血', () => {
    const img = images(build('title-split', { image: IMAGE }).elements)[0]
    expect(img.top).toBe(0)
    expect(img.height).toBe(CANVAS_HEIGHT)
    expect(img.left).toBeGreaterThan(CANVAS_WIDTH / 2)
    expect(img.left + img.width).toBe(CANVAS_WIDTH)
  })

  it('bullets：给了图，文字列会缩窄给图让位', () => {
    const wide = build('bullets').elements.find(e => e.type === 'text')!
    const narrow = build('bullets', { image: IMAGE }).elements.find(e => e.type === 'text')!
    expect(narrow.width).toBeLessThan(wide.width)
  })

  it('bullets：所有文字都不跟图重叠', () => {
    // 缩了标题却忘了缩条目正文，表现就是「字压在图上」——
    // 而那种页面在缩略图上看着还挺正常
    const els = build('bullets', { image: IMAGE }).elements
    const img = images(els)[0]
    for (const el of els) {
      if (el.type === 'image' || !('left' in el)) continue
      expect(el.left + el.width, `${el.type} ${el.id} 压到图上了`).toBeLessThanOrEqual(img.left + 1)
    }
  })
})

describe('不吃图的版式', () => {
  it('cards / compare / timeline 都不吃图', () => {
    // 它们的版面已经被 2~5 个并列块占满，再塞图只会把条目挤出安全区
    expect(NO_IMAGE_PATTERNS.sort()).toEqual(['cards', 'compare', 'timeline'])
  })

  it.each(NO_IMAGE_PATTERNS)('%s：硬塞图也不会产生图片元素', (pattern) => {
    expect(images(build(pattern, { image: IMAGE }).elements)).toHaveLength(0)
  })

  it.each(NO_IMAGE_PATTERNS)('%s：校验会拦下来，并告诉它哪些版式可用', (pattern) => {
    // 静默忽略是最糟的处置：模型花 15 秒生成一张图，交上来石沉大海，
    // 而它永远学不到该换个版式
    const err = validateLayoutContent(pattern, { ...CONTENT[pattern], image: IMAGE })
    expect(err).toContain('不放图')
    expect(err).toContain('title-split')
  })
})

describe('合规 · 图库 URL 不许进 deck', () => {
  it.each([
    ['图库直链', 'https://pixabay.com/get/x.jpg'],
    ['本地路径', '/assets/abc.png'],
    ['大写 hex', `asset://${'B'.repeat(64)}`],
    ['带扩展名', `asset://${HASH}.jpg`],
    ['pending 形式', 'asset://pending/t-1'],
  ])('%s 会被拒', (_label, src) => {
    const err = validateLayoutContent('title-split', { title: 'x', image: { src } })
    expect(err).toContain('asset://')
  })

  it('合法的 asset:// 放行', () => {
    expect(validateLayoutContent('title-split', { title: 'x', image: IMAGE })).toBeNull()
  })

  it('产出的 src 就是传进来的那个 asset://，没有被改写', () => {
    for (const pattern of IMAGE_PATTERNS) {
      const img = images(build(pattern, { image: IMAGE }).elements)[0]
      expect(img.src).toBe(`asset://${HASH}`)
      expect(img.src).not.toContain('http')
    }
  })
})

describe('版式清单会把图片位告诉模型', () => {
  /**
   * 这一条就是那个 bug 的正面判据：清单里没提图，模型就不知道图能往哪放。
   * 从 LAYOUT_META 自动带出来 —— 加一个吃图的版式，prompt 里自动就有。
   */
  const text = describeLayouts()

  it.each(IMAGE_PATTERNS)('%s 在清单里标了「可配图」', (pattern) => {
    const line = text.split('\n').find(l => l.startsWith(`- ${pattern}（`))!
    expect(line).toContain('可配图')
  })

  it.each(NO_IMAGE_PATTERNS)('%s 不标', (pattern) => {
    const line = text.split('\n').find(l => l.startsWith(`- ${pattern}（`))!
    expect(line).not.toContain('可配图')
  })

  it('每个版式都显式声明了 image 字段 —— 加版式忘了表态时这里红', () => {
    for (const p of LAYOUT_PATTERNS) {
      expect(Object.prototype.hasOwnProperty.call(LAYOUT_META[p], 'image'), p).toBe(true)
    }
  })
})

describe('裁剪接到版式上', () => {
  it('横图放进竖长条 → 上下留全、左右裁掉', () => {
    const img = images(build('bullets', { image: { src: `asset://${HASH}`, width: 1600, height: 400 } }).elements)[0]
    expect(img.clip).toBeDefined()
    expect(img.clip!.range[0][1]).toBe(0) // y0
    expect(img.clip!.range[1][1]).toBe(100) // y1
    expect(img.clip!.range[0][0]).toBeGreaterThan(0) // x 被裁了
  })

  it('没有原图尺寸 → 不裁、改用等比', () => {
    const img = images(build('title-split', { image: { src: `asset://${HASH}` } }).elements)[0]
    expect(img.clip).toBeUndefined()
    expect(img.fixedRatio).toBe(true)
  })

  it('裁过的图不锁比例 —— 锁了拖动时会跳', () => {
    const img = images(build('title-split', { image: IMAGE }).elements)[0]
    expect(img.clip).toBeDefined()
    expect(img.fixedRatio).toBe(false)
  })
})
