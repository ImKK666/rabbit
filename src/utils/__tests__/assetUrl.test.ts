import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseAssetUrl,
  resolveAssetUrl,
  isPendingAsset,
  isAssetUrl,
  toAssetUrl,
  toPendingAssetUrl,
  setAssetBaseUrl,
} from '../assetUrl'

beforeEach(() => {
  setAssetBaseUrl('/assets')
})

describe('isAssetUrl', () => {
  it('recognises asset:// prefix', () => {
    expect(isAssetUrl('asset://abc')).toBe(true)
  })
  it('rejects plain URLs', () => {
    expect(isAssetUrl('https://example.com/img.png')).toBe(false)
    expect(isAssetUrl('')).toBe(false)
  })
})

describe('parseAssetUrl', () => {
  const VALID_HASH = 'a'.repeat(64)

  it('parses valid sha256 hash', () => {
    const ref = parseAssetUrl(`asset://${VALID_HASH}`)
    expect(ref.kind).toBe('hash')
    if (ref.kind === 'hash') {
      expect(ref.hash).toBe(VALID_HASH)
      expect(ref.url).toBe(`/assets/${VALID_HASH}`)
    }
  })

  it('normalises uppercase hash to lowercase', () => {
    const upper = 'A'.repeat(64)
    const ref = parseAssetUrl(`asset://${upper}`)
    expect(ref.kind).toBe('hash')
    if (ref.kind === 'hash') {
      expect(ref.hash).toBe('a'.repeat(64))
    }
  })

  it('parses pending asset', () => {
    const ref = parseAssetUrl('asset://pending/task-123')
    expect(ref.kind).toBe('pending')
    if (ref.kind === 'pending') {
      expect(ref.taskId).toBe('task-123')
      expect(ref.url).toBe('')
    }
  })

  it('rejects pending with empty task id', () => {
    const ref = parseAssetUrl('asset://pending/')
    expect(ref.kind).toBe('invalid')
  })

  it('rejects pending with slash in task id', () => {
    const ref = parseAssetUrl('asset://pending/a/b')
    expect(ref.kind).toBe('invalid')
  })

  it('rejects short hash', () => {
    const ref = parseAssetUrl('asset://abcdef')
    expect(ref.kind).toBe('invalid')
  })

  it('passes through plain URLs', () => {
    const ref = parseAssetUrl('https://example.com/img.png')
    expect(ref.kind).toBe('plain')
    expect(ref.url).toBe('https://example.com/img.png')
  })

  it('passes through data URIs', () => {
    const ref = parseAssetUrl('data:image/png;base64,iVBOR...')
    expect(ref.kind).toBe('plain')
    expect(ref.url).toBe('data:image/png;base64,iVBOR...')
  })

  it('returns empty string for empty input', () => {
    const ref = parseAssetUrl('')
    expect(ref.kind).toBe('plain')
    expect(ref.url).toBe('')
  })

  it('respects custom base URL', () => {
    setAssetBaseUrl('https://cdn.example.com/v1/assets/')
    const hash = 'b'.repeat(64)
    const ref = parseAssetUrl(`asset://${hash}`)
    expect(ref.kind).toBe('hash')
    if (ref.kind === 'hash') {
      expect(ref.url).toBe(`https://cdn.example.com/v1/assets/${hash}`)
    }
  })
})

describe('resolveAssetUrl', () => {
  it('resolves hash to full URL', () => {
    const hash = 'c'.repeat(64)
    expect(resolveAssetUrl(`asset://${hash}`)).toBe(`/assets/${hash}`)
  })

  it('returns empty string for pending', () => {
    expect(resolveAssetUrl('asset://pending/xyz')).toBe('')
  })

  it('passes through plain URLs', () => {
    expect(resolveAssetUrl('https://example.com/x.jpg')).toBe('https://example.com/x.jpg')
  })
})

describe('isPendingAsset', () => {
  it('detects pending assets', () => {
    expect(isPendingAsset('asset://pending/abc')).toBe(true)
  })
  it('rejects non-pending', () => {
    expect(isPendingAsset(`asset://${'d'.repeat(64)}`)).toBe(false)
    expect(isPendingAsset('https://x.com/y.png')).toBe(false)
  })
})

describe('toAssetUrl / toPendingAssetUrl', () => {
  it('formats hash into asset URL', () => {
    expect(toAssetUrl('AABB' + '0'.repeat(60))).toBe('asset://' + 'aabb' + '0'.repeat(60))
  })
  it('formats task id into pending URL', () => {
    expect(toPendingAssetUrl('my-task')).toBe('asset://pending/my-task')
  })
})
