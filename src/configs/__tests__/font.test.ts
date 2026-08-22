import { describe, it, expect } from 'vitest'
import { FONTS, FONT_FAMILY_ALIASES, SYSTEM_FONT_SUBSTITUTES, resolveFontFamily } from '../font'

describe('FONT_FAMILY_ALIASES', () => {
  // 别名表漏一个，那个字体导出后就还是报缺失 —— 而且不会有任何报错
  it('覆盖 FONTS 里每一个非默认字体', () => {
    const missing = FONTS
      .map(f => f.value)
      .filter(value => value && !FONT_FAMILY_ALIASES[value])
    expect(missing).toEqual([])
  })

  // 这几个名字看着不像，但都是从 woff2 的 name 表里读出来的，
  // 顺手「修」成中文标签就等于把缺失提示又请回来
  it('保留从 name 表读出的真实家族名', () => {
    expect(FONT_FAMILY_ALIASES.DeYiHei).toBe('Smiley Sans')
    expect(FONT_FAMILY_ALIASES.LXGWWenKai).toBe('LXGW WenKai GB Screen')
    expect(FONT_FAMILY_ALIASES.SourceHanSans).toBe('Source Han Sans CN VF')
  })
})

describe('resolveFontFamily', () => {
  it('把内部别名翻译成真实家族名', () => {
    expect(resolveFontFamily('LXGWNeoXiHei')).toBe('LXGW Neo XiHei')
    expect(resolveFontFamily('AlibabaPuHuiTi')).toBe('Alibaba PuHuiTi 2.0')
  })

  it('真实字体名原样返回', () => {
    expect(resolveFontFamily('Arial')).toBe('Arial')
    expect(resolveFontFamily('微软雅黑')).toBe('微软雅黑')
  })

  // OOXML 的 typeface 只能放一个名字，整条 CSS 栈塞进去谁都匹配不上
  it('CSS 字体栈只取第一项', () => {
    expect(resolveFontFamily('LXGWNeoXiHei, sans-serif')).toBe('LXGW Neo XiHei')
    expect(resolveFontFamily('"Source Han Sans CN VF", Arial')).toBe('Source Han Sans CN VF')
  })

  it('剥掉引号', () => {
    expect(resolveFontFamily("'LXGWNeoZhiSong'")).toBe('LXGW Neo ZhiSong')
  })

  it('空串原样返回', () => {
    expect(resolveFontFamily('')).toBe('')
  })
})

describe('resolveFontFamily · 替换为系统字体', () => {
  it('别名换成系统自带字体', () => {
    expect(resolveFontFamily('LXGWNeoXiHei', true)).toBe('PingFang SC')
    expect(resolveFontFamily('LXGWNeoZhiSong', true)).toBe('Songti SC')
    expect(resolveFontFamily('DeYiHei', true)).toBe('PingFang SC')
  })

  // 替换会改观感，但至少不该把一份宋体正文换成黑体
  it('按风格归类，宋体落宋体、楷体落楷体', () => {
    expect(resolveFontFamily('SourceHanSerif', true)).toBe('Songti SC')
    expect(resolveFontFamily('LXGWWenKai', true)).toBe('Kaiti SC')
    expect(resolveFontFamily('SourceHanSans', true)).toBe('PingFang SC')
  })

  // 导入的 deck / 上游默认值带的是真实 Windows 字体名，在 macOS 上同样缺失
  it('Windows 字体名也替换', () => {
    expect(resolveFontFamily('微软雅黑', true)).toBe('PingFang SC')
    expect(resolveFontFamily('宋体', true)).toBe('Songti SC')
  })

  it('已经是系统字体的原样返回', () => {
    expect(resolveFontFamily('Arial', true)).toBe('Arial')
    expect(resolveFontFamily('PingFang SC', true)).toBe('PingFang SC')
  })

  it('字体栈同样只取第一项', () => {
    expect(resolveFontFamily('LXGWNeoXiHei, sans-serif', true)).toBe('PingFang SC')
  })

  it('关闭时保留真实字体名，不做替换', () => {
    expect(resolveFontFamily('LXGWNeoXiHei', false)).toBe('LXGW Neo XiHei')
  })

  // 漏一个就意味着那个字体在替换模式下仍会弹缺失框
  it('FONTS 里每个字体都有替换项', () => {
    const missing = FONTS
      .map(f => f.value)
      .filter(value => value && !SYSTEM_FONT_SUBSTITUTES[value])
    expect(missing).toEqual([])
  })
})
