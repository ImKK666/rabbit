/**
 * 对象存储纯函数的判据
 *
 * 重点在签名：**签名错了的表现是 403，而 403 看起来跟「密钥填错了」一模一样** ——
 * 排查时人的第一反应永远是去查凭证，不会怀疑算法。所以它必须被钉住。
 *
 * 钉的方式不是「把当前实现的输出抄下来当期望」（那种测试改了实现就跟着改，
 * 不设防）。这里**照腾讯云签名 v5 的文字规范在测试里独立实现一遍**，
 * 两边比对 —— 和 `toolGroups.test.ts` 把配额独立抄一份是同一个道理。
 */

import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import {
  buildAuthorization, cosEndpoint, normalizePrefix, resolvePublicBase, contentKey,
} from '../objectStore'

const CRED = { secretId: 'AKIDTESTTESTTEST', secretKey: 'SECRETTESTTESTTEST' }
const NOW = 1_700_000_000

/** 照规范独立实现一遍，不看被测代码 */
const expectedSignature = (
  method: string, pathname: string,
  query: Record<string, string>, headers: Record<string, string>,
  nowSec: number, ttl = 3600,
) => {
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  const pack = (o: Record<string, string>) => {
    const ks = Object.keys(o).map(k => k.toLowerCase()).sort()
    return {
      list: ks.join(';'),
      str: ks.map((k) => {
        const orig = Object.keys(o).find(x => x.toLowerCase() === k)!
        return `${enc(k)}=${enc(o[orig])}`
      }).join('&'),
    }
  }
  const keyTime = `${nowSec - 60};${nowSec + ttl}`
  const signKey = crypto.createHmac('sha1', CRED.secretKey).update(keyTime).digest('hex')
  const q = pack(query), h = pack(headers)
  const httpString = `${method.toLowerCase()}\n${pathname}\n${q.str}\n${h.str}\n`
  const sts = `sha1\n${keyTime}\n${crypto.createHash('sha1').update(httpString).digest('hex')}\n`
  return {
    signature: crypto.createHmac('sha1', signKey).update(sts).digest('hex'),
    keyTime, headerList: h.list, urlParamList: q.list,
  }
}

const parse = (auth: string) => Object.fromEntries(auth.split('&').map(kv => {
  const i = kv.indexOf('=')
  return [kv.slice(0, i), kv.slice(i + 1)]
}))

describe('COS 签名', () => {
  it('与独立实现的规范逐字段一致', () => {
    const headers = { Host: 'b-1.cos.ap-guangzhou.myqcloud.com', 'Content-Type': 'image/png' }
    const auth = buildAuthorization({
      method: 'PUT', pathname: '/rabbit/abc.png', headers, credentials: CRED, nowSec: NOW,
    })
    const got = parse(auth)
    const want = expectedSignature('PUT', '/rabbit/abc.png', {}, headers, NOW)

    expect(got['q-signature']).toBe(want.signature)
    expect(got['q-sign-time']).toBe(want.keyTime)
    expect(got['q-key-time']).toBe(want.keyTime)
    expect(got['q-header-list']).toBe(want.headerList)
    expect(got['q-ak']).toBe(CRED.secretId)
    expect(got['q-sign-algorithm']).toBe('sha1')
  })

  it('带 query 参数时也一致（?cors= 这类空值参数是真实用法）', () => {
    const query = { cors: '' }
    const headers = { Host: 'b-1.cos.ap-guangzhou.myqcloud.com' }
    const auth = buildAuthorization({
      method: 'PUT', pathname: '/', query, headers, credentials: CRED, nowSec: NOW,
    })
    const want = expectedSignature('PUT', '/', query, headers, NOW)
    expect(parse(auth)['q-signature']).toBe(want.signature)
    expect(parse(auth)['q-url-param-list']).toBe('cors')
  })

  it('header 按小写键排序，不受传入顺序影响', () => {
    const a = buildAuthorization({ method: 'GET', pathname: '/x', credentials: CRED, nowSec: NOW, headers: { Host: 'h', 'Content-Type': 'text/plain' } })
    const b = buildAuthorization({ method: 'GET', pathname: '/x', credentials: CRED, nowSec: NOW, headers: { 'Content-Type': 'text/plain', Host: 'h' } })
    expect(a).toBe(b)
    expect(parse(a)['q-header-list']).toBe('content-type;host')
  })

  it('时钟注入 → 同样输入必得同样签名', () => {
    const mk = () => buildAuthorization({ method: 'GET', pathname: '/x', credentials: CRED, nowSec: NOW })
    expect(mk()).toBe(mk())
  })

  it('签名起点提前 60 秒 —— 容忍机器间时钟偏差', () => {
    const got = parse(buildAuthorization({ method: 'GET', pathname: '/x', credentials: CRED, nowSec: NOW }))
    expect(got['q-sign-time']).toBe(`${NOW - 60};${NOW + 3600}`)
  })
})

describe('签名对每一个输入都敏感（负对照）', () => {
  const base: Record<string, unknown> = {
    method: 'PUT', pathname: '/rabbit/a.png', credentials: CRED, nowSec: NOW, headers: { Host: 'h' },
  }
  const sig = (o: Record<string, unknown> = {}) =>
    parse(buildAuthorization({ ...base, ...o } as never))['q-signature']

  const ref = sig()

  it('换 secretKey → 签名变', () => {
    expect(sig({ credentials: { ...CRED, secretKey: 'OTHER' } })).not.toBe(ref)
  })
  it('换 method → 签名变', () => {
    expect(sig({ method: 'GET' })).not.toBe(ref)
  })
  it('换路径 → 签名变', () => {
    expect(sig({ pathname: '/rabbit/b.png' })).not.toBe(ref)
  })
  it('换时间 → 签名变', () => {
    expect(sig({ nowSec: NOW + 1 })).not.toBe(ref)
  })
  it('加一个 header → 签名变', () => {
    expect(sig({ headers: { Host: 'h', 'x-cos-acl': 'public-read' } })).not.toBe(ref)
  })
})

describe('内容寻址', () => {
  it('同样字节 → 同样 key（重复上传只存一份的前提）', () => {
    const a = new TextEncoder().encode('same bytes')
    const b = new TextEncoder().encode('same bytes')
    expect(contentKey(a, 'rabbit/', 'png')).toBe(contentKey(b, 'rabbit/', 'png'))
  })

  it('不同字节 → 不同 key', () => {
    expect(contentKey(new TextEncoder().encode('a'), 'rabbit/', 'png'))
      .not.toBe(contentKey(new TextEncoder().encode('b'), 'rabbit/', 'png'))
  })

  it('key 就是 sha256，扩展名只是后缀', () => {
    const bytes = new TextEncoder().encode('x')
    const sha = crypto.createHash('sha256').update(bytes).digest('hex')
    expect(contentKey(bytes, 'rabbit/', 'png')).toBe(`rabbit/${sha}.png`)
    expect(contentKey(bytes, '', '')).toBe(sha)
  })

  it('扩展名带不带点都一样', () => {
    const bytes = new TextEncoder().encode('x')
    expect(contentKey(bytes, '', '.png')).toBe(contentKey(bytes, '', 'png'))
  })
})

describe('前缀与基地址', () => {
  it('前缀规范化：补尾斜杠、去首斜杠', () => {
    expect(normalizePrefix('rabbit')).toBe('rabbit/')
    expect(normalizePrefix('/rabbit/')).toBe('rabbit/')
    expect(normalizePrefix('a/b')).toBe('a/b/')
  })

  it('空前缀就是空 —— 不能变成一个孤零零的斜杠', () => {
    // 返回 '/' 的话 key 会变成 `/abc.png`，请求路径出现 `//`
    expect(normalizePrefix('')).toBe('')
    expect(normalizePrefix('   ')).toBe('')
    expect(normalizePrefix('/')).toBe('')
  })

  it('默认域名按 bucket + region 拼', () => {
    expect(cosEndpoint({ bucket: 'rabbit-1307074209', region: 'ap-guangzhou' }))
      .toBe('https://rabbit-1307074209.cos.ap-guangzhou.myqcloud.com')
  })

  it('填了 publicBaseUrl 就用它（挂 CDN / 自定义域名）', () => {
    expect(resolvePublicBase({ bucket: 'b', region: 'r', publicBaseUrl: 'https://cdn.example.com/' }))
      .toBe('https://cdn.example.com')
  })

  it('publicBaseUrl 为空 / 全空白时退回默认域名', () => {
    expect(resolvePublicBase({ bucket: 'b', region: 'r', publicBaseUrl: '' })).toBe('https://b.cos.r.myqcloud.com')
    expect(resolvePublicBase({ bucket: 'b', region: 'r', publicBaseUrl: '   ' })).toBe('https://b.cos.r.myqcloud.com')
    expect(resolvePublicBase({ bucket: 'b', region: 'r' })).toBe('https://b.cos.r.myqcloud.com')
  })

  it('基地址一律不带尾斜杠 —— 拼接方统一加，避免出现 //', () => {
    expect(resolvePublicBase({ bucket: 'b', region: 'r', publicBaseUrl: 'https://x.com///' })).toBe('https://x.com')
  })
})
