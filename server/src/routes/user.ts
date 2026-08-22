import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { getJwtPayload } from '@server/auth/jwt'
import { inspectRoleModel } from '@server/runtime/llm'
import { assetStorageReady } from '@server/runtime/assetConfig'
import { db } from '@server/db'
import {
  users,
  modelProviders,
  modelConfigs,
  roleDefaults,
  userRolePreferences,
  AGENT_ROLES,
  type AgentRole,
} from '@server/db/schema'

const user = new Hono()

user.get('/models', async (c) => {
  const models = await db.select({
    id: modelConfigs.id,
    modelName: modelConfigs.modelName,
    displayName: modelConfigs.displayName,
    supportsImages: modelConfigs.supportsImages,
    supportsVision: modelConfigs.supportsVision,
    providerName: modelProviders.name,
    providerType: modelProviders.providerType,
  })
    .from(modelConfigs)
    .innerJoin(modelProviders, eq(modelConfigs.providerId, modelProviders.id))
    .where(eq(modelConfigs.enabled, true))
    .all()

  return c.json({ models })
})

user.get('/preferences', async (c) => {
  const { userId } = getJwtPayload(c)

  const defaults = await db.select().from(roleDefaults).all()
  const prefs = await db.select()
    .from(userRolePreferences)
    .where(eq(userRolePreferences.userId, userId))
    .all()

  const result = AGENT_ROLES.map(role => {
    const userPref = prefs.find(p => p.role === role)
    const globalDefault = defaults.find(d => d.role === role)
    return {
      role,
      modelConfigId: userPref?.modelConfigId ?? globalDefault?.modelConfigId ?? null,
      source: userPref ? 'user' as const : globalDefault ? 'default' as const : 'none' as const,
    }
  })

  return c.json({ preferences: result })
})

/**
 * R-68 · 对话框能不能传图。
 *
 * 两个条件缺一不可：写作角色的模型**能读图**、对象存储**配好了**。
 * 前端据此把上传入口置灰并说清原因 —— 让用户传完九张再告诉他不行，
 * 是最差的一种做法。
 *
 * 不让前端自己拿 `/models` + `/preferences` 算：那要复算一遍
 * 「用户偏好 → 角色默认」的解析规则，而 `inspectRoleModel` 才是这条规则的
 * 唯一权威。算出两份不一致的答案时，出错的会是**没人看的那一份**。
 *
 * 服务端在 `pipeline.ts` 里还会再挡一道 —— 这里只是体验，那里才是约束。
 */
user.get('/capabilities', async (c) => {
  const { userId } = getJwtPayload(c)

  const [info, storageReady] = await Promise.all([
    inspectRoleModel('deck', userId),
    assetStorageReady(),
  ])

  const vision = info.ok && info.supportsVision
  const reason = !storageReady
    ? '未配置对象存储，无法上传图片'
    : !info.ok
      ? `当前模型不可用（${info.reason}）`
      : !info.supportsVision
        ? '当前模型不支持识图，请在设置里换一个勾了「能读图」的模型'
        : ''

  return c.json({ imageInput: vision && storageReady, reason })
})

const prefSchema = z.object({  role: z.enum(AGENT_ROLES),
  modelConfigId: z.number().int().positive(),
})

user.put('/preferences', zValidator('json', prefSchema), async (c) => {
  const { userId } = getJwtPayload(c)
  const { role, modelConfigId } = c.req.valid('json')

  const model = await db.select()
    .from(modelConfigs)
    .where(and(eq(modelConfigs.id, modelConfigId), eq(modelConfigs.enabled, true)))
    .get()
  if (!model) return c.json({ error: '模型不存在或已禁用' }, 400)

  const existing = await db.select()
    .from(userRolePreferences)
    .where(and(
      eq(userRolePreferences.userId, userId),
      eq(userRolePreferences.role, role as AgentRole),
    ))
    .get()

  if (existing) {
    await db.update(userRolePreferences)
      .set({ modelConfigId })
      .where(eq(userRolePreferences.id, existing.id))
  }
  else {
    await db.insert(userRolePreferences)
      .values({ userId, role: role as AgentRole, modelConfigId })
  }

  return c.json({ ok: true })
})

const passwordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(6).max(128),
})

user.put('/password', zValidator('json', passwordSchema), async (c) => {
  const { userId } = getJwtPayload(c)
  const { oldPassword, newPassword } = c.req.valid('json')

  const row = await db.select().from(users).where(eq(users.id, userId)).get()
  if (!row) return c.json({ error: '用户不存在' }, 404)

  const valid = await Bun.password.verify(oldPassword, row.passwordHash)
  if (!valid) return c.json({ error: '原密码错误' }, 401)

  const passwordHash = await Bun.password.hash(newPassword)
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId))

  return c.json({ ok: true })
})

export default user
