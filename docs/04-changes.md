# 04 · 改动清单

**仓库根目录就是** [PPTist](https://github.com/pipipi-pikachu/PPTist) v2.0.0 的 fork（浅克隆自 `refs/PPTist`，HEAD `e491258` / 2026-08-16，已剔除 `.git`）—— 单体仓库，前端直接在根，`server/` 目录放 Bun 后端。**AGPL-3.0，`LICENSE` 必须保留。**

PPTist 自带的文档已并入 [`docs/upstream/`](./upstream/)（`AI_PPT_SCHEMA.md` 等），避免和本项目的 `docs/` 混淆。

本文是改动的**唯一权威清单**。代码里的 `TODO(R-NN)` 标记对应这里的编号。

设计依据见 [03-architecture.md](./03-architecture.md)。后端技术决策见 [06-backend.md](./06-backend.md)。

## 已定的四个决策

| | 问题 | 结论 |
|---|---|---|
| Q1 | 动画词表约束层级 | **前端也砍**，92 → 26，`effect` 收窄成联合类型，编译期拦非法值 |
| Q2 | PPTX 动画导出 | **保留 pptxgenjs 做基础生成，自研 OOXML writer 注入 `<p:timing>` 动画树。导出留在前端，不迁 Python。** 完整方案见 [05-pptx-export.md](./05-pptx-export.md) |
| Q3 | 旧 AI 路径 | **保留并改造成 agent 工具** `fillFromTemplate`，自由式失败时可回退 |
| Q4 | 变更下发方式 | **整份 deck 替换**（`setSlides`），MVP 不做细粒度 patch |

## 改动清单

状态：`○` 未开始 · `◐` 进行中 · `●` 完成

### 接口层

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-01** | `src/services/index.ts` | `SERVER_URL` 改指自建后端，vite proxy 转发 `/api` → `localhost:3000` | ● |
| **R-02** | `src/services/websocket.ts`<br>`src/store/agent.ts` | WebSocket 双向通信替代 SSE：agent.task / agent.cancel / agent.deck / agent.tool / agent.text | ● |

### 数据模型

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-03** | `src/types/slides.ts` | `PPTAnimation` 加 `exportBehavior?: 'native' \| 'web-only' \| 'flatten'`；新增 `AnimationExportBehavior` 类型 | ● |
| **R-04** | `src/types/slides.ts` | `PPTAnimation.effect` 从 `string` 收窄成 `AnimationEffect` 联合类型（**25 个**） | ● |
| — | `PPTImageElement.src` | **零改动** —— 本来吃任意字符串，`asset://` 是纯约定 | ● |

### 变更入口

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-05** | `src/store/slides.ts` | 级联删除孤儿动画 `pruneOrphanAnimations()`，`updateSlide` 和 `deleteElement` 两处都调 | ● |
| **R-06** | `src/store/slides.ts` | 加 `version: number`，每次变更自增 | ● |

### 动画

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-07** | `src/configs/animation.ts` | **92 → 25**，整体重写。每项带 `cssClass` + `pptx` preset | ● |
| **R-21** | `src/assets/styles/animation-extra.scss` | 补齐 animate.css 缺失的 12 个效果 | ● |
| **R-22** | `useExecPlay.ts` / `ElementAnimationPanel.vue` | `effect` 改经 `getAnimationCssClass()` 解析 | ● |
| **R-15** | `server/src/agent/tools.ts` | `addAnimation` 工具 —— agent 可直接添加动画（25 种效果 × 3 种触发） | ● |
| **R-16** | — | `applyAnimationPreset` 语义 API | ○ |

### 导出

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-08** | `src/hooks/useExport.ts` | 9 种元素补 `objectName: el.id`，导出末尾接入 OOXML 后处理 | ● |
| **R-17** | `src/utils/ooxml/` | 自研 OOXML writer：`buildTimingXml` 覆盖全 25 效果，`buildSpidMap` 解析 elId→spid 映射，注入链路已接入 useExport.ts | ● |
| **R-23** | `package.json` | `jszip` 提升为直接依赖 | ● |
| **R-24** | 工程 | vitest 引入，58 个测试覆盖 assetUrl + spidMap + buildTimingXml | ● |

### 资产

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-10** | `src/utils/assetUrl.ts` | `asset://<sha256>` 解析器 | ● |
| **R-11** | 6 个消费点 | 所有 `src` 消费点接 R-10；`asset://pending/<id>` 渲染骨架屏 | ● |

### 旧 AI 路径

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-09** | `src/hooks/useAIPPT.ts` | 保留模板匹配，包装成 agent 工具 | ○ |
| **R-18** | `src/types/AIPPT.ts` | `AIPPTSlide` 保留作为 `fillFromTemplate` 的入参类型 | ○ |

### 历史 / 撤销

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-12** | `src/store/snapshot.ts` | agent 快照分层：`source: 'user' \| 'agent'`，`addAgentSnapshot()` 不走防抖 | ● |

### Agent UI

| ID | 改什么 | 状态 |
|---|---|---|
| **R-13** | Agent 聊天面板（完整日志流：角色标注 + LLM 文本 + 工具调用参数/结果展开）· WebSocket 实时同步 · 选中元素 → agent 上下文 | ● |

### 工程配置

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-14** | `package.json` | `rabbit-editor@0.1.0`，补 `license` / `description` | ● |
| **R-19** | `NOTICE` | AGPL-3.0 修改声明 | ● |
| **R-20** | `.github/` `.husky/` | 已删 | ● |

### 后端（`server/`，新增）

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **S-01** | `server/` | Bun + Hono + Drizzle + SQLite 项目骨架，8 张表 | ● |
| **S-02** | `server/src/routes/auth.ts` | 账号密码注册/登录 + JWT（首用户自动 admin） | ● |
| **S-03** | `server/src/routes/admin.ts` | Provider CRUD + 模型白名单 + 角色默认 + 用户管理 + fetch-models + reset-password | ● |
| **S-04** | `server/src/routes/deck.ts` | Deck CRUD + version 乐观锁 | ● |
| **S-05** | `server/src/routes/user.ts` | 模型偏好 / 可用模型列表 / 改密码 | ● |
| **S-06** | `server/src/routes/conversation.ts` | 对话历史 CRUD | ● |
| **S-07** | `server/src/agent/kernel.ts` | Deck Kernel：Zod schema + 几何 lint + 7 个纯函数变更操作 | ● |
| **S-08** | `server/src/agent/tools.ts` | 14 个 Vercel AI SDK tools（4 读 + 8 写 + addAnimation + setSlideBackground） | ● |
| **S-09** | `server/src/agent/llm.ts` | LLM Provider 工厂（用户偏好 > 管理员默认 > 报错） | ● |
| **S-10** | `server/src/agent/roles.ts` | 4 角色 system prompt + 工具子集分配 | ● |
| **S-11** | `server/src/agent/orchestrator.ts` | 任务编排：Planner→Generator→Reviewer（容错）→ 实时同步画布 | ● |
| **S-12** | `server/src/ws/handler.ts` | WebSocket 连接管理 + 消息路由 | ● |

### 前端新增页面

| 页面 | 文件 | 说明 | 状态 |
|---|---|---|---|
| 登录/注册 | `src/views/Auth/index.vue` | 账号密码 + JWT 持久化 | ● |
| Deck 列表 | `src/views/DeckList/index.vue` | 卡片列表 + 新建/删除 | ● |
| 设置页 | `src/views/Settings/` | 独立全屏页，左导航 + 5 个子页面（provider / 模型 / 角色 / 用户 / 个人） | ● |
| Agent 面板 | `src/views/Editor/AgentPanel.vue` | 完整日志流 + 实时同步 + 选中元素上下文 | ● |

## 当前状态（2026-08-18）

**已完成 22/24 项改动 + 12 项后端 + 4 个新页面。**

前后端全栈已打通：
```
登录 → Deck 列表 → 编辑器 → Agent 面板输入指令
→ WebSocket → 后端 Orchestrator（Planner→Generator→Reviewer）
→ Vercel AI SDK → LLM → Tool 调用 → Deck Kernel 校验
→ 每步实时同步画布 → 完成后保存 DB
```

58 个单测（vitest）：assetUrl 19 + spidMap 8 + buildTimingXml 31。

`npm run build` exit 0（前端），`bun run dev` 正常启动（后端）。

## 待完成

| 项 | 说明 | 优先级 |
|---|---|---|
| R-09 / R-18 | 旧 AI 路径包装成 agent 工具 `fillFromTemplate` | 中 |
| R-16 | 动画语义 preset API（`applyAnimationPreset`） | 低 |
| E3 地面真相 | 在 PowerPoint 中验证导出的 PPTX 动画是否正常 | 高 |
| 图片资产存储 | 对象存储（S3/R2），目前 TODO | 中 |
| 调研摄入 | MinerU / 联网搜索，目前 TODO | 低 |
| OAuth 登录 | GitHub / Google，目前只有账号密码 | 低 |
| AGPL-3.0 授权 | 需联系 PPTist 作者询价（决策 C） | **高风险** |

## 待确认

- [ ] **决策 C**：AGPL-3.0 授权 —— 需联系 PPTist 作者询价。**这是当前唯一可能导致推倒重来的风险**
- [ ] `objectName` 是否对图表 / 表格生效（走 graphicFrame，属性位置可能不同）
- [ ] 上游 `pptxtojson` 导入时是否解析动画
- [ ] Reviewer 角色调用 LLM 报 "Not Found"，需排查模型名 / baseURL 配置
