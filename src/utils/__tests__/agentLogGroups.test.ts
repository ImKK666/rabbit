/**
 * agent 面板「思考过程」分组的判据
 *
 * 这条规则坏掉时**不会报任何错**，只会表现成「面板看起来怪怪的」——
 * 组头出现在不该出现的地方、收起时藏掉了本该看见的回答、
 * 或者一次任务被切成十几个组。那种东西必须有判据守着。
 */

import { describe, it, expect } from 'vitest'
import { groupStartOf, groupStats, summarizeGroup, type GroupableEntry } from '@/utils/agentLogGroups'

const think = (content: string): GroupableEntry => ({ type: 'reasoning', content })
const tool = (): GroupableEntry => ({ type: 'tool' })
const asset = (): GroupableEntry => ({ type: 'asset' })
const say = (): GroupableEntry => ({ type: 'text' })
const status = (): GroupableEntry => ({ type: 'status' })

/** 一次典型任务：用户说话 → 想 → 调工具 → 想 → 调工具 → 回答 → 完成 */
const typical: GroupableEntry[] = [
  say(), think('先查规范'), tool(), think('拿到了，排版'), tool(), say(), status(),
]

describe('分组', () => {
  it('连续的 reasoning / tool / asset 收成一组，text / status 留在组外', () => {
    expect(groupStartOf(typical)).toEqual([-1, 1, 1, 1, 1, -1, -1])
  })

  it('组 id 就是组的起始下标 —— 组头只在 start === i 时渲染一行', () => {
    const starts = groupStartOf(typical)
    expect(starts.filter((s, i) => s === i)).toEqual([1])
  })

  it('中途说一句话会把过程切成两组 —— 每组正好是「下一句话背后的思考」', () => {
    const log = [say(), think('a'), tool(), say(), think('b'), tool(), say()]
    expect(groupStartOf(log)).toEqual([-1, 1, 1, -1, 4, 4, -1])
  })

  it('asset 也算过程 —— 取图那 15 秒的进度条不该单独漂在外面', () => {
    expect(groupStartOf([say(), asset(), asset(), say()])).toEqual([-1, 1, 1, -1])
  })

  it('全是过程时就一组', () => {
    expect(groupStartOf([think('a'), tool(), think('b')])).toEqual([0, 0, 0])
  })

  it('一条过程都没有时一个组也没有', () => {
    expect(groupStartOf([say(), status(), say()])).toEqual([-1, -1, -1])
  })

  it('空日志不炸', () => {
    expect(groupStartOf([])).toEqual([])
    expect(groupStats([]).size).toBe(0)
  })
})

describe('统计', () => {
  it('按组累加，字数只算思考', () => {
    const stats = groupStats(typical)
    expect(stats.size).toBe(1)
    expect(stats.get(1)).toEqual({ chars: '先查规范'.length + '拿到了，排版'.length, tools: 2, assets: 0, end: 4 })
  })

  it('end 指向组内最后一条 —— 判断「这组还在长吗」靠它', () => {
    const log = [say(), think('a'), tool(), say()]
    expect(groupStats(log).get(1)?.end).toBe(2)
  })

  it('两组各算各的', () => {
    const log = [think('aa'), say(), think('bbbb'), tool()]
    const stats = groupStats(log)
    expect(stats.get(0)).toMatchObject({ chars: 2, tools: 0 })
    expect(stats.get(2)).toMatchObject({ chars: 4, tools: 1 })
  })

  it('没有 content 的 reasoning 算 0 字，不抛', () => {
    expect(groupStats([{ type: 'reasoning' }]).get(0)?.chars).toBe(0)
  })
})

describe('摘要', () => {
  it('只报发生过的那几项', () => {
    expect(summarizeGroup({ chars: 320, tools: 3, assets: 0, end: 5 }))
      .toBe('思考 320 字 · 调用 3 个工具')
  })

  it('纯思考不显示「调用 0 个工具」—— 那种措辞会让人以为出了问题', () => {
    expect(summarizeGroup({ chars: 88, tools: 0, assets: 0, end: 1 })).toBe('思考 88 字')
  })

  it('取图也报', () => {
    expect(summarizeGroup({ chars: 10, tools: 2, assets: 4, end: 9 }))
      .toBe('思考 10 字 · 调用 2 个工具 · 取图 4 张')
  })

  it('全是 0 时退回一个字都不带数字的兜底', () => {
    expect(summarizeGroup({ chars: 0, tools: 0, assets: 0, end: 0 })).toBe('思考')
    expect(summarizeGroup(undefined)).toBe('思考')
  })
})
