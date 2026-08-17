import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '@server/db'
import { modelProviders, modelConfigs, roleDefaults, type AgentRole } from '@server/db/schema'

const admin = new Hono()

admin.use('*', async (c, next) => {
  const payload = c.get('jwtPayload')
  if (payload.role !== 'admin') return c.json({ error: '需要管理员权限' }, 403)
  await next()
})

// --- Providers ---

const providerSchema = z.object({
  name: z.string().min(1),
  providerType: z.enum(['openai', 'anthropic', 'google']),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
})

admin.get('/providers', async (c) => {
  const providers = await db.select({
    id: modelProviders.id,
    name: modelProviders.name,
    providerType: modelProviders.providerType,
    baseUrl: modelProviders.baseUrl,
    createdAt: modelProviders.createdAt,
  }).from(modelProviders).all()
  return c.json({ providers })
})

admin.post('/providers', zValidator('json', providerSchema), async (c) => {
  const data = c.req.valid('json')
  const result = await db.insert(modelProviders).values(data).returning().get()
  return c.json({ provider: result }, 201)
})

admin.delete('/providers/:id', async (c) => {
  const id = parseInt(c.req.param('id'))
  await db.delete(modelProviders).where(eq(modelProviders.id, id))
  return c.json({ ok: true })
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

export default admin
