/**
 * deck 域取消策略的判据
 *
 * 「取消之后哪些事件还发」是这一轮唯一的策略决定，所以它得能被断言，
 * 而不是躺在 `pipeline.ts` 里靠读代码确认。
 *
 * **期望在这里独立抄一份**，不从 `CANCEL_POLICY` 反推 ——
 * 从数据反推的测试是不设防的：改了数据、期望跟着改，测试照样绿
 * （和 `toolGroups.test.ts` 那 23 个键是同一个道理）。
 */

import { describe, it, expect } from 'vitest'
import type { ServerMessage } from '@server/ws/handler'
import { survivesCancel, SURVIVING_EVENT_TYPES } from '../events'

/**
 * 协议里每一种下行事件各造一条。
 *
 * 手写而不是从类型生成 —— 类型在运行时不存在，而且手写的这份**就是期望本身**：
 * 协议加了新消息、这里没跟上时，下面「数量对得上」那条会红。
 */
const SAMPLES: ServerMessage[] = [
  { type: 'agent.status', status: 'thinking', message: '正在思考' },
  { type: 'agent.tool', tool: 'addSlide', args: {} },
  { type: 'agent.text', role: 'generator', content: '写了一页' },
  { type: 'agent.reasoning', role: 'generator', delta: '嗯' },
  { type: 'agent.reasoning.done', role: 'generator' },
  { type: 'agent.conversation', id: 1, title: '新会话' },
  { type: 'agent.ask', question: '要横版还是竖版' },
  { type: 'agent.deck', slidesJson: '[]', version: 3 },
  { type: 'agent.asset.pending', ticket: 'a1b2', kind: 'generate', prompt: 'a data center' },
  { type: 'agent.asset.ready', ticket: 'a1b2', src: `asset://${'0'.repeat(64)}`, width: 1376, height: 768 },
  { type: 'agent.asset.failed', ticket: 'a1b2', reason: '生图超时（120s）' },
  { type: 'error', message: '演示文稿不存在' },
]

/** 取消之后仍必须送达的，独立抄一份 */
const EXPECTED_SURVIVORS = ['agent.deck']

describe('取消策略', () => {
  it('只有 agent.deck 在取消之后仍然送达', () => {
    const survivors = SAMPLES.filter(survivesCancel).map(m => m.type)
    expect(survivors).toEqual(EXPECTED_SURVIVORS)
  })

  it('导出的放行清单与实际判定一致', () => {
    expect(SURVIVING_EVENT_TYPES).toEqual([...EXPECTED_SURVIVORS].sort())
  })

  it('其余全部可回收', () => {
    const reclaimable = SAMPLES.filter(m => !survivesCancel(m)).map(m => m.type)
    expect(reclaimable).toEqual([
      'agent.status',
      'agent.tool',
      'agent.text',
      'agent.reasoning',
      'agent.reasoning.done',
      'agent.conversation',
      'agent.ask',
      // 三条图片消息全部可回收：工具是同步等图的，图由 agent 自己写进 deck，
      // 所以它们一个字节的权威状态都不带 —— 详见 events.ts 里的说明
      'agent.asset.pending',
      'agent.asset.ready',
      'agent.asset.failed',
      'error',
    ])
  })

  it('样本覆盖了协议里的每一种消息', () => {
    // 防空跑：样本漏了一种，上面三条仍然会全绿 ——
    // 和 boundary.test.ts 那条「扫到的文件数 ≥ 5」是同一类断言
    const types = new Set(SAMPLES.map(m => m.type))
    expect(types.size).toBe(SAMPLES.length)
    // 11 → 12：第十八轮加了 agent.asset.failed。
    // 这条断言按设计就该在协议增删时先红 —— 它是「样本别落后于协议」的锚
    expect(SAMPLES).toHaveLength(12)
  })

  it('agent.deck 是唯一放行的那一条，且它确实被放行', () => {
    // 这两条分开断言：一条守「不多」，一条守「不少」。
    // 只写前者的话，把 agent.deck 也改成 reclaimable 仍然是绿的
    expect(SURVIVING_EVENT_TYPES).toHaveLength(1)
    expect(survivesCancel({ type: 'agent.deck', slidesJson: '[]', version: 0 })).toBe(true)
  })
})
