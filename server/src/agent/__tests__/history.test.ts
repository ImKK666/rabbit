import { describe, it, expect } from 'vitest'
import {
  toHistoryTurns,
  makeConversationTitle,
  serializeToolCall,
  parseToolCall,
  HISTORY_CONTENT_LIMIT,
  TITLE_LIMIT,
  TOOL_ARGS_LIMIT,
  TOOL_RESULT_LIMIT,
  type StoredMessage,
} from '../history'

const u = (content: string): StoredMessage => ({ role: 'user', content })
const a = (content: string): StoredMessage => ({ role: 'assistant', content })
const t = (content: string): StoredMessage => ({ role: 'tool', content })

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

  it('tool 行不进记忆 —— 它只用于面板还原，混进去会打断 user/assistant 交替', () => {
    const turns = toHistoryTurns([
      u('做一份 PPT'),
      t('{"tool":"addSlide","args":{},"result":"{\\"ok\\":true}"}'),
      t('{"tool":"setTheme","args":{}}'),
      a('[Generator] 建好了'),
    ])
    expect(turns).toEqual([
      { role: 'user', content: '做一份 PPT' },
      { role: 'assistant', content: '[Generator] 建好了' },
    ])
  })

  it('tool 行夹在中间也不会把同侧的 assistant 拆成两条', () => {
    const turns = toHistoryTurns([
      u('做一份 PPT'),
      a('[Generator] 第一段'),
      t('{"tool":"lintDeck","args":{}}'),
      a('[Generator 修正] 第二段'),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[1].content).toBe('[Generator] 第一段\n\n[Generator 修正] 第二段')
  })
})

describe('makeConversationTitle', () => {
  it('短输入原样用作标题', () => {
    expect(makeConversationTitle('加个封面')).toBe('加个封面')
  })

  it('超长截断并加省略号', () => {
    const title = makeConversationTitle('做一份深海蓝科技风格的演示文稿讲清楚为什么要有 Deck Kernel')
    expect(title.length).toBe(TITLE_LIMIT + 1)
    expect(title.endsWith('…')).toBe(true)
  })

  it('折叠换行和连续空白 —— 多行输入不能把列表撑坏', () => {
    expect(makeConversationTitle('第一行\n\n  第二行')).toBe('第一行 第二行')
  })

  it('空输入回退到「新会话」', () => {
    expect(makeConversationTitle('   ')).toBe('新会话')
    expect(makeConversationTitle('')).toBe('新会话')
  })
})

describe('serializeToolCall / parseToolCall', () => {
  it('往返不丢信息', () => {
    const record = {
      tool: 'addSlide',
      args: { slideId: 'slide_1', afterIndex: 0 },
      result: '{"ok":true,"version":3}',
    }
    expect(parseToolCall(serializeToolCall(record))).toEqual(record)
  })

  it('没有 result 的调用也能往返', () => {
    const record = { tool: 'lintDeck', args: {} }
    const parsed = parseToolCall(serializeToolCall(record))
    expect(parsed?.tool).toBe('lintDeck')
    expect(parsed?.result).toBeUndefined()
  })

  it('超长参数整体换成 __truncated，而不是切成半截 JSON', () => {
    const huge = { content: 'x'.repeat(TOOL_ARGS_LIMIT + 500) }
    const parsed = parseToolCall(serializeToolCall({ tool: 'addSlide', args: huge }))
    expect(parsed?.args.content).toBeUndefined()
    expect(String(parsed?.args.__truncated)).toContain('已截断')
  })

  it('恰好在上限内的参数不动', () => {
    const args = { content: 'x'.repeat(100) }
    const parsed = parseToolCall(serializeToolCall({ tool: 'addSlide', args }))
    expect(parsed?.args).toEqual(args)
  })

  it('超长结果被截断', () => {
    const result = 'y'.repeat(TOOL_RESULT_LIMIT + 500)
    const parsed = parseToolCall(serializeToolCall({ tool: 'getSlide', args: {}, result }))
    expect(parsed!.result!.length).toBeLessThan(result.length)
    expect(parsed?.result).toContain('已截断')
  })

  it('脏数据解析返回 null，不抛异常 —— 一条坏记录不能炸掉整个面板', () => {
    expect(parseToolCall('not json')).toBeNull()
    expect(parseToolCall('{}')).toBeNull()
    expect(parseToolCall('null')).toBeNull()
    expect(parseToolCall('{"tool":123}')).toBeNull()
  })

  it('args 缺失或不是对象时兜底成空对象', () => {
    expect(parseToolCall('{"tool":"getDeck"}')?.args).toEqual({})
    expect(parseToolCall('{"tool":"getDeck","args":"oops"}')?.args).toEqual({})
  })
})
