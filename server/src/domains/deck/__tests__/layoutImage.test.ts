import { describe, it, expect } from 'vitest'
import type { PPTElement, PPTImageElement, SlideTheme } from '@/types/slides'
import {
  LAYOUT_PATTERNS, LAYOUT_META, buildLayout, validateLayoutContent, describeLayouts, coverClip,
  type LayoutPattern, type LayoutContent,
} from '../layouts'
import {
  buildPalette, CANVAS_WIDTH, CANVAS_HEIGHT, contrastRatio, mixHex, toHex,
} from '../design'

/** 把相对亮度反解成等效灰度 hex —— 测试里独立实现一遍，好当负对照 */
const grayHexFor = (l: number): string => {
  const c = Math.max(0, Math.min(1, l))
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
  const v = Math.round(s * 255)
  return toHex([v, v, v])
}

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
  'image-grid': { title: '标题', items: [{ title: 'A', body: 'a' }, { title: 'B', body: 'b' }] },
  'split-figure': { title: '标题', items: [{ title: 'A', body: 'a' }, { title: 'B', body: 'b' }] },
  'full-figure': { title: '标题' },
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

  it.each(backdropPatterns)('%s：遮罩必须存在且落在业界区间内', (pattern) => {
    /**
     * 遮罩不是可选项：照片背后压文字，对比度几乎必然不合格 ——
     * 而 lintDeck 只检查纯色背景与文字的对比度，**它看不见照片**，
     * 于是「一页字全糊在图上」会安安静静地通过所有检查。
     *
     * **第二十轮把上界从「< 1」收到 0.72。** 原来是 0.82/0.78 两个常量，
     * 实测那不是「照片偏淡」而是**照片没了** —— 白底亮图压完只剩一点人影，
     * 搜图/生图的钱白花。业界通行区间是 40~60%，0.72 是留了余量的上限。
     */
    const els = build(pattern, { image: IMAGE }).elements
    const scrim = els.find(e => e.name === '背景遮罩')!
    expect(scrim).toBeDefined()
    expect(scrim.type).toBe('shape')
    const opacity = (scrim as { opacity?: number }).opacity!
    expect(opacity).toBeGreaterThanOrEqual(0.28) // 低于这个等于没压
    expect(opacity).toBeLessThanOrEqual(0.72) // 高于这个就是把照片盖掉，那还不如别配图
    expect(scrim).toMatchObject({ left: 0, top: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT })
  })

  it.each(backdropPatterns)('%s：遮罩浓度跟着图片亮度走，不是一个常量', (pattern) => {
    /**
     * 第二十轮的核心判据：**同一个版式、两张亮度不同的图，遮罩必须不一样浓**。
     * 常量遮罩同时服务深色照片和白底照片，只能取最狠的那个 ——
     * 于是所有深色照片都被冤枉地压成灰。
     *
     * **方向**：PALETTE 是浅底深字，遮罩是把照片**提亮**到深字读得出来。
     * 所以越暗的照片越费遮罩 —— 和「白字压照片要压暗」正好相反。
     * 写这条时我一开始断言成「亮图压得更狠」，被它当场抓住：
     * 那是深色主题（浅字）才成立的方向。
     */
    const opacityOf = (lo: number, hi: number) => {
      const els = build(pattern, { image: { ...IMAGE, luminance: [lo, hi] } }).elements
      return (els.find(e => e.name === '背景遮罩') as { opacity?: number }).opacity!
    }
    // 浅底深字：暗照片才是难题
    expect(opacityOf(0.03, 0.08)).toBeGreaterThan(opacityOf(0.85, 0.95))
  })

  it.each(backdropPatterns)('%s：给了亮度区间就按最坏的一头算', (pattern) => {
    /**
     * 照片不均匀，均值达标不代表每个字都达标。最坏的一头是
     * **{p5, p95} 里离文字亮度更近的那个** —— 对比度在两者相等时最低。
     *
     * 这里给一张「均值很亮、但有暗部」的图：均值算出来几乎不用压，
     * 按暗部算就得压。取暗部才是对的。
     */
    const opacityOf = (luminance: [number, number]) => {
      const els = build(pattern, { image: { ...IMAGE, luminance } }).elements
      return (els.find(e => e.name === '背景遮罩') as { opacity?: number }).opacity!
    }
    // 同样是「很亮」的图，一张有暗部一张没有：有暗部的那张要压得更狠
    expect(opacityOf([0.05, 0.95])).toBeGreaterThan(opacityOf([0.88, 0.95]))
  })

  /**
   * 两种构图，两种遮罩 —— 这张表是**判据的一部分**，不是实现细节的复述。
   *
   * - 偏栏构图（文字收在左侧、右边让给照片）→ **渐变**遮罩，只压文字那一侧
   * - 居中构图（封面、结尾页，文字横跨整幅且上下居中）→ **均匀**遮罩：
   *   任何方向的渐变都会有一头压不住，而封面本来就是「整张图当舞台」
   *
   * 写死清单是故意的：新增一个 backdrop 版式时这里会先红，
   * 逼着人回答「这一页是哪种构图」，而不是默默继承一个可能不合适的默认值。
   */
  const GRADIENT_SCRIM: LayoutPattern[] = ['section', 'stat', 'quote']
  const UNIFORM_SCRIM: LayoutPattern[] = ['title-center', 'end']

  it('两张清单合起来正好覆盖所有 backdrop 版式', () => {
    expect([...GRADIENT_SCRIM, ...UNIFORM_SCRIM].sort()).toEqual([...backdropPatterns].sort())
  })

  it.each(GRADIENT_SCRIM)('%s：偏栏构图用渐变遮罩 —— 照片得留下一半', (pattern) => {
    /**
     * 导出 PPTX 时渐变会被 `useExport.ts` 压平成「首末两色的均值」，
     * 而这里首末同色、只差 alpha，`toHexString()` 又会丢掉 alpha ——
     * 于是压平的结果正好是「该颜色 @ 元素 opacity」的均匀遮罩，也就是业界那种平铺遮罩。
     * **改 useExport 的渐变处理时要回来看这条。**
     */
    const els = build(pattern, { image: IMAGE }).elements
    const scrim = els.find(e => e.name === '背景遮罩') as { gradient?: { colors: { color: string }[] } }
    expect(scrim.gradient).toBeDefined()
    const colors = scrim.gradient!.colors
    expect(colors.length).toBeGreaterThanOrEqual(2)
    // 首末必须同一个 RGB，只有 alpha 不同 —— 压平之后才等于那个颜色本身
    const rgbOf = (c: string) => c.slice(0, 7).toLowerCase()
    expect(rgbOf(colors[0].color)).toBe(rgbOf(colors[colors.length - 1].color))
    // 末端必须是全透明，否则「另一侧照片原样」这件事不成立
    expect(colors[colors.length - 1].color.slice(7).toLowerCase()).toBe('00')
    // 每个色值都必须是合法的 8 位 hex —— `#fff` + `ff` 拼出来的 5 位串
    // SVG 会当非法色直接丢掉，表现是遮罩整个消失而没有任何报错
    for (const c of colors) expect(c.color).toMatch(/^#[0-9a-f]{8}$/i)
  })

  it.each(GRADIENT_SCRIM)('%s：渐变必须一直罩过文字的最右边', (pattern) => {
    /**
     * **这一条是看截图看出来的，任何既有断言都不会报。**
     *
     * 第一版渐变在 55% 处就淡到 85%、100% 处归零，而引用页那行字横跨到 93% 宽 ——
     * 后半句正好落在已经淡掉的地方，「没有界面」四个字压在亮蓝色机柜上糊掉。
     * 现在遮罩保持满强度到文字右缘之后才淡出，这条断言守的就是那个关系。
     */
    const els = build(pattern, { image: IMAGE }).elements
    const scrim = els.find(e => e.name === '背景遮罩') as { gradient?: { colors: { pos: number, color: string }[] } }
    const colors = scrim.gradient!.colors
    // 满强度（alpha=ff）的最后一站
    const holdEnd = Math.max(...colors.filter(c => c.color.slice(7).toLowerCase() === 'ff').map(c => c.pos))

    const texts = els.filter(e => e.type === 'text')
    const textRight = Math.max(...texts.map(e => e.left + e.width))
    expect(holdEnd, `${pattern}: 遮罩满强度只到 ${holdEnd}%，而文字右缘在 ${(textRight / CANVAS_WIDTH * 100).toFixed(0)}%`)
      .toBeGreaterThanOrEqual(textRight / CANVAS_WIDTH * 100 - 1)
  })

  it.each(backdropPatterns)('%s：压在照片上的彩色文字必须够对比度', (pattern) => {
    /**
     * `scrimFor` 是照着 `palette.text` 算遮罩浓度的，但页面上还有别的颜色在当文字用：
     * stat 的大数字是 primary（蓝）、eyebrow 是 accent（黄）、章节号也是 accent。
     *
     * **实测截图上「关键指标」那行黄字压在照片上几乎看不见，而当时所有断言都是绿的** ——
     * 因为 lintDeck 只看纯色背景，它看不见照片。这条判据就是补那个洞：
     * 有背景图时，每个文字元素的颜色对「遮罩之后的实际底色」都要达到 3:1。
     */
    const els = build(pattern, { image: { ...IMAGE, luminance: [0.02, 0.12] } }).elements
    const scrim = els.find(e => e.name === '背景遮罩') as { opacity?: number, fill?: string }

    // 复算一遍遮罩之后的底色：遮罩色以 opacity 叠在照片最坏那一头上
    const effectiveBg = mixHex(grayHexFor(0.02), scrim.fill!, scrim.opacity!)

    for (const el of els) {
      if (el.type !== 'text') continue
      const color = (el as { defaultColor?: string }).defaultColor!
      expect(
        contrastRatio(color, effectiveBg),
        `${pattern}: "${el.name ?? el.id}" 的 ${color} 压在 ${effectiveBg} 上`,
      ).toBeGreaterThanOrEqual(3)
    }
  })

  it.each(UNIFORM_SCRIM)('%s：居中构图用均匀遮罩，不用渐变', (pattern) => {
    const els = build(pattern, { image: IMAGE }).elements
    const scrim = els.find(e => e.name === '背景遮罩') as { gradient?: unknown }
    expect(scrim.gradient).toBeUndefined()
  })

  it.each(backdropPatterns)('%s：给了图，压在照片上的装饰要让开', (pattern) => {
    /**
     * 改之前这条断言的是 `withImage === plain + 2`（只多了图和遮罩）。
     * 那条描述的是「加图不破坏版面」，但它同时锁死了**装饰照旧全画**——
     * 于是 stat 的光晕、end 的装饰环、title-center 的斜块继续叠在照片上，
     * 而 R-48 早就判过「半透明色块叠在照片上像块污渍」，只改了 title-split 一处。
     *
     * 现在断言的是新意图：**加图之后元素只会更少或持平**（装饰让开），
     * 且图和遮罩一定在。
     */
    const plain = build(pattern).elements.length
    const withImage = build(pattern, { image: IMAGE }).elements
    expect(withImage.length).toBeLessThanOrEqual(plain + 2)
    expect(images(withImage)).toHaveLength(1)
    expect(withImage.find(e => e.name === '背景遮罩')).toBeDefined()
  })

  it.each(backdropPatterns)('%s：有图时不留半透明装饰压在照片上', (pattern) => {
    const withImage = build(pattern, { image: IMAGE }).elements
    const decor = withImage.filter(e =>
      e.name === '装饰光晕' || e.name === '装饰环' || e.name === '装饰斜块')
    expect(decor.map(d => d.name)).toEqual([])
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
    // 图**顶掉**主色块（不是叠加），同时装饰环和分界线也不画了 → 少两个元素。
    // 断言相对数量而不是绝对值：版式里加一个新装饰时这条不该跟着红
    expect(withImage).toHaveLength(without.length - 2)
  })

  it('title-split：有图时不画那条强调色分界线', () => {
    /**
     * 那条 10px 的分界线是给**两块纯色相接**收口用的。贴在照片边上就是一条
     * 突兀的彩色描边 —— 照片自己的边缘就是边界。和装饰环同一条理由，
     * R-48 修了装饰环却把它留下了，实测样张上它看着像贴纸。
     */
    expect(build('title-split').elements.find(e => e.name === '分界线')).toBeDefined()
    expect(build('title-split', { image: IMAGE }).elements.find(e => e.name === '分界线')).toBeUndefined()
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
  it('不吃整页图的就这四个', () => {
    /**
     * cards / compare / timeline：版面已被 2~5 个并列块占满，
     * 再塞整页图只会把条目挤出安全区。
     *
     * image-grid 在这张名单上是**另一个理由**：它每条自己配图
     * （`items[].image`），整页再压一张背景图会和三张小图打架。
     * 所以「不吃 content.image」对它不是限制，是设计。
     */
    expect(NO_IMAGE_PATTERNS.sort()).toEqual(['cards', 'compare', 'image-grid', 'timeline'])
  })

  it('image-grid 是唯一吃条目图的版式', () => {
    const itemImagePatterns = LAYOUT_PATTERNS.filter(p => LAYOUT_META[p].itemImage)
    expect(itemImagePatterns).toEqual(['image-grid'])
  })

  it('image-grid：条目图会真的变成图片元素', () => {
    const els = build('image-grid', {
      items: [
        { title: 'A', body: 'a', image: IMAGE },
        { title: 'B', body: 'b', image: IMAGE },
      ],
    }).elements
    expect(images(els)).toHaveLength(2)
    expect(images(els)[0].imageType).toBe('itemFigure')
  })

  it('不吃条目图的版式，塞 items[].image 会被拦下并指路', () => {
    const msg = validateLayoutContent('cards', {
      title: 't',
      items: [{ title: 'A', image: IMAGE }, { title: 'B' }],
    })
    expect(msg).toContain('不吃图')
    expect(msg).toContain('image-grid')
  })

  it('条目图同样只收 asset://（合规：图库 URL 进不了 deck）', () => {
    const msg = validateLayoutContent('image-grid', {
      title: 't',
      items: [{ title: 'A', image: { src: 'https://pixabay.com/x.jpg' } }, { title: 'B' }],
    })
    expect(msg).toContain('asset://')
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
