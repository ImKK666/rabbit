import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '@server/db'
import { users } from '@server/db/schema'
import { signToken, verifyToken, JWT_EXPIRES_IN, JWT_RENEW_THRESHOLD } from '@server/auth/jwt'

const auth = new Hono()

const registerSchema = z.object({
  username: z.string().min(2).max(32),
  password: z.string().min(6).max(128),
})

const loginSchema = registerSchema

auth.post('/register', zValidator('json', registerSchema), async (c) => {
  const { username, password } = c.req.valid('json')

  const existing = await db.select().from(users).where(eq(users.username, username)).get()
  if (existing) return c.json({ error: '用户名已存在' }, 409)

  const passwordHash = await Bun.password.hash(password)

  const isFirstUser = !(await db.select().from(users).limit(1).get())
  const role = isFirstUser ? 'admin' : 'user'

  const result = await db.insert(users).values({ username, passwordHash, role }).returning().get()
  const token = await signToken({ userId: result.id, username: result.username, role: result.role })

  return c.json({ token, user: { id: result.id, username: result.username, role: result.role } })
})

auth.post('/login', zValidator('json', loginSchema), async (c) => {
  const { username, password } = c.req.valid('json')

  const user = await db.select().from(users).where(eq(users.username, username)).get()
  if (!user) return c.json({ error: '用户名或密码错误' }, 401)

  const valid = await Bun.password.verify(password, user.passwordHash)
  if (!valid) return c.json({ error: '用户名或密码错误' }, 401)

  const token = await signToken({ userId: user.id, username: user.username, role: user.role })

  return c.json({ token, user: { id: user.id, username: user.username, role: user.role } })
})

/**
 * 校验登录态，顺便做**滑动续期**。
 *
 * token 固定 7 天且原来没有任何续期手段 —— 用得再勤，到第 8 天也一样被踢下线。
 * 这里在剩余寿命过半时换发新 token，前端收到就换掉。
 */
auth.get('/me', async (c) => {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) return c.json({ error: '未登录' }, 401)

  let payload
  try {
    payload = await verifyToken(header.slice(7))
  }
  catch {
    return c.json({ error: 'token 无效或已过期' }, 401)
  }

  // 从库里读而不是直接信 token 里的字段：
  // 账号被删、角色被管理员改过，都能立刻生效而不用等 token 过期
  const user = await db.select().from(users).where(eq(users.id, payload.userId)).get()
  if (!user) return c.json({ error: '账号不存在' }, 401)

  const body = { user: { id: user.id, username: user.username, role: user.role } }

  const remaining = payload.exp - Math.floor(Date.now() / 1000)
  if (remaining < JWT_EXPIRES_IN * JWT_RENEW_THRESHOLD) {
    const token = await signToken({ userId: user.id, username: user.username, role: user.role })
    return c.json({ ...body, token })
  }

  return c.json(body)
})

export default auth
