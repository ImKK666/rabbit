/**
 * 后台删除渠道 / 用户时的**引用清理**（自底向上的级联删）
 *
 * ## 为什么这个文件存在
 *
 * `PRAGMA foreign_keys = ON`（db/index.ts）+ 三张表互相引用：
 *
 *   model_providers ← model_configs（providerId）
 *   model_configs  ← role_defaults / user_role_preferences / asset_sources
 *   users          ← decks / conversations / user_role_preferences
 *   decks          ← conversations；conversations ← messages
 *
 * 直接删上游会撞 `FOREIGN KEY constraint failed` —— 表现就是：
 * 「有模型配置的服务商删不掉、被角色默认引用的模型删不掉、
 * 用过 agent 的用户删不掉，没关联的却能删」。删除按钮一按一个 500。
 *
 * 语义选**级联**而不是拒绝：确认框里已经承诺「关联的也会失效」，
 * 拒绝反而让管理员删不掉东西。删掉引用行之后各方都会安全回落：
 *   - 角色默认没了 → agent 报「角色还没有配置模型」（llm.ts 的 miss 路径）
 *   - 生图配置没了 → 生图能力关闭（assetConfig 的 ok:false 路径）
 *
 * 和 routes/deck.ts 里删 deck 的自底向上清法同一套纪律。
 *
 * ## 为什么函数收 `db` 参数而不是直接 import
 *
 * 直接 import `@server/db` 会把这个文件变成「只能在后端进程里加载」——
 * 测试想在内存库上跑判据就做不到了。传参让生产用真库、测试用 :memory:，
 * 同一个实现两处都能验。**测试在 `server/__tests__/cleanup.test.ts`**
 * （bun 专属：node 的 vitest 加载不了 `bun:sqlite`，见那文件头注释）。
 */

import { eq, inArray } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import * as schema from './schema'

export interface ModelCleanupCounts {
  deletedModels: number
  clearedRoleDefaults: number
  clearedUserPrefs: number
  clearedAssetSources: number
}

export interface UserCleanupCounts {
  deletedDecks: number
  deletedConversations: number
  deletedMessages: number
  clearedUserPrefs: number
}

const zeroModel = (): ModelCleanupCounts => ({
  deletedModels: 0, clearedRoleDefaults: 0, clearedUserPrefs: 0, clearedAssetSources: 0,
})

/**
 * 删一个模型配置，并清掉所有指向它的行：
 * 角色默认 / 用户偏好是**删行**（回到「未配置」，agent 报错提示管理员重配）；
 * 素材来源的生图选择是**置空**（生图能力关掉，而不是留着指向死配置）。
 */
export const deleteModelConfigCascade = (
  db: BunSQLiteDatabase<typeof schema>,
  configId: number,
): ModelCleanupCounts => {
  const rd = db.delete(schema.roleDefaults)
    .where(eq(schema.roleDefaults.modelConfigId, configId))
    .returning()
    .all()
  const up = db.delete(schema.userRolePreferences)
    .where(eq(schema.userRolePreferences.modelConfigId, configId))
    .returning()
    .all()
  const asrc = db.update(schema.assetSources)
    .set({ imageModelConfigId: null })
    .where(eq(schema.assetSources.imageModelConfigId, configId))
    .returning()
    .all()
  db.delete(schema.modelConfigs).where(eq(schema.modelConfigs.id, configId)).run()

  return {
    deletedModels: 1,
    clearedRoleDefaults: rd.length,
    clearedUserPrefs: up.length,
    clearedAssetSources: asrc.length,
  }
}

/** 删一个服务商 = 先把它名下的每个模型配置按上面的规则清掉，再删服务商 */
export const deleteProviderCascade = (
  db: BunSQLiteDatabase<typeof schema>,
  providerId: number,
): ModelCleanupCounts => {
  const configs = db.select({ id: schema.modelConfigs.id })
    .from(schema.modelConfigs)
    .where(eq(schema.modelConfigs.providerId, providerId))
    .all()

  const totals = zeroModel()
  for (const cfg of configs) {
    const r = deleteModelConfigCascade(db, cfg.id)
    totals.deletedModels += r.deletedModels
    totals.clearedRoleDefaults += r.clearedRoleDefaults
    totals.clearedUserPrefs += r.clearedUserPrefs
    totals.clearedAssetSources += r.clearedAssetSources
  }
  db.delete(schema.modelProviders).where(eq(schema.modelProviders.id, providerId)).run()
  return totals
}

/**
 * 删一个用户 = 自底向上清掉他的一切，再删本人。
 *
 * assets 表**没有外键**（schema.ts 里「不加外键，理由见上」），
 * 它的行是内容寻址的产物，删用户时不碰 —— 留着不伤任何查询。
 */
export const deleteUserCascade = (
  db: BunSQLiteDatabase<typeof schema>,
  userId: number,
): UserCleanupCounts => {
  const convs = db.select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(eq(schema.conversations.userId, userId))
    .all()

  let deletedMessages = 0
  if (convs.length) {
    const msg = db.delete(schema.messages)
      .where(inArray(schema.messages.conversationId, convs.map(cv => cv.id)))
      .returning()
      .all()
    deletedMessages = msg.length
  }
  const delConvs = db.delete(schema.conversations)
    .where(eq(schema.conversations.userId, userId))
    .returning()
    .all()

  const delDecks = db.delete(schema.decks)
    .where(eq(schema.decks.userId, userId))
    .returning()
    .all()

  const prefs = db.delete(schema.userRolePreferences)
    .where(eq(schema.userRolePreferences.userId, userId))
    .returning()
    .all()

  db.delete(schema.users).where(eq(schema.users.id, userId)).run()

  return {
    deletedDecks: delDecks.length,
    deletedConversations: delConvs.length,
    deletedMessages,
    clearedUserPrefs: prefs.length,
  }
}
