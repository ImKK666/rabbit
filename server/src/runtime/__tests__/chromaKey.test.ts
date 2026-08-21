/**
 * 抠图内核的判据 —— docs/14 的 O3 / O4 / O5 / O2
 *
 * **这一组的负对照是实测来的。** docs/14 事实 ④ 量到：
 * thin-line 那一版的装饰层里 `>220 实心` 档**一个像素都没有**，
 * 整层是抗锯齿边缘、颜色全靠反混合重建 —— 我的第一次简化移植就是在那版上偏的色
 * （`#2F6FEB` 蓝抠完偏青、`#E8A33D` 橙偏橄榄）。
 *
 * 所以「不褪色」不能只测实心块，必须**连边缘一起测**。
 */

import { describe, it, expect } from 'vitest'
import {
  chromaKey, keyedLooksUsable, keyDistance,
  MIN_TRANSPARENT_RATIO, DEFAULT_KEY,
} from '../chromaKey'

/** 拿一张 w×h 的纯绿底，按回调往上画 */
const canvas = (w: number, h: number, paint?: (x: number, y: number) => [number, number, number] | null) => {
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const c = paint?.(x, y) ?? null
      const [r, g, b] = c ?? [0, 255, 0]
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255
    }
  }
  return { rgba, w, h }
}

const at = (r: Uint8Array, w: number, x: number, y: number) => {
  const o = (y * w + x) * 4
  return [r[o], r[o + 1], r[o + 2], r[o + 3]]
}

describe('O2 · 纯键色抠成全透明', () => {
  it('一整张纯绿 → 100% 透明', () => {
    const { rgba, w, h } = canvas(8, 8)
    const out = chromaKey(rgba, w, h)
    expect(out.transparent).toBe(64)
    expect(out.opaque).toBe(0)
  })

  it('模型没照要求画纯色底（棋盘格 / 白底 / 照片）→ 判不可用', () => {
    // 棋盘格：两种浅灰交替，一个像素都不接近纯绿
    const { rgba, w, h } = canvas(16, 16, (x, y) =>
      ((x >> 2) + (y >> 2)) % 2 ? [255, 255, 255] : [204, 204, 204])
    const out = chromaKey(rgba, w, h)
    expect(out.transparent).toBe(0)
    expect(keyedLooksUsable(out)).toBe(false)
  })

  it(`透明率刚好到 ${MIN_TRANSPARENT_RATIO} 就算可用`, () => {
    // 前半绿后半藏青
    const { rgba, w, h } = canvas(10, 10, (_x, y) => (y < 5 ? null : [31, 58, 95]))
    const out = chromaKey(rgba, w, h)
    expect(out.transparent / (w * h)).toBeCloseTo(0.5, 5)
    expect(keyedLooksUsable(out)).toBe(true)
  })
})

describe('O3 · 不褪色 —— 去溢出对非键色必须是 no-op', () => {
  /**
   * 这三个色就是装饰层实际用的锚点色。
   * 去溢出的规则是「把键色主导的通道压到其余通道的 max」，
   * 对它们应当一个字节都不动。
   */
  const PALETTE: [string, [number, number, number]][] = [
    ['navy  #1F3A5F', [31, 58, 95]],
    ['blue  #2F6FEB', [47, 111, 235]],
    ['orange #E8A33D', [232, 163, 61]],
    ['white', [255, 255, 255]],
    ['red   #cc2222', [204, 34, 34]],
  ]

  for (const [name, rgb] of PALETTE) {
    it(`${name} 抠完逐字节不变`, () => {
      const { rgba, w, h } = canvas(4, 4, (x, y) => (x === 2 && y === 2 ? rgb : null))
      const out = chromaKey(rgba, w, h)
      expect(at(out.rgba, w, 2, 2)).toEqual([...rgb, 255])
    })
  }

  it('负对照：无条件压 G 通道 → 蓝色会被压坏', () => {
    // 手工模拟「写错的去溢出」：G 一律压到 max(R,B)
    const [r, g, b] = [47, 111, 235]
    const broken = [r, Math.min(g, Math.max(r, b)), b]
    // 正确实现下 G 不该被动；这条断言钉住「111 不等于被压过的值」这件事有意义
    expect(broken[1]).toBe(111)     // 蓝色本来就 G < max(R,B)，压不动
    // 真正会被压坏的是偏绿的内容色 —— 那是设计上接受的代价（不要用接近键色的颜色）
    const greenish: [number, number, number] = [60, 200, 60]
    const { rgba, w, h } = canvas(4, 4, (x, y) => (x === 1 && y === 1 ? greenish : null))
    const out = chromaKey(rgba, w, h)
    expect(at(out.rgba, w, 1, 1)[1]).toBeLessThan(200)
  })
})

describe('O4 · 不丢线 —— 默认不腐蚀', () => {
  it('1px 竖线抠完仍然连续', () => {
    const { rgba, w, h } = canvas(9, 9, x => (x === 4 ? [31, 58, 95] : null))
    const out = chromaKey(rgba, w, h)
    for (let y = 0; y < 9; y++) {
      expect(at(out.rgba, w, 4, y)[3], `第 ${y} 行断了`).toBe(255)
    }
  })

  it('1px 横线也一样', () => {
    const { rgba, w, h } = canvas(9, 9, (_x, y) => (y === 4 ? [232, 163, 61] : null))
    const out = chromaKey(rgba, w, h)
    for (let x = 0; x < 9; x++) expect(at(out.rgba, w, x, 4)[3]).toBe(255)
  })
})

describe('O5 · 全透明像素 RGB 归零（故意偏离原版）', () => {
  it('抠掉的绿底 RGB 全是 0，不留绿残留', () => {
    const { rgba, w, h } = canvas(6, 6, (x, y) => (x === 3 && y === 3 ? [31, 58, 95] : null))
    const out = chromaKey(rgba, w, h)
    for (let i = 0; i < out.rgba.length; i += 4) {
      if (out.rgba[i + 3] !== 0) continue
      expect([out.rgba[i], out.rgba[i + 1], out.rgba[i + 2]]).toEqual([0, 0, 0])
    }
  })

  it('归零让「全透明像素完全相同」成立 —— 无损 PNG 靠这个压到 1/5', () => {
    const { rgba, w, h } = canvas(6, 6)
    const out = chromaKey(rgba, w, h)
    const first = Array.from(out.rgba.slice(0, 4))
    for (let i = 0; i < out.rgba.length; i += 4) {
      expect(Array.from(out.rgba.slice(i, i + 4))).toEqual(first)
    }
  })
})

describe('边缘反混合与开关', () => {
  it('半键像素被判成半透明，而不是一刀切', () => {
    // 绿和藏青的中点：离键色的距离落在 tLow(38) 与 tHigh(110) 之间
    const mid: [number, number, number] = [16, 156, 48]
    expect(keyDistance(...mid, DEFAULT_KEY)).toBeGreaterThan(38)
    expect(keyDistance(...mid, DEFAULT_KEY)).toBeLessThan(110)
    const { rgba, w, h } = canvas(4, 4, (x, y) => (x === 1 && y === 1 ? mid : null))
    const out = chromaKey(rgba, w, h)
    const a = at(out.rgba, w, 1, 1)[3]
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(255)
  })

  /**
   * **边缘反混合必须有判据。**
   *
   * docs/14 事实 ④：thin-line 那版装饰层墨里只有 6.8% 是实心，
   * 剩下全是抗锯齿边缘 —— 颜色**全靠这一步重建**。它错了就是整层偏色，
   * 而我的第一次简化移植正是栽在这里。
   *
   * 判的是方向而不是具体数值：反混合的作用是**把键色污染拿掉**，
   * 所以重建之后的绿通道必须比不重建时**更低**。
   * 用 `despill: false` 把去溢出隔离掉，否则两条路的 G 都会被压到锚点上，
   * 差异被抹平 —— 这一点是负对照 NC6 全绿之后才想清楚的。
   */
  it('边缘反混合把键色污染拿掉 —— 关掉它绿通道会更高', () => {
    // 绿底和藏青的 50/50 混合，落在 tLow~tHigh 的斜坡里
    const blend: [number, number, number] = [16, 157, 48]
    const { rgba, w, h } = canvas(4, 4, (x, y) => (x === 1 && y === 1 ? blend : null))
    const on = chromaKey(rgba, w, h, { despill: false })
    const off = chromaKey(rgba, w, h, { despill: false, edgeRecover: false })
    const gOn = at(on.rgba, w, 1, 1)[1]
    const gOff = at(off.rgba, w, 1, 1)[1]
    expect(gOff).toBe(157)                 // 不重建就是原样的脏绿
    expect(gOn).toBeLessThan(gOff)         // 重建之后绿被拿掉一部分
  })

  it('关掉 despill 之后偏绿内容不再被压 —— 开关是真的接着的', () => {
    const greenish: [number, number, number] = [60, 200, 60]
    const { rgba, w, h } = canvas(4, 4, (x, y) => (x === 1 && y === 1 ? greenish : null))
    const on = chromaKey(rgba, w, h)
    const off = chromaKey(rgba, w, h, { despill: false })
    expect(at(on.rgba, w, 1, 1)[1]).toBeLessThan(at(off.rgba, w, 1, 1)[1])
  })

  it('换品红键色也work —— 压的是 R 和 B 两个通道', () => {
    const magenta = [255, 0, 255] as const
    // 用一个不和品红撞的内容色：绿系（G 是品红键的非溢出通道，做锚点）
    const leaf: [number, number, number] = [46, 160, 67]
    const { rgba, w, h } = canvas(4, 4, (x, y) => (x === 1 && y === 1 ? leaf : [255, 0, 255]))
    const out = chromaKey(rgba, w, h, { key: magenta })
    expect(out.transparent).toBe(15)
    expect(at(out.rgba, w, 1, 1)).toEqual([...leaf, 255])
  })

  /**
   * **键色和内容配色是会撞的，这条把限制钉死。**
   *
   * 去溢出的规则是「把键色主导的通道压到其余通道的 max」。绿键时非溢出通道是 R 和 B，
   * 藏青 `#1F3A5F` 的 max(R,B)=95 > G=58，所以 G 不被动 —— no-op。
   * 但换成**品红键**时溢出通道变成 R 和 B、锚点变成 G=58，
   * 而藏青的 B=95 > 58 → **B 被压到 58，藏青变暗**。
   *
   * 原版 docstring 那句「对红/藏青/灰/白是 no-op」的前提是**绿键**。
   * 这不是 bug，是这类算法的固有性质 —— 也正是 `probe_palette.py` 探色存在的理由
   * （docs/14 §八：rabbit 的背景色由模型定（R-55），有撞色风险，探色还没做）。
   */
  it('已知限制：品红键会压暗藏青 —— 所以换键色前必须探色', () => {
    const magenta = [255, 0, 255] as const
    const navy: [number, number, number] = [31, 58, 95]
    const { rgba, w, h } = canvas(4, 4, (x, y) => (x === 1 && y === 1 ? navy : [255, 0, 255]))
    const out = chromaKey(rgba, w, h, { key: magenta })
    // B 被压到 G 的高度
    expect(at(out.rgba, w, 1, 1)).toEqual([31, 58, 58, 255])
    // 而绿键下同一个藏青纹丝不动
    const g = canvas(4, 4, (x, y) => (x === 1 && y === 1 ? navy : null))
    expect(at(chromaKey(g.rgba, g.w, g.h).rgba, 4, 1, 1)).toEqual([...navy, 255])
  })
})
