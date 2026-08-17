import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { getJwtPayload } from '@server/auth/jwt'
import { db } from '@server/db'
import { decks } from '@server/db/schema'

const deck = new Hono()

deck.get('/', async (c) => {
  const { userId } = getJwtPayload(c)
  const result = await db.select({
    id: decks.id,
    title: decks.title,
    version: decks.version,
    createdAt: decks.createdAt,
    updatedAt: decks.updatedAt,
  }).from(decks).where(eq(decks.userId, userId)).all()
  return c.json({ decks: result })
})

deck.get('/:id', async (c) => {
  const { userId } = getJwtPayload(c)
  const id = parseInt(c.req.param('id'))
  const result = await db.select().from(decks)
    .where(and(eq(decks.id, id), eq(decks.userId, userId))).get()
  if (!result) return c.json({ error: '未找到' }, 404)
  return c.json({ deck: result })
})

const createSchema = z.object({
  title: z.string().optional(),
  slidesJson: z.string().optional(),
  themeJson: z.string().optional(),
})

deck.post('/', zValidator('json', createSchema), async (c) => {
  const { userId } = getJwtPayload(c)
  const data = c.req.valid('json')
  const result = await db.insert(decks).values({ ...data, userId }).returning().get()
  return c.json({ deck: result }, 201)
})

const updateSchema = z.object({
  title: z.string().optional(),
  slidesJson: z.string().optional(),
  themeJson: z.string().optional(),
  version: z.number().int().optional(),
})

deck.put('/:id', zValidator('json', updateSchema), async (c) => {
  const { userId } = getJwtPayload(c)
  const id = parseInt(c.req.param('id'))

  const existing = await db.select().from(decks)
    .where(and(eq(decks.id, id), eq(decks.userId, userId))).get()
  if (!existing) return c.json({ error: '未找到' }, 404)

  if (c.req.valid('json').version !== undefined && c.req.valid('json').version! < existing.version) {
    return c.json({ error: '版本冲突，请刷新后重试', serverVersion: existing.version }, 409)
  }

  const data = c.req.valid('json')
  await db.update(decks).set({
    ...data,
    version: existing.version + 1,
    updatedAt: new Date(),
  }).where(eq(decks.id, id))

  return c.json({ ok: true, version: existing.version + 1 })
})

deck.delete('/:id', async (c) => {
  const { userId } = getJwtPayload(c)
  const id = parseInt(c.req.param('id'))
  await db.delete(decks).where(and(eq(decks.id, id), eq(decks.userId, userId)))
  return c.json({ ok: true })
})

export default deck
