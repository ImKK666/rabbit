import { Hono } from 'hono'
import { eq, and, desc, inArray } from 'drizzle-orm'
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

/**
 * 按 deck 直接取会话历史。
 *
 * 一个 deck 一条会话线（见 orchestrator 的 getOrCreateConversation），
 * 所以前端打开某份演示文稿时一次调用就够，不用先 list 再 get。
 * deck 从没跑过 agent 时返回空数组，不是 404。
 *
 * 注意：这条路由必须在 '/:id' 之前注册。
 */
conversation.get('/by-deck/:deckId', async (c) => {
  const { userId } = getJwtPayload(c)
  const deckId = parseInt(c.req.param('deckId'))
  if (Number.isNaN(deckId)) return c.json({ error: 'deckId 非法' }, 400)

  const conv = await db.select().from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.deckId, deckId)))
    .orderBy(conversations.id)
    .get()

  if (!conv) return c.json({ conversationId: null, messages: [] })

  const msgs = await db.select().from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(messages.id)
    .all()

  return c.json({ conversationId: conv.id, messages: msgs })
})

/** 清空某份演示文稿的会话历史（agent 的记忆也一并归零） */
conversation.delete('/by-deck/:deckId', async (c) => {
  const { userId } = getJwtPayload(c)
  const deckId = parseInt(c.req.param('deckId'))
  if (Number.isNaN(deckId)) return c.json({ error: 'deckId 非法' }, 400)

  const convs = await db.select({ id: conversations.id }).from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.deckId, deckId)))
    .all()

  if (convs.length) {
    await db.delete(messages).where(inArray(messages.conversationId, convs.map(cv => cv.id)))
    await db.delete(conversations).where(and(
      eq(conversations.userId, userId),
      eq(conversations.deckId, deckId),
    ))
  }

  return c.json({ ok: true, cleared: convs.length })
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
