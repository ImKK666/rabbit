/**
 * R-68 · 带图的用户消息
 *
 * 图片走 `blocksJson`，和 assistant / tool 那两条一样。这里守三件事：
 *
 * 1. **老会话零影响** —— 没有 `blocksJson` 的用户行必须逐字节还是老样子。
 *    这条比带图本身更重要：`turnMemory` 是所有会话的公共路径，
 *    改坏了炸的不只是带图的那些。
 * 2. **字节内联，不给 URL** —— 给 URL 等于要求 provider 自己去下载，
 *    中转站往往取不到（实测 "Unable to download content from the provided
 *    URL before the timeout"）。
 * 3. **取不到的图丢掉，不炸整轮** —— 少一张图 ≪ 整轮请求失败。
 */

import { describe, it, expect } from 'vitest'
import {
  toModelMessages,
  serializeBlocks,
  type StoredRow,
  type UserBlock,
  type LoadedImage,
} from '../turnMemory'

const CFG = 7
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const bytesFor = (seed: number) => new Uint8Array([0xff, 0xd8, 0xff, seed])

/** 生产里的形状：预取好的字节表，同步查 */
const loadImage = (src: string): LoadedImage | undefined => {
  if (src === `asset://${HASH_A}`) return { bytes: bytesFor(1), mimeType: 'image/jpeg' }
  if (src === `asset://${HASH_B}`) return { bytes: bytesFor(2), mimeType: 'image/png' }
  return undefined
}

const userWithBlocks = (content: string, blocks: UserBlock[]): StoredRow => ({
  role: 'user',
  content,
  blocksJson: serializeBlocks(blocks),
})

const run = (
  rows: StoredRow[],
  load: ((src: string) => LoadedImage | undefined) = loadImage,
) => toModelMessages(rows, { modelConfigId: CFG, loadImage: load })

describe('带图的用户消息', () => {
  // 内联字节而不是 URL 是这一版的核心决定：provider 不需要有出网能力
  it('图片以字节内联，带上 mimeType', () => {
    const msgs = run([userWithBlocks('这张图里说了什么', [
      { type: 'text', text: '这张图里说了什么' },
      { type: 'image', src: `asset://${HASH_A}` },
    ])])

    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toEqual([
      { type: 'text', text: '这张图里说了什么' },
      { type: 'image', image: bytesFor(1), mimeType: 'image/jpeg' },
    ])
  })

  it('多张图按原顺序带过去', () => {
    const msgs = run([userWithBlocks('看这两张', [
      { type: 'text', text: '看这两张' },
      { type: 'image', src: `asset://${HASH_A}` },
      { type: 'image', src: `asset://${HASH_B}` },
    ])])

    const content = msgs[0].content as Array<{ type: string, mimeType?: string }>
    expect(content.map(p => p.type)).toEqual(['text', 'image', 'image'])
    expect(content[1].mimeType).toBe('image/jpeg')
    expect(content[2].mimeType).toBe('image/png')
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

  /**
   * 图片按固定权重记预算，**不按字节数**。
   *
   * 直接 JSON.stringify 一个 Uint8Array 会得到 `{"0":255,"1":216,…}` 这种
   * 逐字节展开，一张图几百万字符，预算瞬间爆掉、整份历史被丢光。
   */
  it('十轮带图仍在预算内，不会把历史挤掉', () => {
    const rows: StoredRow[] = []
    for (let i = 0; i < 10; i++) {
      rows.push(userWithBlocks(`第 ${i} 轮`, [
        { type: 'text', text: `第 ${i} 轮` },
        { type: 'image', src: `asset://${HASH_A}` },
      ]))
    }
    const msgs = toModelMessages(rows, { modelConfigId: CFG, charBudget: 20_000, loadImage })
    expect(msgs).toHaveLength(10)
  })

  it('预算很小时仍按整轮丢，不会丢半轮', () => {
    const rows: StoredRow[] = []
    for (let i = 0; i < 5; i++) {
      rows.push(userWithBlocks(`第 ${i} 轮`, [
        { type: 'image', src: `asset://${HASH_A}` },
      ]))
    }
    const msgs = toModelMessages(rows, { modelConfigId: CFG, charBudget: 1, loadImage })
    // 至少留最后一轮 + 一条交代被省略的提示
    expect(msgs.length).toBeLessThan(5)
    expect(msgs.every(m => m.role === 'user')).toBe(true)
  })
})

describe('取不到的图', () => {
  it('取不到就丢掉那张，文字留下', () => {
    const msgs = run([userWithBlocks('看这个', [
      { type: 'text', text: '看这个' },
      { type: 'image', src: 'asset://pending/task1' },
    ])])

    expect(msgs[0].content).toEqual([{ type: 'text', text: '看这个' }])
  })

  it('取到 0 字节等同取不到', () => {
    const msgs = run(
      [userWithBlocks('看这个', [
        { type: 'text', text: '看这个' },
        { type: 'image', src: `asset://${HASH_A}` },
      ])],
      () => ({ bytes: new Uint8Array(0) }),
    )

    expect(msgs[0].content).toEqual([{ type: 'text', text: '看这个' }])
  })

  // 没给 loadImage 时不能把引用原样塞给模型 —— 它不认识 asset://
  it('没给 loadImage 时丢图，退回 content 列的文本', () => {
    const msgs = toModelMessages(
      [userWithBlocks('只有一张图', [{ type: 'image', src: `asset://${HASH_A}` }])],
      { modelConfigId: CFG },
    )

    expect(msgs[0].content).toBe('只有一张图')
  })

  it('图全丢且没有文字块时退回 content 列', () => {
    const msgs = run(
      [userWithBlocks('[图片 1 张]', [{ type: 'image', src: `asset://${HASH_A}` }])],
      () => undefined,
    )

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

  it('不带图时给不给 loadImage 结果都一样', () => {
    const rows: StoredRow[] = [
      { role: 'user', content: '第一句' },
      { role: 'user', content: '第二句' },
    ]
    const withLoader = toModelMessages(rows, { modelConfigId: CFG, loadImage })
    const without = toModelMessages(rows, { modelConfigId: CFG })
    expect(JSON.stringify(withLoader)).toBe(JSON.stringify(without))
  })
})
