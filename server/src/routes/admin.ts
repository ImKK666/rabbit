import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getJwtPayload } from '@server/auth/jwt'
import { db } from '@server/db'
import {
  users, modelProviders, modelConfigs, roleDefaults, storageConfigs, assetSources,
  type AgentRole,
} from '@server/db/schema'
import { createObjectStore, resolvePublicBase } from '@server/runtime/objectStore'
import { searchImages, NEEDS_API_KEY } from '@server/runtime/imageSearch'

const admin = new Hono()

admin.use('*', async (c, next) => {
  const payload = getJwtPayload(c)
  if (payload.role !== 'admin') return c.json({ error: '需要管理员权限' }, 403)
  await next()
})

// --- Providers ---

const providerSchema = z.object({
  name: z.string().min(1),
  providerType: z.enum(['openai', 'anthropic', 'google', 'deepseek']),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  remark: z.string().optional(),
})

admin.get('/providers', async (c) => {
  const providers = await db.select({
    id: modelProviders.id,
    name: modelProviders.name,
    providerType: modelProviders.providerType,
    baseUrl: modelProviders.baseUrl,
    remark: modelProviders.remark,
    createdAt: modelProviders.createdAt,
  }).from(modelProviders).all()
  return c.json({ providers })
})

admin.post('/providers', zValidator('json', providerSchema), async (c) => {
  const data = c.req.valid('json')
  const result = await db.insert(modelProviders).values(data).returning().get()
  return c.json({ provider: result }, 201)
})

admin.put('/providers/:id', zValidator('json', providerSchema), async (c) => {
  const id = parseInt(c.req.param('id'))
  const data = c.req.valid('json')
  await db.update(modelProviders).set(data).where(eq(modelProviders.id, id))
  return c.json({ ok: true })
})

admin.delete('/providers/:id', async (c) => {
  const id = parseInt(c.req.param('id'))
  await db.delete(modelProviders).where(eq(modelProviders.id, id))
  return c.json({ ok: true })
})

admin.post('/providers/:id/fetch-models', async (c) => {
  const id = parseInt(c.req.param('id'))
  const provider = await db.select().from(modelProviders).where(eq(modelProviders.id, id)).get()
  if (!provider) return c.json({ error: '服务商不存在' }, 404)

  try {
    const start = Date.now()
    let url: string
    const headers: Record<string, string> = {}

    if (provider.providerType === 'anthropic') {
      url = `${provider.baseUrl.replace(/\/+$/, '')}/v1/models`
      headers['x-api-key'] = provider.apiKey
      headers['anthropic-version'] = '2023-06-01'
    }
    else if (provider.providerType === 'google') {
      url = `${provider.baseUrl.replace(/\/+$/, '')}/v1beta/models?key=${provider.apiKey}`
    }
    else {
      url = `${provider.baseUrl.replace(/\/+$/, '')}/v1/models`
      headers['Authorization'] = `Bearer ${provider.apiKey}`
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return c.json({ error: `请求失败 (${res.status}): ${text.slice(0, 200)}` })
    }

    const body = await res.json() as any
    const elapsed = Date.now() - start

    let models: { id: string, name: string }[] = []
    if (provider.providerType === 'google') {
      models = (body.models || []).map((m: any) => ({
        id: m.name?.replace('models/', '') || m.name,
        name: m.displayName || m.name,
      }))
    }
    else if (provider.providerType === 'anthropic') {
      models = (body.data || []).map((m: any) => ({
        id: m.id || m.name,
        name: m.display_name || m.id || m.name,
      }))
    }
    else {
      models = (body.data || []).map((m: any) => ({
        id: m.id,
        name: m.id,
      }))
    }

    return c.json({ models, elapsed })
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误'
    return c.json({ error: `连接失败: ${msg}` })
  }
})

// --- Model configs (whitelist) ---

const modelConfigSchema = z.object({
  providerId: z.number().int().positive(),
  modelName: z.string().min(1),
  displayName: z.string().min(1),
  supportsImages: z.boolean().default(false),
  enabled: z.boolean().default(true),
})

admin.get('/models', async (c) => {
  const models = await db.select().from(modelConfigs).all()
  return c.json({ models })
})

admin.post('/models', zValidator('json', modelConfigSchema), async (c) => {
  const data = c.req.valid('json')
  const result = await db.insert(modelConfigs).values(data).returning().get()
  return c.json({ model: result }, 201)
})

/**
 * 可改的字段**显式列出**。
 *
 * 原来是 `set(await c.req.json())` —— 请求体里写什么就更新什么，
 * 连 `id` / `providerId` 都能被改。虽然这条路由在管理员闸门后面，
 * 但「能改哪些字段」不该由调用方的 JSON 决定。
 */
const modelPatchSchema = z.object({
  displayName: z.string().min(1).optional(),
  supportsImages: z.boolean().optional(),
  enabled: z.boolean().optional(),
  /** null = 取消限流；正整数 = 每分钟上限 */
  rateLimitPerMin: z.number().int().positive().nullable().optional(),
})

admin.patch('/models/:id', zValidator('json', modelPatchSchema), async (c) => {
  const id = parseInt(c.req.param('id'))
  const data = c.req.valid('json')
  if (Object.keys(data).length === 0) return c.json({ ok: true })
  await db.update(modelConfigs).set(data).where(eq(modelConfigs.id, id))
  return c.json({ ok: true })
})

admin.delete('/models/:id', async (c) => {
  const id = parseInt(c.req.param('id'))
  await db.delete(modelConfigs).where(eq(modelConfigs.id, id))
  return c.json({ ok: true })
})

// --- Role defaults ---

const roleDefaultSchema = z.object({
  role: z.enum(['planner', 'generator', 'reviewer', 'editor'] as const),
  modelConfigId: z.number().int().positive(),
})

admin.get('/role-defaults', async (c) => {
  const defaults = await db.select().from(roleDefaults).all()
  return c.json({ defaults })
})

admin.put('/role-defaults', zValidator('json', roleDefaultSchema), async (c) => {
  const { role, modelConfigId } = c.req.valid('json')
  const existing = await db.select().from(roleDefaults).where(eq(roleDefaults.role, role as AgentRole)).get()
  if (existing) {
    await db.update(roleDefaults).set({ modelConfigId }).where(eq(roleDefaults.role, role as AgentRole))
  }
  else {
    await db.insert(roleDefaults).values({ role: role as AgentRole, modelConfigId })
  }
  return c.json({ ok: true })
})

// --- Users ---

admin.get('/users', async (c) => {
  const result = await db.select({
    id: users.id,
    username: users.username,
    role: users.role,
    createdAt: users.createdAt,
  }).from(users).all()
  return c.json({ users: result })
})

admin.patch('/users/:id', zValidator('json', z.object({ role: z.enum(['admin', 'user']) })), async (c) => {
  const id = parseInt(c.req.param('id'))
  const { role } = c.req.valid('json')
  await db.update(users).set({ role }).where(eq(users.id, id))
  return c.json({ ok: true })
})

admin.delete('/users/:id', async (c) => {
  const payload = getJwtPayload(c)
  const id = parseInt(c.req.param('id'))
  if (id === payload.userId) return c.json({ error: '不能删除自己' }, 400)
  await db.delete(users).where(eq(users.id, id))
  return c.json({ ok: true })
})

admin.post('/users/:id/reset-password', zValidator('json', z.object({ newPassword: z.string().min(6).max(128) })), async (c) => {
  const payload = getJwtPayload(c)
  const id = parseInt(c.req.param('id'))
  if (id === payload.userId) return c.json({ error: '不能重置自己的密码，请用个人设置修改' }, 400)

  const user = await db.select().from(users).where(eq(users.id, id)).get()
  if (!user) return c.json({ error: '用户不存在' }, 404)

  const { newPassword } = c.req.valid('json')
  const passwordHash = await Bun.password.hash(newPassword)
  await db.update(users).set({ passwordHash }).where(eq(users.id, id))
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// 对象存储（图片资产存哪儿）
// ---------------------------------------------------------------------------

/**
 * 两张配置表都是**单行表**，约定 id=1。
 * 读不到就地补一行默认值，省掉「首次进设置页是空的、还得先点保存」这一步。
 */
const STORAGE_ROW_ID = 1
const ASSET_ROW_ID = 1

const loadStorage = async () => {
  const row = await db.select().from(storageConfigs).where(eq(storageConfigs.id, STORAGE_ROW_ID)).get()
  if (row) return row
  return db.insert(storageConfigs).values({ id: STORAGE_ROW_ID }).returning().get()
}

/** **secretKey 永不出现在响应里** —— 前端只需要知道「配没配过」 */
const publicStorage = (row: Awaited<ReturnType<typeof loadStorage>>) => ({
  provider: row.provider,
  secretId: row.secretId,
  hasSecretKey: row.secretKey.length > 0,
  bucket: row.bucket,
  region: row.region,
  prefix: row.prefix,
  publicBaseUrl: row.publicBaseUrl,
  enabled: row.enabled,
  /** 实际生效的对外地址，让管理员一眼看到拼出来是什么 */
  effectiveBaseUrl: row.bucket && row.region
    ? resolvePublicBase({ bucket: row.bucket, region: row.region, publicBaseUrl: row.publicBaseUrl })
    : '',
})

const storageSchema = z.object({
  provider: z.enum(['cos']).default('cos'),
  secretId: z.string().default(''),
  /** 留空 = 不改动已存的密钥。和 provider 表的做法一致 */
  secretKey: z.string().optional(),
  bucket: z.string().default(''),
  region: z.string().default(''),
  prefix: z.string().default('rabbit/'),
  publicBaseUrl: z.string().default(''),
  enabled: z.boolean().default(false),
})

admin.get('/storage', async (c) => {
  return c.json({ storage: publicStorage(await loadStorage()) })
})

admin.put('/storage', zValidator('json', storageSchema), async (c) => {
  const data = c.req.valid('json')
  await loadStorage() // 保证行存在
  const { secretKey, ...rest } = data
  await db.update(storageConfigs)
    .set({
      ...rest,
      // 空字符串意味着「没动这个框」，不能拿它把已存的密钥抹掉
      ...(secretKey ? { secretKey } : {}),
      updatedAt: new Date(),
    })
    .where(eq(storageConfigs.id, STORAGE_ROW_ID))
  return c.json({ storage: publicStorage(await loadStorage()) })
})

/**
 * 连通性测试：**用已保存的配置**跑一次真实往返（上传 → 匿名读 → 删除）。
 *
 * 只验签名不算数 —— 真正会坏的是「桶不是公有读」「CORS 没配」这类，
 * 它们只有真的发一次请求才看得见。前端在测试前先保存，
 * 和 ProviderSettings 的连接测试是同一个流程。
 */
admin.post('/storage/test', async (c) => {
  const row = await loadStorage()
  if (!row.secretId || !row.secretKey || !row.bucket || !row.region) {
    return c.json({ ok: false, error: '请先填完 SecretId / SecretKey / 存储桶 / 地域并保存' })
  }

  const started = Date.now()
  const store = createObjectStore({
    secretId: row.secretId, secretKey: row.secretKey,
    bucket: row.bucket, region: row.region,
    prefix: row.prefix, publicBaseUrl: row.publicBaseUrl,
  })
  // 内容里带时间戳，避免命中上一次测试留下的对象而误判「能写」
  const bytes = new TextEncoder().encode(`rabbit storage check ${Date.now()}`)

  try {
    const put = await store.put(bytes, 'txt', 'text/plain')

    const anon = await fetch(put.url)
    const publicReadable = anon.status === 200

    // 导出（pptxgenjs / html-to-image）要跨域读图片字节，没有 CORS 会静默失败
    const cors = await fetch(put.url, { headers: { Origin: 'http://localhost:5173' } })
    const corsHeader = cors.headers.get('access-control-allow-origin')

    await store.remove(put.key)

    return c.json({
      ok: publicReadable && !!corsHeader,
      elapsed: Date.now() - started,
      url: put.url,
      publicReadable,
      corsAllowOrigin: corsHeader,
      warnings: [
        ...(publicReadable ? [] : ['桶不是公有读：画布上的图会加载不出来']),
        ...(corsHeader ? [] : ['桶没配 CORS：画布正常，但导出 PPTX / PNG 时图片会静默丢失']),
      ],
    })
  }
  catch (err) {
    return c.json({ ok: false, elapsed: Date.now() - started, error: err instanceof Error ? err.message : '测试失败' })
  }
})

// ---------------------------------------------------------------------------
// 素材来源（图从哪来）
// ---------------------------------------------------------------------------

const loadAssetSource = async () => {
  const row = await db.select().from(assetSources).where(eq(assetSources.id, ASSET_ROW_ID)).get()
  if (row) return row
  return db.insert(assetSources).values({ id: ASSET_ROW_ID }).returning().get()
}

const publicAssetSource = (row: Awaited<ReturnType<typeof loadAssetSource>>) => ({
  searchProvider: row.searchProvider,
  hasSearchApiKey: row.searchApiKey.length > 0,
  searchNeedsApiKey: NEEDS_API_KEY[row.searchProvider],
  searchEnabled: row.searchEnabled,
  imageModelConfigId: row.imageModelConfigId,
  generateEnabled: row.generateEnabled,
  maxEdgePx: row.maxEdgePx,
})

const assetSourceSchema = z.object({
  searchProvider: z.enum(['wikimedia', 'pexels', 'unsplash', 'pixabay']).default('wikimedia'),
  searchApiKey: z.string().optional(), // 留空 = 不改
  searchEnabled: z.boolean().default(false),
  imageModelConfigId: z.number().int().positive().nullable().default(null),
  generateEnabled: z.boolean().default(false),
  maxEdgePx: z.number().int().min(320).max(4096).default(1600),
})

admin.get('/asset-source', async (c) => {
  return c.json({ assetSource: publicAssetSource(await loadAssetSource()) })
})

admin.put('/asset-source', zValidator('json', assetSourceSchema), async (c) => {
  const data = c.req.valid('json')
  await loadAssetSource()
  const { searchApiKey, ...rest } = data
  await db.update(assetSources)
    .set({ ...rest, ...(searchApiKey ? { searchApiKey } : {}), updatedAt: new Date() })
    .where(eq(assetSources.id, ASSET_ROW_ID))
  return c.json({ assetSource: publicAssetSource(await loadAssetSource()) })
})

/**
 * 搜图连通性测试。**只搜一次，不生图** ——
 * 生图一次要 15~50 秒还要花钱，不该挂在一个「测试」按钮上。
 * 生图那边只校验「选中的模型还在且启用着」。
 */
admin.post('/asset-source/test', async (c) => {
  const row = await loadAssetSource()
  const search = await searchImages(row.searchProvider, 'city skyline at night', {
    apiKey: row.searchApiKey, limit: 3,
  })

  let generate: { ok: boolean, model?: string, error?: string } = { ok: false, error: '未选择生图模型' }
  if (row.imageModelConfigId) {
    const m = await db.select().from(modelConfigs).where(eq(modelConfigs.id, row.imageModelConfigId)).get()
    if (!m) generate = { ok: false, error: '选中的模型已被删除' }
    else if (!m.enabled) generate = { ok: false, model: m.displayName, error: '该模型未启用' }
    else generate = { ok: true, model: m.displayName }
  }

  return c.json({
    search: {
      ok: search.ok, provider: search.provider, count: search.count,
      elapsed: search.elapsedMs, error: search.error,
      sample: search.candidates.slice(0, 3).map(x => ({ url: x.url, width: x.width, height: x.height })),
    },
    generate,
  })
})

export default admin
