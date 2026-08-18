# 04 · 改动清单

**仓库根目录就是** [PPTist](https://github.com/pipipi-pikachu/PPTist) v2.0.0 的 fork（浅克隆自 `refs/PPTist`，HEAD `e491258` / 2026-08-16，已剔除 `.git`）—— 单体仓库，前端直接在根，`server/` 目录放 Bun 后端。**AGPL-3.0，`LICENSE` 必须保留。**

PPTist 自带的文档已并入 [`docs/upstream/`](./upstream/)（`AI_PPT_SCHEMA.md` 等），避免和本项目的 `docs/` 混淆。

本文是改动的**唯一权威清单**。代码里的 `TODO(R-NN)` 标记对应这里的编号。

设计依据见 [03-architecture.md](./03-architecture.md)。后端技术决策见 [06-backend.md](./06-backend.md)。

## 已定的四个决策

| | 问题 | 结论 |
|---|---|---|
| Q1 | 动画词表约束层级 | **前端也砍**，92 → 25，`effect` 收窄成联合类型，编译期拦非法值 |
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
| **R-16** | `server/src/agent/kernel.ts` | `applyAnimationPreset` 语义 API —— 4 个 preset（sequential / title-then-content / all-at-once / none），kernel 展开成合法时间线，一次调用替代 N 次 addAnimation | ● |

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
| **S-07** | `server/src/agent/kernel.ts` | Deck Kernel：Zod schema（元素级闸门真正接上）+ 几何 lint（含文本重叠）+ 11 个纯函数变更操作 | ● |
| **S-08** | `server/src/agent/tools.ts` | **15 个** Vercel AI SDK tools（4 读 + 7 写 + 3 动画 + setSlideBackground） | ● |
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

**已完成 23/24 项改动 + 12 项后端 + 4 个新页面。**

前后端全栈已打通：
```
登录 → Deck 列表 → 编辑器 → Agent 面板输入指令
→ WebSocket → 后端 Orchestrator（Planner→Generator→Reviewer）
→ Vercel AI SDK → LLM → Tool 调用 → Deck Kernel 校验
→ 每步实时同步画布 → 完成后保存 DB
```

125 个单测（vitest）：assetUrl 19 + spidMap 8 + buildTimingXml 31 + kernel 52 + baseUrl 15。

`npm run build` exit 0（前端），`tsc --noEmit` exit 0（后端），`bun run dev` 正常启动。

功能测试脚本见 [07-agent-test.md](./07-agent-test.md)。

### 2026-08-18 第二轮：agent 能力与正确性

上一轮打通了链路，这一轮补的是**链路里被跳过的环节**。四处「设计写了但代码没接」：

| | 问题 | 处置 |
|---|---|---|
| 1 | `elementSchema` 定义后**零引用** —— `addElement` 收到什么 push 什么，`slideSchema.elements` 是 `z.array(z.any())`。「工具全部经 kernel 校验」当时只对 slide 层成立 | 新增 `validateElement()`，接进 add/update Element 与 add/update Slide 四处；chart/table 等 agent 不产出的类型只校验基础几何，避免误杀导入的 deck |
| 2 | `rectsOverlap` 是**死代码**。而 03-architecture 把「矩形求交查重叠」列为选 JSON 路线的头号收益 | 接进 `lintSlide`，只查 text↔text（文字压图片是正常设计），带背景板豁免和 60% 面积阈值 |
| 3 | `applyMutation` 只回传 `warning`，**error 级被静默吞掉** —— agent 写出零尺寸元素拿到的是干净的 `{ok:true}` | errors / warnings 两级都回传，有 error 时附 hint |
| 4 | `maxSteps` 全角色固定 15，且**截断无提示** | 按角色分配（Planner/Reviewer 12 · Generator 48 · Editor 24），截断时推 `⚠` 到面板 |

同时补的能力：

- **R-16 `applyAnimationPreset`** —— 4 个 preset，一次调用替代 N 次 `addAnimation`
- **`addAnimation` 支持批量**，新增 **`removeAnimation`** —— 此前动画只能加不能删，Reviewer 提了意见 Generator 也改不了
- **动画 effect / type 自洽校验** —— `effect: 'exit-fade'` 配 `type: 'in'` 此前无人拦截，会让导出把入场动画写进退场时间线
- **元素 / 幻灯片 id 唯一性校验** —— 撞车此前会让后续寻址悄悄指向另一个元素
- **`addSlide` 堵死孤儿动画入口** —— 整页带 `animations` 引用不存在的元素，此前可直接写进 deck
- **25 个动画效果单一真相源** —— kernel 改为从 `configs/animation.ts` 派生，不再三处各抄一份
- **`getDeck(includeElements)`** —— Planner/Reviewer 一次拿到全貌，不用逐页 `getSlide`
- **Editor 上下文预注入** —— 选中元素的完整数据直接写进 prompt，省掉两轮 LLM 往返
- **`normalizeBaseUrl`** + 模型调用异常带 provider/model/baseUrl —— 针对 Reviewer `Not Found`
- 顺带修掉 `orchestrator.ts` 里 7 个既有 TS 报错（`Partial<AgentTools>` 让 SDK 把 toolCalls 推断成 `never`）

### 2026-08-18 第三轮：删除失败 + 会话按 deck 隔离

| | 问题 | 根因 | 处置 |
|---|---|---|---|
| 1 | **agent 用过的演示文稿删不掉**（没用过的能删） | `db/index.ts:16` 开了 `PRAGMA foreign_keys = ON`，而 `conversations.deckId` 外键指向 `decks.id` —— 直接 `DELETE FROM decks` 报 `FOREIGN KEY constraint failed`，路由没 catch 变成 500 | `deck.delete` 改为自底向上级联清 messages → conversations → deck，并补上归属校验（原来无论存不存在都返回 `ok:true`） |
| 2 | **新建项目显示上一个项目的对话** | `agentStore.log` 是全局单例；`AgentPanel` 没有 `deckId` watcher；store 里的 `loadConversations`/`loadMessages` 定义了但**全项目零调用**（历史写进 DB 从没读回来过） | 加 `deckId` watcher + `openDeck()`/`reset()`；`GET /conversations/by-deck/:deckId` 一次取回历史 |
| 3 | **agent 没有记忆** | `runAgentTask` 每次新建一条 conversation，且只喂 `[{role:'user', content:prompt}]` | 一个 deck 一条会话线（`getOrCreateConversation`）；历史经 `toHistoryTurns` 带进 Planner/Generator/Editor |
| 4 | 任务跑到一半切走 deck，旧任务的 `agent.deck` 会覆盖新打开的文稿 | 无 | `openDeck` 检测到跨 deck 且任务在跑时先 `cancelTask` |

`toHistoryTurns` 只留用户输入和 Generator/Editor 产出（Planner 的计划、Reviewer 的审查是一轮内部的中间过程），
并合并连续同角色、丢弃开头的 assistant —— Anthropic 要求 user/assistant 严格交替且首条必须是 user。

Reviewer 刻意不给历史：它的职责是拿当前 deck 对照本轮需求，喂历史只会让它翻出上几轮已解决的问题。

面板还加了「清空」（`DELETE /conversations/by-deck/:deckId`），清完 agent 的记忆一并归零。

### 2026-08-18 第四轮：会话管理

上一轮把会话绑到 deck，这一轮做成**一个 deck 多条会话线**，并补上工具调用落库。

数据模型：`decks ──1:N── conversations ──1:N── messages`

```
conversations  + title           标题取首条用户输入前 20 字
               + updatedAt       列表按「最近活动」排序
               + forkedFromId    分叉来源，刻意不加外键
messages         role='tool'     枚举里本来就有，此前从没写过
```

`forkedFromId` **不加外键约束**：加了之后删父会话会被子会话挡住，正是 deck 删不掉那个坑的翻版。

| 能力 | 说明 |
|---|---|
| 工具调用落库 | `role='tool'`，content 是 `{tool,args,result}` JSON。args 上限 8KB、result 4KB，超限整体换 `__truncated` 标记而不是切成半截 JSON（面板按对象渲染，残缺 JSON 只会显示成乱码） |
| 多会话切换 | 面板标题栏下拉，**记忆随会话切换**——每条线各自独立 |
| 新建会话 | 不预建库记录：置空 `activeConversationId`，等真正发出第一条消息后端才建，否则点一下就留一条永远空着的会话 |
| 重命名 / 删除 | 列表项悬停出现 |
| 从消息分叉 | 复制 `messages[起点..选中点]` 到新会话，**deck 不动**——会话是聊天线程，演示文稿是单一可变文档 |

协议变更：`agent.task` 上行加 `conversationId?`（不传=新开），新增下行 `agent.conversation {id, title}` 让前端挂新会话进列表、并在 id 对不上时自愈。

迁移 `0002` 是**手改过的**：SQLite 的 `ALTER TABLE ADD COLUMN` 既不接受 NOT NULL 无默认，也不接受 `unixepoch()` 这类非常量默认，所以 `updated_at` 先用常量 0 占位再回填成 `created_at`；同时从首条用户消息回填了已有会话的标题，否则升级后全叫「新会话」。

**踩到的坑**：`messageCount` 一开始用相关子查询写，drizzle 在 `` sql`` `` 模板里把列渲染成**不带表前缀**的名字，
`WHERE ${messages.conversationId} = ${conversations.id}` 变成 `WHERE "conversation_id" = "id"` ——
两边都落到 messages 上成了自比较，**返回的不是报错而是一个看着挺合理的数字**。改用 GROUP BY 聚合再合并。

## 待完成

| 项 | 说明 | 优先级 |
|---|---|---|
| R-09 / R-18 | 旧 AI 路径包装成 agent 工具 `fillFromTemplate` | 中 |
| 事务 / 回滚 | 逐工具提交，中途失败留半成品。Oh My PPT 的 job/rollback 还没抄 | 中 |
| 并发控制 | agent 跑时用户手改画布会被整份 `agent.deck` 覆盖 | 中 |
| E3 地面真相 | 在 PowerPoint 中验证导出的 PPTX 动画是否正常 | 高 |
| 图片资产存储 | 对象存储（S3/R2），目前 TODO | 中 |
| 调研摄入 | MinerU / 联网搜索，目前 TODO | 低 |
| OAuth 登录 | GitHub / Google，目前只有账号密码 | 低 |
| AGPL-3.0 授权 | 需联系 PPTist 作者询价（决策 C） | **高风险** |

## 待确认

- [ ] **决策 C**：AGPL-3.0 授权 —— 需联系 PPTist 作者询价。**这是当前唯一可能导致推倒重来的风险**
- [ ] `objectName` 是否对图表 / 表格生效（走 graphicFrame，属性位置可能不同）
- [ ] 上游 `pptxtojson` 导入时是否解析动画
- [x] ~~Reviewer 角色调用 LLM 报 "Not Found"~~ —— 已加 `normalizeBaseUrl` 修正常见 baseUrl 填法，且异常现在自带 provider/model/baseUrl。**待实测确认是否根治**
