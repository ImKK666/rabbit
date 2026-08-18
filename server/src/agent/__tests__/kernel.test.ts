/**
 * Deck Kernel 单测
 *
 * kernel 是纯函数库（不依赖 Vue / HTTP / DB / LLM），
 * 03-architecture 说「一个 agent 框架好不好用，八成取决于变更层能不能被独立测试」——
 * 这份测试就是那句话的兑现。
 */

import { describe, it, expect } from 'vitest'
import type { Slide, PPTElement } from '@/types/slides'
import {
  validateElement,
  lintSlide,
  lintDeck,
  applyAddElement,
  applyUpdateElement,
  applyDeleteElement,
  applyAddSlide,
  applyUpdateSlide,
  applyDeleteSlide,
  applyAddAnimations,
  applyRemoveAnimations,
  applyAnimationPreset,
  ANIMATION_EFFECTS,
  VIEWPORT_WIDTH,
  VIEWPORT_HEIGHT,
} from '../kernel'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

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

const ok = <T>(o: { ok: boolean, data?: T, error?: string }) => {
  if (!o.ok) throw new Error(`预期成功，实际失败: ${o.error}`)
  return o.data as T
}

// ---------------------------------------------------------------------------

describe('validateElement — 元素级闸门', () => {
  it('接受合法的 text 元素', () => {
    expect(validateElement(text())).toEqual({ ok: true })
  })

  it('拒绝缺 defaultFontName 的 text 元素', () => {
    const bad = { ...text() } as Record<string, unknown>
    delete bad.defaultFontName
    const r = validateElement(bad)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('defaultFontName')
  })

  it('拒绝零宽 / 负宽元素（width 必须为正）', () => {
    expect(validateElement(text({ width: 0 })).ok).toBe(false)
    expect(validateElement(text({ width: -10 })).ok).toBe(false)
  })

  it('拒绝没有 type 的对象', () => {
    expect(validateElement({ id: 'x' }).ok).toBe(false)
    expect(validateElement(null).ok).toBe(false)
  })

  it('拒绝不认识的元素类型', () => {
    const r = validateElement({ ...text(), type: 'hologram' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('hologram')
  })

  it('对 chart / table 等 agent 不产出的类型只校验基础几何，不整体拒收', () => {
    // 导入的 PPTX 里带表格，不能因为 kernel 没写它的 schema 就让整页进不来
    expect(validateElement({
      id: 'el_table', type: 'table', left: 0, top: 0, width: 300, height: 200, rotate: 0,
      data: [[{ text: 'a' }]], colWidths: [1], theme: {},
    })).toEqual({ ok: true })

    // 但基础几何仍然要合法
    expect(validateElement({
      id: 'el_table', type: 'table', left: 0, top: 0, width: -1, height: 200, rotate: 0,
    }).ok).toBe(false)
  })
})

describe('lintSlide — 几何检查', () => {
  it('完全出画布报 warning', () => {
    const issues = lintSlide(slide({ elements: [text({ left: VIEWPORT_WIDTH + 50 })] }))
    expect(issues.some(i => i.message.includes('完全在画布外'))).toBe(true)
  })

  it('部分出画布也要报 —— agent 最常犯的是「右边超出一点」', () => {
    const issues = lintSlide(slide({ elements: [text({ left: 800, width: 400 })] }))
    const overflow = issues.find(i => i.message.includes('超出画布'))
    expect(overflow).toBeDefined()
    expect(overflow!.message).toContain('右 200px')
  })

  it('底边超出也报', () => {
    const issues = lintSlide(slide({ elements: [text({ top: 500, height: 200 })] }))
    expect(issues.some(i => i.message.includes('下 138px'))).toBe(true)
  })

  it('刚好贴边不报（容差内）', () => {
    const issues = lintSlide(slide({
      elements: [text({ left: 0, top: 0, width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT })],
    }))
    expect(issues.filter(i => i.message.includes('超出画布'))).toHaveLength(0)
  })

  it('空文本报 warning', () => {
    const issues = lintSlide(slide({ elements: [text({ content: '<p><span></span></p>' })] }))
    expect(issues.some(i => i.message.includes('内容为空'))).toBe(true)
  })

  it('零尺寸报 error（不是 warning）', () => {
    const issues = lintSlide(slide({ elements: [text({ height: 0 })] }))
    const zero = issues.find(i => i.message.includes('尺寸为零'))
    expect(zero?.level).toBe('error')
  })

  it('孤儿动画报 error', () => {
    const issues = lintSlide(slide({
      animations: [{ id: 'a1', elId: 'el_ghost', effect: 'fade', type: 'in', duration: 500, trigger: 'click' }],
    }))
    const orphan = issues.find(i => i.message.includes('不存在的元素'))
    expect(orphan?.level).toBe('error')
  })

  describe('文本重叠（此前 rectsOverlap 是死代码，从未被调用）', () => {
    it('两个文本大面积重叠 → warning', () => {
      const issues = lintSlide(slide({
        elements: [
          text({ id: 'a', left: 100, top: 100, width: 300, height: 100 }),
          text({ id: 'b', left: 110, top: 105, width: 300, height: 100 }),
        ],
      }))
      expect(issues.some(i => i.message.includes('重叠'))).toBe(true)
    })

    it('轻微擦边不报（低于阈值）', () => {
      const issues = lintSlide(slide({
        elements: [
          text({ id: 'a', left: 100, top: 100, width: 300, height: 100 }),
          text({ id: 'b', left: 380, top: 100, width: 300, height: 100 }),
        ],
      }))
      expect(issues.filter(i => i.message.includes('重叠'))).toHaveLength(0)
    })

    it('文字压在图片上不报 —— 那是正常设计，报了全是噪音', () => {
      const issues = lintSlide(slide({
        elements: [
          { id: 'img', type: 'image', left: 0, top: 0, width: 1000, height: 400, rotate: 0, src: 'x.jpg', fixedRatio: true } as PPTElement,
          text({ id: 'a', left: 100, top: 100, width: 300, height: 100 }),
        ],
      }))
      expect(issues.filter(i => i.message.includes('重叠'))).toHaveLength(0)
    })

    it('背景板尺寸的文本被豁免', () => {
      const issues = lintSlide(slide({
        elements: [
          text({ id: 'backdrop', left: 0, top: 0, width: 1000, height: 562, content: '<p>bg</p>' }),
          text({ id: 'a', left: 100, top: 100, width: 300, height: 100 }),
        ],
      }))
      expect(issues.filter(i => i.message.includes('重叠'))).toHaveLength(0)
    })
  })
})

describe('applyAddElement', () => {
  it('拒绝非法元素', () => {
    const bad = { ...text(), id: 'el_new' } as Record<string, unknown>
    delete bad.defaultColor
    const r = applyAddElement([slide()], 'slide_1', bad as unknown as PPTElement)
    expect(r.ok).toBe(false)
  })

  it('拒绝重复 id —— 撞车会让后续寻址悄悄指向另一个元素', () => {
    const r = applyAddElement([slide()], 'slide_1', text({ id: 'el_t1' }))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('已存在')
  })

  it('跨页 id 撞车也拒绝', () => {
    const slides = [slide(), slide({ id: 'slide_2', elements: [] })]
    const r = applyAddElement(slides, 'slide_2', text({ id: 'el_t1' }))
    expect(r.ok).toBe(false)
  })

  it('合法元素正常加入，且不改动入参（纯函数）', () => {
    const slides = [slide()]
    const data = ok(applyAddElement(slides, 'slide_1', text({ id: 'el_new', top: 300 })))
    expect(data[0].elements).toHaveLength(2)
    expect(slides[0].elements).toHaveLength(1)
  })
})

describe('applyUpdateElement', () => {
  it('校验的是合并后的结果，不是 props 本身', () => {
    const r = applyUpdateElement([slide()], 'el_t1', { width: -5 })
    expect(r.ok).toBe(false)
  })

  it('不允许改 id', () => {
    const r = applyUpdateElement([slide()], 'el_t1', { id: 'el_other' })
    expect(r.ok).toBe(false)
  })

  it('不允许改 type', () => {
    const r = applyUpdateElement([slide()], 'el_t1', { type: 'image' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('删除后重建')
  })

  it('正常改属性', () => {
    const data = ok(applyUpdateElement([slide()], 'el_t1', { top: 300 }))
    expect((data[0].elements[0] as { top: number }).top).toBe(300)
  })

  it('改到越界会应用成功但带 warning', () => {
    const r = applyUpdateElement([slide()], 'el_t1', { left: 900 })
    expect(r.ok).toBe(true)
    expect(r.ok && r.issues.some(i => i.message.includes('超出画布'))).toBe(true)
  })
})

describe('applyDeleteElement — 级联删动画', () => {
  it('删元素时同页动画一并清掉（写时清理，不是读时过滤）', () => {
    const s = slide({
      animations: [
        { id: 'a1', elId: 'el_t1', effect: 'fade', type: 'in', duration: 500, trigger: 'click' },
        { id: 'a2', elId: 'el_keep', effect: 'fade', type: 'in', duration: 500, trigger: 'auto' },
      ],
      elements: [text(), text({ id: 'el_keep', top: 300 })],
    })
    const data = ok(applyDeleteElement([s], 'el_t1'))
    expect(data[0].animations).toHaveLength(1)
    expect(data[0].animations![0].id).toBe('a2')
    expect(lintDeck(data)).toHaveLength(0)
  })
})

describe('applyAddSlide', () => {
  it('拒绝重复的 slide id', () => {
    const r = applyAddSlide([slide()], slide())
    expect(r.ok).toBe(false)
  })

  it('拒绝页内元素非法的整页', () => {
    const r = applyAddSlide([slide()], slide({ id: 'slide_2', elements: [{ id: 'x', type: 'text' } as PPTElement] }))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('elements[0]')
  })

  it('拒绝元素 id 与已有页面撞车', () => {
    const r = applyAddSlide([slide()], slide({ id: 'slide_2' }))
    expect(r.ok).toBe(false)
  })

  it('拒绝自带孤儿动画的整页 —— 在入口堵死，不留后门', () => {
    const r = applyAddSlide([slide()], slide({
      id: 'slide_2',
      elements: [text({ id: 'el_x' })],
      animations: [{ id: 'a1', elId: 'el_ghost', effect: 'fade', type: 'in', duration: 500, trigger: 'click' }],
    }))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('el_ghost')
  })

  it('afterIndex 控制插入位置', () => {
    const slides = [slide(), slide({ id: 'slide_2', elements: [] })]
    const data = ok(applyAddSlide(slides, slide({ id: 'slide_new', elements: [] }), 0))
    expect(data.map(s => s.id)).toEqual(['slide_1', 'slide_new', 'slide_2'])
  })
})

describe('applyUpdateSlide', () => {
  it('整体替换 elements 时仍然校验 —— 这是绕过 addElement 的后门', () => {
    const r = applyUpdateSlide([slide()], 'slide_1', {
      elements: [{ id: 'x', type: 'text' } as PPTElement],
    })
    expect(r.ok).toBe(false)
  })

  it('替换 elements 后孤儿动画被清理', () => {
    const s = slide({
      animations: [{ id: 'a1', elId: 'el_t1', effect: 'fade', type: 'in', duration: 500, trigger: 'click' }],
    })
    const data = ok(applyUpdateSlide([s], 'slide_1', { elements: [text({ id: 'el_new' })] }))
    expect(data[0].animations).toHaveLength(0)
  })

  it('改 remark / background 正常', () => {
    const data = ok(applyUpdateSlide([slide()], 'slide_1', {
      remark: '讲纯度纪律',
      background: { type: 'solid', color: '#0a0e27' },
    }))
    expect(data[0].remark).toBe('讲纯度纪律')
    expect(data[0].background?.color).toBe('#0a0e27')
  })
})

describe('applyDeleteSlide', () => {
  it('不能删最后一页', () => {
    const r = applyDeleteSlide([slide()], 'slide_1')
    expect(r.ok).toBe(false)
  })

  it('两页以上可以删', () => {
    const data = ok(applyDeleteSlide([slide(), slide({ id: 'slide_2', elements: [] })], 'slide_1'))
    expect(data).toHaveLength(1)
  })
})

describe('动画时间线', () => {
  it('词表就是 configs/animation.ts 的 25 个，不再各处抄一份', () => {
    expect(ANIMATION_EFFECTS).toHaveLength(25)
    expect(ANIMATION_EFFECTS).toContain('fade-up')
    expect(ANIMATION_EFFECTS).not.toContain('bounceInDown') // animate.css 原词表已砍掉
  })

  it('addAnimations 拒绝 effect 与 type 不自洽的条目', () => {
    const r = applyAddAnimations([slide()], 'slide_1', [
      { id: 'a1', elId: 'el_t1', effect: 'exit-fade', type: 'in', duration: 500, trigger: 'click' },
    ])
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('out')
  })

  it('addAnimations 拒绝引用不存在的元素', () => {
    const r = applyAddAnimations([slide()], 'slide_1', [
      { id: 'a1', elId: 'el_ghost', effect: 'fade', type: 'in', duration: 500, trigger: 'click' },
    ])
    expect(r.ok).toBe(false)
  })

  it('addAnimations 拒绝重复动画 id', () => {
    const s = slide({
      animations: [{ id: 'a1', elId: 'el_t1', effect: 'fade', type: 'in', duration: 500, trigger: 'click' }],
    })
    const r = applyAddAnimations([s], 'slide_1', [
      { id: 'a1', elId: 'el_t1', effect: 'pulse', type: 'attention', duration: 500, trigger: 'auto' },
    ])
    expect(r.ok).toBe(false)
  })

  it('addAnimations 支持一次传多条', () => {
    const s = slide({ elements: [text(), text({ id: 'el_b', top: 300 })] })
    const data = ok(applyAddAnimations([s], 'slide_1', [
      { id: 'a1', elId: 'el_t1', effect: 'fade-down', type: 'in', duration: 500, trigger: 'click' },
      { id: 'a2', elId: 'el_b', effect: 'fade-up', type: 'in', duration: 600, trigger: 'auto' },
    ]))
    expect(data[0].animations).toHaveLength(2)
  })

  it('removeAnimations 按 elementIds 删', () => {
    const s = slide({
      elements: [text(), text({ id: 'el_b', top: 300 })],
      animations: [
        { id: 'a1', elId: 'el_t1', effect: 'fade', type: 'in', duration: 500, trigger: 'click' },
        { id: 'a2', elId: 'el_b', effect: 'fade', type: 'in', duration: 500, trigger: 'auto' },
      ],
    })
    const data = ok(applyRemoveAnimations([s], 'slide_1', { elementIds: ['el_t1'] }))
    expect(data[0].animations).toHaveLength(1)
    expect(data[0].animations![0].elId).toBe('el_b')
  })

  it('removeAnimations 没匹配到就报错，不假装成功', () => {
    const s = slide({
      animations: [{ id: 'a1', elId: 'el_t1', effect: 'fade', type: 'in', duration: 500, trigger: 'click' }],
    })
    expect(applyRemoveAnimations([s], 'slide_1', { animationIds: ['nope'] }).ok).toBe(false)
  })

  describe('R-16 · applyAnimationPreset', () => {
    const threeEls = slide({
      elements: [
        text({ id: 'el_title', top: 40, textType: 'title' }),
        text({ id: 'el_card_a', top: 200, left: 60, width: 400, textType: 'item' }),
        text({ id: 'el_card_b', top: 200, left: 540, width: 400, textType: 'item' }),
      ],
    })

    it('sequential：第一个点击触发，其余自动接续，按阅读顺序', () => {
      const data = ok(applyAnimationPreset([threeEls], 'slide_1', 'sequential'))
      const anims = data[0].animations!
      expect(anims.map(a => a.elId)).toEqual(['el_title', 'el_card_a', 'el_card_b'])
      expect(anims.map(a => a.trigger)).toEqual(['click', 'auto', 'auto'])
      expect(anims.every(a => a.type === 'in')).toBe(true)
    })

    it('title-then-content：标题先入，其余同时跟上', () => {
      const data = ok(applyAnimationPreset([threeEls], 'slide_1', 'title-then-content'))
      const anims = data[0].animations!
      expect(anims[0].elId).toBe('el_title')
      expect(anims[0].trigger).toBe('click')
      expect(anims[1].trigger).toBe('auto')
      expect(anims[2].trigger).toBe('meantime')
    })

    it('all-at-once：一次点击全部同时出现', () => {
      const data = ok(applyAnimationPreset([threeEls], 'slide_1', 'all-at-once'))
      expect(data[0].animations!.map(a => a.trigger)).toEqual(['click', 'meantime', 'meantime'])
    })

    it('none：清空本页动画', () => {
      const withAnims = ok(applyAnimationPreset([threeEls], 'slide_1', 'sequential'))
      const cleared = ok(applyAnimationPreset(withAnims, 'slide_1', 'none'))
      expect(cleared[0].animations).toHaveLength(0)
    })

    it('preset 是整页重排语义 —— 覆盖而非追加', () => {
      const once = ok(applyAnimationPreset([threeEls], 'slide_1', 'sequential'))
      const twice = ok(applyAnimationPreset(once, 'slide_1', 'sequential'))
      expect(twice[0].animations).toHaveLength(3)
    })

    it('展开出的动画永远不是孤儿', () => {
      const data = ok(applyAnimationPreset([threeEls], 'slide_1', 'sequential'))
      expect(lintDeck(data).filter(i => i.level === 'error')).toHaveLength(0)
    })

    it('空页面报错而不是产出空时间线', () => {
      const r = applyAnimationPreset([slide({ elements: [] })], 'slide_1', 'sequential')
      expect(r.ok).toBe(false)
    })

    it('自定义 effect 和 duration 生效', () => {
      const data = ok(applyAnimationPreset([threeEls], 'slide_1', 'sequential', { effect: 'zoom-in', duration: 900 }))
      expect(data[0].animations!.every(a => a.effect === 'zoom-in' && a.duration === 900)).toBe(true)
    })
  })
})
