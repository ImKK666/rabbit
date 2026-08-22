import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { generateText } from 'ai'
import { getJwtPayload } from '@server/auth/jwt'
import { db } from '@server/db'
import {
  users, modelProviders, modelConfigs, roleDefaults, storageConfigs, assetSources,
  AGENT_ROLES,
  type AgentRole,
} from '@server/db/schema'
import { createObjectStore, resolvePublicBase } from '@server/runtime/objectStore'
import { searchImages, NEEDS_API_KEY } from '@server/runtime/imageSearch'
import { resolveModelForConfig } from '@server/runtime/llm'
import { generateImage, resolveImageApiFlavor } from '@server/runtime/imageGenerate'
import { decodeImage, alphaStats, sniffFormat } from '@server/runtime/imageCodec'
import {
  deleteProviderCascade, deleteModelConfigCascade, deleteUserCascade,
} from '@server/db/cleanup'

const admin = new Hono()

admin.use('*', async (c, next) => {
  const payload = getJwtPayload(c)
  if (payload.role !== 'admin') return c.json({ error: '需要管理员权限' }, 403)
  await next()
})

// --- Providers ---

/**
 * 创建与更新拆两份 schema：**apiKey 只在创建时必填**。
 *
 * 更新时空缺 = 保持已存的密钥。原来用同一份 schema，
 * 前端「编辑时密钥留空」会被 400 拒掉 —— 想改个名字都得把 key 重新贴一遍，
 * 而且 storage 路由的注释还写着「和 provider 表的做法一致」
 * （写那份注释时 provider 表并没有这么做）。
 */
const providerBase = {
  name: z.string().min(1),
  providerType: z.enum(['openai', 'anthropic', 'google', 'deepseek']),
  baseUrl: z.string().url(),
  remark: z.string().optional(),
}
const providerSchema = z.object({ ...providerBase, apiKey: z.string().min(1) })
const providerUpdateSchema = z.object({ ...providerBase, apiKey: z.string().optional() })

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

admin.put('/providers/:id', zValidator('json', providerUpdateSchema), async (c) => {
  const id = parseInt(c.req.param('id'))
  const data = c.req.valid('json')

  const existing = await db.select({ id: modelProviders.id }).from(modelProviders)
    .where(eq(modelProviders.id, id)).get()
  if (!existing) return c.json({ error: '服务商不存在' }, 404)

  const { apiKey, ...rest } = data
  // 留空 = 不改动已存的密钥（和 storage 路由同一个约定，这次是真的）
  await db.update(modelProviders)
    .set({ ...rest, ...(apiKey ? { apiKey } : {}) })
    .where(eq(modelProviders.id, id))
  return c.json({ ok: true })
})

/**
 * 删服务商 = **级联删掉它名下的模型配置**，并清掉那些配置的引用
 * （角色默认 / 用户偏好删行，生图选择置空）。见 `db/cleanup.ts` 头注释 ——
 * 直接删会撞 `FOREIGN KEY constraint failed`，删除按钮一按一个 500。
 */
admin.delete('/providers/:id', async (c) => {
  const id = parseInt(c.req.param('id'))
  const existing = await db.select({ id: modelProviders.id }).from(modelProviders)
    .where(eq(modelProviders.id, id)).get()
  if (!existing) return c.json({ error: '服务商不存在' }, 404)

  const counts = deleteProviderCascade(db, id)
  return c.json({ ok: true, ...counts })
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
  /** 能出图（生图模型选择器筛的那个） */
  supportsImages: z.boolean().default(false),
  /** 能读图（视觉复核要的那个）。两件事是独立维度，见 db/schema.ts */
  supportsVision: z.boolean().default(false),
  enabled: z.boolean().default(true),
})

admin.get('/models', async (c) => {
  const models = await db.select().from(modelConfigs).all()
  return c.json({ models })
})

admin.post('/models', zValidator('json', modelConfigSchema), async (c) => {
  const data = c.req.valid('json')
  // 不存在的 providerId 会撞外键 500 —— 这里先挡成人话
  const provider = await db.select({ id: modelProviders.id }).from(modelProviders)
    .where(eq(modelProviders.id, data.providerId)).get()
  if (!provider) return c.json({ error: '服务商不存在' }, 400)

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
  supportsVision: z.boolean().optional(),
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

/**
 * 删模型配置 = 清掉角色默认 / 用户偏好里的引用行，生图选择置空。
 * 和删服务商同一套规则，见 `db/cleanup.ts`。
 */
admin.delete('/models/:id', async (c) => {
  const id = parseInt(c.req.param('id'))
  const existing = await db.select({ id: modelConfigs.id }).from(modelConfigs)
    .where(eq(modelConfigs.id, id)).get()
  if (!existing) return c.json({ error: '模型配置不存在' }, 404)

  const counts = deleteModelConfigCascade(db, id)
  return c.json({ ok: true, ...counts })
})

/**
 * 单个模型的真实连通测试（R-64 续）：发一句两字的对话，量耗时。
 *
 * 直接按配置 id 建模型（`resolveModelForConfig`），**不要求 enabled** ——
 * 管理员要测的常常就是刚关掉 / 还没启用的模型。
 *
 * 生图模型（supportsImages）对话测试可能本来就是不支持的，失败时附带一句
 * 指路：「出图能力去素材来源用『生成一张』测」。
 */
admin.post('/models/:id/test', async (c) => {
  const id = parseInt(c.req.param('id'))
  const config = await db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).get()
  if (!config) return c.json({ error: '模型配置不存在' }, 404)

  const started = Date.now()
  try {
    const resolved = await resolveModelForConfig(id)
    const res = await generateText({
      model: resolved.model,
      prompt: '只回复两个字：正常',
      maxTokens: 16,
      abortSignal: AbortSignal.timeout(30_000),
    })
    return c.json({ ok: true, elapsed: Date.now() - started, text: res.text.slice(0, 100) })
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const timedOut = /timed out|timeout|aborted/i.test(msg)
    return c.json({
      ok: false,
      elapsed: Date.now() - started,
      error: timedOut ? `超时（30s）：${msg}` : msg,
      ...(config.supportsImages
        ? { hint: '该模型标了「支持生图」—— 对话测试可能本来就不支持，出图能力请到「素材来源」里用「生成一张」测' }
        : {}),
    })
  }
})

// --- Role defaults ---

const roleDefaultSchema = z.object({
  role: z.enum(AGENT_ROLES),
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
  const existing = await db.select({ id: users.id }).from(users)
    .where(eq(users.id, id)).get()
  if (!existing) return c.json({ error: '用户不存在' }, 404)

  // 用过 agent 的用户名下挂着 deck / 会话 / 消息（外键链），直接删会 500 ——
  // 自底向上级联清掉（见 db/cleanup.ts）
  const counts = deleteUserCascade(db, id)
  return c.json({ ok: true, ...counts })
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
  imageApi: row.imageApi,
  maxEdgePx: row.maxEdgePx,
})

const assetSourceSchema = z.object({
  searchProvider: z.enum(['wikimedia', 'pexels', 'unsplash', 'pixabay']).default('wikimedia'),
  searchApiKey: z.string().optional(), // 留空 = 不改
  searchEnabled: z.boolean().default(false),
  imageModelConfigId: z.number().int().positive().nullable().default(null),
  generateEnabled: z.boolean().default(false),
  imageApi: z.enum(['auto', 'gemini', 'openai']).default('auto'),
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

/**
 * 「生成一张」—— 用**已保存**的生图配置真实出一张图，专门测透明通道。
 *
 * 和搜图连通测试不同，这里真的花钱（image2 一张高档 ≈ $0.21），
 * 所以它是独立按钮而不是挂在「测试」上。回一张 data URL 让管理员直接看，
 * 并量化 alpha：openai 形状下「模型画了实底」是装饰层会判失败重抽的情形，
 * 这里当场就能看到，不用跑一整份稿子。
 */
const IMAGE_TEST_PROMPT = [
  'A minimal alpha-channel test, 16:9 composition: three thin elegant horizontal',
  'lines and one small filled circle, dark teal (#0f766e), evenly spaced, nothing',
  'else. The background must be FULLY TRANSPARENT (real alpha channel, PNG output),',
  'absolutely no background color, no panel, no fill, no text.',
].join(' ')

admin.post('/asset-source/test-image', async (c) => {
  const row = await loadAssetSource()
  if (!row.imageModelConfigId) return c.json({ ok: false, error: '尚未选择生图模型' }, 400)

  const config = await db.select().from(modelConfigs).where(eq(modelConfigs.id, row.imageModelConfigId)).get()
  if (!config) return c.json({ ok: false, error: '选中的模型已被删除' }, 400)

  const provider = await db.select().from(modelProviders).where(eq(modelProviders.id, config.providerId)).get()
  if (!provider) return c.json({ ok: false, error: '模型的服务商不存在' }, 400)

  const flavor = resolveImageApiFlavor(row.imageApi, config.modelName)
  const outcome = await generateImage({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: config.modelName,
    prompt: IMAGE_TEST_PROMPT,
    aspectRatio: '16:9',
    flavor,
    // 只有 openai 形状原生支持透明通道（background=transparent）；gemini 走绿幕路线
    alpha: flavor === 'openai',
  })

  if (!outcome.ok || !outcome.bytes) {
    return c.json({
      ok: false,
      error: outcome.error ?? '没有图',
      elapsed: outcome.elapsedMs,
      flavor,
      rateLimited: outcome.rateLimited ?? false,
    })
  }

  try {
    const decoded = decodeImage(outcome.bytes)
    const alpha = alphaStats(decoded.rgba)
    const format = sniffFormat(outcome.bytes) ?? 'png'
    return c.json({
      ok: true,
      elapsed: outcome.elapsedMs,
      flavor,
      model: config.modelName,
      width: decoded.width,
      height: decoded.height,
      bytes: outcome.bytes.length,
      dataUrl: `data:image/${format};base64,${Buffer.from(outcome.bytes).toString('base64')}`,
      alpha: {
        nativeSupported: flavor === 'openai',
        transparentRatio: alpha.transparentRatio,
        fullyOpaque: alpha.fullyOpaque,
        empty: alpha.empty,
      },
      note: flavor !== 'openai'
        ? 'Gemini 形状不原生支持透明通道（装饰层走绿幕抠图路线），上面是原始生成图'
        : alpha.fullyOpaque
          ? '⚠ 模型没有回透明通道 —— 整图不透明，装饰层会判失败重抽'
          : '透明通道正常',
    })
  }
  catch (err) {
    return c.json({
      ok: false,
      error: `解码失败：${err instanceof Error ? err.message : String(err)}`,
      elapsed: outcome.elapsedMs,
      flavor,
    })
  }
})

export default admin
