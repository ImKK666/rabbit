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
  providerType: text('provider_type', { enum: ['openai', 'anthropic', 'google', 'deepseek'] }).notNull(),
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
  /**
   * 每分钟最多调用几次。**null = 不限**。
   *
   * 为生图模型加的：实测 `gemini-3.1-flash-image` 连发第 4 张就
   * `429 Resource has been exhausted`。限流放在我们这边，是为了让「配额用完」
   * 变成一个**可预期、可回退**的结果（工具回一句「改用搜图」），
   * 而不是等上游甩 429 才手忙脚乱。
   *
   * 按模型配而不是按 provider：同一个 provider 下文本模型和生图模型的
   * 配额完全不是一个量级。
   */
  rateLimitPerMin: integer('rate_limit_per_min'),
})

/**
 * 对象存储配置 —— 图片资产存哪儿。
 *
 * **单行表**（约定 id=1）。做成表而不是环境变量，是因为它要能在设置界面里
 * 改 + 测；做成表而不是通用 KV，是因为 `secretKey` 必须有一条硬规矩：
 * **永不回传给前端**。命名列上强制这条比在 JSON blob 里强制容易得多。
 */
export const storageConfigs = sqliteTable('storage_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 目前只实现了腾讯云 COS，留字段是为了以后加 S3 / R2 时不用改表 */
  provider: text('provider', { enum: ['cos'] }).notNull().default('cos'),
  secretId: text('secret_id').notNull().default(''),
  /** **永不出现在任何响应里**，前端只能看到 hasSecretKey: boolean */
  secretKey: text('secret_key').notNull().default(''),
  bucket: text('bucket').notNull().default(''),
  region: text('region').notNull().default(''),
  /** key 前缀，如 `rabbit/`。和别的用途共用一个桶时靠它隔离 */
  prefix: text('prefix').notNull().default('rabbit/'),
  /**
   * 对外访问的基地址。留空则由 bucket + region 推出默认域名；
   * 挂了 CDN 或自定义域名时在这里覆盖。
   */
  publicBaseUrl: text('public_base_url').notNull().default(''),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

/** 搜图用哪家。`wikimedia` 免 key，其余都要 */
export type AssetSearchProvider = 'wikimedia' | 'pexels' | 'unsplash' | 'pixabay'

/**
 * 素材来源配置 —— 图从哪来。
 *
 * 单行表（id=1）。生图和搜图**刻意分开配**：它们是两个独立的 agent 工具，
 * 代价完全不同（生图 15~50s、配额紧；搜图 ~1s、配额松），
 * 生图被限流时 agent 可以自己改用搜图。
 */
export const assetSources = sqliteTable('asset_sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  searchProvider: text('search_provider').$type<AssetSearchProvider>().notNull().default('wikimedia'),
  /** wikimedia 不需要；其余为空则搜图不可用 */
  searchApiKey: text('search_api_key').notNull().default(''),
  searchEnabled: integer('search_enabled', { mode: 'boolean' }).notNull().default(false),
  /** 生图用哪个模型，指向 model_configs。为空则生图不可用 */
  imageModelConfigId: integer('image_model_config_id').references(() => modelConfigs.id),
  generateEnabled: integer('generate_enabled', { mode: 'boolean' }).notNull().default(false),
  /** 落库前把长边压到这个像素以内。实测生图单张 1~2MB，一份 deck 配 8 张就 16MB */
  maxEdgePx: integer('max_edge_px').notNull().default(1600),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
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
