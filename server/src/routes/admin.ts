import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getJwtPayload } from '@server/auth/jwt'
import { db } from '@server/db'
import { users, modelProviders, modelConfigs, roleDefaults, type AgentRole } from '@server/db/schema'

const admin = new Hono()

admin.use('*', async (c, next) => {
  const payload = getJwtPayload(c)
  if (payload.role !== 'admin') return c.json({ error: '需要管理员权限' }, 403)
  await next()
})

// --- Providers ---

const providerSchema = z.object({
  name: z.string().min(1),
  providerType: z.enum(['openai', 'anthropic', 'google']),
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

admin.patch('/models/:id', async (c) => {
  const id = parseInt(c.req.param('id'))
  const body = await c.req.json()
  await db.update(modelConfigs).set(body).where(eq(modelConfigs.id, id))
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

export default admin
