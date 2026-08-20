/**
 * 判据 9（另一半）· 思考中调用工具 —— **直接观测发出去的请求**
 *
 * `turnMemory.test.ts` 那一组验的是「跨轮」：第二轮的历史里带着第一轮的思考。
 * 这一组验的是「跨工具边界」：**同一轮里，第二步的请求里带着第一步的思考。**
 *
 * 两件事都成立，「思考中可以使用工具」才算真的实现了：
 *   第一步想 → 调工具 → 拿到结果 → **带着刚才想过的东西**接着想 → 再调工具
 * 少了后半句，模型每一步都是从零开始猜，前一步的推理白费。
 *
 * ## 为什么必须是「观测」而不是「读文档」
 *
 * 这条链路全长在依赖里：`streamText` 每步把 `toResponseMessages` 的产物
 * 累进 `responseMessages`，下一步连同历史一起发出去。我们一行代码都没写。
 * 也正因为一行都没写，**它坏掉的时候不会有任何东西报错** ——
 * 升一次 `ai` 的小版本就可能悄悄改掉这个行为，而表现只是「模型变笨了」。
 *
 * 所以这里挂一个假模型，把每一次 `doStream` 收到的 prompt 原样截下来，
 * 直接断言第二次那份里有第一次吐的思考块（连 signature 一起）。
 * 这是**契约测试**：守的不是我们的代码，是我们依赖的那条契约。
 *
 * signature 尤其要断言：Anthropic 靠它验签，丢了签名的思考块会被拒（400），
 * 那时表现同样不是报错，而是整条请求失败。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { streamText, tool } from 'ai'
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test'
import { z } from 'zod'
import type { LanguageModelV1StreamPart, LanguageModelV1Prompt } from '@ai-sdk/provider'

const USAGE = { promptTokens: 10, completionTokens: 20 }

/** 第一步：想一下，然后调工具 */
const STEP_1: LanguageModelV1StreamPart[] = [
  { type: 'reasoning', textDelta: '先查设计规范，' },
  { type: 'reasoning', textDelta: '不然字号只能瞎编。' },
  { type: 'reasoning-signature', signature: 'sig-step-1' },
  {
    type: 'tool-call',
    toolCallType: 'function',
    toolCallId: 'call-1',
    toolName: 'getDesignTokens',
    args: '{}',
  },
  { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
]

/** 第二步：拿到结果，**接着上一步想**，然后收尾 */
const STEP_2: LanguageModelV1StreamPart[] = [
  { type: 'reasoning', textDelta: '主色拿到了，按它排。' },
  { type: 'reasoning-signature', signature: 'sig-step-2' },
  { type: 'text-delta', textDelta: '规范拿到了，开始排版。' },
  { type: 'finish', finishReason: 'stop', usage: USAGE },
]

const prompts: LanguageModelV1Prompt[] = []

const makeModel = () => {
  let step = 0
  return new MockLanguageModelV1({
    doStream: async ({ prompt }) => {
      // 截下这一次真正发出去的 prompt
      prompts.push(JSON.parse(JSON.stringify(prompt)))
      step += 1
      return {
        stream: simulateReadableStream({ chunks: step === 1 ? STEP_1 : STEP_2 }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }
    },
  })
}

const run = async () => {
  const stream = streamText({
    model: makeModel(),
    system: '你是这个演示文稿编辑器的 agent。',
    messages: [{ role: 'user', content: '做一份 3 页的稿子' }],
    maxSteps: 5,
    tools: {
      getDesignTokens: tool({
        description: '拿当前主题的设计规范',
        parameters: z.object({}),
        execute: async () => ({ primary: '#0b6bcb', body: 16 }),
      }),
    },
  })
  // 必须读干，否则流不会被驱动 —— 和 pipeline.ts 里那段注释是同一个理由
  for await (const _ of stream.fullStream) { /* drain */ }
  return stream
}

/** 从一次 prompt 里挑出所有 assistant 的 reasoning 块 */
const reasoningIn = (prompt: LanguageModelV1Prompt) =>
  prompt
    .filter(m => m.role === 'assistant')
    .flatMap(m => m.content as { type: string, text?: string, signature?: string }[])
    .filter(p => p.type === 'reasoning')

describe('判据 9 · 第二步的请求里带着第一步的思考', () => {
  beforeEach(() => { prompts.length = 0 })

  it('确实跑了两步 —— 第一步调工具，第二步收尾', async () => {
    const stream = await run()
    expect(prompts).toHaveLength(2)
    expect(await stream.finishReason).toBe('stop')
  })

  it('第一步的请求里当然没有思考 —— 那时还没想过', async () => {
    await run()
    expect(reasoningIn(prompts[0])).toEqual([])
  })

  it('**第二步的请求里带着第一步的思考，signature 也在**', async () => {
    await run()
    expect(reasoningIn(prompts[1])).toEqual([
      { type: 'reasoning', text: '先查设计规范，不然字号只能瞎编。', signature: 'sig-step-1' },
    ])
  })

  it('思考块排在同一条 assistant 消息里、且在 tool-call 前面', async () => {
    await run()
    const assistant = prompts[1].find(m => m.role === 'assistant')!
    const kinds = (assistant.content as { type: string }[]).map(p => p.type)
    expect(kinds).toEqual(['reasoning', 'tool-call'])
  })

  it('工具结果也在，且和调用配得上对 —— 少一边下一次请求会 400', async () => {
    await run()
    const toolMsg = prompts[1].find(m => m.role === 'tool')!
    const results = toolMsg.content as { toolCallId: string, toolName: string }[]
    expect(results.map(r => [r.toolCallId, r.toolName])).toEqual([['call-1', 'getDesignTokens']])
  })

  it('两步的思考最终都在结果里 —— 落库拿的就是这份', async () => {
    const stream = await run()
    const details = (await stream.steps).flatMap(s => s.reasoningDetails)
    expect(details).toEqual([
      { type: 'text', text: '先查设计规范，不然字号只能瞎编。', signature: 'sig-step-1' },
      { type: 'text', text: '主色拿到了，按它排。', signature: 'sig-step-2' },
    ])
  })

  it('response.messages 就是我们落库的那份，reasoning 在里面', async () => {
    const stream = await run()
    const steps = await stream.steps
    const first = steps[0].response.messages[0]
    expect(first.role).toBe('assistant')
    expect(first.content).toContainEqual({
      type: 'reasoning',
      text: '先查设计规范，不然字号只能瞎编。',
      signature: 'sig-step-1',
    })
  })
})
