/**
 * 渲染后反思的判据
 *
 * 对应 docs/13-queue-reflect-ingest.md §三 的 R1。
 *
 * **这一组的负对照是现成的，而且是实测来的。**
 * `scripts/measure-layout-text.mjs` 头注释记着：66 张样张跑 `lintDeck` **0 告警**，
 * 其中好几张肉眼能看到文字压在一起。原因是
 *   - 「超出画布」永远不响：`Builder.text()` 把框高夹进了画布
 *   - 「文本重叠」比的是**声明的框**，而溢出发生在框外面
 *
 * 所以每一条「量了之后能看见」的断言，都配一条
 * 「同一份数据 `lintSlide` 看不见」的断言。**只测新做法看得见，
 * 证明不了它比原来强。**
 */

import { describe, it, expect } from 'vitest'
import type { Slide, PPTElement } from '@/types/slides'
import { lintSlide } from '../kernel'
import {
  reflectOnRender,
  describeReflection,
  OVERFLOW_TOLERANCE_PX,
  type TextMeasurement,
} from '../renderReflect'

const text = (over: Partial<Record<string, unknown>> = {}): PPTElement => ({
  id: 'el_t1',
  type: 'text',
  left: 100,
  top: 100,
  width: 400,
  height: 80,
  rotate: 0,
  content: '<p><span style="font-size:36px">标题</span></p>',
  defaultFontName: 'Microsoft YaHei',
  defaultColor: '#333333',
  textType: 'title',
  ...over,
} as PPTElement)

const slide = (over: Partial<Slide> = {}): Slide => ({
  id: 'slide_1',
  type: 'content',
  elements: [text()],
  ...over,
} as Slide)

const measure = (elementId: string, actualHeight: number, slideId = 'slide_1'): TextMeasurement =>
  ({ slideId, elementId, actualHeight })

describe('R1 · 文本溢出：量了才看得见', () => {
  it('声明 80、实际画了 140 → 报溢出 60px', () => {
    const s = slide({ elements: [text({ id: 'a', height: 80 })] })
    const r = reflectOnRender([s], [measure('a', 140)])
    expect(r.overflows).toHaveLength(1)
    expect(r.overflows[0]).toMatchObject({
      elementId: 'a', declared: 80, actual: 140, overflow: 60, slideIndex: 1,
    })
  })

  it('**负对照**：同一份数据 lintSlide 一个字都不说', () => {
    // 这就是那 66 张样张 0 告警的复现。溢出发生在框外面，
    // 而现有检查比的是声明的框 —— 它看不见，且不会有任何东西报错
    const s = slide({ elements: [text({ id: 'a', height: 80 })] })
    expect(lintSlide(s)).toEqual([])
  })

  it('文字画得下就不报', () => {
    const s = slide({ elements: [text({ id: 'a', height: 80 })] })
    expect(reflectOnRender([s], [measure('a', 60)]).overflows).toEqual([])
  })

  it('容差之内的抖动不报 —— 1~2px 是行高取整的正常现象', () => {
    const s = slide({ elements: [text({ id: 'a', height: 80 })] })
    expect(reflectOnRender([s], [measure('a', 80 + OVERFLOW_TOLERANCE_PX)]).overflows).toEqual([])
    expect(reflectOnRender([s], [measure('a', 80 + OVERFLOW_TOLERANCE_PX + 1)]).overflows)
      .toHaveLength(1)
  })

  it('容差就是 4px —— 和 measure-layout-text.mjs 用同一个数', () => {
    // 两处不一样的话会出现「工具说没事、脚本说有事」，而那时没人知道该信哪个
    expect(OVERFLOW_TOLERANCE_PX).toBe(4)
  })

  it('预览截前 40 字，HTML 标签剥掉 —— 好让 agent 认出是哪块文字', () => {
    const s = slide({
      elements: [text({ id: 'a', content: `<p><span>${'很长的正文'.repeat(20)}</span></p>` })],
    })
    const [o] = reflectOnRender([s], [measure('a', 500)]).overflows
    expect(o.preview).not.toContain('<')
    expect(o.preview.length).toBeLessThanOrEqual(41) // 40 + 省略号
  })

  it('只量文本元素 —— 形状 / 图片的高度是它自己的，不存在"画出去"', () => {
    const s = slide({
      elements: [{ ...text({ id: 'shape' }), type: 'shape' } as PPTElement],
    })
    const r = reflectOnRender([s], [measure('shape', 999)])
    expect(r.measured).toBe(0)
    expect(r.overflows).toEqual([])
  })
})

describe('R1 · 只报「渲染之后才冒出来」的几何问题', () => {
  it('真实高度撑出的重叠会被报出来', () => {
    // 两块文字声明高度不重叠（80 + 100 < 250），但第一块实际画了 200，
    // 于是真正压在了第二块上 —— 这正是估算偏小的典型后果
    const s = slide({
      elements: [
        text({ id: 'a', top: 100, height: 80, width: 400 }),
        text({ id: 'b', top: 250, height: 100, width: 400 }),
      ],
    })
    // 重叠比例要过 kernel 的 0.6 阈值才报：a 画到 400（100..400）完整盖住 b（250..350）
    const r = reflectOnRender([s], [measure('a', 300), measure('b', 100)])
    expect(r.newIssues.some(i => i.message.includes('重叠'))).toBe(true)
  })

  it('**负对照**：同一份数据 lintSlide 报不出重叠', () => {
    const s = slide({
      elements: [
        text({ id: 'a', top: 100, height: 80, width: 400 }),
        text({ id: 'b', top: 250, height: 100, width: 400 }),
      ],
    })
    expect(lintSlide(s).some(i => i.message.includes('重叠'))).toBe(false)
  })

  it('lintDeck 本来就报的那些**不重复报** —— 否则新信息会被淹掉', () => {
    // 这一页声明时就已经越界了，lintSlide 会报。量完之后仍然越界，
    // 但那不是「渲染之后才发现的」，所以不该再报一次
    const s = slide({ elements: [text({ id: 'a', left: 900, width: 400, height: 80 })] })
    expect(lintSlide(s).length).toBeGreaterThan(0)

    const r = reflectOnRender([s], [measure('a', 82)])
    expect(r.newIssues).toEqual([])
  })

  it('真实高度把元素顶出画布底边 → 报新问题', () => {
    const s = slide({ elements: [text({ id: 'a', top: 400, height: 100 })] })
    expect(lintSlide(s)).toEqual([])
    const r = reflectOnRender([s], [measure('a', 300)]) // 400 + 300 = 700 > 562.5
    expect(r.newIssues.some(i => i.message.includes('超出画布'))).toBe(true)
  })
})

describe('没量到的部分要诚实', () => {
  it('没量到的页原样跳过，不拿声明高度冒充实测', () => {
    // 前端可能只渲染了一部分（视口懒加载）。对没量到的页什么都不说，
    // 比给一份看起来正常、其实是估算值的报告诚实
    const s1 = slide({ id: 'slide_1', elements: [text({ id: 'a' })] })
    const s2 = slide({ id: 'slide_2', elements: [text({ id: 'b' })] })
    const r = reflectOnRender([s1, s2], [measure('a', 200, 'slide_1')])
    expect(r.measured).toBe(1)
    expect(r.overflows.every(o => o.slideId === 'slide_1')).toBe(true)
  })

  it('一条都没量到时 measured 为 0，且说得出来', () => {
    const r = reflectOnRender([slide()], [])
    expect(r.measured).toBe(0)
    expect(describeReflection(r)).toContain('没有量到')
  })

  it('量到了不存在的元素 id，安静忽略', () => {
    const r = reflectOnRender([slide()], [measure('不存在的', 999)])
    expect(r.overflows).toEqual([])
  })

  it('slideIndex 是页码不是数组下标', () => {
    const s1 = slide({ id: 's1', elements: [text({ id: 'a' })] })
    const s2 = slide({ id: 's2', elements: [text({ id: 'b', height: 80 })] })
    const r = reflectOnRender([s1, s2], [measure('b', 300, 's2')])
    expect(r.overflows[0].slideIndex).toBe(2)
  })
})

describe('给 agent 的那段话', () => {
  it('没问题时明确说没问题', () => {
    const r = reflectOnRender([slide()], [measure('el_t1', 60)])
    expect(describeReflection(r)).toContain('没有文本溢出')
  })

  it('**必须写清楚不要直接调框高** —— 否则 agent 的第一反应就是调框高', () => {
    // 调高框只会去压下面那个元素，问题从「文字出框」变成「两块文字叠在一起」
    const s = slide({ elements: [text({ id: 'a', height: 80 })] })
    const out = describeReflection(reflectOnRender([s], [measure('a', 200)]))
    expect(out).toContain('不要直接把框调高')
    expect(out).toMatch(/减字数|字号/)
  })

  it('每条都带页码和元素 id，agent 才定位得到', () => {
    const s = slide({ elements: [text({ id: 'el_xyz', height: 80 })] })
    const out = describeReflection(reflectOnRender([s], [measure('el_xyz', 200)]))
    expect(out).toContain('第 1 页')
    expect(out).toContain('el_xyz')
    expect(out).toContain('120px')
  })
})
