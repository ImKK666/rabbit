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
 */

import { Hono } from 'hono'
import { publicAssetBaseUrl } from '@server/runtime/assetConfig'

const assets = new Hono()

/**
 * 图片资产的根地址。没配好返回空串，前端据此保留默认值、不去请求一个坏地址。
 *
 * 不需要管理员权限：它就是一个公开可读的桶地址，任何登录用户的画布都要用它。
 */
assets.get('/base-url', async (c) => {
  return c.json({ baseUrl: await publicAssetBaseUrl() })
})

export default assets
