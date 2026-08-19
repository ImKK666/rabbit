import { describe, it, expect } from 'vitest'
import {
  CACHE_TTL_MS, normalizeQuery, searchCacheKey, isFresh, readCache,
} from '../searchCache'
import type { ImageCandidate } from '../imageSearch'

const BASE = { provider: 'pixabay' as const, query: 'city skyline', lang: 'en', limit: 6 }

const candidate = (url: string): ImageCandidate => ({ url, width: 1280, height: 853 })

describe('normalizeQuery', () => {
  it('大小写不产生两条缓存', () => {
    expect(normalizeQuery('Business Team')).toBe(normalizeQuery('business team'))
  })

  it('首尾空格与词间多余空白都折叠', () => {
    expect(normalizeQuery('  city   skyline  ')).toBe('city skyline')
  })

  it('中文原样保留（toLowerCase 对它是空操作）', () => {
    expect(normalizeQuery(' 数据中心 ')).toBe('数据中心')
  })
})

describe('searchCacheKey · 四个维度都必须进键', () => {
  it('同样的输入给同样的键', () => {
    expect(searchCacheKey(BASE)).toBe(searchCacheKey({ ...BASE }))
  })

  it('大小写/空白不同但语义相同 → 同一个键', () => {
    expect(searchCacheKey({ ...BASE, query: '  City   Skyline ' })).toBe(searchCacheKey(BASE))
  })

  it.each([
    ['provider', { provider: 'unsplash' as const }],
    ['query', { query: 'data center' }],
    ['lang', { lang: 'zh' }],
    ['limit', { limit: 12 }],
  ])('换 %s 就换一个键 —— 少一个维度会让缓存串台', (_label, patch) => {
    expect(searchCacheKey({ ...BASE, ...patch })).not.toBe(searchCacheKey(BASE))
  })

  it('是 64 位十六进制（sha256）', () => {
    expect(searchCacheKey(BASE)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('isFresh · 24 小时边界', () => {
  it('TTL 就是 24 小时', () => {
    expect(CACHE_TTL_MS).toBe(86_400_000)
  })

  it('刚写入的是新鲜的', () => {
    expect(isFresh(1000, 1000)).toBe(true)
  })

  it('差一毫秒到 24 小时仍新鲜', () => {
    expect(isFresh(0, CACHE_TTL_MS - 1)).toBe(true)
  })

  it('整整 24 小时那一刻就算过期 —— 宁可多发一次请求，不多用一秒', () => {
    expect(isFresh(0, CACHE_TTL_MS)).toBe(false)
  })

  it('超过 24 小时过期', () => {
    expect(isFresh(0, CACHE_TTL_MS + 1)).toBe(false)
  })

  it('时钟回拨（age 为负）算新鲜，不平白多打一次图库', () => {
    expect(isFresh(10_000, 5000)).toBe(true)
  })
})

describe('readCache', () => {
  const entry = { candidates: [candidate('https://pixabay.com/a.jpg')], fetchedAtMs: 0 }

  it('没有条目返回 null', () => {
    expect(readCache(null, 0)).toBeNull()
    expect(readCache(undefined, 0)).toBeNull()
  })

  it('新鲜的条目原样返回候选', () => {
    expect(readCache(entry, 1000)).toEqual(entry.candidates)
  })

  it('过期的条目返回 null', () => {
    expect(readCache(entry, CACHE_TTL_MS)).toBeNull()
  })

  it('空候选列表也是有效缓存 —— 「确实搜不到」是个答案，不该每次再问一遍', () => {
    expect(readCache({ candidates: [], fetchedAtMs: 0 }, 1000)).toEqual([])
  })
})
