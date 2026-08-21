/**
 * 判据 9c · 思考要真的到得了模型
 *
 * `interleavedThinking.test.ts` 验的是「AI SDK 内部把思考传到了下一步」，
 * 那一层早就是对的。这一组验的是**最后一公里**：
 * 转成 OpenAI wire 格式发出去的时候，思考还在不在。
 *
 * 负对照是现成的、而且是实测过的：不打这层补丁时，
 * `@ai-sdk/openai-compatible` 的 assistant 分支只有 `case "text"` 和
 * `case "tool-call"` 两支，思考块被静默丢掉 —— deepseek / openai / google
 * 三家的请求体里都搜不到思考文本，只有 anthropic 有。
 */

import { describe, it, expect } from 'vitest'
import {
  createReasoningRelay,
  needsReasoningRelay,
  relayFetch,
} from '../reasoningRelay'

/** 我们从库里还原出来的一步：想了一下，然后调了两个工具 */
const step = (reasoning: string, ...toolCallIds: string[]) => ({
  role: 'assistant',
  content: [
    ...(reasoning ? [{ type: 'reasoning', text: reasoning, signature: 'sig' }] : []),
    ...toolCallIds.map(id => ({ type: 'tool-call', toolCallId: id, toolName: 'getDeck', args: {} })),
  ],
})

/** provider 转出来的 wire 请求体：思考已经被丢掉了，只剩 tool_calls */
const wire = (...messages: unknown[]) => JSON.stringify({ model: 'deepseek-v4-pro', messages })
const assistantCall = (...ids: string[]) => ({ role: 'assistant', content: '', tool_calls: ids.map(id => ({ id, type: 'function', function: { name: 'getDeck', arguments: '{}' } })) })
const parse = (body: string) => JSON.parse(body).messages as { role: string, reasoning_content?: string }[]

describe('该给哪些 provider 打补丁', () => {
  it('OpenAI wire 格式的两家要打', () => {
    expect(needsReasoningRelay('deepseek')).toBe(true)
    expect(needsReasoningRelay('openai')).toBe(true)
  })

  it('anthropic 不打 —— 它的 converter 本来就把思考带回去了，再补一次是错的', () => {
    expect(needsReasoningRelay('anthropic')).toBe(false)
  })

  it('google 不打 —— wire 格式根本不是这套，塞进去不会有任何作用', () => {
    expect(needsReasoningRelay('google')).toBe(false)
  })
})

describe('判据 9c · 思考被补回请求体', () => {
  it('按 toolCallId 配回去', () => {
    const relay = createReasoningRelay()
    relay.learn([step('先查设计规范，不然字号只能瞎编。', 'c1')])

    const out = parse(relay.patch(wire(
      { role: 'user', content: '做一份稿子' },
      assistantCall('c1'),
      { role: 'tool', tool_call_id: 'c1', content: '{}' },
    )))
    expect(out[1].reasoning_content).toBe('先查设计规范，不然字号只能瞎编。')
  })

  it('一步里发了多个工具调用，任一个 id 都配得回同一段思考', () => {
    const relay = createReasoningRelay()
    relay.learn([step('两页一起排。', 'c1', 'c2')])
    expect(parse(relay.patch(wire(assistantCall('c2'))))[0].reasoning_content).toBe('两页一起排。')
  })

  it('流式拆成几块的思考要拼完整 —— 半段思考比没有更容易带偏模型', () => {
    const relay = createReasoningRelay()
    relay.learn([{
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '先查设计规范，' },
        { type: 'reasoning', text: '不然字号只能瞎编。' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'x', args: {} },
      ],
    }])
    expect(parse(relay.patch(wire(assistantCall('c1'))))[0].reasoning_content)
      .toBe('先查设计规范，不然字号只能瞎编。')
  })

  it('多步各配各的 —— 不能把第一步的思考按到第二步头上', () => {
    const relay = createReasoningRelay()
    relay.learn([step('第一步：查规范', 'c1'), step('第二步：排版', 'c2')])
    const out = parse(relay.patch(wire(assistantCall('c1'), assistantCall('c2'))))
    expect(out.map(m => m.reasoning_content)).toEqual(['第一步：查规范', '第二步：排版'])
  })

  it('learn 可以反复调 —— 单轮内每步学一次，跨轮时整份历史喂一遍', () => {
    const relay = createReasoningRelay()
    relay.learn([step('第一步', 'c1')])
    expect(relay.size()).toBe(1)
    relay.learn([step('第二步', 'c2', 'c3')])
    expect(relay.size()).toBe(3)
  })
})

describe('不该动的一律不动', () => {
  it('provider 自己带了 reasoning_content 就不覆盖 —— 它那份永远优先', () => {
    const relay = createReasoningRelay()
    relay.learn([step('我们记的那份', 'c1')])
    const out = parse(relay.patch(wire({ ...assistantCall('c1'), reasoning_content: 'provider 自己的' })))
    expect(out[0].reasoning_content).toBe('provider 自己的')
  })

  it('没有工具调用的 assistant 不动 —— 没有键，硬配只会配错', () => {
    const relay = createReasoningRelay()
    relay.learn([step('想了点什么', 'c1')])
    const body = wire({ role: 'assistant', content: '做完了' })
    expect(relay.patch(body)).toBe(body)
  })

  it('配不上 id 的不动', () => {
    const relay = createReasoningRelay()
    relay.learn([step('想了点什么', 'c1')])
    const body = wire(assistantCall('别的-id'))
    expect(relay.patch(body)).toBe(body)
  })

  it('什么都没学到时原样返回，连 JSON 都不解析', () => {
    const body = wire(assistantCall('c1'))
    expect(createReasoningRelay().patch(body)).toBe(body)
  })

  it('没有思考的那一步不进表 —— 免得把空串写进请求体', () => {
    const relay = createReasoningRelay()
    relay.learn([step('', 'c1')])
    expect(relay.size()).toBe(0)
  })

  it('user / tool 消息一律不碰', () => {
    const relay = createReasoningRelay()
    relay.learn([step('想了点什么', 'c1')])
    const out = parse(relay.patch(wire(
      { role: 'user', content: 'x' },
      { role: 'tool', tool_call_id: 'c1', content: '{}' },
    )))
    expect(out.every(m => m.reasoning_content === undefined)).toBe(true)
  })
})

describe('坏输入不许把请求搞挂 —— 这层是增强，不是必需品', () => {
  const relay = () => {
    const r = createReasoningRelay()
    r.learn([step('想了点什么', 'c1')])
    return r
  }

  it('请求体不是 JSON', () => {
    expect(relay().patch('not json{{')).toBe('not json{{')
  })

  it('请求体没有 messages 字段', () => {
    expect(relay().patch('{"model":"x"}')).toBe('{"model":"x"}')
  })

  it('tool_calls 里缺 id', () => {
    const body = JSON.stringify({ messages: [{ role: 'assistant', tool_calls: [{ type: 'function' }] }] })
    expect(relay().patch(body)).toBe(body)
  })

  it('learn 收到形状不对的消息不抛', () => {
    const r = createReasoningRelay()
    expect(() => r.learn([
      { role: 'assistant', content: 'string 而不是数组' },
      { role: 'user', content: [{ type: 'text', text: 'x' }] },
    ])).not.toThrow()
    expect(r.size()).toBe(0)
  })
})

describe('relayFetch · 接线', () => {
  it('把补过的请求体交给底层 fetch', async () => {
    const relay = createReasoningRelay()
    relay.learn([step('先查规范', 'c1')])

    let sent = ''
    const base = (async (_i: unknown, init: { body: string }) => {
      sent = init.body
      return new Response('ok')
    }) as unknown as typeof fetch

    await relayFetch(relay, base)('https://x/y', { method: 'POST', body: wire(assistantCall('c1')) })
    expect(JSON.parse(sent).messages[0].reasoning_content).toBe('先查规范')
  })

  it('非字符串 body 直接放行 —— 上传之类的请求不该被碰', async () => {
    let got: unknown = null
    const base = (async (_i: unknown, init: unknown) => {
      got = init; return new Response('ok')
    }) as unknown as typeof fetch
    const init = { method: 'POST', body: new Uint8Array([1, 2, 3]) }
    await relayFetch(createReasoningRelay(), base)('https://x/y', init as never)
    expect(got).toBe(init)
  })

  it('补丁抛异常时照原样发出去，不让请求失败', async () => {
    const broken = {
      learn: () => {},
      size: () => 1,
      patch: () => {
        throw new Error('boom')
      },
    }
    let sent = ''
    const base = (async (_i: unknown, init: { body: string }) => {
      sent = init.body; return new Response('ok')
    }) as unknown as typeof fetch
    await relayFetch(broken, base)('https://x/y', { method: 'POST', body: '{"messages":[]}' })
    expect(sent).toBe('{"messages":[]}')
  })
})
