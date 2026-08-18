import { Hono } from 'hono'
import { eq, and, desc } from 'drizzle-orm'
import { getJwtPayload } from '@server/auth/jwt'
import { db } from '@server/db'
import { conversations, messages } from '@server/db/schema'

const conversation = new Hono()

conversation.get('/', async (c) => {
  const { userId } = getJwtPayload(c)
  const deckId = c.req.query('deckId')

  let query = db.select({
    id: conversations.id,
    deckId: conversations.deckId,
    createdAt: conversations.createdAt,
  }).from(conversations).where(eq(conversations.userId, userId))

  if (deckId) {
    query = db.select({
      id: conversations.id,
      deckId: conversations.deckId,
      createdAt: conversations.createdAt,
    }).from(conversations).where(and(
      eq(conversations.userId, userId),
      eq(conversations.deckId, parseInt(deckId)),
    ))
  }

  const result = await query.orderBy(desc(conversations.createdAt)).all()
  return c.json({ conversations: result })
})

conversation.get('/:id', async (c) => {
  const { userId } = getJwtPayload(c)
  const id = parseInt(c.req.param('id'))

  const conv = await db.select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    .get()
  if (!conv) return c.json({ error: '对话不存在' }, 404)

  const msgs = await db.select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt)
    .all()

  return c.json({ conversation: conv, messages: msgs })
})

conversation.delete('/:id', async (c) => {
  const { userId } = getJwtPayload(c)
  const id = parseInt(c.req.param('id'))

  const conv = await db.select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    .get()
  if (!conv) return c.json({ error: '对话不存在' }, 404)

  await db.delete(messages).where(eq(messages.conversationId, id))
  await db.delete(conversations).where(eq(conversations.id, id))

  return c.json({ ok: true })
})

export default conversation
