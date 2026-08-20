/**
 * baseURL 规范化单测
 *
 * 起因是 04-changes.md 待确认里那条「Reviewer 调用 LLM 报 Not Found」——
 * 这类 404 绝大多数是 baseUrl 少了/多了版本段。
 */

import { describe, it, expect } from 'vitest'
import { normalizeBaseUrl } from '../baseUrl'
import { googleImageEndpoint } from '../imageGenerate'

describe('normalizeBaseUrl · openai（SDK 会拼 /chat/completions）', () => {
  it('裸域名补上 /v1', () => {
    expect(normalizeBaseUrl('openai', 'https://api.deepseek.com')).toBe('https://api.deepseek.com/v1')
  })

  it('已经有 /v1 的不动', () => {
    expect(normalizeBaseUrl('openai', 'https://api.openai.com/v1')).toBe('https://api.openai.com/v1')
  })

  it('尾部斜杠去掉', () => {
    expect(normalizeBaseUrl('openai', 'https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
  })

  it('误填完整端点会被剥掉', () => {
    expect(normalizeBaseUrl('openai', 'https://api.openai.com/v1/chat/completions'))
      .toBe('https://api.openai.com/v1')
  })

  it('非标准版本路径一律不碰 —— 宁可不修也不能改坏能用的配置', () => {
    expect(normalizeBaseUrl('openai', 'https://open.bigmodel.cn/api/paas/v4'))
      .toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(normalizeBaseUrl('openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1'))
      .toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
  })

  it('带端口的本地地址也能补', () => {
    expect(normalizeBaseUrl('openai', 'http://localhost:11434')).toBe('http://localhost:11434/v1')
  })
})

describe('normalizeBaseUrl · anthropic（SDK 会拼 /v1/messages）', () => {
  it('裸域名保持原样', () => {
    expect(normalizeBaseUrl('anthropic', 'https://api.anthropic.com')).toBe('https://api.anthropic.com')
  })

  it('用户多填的 /v1 要去掉，否则变成 /v1/v1/messages', () => {
    expect(normalizeBaseUrl('anthropic', 'https://api.anthropic.com/v1')).toBe('https://api.anthropic.com')
  })

  it('误填完整端点会被剥掉', () => {
    expect(normalizeBaseUrl('anthropic', 'https://api.anthropic.com/v1/messages'))
      .toBe('https://api.anthropic.com')
  })

  it('代理站的自定义路径不动', () => {
    expect(normalizeBaseUrl('anthropic', 'https://proxy.example.com/anthropic'))
      .toBe('https://proxy.example.com/anthropic')
  })
})

describe('normalizeBaseUrl · google（SDK 会拼 /models/xxx）', () => {
  it('裸域名补上 /v1beta', () => {
    expect(normalizeBaseUrl('google', 'https://generativelanguage.googleapis.com'))
      .toBe('https://generativelanguage.googleapis.com/v1beta')
  })

  it('已有版本段不动', () => {
    expect(normalizeBaseUrl('google', 'https://generativelanguage.googleapis.com/v1beta'))
      .toBe('https://generativelanguage.googleapis.com/v1beta')
  })

  /**
   * R-52 实测撞出来的 bug，**它一直在，只是没人撞到**。
   *
   * 库里配的中转是 `https://g.92.run/v` —— 路径非空，上一版按
   * 「已有路径的一律不动」原样交给 SDK，于是它 POST 到
   * `…/v/models/gemini-3.7-flash:generateContent`，少了 `/v1beta`，**每次都 404**。
   *
   * 没被发现是因为：deck agent 配的是 deepseek，而生图那条路
   * **没走 SDK**（`imageGenerate.googleImageEndpoint` 自己拼 URL，规则正好是对的）。
   * 直到把一个 google 模型配成 agent 角色才暴露。
   *
   * 两处对同一件事有两套判断，迟早会像这次一样一边能用一边 404。
   */
  it('**路径非空但没有版本段的中转，也要补 /v1beta**', () => {
    expect(normalizeBaseUrl('google', 'https://g.92.run/v'))
      .toBe('https://g.92.run/v/v1beta')
  })

  it('中转已经带了 /v1beta 就不再加', () => {
    expect(normalizeBaseUrl('google', 'https://g.92.run/v/v1beta'))
      .toBe('https://g.92.run/v/v1beta')
  })

  it('已有别的版本段（/v1）也不动 —— 不猜别人的版本', () => {
    expect(normalizeBaseUrl('google', 'https://proxy.example.com/v1'))
      .toBe('https://proxy.example.com/v1')
  })

  it('和 googleImageEndpoint 用同一条规则 —— 两处不许有两套判断', () => {
    // 这条是把「规则一致」本身变成判据。不一致的表现就是这次撞到的：
    // 生图那条路能用、agent 那条路 404，而两边看着都「配得对」
    for (const raw of [
      'https://g.92.run/v',
      'https://g.92.run/v/v1beta',
      'https://generativelanguage.googleapis.com',
    ]) {
      expect(`${normalizeBaseUrl('google', raw)}/models/m:generateContent`)
        .toBe(googleImageEndpoint(raw, 'm'))
    }
  })
})

describe('normalizeBaseUrl · 边界', () => {
  it('空串原样返回', () => {
    expect(normalizeBaseUrl('openai', '')).toBe('')
    expect(normalizeBaseUrl('openai', '   ')).toBe('')
  })

  it('非法 URL 原样返回，交给 SDK 自己报错', () => {
    expect(normalizeBaseUrl('openai', 'not a url')).toBe('not a url')
  })

  it('未知 provider 类型只做清理，不加版本段', () => {
    expect(normalizeBaseUrl('mystery', 'https://x.com/')).toBe('https://x.com')
  })
})
