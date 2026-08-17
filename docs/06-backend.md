# 06 · 后端架构

前端基座（PPTist fork）已完成 19/24 项改动，本文档记录后端技术决策。

## 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | **Bun** | Deck Kernel 直接 import `src/types/slides.ts`，不用翻译成 pydantic |
| HTTP 框架 | **Hono** | Bun-first，轻量，WebSocket / 中间件 / 验证都有 |
| LLM 封装 | **Vercel AI SDK**（`ai` + `@ai-sdk/openai` / `@ai-sdk/anthropic` / `@ai-sdk/google`） | 统一接口，streaming + tool use，三家都支持自定义 baseURL |
| 数据库 | **SQLite**（`bun:sqlite`，零依赖） | |
| ORM | **Drizzle** | 类型安全，原生支持 bun:sqlite |
| 认证 | **JWT**（`hono/jwt` + `Bun.password`） | MVP 账号密码，OAuth 后补 |
| 校验 | **Zod** | Drizzle + Hono 都原生配合 |

### 不用 Python 的原因

03-architecture.md 原定 FastAPI，改掉的理由只有一条但足够大：

`types/slides.ts` 有 80+ 个类型（`Slide` / `PPTElement` / `PPTAnimation` …），
`configs/animation.ts` 有 25 个效果定义带 PPTX preset，
`utils/ooxml/` 有 spid 解析器和 timing 生成器——
**Python 方案要把这些全部翻译成 pydantic 并永久保持同步。Bun 方案直接 import。**

## 项目结构

```
/
├── src/                        ← 前端（现有）
│   ├── types/slides.ts         ← 后端直接 import
│   ├── configs/animation.ts    ← 后端直接 import
│   └── utils/ooxml/            ← 后端直接 import
├── server/                     ← 后端（新）
│   ├── package.json
│   ├── tsconfig.json           ← paths: { "@/*": ["../src/*"] }
│   ├── src/
│   │   ├── index.ts            ← Hono 入口
│   │   ├── db/
│   │   │   ├── schema.ts       ← Drizzle schema
│   │   │   └── index.ts        ← 连接
│   │   ├── routes/
│   │   │   ├── auth.ts         ← 登录 / 注册
│   │   │   ├── admin.ts        ← 管理员配置
│   │   │   └── deck.ts         ← Deck CRUD
│   │   ├── ws/
│   │   │   └── handler.ts      ← WebSocket（agent 通信）
│   │   ├── agent/
│   │   │   ├── roles.ts        ← 4 个角色定义
│   │   │   ├── tools.ts        ← agent 可调用的工具
│   │   │   └── kernel.ts       ← Deck Kernel（校验 / lint）
│   │   └── auth/
│   │       └── jwt.ts          ← token 签发 / 验证
│   └── drizzle.config.ts
└── docs/
```

`server/tsconfig.json` 的 `paths` 把 `@/*` 指向 `../src/*`，
这样共享代码里的 `import ... from '@/types/slides'` 在前后端都能解析。

## 用户体系

| 角色 | 能做什么 |
|---|---|
| **管理员** | 配置 provider（baseURL / apiKey）、设模型白名单、设各角色全局默认模型 |
| **普通用户** | 在白名单内选自己每个角色的偏好模型、使用全部功能 |

## Agent 角色

| 角色 | 职责 | 模型要求 |
|---|---|---|
| **Planner** | 拆解用户意图，决定每页内容 / 配图 | 理解力强，不需要多模态 |
| **Generator** | 生成 deck JSON，调工具填充内容 | tool use 能力强 |
| **Reviewer** | 校验排版 / 内容质量，反馈修改意见 | 可用便宜快的 |
| **Editor** | 用户选中元素后的局部调整 | 需要理解上下文 |

每个角色独立配模型。管理员设全局默认，用户可覆盖。
图片生成走 LLM 自带生图能力（GPT-image-1 / Gemini 等），不单独配图片服务。

## 通信

**WebSocket 双向**，替代原方案的 REST + SSE。

- 上行：用户提交任务 / 确认 agent 提问 / 取消
- 下行：agent 工具调用进度 / pending 资产通知 / deck 更新 / agent 向用户提问

认证：WebSocket 握手时带 JWT token（query param 或首条消息）。

## 持久化

| 数据 | 存储 | 状态 |
|---|---|---|
| 用户 / 认证 | SQLite | 本次实现 |
| 模型配置 / 白名单 | SQLite | 本次实现 |
| Deck 数据 | SQLite（slides JSON） | 本次实现 |
| 对话历史 | SQLite | 本次实现 |
| 图片资产 | 对象存储（S3/R2） | **TODO** |
| 调研摄入（MinerU / 联网搜索） | — | **TODO** |

## 实施顺序

1. **项目骨架**：Bun + Hono + Drizzle + 依赖安装
2. **DB schema + 认证**：users 表、JWT 签发 / 验证、登录 / 注册接口
3. **管理员配置**：provider / 模型白名单 / 角色默认模型
4. **Deck CRUD**：创建 / 读取 / 更新 / 列表 / 删除
5. **WebSocket + Agent 骨架**：连接管理、消息协议、角色调度框架
6. **Deck Kernel**：Zod schema 校验 + 几何 lint + 事务
7. **Tool Layer**：包装 kernel 为 agent 工具
8. **Agent 实现**：4 个角色的 prompt + tool binding
9. **用户模型偏好**：在白名单内选择、覆盖默认
