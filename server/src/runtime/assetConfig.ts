/**
 * 资产相关配置的读取 —— 把两张单行表变成可用的运行时对象
 *
 * 和 `llm.ts` 一样是「碰库的 runtime 模块」：没有判据（vitest 里 import 不进
 * `bun:sqlite`），所以这里**只做搬运，不做决定**。所有会写错的判断
 * 都在有单测的地方：`objectStore.ts` / `imageCodec.ts` / `assetResults.ts`。
 *
 * ## 一个关键约定：对象 key **不带扩展名**
 *
 * `asset://<sha256>` 的文法只有 64 位十六进制（`src/utils/assetUrl.ts:44`），
 * 既没有前缀也没有扩展名。前端把它解析成 `{assetBaseUrl}/{hash}` ——
 * 所以桶里的对象必须正好叫 `{prefix}{hash}`，多一个 `.jpg` 就对不上。
 *
 * MIME 由上传时的 `Content-Type` 给出，浏览器认那个头。
 * `contentKey()` 传空扩展名即可，它本来就支持（`ext ? … : ''`）。
 *
 * **但不是所有消费者都认 `Content-Type`。** 这里原先写着「浏览器和 pptxgenjs
 * 都认那个头」—— pptxgenjs 那半句是错的，而且代价很大（R-67）：它判断图片类型
 * 时只切 path 字符串，无扩展名的地址会让它把整串 hash 当扩展名；背景图那条路
 * 还会因此漏写 [Content_Types] 声明，PowerPoint 直接判文件损坏。
 * 现在导出侧自己把字节取回来转 data URL 绕开了它（`src/utils/exportAssets.ts`），
 * 但**新接一个消费者时要先确认它认不认 `Content-Type`**，别再假定。
 *
 * 代价是手动从桶里下载下来的文件没有后缀名。可接受 —— 换来的是
 * **deck JSON 与存储位置解耦**：换桶、挂 CDN 只要改这里的配置，
 * 所有旧 deck 跟着走，一个字都不用改。这就是决策 E 想要的东西。
 */

import { eq } from 'drizzle-orm'
import { db } from '@server/db'
import { storageConfigs, assetSources, modelConfigs, modelProviders } from '@server/db/schema'
import { createObjectStore, resolvePublicBase, normalizePrefix, type ObjectStore } from './objectStore'

/** 两张都是单行表，约定 id=1（和 routes/admin.ts 一致） */
const ROW_ID = 1

export type StorageRow = typeof storageConfigs.$inferSelect
export type AssetSourceRow = typeof assetSources.$inferSelect

// 不写 `async`：drizzle 的 `.get()` 在 bun-sqlite 上是同步的，
// 挂一个空 async 只会让 eslint 的 require-await 报错，而返回 Promise 的形状
// 是调用方需要的 —— 所以显式包一层，不靠 async 语法糖
export const loadStorageRow = (): Promise<StorageRow | undefined> =>
  Promise.resolve(db.select().from(storageConfigs).where(eq(storageConfigs.id, ROW_ID)).get())

export const loadAssetSourceRow = (): Promise<AssetSourceRow | undefined> =>
  Promise.resolve(db.select().from(assetSources).where(eq(assetSources.id, ROW_ID)).get())

/** 配置全不全。缺哪一样要说出名字 —— 一句「配置错误」等于没说 */
export const storageMissingFields = (row: StorageRow | undefined): string[] => {
  if (!row) return ['对象存储尚未配置']
  const missing: string[] = []
  if (!row.secretId) missing.push('SecretId')
  if (!row.secretKey) missing.push('SecretKey')
  if (!row.bucket) missing.push('存储桶')
  if (!row.region) missing.push('地域')
  return missing
}

export interface AssetStorage {
  store: ObjectStore
  /** 对外的资产根地址，形如 `https://bucket.cos.region.myqcloud.com/rabbit` */
  baseUrl: string
}

/**
 * 建对象存储客户端。**没开启 / 没配全一律返回 null**，不抛 ——
 * 调用方据此回一句说得清的 `not_configured`，而不是把一个配置问题
 * 变成一次工具异常。
 */
export const openAssetStorage = async (): Promise<AssetStorage | null> => {
  const row = await loadStorageRow()
  if (!row || !row.enabled || storageMissingFields(row).length > 0) return null

  const config = {
    secretId: row.secretId, secretKey: row.secretKey,
    bucket: row.bucket, region: row.region,
    prefix: row.prefix, publicBaseUrl: row.publicBaseUrl,
  }
  return { store: createObjectStore(config), baseUrl: assetBaseUrlOf(row) }
}

/**
 * 前端要设进 `setAssetBaseUrl()` 的那个地址：**公开域名 + key 前缀**。
 *
 * 拼上前缀是必须的：桶里的 key 是 `rabbit/<hash>`，而 `asset://<hash>`
 * 只带 hash。前缀不进 baseUrl 的话，前端会去请求 `/<hash>` —— 404，
 * 而且**只在图片上表现为破图**，别处一切正常。
 */
export const assetBaseUrlOf = (row: StorageRow): string => {
  const base = resolvePublicBase({
    bucket: row.bucket, region: row.region, publicBaseUrl: row.publicBaseUrl,
  })
  // normalizePrefix 产出 `rabbit/` 或空串；末尾斜杠去掉，拼接统一由调用方加
  return `${base}/${normalizePrefix(row.prefix)}`.replace(/\/+$/, '')
}

/** 前端启动时问一次的那个地址。没配好返回空串，前端就不改默认值 */
export const publicAssetBaseUrl = async (): Promise<string> => {
  const row = await loadStorageRow()
  if (!row || !row.enabled || !row.bucket || !row.region) return ''
  return assetBaseUrlOf(row)
}

/**
 * 这次装配要不要把图片工具给 agent。
 *
 * 三个条件缺一不可：对象存储配好且开着（图没地方放）、至少一个取图开关开着。
 * 全不满足时**整组工具不注册** —— 照 R-32 的教训，
 * 一个永远返回「未配置」的工具只会白白消耗步数预算。
 */
export const imageCapabilityAvailable = async (): Promise<boolean> => {
  const [storage, source] = await Promise.all([loadStorageRow(), loadAssetSourceRow()])
  const storageOk = !!storage && storage.enabled && storageMissingFields(storage).length === 0
  return storageOk && !!source && (source.searchEnabled || source.generateEnabled)
}

export interface ImageModelRuntime {
  modelConfigId: number
  modelName: string
  displayName: string
  baseUrl: string
  apiKey: string
  /** null = 不限流 */
  rateLimitPerMin: number | null
}

/**
 * 取生图模型。没选 / 已删 / 已禁用都返回一条**说得出哪儿不对**的原因，
 * 而不是一个 null —— 这三种情况的处置完全不同（去选一个 / 重新选 / 去启用）。
 */
export const loadImageModel = async (
  imageModelConfigId: number | null,
): Promise<{ ok: true, model: ImageModelRuntime } | { ok: false, error: string }> => {
  if (!imageModelConfigId) return { ok: false, error: '尚未选择生图模型' }

  const config = await db.select().from(modelConfigs)
    .where(eq(modelConfigs.id, imageModelConfigId)).get()
  if (!config) return { ok: false, error: '选中的生图模型已被删除' }
  if (!config.enabled) return { ok: false, error: `生图模型「${config.displayName}」未启用` }

  const provider = await db.select().from(modelProviders)
    .where(eq(modelProviders.id, config.providerId)).get()
  if (!provider) return { ok: false, error: `生图模型的服务商 #${config.providerId} 不存在` }

  return {
    ok: true,
    model: {
      modelConfigId: config.id,
      modelName: config.modelName,
      displayName: config.displayName,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      rateLimitPerMin: config.rateLimitPerMin,
    },
  }
}
