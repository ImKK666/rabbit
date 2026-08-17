import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '@server/db'
import { users } from '@server/db/schema'
import { signToken, getJwtPayload } from '@server/auth/jwt'

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

auth.get('/me', async (c) => {
  const payload = getJwtPayload(c)
  return c.json({ user: { id: payload.userId, username: payload.username, role: payload.role } })
})

export default auth
