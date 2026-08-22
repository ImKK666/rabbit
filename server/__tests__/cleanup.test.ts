/**
 * 后台「删除渠道 / 用户」级联清理的判据 —— db/cleanup.ts
 *
 * ## 为什么这个文件在 server/__tests__/ 而不是 src 下的测试目录
 *
 * 根目录的 `npx vitest run` 会扫 server/src 下所有测试目录，而 vitest 跑在
 * node 里 —— **node 加载不了 `bun:sqlite`**（这也是整个代码库「不把碰库的文件
 * import 进测试」那条纪律的由来）。放在 src 之外，vitest 看不见它，
 * 而 `bun test`（server 目录下）照常发现并运行。
 *
 * ## 数据库从哪来
 *
 * `:memory:` + 把 drizzle/ 里全部迁移 SQL 按序执行 —— 不 import `@server/db`
 * （它会 migrate 到真库 `data/rabbit.db`，测试绝不许碰）。
 * drizzle 的迁移文件里带 `--> statement-breakpoint` 分隔符（那是给 migrator
 * 看的，不是 SQLite 注释），所以按它切开逐条 exec。
 */

import { describe, it, expect } from 'vitest'
import { Database } from 'bun:sqlite'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { eq } from 'drizzle-orm'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as schema from '@server/db/schema'
import {
  deleteProviderCascade, deleteModelConfigCascade, deleteUserCascade,
} from '@server/db/cleanup'

const MIGRATIONS_DIR = join(import.meta.dir, '../drizzle')

const makeDb = (): BunSQLiteDatabase<typeof schema> => {
  const sqlite = new Database(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  const db = drizzle(sqlite, { schema })

  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')
    for (const stmt of sql.split(/--> statement-breakpoint/)) {
      if (stmt.trim()) db.run(stmt)
    }
  }
  return db
}

const makeUser = (db: BunSQLiteDatabase<typeof schema>, username: string) =>
  db.insert(schema.users)
    .values({ username, passwordHash: 'x' })
    .returning().get()

const makeProvider = (db: BunSQLiteDatabase<typeof schema>, name: string) =>
  db.insert(schema.modelProviders)
    .values({ name, providerType: 'openai', baseUrl: `https://${name}.example.com`, apiKey: `key-${name}` })
    .returning().get()

const makeConfig = (db: BunSQLiteDatabase<typeof schema>, providerId: number, modelName: string) =>
  db.insert(schema.modelConfigs)
    .values({ providerId, modelName, displayName: modelName })
    .returning().get()

describe('deleteProviderCascade · 删服务商连带清引用', () => {
  it('删掉服务商 → 名下配置没了，角色默认 / 用户偏好删行，生图选择置空，计数逐项对', () => {
    const db = makeDb()
    const user = makeUser(db, 'u1')
    const p1 = makeProvider(db, 'p1')
    const p2 = makeProvider(db, 'p2')
    const c1 = makeConfig(db, p1.id, 'm1')
    const c2 = makeConfig(db, p1.id, 'm2')
    const c3 = makeConfig(db, p2.id, 'm3')

    db.insert(schema.roleDefaults).values({ role: 'deck', modelConfigId: c1.id }).run()
    db.insert(schema.userRolePreferences).values({ userId: user.id, role: 'deck', modelConfigId: c2.id }).run()
    db.insert(schema.assetSources).values({ id: 1, imageModelConfigId: c1.id }).run()

    const counts = deleteProviderCascade(db, p1.id)
    expect(counts).toEqual({
      deletedModels: 2, clearedRoleDefaults: 1, clearedUserPrefs: 1, clearedAssetSources: 1,
    })

    // 上游和引用清干净
    expect(db.select().from(schema.modelProviders).where(eq(schema.modelProviders.id, p1.id)).get()).toBeUndefined()
    expect(db.select().from(schema.modelConfigs).where(eq(schema.modelConfigs.id, c1.id)).get()).toBeUndefined()
    expect(db.select().from(schema.modelConfigs).where(eq(schema.modelConfigs.id, c2.id)).get()).toBeUndefined()
    expect(db.select().from(schema.roleDefaults).all()).toEqual([])
    expect(db.select().from(schema.userRolePreferences).all()).toEqual([])
    expect(db.select().from(schema.assetSources).where(eq(schema.assetSources.id, 1)).get()?.imageModelConfigId).toBeNull()

    // **负对照**：别的服务商的配置一个都没被动
    expect(db.select().from(schema.modelConfigs).where(eq(schema.modelConfigs.id, c3.id)).get()?.id).toBe(c3.id)
  })

  it('没有配置的服务商也能删 —— 全零计数，不误报', () => {
    const db = makeDb()
    const p = makeProvider(db, 'solo')
    const counts = deleteProviderCascade(db, p.id)
    expect(counts).toEqual({ deletedModels: 0, clearedRoleDefaults: 0, clearedUserPrefs: 0, clearedAssetSources: 0 })
    expect(db.select().from(schema.modelProviders).where(eq(schema.modelProviders.id, p.id)).get()).toBeUndefined()
  })

  it('**负对照**：不级联直接删会撞外键 —— 这正是这个文件存在的理由', () => {
    const db = makeDb()
    const p = makeProvider(db, 'p')
    makeConfig(db, p.id, 'm')
    expect(() => db.delete(schema.modelProviders).where(eq(schema.modelProviders.id, p.id)).run())
      .toThrow(/FOREIGN KEY/i)
  })
})

describe('deleteModelConfigCascade · 删单个模型配置', () => {
  it('被角色默认 / 生图选择引用时清干净，别的配置不动', () => {
    const db = makeDb()
    const p = makeProvider(db, 'p')
    const c1 = makeConfig(db, p.id, 'm1')
    const c2 = makeConfig(db, p.id, 'm2')

    db.insert(schema.roleDefaults).values({ role: 'reflect', modelConfigId: c1.id }).run()
    db.insert(schema.assetSources).values({ id: 1, imageModelConfigId: c1.id }).run()
    db.insert(schema.roleDefaults).values({ role: 'deck', modelConfigId: c2.id }).run()

    const counts = deleteModelConfigCascade(db, c1.id)
    expect(counts).toEqual({ deletedModels: 1, clearedRoleDefaults: 1, clearedUserPrefs: 0, clearedAssetSources: 1 })

    expect(db.select().from(schema.modelConfigs).where(eq(schema.modelConfigs.id, c1.id)).get()).toBeUndefined()
    expect(db.select().from(schema.roleDefaults).where(eq(schema.roleDefaults.role, 'reflect')).get()).toBeUndefined()
    // c2 的角色默认原样还在
    expect(db.select().from(schema.roleDefaults).where(eq(schema.roleDefaults.role, 'deck')).get()?.modelConfigId).toBe(c2.id)
  })

  it('**负对照**：被引用的配置直接删同样撞外键', () => {
    const db = makeDb()
    const p = makeProvider(db, 'p')
    const c = makeConfig(db, p.id, 'm')
    db.insert(schema.roleDefaults).values({ role: 'deck', modelConfigId: c.id }).run()
    expect(() => db.delete(schema.modelConfigs).where(eq(schema.modelConfigs.id, c.id)).run())
      .toThrow(/FOREIGN KEY/i)
  })
})

describe('deleteUserCascade · 删用户连带清名下一切', () => {
  it('演示文稿 / 会话 / 消息 / 角色偏好全部清掉，计数逐项对', () => {
    const db = makeDb()
    const victim = makeUser(db, 'victim')
    const other = makeUser(db, 'other')
    const p = makeProvider(db, 'p')
    const c = makeConfig(db, p.id, 'm')

    const deck = db.insert(schema.decks).values({ userId: victim.id, title: 'd1' }).returning().get()
    const conv = db.insert(schema.conversations).values({ userId: victim.id, deckId: deck.id }).returning().get()
    db.insert(schema.messages).values({ conversationId: conv.id, role: 'user', content: 'hi' }).run()
    db.insert(schema.userRolePreferences).values({ userId: victim.id, role: 'deck', modelConfigId: c.id }).run()

    // 别人的数据 —— 负对照，必须原样留下
    const otherDeck = db.insert(schema.decks).values({ userId: other.id, title: 'd2' }).returning().get()

    const counts = deleteUserCascade(db, victim.id)
    expect(counts).toEqual({ deletedDecks: 1, deletedConversations: 1, deletedMessages: 1, clearedUserPrefs: 1 })

    expect(db.select().from(schema.users).where(eq(schema.users.id, victim.id)).get()).toBeUndefined()
    expect(db.select().from(schema.decks).where(eq(schema.decks.id, deck.id)).get()).toBeUndefined()
    expect(db.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)).get()).toBeUndefined()
    expect(db.select().from(schema.messages).where(eq(schema.messages.conversationId, conv.id)).get()).toBeUndefined()
    expect(db.select().from(schema.userRolePreferences).where(eq(schema.userRolePreferences.userId, victim.id)).all()).toEqual([])

    expect(db.select().from(schema.decks).where(eq(schema.decks.id, otherDeck.id)).get()?.id).toBe(otherDeck.id)
    expect(db.select().from(schema.users).where(eq(schema.users.id, other.id)).get()?.id).toBe(other.id)
  })

  it('**负对照**：有文稿的用户直接删会撞外键', () => {
    const db = makeDb()
    const u = makeUser(db, 'u')
    db.insert(schema.decks).values({ userId: u.id, title: 'd' }).run()
    expect(() => db.delete(schema.users).where(eq(schema.users.id, u.id)).run())
      .toThrow(/FOREIGN KEY/i)
  })
})
