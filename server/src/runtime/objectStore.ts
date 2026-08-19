/**
 * 对象存储 —— 内容寻址地存图片资产
 *
 * 域无关：它只知道「给我一段字节，我给你一个公开可读的 URL」，
 * 不知道 deck、不知道幻灯片。
 *
 * ## 为什么是内容寻址
 *
 * key 用 `sha256(bytes)` 而不是随机 id：**同一张图永远只存一份**，
 * 重复生成 / 重复搜到同一张不会重复计费也不会重复占空间，
 * 而且 `asset://<sha256>` 这个约定前端早就实现了（`src/utils/assetUrl.ts`，R-10）。
 *
 * ## 签名为什么自己写
 *
 * 腾讯云 COS 用的是自家的签名 v5，不是 AWS SigV4，
 * 现成的 `cos-nodejs-sdk-v5` 会把一坨依赖拖进后端。
 * 算法本身只有二十行（HMAC-SHA1 两次），自己写反而看得清、测得了。
 *
 * ## 时钟为什么注入
 *
 * `buildAuthorization` 的输出**带时间戳**，不注入时钟就只能断言「它没抛错」。
 * 注入之后可以钉住一个已知输入 → 已知签名，签名算法被改坏时测试会红。
 * 这和 `boundary.test.ts` 把判定写成纯函数是同一个理由：**为了让判据做得成**。
 */

import crypto from 'node:crypto'

export interface CosCredentials {
  secretId: string
  secretKey: string
}

export interface CosLocation {
  bucket: string
  region: string
}

const sha1hex = (s: string) => crypto.createHash('sha1').update(s).digest('hex')
const hmacSha1hex = (key: string, s: string) => crypto.createHmac('sha1', key).update(s).digest('hex')

/**
 * COS 要求的 URL 编码：比 `encodeURIComponent` 更严，
 * `!'()*` 这几个字符它也要转义，不转会签名对不上。
 */
const cosEncode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/** 把 header / query 规范成签名要的「小写键、按键排序」两件产物 */
const normalize = (obj: Record<string, string>) => {
  const entries = Object.entries(obj)
    .map(([k, v]) => [k.toLowerCase(), v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    list: entries.map(([k]) => k).join(';'),
    str: entries.map(([k, v]) => `${cosEncode(k)}=${cosEncode(v)}`).join('&'),
  }
}

export interface SignInput {
  method: string
  pathname: string
  query?: Record<string, string>
  headers?: Record<string, string>
  credentials: CosCredentials
  /** 签名起始秒（Unix 秒）。注入而不是内部取 Date.now()，是为了测试能钉死输出 */
  nowSec: number
  /** 签名有效期，默认 1 小时 */
  ttlSec?: number
}

/**
 * 生成 COS 的 `Authorization` 头。
 *
 * 算法（腾讯云签名 v5）：
 *   SignKey      = HMAC-SHA1(SecretKey, KeyTime)
 *   HttpString   = method\npathname\nquery\nheaders\n
 *   StringToSign = "sha1\n" + KeyTime + "\n" + SHA1(HttpString) + "\n"
 *   Signature    = HMAC-SHA1(SignKey, StringToSign)
 */
export const buildAuthorization = (
  { method, pathname, query = {}, headers = {}, credentials, nowSec, ttlSec = 3600 }: SignInput,
): string => {
  const keyTime = `${nowSec - 60};${nowSec + ttlSec}` // 提前 60 秒，容忍机器间的时钟偏差
  const signKey = hmacSha1hex(credentials.secretKey, keyTime)

  const q = normalize(query)
  const h = normalize(headers)

  const httpString = `${method.toLowerCase()}\n${pathname}\n${q.str}\n${h.str}\n`
  const stringToSign = `sha1\n${keyTime}\n${sha1hex(httpString)}\n`
  const signature = hmacSha1hex(signKey, stringToSign)

  return [
    'q-sign-algorithm=sha1',
    `q-ak=${credentials.secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${h.list}`,
    `q-url-param-list=${q.list}`,
    `q-signature=${signature}`,
  ].join('&')
}

/** 桶的默认访问域名 */
export const cosEndpoint = ({ bucket, region }: CosLocation): string =>
  `https://${bucket}.cos.${region}.myqcloud.com`

/** 规范化前缀：去掉首斜杠、补尾斜杠；空前缀原样返回 */
export const normalizePrefix = (raw: string): string => {
  const p = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  return p ? `${p}/` : ''
}

/**
 * 对外访问的基地址。
 *
 * 填了 `publicBaseUrl`（挂 CDN / 自定义域名）就用它，否则用桶的默认域名。
 * 一律**不带**尾斜杠，拼接由调用方统一加，避免出现 `//`。
 */
export const resolvePublicBase = (
  { bucket, region, publicBaseUrl }: CosLocation & { publicBaseUrl?: string },
): string => {
  const custom = (publicBaseUrl ?? '').trim().replace(/\/+$/, '')
  return custom || cosEndpoint({ bucket, region })
}

/** 内容寻址的 key。扩展名只影响 Content-Type 观感，不参与寻址 */
export const contentKey = (bytes: Uint8Array, prefix: string, ext: string): string =>
  `${normalizePrefix(prefix)}${crypto.createHash('sha256').update(bytes).digest('hex')}${ext ? `.${ext.replace(/^\./, '')}` : ''}`

export interface StorageConfig extends CosCredentials, CosLocation {
  prefix: string
  publicBaseUrl?: string
}

export interface PutResult {
  key: string
  url: string
  /** 是否本来就在（内容寻址下重复上传是常态，不是错误） */
  existed: boolean
  bytes: number
}

export interface ObjectStore {
  put(bytes: Uint8Array, ext: string, contentType: string): Promise<PutResult>
  head(key: string): Promise<number>
  remove(key: string): Promise<number>
  urlFor(key: string): string
}

/**
 * 建一个 COS 客户端。
 *
 * `now` 可注入，同样是为了让签名可被钉死。
 */
export const createObjectStore = (
  config: StorageConfig,
  now: () => number = Date.now,
): ObjectStore => {
  const endpoint = cosEndpoint(config)
  const publicBase = resolvePublicBase(config)
  const credentials = { secretId: config.secretId, secretKey: config.secretKey }

  const request = (method: string, key: string, init: { headers?: Record<string, string>, body?: Uint8Array } = {}) => {
    const pathname = `/${key}`
    const headers = { Host: new URL(endpoint).host, ...(init.headers ?? {}) }
    const nowSec = Math.floor(now() / 1000)
    return fetch(`${endpoint}${pathname}`, {
      method,
      headers: {
        ...headers,
        Authorization: buildAuthorization({ method, pathname, headers, credentials, nowSec }),
      },
      body: init.body as BodyInit | undefined,
    })
  }

  return {
    urlFor: (key: string) => `${publicBase}/${key}`,

    async put(bytes, ext, contentType) {
      const key = contentKey(bytes, config.prefix, ext)

      // 内容寻址下同一张图会被反复请求上传 —— 先探一次，命中就不重传。
      // 省的不只是带宽，还有「同一张图重复计费」
      const existing = await request('HEAD', key)
      if (existing.status === 200) {
        return { key, url: `${publicBase}/${key}`, existed: true, bytes: bytes.byteLength }
      }

      const res = await request('PUT', key, { headers: { 'Content-Type': contentType }, body: bytes })
      if (res.status !== 200) {
        throw new Error(`对象存储上传失败 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`)
      }
      return { key, url: `${publicBase}/${key}`, existed: false, bytes: bytes.byteLength }
    },

    async head(key) {
      return (await request('HEAD', key)).status
    },

    async remove(key) {
      return (await request('DELETE', key)).status
    },
  }
}
