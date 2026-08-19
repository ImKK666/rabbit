/**
 * 图库检索里纯函数部分的判据
 *
 * 网络那半段测不了（真实 IO），但**尺寸换算**必须测 —— 它是这一轮抓到的真 bug：
 * 交出去的是 Pixabay 的 `largeImageURL`（最长边缩到 1280），
 * 报的却是 `imageWidth/imageHeight`（**原图**，能到 5760）。
 * 版式拿这个宽高算 cover / contain 裁剪，就会以为手里有张 5760px 的图，
 * 实际只有 1280px —— 满屏背景直接糊掉，而且不会报任何错。
 *
 * 期望值是**实测量出来的**：抓真实 API 响应、把 `largeImageURL` 下下来、
 * 从 JPEG 的 SOF 段读真实像素，三组数据全部对上。
 * 不是从公式反推的 —— 那样只能证明「代码等于代码」。
 */

import { describe, it, expect } from 'vitest'
import { scaleToMaxEdge, detectLang, NEEDS_API_KEY, PIXABAY_LARGE_MAX_EDGE } from '../imageSearch'

describe('largeImageURL 的真实尺寸换算', () => {
  /** 原图尺寸 → 实际下载到的 large 尺寸，2026-08-19 实测 */
  const MEASURED: Array<[number, number, number, number]> = [
    [3354, 2019, 1280, 771],
    [5760, 3840, 1280, 853],
    [5868, 4004, 1280, 873],
  ]

  it.each(MEASURED)('原图 %i×%i → large %i×%i', (w, h, ew, eh) => {
    expect(scaleToMaxEdge(w, h, PIXABAY_LARGE_MAX_EDGE)).toEqual({ width: ew, height: eh })
  })

  it('竖图按高缩 —— 长边是哪条就缩哪条', () => {
    expect(scaleToMaxEdge(2000, 4000, 1280)).toEqual({ width: 640, height: 1280 })
  })

  it('本来就小于上限的原样不动，不做放大', () => {
    // 放大只会让 agent 以为图更清晰，而字节数一点没多
    expect(scaleToMaxEdge(800, 600, 1280)).toEqual({ width: 800, height: 600 })
  })

  it('正好等于上限时不动', () => {
    expect(scaleToMaxEdge(1280, 720, 1280)).toEqual({ width: 1280, height: 720 })
  })

  it('缺尺寸时不崩也不产生 NaN', () => {
    // API 偶尔缺字段，算出 NaN 会一路流进 deck 的几何里
    expect(scaleToMaxEdge(0, 0, 1280)).toEqual({ width: 0, height: 0 })
  })

  it('负对照：直接用原图尺寸会差 4 倍以上', () => {
    // 这就是修之前的行为
    const [w, h] = [5760, 3840]
    const wrong = { width: w, height: h }
    const right = scaleToMaxEdge(w, h, PIXABAY_LARGE_MAX_EDGE)
    expect(wrong.width / right.width).toBeGreaterThan(4)
    expect(right).not.toEqual(wrong)
  })
})

describe('检索语言', () => {
  it('中文查询切 zh', () => {
    expect(detectLang('城市 夜景')).toBe('zh')
    expect(detectLang('团队协作')).toBe('zh')
  })

  it('中英混排也切 zh —— 有中文就说明用户在用中文表达', () => {
    expect(detectLang('AI 芯片')).toBe('zh')
  })

  it('纯英文走 en', () => {
    expect(detectLang('business team meeting')).toBe('en')
    expect(detectLang('data center')).toBe('en')
  })
})

describe('哪些图库要 key', () => {
  it('只有 wikimedia 免 key', () => {
    expect(Object.entries(NEEDS_API_KEY).filter(([, v]) => !v).map(([k]) => k)).toEqual(['wikimedia'])
  })

  it('四家都登记了 —— 加了新图库忘了登记，设置页就不会显示 key 输入框', () => {
    expect(Object.keys(NEEDS_API_KEY).sort()).toEqual(['pexels', 'pixabay', 'unsplash', 'wikimedia'])
  })
})
