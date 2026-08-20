/**
 * 判据 10 · 重开会话要看得见上一轮的思考和工具
 *
 * 见 docs/12-single-agent.md 第五节。
 *
 * ## 这一条为什么需要单独一组断言
 *
 * 存储改成「一行 = 一条模型消息」之后，**一次工具调用横跨两行**：
 * 参数在 assistant 的 `tool-call` 块里，结果在紧跟着的 tool 消息里。
 * 面板要把它显示成一条，就得跨行配对 —— 而配错了不会报任何错，
 * 只会表现成「重开会话之后工具调用没有参数」或者「结果对到了别的调用上」。
 *
 * 后端那边同样有配对逻辑（`turnMemory.ts` 的 `repairToolPairing`），
 * 但那是给模型看的，跟这里是两条独立的路径。**两边都得有判据。**
 */

import { describe, it, expect } from 'vitest'
import { hydrateLog } from '@/store/agent'

interface Row {
  id: number
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  blocksJson?: string | null
}

let nextId = 1
const row = (role: Row['role'], content: string, blocks?: unknown[]): Row => ({
  id: nextId++,
  role,
  content,
  blocksJson: blocks ? JSON.stringify(blocks) : null,
})

/** 一轮任务在库里的形状：想一下 → 调工具 → 拿结果 → 汇报 */
const oneTurn = (): Row[] => {
  nextId = 1
  return [
    row('user', '做一份海洋主题的 PPT'),
    row('assistant', '', [
      { type: 'reasoning', text: '两条内容撑不起 cards，第二页换 compare', signature: 'sig' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'applyLayout', args: { slideId: 'slide_1', layout: 'title-center' } },
    ]),
    row('tool', '[]', [
      { type: 'tool-result', toolCallId: 'c1', toolName: 'applyLayout', result: { ok: true, version: 3 } },
    ]),
    row('assistant', '建好了', [{ type: 'text', text: '建好了' }]),
  ]
}

describe('判据 10 · 重开会话的还原', () => {
  it('思考被还原出来，且默认是收起的 —— 它是过程，回看不该占屏', () => {
    const log = hydrateLog(oneTurn())
    const reasoning = log.find(e => e.type === 'reasoning')
    expect(reasoning).toMatchObject({
      type: 'reasoning',
      content: '两条内容撑不起 cards，第二页换 compare',
      done: true,
    })
  })

  it('一次工具调用还原成一条日志，参数和结果都在 —— 它们本来分在两行里', () => {
    const tool = hydrateLog(oneTurn()).find(e => e.type === 'tool')
    expect(tool).toMatchObject({
      type: 'tool',
      tool: 'applyLayout',
      args: { slideId: 'slide_1', layout: 'title-center' },
    })
    expect((tool as { result?: string }).result).toContain('"version": 3')
  })

  it('顺序照旧：用户 → 思考 → 工具 → 汇报', () => {
    expect(hydrateLog(oneTurn()).map(e => e.type))
      .toEqual(['text', 'reasoning', 'tool', 'text'])
  })

  it('结果按 toolCallId 配对，不按位置 —— 并发工具的返回先后本来就不定', () => {
    nextId = 1
    const log = hydrateLog([
      row('user', '做一份 PPT'),
      row('assistant', '', [
        { type: 'tool-call', toolCallId: 'a', toolName: 'addSlide', args: { i: 1 } },
        { type: 'tool-call', toolCallId: 'b', toolName: 'addShape', args: { i: 2 } },
      ]),
      row('tool', '[]', [
        { type: 'tool-result', toolCallId: 'b', toolName: 'addShape', result: 'B' },
        { type: 'tool-result', toolCallId: 'a', toolName: 'addSlide', result: 'A' },
      ]),
    ])
    const tools = log.filter(e => e.type === 'tool') as { tool: string, result?: string }[]
    // 字符串结果原样透传（和后端 `humanSummary` 一致），不再套一层 JSON 引号
    expect(tools.map(t => [t.tool, t.result])).toEqual([
      ['addSlide', 'A'],
      ['addShape', 'B'],
    ])
  })

  it('没等到结果的调用照样显示出来 —— 任务被取消时就是这样', () => {
    nextId = 1
    const log = hydrateLog([
      row('user', '做一份 PPT'),
      row('assistant', '', [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'applyLayout', args: {} },
      ]),
      // 结果永远不会来了
    ])
    const tool = log.find(e => e.type === 'tool') as { tool: string, result?: string }
    expect(tool.tool).toBe('applyLayout')
    expect(tool.result).toBeUndefined()
  })

  it('分叉锚点落在 tool 行上 —— 从一次调用分叉时，发起它的 assistant 也要留下', () => {
    const rows = oneTurn()
    const toolRowId = rows[2].id
    const tool = hydrateLog(rows).find(e => e.type === 'tool') as { messageId?: number }
    expect(tool.messageId).toBe(toolRowId)
  })

  it('加密的思考跳过，不显示成乱码', () => {
    nextId = 1
    const log = hydrateLog([
      row('user', 'x'),
      row('assistant', '好', [
        { type: 'redacted-reasoning', data: 'AAAA' },
        { type: 'text', text: '好' },
      ]),
    ])
    expect(log.map(e => e.type)).toEqual(['text', 'text'])
    expect(JSON.stringify(log)).not.toContain('AAAA')
  })
})

describe('老会话不能被改坏', () => {
  it('没有 blocksJson 的行按原来的方式还原', () => {
    nextId = 1
    const log = hydrateLog([
      row('user', '做一份 PPT'),
      row('assistant', '[Generator] 建好 3 页'),
      row('tool', '{"tool":"addSlide","args":{"i":1},"result":"{\\"ok\\":true}"}'),
      row('assistant', '[Reviewer] {"passed":true}'),
    ])
    expect(log).toEqual([
      { type: 'text', role: 'user', content: '做一份 PPT', messageId: 1 },
      { type: 'text', role: 'generator', content: '建好 3 页', messageId: 2 },
      { type: 'tool', tool: 'addSlide', args: { i: 1 }, result: '{"ok":true}', messageId: 3 },
      { type: 'text', role: 'reviewer', content: '{"passed":true}', messageId: 4 },
    ])
  })

  it('新旧行混在一条会话里也不串味 —— 迁移当天的会话就是这样', () => {
    nextId = 1
    const log = hydrateLog([
      row('user', '第一轮'),
      row('assistant', '[Generator] 老产出'),
      row('user', '第二轮'),
      row('assistant', '', [{ type: 'tool-call', toolCallId: 'c9', toolName: 'lintDeck', args: {} }]),
      row('tool', '[]', [{ type: 'tool-result', toolCallId: 'c9', toolName: 'lintDeck', result: { errors: [] } }]),
    ])
    expect(log.map(e => e.type)).toEqual(['text', 'text', 'text', 'tool'])
    expect(log[3]).toMatchObject({ tool: 'lintDeck' })
  })

  it('blocksJson 是脏数据时退回文本路径，不炸掉整个面板', () => {
    nextId = 1
    const log = hydrateLog([
      { id: 1, role: 'user', content: '做一份 PPT' },
      { id: 2, role: 'assistant', content: '[Generator] 建好了', blocksJson: 'not json{{' },
    ])
    expect(log).toEqual([
      { type: 'text', role: 'user', content: '做一份 PPT', messageId: 1 },
      { type: 'text', role: 'generator', content: '建好了', messageId: 2 },
    ])
  })
})
