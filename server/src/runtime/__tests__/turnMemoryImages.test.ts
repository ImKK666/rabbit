/**
 * R-68 · 带图的用户消息
 *
 * 图片走 `blocksJson`，和 assistant / tool 那两条一样。这里守两件事：
 *
 * 1. **老会话零影响** —— 没有 `blocksJson` 的用户行必须逐字节还是老样子。
 *    这条比带图本身更重要：`turnMemory` 是所有会话的公共路径，
 *    改坏了炸的不只是带图的那些。
 * 2. **坏引用不能炸整轮** —— 解析不出来的图丢掉，宁可少一张图，
 *    也不能塞个坏 URL 让整轮请求 4xx。
 */

import { describe, it, expect } from 'vitest'
import {
  toModelMessages,
  serializeBlocks,
  type StoredRow,
  type UserBlock,
} from '../turnMemory'

const CFG = 7
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const BASE = 'https://bucket.example.com/rabbit'

/** 和生产一致：`asset://<hash>` → `{base}/{hash}`，其余原样透传 */
const resolveAssetUrl = (src: string): string =>
  src.startsWith('asset://') ? `${BASE}/${src.slice(8)}` : src

const userWithBlocks = (content: string, blocks: UserBlock[]): StoredRow => ({
  role: 'user',
  content,
  blocksJson: serializeBlocks(blocks),
})

const run = (rows: StoredRow[], resolve: ((src: string) => string) | undefined = resolveAssetUrl) =>
  toModelMessages(rows, { modelConfigId: CFG, resolveAssetUrl: resolve })

describe('带图的用户消息', () => {
  it('图片解析成真实 URL 交给模型', () => {
    const msgs = run([userWithBlocks('这张图里说了什么', [
      { type: 'text', text: '这张图里说了什么' },
      { type: 'image', src: `asset://${HASH_A}` },
    ])])

    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    const content = msgs[0].content
    expect(Array.isArray(content)).toBe(true)
    expect(content).toEqual([
      { type: 'text', text: '这张图里说了什么' },
      { type: 'image', image: new URL(`${BASE}/${HASH_A}`) },
    ])
  })

  it('多张图按原顺序带过去', () => {
    const msgs = run([userWithBlocks('看这两张', [
      { type: 'text', text: '看这两张' },
      { type: 'image', src: `asset://${HASH_A}` },
      { type: 'image', src: `asset://${HASH_B}` },
    ])])

    const content = msgs[0].content as Array<{ type: string, image?: URL }>
    expect(content.map(p => p.type)).toEqual(['text', 'image', 'image'])
    expect(content[1].image?.href).toContain(HASH_A)
    expect(content[2].image?.href).toContain(HASH_B)
  })

  // 只发图不打字是合理用法，不该退化成「一条空消息」
  it('只有图没有文字时仍是数组', () => {
    const msgs = run([userWithBlocks('[图片 1 张]', [
      { type: 'image', src: `asset://${HASH_A}` },
    ])])

    const content = msgs[0].content as Array<{ type: string }>
    expect(Array.isArray(content)).toBe(true)
    expect(content.map(p => p.type)).toEqual(['image'])
  })

  // 存 asset:// 而不是 base64 的收益就在这里：一张图只占一行字的预算
  it('图片按 URL 长度记预算，不会把历史挤掉', () => {
    const rows: StoredRow[] = []
    for (let i = 0; i < 10; i++) {
      rows.push(userWithBlocks(`第 ${i} 轮`, [
        { type: 'text', text: `第 ${i} 轮` },
        { type: 'image', src: `asset://${HASH_A}` },
      ]))
    }
    // 十轮带图仍在 5000 字符预算内 —— 换成 base64 早就爆了
    const msgs = toModelMessages(rows, { modelConfigId: CFG, charBudget: 5000, resolveAssetUrl })
    expect(msgs).toHaveLength(10)
  })
})

describe('坏引用与降级', () => {
  it('解析不出的图丢掉，文字留下', () => {
    const msgs = run([userWithBlocks('看这个', [
      { type: 'text', text: '看这个' },
      { type: 'image', src: 'asset://pending/task1' },
    ])], () => '')

    expect(msgs[0].content).toEqual([{ type: 'text', text: '看这个' }])
  })

  it('resolver 给出非法 URL 时丢掉那张，不抛', () => {
    const msgs = run([userWithBlocks('看这个', [
      { type: 'text', text: '看这个' },
      { type: 'image', src: `asset://${HASH_A}` },
    ])], () => 'not a url')

    expect(msgs[0].content).toEqual([{ type: 'text', text: '看这个' }])
  })

  // 没给 resolver 时不能把 asset:// 原样塞给模型 —— 它取不到，只会让请求失败。
  // **直接调 toModelMessages**：`run` 的默认参数对显式 undefined 同样生效，
  // 走它的话这条断言根本测不到「没给 resolver」
  it('没给 resolver 时丢图，退回 content 列的文本', () => {
    const msgs = toModelMessages(
      [userWithBlocks('只有一张图', [{ type: 'image', src: `asset://${HASH_A}` }])],
      { modelConfigId: CFG },
    )

    expect(msgs[0].content).toBe('只有一张图')
  })

  it('图全丢且没有文字块时退回 content 列', () => {
    const msgs = run([userWithBlocks('[图片 1 张]', [
      { type: 'image', src: `asset://${HASH_A}` },
    ])], () => '')

    expect(msgs[0].content).toBe('[图片 1 张]')
  })

  it('blocksJson 是脏数据时退回纯文本路径', () => {
    const msgs = run([{ role: 'user', content: '正常文字', blocksJson: '{不是 JSON' }])
    expect(msgs[0].content).toBe('正常文字')
  })
})

describe('老会话零影响', () => {
  // 这条是整个改动的安全网：没有 blocksJson 的用户行必须还是老样子
  it('没有 blocksJson 的用户行仍然是纯字符串', () => {
    const msgs = run([{ role: 'user', content: '做一份海洋主题的 PPT' }])
    expect(msgs).toEqual([{ role: 'user', content: '做一份海洋主题的 PPT' }])
  })

  it('不带图时给不给 resolver 结果都一样', () => {
    const rows: StoredRow[] = [
      { role: 'user', content: '第一句' },
      { role: 'user', content: '第二句' },
    ]
    const withResolver = toModelMessages(rows, { modelConfigId: CFG, resolveAssetUrl })
    const without = toModelMessages(rows, { modelConfigId: CFG })
    expect(JSON.stringify(withResolver)).toBe(JSON.stringify(without))
  })
})
