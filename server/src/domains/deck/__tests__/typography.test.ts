/**
 * 字体配对与逐字体字宽表的判据
 *
 * ## 为什么单独一个文件
 *
 * `design.test.ts` 已有的文本度量断言全是**相对性质**
 * （长文比短文高、窄框比宽框高、中文比拉丁宽）。那些断言是好的 ——
 * 它们对调参不敏感，不会因为改了一个系数就红一片。
 *
 * 但代价是：**把整张 `CHAR_WIDTH` 换成 8 张 per-font 表，1518 条测试一条都没破。**
 * 也就是说这块改动当时没有任何机器判据。这个文件补的就是那一块。
 *
 * 四条各自钉住一件事：
 *   ① 源码里的表 == `npm run char-width` 量出来的那份（防手改、防漏更新）
 *   ② font 参数真的穿到底了（防「加了参数但没人用」）
 *   ③ 量的字族和渲染的字族必然一致（钉住 `Builder` 那个构造保证）
 *   ④ 配对清单进得了 prompt
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { SlideTheme, Slide } from '@/types/slides'
import {
  CHAR_WIDTH_BY_FONT, FONT_FAMILIES, isFontFamily,
  TYPOGRAPHY_PAIRS, isTypographyPair, describeTypographyPairs,
  fontForSize, DISPLAY_MIN, DEFAULT_BODY_FONT,
  PALETTE_FORMALITY, PALETTE_STYLES,
  estimateTextHeight, buildPalette,
  type TypographyPair,
} from '../design'
import { buildLayout } from '../layouts'
import { lintDeck } from '../kernel'

const REPO = path.resolve(__dirname, '../../../../..')

const theme = (): SlideTheme => ({
  themeColors: ['#5b9bd5', '#ed7d31'],
  fontColor: '#333333',
  fontName: '',
  backgroundColor: '#ffffff',
  shadow: { h: 3, v: 3, blur: 2, color: '#808080' },
  outline: { width: 2, color: '#525252', style: 'solid' },
})

// ---------------------------------------------------------------------------
// ① 表和实测对得上
// ---------------------------------------------------------------------------

describe('字宽表 · 和实测数据一致', () => {
  /**
   * `samples/char-width.json` 是 `npm run char-width` 在真浏览器里量出来的原始输出，
   * **入库**（`.gitignore` 只挡了 `samples/layout-*.png` 和 layout-text-overflow.json）。
   *
   * 这条断言的意义是把「源码里的数」和「量出来的数」锁在一起：
   * 谁手改了表、或者重量之后忘了同步，这里当场红。
   *
   * 拿不到文件时**跳过而不是静默通过** —— 一条永远绿的断言比没有断言更糟。
   */
  it('源码里的表逐项等于 samples/char-width.json', () => {
    const raw = readFileSync(path.join(REPO, 'samples/char-width.json'), 'utf8')
    const measured = JSON.parse(raw) as {
      font: string
      widths: Record<string, number>
    }[]

    const byFont = new Map(measured.map(m => [m.font, m.widths]))
    for (const font of FONT_FAMILIES) {
      const got = byFont.get(font)
      expect(got, `samples/char-width.json 里没有 ${font} —— 重量一次？`).toBeDefined()
      for (const [cls, v] of Object.entries(CHAR_WIDTH_BY_FONT[font])) {
        // 源码写 3 位小数，量出来的是全精度
        expect(got![cls], `${font}.${cls}`).toBeCloseTo(v, 3)
      }
    }
  })

  it('每个配对用到的字体都有表', () => {
    for (const [key, r] of Object.entries(TYPOGRAPHY_PAIRS)) {
      expect(isFontFamily(r.display), `${key}.display=${r.display} 没有字宽表`).toBe(true)
      expect(isFontFamily(r.body), `${key}.body=${r.body} 没有字宽表`).toBe(true)
    }
    expect(isFontFamily(DEFAULT_BODY_FONT)).toBe(true)
  })

  it('得意黑确实比别家窄 —— 这是 per-font 表存在的理由', () => {
    // 量出来 cjk 0.800 vs 别家 1.000。如果哪天它变成 1.0，
    // 说明要么重量错了，要么换字体了，两种都该有人看一眼
    expect(CHAR_WIDTH_BY_FONT.DeYiHei.cjk).toBeLessThan(0.9)
    for (const f of FONT_FAMILIES.filter(x => x !== 'DeYiHei' && x !== 'AlibabaPuHuiTi')) {
      expect(CHAR_WIDTH_BY_FONT[f].cjk, f).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// ② font 参数真的穿到底
// ---------------------------------------------------------------------------

describe('字宽表 · font 参数穿到底了', () => {
  /**
   * **这条是负对照的正面版本。**
   *
   * 如果 `estimateTextHeight` 收了 `font` 却没往下传（或者传丢在
   * `wrapLines` / `charWidth` 任何一层），同一段文字在窄字体和宽字体下
   * 会算出**一模一样**的高度 —— 而那正是「加了参数但没生效」的表现，
   * 它不会报错，只会安静地按同一张表估所有字体。
   */
  it('同一段文字，窄字体估出来比宽字体矮', () => {
    const text = 'Webhook 800ms SOC2 Type II 的 P99 延迟'.repeat(6)
    const narrow = estimateTextHeight(text, 16, 300, 1.6, { font: 'DeYiHei' })
    const wide = estimateTextHeight(text, 16, 300, 1.6, { font: 'LXGWNeoZhiSong' })
    expect(narrow).toBeLessThan(wide)
  })

  /**
   * 孤儿标点（“”‘’—…·）的码位不在 `CJK_PUNCT_RANGE` 里，
   * 补 `CJK_PUNCT_EXTRA` 之前它们全部按 `asciiPunct` 估 ——
   * 思源黑体下低估 2.35×。这条钉住那个修复。
   *
   * 判法是「同样字数，带弯引号的那段必须比带 ASCII 引号的宽」。
   * 直接断言宽度数值会把 `WIDTH_SAFETY` 之类的系数也钉死，那太脆。
   */
  it('中文弯引号按全角估，不按 ASCII 标点估', () => {
    const curly = '“' + '字'.repeat(30) + '”，' + '“' + '字'.repeat(30) + '”'
    const ascii = '"' + '字'.repeat(30) + '",' + '"' + '字'.repeat(30) + '"'
    expect(curly.length).toBe(ascii.length)
    const withCurly = estimateTextHeight(curly, 15, 260, 1.6, { font: 'SourceHanSans' })
    const withAscii = estimateTextHeight(ascii, 15, 260, 1.6, { font: 'SourceHanSans' })
    expect(withCurly).toBeGreaterThan(withAscii)
  })

  it('省略 font 时按最宽估 —— 漏传落在安全那一侧', () => {
    const text = '字'.repeat(50) + 'Webhook800ms'
    const omitted = estimateTextHeight(text, 16, 300)
    for (const f of FONT_FAMILIES) {
      expect(
        estimateTextHeight(text, 16, 300, 1.6, { font: f }),
        `${f} 估出来比「不传 font」还高，说明兜底不是取最宽`,
      ).toBeLessThanOrEqual(omitted)
    }
  })
})

// ---------------------------------------------------------------------------
// ③ 量的字族 == 渲染的字族
// ---------------------------------------------------------------------------

describe('字体配对 · 量和渲染用同一个字族', () => {
  /**
   * `Builder.measure()` 和 `Builder.text()` 都用 `fontForSize(size, recipe)` 推字族。
   * 这条断言钉住那个构造保证：**跑完整个版式引擎，每个文本元素落在页面上的
   * `defaultFontName`，必须等于按它自己的字号推出来的那个**。
   *
   * 它红了只有两种可能：`text()` 改用别的规则了，或者有人绕过 `Builder` 直接造元素。
   * 两种都该当场知道。
   */
  const pairs = Object.keys(TYPOGRAPHY_PAIRS) as TypographyPair[]

  it.each(pairs)('%s：每个文本元素的字族都对得上它的字号', (pair) => {
    const recipe = TYPOGRAPHY_PAIRS[pair]
    const r = buildLayout(
      'cards',
      {
        title: '三个能力',
        items: [
          { title: '响应快', body: 'P99 200ms，Webhook 回调 800ms 内送达' },
          { title: '成本低', body: '单位成本下降 40%' },
          { title: '零运维', body: 'SOC2 Type II，托管在 AWS' },
        ],
      },
      buildPalette(theme()),
      'el',
      { typography: recipe },
    )

    const texts = r.elements.filter(e => e.type === 'text')
    expect(texts.length).toBeGreaterThan(0)

    for (const el of texts) {
      if (el.type !== 'text') continue
      // 字号写在 content 的内联样式里，取第一个 font-size
      const m = /font-size:(\d+(?:\.\d+)?)px/.exec(el.content)
      expect(m, `元素 ${el.id} 的 content 里没有 font-size`).not.toBeNull()
      const size = Number(m![1])
      expect(el.defaultFontName, `${pair} 的元素 ${el.id}（${size}px）`)
        .toBe(fontForSize(size, recipe))
    }
  })

  it('阈值两侧分别落到 display 和 body', () => {
    const r = TYPOGRAPHY_PAIRS.classic
    expect(fontForSize(DISPLAY_MIN, r)).toBe(r.display)
    expect(fontForSize(DISPLAY_MIN - 1, r)).toBe(r.body)
  })

  it('不传 typography 时用 classic —— 和 DEFAULT_BODY_FONT 对齐', () => {
    const r = buildLayout('stat', { stat: { value: '87%', label: '留存' } },
      buildPalette(theme()), 'el')
    const texts = r.elements.filter(e => e.type === 'text')
    for (const el of texts) {
      if (el.type !== 'text') continue
      expect([TYPOGRAPHY_PAIRS.classic.display, TYPOGRAPHY_PAIRS.classic.body])
        .toContain(el.defaultFontName)
    }
  })
})

// ---------------------------------------------------------------------------
// ④ 进得了 prompt
// ---------------------------------------------------------------------------

describe('字体配对 · 清单与 formality', () => {
  it('describeTypographyPairs 每个配对恰好出现一次', () => {
    const text = describeTypographyPairs()
    for (const p of Object.keys(TYPOGRAPHY_PAIRS)) {
      expect(text.split(`- ${p}（`).length - 1, p).toBe(1)
    }
  })

  it('isTypographyPair 认得出合法值', () => {
    expect(isTypographyPair('classic')).toBe(true)
    expect(isTypographyPair('CLASSIC')).toBe(false)
    expect(isTypographyPair('songti')).toBe(false)
    expect(isTypographyPair(7)).toBe(false)
  })

  it('每个配色风格都有 formality 分', () => {
    for (const k of Object.keys(PALETTE_STYLES)) {
      expect(PALETTE_FORMALITY[k as keyof typeof PALETTE_FORMALITY], k)
        .toBeGreaterThanOrEqual(0)
    }
  })

  it('formality 覆盖足够宽 —— 否则差值 lint 永远不响', () => {
    const all = [
      ...Object.values(TYPOGRAPHY_PAIRS).map(r => r.formality),
      ...Object.values(PALETTE_FORMALITY),
    ]
    expect(Math.max(...all) - Math.min(...all)).toBeGreaterThan(4)
  })
})

// ---------------------------------------------------------------------------
// ⑤ lint 看得见「每页换一套」和「正式度对不上」
// ---------------------------------------------------------------------------

describe('lintDeckDesign · 配色与字体的一致性', () => {
  /** 造一页套过版式的页，只关心 layout / paletteStyle / typography 三个字段 */
  const page = (i: number, paletteStyle: string, typography: string): Slide => ({
    id: `s${i}`,
    elements: [
      {
        id: `e${i}`, type: 'text', left: 72, top: 100, width: 400, height: 40, rotate: 0,
        content: '<p><span style="font-size:38px">标题</span></p>',
        defaultFontName: 'SourceHanSerif', defaultColor: '#111111',
      },
      {
        id: `r${i}`, type: 'shape', left: 72, top: 200, width: 64, height: 8, rotate: 0,
        viewBox: [200, 200], path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z',
        fixedRatio: false, fill: '#2f6feb',
      },
      {
        id: `t${i}`, type: 'text', left: 72, top: 260, width: 400, height: 60, rotate: 0,
        content: '<p><span style="font-size:15px">正文</span></p>',
        defaultFontName: 'AlibabaPuHuiTi', defaultColor: '#333333',
      },
    ],
    // 相邻页版式不同，免得撞上「版式雷同」那条把断言搅浑
    layout: i % 2 === 0 ? 'cards' : 'bullets',
    paletteStyle,
    typography,
  })

  const messages = (slides: Slide[]) => lintDeck(slides).map(i => i.message)

  it('整份统一时不报', () => {
    const msgs = messages([page(0, 'business', 'classic'), page(1, 'business', 'classic')])
    expect(msgs.some(m => m.includes('种配色风格'))).toBe(false)
    expect(msgs.some(m => m.includes('种字体配对'))).toBe(false)
  })

  it('每页换配色风格 → 报，且指出是哪几页', () => {
    const msgs = messages([
      page(0, 'business', 'classic'),
      page(1, 'vivid', 'classic'),
      page(2, 'tech', 'classic'),
    ])
    const hit = msgs.find(m => m.includes('种配色风格'))
    expect(hit).toBeDefined()
    expect(hit).toContain('3 种')
    expect(hit).toContain('第 2 页')
  })

  it('每页换字体配对 → 报', () => {
    const msgs = messages([
      page(0, 'business', 'classic'),
      page(1, 'business', 'impact'),
    ])
    expect(msgs.find(m => m.includes('种字体配对'))).toContain('2 种')
  })

  it('手工搭的页（没有 layout）不参与判定', () => {
    const manual = { ...page(1, 'business', 'classic'), layout: undefined, paletteStyle: undefined, typography: undefined }
    const msgs = messages([page(0, 'business', 'classic'), manual])
    expect(msgs.some(m => m.includes('种配色风格'))).toBe(false)
  })

  it('正式度差太远 → 报（学术配色 9 + 温暖手写 3，差 6）', () => {
    const msgs = messages([page(0, 'academic', 'warm'), page(1, 'academic', 'warm')])
    expect(msgs.find(m => m.includes('正式度差'))).toContain('6 档')
  })

  it('正式度差在限内 → 不报（商务 8 + 几何科技 5，差 3）', () => {
    const msgs = messages([page(0, 'business', 'impact'), page(1, 'business', 'impact')])
    expect(msgs.some(m => m.includes('正式度差'))).toBe(false)
  })
})
