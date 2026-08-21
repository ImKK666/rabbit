/**
 * 版面底图的判据
 *
 * **两条都是实测抓出来的**（2026-08-21，真模型）：
 *
 * 1. **提示词里绝不能出现数字。** 第一版把留白区写成 `x 8%, y 12%, w 62%, h 18%`，
 *    版面画得很好，**但模型把那串坐标原样写在了页面右边** ——
 *    尽管提示词里明写着 `ABSOLUTELY NO text, letters, numbers`。
 *    改成方位短语之后，同样的提示词跑出来一个字都没有。
 * 2. **安静区阈值 0.30 是标定的。** 实测文字区亮度跨度 0.013 / 0.048 / 0.128，
 *    非文字区 0.814 / 0.861；一次「卡片没盖满文字区」的失败量到 0.405~0.416。
 *    阈值落在 0.128 与 0.405 之间。
 */

import { describe, it, expect } from 'vitest'
import {
  describeRegion, buildBackdropPrompt, lintBackdropCalm, describeCalmIssues,
  MAX_LUMINANCE_SPREAD,
} from '../backdrop'
import type { OccupiedRect } from '../ornament'

const rect = (over: Partial<OccupiedRect> = {}): OccupiedRect =>
  ({ kind: 'text', x: 0.08, y: 0.12, w: 0.62, h: 0.18, ...over })

/** 造一张底图：整张 base 亮度，指定矩形内填 patch 亮度 */
const canvas = (w: number, h: number, base: number, patch?: { r: OccupiedRect, v: number }) => {
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = patch
        && x >= patch.r.x * w && x < (patch.r.x + patch.r.w) * w
        && y >= patch.r.y * h && y < (patch.r.y + patch.r.h) * h
      const v = inside ? patch.v : base
      const o = (y * w + x) * 4
      rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255
    }
  }
  return { rgba, w, h }
}

describe('describeRegion · 输出里绝不能有数字', () => {
  it('翻成方位短语，一个数字都不带', () => {
    for (const r of [
      rect(), rect({ x: 0.7, y: 0.7, w: 0.25, h: 0.25 }), rect({ x: 0, y: 0, w: 1, h: 1 }),
    ]) {
      expect(describeRegion(r)).not.toMatch(/\d/)
    }
  })

  it('方位分得开', () => {
    expect(describeRegion(rect({ x: 0.02, y: 0.02, w: 0.2, h: 0.2 }))).toContain('upper-left')
    expect(describeRegion(rect({ x: 0.78, y: 0.78, w: 0.2, h: 0.2 }))).toContain('lower-right')
    expect(describeRegion(rect({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }))).toContain('middle-centre')
  })
})

describe('buildBackdropPrompt · 从源头消除「模型把坐标画出来」', () => {
  const colors = ['#F7F5F0', '#1F3A5F', '#2F6FEB', '#E8A33D']

  /**
   * **这条钉的是一次真实失败。** 光靠 `NO text, letters, numbers` 挡不住 ——
   * 给了数字它就会画。所以判的是「提示词里根本没有数字可画」。
   */
  it('整段提示词里不出现坐标数字或百分号', () => {
    const p = buildBackdropPrompt({ rects: [rect(), rect({ y: 0.38, h: 0.44 })], colors })
    expect(p).not.toMatch(/\d+\s*%/)
    expect(p).not.toMatch(/\bx\s*\d/)
    expect(p).not.toMatch(/\by\s*\d/)
  })

  it('禁文字那句放在最前面 —— 放末尾时模型已经把画面想完了', () => {
    const p = buildBackdropPrompt({ rects: [rect()], colors })
    // **先断言它存在再比位置。** 第一版只比 indexOf，而 indexOf 找不到时返回 -1，
    // 「-1 < 任何正数」恒真 —— 把那句话整个删掉测试照样绿。负对照当场抓住了
    expect(p).toContain('FIRST AND MOST IMPORTANT')
    expect(p).toContain('NO text of any kind')
    const banIdx = p.indexOf('NO text of any kind')
    const drawIdx = p.indexOf('WHAT TO DRAW')
    expect(banIdx).toBeGreaterThan(-1)
    expect(drawIdx).toBeGreaterThan(-1)
    expect(banIdx).toBeLessThan(drawIdx)
  })

  it('安静区要求「完整覆盖」—— 只盖一半正是实测那次失败', () => {
    const p = buildBackdropPrompt({ rects: [rect()], colors })
    expect(p).toContain('ENTIRELY')
    expect(p).toContain('covers only part of the zone is wrong')
  })

  it('锚点色由代码注入', () => {
    const p = buildBackdropPrompt({ rects: [rect()], colors })
    for (const c of colors) expect(p).toContain(c)
  })

  it('一个矩形都没有时也拼得出来', () => {
    expect(() => buildBackdropPrompt({ rects: [], colors })).not.toThrow()
  })

  // ── R-60：艺术流派注入。原来 Style 行写死 flat vector，每份稿子的底图同脸
  it('传了 artDirection 就替换写死的 Style 行', () => {
    const art = 'mid-century editorial illustration'
    const p = buildBackdropPrompt({ rects: [rect()], colors, artDirection: art })
    expect(p).toContain('ART DIRECTION')
    expect(p).toContain(art)
    expect(p).not.toContain('flat vector / editorial print design')
  })

  it('不传 artDirection 保持旧措辞 —— 安静区阈值是照它标定的', () => {
    const p = buildBackdropPrompt({ rects: [rect()], colors })
    expect(p).toContain('flat vector / editorial print design')
    expect(p).not.toContain('ART DIRECTION')
  })

  it('artDirection 只换风格行，结构约束（安静区/禁文字）原样保留', () => {
    const p = buildBackdropPrompt({ rects: [rect()], colors, artDirection: 'brutalist grid minimalism' })
    expect(p).toContain('FIRST AND MOST IMPORTANT')
    expect(p).toContain('CALM ZONES')
    expect(p).toContain('ENTIRELY')
  })
})

describe('安静区判据', () => {
  it('整块均匀 → 不报', () => {
    const c = canvas(200, 120, 230)
    expect(lintBackdropCalm(c.rgba, c.w, c.h, [rect()])).toHaveLength(0)
  })

  it('区内一半亮一半暗 → 报，且给得出跨度', () => {
    const r = rect()
    // 在文字区下半部盖一块深色 —— 就是实测那次「卡片没盖满」
    const dark = { r: { ...r, y: r.y + r.h / 2, h: r.h / 2 }, v: 40 }
    const c = canvas(200, 120, 240, dark)
    const issues = lintBackdropCalm(c.rgba, c.w, c.h, [r])
    expect(issues).toHaveLength(1)
    expect(issues[0].spread).toBeGreaterThan(MAX_LUMINANCE_SPREAD)
    expect(describeCalmIssues(issues)).toContain('太花')
  })

  it('区外再花也不管 —— 那正是要的', () => {
    const r = rect()
    const elsewhere = { r: { kind: 'text' as const, x: 0.75, y: 0.1, w: 0.2, h: 0.8 }, v: 0 }
    const c = canvas(200, 120, 240, elsewhere)
    expect(lintBackdropCalm(c.rgba, c.w, c.h, [r])).toHaveLength(0)
  })

  it('最花的排前面', () => {
    const a = rect({ x: 0.05, y: 0.05, w: 0.3, h: 0.3 })
    const b = rect({ x: 0.05, y: 0.5, w: 0.3, h: 0.3 })
    // 只盖 b 的下半 —— 整块填满反而是「均匀」，跨度 0，不该报。
    // 第一版就是这么写错的，测试当场抓住了
    const c = canvas(200, 120, 240, { r: { ...b, y: 0.65, h: 0.15 }, v: 0 })
    const issues = lintBackdropCalm(c.rgba, c.w, c.h, [a, b])
    expect(issues).toHaveLength(1)
    expect(issues[0].rect.y).toBe(0.5)
  })

  it('整块均匀的深色也不报 —— 判的是「花不花」，不是「深不深」', () => {
    const r = rect()
    const c = canvas(200, 120, 240, { r, v: 20 })
    // 区内全是 20，跨度 0。深底配浅字是成立的设计，该由对比度那条判，不是这条
    expect(lintBackdropCalm(c.rgba, c.w, c.h, [r])).toHaveLength(0)
  })

  it('矩形落在画布外时跳过，不崩也不误报', () => {
    const c = canvas(60, 40, 200)
    expect(lintBackdropCalm(c.rgba, c.w, c.h, [rect({ x: 1.4, y: 1.4, w: 0.2, h: 0.2 })])).toHaveLength(0)
  })

  it('全干净时那句话不含告警口吻', () => {
    expect(describeCalmIssues([])).toContain('读得出来')
  })
})
