/**
 * 资产库的对外信息 —— 目前只有一条：图片从哪个地址取
 *
 * ## 为什么需要这条路由
 *
 * deck 里存的是 `asset://<sha256>`（决策 E），前端 `utils/assetUrl.ts`
 * 把它解析成 `{assetBaseUrl}/{hash}`。而 `assetBaseUrl` 的默认值是 `/assets`，
 * **必然 404** —— `setAssetBaseUrl()` 那个 setter 从 R-10 建好之后
 * 全项目零调用，`assetUrl.ts:59` 的 `TODO(R-01)` 一直没兑现。
 *
 * 前端不能自己算这个地址：它由管理员配的桶 / 地域 / 自定义域名 / key 前缀
 * 拼出来，全在库里。所以启动时问后端一次。
 *
 * ## 为什么值得多一次往返，而不是把 URL 直接写进 deck
 *
 * 换桶、挂 CDN、迁到别家对象存储时，**改这一处配置，所有旧 deck 跟着走**。
 * 把 `https://…/rabbit/<hash>` 写进 deck 的话，那天所有历史文稿里的图会一起失效。
 *
 * ## R-68 起这里还负责上传
 *
 * 对话框粘贴/上传的图片走 `POST /upload`。它和搜图/生图落图共用
 * `runtime/assetIngest.ts`，只是长边上限不同（见下面的常量说明）。
 */

import { Hono } from 'hono'
import { publicAssetBaseUrl, openAssetStorage } from '@server/runtime/assetConfig'
import { storeImageBytes } from '@server/runtime/assetIngest'
import { sniffFormat } from '@server/runtime/imageCodec'
import { toAssetUrl } from '@/utils/assetUrl'

const assets = new Hono()

/**
 * 用户上传图片的长边上限。
 *
 * 1568 不是随便取的：Anthropic 与 OpenAI 的视觉输入在这个量级之上不再收益，
 * 只是把 token 烧掉。搜图/生图那条路走的是各自 `assetSources.maxEdgePx`
 * （那些图要铺满整页，对分辨率的要求不一样），**刻意不共用这个常量**。
 */
const UPLOAD_MAX_EDGE_PX = 1568

/**
 * 单张原图字节上限。压缩之前挡，挡的是「解码一张 200MB 的 PNG」——
 * `decodeImage` 是纯 JS 同步实现，真解下去会把整个进程卡住。
 */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

/**
 * 图片资产的根地址。没配好返回空串，前端据此保留默认值、不去请求一个坏地址。
 *
 * 不需要管理员权限：它就是一个公开可读的桶地址，任何登录用户的画布都要用它。
 */
assets.get('/base-url', async (c) => {
  return c.json({ baseUrl: await publicAssetBaseUrl() })
})

/**
 * R-68 · 上传一张图片，拿到 `asset://<hash>`。
 *
 * 给对话框的粘贴/上传用：图片是**给模型看的材料**，不进 deck。
 * 但仍然走同一个资产库 —— 内容寻址让同一张图重复上传只占一份，
 * 而 `asset://` 让它在换桶、挂 CDN 之后仍然取得到。
 *
 * ## 认字节头，不认扩展名也不认 Content-Type
 *
 * 两者都是客户端说了算的，而**解码器不看它们的脸色**：
 * 一个 `.png` 结尾的 HEIC 会让 `decodeImage` 直接抛，那时错误信息
 * 说的是「字节坏了」而不是「这个格式不支持」，排查会绕远路。
 * 所以先 `sniffFormat` 认头，认不出就当场说清楚支持哪两种。
 */
assets.post('/upload', async (c) => {
  const storage = await openAssetStorage()
  if (!storage) {
    // 说清楚是「没配」而不是「传失败」—— 前端据此禁用上传入口，
    // 而不是让用户对着一个每次都失败的按钮反复重试
    return c.json({ error: 'not_configured', message: '对象存储尚未配置，无法上传图片' }, 503)
  }

  let file: File | null = null
  try {
    const form = await c.req.formData()
    const value = form.get('file')
    if (value instanceof File) file = value
  }
  catch {
    return c.json({ error: 'bad_request', message: '请求不是合法的 multipart 表单' }, 400)
  }

  if (!file) return c.json({ error: 'bad_request', message: '缺少 file 字段' }, 400)
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({
      error: 'too_large',
      message: `图片太大（${(file.size / 1024 / 1024).toFixed(1)}MB），单张上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`,
    }, 413)
  }

  const raw = new Uint8Array(await file.arrayBuffer())
  if (!sniffFormat(raw)) {
    return c.json({ error: 'unsupported_format', message: '只支持 PNG 与 JPEG 图片' }, 415)
  }

  try {
    const stored = await storeImageBytes(raw, UPLOAD_MAX_EDGE_PX, storage.store)
    return c.json({
      src: toAssetUrl(stored.hash),
      width: stored.width,
      height: stored.height,
      bytes: stored.bytes,
    })
  }
  catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn('[assets] 上传失败:', reason)
    return c.json({ error: 'upload_failed', message: reason }, 500)
  }
})

export default assets
