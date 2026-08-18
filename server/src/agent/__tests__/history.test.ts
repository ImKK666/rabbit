import { describe, it, expect } from 'vitest'
import { toHistoryTurns, HISTORY_CONTENT_LIMIT, type StoredMessage } from '../history'

const u = (content: string): StoredMessage => ({ role: 'user', content })
const a = (content: string): StoredMessage => ({ role: 'assistant', content })

describe('toHistoryTurns — 对话历史转 LLM 消息', () => {
  it('保留用户和 Generator 的产出', () => {
    expect(toHistoryTurns([
      u('做一份海洋主题的 PPT'),
      a('[Generator] 已建 3 页'),
    ])).toEqual([
      { role: 'user', content: '做一份海洋主题的 PPT' },
      { role: 'assistant', content: '[Generator] 已建 3 页' },
    ])
  })

  it('丢弃 Planner 和 Reviewer —— 一轮任务内部的中间过程，对下一轮没参考价值', () => {
    const turns = toHistoryTurns([
      u('做一份海洋主题的 PPT'),
      a('[Planner] {"steps":[...]}'),
      a('[Generator] 已建 3 页'),
      a('[Reviewer] {"passed":true}'),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[1].content).toBe('[Generator] 已建 3 页')
  })

  it('丢弃 system 行（错误记录）', () => {
    const turns = toHistoryTurns([
      u('做一份 PPT'),
      { role: 'system', content: '错误: Not Found' },
    ])
    expect(turns).toEqual([{ role: 'user', content: '做一份 PPT' }])
  })

  it('合并连续的 assistant —— Generator + Generator 修正会连着落两条', () => {
    const turns = toHistoryTurns([
      u('做一份 PPT'),
      a('[Generator] 已建 3 页'),
      a('[Generator 修正] 修好了标题溢出'),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[1].role).toBe('assistant')
    expect(turns[1].content).toBe('[Generator] 已建 3 页\n\n[Generator 修正] 修好了标题溢出')
  })

  it('合并连续的 user', () => {
    const turns = toHistoryTurns([u('第一句'), u('第二句')])
    expect(turns).toEqual([{ role: 'user', content: '第一句\n\n第二句' }])
  })

  it('首条是 assistant 时丢弃 —— Anthropic 要求首条必须是 user', () => {
    const turns = toHistoryTurns([
      a('[Generator] 上一轮的残留'),
      u('这一轮的需求'),
      a('[Generator] 做完了'),
    ])
    expect(turns[0]).toEqual({ role: 'user', content: '这一轮的需求' })
    expect(turns).toHaveLength(2)
  })

  it('过滤掉 Planner 后开头恰好剩 assistant，也要丢掉', () => {
    const turns = toHistoryTurns([
      a('[Planner] 计划'),
      a('[Generator] 产出'),
      u('接着改'),
    ])
    expect(turns).toEqual([{ role: 'user', content: '接着改' }])
  })

  it('产出的序列永远严格交替', () => {
    const turns = toHistoryTurns([
      u('a'), a('[Generator] 1'), a('[Generator 修正] 2'),
      u('b'), u('c'), a('[Planner] x'), a('[Generator] 3'),
    ])
    for (let i = 1; i < turns.length; i++) {
      expect(turns[i].role).not.toBe(turns[i - 1].role)
    }
    expect(turns[0].role).toBe('user')
  })

  it('超长内容被截断', () => {
    const long = 'x'.repeat(HISTORY_CONTENT_LIMIT + 200)
    const turns = toHistoryTurns([u(long)])
    expect(turns[0].content.length).toBeLessThan(long.length)
    expect(turns[0].content).toContain('已截断')
  })

  it('恰好等于上限不截断', () => {
    const exact = 'x'.repeat(HISTORY_CONTENT_LIMIT)
    expect(toHistoryTurns([u(exact)])[0].content).toBe(exact)
  })

  it('空输入返回空数组', () => {
    expect(toHistoryTurns([])).toEqual([])
  })

  it('全是 Planner / Reviewer 时返回空，而不是产出非法序列', () => {
    expect(toHistoryTurns([a('[Planner] x'), a('[Reviewer] y')])).toEqual([])
  })

  it('Editor 路径的产出没有角色前缀，同样保留', () => {
    const turns = toHistoryTurns([u('把标题改蓝'), a('已把标题改成 #00d4ff')])
    expect(turns[1].content).toBe('已把标题改成 #00d4ff')
  })
})
