import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, inArray } from 'drizzle-orm'
import { getJwtPayload } from '@server/auth/jwt'
import { db } from '@server/db'
import { decks, conversations, messages } from '@server/db/schema'

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

  const existing = await db.select({ id: decks.id }).from(decks)
    .where(and(eq(decks.id, id), eq(decks.userId, userId))).get()
  if (!existing) return c.json({ error: '未找到' }, 404)

  // conversations.deckId 和 messages.conversationId 都是外键，且 PRAGMA foreign_keys = ON，
  // 直接删 deck 会 FOREIGN KEY constraint failed ——
  // 表现就是「agent 用过的文稿删不掉，没用过的能删」。必须自底向上清。
  const convs = await db.select({ id: conversations.id }).from(conversations)
    .where(eq(conversations.deckId, id)).all()

  if (convs.length) {
    await db.delete(messages).where(inArray(messages.conversationId, convs.map(cv => cv.id)))
    await db.delete(conversations).where(eq(conversations.deckId, id))
  }

  await db.delete(decks).where(and(eq(decks.id, id), eq(decks.userId, userId)))

  return c.json({ ok: true })
})

export default deck
