/**
 * baseURL 规范化单测
 *
 * 起因是 04-changes.md 待确认里那条「Reviewer 调用 LLM 报 Not Found」——
 * 这类 404 绝大多数是 baseUrl 少了/多了版本段。
 */

import { describe, it, expect } from 'vitest'
import { normalizeBaseUrl } from '../baseUrl'

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
