/**
 * R-38 · 思考过程的开关
 *
 * 这层最容易出的错是**静默**：参数拼错、provider 选错，模型照常回答，
 * 只是思考块永远不出现 —— 没有任何报错能提示你哪里断了。
 * 所以把每个 provider 该发什么参数逐条钉住。
 */

import { describe, it, expect } from 'vitest'
import {
  reasoningProviderOptions,
  needsReasoningTagExtraction,
  REASONING_TAG,
} from '../reasoning'

describe('providerOptions', () => {
  it('google 要显式请求带回思考内容 —— 它默认思考但不回传', () => {
    expect(reasoningProviderOptions('google', {})).toEqual({
      google: { thinkingConfig: { includeThoughts: true } },
    })
  })

  // deepseek 的 reasoning_content 是无条件回传的，provider 认得就够了。
  // 这里断言「不发参数」是为了防有人日后照着 google 抄一份多余的配置
  it('deepseek 不需要任何参数', () => {
    expect(reasoningProviderOptions('deepseek', {})).toEqual({})
  })

  it('openai 不发参数 —— o 系列的摘要要走 Responses API，兼容端点靠 <think> 标签', () => {
    expect(reasoningProviderOptions('openai', {})).toEqual({})
  })

  describe('anthropic 默认不开', () => {
    // extended thinking 会锁 temperature、要求 budgetTokens、老模型直接报错，
    // 还改变计费 —— 默认打开等于替用户做主
    it('没设环境变量时不发参数', () => {
      expect(reasoningProviderOptions('anthropic', {})).toEqual({})
    })

    it('设了预算才开', () => {
      expect(reasoningProviderOptions('anthropic', { AGENT_ANTHROPIC_THINKING_BUDGET: '4096' }))
        .toEqual({ anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } } })
    })

    // 1024 是 Anthropic 侧的下限，低于它请求会被拒 —— 与其让线上报错，不如当没开
    it.each(['0', '512', '1023', '-1', 'abc', ''])('低于下限或非法值 %s 视为没开', (raw) => {
      expect(reasoningProviderOptions('anthropic', { AGENT_ANTHROPIC_THINKING_BUDGET: raw }))
        .toEqual({})
    })

    it('小数向下取整', () => {
      expect(reasoningProviderOptions('anthropic', { AGENT_ANTHROPIC_THINKING_BUDGET: '2048.9' }))
        .toEqual({ anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } } })
    })
  })

  it('未知 provider 类型不发参数，也不抛错', () => {
    expect(reasoningProviderOptions('mistral', {})).toEqual({})
  })
})

describe('<think> 标签提取', () => {
  it('只给 openai 兼容端点挂 —— 纯文本解析，模型不吐标签就什么都不会发生', () => {
    expect(needsReasoningTagExtraction('openai')).toBe(true)
  })

  // deepseek 实测是 reasoning_content 字段、不带 <think>，挂了也没用；
  // 而且它走的是自己的 provider，思考在解析阶段就已经分离好了
  it.each(['deepseek', 'google', 'anthropic'])('%s 不需要', (type) => {
    expect(needsReasoningTagExtraction(type)).toBe(false)
  })

  it('标签名是 think', () => {
    expect(REASONING_TAG).toBe('think')
  })
})
