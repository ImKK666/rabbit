/**
 * 判据 1 / 2 / 3 / 9 · 一问一答的记忆完整性
 *
 * 核心断言只有一句：**第二轮的请求里，带得到第一轮的思考和工具调用。**
 * 见 docs/12-single-agent.md 第五节。
 *
 * ## 负对照（已跑过，记在这里）
 *
 * 这组断言先写在旧的 `toHistoryTurns` 上跑过一遍，4 条里红了 3 条：
 * 工具调用、工具返回值、长汇报的结尾各丢一条 —— 因为旧路径
 * 丢掉全部 `role='tool'` 行、并把每条截断到 600 字。
 *
 * **第 4 条（思考）当时是绿的，但那是假绿**：思考在旧 schema 里根本没有
 * 存储位置，我把它伪装成一条 assistant 行才「过」的。
 * 这里改成断言真正的存储形状 —— 一个 `reasoning` block 带着 signature。
 * 一条为了变绿而写的断言比没有断言更糟，它会让人以为这块被守着。
 */

import { describe, it, expect } from 'vitest'
import {
  toModelMessages,
  serializeBlocks,
  INTERRUPTED_TOOL_RESULT,
  type StoredRow,
  type ModelMessage,
  type AssistantBlock,
  type ToolResultBlock,
} from '../turnMemory'

/** 本次任务用的模型配置 */
const CFG = 7

const user = (content: string): StoredRow => ({ role: 'user', content })

const assistant = (blocks: AssistantBlock[], modelConfigId = CFG): StoredRow => ({
  role: 'assistant',
  content: blocks.map(b => (b.type === 'text' ? b.text : `<${b.type}>`)).join(''),
  blocksJson: serializeBlocks(blocks),
  modelConfigId,
})

const tool = (blocks: ToolResultBlock[], modelConfigId = CFG): StoredRow => ({
  role: 'tool',
  content: JSON.stringify(blocks),
  blocksJson: serializeBlocks(blocks),
  modelConfigId,
})

/**
 * 第一轮任务在库里留下的痕迹，**形状就是 `streamText` 的 `response.messages`**：
 * agent 先想了一下 → 查设计规范 → 拿到结果 → 套版式 → 汇报。
 */
const firstTurn: StoredRow[] = [
  user('做一份海洋主题的 PPT，三页'),
  assistant([
    { type: 'reasoning', text: '两条内容撑不起 cards，第二页换 compare', signature: 'sig-abc' },
    { type: 'tool-call', toolCallId: 'c1', toolName: 'getDesignTokens', args: {} },
  ]),
  tool([
    { type: 'tool-result', toolCallId: 'c1', toolName: 'getDesignTokens', result: { primary: '#0b6bcb' } },
  ]),
  assistant([
    { type: 'tool-call', toolCallId: 'c2', toolName: 'applyLayout', args: { slideId: 'slide_1', layout: 'title-center' } },
  ]),
  tool([
    { type: 'tool-result', toolCallId: 'c2', toolName: 'applyLayout', result: { ok: true, version: 3 } },
  ]),
  assistant([{ type: 'text', text: '建好 3 页。封面 title-center，第二页改用了 compare。' }]),
]

const dump = (msgs: ModelMessage[]) => JSON.stringify(msgs)
const run = (rows: StoredRow[], modelConfigId: number | null = CFG) =>
  toModelMessages(rows, { modelConfigId })

describe('判据 9 · 第二轮要看得见第一轮', () => {
  it('工具调用要活到第二轮 —— 用户说「刚才那页」时得知道是哪页', () => {
    const d = dump(run(firstTurn))
    expect(d).toContain('applyLayout')
    expect(d).toContain('slide_1')
  })

  it('工具的返回值也要活到第二轮 —— 否则设计规范每轮都要重新查一遍', () => {
    expect(dump(run(firstTurn))).toContain('#0b6bcb')
  })

  it('思考要活到第二轮，且 signature 原样带回 —— 这是交错思考跨轮成立的前提', () => {
    const msgs = run(firstTurn)
    const reasoning = msgs
      .filter((m): m is ModelMessage & { role: 'assistant' } => m.role === 'assistant')
      .flatMap(m => m.content)
      .find(b => b.type === 'reasoning')

    expect(reasoning).toEqual({
      type: 'reasoning',
      text: '两条内容撑不起 cards，第二页换 compare',
      signature: 'sig-abc',
    })
  })

  it('长汇报不该被腰斩 —— 旧路径的 600 字上限会把「为什么这么排」切掉', () => {
    const long = `${'排版说明。'.repeat(200)}关键结论在最后：第三页留白是刻意的。`
    const msgs = run([user('做一份 PPT'), assistant([{ type: 'text', text: long }])])
    expect(dump(msgs)).toContain('第三页留白是刻意的')
  })
})

describe('判据 1 · 存储是模型视角的镜像', () => {
  it('还原出来的消息与写进去的 blocks 逐块相等', () => {
    expect(run(firstTurn)).toEqual([
      { role: 'user', content: '做一份海洋主题的 PPT，三页' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '两条内容撑不起 cards，第二页换 compare', signature: 'sig-abc' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'getDesignTokens', args: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'getDesignTokens', result: { primary: '#0b6bcb' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c2', toolName: 'applyLayout', args: { slideId: 'slide_1', layout: 'title-center' } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c2', toolName: 'applyLayout', result: { ok: true, version: 3 } },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: '建好 3 页。封面 title-center，第二页改用了 compare。' }] },
    ])
  })

  it('第二轮追加在同一条历史后面，不是另起一份', () => {
    const msgs = run([...firstTurn, user('第二页再紧凑一点')])
    expect(msgs[0]).toEqual({ role: 'user', content: '做一份海洋主题的 PPT，三页' })
    expect(msgs.at(-1)).toEqual({ role: 'user', content: '第二页再紧凑一点' })
  })
})

describe('判据 2 · tool-call 与 tool-result 必须配对', () => {
  /** 取消 / 崩溃 / 进程被 kill 之后，库里会留下「有调用没结果」的半截状态 */
  const orphanCall: StoredRow[] = [
    user('做一份 PPT'),
    assistant([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'applyLayout', args: {} },
      { type: 'tool-call', toolCallId: 'c2', toolName: 'addShape', args: {} },
    ]),
    tool([{ type: 'tool-result', toolCallId: 'c1', toolName: 'applyLayout', result: { ok: true } }]),
    // c2 的结果永远不会来了
  ]

  it('缺结果的调用被补上一条 isError —— 缺了下一轮请求直接 400', () => {
    const msgs = run(orphanCall)
    const results = msgs.filter(m => m.role === 'tool').flatMap(m => m.content as ToolResultBlock[])
    expect(results.map(r => r.toolCallId)).toEqual(['c1', 'c2'])
    expect(results[1]).toEqual({
      type: 'tool-result',
      toolCallId: 'c2',
      toolName: 'addShape',
      result: INTERRUPTED_TOOL_RESULT,
      isError: true,
    })
  })

  it('对不上任何调用的孤儿结果被丢掉 —— 它同样会 400', () => {
    const msgs = run([
      user('做一份 PPT'),
      tool([{ type: 'tool-result', toolCallId: 'ghost', toolName: 'addSlide', result: {} }]),
      assistant([{ type: 'text', text: '好的' }]),
    ])
    expect(dump(msgs)).not.toContain('ghost')
  })

  it('结果按调用顺序重排 —— 产出确定，判据 1 才逐块比得了', () => {
    const msgs = run([
      user('做一份 PPT'),
      assistant([
        { type: 'tool-call', toolCallId: 'a', toolName: 'x', args: {} },
        { type: 'tool-call', toolCallId: 'b', toolName: 'y', args: {} },
      ]),
      // 落库顺序反了（并发工具返回的先后本来就不定）
      tool([
        { type: 'tool-result', toolCallId: 'b', toolName: 'y', result: 2 },
        { type: 'tool-result', toolCallId: 'a', toolName: 'x', result: 1 },
      ]),
    ])
    const results = msgs.filter(m => m.role === 'tool').flatMap(m => m.content as ToolResultBlock[])
    expect(results.map(r => r.toolCallId)).toEqual(['a', 'b'])
  })

  it('任何情况下产出里都不存在失配 —— 这条是不变式，不是某个用例', () => {
    for (const rows of [firstTurn, orphanCall, [...firstTurn, ...orphanCall]]) {
      const msgs = run(rows)
      const calls = msgs
        .filter(m => m.role === 'assistant')
        .flatMap(m => (m.content as AssistantBlock[]).filter(b => b.type === 'tool-call'))
        .map(b => (b as { toolCallId: string }).toolCallId)
      const results = msgs
        .filter(m => m.role === 'tool')
        .flatMap(m => (m.content as ToolResultBlock[]).map(r => r.toolCallId))
      expect(results).toEqual(calls)
    }
  })
})

describe('判据 3 · 换模型配置要剥掉思考块', () => {
  it('modelConfigId 对不上时思考被剥掉，其余一字不动', () => {
    // 管理员换了 provider / 换了 key，本次用的是 99
    const msgs = run(firstTurn, 99)
    expect(dump(msgs)).not.toContain('sig-abc')
    expect(dump(msgs)).not.toContain('撑不起 cards')
    // 工具调用和文本是和 key 无关的，必须留下
    expect(dump(msgs)).toContain('applyLayout')
    expect(dump(msgs)).toContain('#0b6bcb')
    expect(dump(msgs)).toContain('第二页改用了 compare')
  })

  it('剥完只剩空壳的 assistant 整条丢掉 —— 空 content 的 assistant 同样会被拒', () => {
    const msgs = run([
      user('做一份 PPT'),
      assistant([{ type: 'reasoning', text: '只有思考没有别的', signature: 's' }]),
      assistant([{ type: 'text', text: '做完了' }]),
    ], 99)
    expect(msgs).toEqual([
      { role: 'user', content: '做一份 PPT' },
      { role: 'assistant', content: [{ type: 'text', text: '做完了' }] },
    ])
  })

  it('配置一致时一个思考块都不能少', () => {
    expect(dump(run(firstTurn, CFG))).toContain('sig-abc')
  })

  it('拿不到配置 id 时按最保守处理 —— 全剥，不赌 signature 还有效', () => {
    expect(dump(run(firstTurn, null))).not.toContain('sig-abc')
  })
})

describe('上下文预算 · 丢整轮不丢半轮', () => {
  const bigTurn = (n: number): StoredRow[] => [
    user(`第 ${n} 轮的需求`),
    assistant([
      { type: 'text', text: 'x'.repeat(400) },
      { type: 'tool-call', toolCallId: `t${n}`, toolName: 'applyLayout', args: {} },
    ]),
    tool([{ type: 'tool-result', toolCallId: `t${n}`, toolName: 'applyLayout', result: { ok: true } }]),
  ]

  const rows = [...bigTurn(1), ...bigTurn(2), ...bigTurn(3), ...bigTurn(4)]

  it('超预算时从最旧的整轮开始丢', () => {
    const msgs = toModelMessages(rows, { modelConfigId: CFG, charBudget: 1200 })
    const d = dump(msgs)
    expect(d).not.toContain('第 1 轮的需求')
    expect(d).toContain('第 4 轮的需求')
  })

  it('丢完之后首条仍是 user，且配对完好', () => {
    const msgs = toModelMessages(rows, { modelConfigId: CFG, charBudget: 1200 })
    expect(msgs[0].role).toBe('user')
    const calls = msgs.filter(m => m.role === 'assistant')
      .flatMap(m => (m.content as AssistantBlock[]).filter(b => b.type === 'tool-call')).length
    const results = msgs.filter(m => m.role === 'tool')
      .flatMap(m => m.content as ToolResultBlock[]).length
    expect(results).toBe(calls)
  })

  it('留一行交代被省略了几轮 —— 让 agent 知道「前面有过对话」而不是以为没有', () => {
    const msgs = toModelMessages(rows, { modelConfigId: CFG, charBudget: 1200 })
    expect(msgs[0].content).toContain('已省略')
  })

  it('再紧的预算也至少留最后一轮 —— 全丢光等于把用户刚说的话删了', () => {
    const msgs = toModelMessages(rows, { modelConfigId: CFG, charBudget: 1 })
    expect(dump(msgs)).toContain('第 4 轮的需求')
  })

  it('没超预算就一条不动', () => {
    expect(toModelMessages(rows, { modelConfigId: CFG, charBudget: 1_000_000 }))
      .toEqual(run(rows))
  })
})

describe('老数据兼容 · 没有 blocksJson 的行按原语义处理', () => {
  const legacy = (role: StoredRow['role'], content: string): StoredRow => ({ role, content })

  it('老的 user / assistant 文本照旧进历史', () => {
    expect(run([legacy('user', '做一份 PPT'), legacy('assistant', '[Generator] 建好了')]))
      .toEqual([
        { role: 'user', content: '做一份 PPT' },
        { role: 'assistant', content: [{ type: 'text', text: '[Generator] 建好了' }] },
      ])
  })

  it('老的 Planner / Reviewer 行照旧丢弃', () => {
    const msgs = run([
      legacy('user', '做一份 PPT'),
      legacy('assistant', '[Planner] 计划'),
      legacy('assistant', '[Reviewer] 通过'),
      legacy('assistant', '[Generator] 建好了'),
    ])
    expect(msgs).toHaveLength(2)
    expect(dump(msgs)).not.toContain('计划')
  })

  it('老的 tool 行必须丢掉 —— 它没有 toolCallId，带进去必然配不上对', () => {
    const msgs = run([
      legacy('user', '做一份 PPT'),
      legacy('tool', '{"tool":"addSlide","args":{},"result":"{}"}'),
      legacy('assistant', '[Generator] 建好了'),
    ])
    expect(dump(msgs)).not.toContain('addSlide')
  })

  it('老数据仍然按 600 字截断 —— 不改老会话的行为', () => {
    const long = `[Generator] ${'x'.repeat(2000)}`
    const msgs = run([legacy('user', '做一份 PPT'), legacy('assistant', long)])
    expect(dump(msgs)).toContain('已截断')
  })

  it('新旧行混在同一条会话里也不炸 —— 迁移当天的会话就是这样', () => {
    const msgs = run([
      legacy('user', '第一轮'),
      legacy('assistant', '[Generator] 老产出'),
      user('第二轮'),
      assistant([{ type: 'tool-call', toolCallId: 'c9', toolName: 'lintDeck', args: {} }]),
      tool([{ type: 'tool-result', toolCallId: 'c9', toolName: 'lintDeck', result: { errors: [] } }]),
    ])
    expect(msgs[0]).toEqual({ role: 'user', content: '第一轮' })
    expect(dump(msgs)).toContain('lintDeck')
  })

  it('blocksJson 是脏数据时退回文本路径，不炸掉整条会话', () => {
    const msgs = run([
      user('做一份 PPT'),
      { role: 'assistant', content: '[Generator] 建好了', blocksJson: 'not json{{', modelConfigId: CFG },
    ])
    expect(msgs).toEqual([
      { role: 'user', content: '做一份 PPT' },
      { role: 'assistant', content: [{ type: 'text', text: '[Generator] 建好了' }] },
    ])
  })
})

describe('边界', () => {
  it('空输入返回空数组', () => {
    expect(run([])).toEqual([])
  })

  it('首条不是 user 时把开头掐掉 —— Anthropic 要求首条必须是 user', () => {
    const msgs = run([
      assistant([{ type: 'text', text: '上一轮的残留' }]),
      user('这一轮'),
    ])
    expect(msgs[0]).toEqual({ role: 'user', content: '这一轮' })
  })

  it('掐掉开头的 assistant 之后，它留下的孤儿 tool 消息也一并清掉', () => {
    const msgs = run([
      assistant([{ type: 'tool-call', toolCallId: 'z', toolName: 'addSlide', args: {} }]),
      tool([{ type: 'tool-result', toolCallId: 'z', toolName: 'addSlide', result: {} }]),
      user('这一轮'),
    ])
    expect(msgs).toEqual([{ role: 'user', content: '这一轮' }])
  })

  it('system 行（错误日志）不进模型', () => {
    const msgs = run([
      user('做一份 PPT'),
      { role: 'system', content: '错误: Not Found' },
    ])
    expect(msgs).toEqual([{ role: 'user', content: '做一份 PPT' }])
  })
})
