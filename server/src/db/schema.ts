import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export const modelProviders = sqliteTable('model_providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  providerType: text('provider_type', { enum: ['openai', 'anthropic', 'google'] }).notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull(),
  remark: text('remark').default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export const modelConfigs = sqliteTable('model_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  providerId: integer('provider_id').notNull().references(() => modelProviders.id),
  modelName: text('model_name').notNull(),
  displayName: text('display_name').notNull(),
  supportsImages: integer('supports_images', { mode: 'boolean' }).notNull().default(false),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
})

export type AgentRole = 'planner' | 'generator' | 'reviewer' | 'editor'

export const roleDefaults = sqliteTable('role_defaults', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  role: text('role').$type<AgentRole>().notNull().unique(),
  modelConfigId: integer('model_config_id').notNull().references(() => modelConfigs.id),
})

export const userRolePreferences = sqliteTable('user_role_preferences', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id),
  role: text('role').$type<AgentRole>().notNull(),
  modelConfigId: integer('model_config_id').notNull().references(() => modelConfigs.id),
})

export const decks = sqliteTable('decks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id),
  title: text('title').notNull().default('未命名演示文稿'),
  slidesJson: text('slides_json').notNull().default('[]'),
  themeJson: text('theme_json'),
  version: integer('version').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export const conversations = sqliteTable('conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id),
  deckId: integer('deck_id').notNull().references(() => decks.id),
  title: text('title').notNull().default('新会话'),
  /**
   * 分叉来源会话 id。**刻意不加外键约束** ——
   * 加了之后删除父会话会被子会话挡住，正是 deck 删不掉的那个坑的翻版。
   * 来源没了就当普通会话，不影响使用。
   */
  forkedFromId: integer('forked_from_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversationId: integer('conversation_id').notNull().references(() => conversations.id),
  role: text('role', { enum: ['user', 'assistant', 'system', 'tool'] }).notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})
