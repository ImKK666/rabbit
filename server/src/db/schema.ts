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

/**
 * 资产票据表 —— 一张图从「要一张」到「拿到了」的全过程。
 *
 * ## 它不是一个异步队列
 *
 * 工具是**同步等图**的（生图 14~15 秒实测），拿到结果才返回给 agent，
 * 由 agent 自己调 `addElement` 写进 deck。所以这张表不承担「后台回填」的职责 ——
 * 那条路会和 B 期刚立的两条契约正面冲突（见 `domains/deck/assetTools.ts` 头注释）。
 *
 * 它承担的是另外四件事：
 *   1. **署名可反查**：合规要求「必须署名」，attribution 得能从 hash 查回来
 *   2. **审计**：哪张图哪来的、什么 prompt、压缩前后多大、为什么是这个结果
 *   3. **状态**：pending / ready / failed。进程中途死掉时留下的 pending 行
 *      由启动时的清扫改成 failed，否则它会永远挂着
 *   4. **票据 id**：`agent.asset.pending` / `.ready` 两条消息靠它配对
 *
 * ## 为什么 userId / deckId 都不加外键
 *
 * 加了之后「删用户」「删演示文稿」会被资产行挡住，报
 * `FOREIGN KEY constraint failed` —— 正是第三轮那个「agent 用过的演示文稿删不掉」
 * 的坑。资产的来源没了就当孤儿，不影响任何功能，
 * 而一条删不掉的记录会直接变成 500。和 `conversations.forkedFromId` 同一个判断。
 */
export const assets = sqliteTable('assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 票据 id。进 `agent.asset.pending` / `.ready`，让面板把「开始」和「拿到」对上 */
  ticket: text('ticket').notNull().unique(),
  kind: text('kind', { enum: ['search', 'generate'] }).notNull(),
  status: text('status', { enum: ['pending', 'ready', 'failed'] }).notNull().default('pending'),
  /** 谁触发的。**不加外键**，理由见上 */
  userId: integer('user_id').notNull(),
  /** 哪份文稿触发的。**不加外键**，理由见上 */
  deckId: integer('deck_id'),
  /** 搜图是关键词，生图是 prompt */
  prompt: text('prompt').notNull(),
  /** 图库名（`pixabay`）或生图模型的显示名 */
  source: text('source').notNull().default(''),
  /** 内容寻址的 sha256。`ready` 才有 */
  hash: text('hash'),
  /** 对象存储里的 key，删图时用 */
  storageKey: text('storage_key'),
  width: integer('width'),
  height: integer('height'),
  /** 落库（上传）时的字节数 */
  bytes: integer('bytes'),
  /** 压缩前的字节数。和 bytes 一起就能看出压缩到底有没有起作用 */
  originalBytes: integer('original_bytes'),
  /** `recoded` / `resized-and-recoded` / `kept-transparent` / `kept-as-is` */
  compressReason: text('compress_reason'),
  /** 合规②：署名三件套。`attribution` 字段留了不等于兑现了，所以这里是真存 */
  attributionAuthor: text('attribution_author'),
  attributionSource: text('attribution_source'),
  attributionUrl: text('attribution_url'),
  /** `failed` 时的原因 */
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

/**
 * 搜图请求缓存 —— 图库的硬性要求（24 小时）。
 *
 * 落库而不是放内存：进程重启一次就把缓存清空的话，等于没缓存过，
 * 而这条是**合规要求**不是性能优化。键与过期判定见 `runtime/searchCache.ts`。
 */
export const assetSearchCache = sqliteTable('asset_search_cache', {
  /** sha256(provider|归一化查询|lang|limit) */
  key: text('key').primaryKey(),
  provider: text('provider').$type<AssetSearchProvider>().notNull(),
  /** 原始查询词。只为排查时看得懂，命中判定只认 key */
  query: text('query').notNull(),
  /** `ImageCandidate[]` 的 JSON */
  candidatesJson: text('candidates_json').notNull(),
  fetchedAt: integer('fetched_at', { mode: 'timestamp' }).notNull(),
})

/**
 * Agent 的种类。
 *
 * **R-51 之前这里是 `'planner' | 'generator' | 'reviewer' | 'editor'` 四个值**，
 * 对应四个角色各跑一次模型。合并成一个 agent 之后只剩 `'deck'`。
 * 实测代价与合并理由见 docs/12-single-agent.md。
 *
 * **这一维刻意保留，没有把 role 这个字段整个删掉。** `role_defaults` 和
 * `user_role_preferences` 两张表按它分行 —— 删掉等于「一个用户只能配一个模型」，
 * 而第二个域（research）接进来时马上就要按域配不同的模型。
 * 现在它只有一个值，不代表它是多余的。
 *
 * **列表和类型是同一份。** 原来 `z.enum(['planner','generator','reviewer','editor'])`
 * 在 `routes/admin.ts` 和 `routes/user.ts` 里各硬抄了一份，
 * 加一个角色要改三处、漏一处不会有任何东西报错。现在两边都从这里取。
 */
export const AGENT_ROLES = ['deck'] as const
export type AgentRole = typeof AGENT_ROLES[number]

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
  /**
   * 给人看的那一份 —— 面板渲染、会话标题、分叉锚点都读它。
   * **这一列的语义没变**，加 `blocksJson` 时刻意没动它：
   * 改它等于同时改渲染、标题、分叉三件事。
   */
  content: text('content').notNull(),
  /**
   * 给模型看的那一份：这条消息的完整 content 数组
   * （`runtime/turnMemory.ts` 的 `AssistantBlock[]` / `ToolResultBlock[]`）。
   *
   * **可空**。老会话没有这一列，读回来时退回纯文本路径，
   * 所以这次迁移不需要回填 —— 回填一份猜出来的 blocks 比没有更糟。
   */
  blocksJson: text('blocks_json'),
  /**
   * 产出这条消息的模型配置。
   *
   * 存它只为一件事：**Anthropic 的 thinking signature 绑在生成它的 API key 上**，
   * 管理员换一次 provider 或 key，库里的旧 signature 会让下一次请求直接 400。
   * 对不上就把思考块剥掉，见 `turnMemory.ts` 的 `stripForeignReasoning`。
   *
   * **刻意不加外键**：模型配置被删掉时这条历史仍然有效
   *（只是从此按「对不上」处理），加了外键反而会让删配置被历史挡住 ——
   * 和 `conversations.forkedFromId` 是同一个理由。
   */
  modelConfigId: integer('model_config_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})
