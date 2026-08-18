/**
 * 会话管理
 *
 * 一个 deck 可以有多条会话线，每条各自独立记忆（见 orchestrator 的 resolveConversation）。
 * 「新开会话」= 记忆归零，这是它存在的意义。
 *
 * 注意路由顺序：具体路径（/by-deck/…、/:id/fork）必须在 '/:id' 之前注册。
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, desc, inArray, lte, sql } from 'drizzle-orm'
import { getJwtPayload } from '@server/auth/jwt'
import { db } from '@server/db'
import { conversations, messages, decks } from '@server/db/schema'
import { makeConversationTitle } from '@server/agent/history'

const conversation = new Hono()

/** 校验会话归属，顺带把行取回来 */
const ownedConversation = async (id: number, userId: number) => {
  if (Number.isNaN(id)) return null
  return db.select().from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    .get()
}

const listForDeck = async (userId: number, deckId: number) => {
  const rows = await db.select().from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.deckId, deckId)))
    .orderBy(desc(conversations.updatedAt))
    .all()

  if (!rows.length) return []

  // 消息数单独聚合再合并。
  //
  // 不用相关子查询：drizzle 在 sql`` 模板里把列渲染成**不带表前缀**的名字，
  // `WHERE ${messages.conversationId} = ${conversations.id}` 会变成
  // `WHERE "conversation_id" = "id"` —— 两边都落到 messages 上成了自比较，
  // 返回的不是报错而是一个看着挺合理的数字。
  const counts = await db.select({
    conversationId: messages.conversationId,
    count: sql<number>`count(*)`,
  }).from(messages)
    .where(inArray(messages.conversationId, rows.map(r => r.id)))
    .groupBy(messages.conversationId)
    .all()

  const countMap = new Map(counts.map(c => [c.conversationId, c.count]))

  return rows.map(r => ({ ...r, messageCount: countMap.get(r.id) ?? 0 }))
}

// ---------------------------------------------------------------------------
// 列表 / 读取
// ---------------------------------------------------------------------------

conversation.get('/', async (c) => {
  const { userId } = getJwtPayload(c)
  const deckId = c.req.query('deckId')

  if (deckId) {
    const parsed = parseInt(deckId)
    if (Number.isNaN(parsed)) return c.json({ error: 'deckId 非法' }, 400)
    return c.json({ conversations: await listForDeck(userId, parsed) })
  }

  const result = await db.select({
    id: conversations.id,
    deckId: conversations.deckId,
    title: conversations.title,
    createdAt: conversations.createdAt,
    updatedAt: conversations.updatedAt,
  }).from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))
    .all()

  return c.json({ conversations: result })
})

/**
 * 打开演示文稿时一次拿到：会话列表 + 最近活动那条的全部消息。
 * 省掉前端「先 list 再 get」的两次往返。
 */
conversation.get('/by-deck/:deckId', async (c) => {
  const { userId } = getJwtPayload(c)
  const deckId = parseInt(c.req.param('deckId'))
  if (Number.isNaN(deckId)) return c.json({ error: 'deckId 非法' }, 400)

  const list = await listForDeck(userId, deckId)
  if (!list.length) return c.json({ conversations: [], activeId: null, messages: [] })

  const active = list[0]
  const msgs = await db.select().from(messages)
    .where(eq(messages.conversationId, active.id))
    .orderBy(messages.id)
    .all()

  return c.json({ conversations: list, activeId: active.id, messages: msgs })
})

/** 清空某份演示文稿的全部会话（agent 记忆一并归零） */
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

// ---------------------------------------------------------------------------
// 新建 / 分叉
// ---------------------------------------------------------------------------

const createSchema = z.object({
  deckId: z.number().int(),
  title: z.string().max(120).optional(),
})

conversation.post('/', zValidator('json', createSchema), async (c) => {
  const { userId } = getJwtPayload(c)
  const { deckId, title } = c.req.valid('json')

  const deck = await db.select({ id: decks.id }).from(decks)
    .where(and(eq(decks.id, deckId), eq(decks.userId, userId))).get()
  if (!deck) return c.json({ error: '演示文稿不存在' }, 404)

  const created = await db.insert(conversations)
    .values({ userId, deckId, title: title?.trim() || '新会话' })
    .returning()
    .get()

  return c.json({ conversation: { ...created, messageCount: 0 } }, 201)
})

const forkSchema = z.object({
  /** 从哪条消息之前分叉；含这条。不传则整条复制 */
  fromMessageId: z.number().int().optional(),
  title: z.string().max(120).optional(),
})

/**
 * 从某条消息分叉出新会话。
 *
 * 复制 messages[起点..fromMessageId]，**deck 不动** ——
 * 会话是聊天线程，演示文稿是单一可变文档，分叉只分叉对话不分叉画布。
 * 想回到那次生成的样子需要快照，是另一回事。
 */
conversation.post('/:id/fork', zValidator('json', forkSchema), async (c) => {
  const { userId } = getJwtPayload(c)
  const id = parseInt(c.req.param('id'))
  const { fromMessageId, title } = c.req.valid('json')

  const source = await ownedConversation(id, userId)
  if (!source) return c.json({ error: '对话不存在' }, 404)

  const rows = await db.select().from(messages)
    .where(fromMessageId === undefined
      ? eq(messages.conversationId, id)
      : and(eq(messages.conversationId, id), lte(messages.id, fromMessageId)))
    .orderBy(messages.id)
    .all()

  if (!rows.length) return c.json({ error: '分叉点之前没有内容' }, 400)

  const firstUser = rows.find(m => m.role === 'user')
  const forked = await db.insert(conversations).values({
    userId,
    deckId: source.deckId,
    title: title?.trim() || makeConversationTitle(firstUser?.content ?? source.title),
    forkedFromId: source.id,
  }).returning().get()

  await db.insert(messages).values(rows.map(m => ({
    conversationId: forked.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
  })))

  return c.json({ conversation: { ...forked, messageCount: rows.length } }, 201)
})

// ---------------------------------------------------------------------------
// 单条：读 / 改名 / 删
// ---------------------------------------------------------------------------

conversation.get('/:id', async (c) => {
  const { userId } = getJwtPayload(c)
  const id = parseInt(c.req.param('id'))

  const conv = await ownedConversation(id, userId)
  if (!conv) return c.json({ error: '对话不存在' }, 404)

  const msgs = await db.select().from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.id)
    .all()

  return c.json({ conversation: conv, messages: msgs })
})

const renameSchema = z.object({ title: z.string().min(1).max(120) })

conversation.patch('/:id', zValidator('json', renameSchema), async (c) => {
  const { userId } = getJwtPayload(c)
  const id = parseInt(c.req.param('id'))
  const { title } = c.req.valid('json')

  const conv = await ownedConversation(id, userId)
  if (!conv) return c.json({ error: '对话不存在' }, 404)

  await db.update(conversations).set({ title: title.trim() }).where(eq(conversations.id, id))
  return c.json({ ok: true, title: title.trim() })
})

conversation.delete('/:id', async (c) => {
  const { userId } = getJwtPayload(c)
  const id = parseInt(c.req.param('id'))

  const conv = await ownedConversation(id, userId)
  if (!conv) return c.json({ error: '对话不存在' }, 404)

  await db.delete(messages).where(eq(messages.conversationId, id))
  await db.delete(conversations).where(eq(conversations.id, id))

  return c.json({ ok: true })
})

export default conversation
