/**
 * 生图双请求形状的纯函数判据（R-62）
 *
 * flavor 路由 / 端点拼接 / seed 派生都是纯函数 —— 写错了不会有东西报错，
 * 只会在某一个中转上得到一串 404 或风格漂移，所以必须钉住。
 * 网络那半（请求体/响应解析）在端到端实测里验，这里不 mock fetch。
 */

import { describe, it, expect } from 'vitest'
import {
  resolveImageApiFlavor, openAiImagesEndpoint, googleImageEndpoint, hashSeed,
} from '../imageGenerate'

describe('resolveImageApiFlavor · 按模型名猜，显式配置优先', () => {
  it('auto 下 gpt-image 系 → openai', () => {
    expect(resolveImageApiFlavor('auto', 'gpt-image-2')).toBe('openai')
    expect(resolveImageApiFlavor('auto', 'gpt-image-1.5')).toBe('openai')
    expect(resolveImageApiFlavor('auto', 'gpt-image-1-mini')).toBe('openai')
    // 大小写不敏感，中转站别名常带前缀/大小写
    expect(resolveImageApiFlavor('auto', 'GPT-IMAGE-2')).toBe('openai')
  })

  it('auto 下其它模型名 → gemini（存量行为不变）', () => {
    expect(resolveImageApiFlavor('auto', 'gemini-3.1-flash-image')).toBe('gemini')
    expect(resolveImageApiFlavor('auto', 'imagen-4.0')).toBe('gemini')
    expect(resolveImageApiFlavor('auto', '')).toBe('gemini')
  })

  it('显式配置优先于模型名', () => {
    expect(resolveImageApiFlavor('openai', 'gemini-3.1-flash-image')).toBe('openai')
    expect(resolveImageApiFlavor('gemini', 'gpt-image-2')).toBe('gemini')
  })
})

describe('openAiImagesEndpoint · 与 googleImageEndpoint 同一条「不重复加版本」规则', () => {
  it('baseUrl 已以 /v1 结尾就不再补', () => {
    expect(openAiImagesEndpoint('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/images/generations')
    expect(openAiImagesEndpoint('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/images/generations')
  })

  it('baseUrl 没有版本段就补 /v1', () => {
    expect(openAiImagesEndpoint('https://relay.example.com')).toBe('https://relay.example.com/v1/images/generations')
    expect(openAiImagesEndpoint('https://relay.example.com/v')).toBe('https://relay.example.com/v/v1/images/generations')
  })

  it('gemini 端点行为保持不变（存量配置回归保护）', () => {
    expect(googleImageEndpoint('https://g.92.run/v', 'gemini-3.1-flash-image'))
      .toBe('https://g.92.run/v/v1beta/models/gemini-3.1-flash-image:generateContent')
    expect(googleImageEndpoint('https://g.92.run/v/v1beta', 'm'))
      .toBe('https://g.92.run/v/v1beta/models/m:generateContent')
  })
})

describe('hashSeed · 稳定、分散、正值', () => {
  it('同一组输入永远同一个 seed', () => {
    expect(hashSeed(['#fff', 'tech', 'ornament'])).toBe(hashSeed(['#fff', 'tech', 'ornament']))
  })

  it('不同层种 / 不同配色得不同 seed —— 同一份稿子里装饰与底图不该共用', () => {
    const base = ['#1F3A5F', 'precision technical blueprint']
    expect(hashSeed([...base, 'ornament'])).not.toBe(hashSeed([...base, 'backdrop']))
    expect(hashSeed([...base, 'ornament'])).not.toBe(hashSeed(['#000000', ...base.slice(1), 'ornament']))
  })

  it('非负且在 32 位内 —— 上游要求整数 seed', () => {
    for (let i = 0; i < 50; i++) {
      const s = hashSeed([`p${i}`, 'x', 'y'])
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThan(0x7fffffff)
    }
  })
})
