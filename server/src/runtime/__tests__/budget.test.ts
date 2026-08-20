/**
 * R-37 · 步数预算解析
 *
 * 这层唯一的风险是**打错的环境变量静默生效**：
 * `AGENT_MAX_STEPS=0` 让 agent 一步都跑不了、`AGENT_MAX_STEPS=abc` 让它 NaN，
 * 两种都不会报错，只会表现成「agent 突然什么都不做了」。
 * 所以非法值一律回退到默认，并在这里钉死。
 */

import { describe, it, expect } from 'vitest'
import { resolveMaxSteps, DEFAULT_ROLE_MAX_STEPS } from '../budget'

describe('默认值', () => {
  it('每个 agent 都有默认上限', () => {
    expect(Object.keys(DEFAULT_ROLE_MAX_STEPS).sort()).toEqual(['deck'])
  })

  it('没有环境变量时用默认', () => {
    expect(resolveMaxSteps('deck', {})).toBe(DEFAULT_ROLE_MAX_STEPS.deck)
  })

  // 旧上限 60 实测只做出 10 页。数量级本身要有余量，
  // 否则又会退回「实测不够就抬一点」的循环
  it('默认远高于旧的 60', () => {
    expect(DEFAULT_ROLE_MAX_STEPS.deck).toBeGreaterThanOrEqual(256)
  })
})

describe('环境变量覆盖', () => {
  it('AGENT_MAX_STEPS 管住所有 agent', () => {
    expect(resolveMaxSteps('deck', { AGENT_MAX_STEPS: '60' })).toBe(60)
  })

  it('单 agent 覆盖优先于全局', () => {
    const env = { AGENT_MAX_STEPS: '60', AGENT_MAX_STEPS_DECK: '200' }
    expect(resolveMaxSteps('deck', env)).toBe(200)
  })

  it('小数向下取整', () => {
    expect(resolveMaxSteps('deck', { AGENT_MAX_STEPS: '2.7' })).toBe(2)
  })

  it.each([
    ['0', '零步等于 agent 什么都不做'],
    ['-1', '负数'],
    ['abc', '非数字'],
    ['', '空串'],
    ['   ', '只有空白'],
    ['Infinity', '无穷 —— SDK 拿到会一直转'],
    ['NaN', 'NaN'],
  ])('非法值 %s 回退到默认（%s）', (raw) => {
    expect(resolveMaxSteps('deck', { AGENT_MAX_STEPS: raw }))
      .toBe(DEFAULT_ROLE_MAX_STEPS.deck)
  })

  it('单 agent 值非法时退到全局，而不是直接退到默认', () => {
    const env = { AGENT_MAX_STEPS: '80', AGENT_MAX_STEPS_DECK: 'oops' }
    expect(resolveMaxSteps('deck', env)).toBe(80)
  })
})
