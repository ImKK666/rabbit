/**
 * v-tooltip 的空值安全
 *
 * 这个指令此前没有任何判据，而它**能把整个宿主组件搞崩**：
 * `mounted` 钩子里抛的异常会让组件起不来。R-68 实测撞到过 ——
 * 一句 `v-tooltip="cond ? msg : undefined"` 让整块 AgentPanel 白掉。
 *
 * 所以这里只守一件事：**任何输入都不许抛**。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Directive, DirectiveBinding } from 'vue'

const setContent = vi.fn()
const destroy = vi.fn()
const tippy = vi.fn(() => ({ setContent, destroy }))

vi.mock('tippy.js', () => ({ default: (...args: unknown[]) => tippy(...args as []) }))
vi.mock('../tooltip.scss', () => ({}))

const { default: TooltipDirective } = await import('../tooltip') as { default: Directive }

/** 只造指令用得到的那两个字段 */
const bind = (value: unknown) => ({ value } as DirectiveBinding)

/**
 * 指令只把 el 当作挂实例的键（tippy 已 mock），所以给个普通对象就够。
 * 不为这一个文件把全局测试环境切成 jsdom —— 那会拖慢所有前端单测，
 * 而这里一个真实 DOM 节点也用不上。
 */
const el = () => ({} as HTMLElement)

const mount = (value: unknown) => {
  const node = el()
  ;(TooltipDirective.mounted as (e: HTMLElement, b: DirectiveBinding) => void)(node, bind(value))
  return node
}
const update = (node: HTMLElement, value: unknown) =>
  (TooltipDirective.updated as (e: HTMLElement, b: DirectiveBinding) => void)(node, bind(value))

beforeEach(() => {
  tippy.mockClear()
  setContent.mockClear()
})

describe('v-tooltip · 不许因为空值抛异常', () => {
  // 这条就是 R-68 撞到的形状
  it('undefined 不抛，内容退化成空串', () => {
    expect(() => mount(undefined)).not.toThrow()
    expect(tippy.mock.calls[0][1]).toMatchObject({ content: '' })
  })

  it('null 不抛', () => {
    expect(() => mount(null)).not.toThrow()
    expect(tippy.mock.calls[0][1]).toMatchObject({ content: '' })
  })

  it('对象里没有 content 时不抛', () => {
    expect(() => mount({ placement: 'bottom' })).not.toThrow()
    expect(tippy.mock.calls[0][1]).toMatchObject({ content: '', placement: 'bottom' })
  })

  it('updated 收到 undefined 时不抛', () => {
    const node = mount('原文案')
    expect(() => update(node, undefined)).not.toThrow()
    expect(setContent).toHaveBeenCalledWith('')
  })
})

describe('v-tooltip · 正常用法不受影响', () => {
  it('字符串直接当文案', () => {
    mount('删除此会话')
    expect(tippy.mock.calls[0][1]).toMatchObject({ content: '删除此会话' })
  })

  it('对象形式的 placement / delay 仍然生效', () => {
    mount({ content: '提示', placement: 'right', delay: [0, 0] })
    expect(tippy.mock.calls[0][1]).toMatchObject({
      content: '提示',
      placement: 'right',
      delay: [0, 0],
    })
  })

  it('不给 placement / delay 时用默认值', () => {
    mount('提示')
    expect(tippy.mock.calls[0][1]).toMatchObject({ placement: 'top', delay: [300, 0] })
  })

  it('updated 用新文案刷新', () => {
    const node = mount('旧')
    update(node, '新')
    expect(setContent).toHaveBeenCalledWith('新')
  })
})
