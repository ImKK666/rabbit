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
| **R-25** | `src/configs/animation.ts`<br>`src/utils/ooxml/buildTimingXml.ts` | **25 → 45**，`effectFilter` 泛化成完整 OOXML 滤镜词表；时间线结构改成三层 `<p:par>`；退场 visibility 延后；强调回弹去掉嵌套 seq；animRot 补 attrNameLst | ● |
| **R-26** | `src/utils/ooxml/buildTransitionXml.ts`<br>`useExport.ts` | 页面转场接进导出：12 种 turningMode → `<p:transition>`，转场在前 timing 在后 | ● |

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

### 表现力（`08-expressiveness.md` 的 A / B / C 三条工作线）

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-27** | `src/configs/shapeCatalog.ts` | 形状语义目录 —— 从 151 个形状里精选 **37 个起语义名**，agent 按名字选、路径由代码生成 | ● |
| **R-28** | `server/src/agent/design.ts` | 设计系统：字号阶梯 / 8px 间距栅格 / 颜色角色（从主题推导，含 WCAG 对比度） | ● |
| **R-29** | `server/src/agent/layouts.ts` | 语义版式引擎 —— **10 个版式**，一次调用排完整页（含各不相同的出场编排）；`Slide.layout` 记录版式 | ● |
| **R-30** | `server/src/agent/kernel.ts` | chart / table 补严格 Zod schema，从 `PASSTHROUGH_ELEMENT_TYPES` 后门挪出；新增 addShape / addChart / addTable / addLine 构造器 | ● |
| **R-31** | `server/src/agent/kernel.ts` | 排版几何：`applyArrangeElements`（6 种对齐 + 2 向分布，支持固定间距） | ● |
| **R-32** | `server/src/agent/assets.ts` | 图片 / 图标接口定义 + provider 契约，**本轮不实现、不注册给 LLM** | ● |
| **R-33** | `server/src/agent/roles.ts` | 4 个角色 prompt 全面重写：删掉三条劝退形状的指引，换成设计规范 + 版式词汇 + 多样性压力 | ● |
| **R-34** | `server/src/agent/kernel.ts` | `lintDeckDesign` —— 08 号文档验收标准前三条落成机器判据 | ● |
| **R-35** | `scripts/build-animation-samples.ts` | 动画最小样本生成器，`npm run samples` 产出 20 份分类样本供 PowerPoint 人工验证 | ● |

### 前端新增页面

| 页面 | 文件 | 说明 | 状态 |
|---|---|---|---|
| 登录/注册 | `src/views/Auth/index.vue` | 账号密码 + JWT 持久化 | ● |
| Deck 列表 | `src/views/DeckList/index.vue` | 卡片列表 + 新建/删除 | ● |
| 设置页 | `src/views/Settings/` | 独立全屏页，左导航 + 5 个子页面（provider / 模型 / 角色 / 用户 / 个人） | ● |
| Agent 面板 | `src/views/Editor/AgentPanel.vue` | 完整日志流 + 实时同步 + 选中元素上下文 | ● |

## 当前状态（2026-08-18）

**已完成 34/35 项改动 + 12 项后端 + 4 个新页面。**

前后端全栈已打通：
```
登录 → Deck 列表 → 编辑器 → Agent 面板输入指令
→ WebSocket → 后端 Orchestrator（Planner→Generator→Reviewer）
→ Vercel AI SDK → LLM → Tool 调用 → Deck Kernel 校验
→ 每步实时同步画布 → 完成后保存 DB
```

**1328 个单测**（vitest，截至 2026-08-19 第二十轮）：
layouts 298 + buildTimingXml 114 + layoutImage 111 + kernel-elements 106 + shapeCatalog 92 +
animation 71 + design 63 + kernel 53 + assetResults 30 + rateLimiter 27 + history 26 +
imageCodec 25 + buildTransitionXml 21 + objectStore 20 + searchCache 20 + assetUrl 19 +
reasoning 18 + taskRegistry 18 + toolGroups 18 + deckWriter 15 + baseUrl 15 + budget 15 +
commit 15 + useStickToBottom 14 + boundary 14 + imageSearch 13 + toolRegistry 11 +
animation-reach 11 + channel 10 + animationSteps 8 + spidMap 8 + cancellation 8 +
toolCommit 7 + events 5。

版面的三条判据不在单测里（它们要真浏览器 / 要整批样张），单独跑：
`npm run layout-shoot`（87 张样张截图）· `npm run layout-audit`（lint + 量化指标）·
`npm run layout-text`（真浏览器量文字溢出）· `npm run layout-order`（出场顺序）。

`npm run build` exit 0（前端），`bunx tsc --noEmit` exit 0（后端），`npx vitest run` 全绿。

> **后端要从 `server/` 目录起**（`PORT=3099 bun run src/index.ts`）——
> `migrate()` 的 `./drizzle` 是相对 cwd 的，从仓库根跑会死在
> `Can't find meta/_journal.json`，且在死之前已经在根目录建了一个空的 `data/`。

功能测试脚本见 [07-agent-test.md](./07-agent-test.md)。
动画导出的 PowerPoint 人工验证清单见 [09-powerpoint-verify.md](./09-powerpoint-verify.md)。

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

### 2026-08-18 第五轮：登录态持久

| | 问题 | 处置 |
|---|---|---|
| 1 | **`fetchMe()` catch 到任何异常就 `logout()`** —— 网络抖动、后端还没起、5xx 全都清掉 token。开发时 vite 比 bun 先起来，刷新一次就掉登录 | 只有真 401 才登出；其余保留登录态 |
| 2 | **启动必须等 `/auth/me` 回来才知道自己是谁** | 身份缓存进 localStorage，刷新即已登录（乐观恢复），再后台跟服务端核对 |
| 3 | **JWT 固定 7 天、零续期**，用得再勤第 8 天也被踢 | `/auth/me` 在剩余寿命过半时换发新 token，前端收到即替换 |
| 4 | **换账号登录会直接进上一个人的演示文稿**，AI 面板还是上一个人的对话 —— `currentDeckId` 是 App.vue 局部 ref，slides / agent 是 pinia 单例，都不随登出重置（deckId 没变，AgentPanel 的 watch 也不触发） | watch `isLoggedIn`，登出时清 deck + slides + agent |
| 5 | WebSocket 固定 3 秒重连、**10 次后永久放弃** —— 后端重启一次，AI 面板从此静默失联 | 指数退避（1s→30s 封顶）不设次数上限；登出才停 |
| 6 | 各处 401 无统一处理 | axios 响应拦截器统一登出；`/auth/login`、`/auth/register` 的 401 是「密码错了」，排除在外 |

`/auth/me` 顺带改成**从库里读用户**而不是直接信 token 里的字段：账号被删、角色被管理员改过都能立刻生效。

实测：新鲜 token 不换发 · 剩 1 天的 token 换发新的 · 账号删除后立即 401 · 错误密码的 401 不会触发登出。

### 2026-08-18 第六轮：表现力升级（A / B / C 三条线）

诊断见 [08-expressiveness.md](./08-expressiveness.md)：产出「太没有新意」有五个可指认的技术原因。这一轮做了其中四条（图片按决策 P1 推迟）。

**贯穿三条线的一个判断**：雷同不是模型不努力，是**它被要求做的决策本身就不该由它做**。
坐标、字号、间距、配色、SVG path、动画时间线 —— 这些交给模型，它只能靠 prompt 里的示例发挥，
而示例只有一份，于是每次产出都长得像那一份。处置是把这些决策**从 prompt 挪进代码**。

#### A 线 · 动画扩容（R-25 / R-26）

25 个效果实际只映射到 5 个 presetId，换的只是方向和缩放参数。扩容的入口是
`<p:animEffect filter="...">` 的 OOXML 滤镜词表 —— 百叶窗 / 棋盘 / 圆形 / 菱形 / 十字 / 楔入 / 轮辐 / 溶解，
全是 PowerPoint 原生，导出即可播，且和现有的「淡入 + 位移 + 缩放」完全不同类。**25 → 45**。

顺手修掉四处**写了三年没人验过**的结构问题（`docs/09` 第一节列了表）：

| | 原来 | 现在 |
|---|---|---|
| 时间线嵌套 | 2 层 `<p:par>` | 3 层（点击步 / 子步 / 效果）—— 少了最外层，PowerPoint 收不到「停下来等点击」的信号 |
| 退场 visibility | `delay="0"` | `delay="dur-1"` —— 原来元素先瞬间消失，淡出动画对着空气播 |
| 强调回弹 | 裹在嵌套的 `<p:seq nodeType="mainSeq">` 里 | 平铺两段 animScale —— 原来一页有两条主时间线 |
| `wipe` 的 presetId | 5（Checkerboard） | 22（Wipe）；filter 也从 `wipe(r)` 改成规范写法 `wipe(right)` |
| 方向 presetSubtype | 8 / 1 / 2 / 3 | 标准位掩码 4 / 1 / 8 / 2（下 / 上 / 左 / 右） |
| `<p:animRot>` | 无 attrNameLst | 补 `<p:attrName>r</p:attrName>` |
| cTn id | 乱序（子节点先取号） | 文档顺序递增，tmRoot=1 / mainSeq=2，和 PowerPoint 产物一致 |

页面转场（R-26）此前是零支持。ground truth 是现成的 ——
`refs/PPTAgent/pptagent/templates/default/source.pptx` 是 PowerPoint 亲手写的，
解包看 `slide1.xml` 末尾就有 `<p:transition spd="med"><p:fade/></p:transition>`，位置在 `</p:clrMapOvr>` 之后。
我们只写它 `mc:Fallback` 里的那一种（不带 p14 扩展），代价是时长只有三档，换来的是 WPS / Keynote / LibreOffice 都认。
`slideX3D` / `slideY3D` / `rotate` 基础规范里没有，**声明式降级**（`degraded` 字段会报告降了哪几页）。

**没设过转场的页面导出后不加转场** —— 网页播放器把缺省当 `slideY`，但那是播放器的默认值不是用户的意图，
导入的 pptx 再导出时平白多出一堆推移动画是实打实的失真。

#### B 线 · 工具扩容（R-27 ~ R-32）

15 → **23 个工具**。

| 工具 | 解决的问题 |
|---|---|
| `applyLayout` | **最大的一个杠杆**。10 个语义版式，一次调用排完整页，坐标 / 字号 / 间距 / 配色 / 层次 / 动画全部代码算 |
| `addShape` | 按名字从 37 个形状里选，**agent 永远不用写 SVG path** |
| `addChart` / `addTable` / `addLine` | 数字画成图表、结构化数据排成表格、分隔线和箭头 |
| `arrangeElements` | 对齐 + 等距分布。差 3px 肉眼看不出差在哪，只会觉得这页脏 |
| `setSlideTransition` | 翻页转场 |
| `getDesignTokens` | 拿颜色角色 / 字号阶梯 / 间距栅格，**别凭空编数值** |

`applyLayout` 是**整页替换**语义：版式的价值来自「所有元素同属一套网格」，
留半页旧元素等于留半套旧网格，两套叠在一起比没有网格更糟。

形状目录（R-27）按 `(分类下标, 条目下标)` 引用 `SHAPE_LIST` 而不是复制 path，
代价是上游重排会静默指错形状 —— 所以有一组测试逐条钉住每个键的 `pathFormula` / `pptxShapeType` / path 前缀。
带 `pathFormula` 的形状必须按实际宽高重算 path（`viewBox` 换成 `[w, h]`），**不重算宽卡片的圆角就是歪的**。

「其他形状」「线性」两类共 51 个是 1024 viewBox 的图标字形，光看 path 无法可靠命名，**刻意没收录** ——
猜错名字比没有更糟，等图标能力落地时一起处理。

chart / table 补了严格 Zod schema 并从 `PASSTHROUGH_ELEMENT_TYPES` 挪出（R-30）。
校验里最要紧的两条是「系列数 = 图例数」和「每条系列的点数 = 标签数」：
对不上时画布上只是少画一根线，导出到 PPTX 却是一份**数据错位的内嵌表格**，比不画更糟。

图片 / 图标（R-32）按决策 P1 只定接口不实现，且**不注册给 LLM** ——
一个永远返回「未接入」的工具只会白白消耗步数预算。

#### C 线 · prompt 重写（R-33）

旧 `CANVAS_CONTEXT` 里三条硬指引在**主动劝退形状**（「圆角矩形不容易用 path 表达，可以改用 text 元素带 fill」等），
于是每页都是「文本框 + 背景色」。但换成三条鼓励只会换一批被照抄的示例 ——
真正的改法是决策已经进了代码，prompt 只负责讲「什么时候用哪个」和「不许做什么」。

- Planner 输出从 `{action, target, detail}` 操作流水账改成**逐页版式设计**（`{layout, purpose, content}`）
- Generator 的工作顺序定为 `addSlide → applyLayout → 精修`，并明确列出「别做这些」
- Reviewer 从「几何合法」升级到 13 条设计质量检查（留白 / 对齐 / 层次 / 对比度 / 版式雷同 / 动画单一）
- Generator 步数 48 → 60：`applyLayout` 让「一页 = 两步」，但也让精修动作变得值得做了

#### 验收（R-34）

08 号文档第四节前三条落成 `lintDeckDesign`，跟着 `lintDeck` 一起跑（可用 `designChecks:false` 关掉）：

| 检查 | 判据 |
|---|---|
| 版式多样性 | 相邻页 `layout` 相同 → warning；没有 `layout` 标记的页用**结构指纹**（元素类型构成 + 前三个元素的 1/8 网格位置）兜底 |
| 非文本元素 | 整页只有文字 → warning；元素少于 3 个 → warning |
| 动画多样性 | 整份 deck 效果种类 < 3 → warning；全是 fade 系 → warning |

全部是 **warning 不是 error**：它们是设计建议，当硬闸门会把「刻意的极简」也拦掉。

实测（5 页 deck 全走 `applyLayout`）：**lint 0 问题 · 12 种动画效果 · 每页 4~18 个元素 · 5 个版式各不相同。**

第四条「导出的动画在真实 PowerPoint 里能正常播放」只能人工验，
样本和操作手册见 [09-powerpoint-verify.md](./09-powerpoint-verify.md)。

### 2026-08-19 第七轮：动画三方一致性核查（R-36）

上一轮 25 → 45 是**一次性批量扩容**，静态核过「45 个 cssClass 都有定义」，
但**没有一个在浏览器里被看过**。这一轮把三方对齐逐条验完：网页真的动了吗 · 和 PPTX 是不是一回事 · agent 到底会用到哪些。

#### 怎么验的 —— 把肉眼换成采样

新增两个开发工具（都不参与打包）：

| | 做什么 |
|---|---|
| `npm run lab` → `scripts/build-animation-lab.ts` | 生成 `samples/animation-lab.html`：自包含单页，只装 animate.css + animation-extra.scss，45 个类逐个套在色块上循环播。**词表走 `getAnimationCssClass`，不另抄一份** |
| `scripts/measure-animation-lab.mjs` | 无头 Chromium 逐帧采样。需要一次性 `npm i --no-save playwright-core`，**刻意不进 devDependencies** |

肉眼分不清「补间」和「30 步阶梯」，也分不清「元素从左边进来」和「往左边出去」，所以采样把每帧压成两个标量：

- **coverage** 可见暗度占比 —— mask / clip-path / 透明度 / 缩放在这个标量上是同一件事
- **centroid** 可见像素重心 —— 纯位移的 `slideInLeft` 全程不透明，只有重心在动

两个都**相对「不加任何动画类时的静止态」**实测，不写死阈值。把动画 `pause()` 后 `seek` 到 0/0.1/…/1.0，
整页各截一张图按卡片裁开，11 帧 × 45 个效果。

判据：入场起点必须离静止态足够远、终点必须回到静止态；退场反过来且末帧必须真的看不见；
强调首尾都必须在静止态、中途必须有变化；再加一条**补间检测**（中间帧全贴着两端 = 硬切换）。

> **负对照做过**：把 `@property --rb-reveal` 的注册摘掉再跑，
> 恰好 `blinds-h` / `blinds-v` / `randombar` / `exit-blinds` 四个被判「硬切换」，其余 41 个不受影响。
> 这条才是这套采样值得信的理由 —— 全绿的检查器和没有检查器是一回事。

#### 查出来的三件事

**① `plus-in` 播完停在十字形上（已修）**

`rbPlusIn` 的 `to` 关键帧是一个臂宽 30% 的十字，只盖住元素的 51%。
动画播到 100% 时元素**四个角还被裁着**，直到 `useExecPlay` 摘掉类名才「啪」地补上 ——
看着像动画结束后又闪了一下。实测 visible 曲线停在 0.51，是 45 个里唯一一个终态不等于常态的。

改法是把终态的十字撑到臂宽 100%、臂长溢出到 ±150%，此时十字并集 ⊇ 整个盒子；
中间帧仍是标准十字（所有点从中心按同一比例外扩），观感不变。修完 visible 走到 1.00。

**② `grow-shrink-*` 在 PPTX 侧起手瞬跳（已修）**

网页侧是 `scale(1) → 0.95 → 1.04 → 1`，而 `buildTimingXml` 直接 `from=95000`，
PowerPoint 里元素会在 t=0 **瞬间弹到 95%** 再开始长。两边对不上，而且那个瞬跳看着就是个 bug。

改成按 CSS 关键帧的 30% / 70% 切三段：`100% → low → high → 100%`。
`pulse-*` 的 `scaleFrom` 本来就是 100%，仍走两段 50/50，XML 不变。

**③ `fly-in` / `exit-fly` 的 `cssExact` 标错了（已改标注）**

网页侧用的是 animate.css 的 `backInUp` / `backOutDown`，除位移外**还带一路 `scale(0.7)`**，
PPTX 侧只有「位移 + 淡入」。而且 `backOutDown` 末帧停在 `opacity: .7` 而不是 0 ——
网页上元素是「飞出画布被 `ScreenSlide` 的 `overflow: hidden` 裁掉」才看不见的，PPTX 侧是老老实实淡到全透明。

顺带记一笔：`motion: 'fromTrace'` 在 `buildTimingXml` 里走的是和 `fromBottom` 同一个公式，
所以 **`fly-in` 导出后和 `fade-up` 在 PowerPoint 里几乎是同一个效果**，网页上却明显不同。

同时把 `cssExact` 的判据在注释里写死了，免得它退化成一个凭感觉打的勾：
**同一种机制、同一个方向、同一条物理量曲线**；只是行程距离不同（animate.css 位移 100% 自身宽度、
PPTX 是 w/2）仍算 exact，机制多一路或少一路才算近似。按这条判据近似的从 8 个变成 10 个。

#### 45 个效果的三方对照

网页表现：✅ 播得对 · ⚠️ 播得对但有一处值得知道的近似或依赖 · ❌ 有问题（本轮已清零）
与 PPTX：✅ = `cssExact` · ≈ = 网页是近似，**PPTX 侧才是保真的那边**

| effect | 网页表现 | 与 PPTX 一致 | agent 会不会用到 |
|---|:--:|:--:|---|
| `fade` 淡入 | ✅ | ✅ | **版式**：title-center |
| `fade-up` 自下淡入 | ✅ | ✅ | **版式**：title-center / cards / timeline / stat / quote / end；**preset 默认** |
| `fade-down` 自上淡入 | ✅ | ✅ | **版式**：cards / compare / timeline；**preset 标题** |
| `fade-left` 自左淡入 | ✅ | ✅ | **版式**：title-split / section / bullets / stat / quote |
| `fade-right` 自右淡入 | ✅ | ✅ | 仅 LLM 自选 |
| `scale-in` 轻缩放进入 | ✅ | ✅ | **版式**：end |
| `zoom-in` 放大进入 | ✅ | ✅ | **版式**：title-split / bullets / cards / timeline / stat / quote |
| `spin-in` 旋转进入 | ✅ | ✅ | **版式**：end |
| `slide-up` 自下滑入 | ✅ | ✅ | 仅 LLM 自选 |
| `slide-down` 自上滑入 | ✅ | ✅ | 仅 LLM 自选 |
| `slide-left` 自左滑入 | ✅ | ✅ | 仅 LLM 自选 |
| `slide-right` 自右滑入 | ✅ | ✅ | 仅 LLM 自选 |
| `fly-in` 飞入 | ⚠️ 行程 1200px 远超画布 | ≈ 多一路 scale(0.7)；导出后≈`fade-up` | 仅 LLM 自选 |
| `wipe` 自左擦除 | ✅ | ✅ | **版式**：8 个版式都用（强调条 / 轴线 / 分隔条） |
| `wipe-right` 自右擦除 | ✅ | ✅ | **版式**：title-split / compare |
| `wipe-up` 自下擦除 | ✅ | ✅ | **版式**：title-center |
| `wipe-down` 自上擦除 | ✅ | ✅ | **版式**：title-center / title-split / section / bullets / compare |
| `blinds-h` 百叶窗（横） | ⚠️ mask 12 条 | ≈ 分块数与 PowerPoint 不同 | 仅 LLM 自选 |
| `blinds-v` 百叶窗（竖） | ⚠️ mask 12 条 | ≈ 分块数与 PowerPoint 不同 | **版式**：stat（关键数字） |
| `checkerboard` 棋盘 | ⚠️ 两段式，55% 处一次跳变 | ≈ 不是连续扫过 | 仅 LLM 自选 |
| `dissolve-in` 溶解 | ⚠️ 整体透明度 steps(10) | ≈ 不是像素级溶解 | 仅 LLM 自选 |
| `randombar` 随机线条 | ⚠️ steps(8)，末帧才补满 | ≈ 分块数与 PowerPoint 不同 | 仅 LLM 自选 |
| `strips-in` 阶梯状 | ⚠️ 单条 45° 三角扫过 | ≈ PowerPoint 是多条斜纹 | 仅 LLM 自选 |
| `box-in` 盒状展开 | ✅ | ✅ | 仅 LLM 自选 |
| `circle-in` 圆形展开 | ✅ | ✅ | **版式**：title-center（大标题） |
| `diamond-in` 菱形展开 | ✅ | ✅ | 仅 LLM 自选 |
| `plus-in` 十字展开 | ✅ **本轮修复** | ✅ | 仅 LLM 自选 |
| `wedge-in` 楔入 | ✅ 自顶部张开 | ✅ | **版式**：section（章节号） |
| `wheel-in` 轮辐 | ✅ 4 辐，与 `wheel(4)` 对齐 | ✅ | 仅 LLM 自选 |
| `pulse-soft` / `pulse` / `pulse-strong` | ✅ 首尾均回到原状 | ✅ | 仅 LLM 自选 |
| `grow-shrink-soft` / `grow-shrink` / `grow-shrink-strong` | ✅ 首尾均回到原状 | ✅ **本轮修复 PPTX 侧** | 仅 LLM 自选 |
| `spin` 陀螺旋转 | ✅ 转满一圈回原位 | ✅ | 仅 LLM 自选 |
| `blink` 闪烁 | ✅ 暗到 .3 再回 1 | ✅ | 仅 LLM 自选 |
| `exit-fade` 淡出 | ✅ | ✅ | 仅 LLM 自选 |
| `exit-scale` 轻缩放退出 | ✅ | ✅ | 仅 LLM 自选 |
| `exit-zoom` 缩小退出 | ✅ | ✅ | 仅 LLM 自选 |
| `exit-wipe` 擦除退出 | ✅ 自左擦掉 | ✅ | 仅 LLM 自选 |
| `exit-fly` 飞出 | ⚠️ 末帧 opacity .7，靠飞出画布 | ≈ 多一路 scale(0.7) | 仅 LLM 自选 |
| `exit-dissolve` 溶解退出 | ⚠️ 整体透明度 steps(10) | ≈ 不是像素级溶解 | 仅 LLM 自选 |
| `exit-blinds` 百叶窗退出 | ⚠️ mask 12 条 | ≈ 分块数与 PowerPoint 不同 | 仅 LLM 自选 |
| `exit-circle` 圆形收拢 | ✅ | ✅ | 仅 LLM 自选 |

#### 方向约定是实测过的，不是读关键帧读出来的

约定是**方向指元素「从哪里来」**。用重心轨迹逐个量，13 个方向性效果全部符合，
且与 `buildTimingXml` 写进 PPTX 的 `presetSubtype` / `filter` 同向：

| 网页实测 | PPTX |
|---|---|
| `fade-up` / `slide-up` 重心自下方归位 | `presetSubtype=4`(下) + `ppt_y` 自 `+h/2` |
| `fade-left` / `slide-left` 重心自左侧归位 | `presetSubtype=8`(左) + `ppt_x` 自 `-w/2` |
| `wipe` 先露左边 → 向右揭开 | `presetSubtype=8`(左) + `filter=wipe(right)` |
| `wipe-up` 先露下边 → 向上揭开 | `presetSubtype=4`(下) + `filter=wipe(up)` |
| `strips-in` 自左上角对角扫出 | `filter=strips(downRight)` |
| `wedge-in` 自正上方向两侧张开 | `filter=wedge` |
| `exit-wipe` 自左侧擦掉 | `filter=wipe(right)` + `transition=out` |

**`presetSubtype` 记的是「来源边」，`filter` 里的方向记的是「擦除去向」，两者天然相反**，这一点在词表注释里已经写明。

#### agent 的三条路，没有死词表

| 路 | 覆盖 |
|---|---|
| a) `layouts.ts` 10 个版式写死的编排 | **14 个效果**，每份 deck 必然跑到 |
| b) `applyAnimationPreset` | 默认 `fade-up`；`title-then-content` 的标题用 `fade-down`（都在上面 14 个里） |
| c) LLM 自选 | `ANIMATION_EFFECTS` 由 `ANIMATION_DEFS` 直接推导 → z.enum **覆盖全部 45 个**；`ANIMATION_GUIDE` 按性格分六类，**45 个全部点名** |

所以**死词表是 0 个**：没有任何效果是三条路都够不着的。31 个是「只有模型主动选才会出现」，
这是设计意图不是缺陷 —— 版式写死的那 14 个是保底的多样性，其余是模型的调色盘。

高频那批（`wipe` 系 8 个版式都用、`fade-*` / `zoom-in` 遍布各版式）**全部 ✅**；
写死路径里唯一落在 ⚠️ 的是 `blinds-v`（stat 版式的关键数字），它的 ⚠️ 只是「分块数和 PowerPoint 不同」，网页侧播得完全正常。

#### 面板与翻页转场

- **动画面板没被撑坏**。实测编译后的真实 SCSS：入场页签内容高 700px、容器 500px，
  **多出来的 200px 由既有的 `overflow-y: auto` 接住**；每组仍是 4 列，最右侧 400px < 可用宽 405px，没有横向溢出。
  入场从 4 组变 6 组带来的唯一变化是「这个页签现在要滚一下」
- **悬停预览 45 个全部工作**：走的是同一个 `getAnimationCssClass`，实测每个类都恰好跑起 1 条 CSS 动画（`anims=0` 的有 0 个）。
  这条比看着像更重要 —— 类名拼不出 keyframes 时 `animationend` **永远不会触发**，`useExecPlay` 的 `inAnimation` 卡住，整页放映点不动了
- **12 种翻页转场**：11 种在 `ScreenSlideList.vue` 有 `turning-mode-*` 规则，
  `random` 在渲染前已被 `useSlidesWithTurningMode` 换成具体值，**没有缺口**。
  已知缺口在移动端：`MobilePlayer.vue` 只实现了 no / fade / slideX / slideY 四种，其余静默无转场（上游行为，未动）

#### 新增单测（542 → 628）

| 文件 | 钉住什么 |
|---|---|
| `src/configs/__tests__/animation.test.ts`（71） | ① 每个 `cssClass` 在 animate.css 或 animation-extra.scss 里真有规则、且自定义类都声明了 `animation-name` ② 45 个在面板分组里恰好各出现一次 ③ 每个 `turningMode` 都有 CSS ④ `cssExact` 的近似清单显式列出，改它是个需要解释的动作 |
| `server/src/agent/__tests__/animation-reach.test.ts`（11） | z.enum 覆盖全集、`ANIMATION_GUIDE` 45 个全点名且没有词表外的名字、版式写死的 effect 全合法且全是入场类 |
| `buildTimingXml.test.ts`（+4） | grow-shrink 三段且从 100% 起步、pulse 仍两段、强调最后一段一定收在 100% |

三条都是「文件 A 改了、文件 B 没跟上」，类型系统管不着 —— 只能读文件对。

`samples/animations/` 20 份**已按新的强调时间线重新生成**。

### 2026-08-19 第八轮：步数预算、截断续作、思考流（R-37）

一次 12 页的实测暴露了三个独立问题，都不在动画那条线上。

#### ① 步数上限低了一个数量级

实测：Generator 60 步 → 96 次工具调用 → **只做出 10 页**，然后截断。
`orchestrator.ts` 原来的注释写的是「60 步 ≈ 10 页」，所以行为完全符合预期 —— **预期本身定错了**。

96 次调用约 13 万 token。现役模型是 1M 上下文，也就是说旧上限**只用掉 13%** 就把 agent 掐停了。
掐它的从来不是模型的能力边界，是一个按当年模型定的保守估值。

按 1M 倒推真正的容量在 400~500 步，所以默认改成：

| 角色 | 原 | 现 |
|---|---:|---:|
| generator | 60 | **512** |
| editor | 24 | 256 |
| planner | 12 | 64 |
| reviewer | 12 | 64 |

搬进独立的 `server/src/agent/budget.ts`（纯函数、无依赖，orchestrator 导入 `bun:sqlite`，
在 vitest 里根本 import 不进来，不拆出来就没法测）。支持环境变量回退：

```
AGENT_MAX_STEPS=60                 # 一次管住所有角色
AGENT_MAX_STEPS_GENERATOR=200      # 单角色覆盖，优先级更高
```

非法值（`0` / 负数 / `abc` / `Infinity`）一律忽略退回默认，**不报错** ——
打错的环境变量会表现成「agent 突然什么都不做」，比启动失败难查得多。

#### ② 截断被当成了完成

这条比 ① 严重。`runRole` 一直有 `truncated` 标志，但**编排器读都不读**：
Generator 做到一半，Reviewer 就开始审一份没做完的稿子，然后理所当然地报一堆「缺这缺那」，
Generator 的修正轮再去补它本来就要补的东西。用户看到的是「PPT 没做完就切角色去审查了」。

改成 `runRoleToCompletion`：触顶就带着当前 deck 续作，最多 3 轮，做完才轮到下一个角色。

**续作不传 history**，这是关键 —— 要接着做的信息全在 deck 里，agent 自己 `getDeck` 就看得到。
等于每一轮都从**干净的上下文**起步，所以任务的真实上限是 512 × 4 轮而上下文不累积。
Editor 路径和 Reviewer 的修正轮同样走它：修到一半就交付，和没修一样。

#### ③ 思考过程没有出口

`generateText` 要等**一整步**跑完才有东西可发，而一步可能几十秒 —— 那段时间界面上只有一个转圈。

核心调用换成 `streamText`，加 `onChunk` 转发 `reasoning` 增量：

```
agent.reasoning       { role, delta }   逐段流式推送
agent.reasoning.done  { role }          这一步想完了
```

面板里的思考块**默认开合与工具调用相反**：想的时候摊开、想完了收起来，点标题可回看
（`isReasoningOpen`）。思考是过程信息，实时看着有用，执行阶段还占着半屏就只是噪声。

不开 reasoning 的模型一条 `agent.reasoning` 都不会发，前端也就不画这个块 —— **没有空壳**。
本轮**没有**去替各家 provider 打开 thinking 开关（Anthropic 的 `thinking`、OpenAI 的
reasoning summary 各不相同，且会改变计费），只做「**有就显示**」。

#### 顺带修的

`bun run dev` 起不来（`Cannot find module '@/types/slides' from src/configs/shapes.ts`）。
`@/` 的 paths 只写在 `server/tsconfig.json`，管不到 `src/` 下的文件；根 `tsconfig.json` 是
solution-style（`files: []` + references），没有 paths。`src/` 里其余的 `@/` 全是
`import type`，编译时就抹掉了，所以只有这一处会炸 —— `ShapePathFormulasKeys` 是 const enum，是值。
改成相对路径。**自 f542c15 起后端就起不来了**，是上一轮 `shapeCatalog.ts` 把 `shapes.ts`
拉进后端加载图带出来的。

#### 还没做的

实测里另外两个步数大头**没动**，它们是下一轮的活：

- `getSlide` × 13 —— `applyLayout` 不返回它创建了什么，agent 只能紧跟一次回读。
  这 10 次是串行依赖，每次占一整步
- `updateElement` × 24（其中 17 次只改 `width`）—— agent 在手工返修 `applyLayout` 的几何。
  「模型被要求做的决策本身就不该由它做」在这里又冒出来一次，只是换了个位置

思考流的**端到端效果没验**：需要一个真开了 reasoning 的模型才看得到。
类型、编译、启动都过了，但「思考块长什么样」得你跑一次才知道。

### 2026-08-19 第九轮：修 streamText 挂死 + 思考过程真正落地（R-38）

#### ① R-37 的 streamText 迁移会**永久挂死**（严重，已修）

`streamText` 的 `text` / `steps` / `finishReason` 都是 promise，但**只在流被读干之后才 settle**。
R-37 写的是直接 `await Promise.all([...])` —— 没有任何东西去驱动那条流，于是三个 promise
永远 pending。表现是「`XX 角色 开始工作`」之后再无下文，**没有报错、没有超时**。

`consumeStream()` 看着是对的解法，实测**更糟**：它把错误吞掉再正常返回，之后那三个
promise 同样再不 settle —— 换来的是同一种挂死，只是更难查。坏 API key 实测：

| 做法 | 正常 key | 坏 key |
|---|---|---|
| `await Promise.all([...])` | 挂死 | 挂死 |
| `await consumeStream()` | 1 秒完成 | **静静挂死** |
| `for await (fullStream)` | 0.9 秒完成 | **1 秒抛出 AI_APICallError** |

改成 for-await 读干 `fullStream`，遇到 `error` 分片就自己抛。思考增量也顺手在这个循环里转发，
`onChunk` 回调随之删掉 —— 流总要读一遍，读的时候顺手发比多挂一个回调更好懂。

#### ② 思考过程为什么一条都没有

R-37 把管道和 UI 都建好了，但实测一条 reasoning 都收不到。原因**不在那条管道上**，
在模型那一端根本没开、或者开了被 SDK 丢了，而且三家的情况各不相同：

| provider | 思考在哪 | 处置 |
|---|---|---|
| **deepseek** | SSE delta 的 `reasoning_content` 字段 | **新增 provider 类型**，见下 |
| google | 默认思考但不回传 | `thinkingConfig.includeThoughts = true` |
| openai | o 系列只在 Responses API 给摘要 | 不动；兼容端点常用 `<think>` 标签，挂 `extractReasoningMiddleware` 兜住 |
| anthropic | 需显式开 extended thinking | **默认不开**，见下 |

**DeepSeek 的坑**：它的端点是 OpenAI 兼容的，所以自然会被配成 `providerType: 'openai'`。
但 `@ai-sdk/openai` 用 zod schema 解析 SSE，`reasoning_content` 不在 schema 里，
**在到达任何中间件之前就被剥掉了** —— 靠中间件救不回来，只能换 provider。

实测确认（直接打端点）：`deepseek-v4-flash` / `-pro` 的 delta 确实带 `reasoning_content`
且**不带** `<think>` 标签。换用 `@ai-sdk/deepseek` 后同一个模型：

```
@ai-sdk/openai  : reasoning 0 字
@ai-sdk/deepseek: reasoning 64 字
```

所以新增 `deepseek` provider 类型（schema / admin zod / 设置页下拉三处）。
`text('provider_type', { enum })` 在 drizzle-sqlite 里只是类型级约束、不生成 CHECK，**无需迁移**。
**已有的 DeepSeek provider 要在设置里把类型从「OpenAI 兼容」改成「DeepSeek（带思考过程）」才会生效。**

**anthropic 默认不开**：extended thinking 一开就锁 temperature、要求 `budgetTokens`、
老模型直接报错，还改变计费。给一个没人配过的 provider 默认打开这些属于替用户做主。
需要时 `AGENT_ANTHROPIC_THINKING_BUDGET=4096`，低于 1024（Anthropic 侧下限）视为没开。

#### 端到端实测

用真实模型跑通了整条链，不是只过类型：

```
steps=2 · 工具调用=3 · reasoning=170 字 · finish=stop · 2.7 秒
```

多步工具循环、思考增量、正常收尾三件事同时成立。

### 2026-08-19 第十轮：出场顺序核查与修复（R-39）

症状是肉眼看到的：生成出来的每一页，**信息出现的先后顺序不对**。内容直接就在那儿、
动画播完才轮到标题、装饰图形抢在正文前面。

R-36 验的是**单个效果**动不动、动得对不对，验完是全绿的 —— 因为「一页里先看到什么、
后看到什么」根本不由 CSS 决定，它由 `layouts.ts` 里 `b.animate()` 的**调用顺序 + trigger** 决定。
那是一片从来没有任何检查覆盖过的地方。

#### 怎么查的 —— 把「编排的问题」和「渲染的问题」分开

新增 `npm run layout-order`（`scripts/inspect-layout-order.ts`），逐版式打三张表：
元素清单（谁挂了动画、谁没挂）· 动画序列（effect / trigger / 时长）· 分步结果。

工具里没有一行是规则的第二实现：元素与动画调 `buildLayout`，网页分步起一个真的
pinia store 读 `formatedAnimations`，PPTX 分步调 `groupTriggersIntoSteps`，判据调
`lintSlideAnimationOrder`。它只负责把四者摆到一起。

#### 查出来的：10 个版式里 8 个有问题，分两类

| 版式 | 修前的实际出场序列 | 问题 |
|---|---|---|
| title-center | 斜块×2 → eyebrow → **标题** → 强调条 → 副标题 | 装饰独占第 1 步 |
| title-split | 主色块+分界线 → 装饰环 → eyebrow → **标题** → … | 装饰占掉前 2 步，标题第 4 步才出 |
| section | 章节号 → 竖线 → **标题** → 正文 | 竖线独占一步 |
| bullets | 强调条+标题 → 每条要点 | **副标题、3 个序号数字从头就在** |
| cards | 标题+强调条 → 每张卡的底板+编号 | **副标题、卡内标题正文共 10 个从头就在** |
| compare | 标题 → 两块底板 → 分界线 | **两栏下划条、标题、正文共 6 个从头就在** |
| timeline | 标题+强调条 → 轴 → 逐个节点 | ✓ 无 |
| stat | 光晕+eyebrow → **数字** → 标签+条 → 注释 | 只给必填时光晕独占第 1 步 |
| quote | 引号 → 引文 → 分隔条+出处 | ✓ 无 |
| end | 装饰环 → **标题** → 强调条 → 副标题 | 装饰独占第 1 步 |

**两类的表现和处置完全不同**：

- **漏挂动画**（bullets / cards / compare，共 20 个元素）。没挂 ≠ 不动，而是
  「第一次点击之前它就已经在画布上」——`views/Screen/ScreenElement.vue` 的
  `needWaitAnimation` 查不到动画就一律 `visible`。cards 最典型：底板 `fade-up`
  升上来，而卡里的文字早就摆好了。这是**功能缺陷**。
- **编排写反**（另外 5 个版式）。所有元素都挂了动画，但装饰单独占了标题前面的一步。
  title-split 最重：主色块 700ms + 装饰环 600ms + eyebrow 400ms，1.7 秒之后标题才出现。
  这是**编排缺陷**。

#### 修法：装饰跟着它修饰的内容走

`layouts.ts` 顶部记了三条硬规矩（每个元素都挂动画 · 标题领跑 · 装饰不单独占步），
十个版式逐个按这三条重排。核心手法只有一个：把装饰的 trigger 从 `auto` 改成 `meantime`，
让它和标题同格出场 —— 封面的「几何开场」观感一点没少，但第一眼看到的是标题。

顺手修的：`Builder.animate` 现在兜底把第一条落地的动画改成 `click`。
版式里大量元素是条件创建的，`animate(null, …)` 会静默跳过 ——
领跑的那条被跳过时，整页时间线就会变成「进页自动播一半」。
「只给必填」的 stat 正是这么暴露出来的。

修完每页的步数反而少了（title-center 5 → 3，title-split 6 → 3）：
原来一堆装饰各占一步，现在并成一格。

#### 网页与 PPTX 的分步逻辑：一致，且已经钉死

顺带确认的那件事有答案了。分步规则原来有两份实现：
`src/store/slides.ts` 的 `formatedAnimations`（网页放映）和 `buildTimingXml.ts` 的
`groupIntoSteps`（PPTX 导出）。**结论是等价的**，但此前没有任何东西在守这一点。

现在规则提到 `src/utils/animationSteps.ts`，导出侧和新的 lint 都用这一份；
`formatedAnimations` 保持原样（上游 PPTist 的播放路径，动它不值得），
等价性由 `src/store/__tests__/animationSteps.test.ts` **穷举长度 1~5 的全部 363 条
trigger 序列**逐格比对，外加「进页是否自动播」两侧结论一致。

记录在案的唯一差异：同一元素在同一格里挂两条动画时网页会去重、PPTX 不会。
不改 —— 一个元素同一瞬间播两个入场动画本身没有产品含义，版式引擎也产不出这种输入。

#### 这个问题该在哪一层拦住

**主修在 layouts.ts，不在 Reviewer。** 理由是「Generator 有没有可用的修复动作」：
这些页是 `applyLayout` 生成的，Generator 唯一能做的是**重新套一次版式** ——
而那会逐字节重现同一个顺序。于是 Reviewer 每轮都报同一条、Generator 每轮都白改一遍，
Planner→Generator→Reviewer→Generator 的回路永远不收敛。**每次都报同一个问题、每次都得改一遍，
这正是把它放进 Reviewer 会发生的事。**

lint 规则照样加了（`server/src/agent/animationOrder.ts` → `lintDeckDesign` 第 ④ 条），
但它守的是**另一条路**：agent 用 `addElement` + `addAnimation` 手工拼时间线时，
它拼错了、也拼得回来。三条判据和版式引擎那三条是同一份代码。

两个刻意的设计约束：

- **进 `lintDeckDesign`，不进 `lintSlide`。** `lintSlide` 的结果跟在每一次元素改动后面返回，
  而手工搭页时元素和动画是分两步加的 —— 在那里报「有元素没挂动画」等于每加一个元素催一次。
  `lintDeck` 是收尾时才跑的，那时候页面已经成型。
- **applyLayout 的产物必须零告警**，`kernel-elements.test.ts` 里 10 个版式逐个守着。
  一旦破了，agent 每跑一份 deck 都会收到一条自己修不掉的意见 —— 那才是真正的烧步数。

Reviewer 的 prompt 只加了一条：把 lintDeck 报的出场顺序问题转成 issue，
并写明「版式页报警是版式引擎的 bug，不要让 Generator 反复重排」。

#### 测试

**661 → 771**。新增 110 条，全部是机器判据（08 号文档第四节「变成机器能判的，才不会退化」）：

| | 条数 | 守什么 |
|---|---:|---|
| `layouts.test.ts` · 出场顺序 | 81 | 10 版式 × 2 份内容 × 4 条不变量（覆盖 / 标题领跑 / 装饰不抢跑 / 首条是 click） |
| `kernel-elements.test.ts` · 出场顺序 lint | 21 | 判据本身 + applyLayout 产物零告警 + 不进 lintSlide |
| `animationSteps.test.ts` | 8 | 网页 ≡ PPTX，穷举 363 条 trigger 序列 |

**负对照做过**：把新测试挂到修改前的 `layouts.ts` 上，21 条失败，
和核查工具查出来的 8 个版式一一对应。全绿的检查器和没有检查器是一回事。

### 2026-08-19 第十一轮：品牌改名 Rabbit（R-40）

fork 自 PPTist 之后，自己新加的页面（登录 / Deck 列表）早就叫 Rabbit，
但上游带过来的编辑器外壳里还到处是 PPTist。这一轮清干净，**破坏性重建，不留兼容路径**。

#### 删掉的

主菜单「意见反馈」「常见问题」两项 —— 它们链的是上游仓库的 issues 和 Q&A 文档，
对这个 fork 的用户没有意义。随之删掉只服务这两项的 `goLink()`。

#### 改名的

| | 旧 | 新 |
|---|---|---|
| 标签页标题 / meta | PPTist | Rabbit |
| 动画面板预览色块 | CSS `content: 'PPTist'` | `'Rabbit'` |
| `public/mocks/slides.json` | 112px 示例标题 | Rabbit |
| 专属文件后缀 | `.pptist` | `.rabbit` |
| 加密密钥 | `pptist` | `rabbit` |
| IndexedDB 前缀 | `PPTist` | `Rabbit` |
| localStorage key | `PPTIST_DISCARDED_DB` | `RABBIT_DISCARDED_DB` |
| BroadcastChannel / 窗口名 | `pptist-audience[-sync]` | `rabbit-audience[-sync]` |
| 导出对话框 key | `'pptist'` | `'rabbit'` |
| CSS 类 | `.pptist-editor` / `.pptist-screen` / `.export-pptist-dialog` | `.rabbit-editor` / `.rabbit-screen` / `.export-specific-dialog` |
| 图标 | `file-pptist.svg` | `file-rabbit.svg` |
| PPTX 内部母版名 | `PPTIST_MASTER` / `PPTIST_CUSTOM_LAYOUT` | `RABBIT_*`（PowerPoint 母版视图里看得到） |

后缀集中到 `src/configs/specificFile.ts` 一处（导出、两个 file input、粘贴判断都从这里取），
免得下次改名又要满仓库找字符串。

#### 破坏性后果（都是有意的）

- **改名前导出的 `.pptist` 文件打不开** —— 后缀不认、密钥也换了。
  第一版做过兼容（accept 收两个后缀、decrypt 试两把密钥），按「不要保留兼容」的要求撤掉了。
  真要救旧文件，把 `configs/specificFile.ts` 的后缀和 `utils/crypto.ts` 的密钥临时改回去导一次。
- **遗留的 `PPTist_*` IndexedDB 不会被自动清掉** —— 那是每次启动新建、下次启动清掉的
  临时库（撤销快照 + 画板图），**没有用户数据**，但对不上新前缀的过滤会一直留在浏览器里。

#### 顺带去掉的一条白名单

`usePasteTextClipboardData` 的图片来源白名单原本放行 `pptist.cn`（上游图床）。
这个 fork 不控制那个域名，而**这是一张安全白名单** —— 那个文件自己的注释就写着
「必须确保图片来源都是合法、可靠、可控的」。内置模板用的图全在 `images.pexels.com`
（`public/mocks/`），去掉不影响任何东西。顺手把散着的两条正则收进数组。

#### 没改的

代码注释里对上游 PPTist 的事实性引用 —— 那些在解释「这段代码为什么长这样」，
是出处说明不是标识符。**AGPL-3.0 第 5 条要求的归属仍在 `NOTICE` / `LICENSE`，两个文件没动。**

#### 验证

四道闸门全过。产物实测：`dist/` 的 js + css + html 里 `pptist` 命中数为 **0**。

> 改名后第一次 `npm run dev` 若报 `Icon custom/file-pptist not found`，
> 是**已经在跑的那个 dev server** 的陈旧模块图 —— `unplugin-icons` 的
> `FileSystemIconLoader` 按需读盘，svg 改名不会让它失效。重启 dev server + 浏览器硬刷新即可。
> 干净启动实测：转换出来的 import 已经是 `~icons/custom/file-rabbit`，无报错。

### 2026-08-19 第十二轮：图标字形命名（R-41）

「待完成」里挂了很久的一条：`configs/shapes.ts` 的「其他形状」「线性」两类共 51 个
1024 viewBox 图标字形没名字，agent 用不了。`shapeCatalog.ts` 里当初写的理由是
**「光看 path 无法可靠命名，猜错名字比没有更糟」**。

前半句是对的，结论下早了 —— **看不出来是因为没把它们画出来看。**
一个 1600 字符的贝塞尔串人眼读不出是云还是锁，渲染成 150px 就一目了然。

#### 工具

| | 做什么 |
|---|---|
| `npm run shapes` → `scripts/build-shape-sheet.ts` | 生成 `samples/shape-sheet.html`：150 个形状按 `pick(分类下标, 条目下标)` 标好铺成联系表，已收录的压暗，未命名的正常显示 |
| `node scripts/shoot-shape-sheet.mjs` | 截成 PNG（`--group N` 只截一类）。和 `measure-animation-lab.mjs` 一样，playwright-core 按需装，不进依赖表 |

51 个逐个看过来命名，存疑的（企鹅？狐狸？鸟？）放大到 150px 再看一遍。

#### 收了 47 个，刻意排除 4 个

新增 `icon` 分类 47 个 + 弧形箭头 2 个（`arrowUndo` / `arrowRedo`，在箭头分类里躺着也没名字），
目录从 **37 → 86**。`describeShapeCatalog()` 只多了一行（它输出的是 `key(名字)` 紧凑清单），
Generator 的 system prompt 从 5340 → 6130 字符。

排除的 4 个及理由：

- **QQ 企鹅 / Twitter 小鸟 / GitLab 狐狸** —— 第三方品牌标识。
  把别家商标交给一个会自动往用户文稿里盖图形的 agent，是给用户埋雷。
  它们在 UI 的形状面板里照常可选 —— 人自己挑是人自己的决定。
- **孤零零的男性符号 ♂** —— 集合里没有配套的 ♀，
  它最可能的用途（性别构成对比）恰恰是它一个人干不了的。

这四条决定**钉在测试里**（`shapeCatalog.test.ts`），免得哪天有人「顺手补全」又加回去。

#### 顺带修的两处

**① `fixedRatio` 一直没被传下去。** `buildShapeGeometry` 算了这一位，
但 `applyAddShape`（kernel.ts）和 `Builder.shape`（layouts.ts）两处都写死 `fixedRatio: false` ——
shapeCatalog 里 `ellipse` / `donut` / `star5` 那一列标记等于白写，用户在画布上拖一下就把圆拖成椭圆。
现在两处都传 `geometry.fixedRatio`。

**② 图标被拉长没人管。** 形状渲染是裸的 `scale(width/viewBox[0], height/viewBox[1])`
（`BaseShapeElement.vue`），给云一个 120×40 的框，出来的是一条云状的面条。
`applyAddShape` 现在对 **icon 分类**且长宽比 > 1.3 的调用回一条 warning。
只查 icon：`ellipse` 的名字就叫「椭圆 / 圆」，把椭圆画成椭圆不是错。

#### 钉住身份的方式改了 —— 第一版钉法是假的

目录按 `(分类下标, 条目下标)` 引用 `SHAPE_LIST`，上游一旦重排就会**静默**指到另一个字形上。
原有的 37 个靠「path 前缀 + pptxShapeType + pathFormula」三件套钉住，图标没有后两者，
所以第一版只钉了 path 前 28 个字符。

**实测这个钉法是假的**：`checkCircle` / `minusCircle` / `closeCircle` / `plusCircle` /
`playCircle` / `clock` / `ban` 七个的开头一模一样（同一个外圆），方形那五个也一样 ——
✓ 变成 ✗ 的时候它会一声不吭地通过，而 agent 会照样把 ✗ 盖进用户的对比表。

改成钉 **path 长度 + 末 24 字符**，对 86 个键全部可区分。
负对照做过：把 `checkCircle` 偷偷指向 `closeCircle` 的字形，测试立刻红。

#### 测试

**771 → 831**（新增 54 条 shapeCatalog + 6 条 addShape）：
49 条身份钉住 · 47 个图标全部 `fixedRatio` 且 viewBox 为 1024 · 4 条排除决定 ·
`fixedRatio` 传递 · 图标长宽比警告的边界。

51 个字形的 path 全部过了 `toPoints`（PPTX 导出用的转换器），无一失败 —— 命名之前先确认过它们导得出去。

### 2026-08-19 第十三轮：外部 runtime 研究与方向决策（R-42）

**这一轮没有代码改动**，产出是两份文档和一个方向决策。记在这里是因为它会决定后面十轮的形状。

#### 读了什么

`refs/` 下新增两个浅克隆（`.gitignore` 里，不入库）：

| 仓库 | 是什么 | 授权 |
|---|---|---|
| `refs/BitFun` `405c1c7` | Rust agent runtime + React 桌面端，46 crate / 1714 `.rs` / 2270 `.ts(x)` | MIT |
| `refs/ClaudeCodeRev` `ffe4eab` | `@anthropic-ai/claude-code@2.1.88` 从 sourcemap 还原 | **无授权声明** |

研究结论落在 [10-agent-runtime-study.md](./10-agent-runtime-study.md)。
最能直接用的六条：单一权威写者（TurnOwnership）· 取消时回收在途分片 ·
提问注册表的生命周期绑定 · `FINISHING` 态与五模式按钮 · 收益递减检测 ·
`State` 写全字段 + `transition.reason`。

#### 方向决策

**agent 从「生成 PPT 的硬编码剧本」强化成通用 agent 系统**，PPT 是第一个域。
路线、目标架构、A~D 分期和验收判据见 [11-agent-roadmap.md](./11-agent-roadmap.md)。

一条贯穿的红线：**通用化只往 runtime 层加自由度，不往排版层加自由度。**
`kernel.ts` / `layouts.ts` / `design.ts` 一行不动 —— 08 号文档那句
「模型被要求做的决策本身就不该由它做」是有十二轮实测背书的，不能因为要通用化就吐回去。

规划时提过一条保留意见（通用化会稀释域内优势），**已被否决，原样记录在 11 号文档第二节 ④**。

#### 顺带查清的四个事实

1. **`orchestrator.ts` 的 `activeTasks` 按 `userId` 键** —— 一个用户全局只能跑一个任务，
   跨 deck 也不行，和「一个 deck 多条会话线」的数据模型对不上
2. **`saveDeckState` 只在最后调一次**（`:506`），而 `agent.deck` 每步实时推画布 ——
   中途失败会造成**画布有改动、库里没有**，刷新即丢。比「留半成品」更隐蔽
3. **`cancelAgentTask` 只是 `abort()`**，在途的 `agent.deck` / `agent.text` 照发
4. **`FINISHING` 不该进后端协议** —— BitFun 的 Rust 侧 `SessionState` 只有
   `Idle / Processing / Error` 三态，`FINISHING` 是纯前端概念，
   存在只为给 UI 一个排干迟到事件的地方

#### 判断错过的地方

**① 差点把自动生成的 stub 当成真源码。**
ClaudeCodeRev 里 146 个文件是 `gen-stubs.ts` 按 import 分析推断出来的，
`query/transitions.ts` 就是其中之一，它把 `Continue` 推断成 `{ type: 'continue' }`。
是后面读到真实 continue 点写着 `transition: { reason: … }` 才发现对不上。
**对着「还原出来的」仓库，第一件事应该是分清哪些是观测、哪些是推断**，
而不是读到矛盾了才回头查。这条和「不猜，跑出来看」是同一件事的另一面。

**② 先用 grep 啃了半天才被提醒仓库里装了 LSP。**
更糟的是实测两个 LSP 都不能直接用 —— 插件只是接线壳子，
`rust-analyzer` 和 `typescript-language-server` 二进制都要另装（README 里写着，没读）。
装完 rust-analyzer 实测：`documentSymbol` 可用，`workspaceSymbol` / `findReferences` 全空，
因为这台机器没有 cargo，建不出 crate 图，它退到了 detached-file 模式。
**「装了插件」和「LSP 能用」之间隔着两层，而我在第一层就下了结论。**

**③ 读 BitFun 一开始用错了方式。**
按「读代码」读，收益远低于读它的 `AGENTS.md`。
`flow_chat/components/modern/AGENTS.md` 217 行的信息量超过任何 2000 行实现 ——
它把每条规则背后那次翻车都写明了。
**成熟仓库里最该先读的，是它写给「要改这块代码的人」的那份文件。**

### 2026-08-19 第十四轮：拆层 A1~A4（R-43）

[11-agent-roadmap.md](./11-agent-roadmap.md) **阶段 A 全部四步**。
A1~A3 零行为改动，A4 顺带修掉两个真 bug（任务并发键错了 + 注销的 ABA 竞态）。
每一步都用「拆层前的期望」当判据，而不是从新代码反推。

#### 切成了三层

```
server/src/runtime/       域无关：baseUrl · budget · history · llm · reasoning
server/src/domains/deck/  PPT 域：animationOrder · assets · design · kernel · layouts · roles · tools
server/src/agent/         装配层：orchestrator（唯一同时 import 两边的文件）
```

**这个切分不是硬凑的 —— 排依赖图时发现现有代码天然就分好了**：

```
runtime:  llm → baseUrl, reasoning        其余四个零依赖
deck:     kernel → animationOrder, design, layouts    tools → design, kernel, layouts
          roles → layouts, tools          layouts → design
装配:     orchestrator → budget, history, llm（runtime）+ roles, tools（deck）
```

**deck 域没有任何文件 import runtime，runtime 也没有 import deck。**
唯一的跨层依赖只有 orchestrator 一处，而那正是装配层的定义。
拆层之所以只花了 2 个文件的内容改动，是因为边界本来就在那儿，只是没画出来。

`agent/` 刻意保留一个文件不改名叫 `assembly/`：A4 会把 orchestrator 拆成
「域无关的 runTask 循环」+「deck 域的剧本」两半，那时名字要重取，现在改一次白折腾。

#### 判据 3 意外地比原文写的更强

11 号文档写的是「**现有 831 个测试不许改，且全绿**」。
字面上这条站不住 —— 搬文件必然要改测试里的 import 路径。

但排依赖图时发现一个更好的办法：**源文件和它的测试一起搬**。
测试用的是 `from '../kernel'` 这种相对路径，
`agent/__tests__/kernel.test.ts → ../kernel` 搬成
`domains/deck/__tests__/kernel.test.ts → ../kernel` 之后**原样有效**。

于是 **9 个测试文件一个字都没改**，831 条断言全部原样通过。
这比「只改 import 不改断言」强一档：连改都没改，就没有「改的时候顺手动了断言」的空间。

前提是先确认过**没有一个测试跨新边界**（逐个查过 import：
runtime 的 4 个测试只 import 自己那一层，deck 的 5 个只 import deck）。

#### A2：边界判据 + 真负对照

`server/src/runtime/__tests__/boundary.test.ts`，10 条。守的是
「`runtime/` 不得依赖 `domains/` 或装配层」，抄 BitFun 的 `check:core-boundaries`
（把依赖方向做成 CI 检查，而不是写进文档靠人自觉）。

三个设计决定：

| | 为什么 |
|---|---|
| 判定写成纯函数 `collectBoundaryViolations(files, layerRoot)` | 不读磁盘才能喂合成的违规输入。**这是为了让负对照做得成** |
| `import type` 一样算越界 | 类型依赖同样是依赖方向；编译期抹掉不代表设计上可以反向依赖 |
| 除别名外还查相对路径爬出 | 只查 `@server/domains/` 会漏掉 `../domains/deck/tools`，而那正是「顺手改一下」最可能写出来的形状 |

还有一条**防空跑**的断言：先验证扫到的文件数 ≥ 5 且包含 `runtime/llm.ts`。
没有这条，目录一改名检查就会「零文件、零违规、全绿」地静默失效 ——
和第十二轮图标身份钉法那个假钉法是同一类病。

**真负对照做过**：合成输入过了不算数，往真实的 `runtime/llm.ts` 里插了一条
`import type { DeckState } from '@server/domains/deck/tools'`，
判据立刻变红并点名该 specifier；还原后复跑全绿、`git diff` 干净。

#### A3：工具配额从控制流改成数据

拆层前 `roles.ts` 里是一个 switch：「planner/reviewer 拿这 5 个，generator/editor 拿全集」。
那个形状有两个问题，接第二个域之前必须先解决：

1. 组合规则写在控制流里，看不出「谁能做什么」，也没法测
2. **它假设只有一个域**。第二个域进来时 `allTools` 是哪个域的？
   switch 里要不要再加一层判断？—— 每加一个域就要改一次角色定义

改成：**域声明自己有哪些组，agent 声明自己要哪些组**，装配是一个域无关的纯函数。

| 新增 | 位置 | 是什么 |
|---|---|---|
| `selectToolGroups` / `findUngroupedTools` | `runtime/toolRegistry.ts` | 域无关装配。**不知道 deck 是什么，也不该知道** |
| `DECK_TOOL_GROUPS`（6 组 23 工具）· `DECK_ROLE_TOOL_GROUPS` | `domains/deck/toolGroups.ts` | deck 域的分组与角色配额 |

分组按「一次能力」切而不是按「读/写」切（read · slide · element · layout · theme · animation）——
读写只有两档，表达不了「能改内容但不许动主题」这种配额，
而那正是接入更多 agent 之后马上会需要的。

`as const satisfies ToolGroupMap<AgentTools>`：组里写错工具名是**编译错误**，
同时组名保持字面量联合，`DeckToolGroup` 自动跟着长，不用手抄一份组名列表。

**未知组名抛错，不静默跳过** —— 这条和 `budget.ts` 对非法环境变量
「一律忽略退回默认，不报错」的处置**故意相反**，因为输入来源不同：
`AGENT_MAX_STEPS=abc` 是用户在部署环境里打错的字，启动失败比用默认值更糟；
而工具组名是代码里的常量，打错就是程序员的错，
静默跳过的表现是「agent 突然什么都不会做了」，比启动时抛明确错误难查一个数量级。

#### A3 的判据：期望独立抄一份，不从数据反推

新增 22 条（`runtime/__tests__/toolRegistry.test.ts` 11 +
`domains/deck/__tests__/toolGroups.test.ts` 11）。

**关键设计：把拆层前的配额硬编码成期望**，而不是从 `DECK_ROLE_TOOL_GROUPS` 反推。
从数据反推的测试是不设防的 —— 改了数据、期望跟着改，测试照样绿。
这一组的价值全在「期望是独立写下来的那 23 个键 + 那 5 个只读键」。

守住的三件事：

- **配额等价**：planner/reviewer = 那 5 个；generator/editor = 全部 23 个
- **零漏网工具**（`findUngroupedTools` 为空）—— 加了第 24 个工具却忘了归组时，
  它会编译过、测试过、然后**永远不出现在任何 agent 手里，且没有任何东西报错**。
  和第七轮动画「死词表是 0 个」是同一类判据
- **挑出来的是同一个工具对象不是拷贝** —— 哪天变成结构化克隆，
  `tool()` 闭包捕获的 accessor 会静默失效

**两个真负对照都做过**：
① 给 generator 少发一个 `theme` 组 → 等价性判据变红；
② 把 `setSlideBackground` 从组里删掉 → **4 条同时红**（等价性 2 条 + 完整性 2 条）。
两次都还原干净、`git diff` 为空。

#### A4a：任务注册表 —— 顺带修掉两个真 bug

`runtime/taskRegistry.ts`。原来是 `orchestrator.ts` 里一行
`new Map<number, AbortController>()`，按 `userId` 键。两个问题：

**① 键错了。** 按 userId 意味着一个用户全局只能跑一个任务，打开两份演示文稿也不能各跑各的。
真正需要串行的是「同一份 deck」—— 画布是单一权威，两个任务同时改一份 deck 就是改动丢失。
改成按工作区键（`deck:42`）：**跨 deck 并行、同 deck 串行**。

**② 注销存在 ABA 竞态。** 原来取消和收尾都执行 `activeTasks.delete(userId)`：

```
任务 A 在跑         → { u1: ctrlA }
用户取消            → ctrlA.abort() + delete   → {}
用户立刻重发任务 B  → { u1: ctrlB }
任务 A 的 finally   → delete                   → {}   ← 把 B 的注册删掉了
```

此后 B 在跑但没登记：取消找不到它，还能再并发起第三个任务。
表现是「取消之后偶尔会有两个 agent 同时改同一份 deck」，
**且只在用户取消后马上重发时出现，手测几乎撞不到**。

修法抄 BitFun 的 `UserInputRegistration`（docs/10 第 1.2 节）：
注册时发一张收据，**注销必须出示收据**，只有仍持有当前注册的那一方才删得掉。

一个刻意的行为：**取消之后到任务真正收尾之间，该键仍然占用**。
此刻重发会收到「已有任务在执行中」—— 这是对的，
上一轮的收尾写入（保存 deck、推送状态）还没跑完，
放新任务进来正是 BitFun 状态机 `FINISHING` 要防的「排队输入和收尾写入抢跑」。

协议随之改动：`agent.cancel` 加 `deckId`（前端 store 本来就有 `currentDeckId`）。
不带 deckId 就没法点名取消哪一份演示文稿的任务。

判据 16 条（`runtime/__tests__/taskRegistry.test.ts`），其中「ABA 竞态」一组
**就是那个 bug 的复现脚本**，外加一条负对照：用 `Map` 模拟「按键删除、不看收据」的旧实现，
确认它在同一序列下确实会漏。

#### A4b：把 deck 剧本搬回域里

`agent/orchestrator.ts` **572 → 84 行**，其余搬进 `domains/deck/pipeline.ts`。

搬的理由是分层：那 500 行全部是 deck 专属的（剧本、deck 持久化、会话与消息落库、角色循环），
放在装配层里等于 `domains/deck/` 没有 deck 的编排。
装配层现在只剩两件事：**持有跨域共享的任务注册表**、**占坑 / 注销并路由到域的剧本**。

**没有顺手抽泛型的 `runTask` 骨架** —— 原计划要抽，做的时候改了主意：
抽骨架得先知道「第二个域会共用什么」，而 research 域还不存在，
现在抽等于照着想象划接缝。08 号文档第九节的教训是别为想象中的需求建抽象。
等 research 落地、能看见真正共用的部分再抽。

**会话也留在 deck 域**：`conversations.deckId` 是指向 `decks` 的硬外键，
会话在**表结构层面**就绑死了 deck。真正解耦要一次数据迁移（加 `workspace_kind`，默认 `'deck'`），
在第二个域真的需要会话之前那是纯粹的风险。
迁移发生时改的是 schema 和域里的查询，`runtime/` 不受影响 —— **判据 2 仍然成立**。

顺带消掉一处易漏点：拆层前「演示文稿不存在」那条提前 return 要**手动记得还坑位**，
现在占坑在装配层、注销在 `finally`，每一条退出路径都会走到，漏不了。

边界判据同时扩成守两个方向：新增 **`domains/` 不得依赖装配层**
（域可以依赖 runtime，那是地基；反向依赖会让「换一种装配方式」变成要改域的代码）。

**搬运忠实性是逐行验过的**：把 HEAD 的 `orchestrator.ts` 与新 `pipeline.ts` 去注释后 diff，
54 处差异**全部可归因**到四类预期改动 —— import 路径、
`runAgentTask` → `runDeckTask` 的签名（改收 `signal`）、`abort.signal` → `signal`、
以及占用守卫和 `cancelAgentTask` 移出。没有一处是意外的逻辑改动。

eslint 也是旁证：HEAD 的 orchestrator 是 `3e 6w`，
现在 orchestrator `0e 0w` + pipeline `3e 6w` —— **违规原样跟着代码搬走了，一条没多一条没少。**

#### 验证

四道闸门全过。**外加实际启动后端** —— 雷区 #1 的教训是
`tsc` 过了不代表 bun 能加载（34e45c7 当初 tsc 也是绿的）：
`PORT=3099 bun run src/index.ts` 正常起，`/api/auth/me` 无 token 返回 401。

测试 **831 → 885**（A2 边界判据 14 条 + A3 工具组判据 22 条 + A4 注册表判据 16 条；
原有 831 条一字未改）。

行为等价的旁证：`git status` 把 22 个文件全部识别为 **rename**，
内容改动只有 2 个文件 —— `orchestrator.ts`（import 改别名 + 头部注释）和
`routes/conversation.ts`（1 行）。

#### 判断错过的地方

**① 判据 3 我写对了结论，理由是错的。**
写 11 号文档时我认为「不许改测试」需要靠自律，
实际是「源文件和测试一起搬」这个结构性办法让它自动成立。
**当时没想到这个办法就把判据写下去了** —— 判据比我理解的更强，属于蒙对。
真正的教训是：判据该在排完依赖图之后写，不是在规划时凭感觉写。

**② 又在 LSP 上折腾了一轮。**
重启后 `.ts` 仍报无 server，查出 `typescript-language-server` 装在
`~/.local/node/bin`，而 CC 进程的 PATH 里没有它（rust-analyzer 能用是因为在
`/opt/homebrew/bin`）。软链过去了，但**还要再重启一次才生效** ——
LSP 注册表是会话启动时快照的。这一轮全程还是 grep + Read 做的。

### 2026-08-19 第十五轮：中途落库 + 取消回收在途事件（R-44）

[11-agent-roadmap.md](./11-agent-roadmap.md) **B 期第一组**，治的是 11 号文档第三节
③ ④ 两条：`saveDeckState` 只在最后调一次、`cancelAgentTask` 只 `abort()`。

#### ① 中途落库

原来 `saveDeckState` 在剧本最后调一次，而 `agent.deck` 每步实时推画布。
中途失败 → **画布上有改动、库里没有**，刷新即丢。这比「留半成品」更隐蔽 ——
它是前后端不一致，界面上完全看不出来。

改法**不是**「在更多地方记得调 `saveDeckState`」。那是把「两件事各自做对」当解法，
而它已经错过一次了。新增 `runtime/commit.ts`，把两者合成**一次 `commit`**，让它们不可能错开。

**先量再定 cadence**：12 页 / 129 元素的 deck 序列化 43.5 KB，
按 `db/index.ts` 同款 WAL 建库实测 `JSON.stringify + UPDATE` **0.19 ms/次**，500 次 94 ms。
相对于一次任务几十步 LLM 调用（每步几十秒），逐 mutation 落库是白送的 ——
**节流、合并、防抖这些设计问题量完就不存在了**，直接每次都写。

三个刻意的决定：

| | 为什么 |
|---|---|
| **先落库，再推画布** | 反过来的话，写库失败会留下「画布已经变了、库没变」——正是要修的那个形状 |
| **内部串行**（尾巴 promise 排队） | 模型可以在一步里发多个工具调用，SDK 并发执行。两次提交同时在飞时，写库完成的先后可能和调用先后相反，结果是**库停在 state1、画布停在 state2** —— 只在并发下出现、手测撞不到 |
| **写库失败向调用方抛，不吞** | 吞掉的话工具会回一句 `{ ok: true }`，agent 不会重试，这条修改从此谁也不知道丢了 |

`DeckStateAccessor.onChange` 随之改成可 `await`，`applyMutation` 变 async。
**17 个调用点一个字都没改** —— 它们全是 `return applyMutation(...)` 且外层已经是
`async execute`，返回 promise 自动展开。只有 `setTheme` 那处手写的 `onChange` 要单独加 `await`。

#### ② 取消回收在途事件

`abort()` 掐的是 LLM 那条 fetch，而**正在执行的工具函数一个都不看 signal** ——
它们会跑完，然后照常往 WebSocket 上发 `agent.text` / `agent.tool` / `agent.reasoning`。
用户看到的是「点了取消，面板还在自己往下滚」。

新增 `runtime/cancellation.ts`：abort 之后，可回收的事件不再投递。
抄 BitFun 的 `is_reclaimable_stream_data`（docs/10 第 1.4 节）。

**世代号没抄。** BitFun 要 `execution_generation` 是因为事件先进优先级队列、可能延迟出队；
我们的 `send` 在调用点同步发，`signal.aborted` 一置位后面每次都看得见。
唯一会让它变必要的路径是 `taskRegistry.cancelAllMatching`（它立刻删注册，
新任务能在旧任务收尾前占同一个键）—— 而它**目前零调用方**，是 A4 给「登出 / 断线取消」留的接口。
**接那条路时要连世代号一起补**，记在这里免得到时候忘了。

闸门还数被丢掉的条数。抄 BitFun 视口登记处那句：
「一个『拒绝』的写者也要说出来 —— 没发生的写入在别处完全不可见，
而『什么都没发生』才是更常见的报障。」闸门坏掉的两种表现（该丢的没丢 / 不该丢的丢了）都只有计数看得见。

#### 判据 4 被改写了 —— 这是一次改自己的验收标准

原文：**「取消后不再有任何 `agent.*` 消息到达前端」**。

中途落库落地之后这条和判据 5 会互相顶：abort 之后当前步的 mutation 仍会落库，
如果闸门把配套的 `agent.deck` 一起丢掉，**画布就比库少一步**，判据 5 破。

摆了三个方案（前端收到取消回执后重新拉一次 / `agent.deck` 永不回收 / 什么都不补），
**决策者选了「`agent.deck` 永不回收」**。改写后：

> 取消后除 `agent.deck` 外 `agent.*` 为 0 条；
> 且任务结束时库里的 `slidesJson` 与最后一条 `agent.deck` **逐字节相等**。

比原判据强 —— 它断言的是**与库相等**，而不是**没有消息**。
和 BitFun 也一致：它回收的是 `TextChunk` / `ThinkingChunk`，不是权威状态。

取消的**回执**不受影响：`ws/handler.ts` 收到 `agent.cancel` 当场就回一条，
所以剧本这边彻底静音不会让用户失去反馈。

#### 为了能测，挪了两处代码出来

`pipeline.ts` 经 `db/index.ts` 拉进 `bun:sqlite`，**在 vitest 里 import 不进来**
（实测报 `Failed to load url bun:sqlite`，和当初 `budget.ts` 被拆出去是同一个原因）。
写在里面的东西等于没有判据，所以挪了两块出来：

| 新文件 | 是什么 | 不挪出来会怎样 |
|---|---|---|
| `domains/deck/events.ts` | 取消策略（哪些事件放行） | 这是本轮**唯一的策略决定**，躺在 pipeline 里只能靠读代码确认 |
| `domains/deck/channel.ts` | 闸门 + 提交器的接线 | **零件对 ≠ 装配对**。R-36 静态核过「45 个 cssClass 都有定义」但没有一个被看过，是同一类病 |

策略写成 `Record<ServerMessage['type'], 'survives' \| 'reclaimable'>` 而不是一行
`msg.type === 'agent.deck'`：协议里加一种新消息却忘了决定它的取消策略时，**这里编译不过**。
一行写法会让新消息默认落进「可回收」而没有任何东西提醒 ——
如果那条新消息恰好是权威状态，表现就是「取消之后画布悄悄少了一块」。
和 `toolGroups.ts` 的 `satisfies` 防的是同一类病。

`runRole` / `runRoleToCompletion` 的 `ws` 参数换成了通道。
它们对 ws 的用法**只有发消息**一种，换掉之后角色循环不再知道 WebSocket 存在，
取消回收与落库也就有了唯一入口 —— **想绕过它们得先改签名**。

#### 测试 885 → 930

| 文件 | 条数 | 守什么 |
|---|---:|---|
| `runtime/__tests__/commit.test.ts` | 15 | 顺序 / 失败不推画布 / 失败不毒死链 / 并发串行化 / 中途 kill / drain / 计数 |
| `runtime/__tests__/cancellation.test.ts` | 8 | 取消前后的投递、signal 发送时读、闸门非一次性、计数 |
| `domains/deck/__tests__/channel.test.ts` | 10 | **判据 ① 和 ② 就在这里**，加接线本身 |
| `domains/deck/__tests__/toolCommit.test.ts` | 7 | 真工具 + 真提交器：每次调用后不变量成立、工具必须等写入落地才返回 |
| `domains/deck/__tests__/events.test.ts` | 5 | 策略表逐条，期望独立抄一份 |

原有 885 条一字未改。

#### 八个负对照，全部挂到真源码上跑过

「合成的输入过了不算数」（A2 立的规矩），所以每一条都是真的改坏 `server/src/` 里的文件：

| 改坏什么 | 变红 |
|---|---|
| ① 闸门不看 `signal` | cancellation 7 · channel 3 |
| ② 先推画布再落库 | commit 3 |
| ③ 去掉串行化 | commit 1 |
| ④ `applyMutation` 不 await onChange | toolCommit 3 |
| ⑤ `setTheme` 不 await onChange | toolCommit 1 |
| ⑥ `agent.deck` 改成可回收 | events 4 · channel 3 |
| ⑦ 接线时 signal 接错 | channel 3 |
| ⑧ publish 绕过闸门 | channel 1 |

八条全部还原干净，复跑 930 全绿。

#### 验证

四道闸门全过（930 / build / type-check / server tsc），**外加实际启动后端** ——
`PORT=3099 bun run src/index.ts` 正常起、`/api/auth/me` 无 token 返回 401。

eslint：4 个新源文件 + 5 个新测试文件**全部 0 问题**；
`tools.ts` 23 → **22** errors（`setTheme` 的 execute 现在有 await 了，少一条 `require-await`）；
`pipeline.ts` 3e 6w → 3e **7**w，多的那一条是新加的 `console.log`（该文件本来就有 7 条）。

#### 判断错过的地方

**① 两个判据是假的，而且都只有挂负对照才暴露。**

- `toolCommit` 那条「工具必须等写入落地才返回」写的是 `await Promise.resolve()`，
  只推进一个微任务 tick —— 「没 await onChange」的版本也来得及显示成「还没返回」，
  **两版都是绿的**。改成 `setTimeout(0)` 落到宏任务才分得开。
- `channel` 那条「`agent.deck` 也走闸门」用的是 `emit`，而 `emit` 无论如何都走闸门 ——
  把 `publish` 改成绕过闸门**照样全绿**。它测的根本不是 publish 那条路，得用 `commit` 验。

两条都是「测了一件必然成立的事」。这一轮真正的收获是：
**负对照不只在验代码，它同时在验判据本身。**
R-36 那次负对照回答的是「检查器会不会红」，这次回答的是
「判据测的是不是它名字说的那件事」—— 后者更隐蔽，因为它全程绿着。

**② 差点把一个没做成的验证记成做过的。**
负对照②（顺序反过来）第一次用 perl 改，模式没匹配上，文件根本没变，而测试**全绿** ——
我差一点就把这条记成「负对照通过」。实际上它证明的是「没改代码时测试是绿的」，一句废话。
后面每一条都加了 `grep` 先确认改动真的落到文件上再跑。
**「跑出来看」的前提是先确认跑的是改过的那一版。**

**③ 后端第一次没起来，是我从仓库根跑的。**
`migrate()` 的 `./drizzle` 相对 cwd，从根跑直接死在 `Can't find meta/_journal.json`；
而在死之前 `db/index.ts:10` 已经 `mkdirSync('./data')` 了，
于是仓库根多出一个 `data/rabbit.db`（0 张表）—— 而 `.gitignore:38` 只忽略 `server/data/`。
**必须从 `server/` 起**。顺带值得补一行 `/data/` 进 `.gitignore`，
或者把 `DB_PATH` 改成相对 server 目录解析。

#### 这一组没做的（说清楚边界）

中途落库**拿掉了一个白捡的「全或无」回滚** —— 原来任务失败时库是干净的，
现在失败 / 取消之后半成品**永久留在库里且没有撤销**。
11 号文档判据 5 就是这个方向，但在 B 期的 **checkpoint / 回滚**落地之前，
中间有一段「失败即留半成品」的窗口。这是有意的取舍，不是漏掉的。

`FINISHING` 态、权限闸门、上下文压缩、子任务派生、收益递减都还没做，它们是 B 期后面的活。

### 2026-08-19 第十六轮：单一权威写者（R-45）

B 期第二组。治的是 docs/10 可迁移清单第 1 条 —— **清单里唯一一条「真实改动丢失」**。

#### 先把 bug 变成看得见的

症状是可以推理出来的，但推理出来的 bug 和看见的 bug 不是一回事。
先写了 `src/store/__tests__/deckWriter.test.ts`，用**真 pinia store 跑真路径**
（`agentStore.handleMessage` → `slidesStore`），三条断言当时全绿 —— 绿的是**坏行为**：

- 用户拖动的元素位置，下一条 `agent.deck` 到达即消失
- 用户新加的元素整个不见
- **连 Ctrl+Z 都救不回来** —— `setSlides` 只替换数组 + `version++`，
  不经 `addHistorySnapshot`，所以 agent 那次覆盖**根本不是一个撤销步**

第三条是查的时候才发现的，它把这个 bug 的严重性抬了一档：不是「改动被盖掉」，是「改动被盖掉且没有退路」。

#### 契约：对称的所有权

抄 BitFun 的 TurnOwnership（docs/10 第 1.7 节）：
**同一份文档同一时刻只有一个权威写者，所有权在终止事件上恰好转移一次。**

| 所有权 | 用户写入 | `agent.deck` |
|---|---|---|
| `agent` | 拒绝（画布锁住） | 应用 |
| `user` | 应用 | **丢弃** |

**后半条不是对称美学，是断线时的救命绳。** 点「接管」**本地立刻转移所有权，不等后端确认** ——
`send()` 在 socket 未连接时是空转（`services/websocket.ts:140`），
要是解锁得等后端回消息，断一次线画布就永久锁死了。
**一把鼠标解不开的锁比丢一次改动更糟。** 代价是后端任务还在收尾、还会推几条 `agent.deck`，
而它们正好被「`user` 持有时丢弃 agent 写入」这半条挡住。

#### 守卫放在 store 里，不放在调用点上

实测 `slidesStore` 的写 action 有 **197 个调用点、散在 77 个文件**。
挨个拦是那种「做了 80% 然后静默回归」的活。守卫放进 store 的 action 里，
**一处覆盖全部调用点**。

三个刻意的例外：

| | 处置 | 为什么 |
|---|---|---|
| `setSlides` | **不锁** | 它是「装载 / 清空整个文档」的路径（打开、登出清场、导入、撤销重做）。锁住它，登出时清不掉画布，换账号会看到上一个人的文稿 —— 比它防住的问题更糟 |
| 撤销 / 重做 | 在 snapshot store 单独挡 | 它们绕过细粒度 action 直接整份替换，画布守卫拦不住 |
| `setTitle` / 视口 | 不锁 | agent 根本不写这两样，不存在两个写者 |

顺带把 `setSlides` 里的 `this.setTheme(themeProps)` 改成直接赋值：
`setTheme` 现在带守卫，转调会让锁定期间的整份替换**只写一半**（slides 写了、theme 和 version 没跟上）。

#### 所有权由事件驱动，不从画布推导

BitFun 那句点破要害的话：「问『这个 Turn 在屏幕上看起来完成了吗』正是这个契约要消除的那种检查」。

- `submitTask` → 取所有权。**在发出请求时就取，不等后端回第一条消息** —— 那段空窗期用户照样能拖
- `agent.status` 为 `done` / `error` → 还所有权。每次任务恰好一条终止事件（上一轮已经验过）
- `reset()` → 兜底解锁。切文稿 / 登出 / 清空历史时要是还锁着，新文稿会带一把没有任何任务与之对应的锁

#### 锁必须看得见

写入守卫在 store 里，用户拖不动元素时界面要是什么都不说，**表现就是「编辑器坏了」**。
`views/Editor/index.vue` 在 CanvasTool 和 Canvas 之间加了一条横幅
（紧贴画布上沿 —— 它解释的是「为什么拖不动」，离画布越近越容易被联系起来），
右侧一个「接管并编辑」。**这条横幅是那把锁唯一的解释，也是唯一的钥匙。**

#### 测试 930 → 945

15 条，全在 `deckWriter.test.ts`：锁定期间六类写入被拒 · agent 自己的写入照常 ·
接管后可写且迟到的 `agent.deck` 被丢 · 接管不依赖后端确认 ·
终止事件解锁 / 中间态不解锁 / `reset` 兜底 · 撤销重做被挡 · `setSlides` 仍可清场。

**五个负对照全部挂到真 store 上跑过**：

| 摘掉什么 | 变红 |
|---|---|
| ① 全部用户写入守卫 | 2 |
| ② `applyAgentDeck` 的对称守卫 | 1 |
| ③ `submitTask` 不取所有权 | 7 |
| ④ 终止事件不还所有权 | 2 |
| ⑤ 撤销 / 重做不挡 | 2 |

全部还原干净，复跑 945 全绿。eslint：4 个改动文件与 HEAD 同为 0 问题。

#### 没做的 / 没验的

- **横幅只验到「CSS 编译进了产物」**（`dist` 里能查到 `.deck-locked-banner`，
  `$themeColor` 解析成 `#d14424`），**没有在浏览器里看过它长什么样**。
  逻辑全测了、样式没眼看过 —— 这一条得跑一次 `npm run dev` 才知道。
- **后端没有加对应的闸门。** `PUT /decks/:id` 在任务运行时仍会接受写入。
  画布锁住之后前端在运行期不会发这个请求，所以这条不再是「两个写者抢」，
  而是**陈旧标签页**的问题 —— 而那是个独立的老毛病：`decks.version` 的乐观并发
  后端实现了（`routes/deck.ts:60`），**前端的 `saveDeck` 从来不传 `version`**，
  于是那道检查一次都没生效过。已记进待完成。

### 2026-08-19 第十七轮：D1 的设置面 —— 对象存储 / 素材来源 / 模型限流（R-46）

D1（图片能力）的**配置层**。按「先把设置搞定，再实装功能」做，
所以这一轮**没有** `searchImage` / `generateImage` 工具，agent 还拿不到图。

#### 先把两条路探通了（探针不入库）

| | 结论 |
|---|---|
| 腾讯云 COS | ✅ 可用。新建 `rabbit-1307074209`（ap-guangzhou，公有读），配好 CORS `*` |
| 生图 | ✅ 可用，**零新凭证** —— 用库里已有的 Gemini provider |

生图的正确形状（**用户给的 Python 片段跑不通**，`:predict` 在那个中转上三个模型名全 404）：

```
POST {origin}/v/v1beta/models/gemini-3.1-flash-image:generateContent?key=…
{ "contents": [{ "role": "user", "parts": [{ "text": … }] }],
  "generationConfig": { "responseModalities": ["IMAGE"] } }
→ candidates[0].content.parts[].inlineData.data   (base64 PNG)
```

`role: "user"` 不能省，少了 400。全链路实测：生图 → sha256 → 传 COS → 匿名读**字节逐一致** → 跨域读 `allow-origin: *`。

#### 落地的东西

| | |
|---|---|
| `storage_configs` 表 | 单行。COS 凭证 / 桶 / 地域 / 前缀 / 自定义域名 / 启用 |
| `asset_sources` 表 | 单行。搜图源 + key、生图模型、长边上限、两个独立开关 |
| `model_configs.rate_limit_per_min` | 按模型配限流，null = 不限 |
| `runtime/objectStore.ts` | COS 签名 v5 + 内容寻址上传，**时钟注入** |
| `runtime/imageSearch.ts` | 四家图库收敛成一个形状 + 硬超时 |
| 设置页 ×2 | 「对象存储」「素材来源」，都带**真实连接测试** |
| 模型管理 | 加「每分钟上限」列 |

**搜图和生图刻意分成两个开关、两个工具**：耗时差 15~50 倍、配额松紧完全不同。
生图被限流时 agent 自己改用搜图 —— 选图源是**内容决策**，本来就该模型做，
和「排版决策不该给模型」不冲突。

**密钥永不回传前端**：响应里只有 `hasSecretKey: boolean`；提交时留空 = 不改动已存的那把。
`PATCH /admin/models/:id` 顺手从 `set(await c.req.json())`（任意列都能写）收紧成 Zod 白名单。

#### 三个实测撞出来的坑，都不在图片本身上

**① `Bun.serve` 默认 `idleTimeout` 只有 10 秒。**
超了它自己掐掉请求，日志里只留一句 `request timed out after 10 seconds`，
客户端拿到一个没有响应体的失败。**这条会让 D1 必然失败** ——
搜图 5~9.5 秒（时好时坏），**生图 15~50 秒，每一次都会被掐死**。
而且它骗人：浏览器里失败、curl 却成功，差别只是那一次快了几秒。已设成上限 255。

**② bun 的 fetch 不回退 IPv4。**
`commons.wikimedia.org` 的 AAAA 在这条网络上连不通，bun 直接卡 15 秒超时。
`dns.setDefaultResultOrder('ipv4first')` 在 bun 里是**空操作**，只有环境变量有效。
已写进 `server/package.json` 的 dev / start 脚本，**不靠人记得**。

**③ Wikimedia 是个弱兜底，比我一开始说的弱得多。**
先是 9.5 秒返回、再是 4.9 秒，十分钟后**完全连不上**（curl -4 也 30 秒超时）。
不是慢，是时通时不通。所以搜图加了 8 秒硬超时 —— **挂住比失败更糟**：
没有它，一次搜图会一直拖到服务器的 255 秒才算完，agent 干等。
相关性也一般（「business team meeting」搜出拉斯维加斯赌场照片）。
**能注册到 Unsplash / Pixabay 的 key 就别用它。**

#### 测试 945 → 965

`objectStore.test.ts` 20 条。签名那组的钉法值得记：
**照腾讯云签名 v5 的文字规范在测试里独立实现一遍再比对**，
不是把当前实现的输出抄下来当期望（那种测试改了实现跟着改，不设防）。
外加 5 条负对照（换密钥 / 换方法 / 换路径 / 换时间 / 加 header，签名都必须变）——
**签名错了的表现是 403，而 403 看起来跟「密钥填错」一模一样**，人第一反应永远是去查凭证。

`imageSearch.ts` 和路由没有单测：前者是纯网络 IO，后者经 `db/index.ts` 拉 `bun:sqlite`
（vitest import 不进来）。这两块靠真实往返验的，见下。

#### 验证：真的起了前后端，在浏览器里看了

四道闸门全过 + 后端实起。外加 playwright 驱动真实前后端：

- 三个页面截图逐一看过，无控制台错误
- **看出一个 bug**：生图模型下拉显示裸的 `0` —— 我用 0 当「未选择」哨兵值，
  但下拉里没有对应选项，原始值漏到界面上了。补了 `{ label: '未选择', value: 0 }`
- 真实点选模型 → 开两个开关 → 保存 → **查库确认落库**（`1|18|1|1600`）
- 点「测试」→ 就是在这一步撞出了上面的坑 ①

COS 连接测试实测：`ok:true`、`publicReadable:true`、`corsAllowOrigin:*`、995ms，
且它会把「桶不是公有读」「没配 CORS」分别报成告警 —— 后者尤其重要，
**没有 CORS 时画布一切正常，只有导出 PPTX / PNG 时图片静默丢失**。

#### 判断错过的地方

**① 我说「你那个 Gemini 中转是坏的」，错了。**
是我路径探错：`/v` 404、`/v1beta` 500，正确的是 `/v/v1beta`。
中转好得很，23 个模型都在。**我该先用 `GET /models` 确认路径再下结论**，
而不是从一个 500 直接推断服务坏了。

**② 顺带查出库里 Gemini provider 的 baseUrl 配错了。**
填的是 `https://g.92.run/v`，SDK 会拼成 `/v/models/…` → 404。
应改成 `https://g.92.run/v/v1beta`。`normalizeBaseUrl` 没自动修是**故意的**
（注释写着「路径已有内容的一律不动，宁可不修也不能把本来能用的配置改坏」），这条判断仍然对。
四个角色现在全跑在 DeepSeek 上，所以没人发现 Gemini 这条是断的。

**③ 起 vite 时 `cd` 泄漏到了后一条后台命令**，导致 vite 在 `server/` 里启动、
报「找不到入口」。多花了一轮才看出来 —— 复合命令里的 `cd` 会影响同一次调用中后续的命令。

#### 补记：Pixabay 接上了，并抓到一个自己写的真 bug

拿到 key 之后实测，**Pixabay 明显优于 Wikimedia**：

| | Pixabay | Wikimedia |
|---|---|---|
| 延迟 | **347~1197 ms** | 5000~9500 ms，或完全连不上 |
| 「business team meeting」 | 真的商务照片 | 拉斯维加斯赌场 |
| 中文 / 抽象概念 | 都正常 | 抽象概念不对题 |
| 单图体积 | ~200~280 KB (JPEG) | — |

搜图全链路实测通过：搜 → 下载 → sha256 → 传 COS → 匿名读 → 跨域读 → 清理。
顺带一个数字：搜来的 JPEG 约 280 KB，而生图的 PNG 是 1~2 MB —— **搜图对存储轻一个数量级**。

**抓到的真 bug**：我交出去的是 `largeImageURL`（最长边被缩到 1280），
报的宽高却是 `imageWidth/imageHeight`（**原图**，能到 5760）。
版式拿这个宽高算 cover / contain，就会以为手里有张 5760px 的图而实际只有 1280px ——
**满屏背景直接糊掉，且不报任何错**。修法是按最长边换算，实测三组全中
（3354×2019→1280×771 · 5760×3840→1280×853 · 5868×4004→1280×873），
修完再打真 API 逐张比对下载到的真实像素，**包括竖图 921×1280 全部一致**。

判据的期望值是**实测量出来的**（抓真实响应 + 从 JPEG 的 SOF 段读像素），
不是从公式反推 —— 那样只能证明「代码等于代码」。

按文档同时补上：`safesearch=true`（图要插进用户文稿）· `lang` 自动切 zh ·
`q` 截到 100 字符 · `per_page` 夹到 3~200 · 429 单独报「100 次/60 秒」。
`fullHDURL` / `imageURL` 实测**本 key 没有**（需申请完整 API 权限），所以 1280 就是上限。

**三条合规要求钉进了模块注释**，因为它们最容易在实装时被忘掉：
不许长期热链（我们下载后传自己的 COS，本来就合规，但**绝不能把图库 URL 写进 deck**）·
必须署名（`attribution` 字段留了**不等于兑现了**）· 请求要缓存 24 小时（**搜索请求还没缓存**）。

#### 没做的

- **`searchImage` / `generateImage` 工具没有注册给 agent**。按 R-32 的教训，
  没实现的工具不注册（「一个永远返回『未接入』的工具只会白白消耗步数预算」）
- 限流的**执行**（`runtime/rateLimiter.ts`）没写，现在只有配置字段
- 图片压缩（`maxEdgePx`）只有配置，没有实现
- `assets` 任务表 / 票据状态机没建

### 2026-08-19 第十八轮：D1 的工具层 —— agent 真的能拿到图了（R-47）

上一轮做完配置层，这一轮把 `searchImage` / `generateImage` 接成 agent 真能调的工具。
**08 号诊断里「最大的一条」到这一轮为止闭环了**：从纯文字到有图。

#### 动手前先量，四个数字改掉了两个原定方案

「先量再定」这条第十五轮用在落库 cadence 上，这轮用在压缩上。真打 API 量出来：

| | 实测 | 对 `max_edge_px = 1600` |
|---|---|---|
| 生图 `gemini-3.1-flash-image` | **1408×768 PNG，1.5~2.0 MB**，14~15 秒 | 长边 1408，**不触发缩放** |
| `aspectRatio: '16:9'` | 1376×768，922 KB，14.0 秒 | 同样不触发 |
| `aspectRatio: '1:1'` | 1024×1024，370 KB，13.8 秒 | 同样不触发 |
| 搜图 Pixabay `largeImageURL` | 1280 长边 JPEG，165~279 KB，540~800 ms | 同样不触发 |

两个结论都和动手前的设想相反：

**① 那个「长边上限」配置在默认值下一次都不会生效。** 省下来的字节
**全部来自 PNG → JPEG 重编码**。缩放仍然实现了（配置能调到 1280 以下），
但它不是主角 —— 差点把「缩放做完了」当成「压缩做完了」。

**② `imageConfig.aspectRatio` 是生效的，但给的不是精确比例**
（16:9 要 1.778，实得 1376/768 = 1.792）。所以下游一律用**解码出来的真实像素**，
不拿请求时的比例去推 —— 上一轮 Pixabay 那个「报原图尺寸、给缩略图」的真 bug 就是这么来的。

#### 四个拍板的决策

| 决策 | 选了什么 |
|---|---|
| deck 里 `src` 存什么 | `asset://<hash>`，并把断掉的三处补上（兑现决策 E） |
| 票据语义 | **工具内同步等图**，票据表只做持久化 / 审计 / 署名反查 |
| 压缩 | 先实测再定，最后选纯 JS 编解码 |
| 署名 | 权威副本落 `assets` 表 + 工具返回值带上，界面显示留到下一轮 |

#### 为什么不做异步票据 —— 它和 B 期刚立的两条契约正面撞

`assets.ts`（R-32）当初设计的形状是「工具立刻返回 `asset://pending/<id>`，
后台完成后改元素的 src」，协议里的 `agent.asset.pending` / `.ready` 就是为那条路留的。
**这一轮没有走。** 摆开看：

| 契约 | 冲突点 |
|---|---|
| R-44 中途落库 | 所有 deck 变更必须走 `channel.commit`，而 channel 的生命周期**绑在任务上**（signal / drain / stats）。任务结束后没有 channel 可用 |
| R-45 单一权威写者 | 任务结束时前端把所有权还给 `user`、画布解锁。此后再推 `agent.deck` 会被对称守卫**丢弃且不报错** —— 图永远补不上 |

`events.ts:54` 的旧注释其实预见到一半：「真接上之后 `asset.ready` 会改元素的 src ——
那时它就是权威状态了，**要连同一次 commit 一起走**」。走同步这条路之后，
那个担心根本没有发生：图由 agent 自己调 `addElement` 写进 deck，
**deck 写入仍然只有 `applyMutation → commit` 一条路**，两条契约一个字都没改。

代价说清楚：生图那 14~15 秒 agent 是阻塞的，一份配 6 张图的 deck 多等 1.5 分钟。
步数预算不受影响（一次调用一步，上限 512）。真要异步，得先解决
「任务结束后谁是权威写者」—— 建议放到 C 期和 `FINISHING` 态一起做。

于是那三条 `agent.asset.*` 降级成**纯进度叙事**（填上那 14 秒的沉默 ——
`onStepFinish` 在工具**返回之后**才触发，那段时间面板上一条 `agent.tool` 都没有，
看起来就是卡死）。它们不改 deck，所以 `events.ts` 里「可回收」的分类继续正确。
新增的 `agent.asset.failed` 是因为少了它，面板那个「生成中」会一直转下去。

#### 限流：三样缺一不可，外加一样是实测撞出来的

`runtime/rateLimiter.ts`，滑动窗口 + 注入时钟。超限时**返回而不是抛**
（抛出去模型的默认反应是重试，而它一定会再被拒，白烧两步）。返回的形状：

```json
{ "ok": false, "reason": "rate_limited", "retryAfterSec": 37,
  "hint": "…约 37 秒后恢复。现在请改用 searchImage…**不要重试 generateImage**…" }
```

- `reason` 是**稳定机器码**，单测按它断言，不按提示语断言
- `retryAfterSec` 可以独立算一遍验证
- hint **点名替代工具** —— 不点名时模型只会重试。上一轮「搜图生图分成两个工具」
  就是为这一刻，分开了却不告诉模型等于没分

**最容易写错的是「超限不消耗名额」**：反过来写（先记时间戳再判断）会让被拒的调用
也把窗口填满，agent 每被拒一次就把恢复时间往后推一次 ——
表现是**限流一触发就永不恢复**，而日志里一切正常。

**外加一条是端到端跑出来才发现的**：库里配 3 次/分钟，而这个中转实际只放 2 次，
第 3 次直接 429。原来把它当普通 `provider_error`，提示语是「可以再试一次」——
**那正好是此刻最不该做的事**。改成：上游 429 也走 `rate_limited`，
并且 `limiter.block(key, 60)` 真的把这个键按死 ——
对方已经给了答案，没必要每次都再打一次才知道不行。

#### 压缩：三个候选都在 bun 里跑过，选了最不聪明的那个

| | q=82 输出 | 编码耗时 | 依赖性质 |
|---|---|---|---|
| `upng-js` + `jpeg-js`（**选它**） | 2000 KB → **333 KB**（6.0×） | 78 ms | 纯 JS，零 wasm |
| `@jsquash`（mozjpeg wasm） | 2000 KB → 254 KB（7.9×） | 366 ms | 多一条 wasm 加载路径 |
| `sharp` | 未测 | — | 原生编译，跨平台部署代价明显 |

mozjpeg 小 24%，但 **6 倍已经解决了问题**，再省 78 KB 不值得为它多一个
会在别人机器上炸的环节。速度不是理由 —— 相对 14 秒生图两者都是噪声。

确定**不用 WebP**：PPTX 对它支持很差，而这个项目的产物终点就是 PPTX。

**两个坑**：

- **JPEG 没有 alpha。** 透明 PNG 直接转过去，透明区域变黑且不报任何错。
  所以解码后逐像素查 alpha，有透明就保留 PNG —— 宁可大也不能把图毁了。
- **`upng-js` 解不了调色板 PNG（ctype=3）。** 它自己 encode 出来的都 decode 不回来，
  抛的是 `undefined is not an object (evaluating 'data[i]')` —— 排查的人根本看不出
  发生了什么。加了显式检测换一条说得清的错误。两条主路径都不碰它
  （生图实测 ctype=2、搜图是 JPEG），代价只是偶尔跳过一张索引色候选。

实测真图上的压缩：生图 656 KB → 48 KB、1312 KB → 112 KB（**11~13 倍**，
比合成素材上估的 6 倍还好，因为渐变图更适合 JPEG）；
搜图的 JPEG 走 `kept-as-is` 不做二次有损编码。

#### `asset://` 原来在导出路径上是断的，`setAssetBaseUrl` 从来没被调用过

这三条是读代码时查出来的，文档里一条都没记：

| | 状态 |
|---|---|
| `setAssetBaseUrl()` | **全项目零调用**，`assetUrl.ts:59` 的 `TODO(R-01)` 从 R-10 起一直没兑现。于是 `asset://<hash>` 一直解析成默认的 `/assets/<hash>`，一个必然 404 的地址 |
| PPTX 导出 | `useExport.ts:625` / `:549` 把 `el.src` **原样**交给 pptxgenjs。表现和上一轮那条 CORS 坑一模一样：画布上一切正常，只有导出时图静默消失 |
| 内容寻址 key | `contentKey()` 产出 `rabbit/<sha>.jpg`（带前缀带扩展名），而 `asset://<hash>` 的文法**两样都不带** |

三条都补了：上传时 key 不带扩展名（MIME 由 `Content-Type` 给，`contentKey` 本来就支持空扩展名）·
新增 `GET /api/assets/base-url` 让前端启动时问一次 · 导出两处过 `resolveAssetUrl`。

**为什么值得多一次往返，而不是把 COS 的 URL 直接写进 deck**：
换桶、挂 CDN、迁到别家对象存储时，改这一处配置**所有旧 deck 跟着走**。
把 `https://…/rabbit/<hash>` 写进 deck 的话，那天所有历史文稿里的图会一起失效。

#### 测试 978 → 1087

| 文件 | 条数 | 守什么 |
|---|---:|---|
| `runtime/__tests__/rateLimiter.test.ts` | 27 | 窗口边界 / **超限不消耗名额** / block 盖过配额 / retryAfterSec / 键隔离 / 时钟回拨 |
| `domains/deck/__tests__/assetResults.test.ts` | 30 | **限流返回形状（Q1 的判据）** / 合规① src 必是 `asset://<64hex>` / 合规② 署名透传 / 各失败机器码 |
| `runtime/__tests__/imageCodec.test.ts` | 25 | 格式判定 / 透明保护 / 面积平均算术 / 四条分支选择 / 索引色拦截 |
| `runtime/__tests__/searchCache.test.ts` | 20 | 键的四个维度 / 归一化 / 24 小时边界 / 空结果也算有效缓存 |
| `toolGroups.test.ts` | 11 → 18 | 加了「图片能力关着时整组不注册」一组 |
| `events.test.ts` | 5 | 样本 11 → 12（协议加了 `agent.asset.failed`） |

`toolGroups.test.ts` 那份「23 个键」的硬编码清单**按设计变红了** ——
它的注释写着「工具增删时这里先红，提醒去更新清单」。更新时把 deck 的 23 个
和图片的 2 个**分开列**，这样「原有配额有没有被动过」仍然一眼看得出来（判据 8）。

图片工具本体在 `assetTools.ts`（碰库，vitest 加载不了），
所以工具名单独放进不碰库的 `assetResults.ts`，再用一行编译期断言
把「字面量 ≡ 名字清单 ≡ 真实工具键」三方钉死 —— 否则「加了工具忘了归组」
这条判据对图片工具是**测不到**的。

#### 十五条负对照全部挂到真源码上跑过

| 改坏什么 | 变红 |
|---|---|
| ① 限流超限也记账 | rateLimiter |
| ② 窗口边界 `>` → `>=` | rateLimiter |
| ③ block 不再盖过配额 | rateLimiter |
| ④ `toolAsset` 不校验 hash 形状 | assetResults |
| ⑤ 限流提示语不点名 searchImage | assetResults |
| ⑥ 透明 PNG 也转 JPEG | imageCodec |
| ⑦ 面积平均改成只取一行 | imageCodec |
| ⑧ 不拦索引色 PNG | imageCodec |
| ⑨ 查询不归一化 | searchCache |
| ⑩ 24 小时边界 `<` → `<=` | searchCache |
| ⑪ limit 不进缓存键 | searchCache |
| ⑫ `readCache` 不看过期 | searchCache |
| ⑬ attribution 不透传 | assetResults |
| ⑭ 关着图片能力也发 asset 组 | toolGroups |
| ⑮ `agent.asset.ready` 改成取消后放行 | events |

跑批脚本里写死了两道自检：**模式匹配不上就 ABORT**、**改完回读文件确认落盘**。
两条都真的触发过（⑦⑪ 第一次缩进对不上），
而正是那个 ABORT 把下面「判断错过的地方 ③」翻了出来。

#### 验证

四道闸门全过（1087 / build / type-check / server tsc）+ **从 `server/` 实起后端**。

**端到端真跑**（不是重写一遍流程，是直接调 `createAssetTools`）：
搜图 → 24h 缓存 → 下载 → 压缩 → 传 COS → 匿名读回 `HTTP 200 image/jpeg` →
CORS `*` → 生图 13.4 秒 → 限流拒绝 → 票据落库 → 清扫残留。
缓存命中用 **`fetched_at` 变没变**判定（第一版拿耗时判，测的其实是下载时间，是错的）。

**浏览器里真看了**：建一份带 `asset://<hash>` 图片元素的 deck，
用 playwright 打开编辑器 —— 画布和左侧缩略图都出图，`naturalWidth = 1280`，无控制台错误。
**这一步抓到了本轮最隐蔽的一个 bug**，见下。

eslint：9 个新源文件 + 4 个新测试文件**全部 0 问题**；
`pipeline.ts` 3e 7w → 3e 8w、`index.ts` 0e 3w → 0e 5w、`App.vue` 0e 0w → 0e 1w，
多出来的三条全是新加的 `console`。

#### 判断错过的地方

**① 类型说一套、运行时做另一套 —— 只有真浏览器能发现。**

`syncAssetBaseUrl` 第一版写的是 `res.data?.baseUrl`。TypeScript 通过了（`assetApi.baseUrl()`
的类型是 `AxiosResponse`，它确实有 `.data`），四道闸门全绿，接口返回 200 且内容正确，
**控制台一条错误都没有** —— 而 `res.data` 运行时是 `undefined`。

因为 `services/index.ts` 引的是 `./axios` 那个**会拆包**的实例
（拦截器 `return response.data`），拿到的就是响应体本身。仓库里其它调用点全都写
`await deckApi.list() as any` 然后 `res.decks` —— **类型从来没跟着改过**，
而那个 `as any` 恰好把每个人的错误都掩盖成了「能跑」。

这条单测和端到端脚本都验不到：它们不经过前端那条 axios 链路。
**是浏览器里那次实测把它翻出来的。**

**② 我加了一个没必要的响应式改造，是负对照证明它没用的。**

看到「图没加载出来」时，我的第一反应是「`assetBaseUrl` 是模块级普通变量，
而消费点是 `computed`，Vue 追踪不到」—— 推理本身没错，于是改成了 `shallowRef`。
改完图还是没出来（真因是 ①）。修好 ① 之后，我**把 ref 改回普通变量再跑一次浏览器**：
**图照样正常加载**。

它不成立是因为时序本来就是对的：登录后立刻同步根地址，
而画布只可能在登录之后才打开，图片组件被创建时 computed 第一次求值读到的已经是新值。
按仓库自己那条「别为想象中的需求建抽象」，加上它会让 `assetUrl.ts`
从文件头明写的「不依赖 Vue」变成依赖 Vue —— 去掉了，风险写进注释。

**这是第十五轮那句话的又一次兑现：负对照不只在验代码，它同时在验判据本身。**
差一点就把一个不解决任何问题的改动当成「修好了 bug」记进这份文档。

**③ 我往源码里写进了三个不可见的 NUL 字节。**

`searchCache.ts` 的缓存键原本写的是模板字符串加空格分隔，
而落到磁盘上的分隔符是 `\0`。功能上碰巧比空格更安全（空格可能出现在查询词里），
但源码里藏控制字符是另一回事：看不见、grep 不到、有的工具会把整个文件当二进制。
**四道闸门全绿，没有任何东西报警。**

是负对照那条「模式没匹配上 → ABORT」把它翻出来的 —— 我去看为什么匹配不上，
才逐字符打印发现的。改成了 `JSON.stringify([...])`：分隔无歧义，而且看得见。

**④ 上游 429 被报成「可以重试」。**
端到端跑限流那一组时才发现，见上文。单测覆盖不到这条，因为它是真实上游的行为。

**⑤ `page.evaluate` 里 `import('/src/utils/…')` 拿到的是另一个模块实例。**
我用它当探针查「setter 到底跑没跑」，它一直报默认值 —— 即使修好之后、
DOM 上的图已经正常加载，那个探针**仍然报 `/assets`**。
差点被它引到错误的方向。**DOM 才是真相，模块探针不是。**

**⑥ `cd` 又泄漏了一次。**
上一轮「判断错过的地方 ③」原样记着这条，这一轮起 vite 时照犯 ——
`cd server && ... & npx vite &` 让 vite 在 `server/` 里启动，报找不到入口。
**写进文档不等于不会再犯**，分开两条命令起才是解法。

#### 没做的（说清楚边界）

- **署名只到「数据在」，没到「界面显示」。** 权威副本落在 `assets` 表（按 hash 可反查，
  不依赖模型），工具返回值也带着 —— 但**没有任何界面显示它**，
  也没有写进 `PPTImageElement`。合规②「必须署名」严格说还没兑现完。
  下一轮做：画布选中图片时显示来源、导出时附一页来源清单。
  （查过了：`validateElement` 用 `safeParse` 只校验、丢弃解析产物，
  所以往元素上加字段**不需要动 kernel.ts** —— 路线图里它是「一行不动」的硬约束。）
- **异步票据没做**，理由见上。`asset://pending/` 那一档前端骨架屏仍然闲置着。
- **生图 prompt 没有任何模板化**。agent 写什么就发什么，
  产出风格的一致性完全靠模型自觉 —— 而「决策不该由模型做」这条红线在这里还没落实。
- **没验过一次真实的 agent 端到端生成**（跑一句「做一份带图的 PPT」看它自己怎么用这两个工具）。
  工具本身逐项验过了，但**模型会不会用、用得对不对是另一回事** ——
  这正是 R-32 那条「注册了不等于用得上」要防的，下一轮该补一次 07 号文档那样的功能测试。
- 上游实际配额比库里配的紧（实测中转只放 2 次/分钟，库里是 3）。
  代码已经能优雅处理，但**那个数字该由管理员调**，不是代码问题。

### 2026-08-19 第十九轮：让图真的落到页面上，外加三个实测撞出来的 bug（R-48）

上一轮把图片工具接通了，这一轮是**用户实测反馈的一轮** —— 三个问题全是真跑出来的，
不是读代码推理出来的。

#### ① 图搜到了不用 —— 设计缺口，不是代码 bug

用户跑完一份 26 页的稿子，日志里 `searchImage` × 5、`generateImage` × 2 **全部成功**，
而 deck 里**图片元素 0 个**。

查出来是两条同时缺：

| | 状态 |
|---|---|
| 10 个版式**一个图片位都没有** | `grep image/src layouts.ts` → 0 处。而 `applyLayout` 是**整页替换语义**、是 agent 造页的主力（那一轮调了 14 次） |
| Generator 的 prompt **一个字没提这两个工具** | `roles.ts` 是 R-33 写的，那时图片工具还不存在 |

所以它拿到 src 之后，在整个工作流里**找不到能把图放进去的地方**，就丢了。
这是 R-32 那条「注册了不等于用得上」的教科书案例 ——
上一轮我在「没做的」里写过这条风险，用户第一次实测就撞上了。

**修法按「决策从 prompt 挪进代码」那条红线来**：

- `LayoutContent.image` + `LAYOUT_META[p].image`（`'panel'` / `'backdrop'` / `null`）
- **7 个版式吃图**：封面两种、章节页、要点列表、单点强调、引用、结尾页
- **cards / compare / timeline 刻意不吃**：版面已被 2~5 个并列块占满，
  再塞图只有两个结果 —— 图被挤成邮票，或把条目挤出安全区。
  硬塞会被拒，并**告诉它哪些版式可用**（静默忽略是最糟的：模型花 15 秒生成一张图，
  交上来石沉大海，而它永远学不到该换个版式）
- 摆放、cover 裁剪、层级、出场动画**全部在代码里算**，模型只说「这页配这张图」

两个只有实测才看得见的判断：

**背景图必须压遮罩。** 照片背后压文字，对比度几乎必然不合格 ——
而 `lintDeck` 只检查**纯色背景**与文字的对比度，**它看不见照片**，
于是「一页字全糊在图上」会安安静静通过所有检查。用背景色本身当遮罩
（不是纯黑/纯白），主题换了它自动跟着换。

**装饰环不能叠在照片上。** `title-split` 那个半透明圆环是给纯色块加质感的，
叠在照片上像块污渍 —— 这条是**看截图看出来的**，任何断言都不会报。

prompt 那一半只写「内容决策」：什么时候用搜图什么时候用生图、
**取图和排版要一页一页一起做完**、不是每页都要图
（「满篇配图和满篇没图一样廉价」）。版式清单里的「可配图」标记
是从 `LAYOUT_META` **自动带出来**的 —— 加一个吃图的版式，prompt 里自动就有，
不靠有人记得改文案。

#### ② 空 deck 上跑 agent，画布被清成 0 页并永久转圈

用户报的：agent 跑完画布白屏 + 转圈，刷新进去还是空的。

链条是**两个真相源对不上**：

```
① 新建 deck → 库里 slides_json = '[]'
② openDeck 见 0 页 → 只在**本地**补一页，从不落库
③ agent 从**库**读 → 拿到 []
④ 跑完收尾那次 commit（R-44 加的）→ 把 [] 原样推回前端
⑤ applyAgentDeck([]) → slides = [] → v-else-if="slides.length" 落空 → 永久转圈
```

kernel 守着「不能删除最后一页」（`kernel.ts:816`），所以 agent 不可能把非空 deck
删到 0 页 —— **唯一入口就是「deck 从一开始就是空的」**。

修两层：**源头**（openDeck 补的那页立刻落库，agent 从此读到同一份真相）+
**兜底**（区分 `deckLoading` 与「加载完但 0 页」。原来两者共用
`slides.length === 0` 这一个条件，分不开）。

**光改转圈条件不是修复** —— 负对照证明它只是把「永久转圈」换成「一片空白」。

#### ③ 错误处理路径二次失败会带走整个后端进程

我自己的验证脚本在任务还跑着的时候删了 deck，**后端进程直接死了**：

```
[agent] task failed: FOREIGN KEY constraint failed   ← catch 接住了
SQLiteError: FOREIGN KEY constraint failed           ← catch 里的 saveMessage 又抛，没人接
error: script "start" exited with code 1
```

`runAgentTask` 是 **fire-and-forget** 调的（`ws/handler.ts`，故意不 await ——
await 了就没法处理同一条连接上的 `agent.cancel`，取消按钮会彻底失灵），
而 `pipeline.ts` 的 **catch 和 finally 里还有 await 落库**。
错误处理路径上再失败一次，rejection 就逃到没人接的地方 → Bun 杀进程 →
**所有用户的所有任务一起死**。

触发面不止「删 deck」：磁盘满、库锁超时，任何让写库失败的东西都算。

修法：收尾动作统一包一层 `settle`（只记日志不上抛）+ 调用点补 `.catch()`。
**只有收尾动作能这么吞** —— 主路径的写库失败必须往上抛，
理由见 `runtime/commit.ts` ③（吞掉的话工具会回一句 ok，agent 不会重试，
那次修改从此谁也不知道丢了）。

#### 顺带修的：agent 面板一滚就回弹

用户报的第四件。原来是一行**无条件**的 `scrollTop = scrollHeight`，
每条日志变化都执行 —— 而 reasoning 增量是几个字符一条、每秒几十条，
用户往上滚，滚轮确实生效了（内容动了一下），然后 `nextTick` 里那行把它按回去。

新增 `useStickToBottom`：`pinned` **只在容器自己的 `scroll` 事件里更新**，
内容变化时只读不写。顺序不能反 —— 在内容变化时重新测量的话，
「内容变长了、用户没动」会被算成「用户滚开了」，跟随在第一次增长后就永久失效，
而且失效得悄无声息。

思考块抽成 `AgentReasoningEntry.vue`（它自己是滚动容器，要拿自己那个 DOM 元素）。
`scroll` 不冒泡，两个容器各持有自己的 `pinned`，天然互不干扰。

#### 测试 1087 → 1170

| 文件 | 条数 | 守什么 |
|---|---:|---|
| `layoutImage.test.ts` | 69 | 裁剪算术 / backdrop 必压遮罩 / panel 顶掉色块 / 文字不压图 / 不吃图的版式拦得住 / **合规：图库 URL 进不了 deck** / 清单会告诉模型 |
| `useStickToBottom.test.ts` | 14 | 贴底跟随 / 用户滚开后不打扰 / 阈值 / 元素反复挂载卸载 / 监听清理 |

原有 224 条 `layouts.test.ts` **一字未改**。

#### 负对照：14 条源码级 + 3 条真浏览器 + 1 条真进程

版式图片位 8 条（去掉图片位 / 不压遮罩 / 图放最后 / 裁剪判反 / 静默忽略 /
不校验 asset:// / 清单不提图 / 文字不缩窄）、滚动 6 条 —— **全红**。

**空 deck 那条在真浏览器 + 真 agent 任务下做的**：

| | 结果 |
|---|---|
| 只摘源头落库 | 兜底触发（告警可见）、画布正常 → 证明 0 页真的会发生 |
| 两层全摘 | `editor=false` 缩略图 0 → 证明测试能检出这个 bug |
| 还原 | 库里 1 页、兜底不触发 → 两层分工正确 |

**崩溃那条在真进程上做的**：摘掉 `settle` + `.catch` → 删 deck 后 **+50 秒进程死**
（`exited with code 1`）；还原后**同样的 FK 错误照样发生**，
但被 `收尾动作「落库错误消息」失败（已忽略）` 接住，进程活到 +120 秒。

#### 验证：agent 真跑了一遍，图真的进了页面

四道闸门（1170 / build / type-check / server tsc）+ 后端实起。
外加一次真实 agent 任务（「3 页简报，每页配图」）：

```
3 页 3 张图
 p1 title-split panel  400×562.5  clip=有  imageType=pageFigure
 p2 bullets     panel  400×562.5  clip=有  imageType=pageFigure
 p3 end         backdrop 1000×562.5 clip=有 imageType=background
```

**并且在浏览器里逐页看了截图**：左文右图出血、文字完全不压图、
backdrop 遮罩下「感谢观看」清晰可读、无控制台错误。

意外之喜：agent **自己在每页底部加了一行「图：作者 / Pixabay」**——
它读了 prompt 里的署名指引。合规②比预期落地得早。

#### 判断错过的地方

**① 我的验证脚本自己有 bug，差点把假成功记成真。**
第一次验空 deck 修复时，脚本用 `.first()` 点 deck，而三份测试 deck **同名** ——
它点开的是旧的那份（后端日志里 `GET /api/decks/25` 而不是 27）。
那次「通过」完全不作数。改成唯一标题重跑才算数。

**② 差点把「光改转圈条件」当成修复。**
负对照②（两层全摘）跑出来不是「转圈」而是「一片空白」——
因为我同时改了转圈条件。**改判据的同时改实现，会让负对照测的东西悄悄变掉。**

**③ 我加过一个不必要的响应式改造（上一轮的延续）。**
`assetUrl.ts` 那个 `shallowRef`，负对照证明它不解决任何问题，已去掉。

**④ 环境里的坑（不是项目问题，但会咬人）**：
`no_proxy=locahost,...` —— **`localhost` 拼错了**，于是 bun 的 fetch 把
`http://localhost` 走 HTTP_PROXY，回 502。curl 不受影响所以一直没露出来。
调试脚本一律用 `127.0.0.1`。

**⑤ `cd` 又泄漏了一次。** 上一轮「判断错过的地方 ⑥」原样记着这条，这一轮起 vite 时照犯。

#### 没做的

- **背景图遮罩浓度（0.82 / 0.78）是拍的，没调过。** 截图上文字清晰可读、
  照片略偏淡。往下调更好看但可能压不住浅色照片 —— 这是审美工作的活，
  该在有一批真实样张之后统一定
- **agent 仍然先囤图再排版**（连着 5 次 `searchImage` 再开始 `applyLayout`），
  prompt 里写了「一页一页一起做完」它没照做。结果是对的，所以没管 ——
  但这说明 prompt 里的**流程约束模型未必遵守**，真要保证得靠代码
- `cards` / `compare` / `timeline` 仍然不吃图。要给它们配图得**新增版式**
  （图文网格、左图右表），那是审美扩容的活

### 2026-08-19 第二十轮：审美 —— 把「按内容构图」写进代码（R-49）

产出的问题是「排得整齐但没有设计感」。这一轮的结论是：
**版式引擎一直把「一页有多高」当成已知常量在用**（固定 `top:150`、固定 `height:52`、
固定 `SAFE.width-300`），内容多了就压在一起，内容少了就留一大片空。
所以要补的不是「更好看的常量」，是**「按内容重新构图」这件事本身没有在代码里**。

#### 先做了一件事：给这一轮找一个「看它的方式」

「好不好看」没有机器判据，但仓库已经吃过两次同样的亏，两次的解法都是换个看法
（R-36 逐帧采样代替肉眼、R-41 联系表代替读 path）。这是第三次：

| 工具 | 回答什么 |
|---|---|
| `npm run layout-shoot` | **13 个版式 × 最多 9 种内容变体 = 87 张样张**，用真实 `ThumbnailSlide` 渲染、真实 COS 照片 |
| `npm run layout-audit` | 跑真实 `lintSlide` / `lintDeckDesign`，外加内容占比、上下留白失衡两个量化指标 |
| `npm run layout-text` | 在真浏览器里量**声明框高 vs 实际渲染高** |

三个工具都不写第二套规则：版面调 `buildLayout`、渲染用编辑器同一个组件、
判据调生产代码的 lint。样本内容只有一份（`scripts/layout-fixtures.ts`），
`layout-order` 也改成共用它 —— 两边各写一套，看到的就不是同一页。

#### 摆出来一看，第一个数字就说明了问题

> **66 张样张跑完整 lint：0 条告警。** 而其中好几张肉眼可见文字压在一起。

原因是结构性的：`Builder.text()` 每次都把框高夹进画布，所以 `lintSlide` 的
「超出画布」**永远不可能响**；重叠检查比的也是声明框，而溢出发生在框外面
（PPTist 不裁剪文本）。**这是 R-39 那句话的逐字复现** ——
「没被写成判据的东西不会退化，因为它从来就没立起来过」。

| 判据 | 改之前 | 改之后 |
|---|---|---|
| lint 告警 | 0 / 66（**看不见问题**） | 0 / 87（真的没问题） |
| 文本实际渲染超出声明框 | **15 处 / 10 张** | **0 / 428** |
| 文本落在 8px 基线栅格上 | 24% | **100%** |
| 需要兜底截断 / 越出画布 | 无从得知 | **0 / 87** |
| 上下留白失衡 > 60px | —— | 14 / 87 |

#### 文字高度：三个都是量出来的，没有一个是猜的

估算不准不是「差一点」，是三处系统性错误叠加：

| | 发现的问题 | 实测证据 |
|---|---|---|
| ① | **文本元素有 10px 默认内边距，从来没被算进去**（`BaseTextElement.vue` 的 `inset`） | 六条要点是 12 个文本框，光内边距吃掉 240px，而版心只有 442px |
| ② | **行高按 `max(字号,16) × 行距` 算，不是 `字号 × 行距`** —— `.element-content` 只设了无单位 `line-height`、没设 font-size，继承 16px 的行盒撑着 | `cards` 那个 128px 正文框正好是 `5 × 25.6`；`bullets` 的 26px 正好是 `1 × 25.6` |
| ③ | **拉丁词整词不断**，「总长 ÷ 行宽」的模型必然少算行数 | `Webhook` 实测每字符 0.575，而按 a~z 平均值算是 0.48，少算 14.6% |

字宽表也换成了**真实词量出来的**而不是 a~z 算术平均 —— 平均值被 i/l/j/t 拉下去了，
真实单词里占多数的是 e/o/h/b/k。数字和大写各低估 15% / 26%，
而这两类正是这类文稿里最密的东西（「800ms」「P99 2.4s」「SOC2 Type II」）。

处置：`inset` 改成版式引擎自己的 `[0,6,0,6]`（那个 `[10,10,10,10]` 是给手工拖拽用的）、
行盒按 16px 下限算、折行改成**贪心排版真算一遍**。
最后留 6% 余量 —— 实测最后一个溢出就是 `Webhook` 占 10.41 em、行宽 10.42 em，
差 0.01 em「刚好放得下」而浏览器判定放不下。这种边界只能靠余量，
**而余量往哪边留是有讲究的：估高了浪费一点留白，估低了文字直接压在一起。**

#### 遮罩：从两个拍脑袋的常量换成按图算 + 渐变

R-48 在「没做的」里写着「遮罩浓度 0.82/0.78 是拍的，没调过」。摆出来一看，
那不是「照片偏淡」，是**照片没了** —— 白底亮图压完只剩一点人影，搜图/生图的钱白花。
业界通行区间是 40~60%，我们高出去 20 个点还带反方向（浅色遮罩 + 深色字）。

现在三件事一起解决：

1. **浓度按图片实际亮度算**。`runtime/imageCodec.ts` 在**已经解开图的那一步**顺手量
   `{mean, p5, p95}`，经 `assets` 表 → 工具返回值 → `content.image.luminance` 到版式
2. **对着最坏情况算，而「最坏」是哪一头要看文字颜色** —— 浅色主题（深字）怕暗部（p5），
   深色主题（浅字）怕亮部（p95）。统一说法是「取离文字亮度更近的那个」，
   因为对比度在两者相等时最低。**写这条测试时我一开始断言反了**（以为一律「亮图压得更狠」），
   是测试当场把这个思考错误抓住的
3. **渐变**，只压文字那一侧，另一侧照片留着

**导出那一半是照着 `useExport.ts` 推出来再实测确认的**：它对带渐变的形状做
`tinycolor.mix(首色, 末色).toHexString()`，而 `toHexString()` 丢掉 alpha，
于是两个同色不同 alpha 的端点合出来就是那个颜色本身，再乘元素级 opacity。
所以**网页得到渐变、PPTX 得到均匀遮罩**，两边都是成立的设计，
PPTX 那边更保守但保证读得出来。改 `useExport.ts` 的渐变处理时要回来看这条。

#### 三件只有看截图才发现的事

1. **渐变淡完了而文字还没完。** 第一版渐变在 55% 处开始淡出，引用页那行字横跨到 93% 宽，
   「没有界面」四个字正好压在亮蓝色机柜上糊掉。第一反应是「把渐变拉长」，
   但拉到 93% 就等于全屏均匀压 —— **真正的问题不是遮罩太短，是文字太宽**。
   配了照片的版面本来就该给照片留出地方，那才是配图的意义。
   所以 quote / stat / section 有背景图时文字栏收窄到 58~78%
2. **彩色文字没人管。** `scrimFor` 照着 `palette.text` 算浓度，但 stat 的大数字是 primary（蓝）、
   eyebrow 是 accent（黄）——「关键指标」那行黄字压在照片上几乎看不见，**而所有断言都是绿的**。
   补了 `ensureContrast` + `Builder.onPhoto()`，并补上对应判据
3. **装饰还叠在照片上。** R-48 判过「半透明色块叠在照片上像块污渍」，但只修了 `title-split` 的装饰环 ——
   `stat` 的光晕、`end` 的装饰环、`title-center` 的斜块、`title-split` 的强调色分界线都漏了整整一轮

#### 新增 3 个版式，补的是实测统计出来的缺口

先拿真实产出统计，不凭感觉列。库里那份 12 页的稿子：
**cards×3 + bullets×3 = 一半是「标题 + 并列块」**，图只有 1 张，
section / timeline / title-center **一次都没被用过**。

| 版式 | 补的是什么 |
|---|---|
| `image-grid` 图文网格 | 2~3 个概念**各配一张图**（`items[].image`）。R-48 判「cards 版面已满塞不下图」是对的，但缺了下半句：**并列块本来就该有一种自带图位的形态** |
| `split-figure` 左图右列 | 左边出血大图 + 右边 2~4 条要点。`bullets` / `cards` 想配图时的正解 |
| `full-figure` 满屏图 + 浮层卡片 | 整幅照片 + **不透明**卡片装文字。**对比度由卡片保证，和照片有多亮完全无关** —— 照片很花或亮度信息缺失时的稳妥选择 |

`full-figure` 的图位刻意叫 `overlay` 而不是 `backdrop`：两者的区别不是程度而是种类
（一个靠遮罩、一个靠卡片）。混用一个名字，「遮罩必须随亮度变化」那条判据
就会套到一个根本不靠遮罩的版式上 —— 测试当场红给我看了。

#### 配色风格包：选哪个是模型的事，色值是代码的事

`buildPalette` 加了 business / tech / academic / vivid 四档。分工和 R-46
「搜图还是生图由模型决定」是同一条：**选哪个风格是内容决策**（学术汇报和产品发布会
本来就该长得不一样，而只有模型知道这份稿子是什么），**风格里的九个色值是排版决策**。

风格包**不动用户主题里的背景色和主色** —— 那是品牌资产。它只调推导出来的角色：
卡片底的冷暖、与背景的分离度、描边轻重、次要文字的弱化程度。
第一版写的是「背景往风格色偏一点」，**被 `design.test.ts` 当场挡下来**，
而我在同一次改动的注释里还写着「不动用户的背景色」——
注释说的是原则，代码做的是另一回事。测试是对的。

#### 测试 1170 → 1328

| 文件 | 守什么 |
|---|---|
| `design.test.ts` 30 → 63 | 栅格吸附 / 光学底重 / 16px 行盒下限 / inset 计入 / 拉丁整词不断 / stack 四种对齐 / fitSteps / 遮罩浓度方向与区间 / 三位 hex 拼 8 位色值 / ensureContrast / 四个风格包 |
| `layoutImage.test.ts` 69 → 111 | 遮罩落在业界区间 / **浓度随亮度变化** / 取最坏那一头 / 渐变端点同色只差 alpha / **渐变必须罩过文字最右边** / 居中构图用均匀遮罩 / **压在照片上的彩色文字够对比度** / 装饰让开照片 / 条目图只收 asset:// |
| `layouts.test.ts` 224 → 298 | 三个新版式过全部既有不变量；**降级阶梯真的走了**；**全部版式 clampedIds 为空** |

`layouts.test.ts` 原有 224 条**一字未改**就把三个新版式全覆盖了 ——
因为它们断言的是性质（在画布内、在安全区内、id 唯一、每个元素都挂动画、标题领跑），
不是坐标。这是 R-39 立的写法，这一轮直接受益。

#### 负对照：9 条全部挂到真源码上跑过

| 改坏什么 | 变红 |
|---|---|
| ① 遮罩浓度改回常量 0.82 | layoutImage |
| ② 行盒改回「字号 × 行距」 | layout-text（真浏览器） |
| ③ 折行改回「总长 ÷ 行宽」 | layout-text |
| ④ inset 不写到元素上 | layout-text |
| ⑤ `snapY` 改成恒等 | 栅格判据 |
| ⑥ 有图时装饰照旧画 | layoutImage |
| ⑦ 渐变 hold 改回固定 0.55 | layoutImage |
| ⑧ `fitSteps` 不再降级 | layouts |
| ⑨ `onPhoto` 改成恒等 | layoutImage |

跑批脚本里那两道自检（**模式匹配不上就 ABORT**、**改完回读确认落盘**）**都真的触发了**：

- ⑧ 第一版的替换串**包含**原串，回读检查分不出改没改 → ABORT。改成替换 `fitSteps` 本体才无歧义
- ⑧ 修好之后**仍然没红** —— 因为 `survives maximum item counts` 用的是「第 N 条 / 说明」这种短内容，
  任何一档都放得下。**降级阶梯是活的（实测 15px → 14px → 12px），但没有任何判据在守它**。
  补了一条用三重压力（六条 + 副标题 + 配图）的测试
- ⑨ 第一次跑**也没红** —— 我加了 `onPhoto` 却没写任何判据。补了「压在照片上的彩色文字够对比度」

**两条都是负对照替我发现「判据缺了」，而不是「代码错了」。**

#### 判断错过的地方

**① 我的两个量化指标自己过期了。**
「底部空档」这个指标在版面改成垂直居中之后立刻失效 —— 底部空档大是**对的**，
因为顶部空档一样大。拿它当判据会把「排好了」判成「没排完」，
而我确实照着它调了一轮才发现不对。换成「上下留白不对称度」。
**判据也会过期**：改了实现却不回头看判据还量不量得对，就是拿着一把量错东西的尺子在调。

同样地，栅格判据一开始同时查 `left` 和 `top`，报 37% 不合格 —— 而横向本来就**故意不吸附**
（居中是光学的，`(1000-96)/2 = 452` 吸附成 456 就真的偏了）。改成只查纵向之后是 0%。

**② 遮罩方向我一开始想反了。** 见上文，测试抓住的。

**③ 在模板字符串里写反引号。** `roles.ts` 的 `CANVAS_CONTEXT` 是模板字符串，
我在里面写了 `` `style` `` 想标记参数名，直接把模板提前闭合，tsc 报了两个
莫名其妙的 `',' expected`。

**④ `cd` 又泄漏了两次。** R-47「判断错过的地方 ③」、R-48「⑤」原样记着这条，这一轮照犯 ——
一次是查 DB 之后 `grep` 找不到文件，一次是改测试文件时路径不对。
**写进文档不等于不会再犯**，用绝对路径才是解法。

**⑤ 我一开始编了两个不存在的图片 hash。** 写样本 fixture 时凭印象补了 `glow` / `abstract`
两个 hash 的后半段。错的 hash 解析出来是 404，而**联系表上 404 的图是一块白**，
看起来完全像「这个版式就是这么设计的」。改成从库里查真值，
并且给截图脚本加了「有图没加载出来就显式报错并退出码 1」。

#### 没做的（说清楚边界）

- **`full-figure` 的标题会出现单字换行**（「把复杂留给自己」在 52% 宽的卡片里
  按 64px 排成两行、第二行只有一个「己」）。`fitFontSize` 只按高度挑字号，
  不管「会不会留下一个孤字」。要治得给它加一条「避免孤行/孤字」的判据
- **没跑一次真实 agent 端到端生成**。四道闸门 + 87 张样张 + 9 条负对照 + 后端实起都做了，
  但**模型会不会用这三个新版式、会不会传 style 和 luminance 是另一回事** ——
  这正是 R-32「注册了不等于用得上」、R-48「搜了图不知道往哪放」反复吃过的亏。
  下一轮该补一次 07 号文档那样的功能测试
- **风格包只在 `applyLayout` 和 `getDesignTokens` 上开了口**，没有 deck 级别的存储 ——
  模型每页都得传同一个值，prompt 里写了但**流程约束模型未必遵守**（R-48 已经记过这条）。
  真要保证得把它存进主题
- **内容占比 31/87 仍然低于 35%**。其中大部分是 quote / section / full-figure 这类
  「呼吸页」，本来就该稀疏 —— 这个指标现在只当参考，没有当判据
- `cards` / `compare` / `timeline` 本身仍然不吃整页图，但缺口由三个新版式接住了

### 2026-08-20 第二十二轮：排队输入 + 渲染后反思（R-52）

> **R-50 / R-51（四角色 → 单 agent、思考跨轮回传）不在这张清单里** ——
> 它们的完整记录在 [12-single-agent.md](./12-single-agent.md) 的「落地记录」一节。
> 规模大到自成一份文档的改动就记在自己那份里，这里只留指针。
> 本轮同理，细节在 [13-queue-reflect-ingest.md](./13-queue-reflect-ingest.md)。

**做了两件事**：11 号文档 C 期剩下的「排队输入」，和 D3「渲染后反思」。

**① 排队输入。** `taskRegistry.cancel()` 只 abort 不 release，从取消到收尾跑完
这段窗口里键仍然占用中 —— 那份代码的注释自己写着「用户此刻重发会收到
『已有任务在执行中』，**这是对的**」。那句话没错，但它描述的是一个
**没有出口的正确**。这一轮在闸门外面加了队列：`runtime/inputQueue.ts`（纯数据结构）
+ `runtime/taskGate.ts`（占坑 / 排队 / 接力的接线）。

顺带修了一个**现存 bug**：前端 `submitTask` 在**发出请求那一刻**就把用户那句
push 进日志，被拒时后端只回一条泛泛的 `error` —— 那句话就留在面板上像是被受理了，
而且那条路径**不还画布所有权**。现在协议是 `agent.input { queued | started | rejected }`，
**每一句输入恰好收到一个终局回执**。

**② 渲染后反思。** `estimateTextHeight` 是估的，估小了下一个元素就压上来，
而现有几何检查一条都看不见（框高被夹进画布 / 重叠比的是声明的框）。
新工具 `reflectRender`：后端要前端离屏渲染一遍、量 `.text` 的真实 `offsetHeight`，
贴回去重跑 `lintSlide`，**只报差集**（渲染之后才冒出来的那些）。

**决策者当场纠正了我一个判断，记在案**：我原本写「VLM 视觉复核这一版不做」。
纠正是「反思渲染要搞一个工具，同时这个工具的模型要重新设置成一个独立的模型」。
这条是对的 —— 我对的那一半是「几何测量绝不能过模型」（过了就没有判据了），
漏掉的那一半是「看一眼这页丑不丑本来就不是几何能回答的问题」。
于是 `AGENT_ROLES` 加了 `'reflect'`，管理员和用户的设置页各自自动多出一档独立模型。
**这是 12 号文档 §C 保留 `AgentRole` 这一维之后，它第一次被真的用起来。**

#### 判断错过的地方

**① 接线写在 orchestrator 里 = 没有判据。** 原计划把「占坑 → 排队 → 接力」
写进 `agent/orchestrator.ts`，写到一半才想起那个文件经 `db/index.ts` 拉 `bun:sqlite`，
**vitest 里 import 不进来**。而这段恰恰是「零件对 ≠ 装配对」点名的地方。
抽成 `runtime/taskGate.ts` 之后才测得到 —— 它的 25 条判据里有 10 条只在接线处才成立。

**② 协议一开始设计成两条消息，第三种情况没人管。** `agent.queued` + `agent.dequeued`
覆盖了排队和开跑，**队列满被拒的那一句仍然显示成已受理** —— 也就是说我修了一个 bug 的
两种情形、漏了第三种。收成一条带状态的消息之后三种都有着落。

**③ `getSlides` 闭包读了错的 `state`。** 反思工具原本建在 `runDeckTask` 那层，
闭包捕获的是**开跑那一刻**的 state —— 而 `runTurn` 里的 mutation 只更新它自己的局部绑定。
agent 辛苦排完 14 页，量到的是一份空稿子，**而且不会有任何东西报错**。
改成建在 `runTurn` 里、从 `accessor.get()` 读。

**④ 判据 R3 原来的问法抓不住真正的风险。** 原计划是「和 `measure-layout-text.mjs`
量出来的一致」，但那两个脚本量的不是同一件事。真正的风险是「离屏渲染 ≠ 用户看到的渲染」，
所以改成同一页里量两遍（正常渲染 vs 离屏）逐个元素比。
**这个换法是被负对照逼出来的**：把离屏容器改成 `display:none`，`offsetHeight` 全变 0，
而 0 的意思是「每块文字都画得下」—— 报告一片祥和，原来那个问法看不见。

**⑤ 两个「不会报错」的真 bug 是测试抓的，不是我想到的。**
一个是前端 FIFO 配对要分状态找（`A 已开跑 · B 排队中 · C 刚发出` 时 C 的回执会落在 B 上），
一个是 `InputQueue.enqueue` 的上限检查被「队列还不存在」那条捷径绕过了
（`maxPerKey = 0` 时第一条照样进得来）。

**⑥ `cd` 又泄漏了一次。** R-47③ / R-48⑤ / R-49④ 连着记了三轮，这轮照犯 ——
`cd server` 之后接着跑仓库根的 `grep`，报「No such file or directory」。
另外 zsh 的 `no matches found` 把好几条带 glob 的命令整条打断，
后来一律先 `set -o noglob`。

#### 追加：把视觉复核真的配上并跑通（同一轮，决策者要求实测）

配 `gemini-3.7-flash`（原生多模态）到 `reflect` 角色。**这一步撞出两个真 bug，
都是「不会报错」的那类，比功能本身更值得记：**

**⑦ 差点用错字段。** 原本要复用 `model_configs.supports_images` 当门禁，
查了才发现它现在的语义是**「能出图」**（`AssetSettings.vue` 拿它筛生图模型）。
复用的后果是：给 3.7-flash 打上这个标之后它会出现在「生图用哪个模型」的下拉里，
**而它一张图也生不出来**。加了 `supports_vision` 一列（迁移 `0007`）+ 设置页多一个开关。
四种组合都真实存在，deepseek 出✗读✗ · 3.7-flash 出✗读✓ · 3.1-flash-image 出✓读✓。

**⑧ `normalizeBaseUrl` 对 google 一直是坏的，只是没人撞到。**
库里的中转是 `https://g.92.run/v`，路径非空，按原来那条「已有路径的一律不动」
原样交给 SDK → POST 到 `…/v/models/xxx:generateContent`，**少了 `/v1beta`，每次 404**。
没被发现是因为 deck agent 用的是 deepseek，而生图那条路**根本没走 SDK**
（`imageGenerate.googleImageEndpoint` 自己拼 URL，规则正好是对的）。
**同一件事两处两套判断，一边能用一边 404。** 现在两处统一，
且「规则一致」本身成了判据（拿两个函数的输出对一次）。

**⑨ 第一次实测是假绿，这是本轮最值得记的一次判据失效。**
测试脚本里库里那页是我 `buildLayout` 造的 bullets，发给模型的截图却是探针截的
title-center —— 两页根本不是同一页。模型回「这几页没挑出问题」，我差点当成通过。
**而「它没看见图」和「它看了图觉得没问题」在报告里长得一模一样。**
更糟的是代码里这两件事**返回同一个值**（`reviewOne` 的 catch 和「模型说无」都
`return null`），翻服务端日志才看到每一次调用都是 404。

两处都改了：截图和 slide JSON 由探针**一次吐出**（`--shot-out` + `--slide-out`），
两边不可能对不上；`reviewOne` 改成返回三态（有意见 / 没问题 / 失败带原因），
全失败时明说「**一页都没跑成**（N/N）：<原因>」，并单独回
`visualReviewed` / `visualFailed` 两个数。

修完之后实测（探针 `--bad` 渲一页故意写坏的：套话 + 百分比排成文字）：

```
V1 配了能读图的 → wantShots=true                 ✅
V2 工具返回带视觉意见                             ✅
V2 正对照：意见里出现页面上真有的内容              ✅ 模型逐字引用了标题
V3 换成不能读图的 → wantShots=false（不白截图）    ✅
V4 负对照：全失败时不许说「没挑出问题」            ✅ 明说 404 + 原因
```

模型说的：「标题及三个列表项…全为空洞套话」「版面内容全部挤在左侧窄条区域，
右侧大面积严重空置」。第一条正是 12 号文档砍 Reviewer 时说「先丢掉」的那两条之一。
**它没抓到另一条**（该用图表却排成文字），一次实测说明不了什么，先记着。

#### 没做的（说清楚边界）

- **判据 R4 只做了一半**：验了「agent 调工具 → 拿到溢出报告 → 转述」，
  **没验「它拿到报告之后真的改对了」**。要构造一份「真实模型排出来、且真的溢出」的稿子
  才验得了，而实测下来当前版式引擎在样张上**溢出 0 处**（R-49/R-50 修掉三处系统性偏差之后），
  造不出自然的溢出样本
- **视觉复核的输入是模拟前端喂进去的**：截图是真的（探针在无头浏览器里截的），
  但走的是测试脚本按协议应答，**没有从真实编辑器页面点一次**
- **截图的跨域风险仍然没验**：`html-to-image` 遇到 COS 上的配图可能污染画布，
  代码里 try/catch 降级成「这一页只给几何数据」，探针截的那页**没有图片元素**
- **`agent.confirm` 仍然是空分支**：它要的等待机制（`runtime/pendingRequests.ts`）
  这一轮建好了，但没有接上去

### 2026-08-21 第二十三轮：版式分布、节奏，与「让模型自己设计风格」（R-54 / R-55）

起因是把 `refs/skills/` 那 21 个外部 PPT skill 的审美 prompt 通读了一遍，
逐条对着 rabbit 现状比。结论是**绝大多数规则这边已经有了，而且有几处更强** ——
逐字体实测字宽表（`CHAR_WIDTH_BY_FONT`）、降行距而不降字号的溢出阶梯（`fitSteps`）、
真浏览器里量的溢出判据（`npm run layout-text`），参考库里没有一个仓库做到这个程度。

差的是三条，这一轮补了能机器判的两条。

**① 版式分布。** `lintDeckDesign` 的判据 ① 只比**相邻两页**。它挡得住
「连着两页 cards」，**挡不住 cards / compare 交替二十页** —— 每一对相邻页都不同，
全绿，而读者看到的是同两张脸轮流出现。

判据按「最多的那个版式占了多少」算，不按「一共用了几种」：二十页里十四页是 cards
才是真的雷同，而「只用了三种版式」在一份五页的稿子里完全正常 ——
种类数会把短稿子一律判负，占比不会。阈值是**占比 > 40% 且至少三页**，
两个条件缺一不可：光有占比的话，五页的稿子 `0.4 × 5 = 2`，两页 cards 就会报，
而相邻页判据已经保证了这两页不挨着。

**② 节奏页密度。** prompt 里写着「每 3~4 页内容页插一页节奏页」，
而在这条判据之前**没有任何东西在验** —— 和判据 ④（配色 / 字体全篇统一）
的处境逐字相同：写在 prompt 里的规矩，模型照做与否无人知晓，而所有检查都是绿的。

为此给 `LayoutMeta` 加了一维 `pace: 'structural' | 'rhythm' | 'content'`，
**必填而不是可选** —— 给成可选的话，新加版式漏标就默认落进 `content`，
而漏标的表现是判据悄悄失准。这和 `signatureIds` 那条「用 id 不用名字前缀」
是同一个理由：会安静失效的豁免机制不要写。

判据取「连续 6 页」而不是 prompt 说的 4：**护栏要比指导宽一档**。
指导说的是「怎么做才好」，判据说的是「这样已经不行了」，两者取同一个数
会让「按指导做到边界」的稿子也变红。

一处**写注释时自己弄反了、被测试问出来**的地方记在案：我原本在注释里写
「封面 / 结尾不打断连续段」，而代码里它们是打断的。想清楚之后是**代码对**——
封面和结尾本来就是低密度大留白的页，视觉上确实让人喘了口气；
把它们归成 `structural` 而不是 `rhythm`，只是因为位置固定、
agent 不能靠多加两页封面来凑节奏。改的是注释不是代码。
（手工页 —— 没有 `layout` 标记的 —— 则**既不算内容页也不打断**：
lint 不知道它长什么样，让它冒充节奏页去截断一串 cards 是在放过真问题。）

**判据与负对照**：新增 8 条测试。负对照是把 `kernel.ts` / `layouts.ts` 单独 stash 掉、
只留新测试跑一遍 —— **三条正向断言全红，五条反向断言两版都绿**（反向断言测的是
「不该报的时候不报」，本来就该在两版上都通过）。`npm run layout-audit`
87 张样张仍然 0 告警，新判据没有引入噪音。

---

## R-55 · 不再给菜单，让模型自己设计

第三条差距（跨份雷同）原本我判成「要存历史、落点在 DB、而且是产品决策」。
决策者当场把方向改了，而且**是对的**：不该让模型从 4×6 的搭配里挑，
应该让它自己想这份稿子该长什么样。记在案。

#### 一个查出来的事实：口子早就通了

`applyLayout` **一直收 `primaryColor` / `accentColor` / `backgroundColor`**。
也就是说「模型自己设计配色」这条路从来没被堵死过。而 prompt 里提到这三个参数的
次数是 **0** —— 不光没提，还反着教：「这里不给模型调色盘，只给四个名字」
「想让某处跳出来用 accent，不要临时调一个新颜色」。

这和第十八轮那个图片 bug 是**同一个形状**，`LAYOUT_META.image` 的注释里那句话
一字不改地适用：**能力存在但没有任何路径够得着，等于不存在。**

#### 为什么当年封、现在能开

第六轮诊断 ④ 的结论「交给模型就是随机挑六个色」没有错，`design.ts` 的注释也没写错。
**变的是兜底**：`contrastRatio` 保证正文达标、`ensureContrast` 把看不见的彩色字硬拉回可读、
`scrimFor` 按图片实测亮度算遮罩、`buildPalette` 从锚点推出九个角色。

当年不敢放，是因为没东西接得住一套烂配色；现在接得住了。
**这个决定值得重开，不是因为当年判断错了，是因为判据追上来了。**

#### 分工重划

| | 谁定 | 为什么 |
|---|---|---|
| 三个锚点色（background / primary / accent） | **模型** | 它是内容决策，而且对比度有代码兜底 |
| surface / border / textMuted / onPrimary | 代码 | 从锚点推，推完还要过对比度 |
| 一对字（display + body） | **模型**，八个里自由配对 | 8×8 比六套预设宽得多 |
| 字宽、字号阶梯、栅格、坐标 | 代码 | 这些是排版不是设计，一个字都没动 |
| `style` | 模型选名字 | **它不是「配色」，是质感档位** —— 只调分离度、描边、次要文字弱化和冷暖染色 |

`style` 这一维的重新命名值得单独说：翻 `StyleRecipe` 的五个字段
（tint / surfaceLift / borderAmount / mutedAmount / accentShift），
除了最后一个都在调**推导出来的角色**。它一直叫「配色风格」，但它其实是质感档位 ——
名字起错了，于是 prompt 里也就教错了。

#### 字体为什么不能全放开

只有 `CHAR_WIDTH_BY_FONT` 那八个量过字宽。表外字体没有实测数据，
`estimateTextHeight` 会退回 `WIDEST`（取全部字体逐项最大值）兜底，
于是每一行都按最坏情况估，白白浪费四分之一版面。
**这是硬约束不是偏好**，所以放开的是「配对」不是「命名」。

`displayFont` / `bodyFont` 必须一起给：只给一半的话另一半会落回预设，
配出来的对比关系不受任何一方控制，那就不是「自己配」了。

#### 两条新判据

**⑨ 这份稿子被设计过吗。** 判 `paletteAnchors`（新字段，记的是**模型显式给了哪几个锚点**）
而不是 `paletteStyle` —— 后者写的是 `?? 'business'`，**默认值一旦落盘就再也分不出
它是决定还是缺省**，而这两者的区别正是「被设计过」和「二十份长一个样」的区别。

这条顺手把跨份雷同解掉了，**而且不用存历史**。因为那个问题的根子从来不是
「两份撞色」，是「模型压根没做决定」：真设计过的两份稿子撞成一模一样的概率极低，
而没设计过的一百份必然全等。判「有没有做决定」，多样性是白送的。

起查页数 3：用户说「这页重排一下」时 agent 只调一次 `applyLayout`，
那一次它没有义务重新设计整份配色，在那里报是纯噪音。

**⑩ 标题和正文同一个字族。** 只有自配之后才可能出现，六套预设永远不会踩
（最接近的 `scholarly` 也是思源宋 + 思源黑）。

#### prompt 改了什么

「配色风格 + 字体配对」两节（教你选名字）换成「先定这份稿子长什么样」五步：
这份稿子是什么 → 三个锚点色（每个都要说得出被内容里的什么驱动）→ 一对字 →
质感档位 → **自己批一遍**。

最后那一步是从 `refs/skills` 抄来的、整个参考库里最值钱的一句：
**「这套方案，是不是我给任何一份同类稿子都会产出的？是就改，并说出改了什么。」**
连带点名了三套最容易滑进去的默认（白底+蓝+橙、深灰底+青、米白+深红+宋体标题）——
点名是必要的，`ai-tells-catalog.md` 的做法就是把「AI 味」写成具体清单而不是抽象告诫。

**代价：system prompt 从 8,865 字涨到 10,394 字（+17%）。** 实测的，不是估的。
R-51 把它从 20,212 压到 7,865 是因为当时四个角色各送一份；现在是单 agent 送一次，
这 1,529 字一轮只付一次。

#### 没做的（说清楚边界）

- **没有真跑一次生成。** 判据、负对照、渲染、后端起都验了，但**没有让真实模型
  照着新 prompt 做一份稿子看它到底会不会设计**。prompt 改动的效果只有实跑才知道，
  这一条是空的
- **`getDesignTokens` 仍然返回主题推出来的那套颜色**，而现在颜色该由模型定。
  prompt 里加了一句「它给的是你还没定时的默认，不是让你照抄的答案」，
  但这是拿文案补接口语义，不是干净的做法
- **⑨ 只判「有没有给锚点」，不判「给得好不好」**。模型可以传三个随机色骗过它。
  再往下就得判色相距离、明度分布这类东西，而那些**该不该由 lint 判本身就存疑** ——
  真正的兜底是 `ensureContrast`，它已经在跑了
- **形状文字和表格仍是 `DEFAULT_BODY_FONT`**（`design.ts` 里那条已知缺口），
  自配字体之后这个不一致更明显了：一份自配「得意黑 + MiSans」的稿子，
  表格会是阿里普惠体

---

## R-56 · 工具覆盖调研，以及 R-55 那条判据是错的

起因是一句提问：「还有多少工具是没有被提示词调用的」。查法是把 26 个工具名逐个
在 `getSystemPrompt('deck')` 里数一遍 —— **8 个 0 次出现**，9 个只出现 1 次。

先说方法上的一句：**光数「提示词提没提」是没有意义的**，工具的 zod 描述是随请求
发给模型的。真正会出事的是三种：提示词反着教、工作流里没有它的位置、
以及**提示词把模型指向了另一条走不通的路**。第三种正好抓到了我自己。

#### 调研直接抓出了 R-55 的一个错

那 8 个里有 `setTheme`。而查下去发现**所有下游都读 `state.theme`**：

```
getDesignTokens   → buildPalette(state.theme)
addShape.fill     → 必填，描述说「用 getDesignTokens 拿主色/强调色」→ theme
addChart          → 不传 themeColors 就用「主题的主色+强调色」
addTable          → 不传 themeColor 就用「主题主色」
```

**只有 `applyLayout` 的 `paletteOverride` 绕开主题**，而且它是每次调用的、不落盘的。
R-55 的 prompt 写的却是「每次 applyLayout 都把这一套原样传进去，每页都一样」。

实测（`applyLayoutToSlide` + `applyAddChart` 各跑一遍，量出来的）：

| | 版式页背景 | 图表主色 |
|---|---|---|
| setTheme 定色 | `#f4f1ea` | `#8a1538` ✅ |
| 每页传 paletteOverride | `#f4f1ea` | **`#2f6feb`** ❌ 还是旧主题蓝 |

也就是说 R-55 教出来的是一份**版式一套色、形状和图表另一套色**的稿子。
**而且改之前反倒是一致的**（大家都用同一套默认）—— 是 R-55 把它劈开的。

更糟的是判据 ⑨ 判的是 `paletteAnchors`（applyLayout 显式传了哪几个覆盖色），
于是它**奖励了会劈开稿子的那条路，惩罚了正确的那条**：走 setTheme 时
`paletteAnchors` 恰恰是空的。

#### 怎么改的：让模型自己说，不让代码去猜

判「这份稿子被设计过吗」，第二个念头是拿 `store/slides.ts:75` 那套默认色当参照物比对。
决策者否掉了，理由是「让模型自己决定」—— 这条是对的：拿常量比是**代码在猜**，
而且默认主题一改判据就悄悄失准。

改成判 `theme.designNote`：模型自己写的一句「这套色是被这份稿子里的什么驱动的」。
它本来就该答（prompt 从 R-55 起就这么要求），**只是以前没地方写** ——
和 `paletteStyle` 落盘之前的处境逐字相同。写下来这件事本身就是逼它真想一遍。

`designNote` 挂在 `SlideTheme` 上，跟着 `themeJson` 整块存，**不用迁移**。
`paletteAnchors` 留作第二信号：个别页真要破例覆盖时，那也是做了决定。

`lintDeckDesign` 因此多收一个可选的 `theme`。不传就退回只看锚点 ——
**少一个信号会让 ⑨ 偏严**，所以生产路径（`lintDeck` 工具）必须传，
不传只出现在只关心几何的单测里。

#### 顺带补上的三个

| | 原来 | 现在 |
|---|---|---|
| `reflectRender` | R-52 整个功能，工作顺序里**没有第 4 步** | 补成第 5 步，写清它和 lintDeck 的分工 |
| `updateElement` | 提示词专门有一节讲「局部调整」，却从没说过用哪个工具改 | 在那一节点名 |
| `addSlide.afterIndex` | 只说「addSlide 建空页」，没说怎么往中间插 | 补上 |

调研的 8 个未提及降到 4 个（`getSlide` / `findElements` / `updateSlide` / `deleteSlide`，
都是自述清楚的读和增删，低风险）。

#### 判据与负对照

新增 3 条测试，其中一条是**专门钉住第一版那个错**的：

> `setTheme 写了 designNote 就放过 —— 那才是定颜色的正路`
> 先断言 `paletteAnchors` 全空，再断言 ⑨ 不报。第一版判据下这条必红。

`npm run layout-audit` 87 张样张仍然 0 告警。

#### 没做的

- **字体和 `style` 仍然是每页传**：`buildLayout` 要的是 `TypeRecipe`，
  没有主题级的位置。把它们提到主题上是对的，但那是另一轮的改动
- **`getDesignTokens` 现在对了**，因为颜色回到了主题上 ——
  R-55 那条「拿文案补接口语义」的欠账被这一轮顺手还掉了
- **仍然没有真跑一次生成**。R-55 那条空着的判据，这一轮还是空着

## R-57 · 文字底下实际是什么颜色（14 号文档 O6）

起因是通读 `refs/skills` 那两个参考项目之后定的借鉴方案（[14 号文档](./14-ornament-layer.md)）。
四步里的**第一步**，也是唯一一步**独立有价值**的：就算生成装饰层那条路后面被否掉，
这一步还的是 R-48 那笔旧账。

#### 它补的是哪个洞

`scrimFor` 算的是「遮罩压在**图片解码亮度**上之后，文字踩在什么颜色上」。
这个推算漏掉一整类东西 —— **版式自己在遮罩之上画的装饰**：

R-48 判过「半透明色块叠在照片上像块污渍」，**只修了 `title-split`**；
R-50 才发现 `stat` 的光晕、`end` 的装饰环、`title-center` 的斜块、
`title-split` 的强调色分界线**漏了整整一轮**。同一轮还有一条更直接的：
「『关键指标』那行黄字压在照片上几乎看不见，**而所有断言都是绿的**」。

那次是补了 `ensureContrast` + `Builder.onPhoto()`，**但那仍然是推算** ——
`onPhoto` 拿的是 `scrimFor` 给的 `effectiveBg`，它照样不知道装饰画在了哪儿。

#### 做法：和 `renderReflect` 逐字同一个形状

**换的是输入，不是检查。** `contrastRatio` 一行没改、`CONTRAST_AA = 4.5` 没动 ——
改的只是喂给它的背景色：从推算的 `effectiveBg`，变成前端在**真实渲染**上采样出来的值。

```
前端多渲一份「不含文字层」的同一页 → toCanvas → 对每块文字的矩形采样
  ↓
每块文字回传三个只有浏览器知道的数：
  textColor  getComputedStyle().color（不解析 HTML —— 那是第二实现）
  backdrop   该矩形下方合成后的第 5 / 95 百分位**真实颜色**
  sampled    采到几个像素
  ↓
服务端 renderContrast.ts（纯函数，测得到）
```

三个刻意的决定：

- **按亮度排序取百分位，返回那两个位置的真实颜色，不取平均色。**
  平均色会把「一半纯白一半纯黑」算成灰 —— 而那正是最危险的背景：
  白字在白半边完全消失，平均值却显示对比度很好
- **「最坏那一头」的判据和 `scrimFor` 逐字相同**（取 {p5,p95} 里离文字亮度更近的那个）。
  两处用不同判据会出现「遮罩按 p5 算、检查按 p95 判」，那时遮罩永远修不好检查报的问题
- **跨域图片污染画布时返回 `sampled:0`，服务端报「这条没判」**，绝不吞掉当成「背景是白的」——
  那会把所有深色主题误判成低对比度

给 agent 的改法按病灶分三种，并明写**不要把整份稿子的文字改成黑白** ——
配色是这份稿子被设计过的证据（判据 ⑨），洗掉它等于把 R-55/R-56 白做了。

#### 判据与负对照

新增 14 条测试。**每一条「量了能看见」都配一条「推算看不见」** ——
只测新做法看得见，证明不了它比原来强。核心那条是 R-48 那个 bug 的复现脚本：

> 同一份数据，`scrimFor` 推算出的对比度 **≥ 4.5（达标）**，
> 而实测文字底下是那枚强调色装饰环 → **< 4.5（不达标）**。两个断言同时成立。

四组真负对照，**真改坏源文件、`grep` 确认改动落到文件上、跑完还原复跑**：

| 负对照 | 结果 |
|---|---|
| `worstBackdrop` 改成「一律取亮的」 | 2 failed ✅ |
| 去掉采样数门槛 | 2 failed ✅ |
| 不再只判文本元素 | 1 failed ✅ |
| 去掉「最糟的排前面」 | 1 failed ✅ |
| 还原后复跑 | 全绿 ✅ |

#### 判断错过的地方（两处，都是自己的检查太松）

1. **第一版负对照脚本有两条是无效的，而它「看起来跑过了」。**
   用 `IFS='|'` 切分参数，而 perl 表达式里有 `\|\|` —— 分隔符把表达式切坏了，
   perl 报 `Substitution pattern not terminated`，改根本没落到文件上，测试自然全绿。
   **是「grep 确认改动落到文件上」这条规矩当场抓住的** ——
   没有它，我会拿着两条假负对照报「四条全过」。
2. **验 UPNG 调色板能不能读回来时，第一版只比了长度不比内容。**
   长度对而内容全零，检查照样过。补了逐像素比之后才看清真实情况
   （见 14 号文档事实 ⑥）。这正是这个仓库最忌讳的那种绿。

#### 没做的 / 已知问题

- **`npx tsc --noEmit -p server/tsconfig.json` 没过，但不是这轮引入的。**
  `layouts.test.ts(364,24)`：`el.height` —— 上面的 `if (!('left' in el) || !('top' in el))`
  只窄化了 `left`/`top`，没窄化 `width`/`height`，而 `PPTLineElement` 没有后两个字段。
  该文件与 HEAD **逐字节相同**；把本轮新增的两个文件移开后**照样报**（已实测验证）。
  修法是给守卫补上 `'width' in el`，但那会**改变测试语义**（线元素会被跳过检查），
  所以没有顺手改 —— 留给决策者定。
- **端到端没验。** 前端采样那半只过了类型和构建，**没有真跑一次「渲染 → 采样 → 报告」**。
  和 13 号文档判据 R4 是同一种欠账：要构造一份「真的低对比度」的稿子才验得了。
- **`scrimFor` 本身没动。** 这一轮只加了「事后能看见」，没有让版式引擎「事前算得更准」。
  两者是不同的事，后者要等装饰层的位置也进得了推算才谈得上。

---

## R-58 · 生成装饰层（14 号文档全四步）

四步一次做完：抠图内核 → 负空间提示词 → 判据 → 接线 + 端到端实测。
背景与决策见 [14 号文档](./14-ornament-layer.md)。

#### 链路

```
applyLayout 定好坐标
  → occupiedRectsOf   把「文字/图片在哪」翻译成负空间
  → buildOrnamentPrompt  矩形 + 锚点色 hex + 键色名，全部由代码注入
  → generateImage     模型只填负空间里的纹样
  → chromaKey         纯绿底抠成透明（保色保线）
  → O2 形状对不对 / O1 有没有压到文字  →  不过就重抽一次
  → encodeRgbaPng → COS → asset://
```

**整条链路上唯一的模型决策是「画什么花纹」。** 构图来自已定的坐标、配色来自主题，
这是 11 号文档那条红线在这条路上的落法。

#### 端到端实测（真模型 + 真抠图 + 真 COS）

```
透明 94.95% · 半透明 2.49% · 不透明 2.56%
O2 ✅ · O1 ✅ 没有压到文字
109 KB（原图 858 KB，判据上限 300 KB）
✅ asset://347b62df…
```

#### 判据与负对照

新增 47 条测试（chromaKey 18 + ornament 17 + toolGroups 补 2 + 前一轮 renderContrast 14 之外）。
**八组真负对照**，全部改坏源文件 → `grep` 确认落到文件 → 跑 → 还原复跑：

| 负对照 | 结果 |
|---|---|
| 去溢出锚点恒为 0 | 7 failed ✅ |
| 去溢出压所有三通道 | 6 failed ✅ |
| 不归零全透明像素 RGB | 1 failed ✅ |
| 可用性门槛降到 0（棋盘格放行） | 1 failed ✅ |
| 关掉边缘反混合 | 1 failed ✅ |
| `alphaCutoff` 拉到 200（细线被砍） | 1 failed ✅ |
| `occupiedRectsOf` 收所有元素 | 1 failed ✅ |
| O1 判「有没有像素」而非平均浓度 | 1 failed ✅ |

阈值全部拿真样本标定（`samples/ornament/`）：留空矩形内平均 alpha
**目标形态 0 / thin-line 0.6 / 被压 76.1 / 棋盘格 255**，阈值 12 落在中间，两边各差一到两个数量级。

#### 判断错过的地方（三处，都是实测抓的）

1. **把 prompt 泛化时丢了颜色的名字，当场回归。**
   为支持任意键色，把 `pure green background, hex #00FF00` 改成
   `the exact color #00FF00`。实测：**带色名的 3 次全部照做（透明 92~95%），
   只给 hex 的 2 次全部翻车**（一次 32.79% 不透明、一次 91.97%）。
   **模型对色名的遵守远强于对 hex 的遵守。** 已钉成判据。
2. **第一条负对照是无效的，而它「看起来跑过了」。**
   把 `if (isSpill[1] && g > anchor)` 的守卫去掉 —— 但绿键下 `isSpill[1]` 恒真、
   品红键下锚点就是 G 自己，**这个「改坏」两种情况下都是 no-op**。
   是它没变红才发现的。
3. **关掉边缘反混合时测试全绿 —— 真的测试缺口。**
   那是决定颜色漂不漂的一环（thin-line 版墨里只有 6.8% 是实心，颜色全靠它重建），
   而我一条判据都没写。补了之后负对照才红。

#### 顺带修正的一处认知

**「实心笔画」和「覆盖密度」是两个正交的旋钮，第一版把它们混在一句话里。**
「bold flat vector shapes and thick bars」要到了实心（墨中实心占比 6.8% → 92%），
但覆盖率也从 7.65% 飙到 33% —— 那不是装饰层，是会跟内容打架的海报。
拆成 (A)/(B) 两段之后收敛到覆盖 5.04% + 墨中实心 80%。

#### 追加：`generateBackdrop`（同一轮，决策者要「更好的效果」之后加的）

装饰层压在上面加线条，**底图垫在下面给底子** —— 后者才是观感提升最大的那一档。
两者共用取模型/限流/存储，其余完全不同（对照表见 14 号文档开头）。

底图**不用抠图**（不透明），所以能走 JPEG：实测 1043 KB → **118 KB**，
比装饰层的无损 PNG 207 KB 还小。

端到端实测一次过：`提示词无数字 ✅ → 安静区判据 ✅ → 118 KB → COS ✅`，
产物见 `samples/ornament/backdrop.jpg`（网格底纹 + 标题区带阴影面板 +
正文区安静色带 + 右侧斜带和四角承担视觉分量，**零文字**）。

**这一轮又抓到两个自己的洞**：

1. **`indexOf` 断言的坑。** 「禁文字那句要在最前面」写成
   `expect(p.indexOf('NO text')).toBeLessThan(p.indexOf('WHAT TO DRAW'))` ——
   而 `indexOf` 找不到时返回 **-1**，`-1 < 任何正数`恒真。
   **把那句话整个删掉，测试照样绿。** 负对照当场抓住，改成先断言存在再比位置。
2. **测试 fixture 造错了。** 验「最花的排前面」时把整块填成纯黑 ——
   那是**均匀**，跨度 0，本来就不该报。顺手补了一条「深 ≠ 花」：
   整块均匀的深色不报，因为深底配浅字是成立的设计，该由对比度那条判。

#### 追加二：把工具接进提示词 —— 以及把「工具够不够得着」变成机器可判

**R-58 第一次交付时又踩了 R-56 那个坑**：两个工具装好了、判据立了、
端到端跑通了，而 `getSystemPrompt('deck')` 里 **0 次出现**、
**工作顺序里没有位置** —— 于是模型永远不会想起来调它，
**且没有任何东西会报错**。是决策者一句「你不检查 prompt 让他自己调用啊」点破的。

R-56 那次的结论原样适用，也是这次判据的立法依据：

> 光数「提示词提没提」是没有意义的……真正会出事的是三种：提示词**反着教**、
> **工作流里没有它的位置**、以及提示词把模型指向了另一条走不通的路。

所以新增的 `promptCoverage.test.ts` 判的不是「提到了没有」，而是**「工作顺序那一节里有没有它」**。

**顺带发现一处实质的顺序约束**：生成图层必须排在 `reflectRender` **之前**。
底图会改变文字背后的颜色，而 `reflectRender` 的对比度那档量的是**实际渲染出来的背景** ——
顺序反了的话量的是没有底图的版本，**等于白量**。这条也钉成了判据。

改动：工作顺序从 5 步变 6 步（第 5 步生成图层，reflectRender 顺延到第 6）、
新增「生成图层」一节、「页面背景」那节点名 `generateBackdrop`。
prompt 从 10,394 涨到 **12,036 字（+16%）**，实测的。

三组负对照：删掉第 5 步 → 2 failed；把生成图层挪到 reflectRender 之后 → 2 failed；
提示词里明令禁用一个已注册工具 → 1 failed。

**还踩了一个低级的**：新写的那节里用了反引号（`` `addOrnament` ``），
而整段 prompt 是模板字符串 —— 反引号提前闭合，`getSystemPrompt` 直接抛。
起后端时才发现，不是类型检查能拦的。

#### 已知限制

- **键色和内容配色会撞。** 去溢出压的是「键色主导的通道」，所以哪些颜色是 no-op
  取决于键色：绿键下藏青纹丝不动，**品红键下藏青的 B 会被压到 G 的高度**。
  `probe_palette` 那套探色还没移植，而 rabbit 的配色是模型自己定的（R-55），
  撞绿的稿子迟早出现。判据钉在 `chromaKey.test.ts`「已知限制」那条。
- **`addOrnament` 返回 `asset://`，由 agent 自己调 `addElement` 落成图片元素**，
  和 `searchImage`/`generateImage` 同一个形状。没做成自动叠加。
- **没有真跑一次完整的 agent 任务**。工具、判据、端到端链路都验了，
  但「模型会不会在该用的时候用它」是空的 —— 和 R-55/R-56 欠的是同一笔。

---

## R-59 · 白屏没有任何记录 —— 以及一次被负对照证伪的诊断

用户报「思考完调用工具直接白屏刷新页面了，具体是哪个工具我不知道」。

#### 先说结论：我的第一个诊断是错的，而且是负对照挡住的

查到 `renderMeasure.ts` 里 `bare(slide)` 写在 `render()` **函数内部** ——
每次重渲都造新对象，而 `bare()` 读的 `slide.elements` 是 pinia 响应式代理，
看起来是个典型的自激循环。改法很直接：挪到 `render()` 外面算一次。

**然后按规矩把修复退回去跑负对照 —— 它没红。** 出 bug 的那一版在
`npm run render-probe`（真无头浏览器）里照样跑完，547ms、89/89 块全采到。
接着补了「测量进行中连推三次 `setSlides`」模拟真实时序，**还是过**（921ms）。

所以那个循环**不是**白屏的原因。修复留着（它本身是对的：不该在 render 里造新身份），
但**不能说它修好了那个 bug**。

#### 真正做的事：让白屏说得出话

查出根因之外的一件事：`main.ts` 里**一个全局错误处理都没有**。
于是 Vue 渲染期出错 = 静默白屏，页面没了、控制台跟着没了，
用户能提供的信息只有「它白了」—— 这才是排查不下去的真正原因。

`src/utils/crashLog.ts` + `main.ts` 装三条捕获路径
（`app.config.errorHandler` / `window.onerror` / `unhandledrejection`），
记录**落 localStorage**：白屏之后人的第一反应是刷新，而刷新会带走内存里的一切。

两个刻意的决定：

- **满了丢新的，不丢旧的**（和常见 ring buffer 反着来）。一次崩溃常连环触发十几条，
  **第一条才是根因**，后面全是余波 —— 丢旧留新等于把唯一有用的挤掉
- **读写全包在 try 里**。无痕模式下 `setItem` 抛 QuotaExceeded，
  而在错误处理路径上再抛一次，会把原始错误彻底盖掉 —— 比没有捕获更糟

16 条测试，重点全在「错误处理路径自己不能再出错」：
Error / 字符串 / 数字 / null / undefined / 对象都能整成记录，
坏 JSON、非数组、`getItem`/`setItem`/`removeItem` 抛异常，一律不往外冒。

#### 顺带补上探针的一个缺口

`render-probe` 原来调的是 `measureRenderedSlides([], false)` ——
**`wantBackdrop` 是默认的 false，R-57 那条路一行都没被覆盖过**。
补了一次 `wantBackdrop: true` 的运行，并把它纳入 R3 的通过判据
（跑不完、或跑完了但一块都没采到，都算不通过）。

#### 追加：横幅 —— 因为「打开控制台」不是所有人都做得到

Safari 的开发者菜单**默认是关的**，要先进设置勾「显示网页开发者功能」。
一个排查步骤如果要求用户先改浏览器设置，现实里它就是不会被执行的。

所以崩过之后刷新，页面顶上直接挂一条横幅：第一条错误 + 一键复制 + 清除。
**纯 DOM，不走 Vue** —— 崩溃可能就发生在 Vue 挂载期间，
那种情况下组件形式的横幅根本渲染不出来，而它要服务的正是最糟的那个场景。
样式全内联，因为样式表也可能没加载上；复制留了 `execCommand` 那条老路，
因为 `navigator.clipboard` 在非 https 下不存在。

#### 又抓到一个假绿的断言（同一类，一轮里第二次）

横幅那条测试写的是「显示的是第一条」，用「根因 / 余波1」当消息内容断言。
**而横幅自己的标题里就写着「下面是第一条 —— 它才是根因」** ——
于是 `toContain('根因')` 匹配的是**界面文案**而不是数据，
把 `records[0]` 改成 `records.at(-1)`，测试照样绿。负对照当场抓住。

改成 `ZZ_FIRST_ONLY` 这种不可能和文案撞车的字符串之后才红。

**这一轮里同一类洞踩了两次**：先是 `indexOf` 找不到返回 -1 让
「-1 < 任何正数」恒真，再是断言字符串和界面文案撞车。
共同点都是**「被测对象消失/改变时，断言仍然成立」** —— 而这正是负对照要抓的东西。

#### 还没解决的

**白屏的根因仍然不知道。** 这一轮交付的是「下次复现能知道是什么」，
不是「修好了」。等下一次复现时读 `localStorage` 里那份记录。

---

## 待完成

> 下面这张表是**当前**的权威清单。其中 agent 相关的多项已被
> [11-agent-roadmap.md](./11-agent-roadmap.md) 重新编排进 A~D 四期，
> 两边冲突时以 11 号文档的期次为准。

| 项 | 说明 | 优先级 |
|---|---|---|
| **applyLayout 返回创建的元素** | 省掉每页一次 `getSlide` 回读（实测 13 次），是当前最大的一块步数浪费 | 中 |
| **查清 updateElement 改宽度** | 实测 24 次里 17 次只改 `width`。是 `applyLayout` 估宽不够，还是模型多手？**第二十轮修了估算的三处系统性偏差（inset / 16px 行盒 / 拉丁整词不断），值得重测一次** | 中 |
| 思考过程落库 | 现在只在实时流里，重开会话看不到。要不要存、存多少（很占地方）没定 | 低 |
| **E3 地面真相** | 导出的动画在真实 PowerPoint 里逐个验，样本已生成（`samples/animations/`），清单见 [09-powerpoint-verify.md](./09-powerpoint-verify.md)。**网页侧已在无头浏览器里逐帧验完**（R-36），剩下的确实只有 PowerPoint 那一半 | **高** |
| **`in` / `out` 光圈方向** | `box-in` / `circle-in` / `diamond-in` / `plus-in` 网页侧一律「自中心向外张开」。若 PowerPoint 的 `filter=circle(in)` 实际是「自外向内收拢」，这四个方向就是反的 —— 只能开 PowerPoint 看，判法见 [09](./09-powerpoint-verify.md) 第三节 | **高** |
| ~~**图片 / 图标能力**~~ | 08 号诊断 ① 里最大的一条。**第十七轮配置层 + 第十八轮工具层已完成**：两个工具已注册、限流已执行（含上游 429）、压缩已实现（PNG→JPEG 6~13 倍）、`assets` 票据表 + 24h 搜图缓存已建，全链路实测通过并在浏览器里看过 | ✅ |
| **图片署名要显示出来** | 合规②：`assets` 表有权威副本，且第十九轮实测中 agent **自己**在每页底部加了署名小字 —— 但那是模型自觉，不是保证。要做成不依赖模型的：画布选中图片时显示来源、导出时附一页来源清单 | 中 |
| ~~**agent 用图的功能测试**~~ | **第十九轮已做**：真实任务「3 页简报每页配图」跑通，3 页 3 张图全部落进 deck，浏览器里逐页看过 | ✅ |
| ~~**给 cards / compare / timeline 配图**~~ | **第二十轮已做**：新增 `image-grid`（每条各配一张图）/ `split-figure`（左图右列）/ `full-figure`（满屏图 + 浮层卡片）三个版式，10 → 13 | ✅ |
| **生图 prompt 模板化** | 现在 agent 写什么就发什么，产出风格一致性全靠模型自觉。「决策不该由模型做」这条红线在这里还没落实 | 中 |
| R-09 / R-18 | 旧 AI 路径包装成 agent 工具 `fillFromTemplate` | 中 |
| **事务 / 回滚** | 逐工具提交，中途失败留半成品。Oh My PPT 的 job/rollback 还没抄。**第十五轮之后这条变重了**：中途落库把原来那个「失败时库是干净的」的意外回滚拿掉了，现在半成品会永久留在库里 —— checkpoint 是把它还回来的那一步 | **高** |
| ~~并发控制~~ | ~~agent 跑时用户手改画布会被整份 `agent.deck` 覆盖~~ —— **第十六轮已修**（单一权威写者，画布锁 + 接管） | ✅ |
| **乐观并发从没生效过** | `routes/deck.ts:60` 的 `version < existing.version → 409` 实现了，但前端 `saveDeck`（`App.vue:99`）**从来不传 `version`**，那道检查一次都没跑过。表现是两个标签页开同一份文稿会互相静默覆盖。和 agent 无关，是独立的老毛病 | 中 |
| ~~图片资产存储~~ | ~~对象存储（S3/R2）~~ —— **第十七轮已完成**：腾讯云 COS，桶 / CORS / 内容寻址全部实测通过 | ✅ |
| **调研摄入** | 方案已定，见 [13-queue-reflect-ingest.md](./13-queue-reflect-ingest.md) §四§五。**摄入的验收标准是「几乎所有材料都能吃」**（pdf / txt / 图片 / word / md / json / 网页 url），按「解析在哪」分三档：浏览器侧（jszip 已在树里 + pdfjs）/ 服务端（URL 抓取）/ 模型（图片与扫描件）。搜索照抄 `imageSearch.ts` 那套：付费 provider 首选 + 一档免 key 兜底 | **高** |
| **`agent.confirm` 接上去** | 空分支等的那个「后端挂起等前端」机制，R-52 已经建好了（`runtime/pendingRequests.ts`，渲染后反思用的就是它），只差接线 | 中 |
| ~~渲染后反思~~ | 11 号 D3。**R-52 已完成**：`reflectRender` 工具 + 离屏测量 + 独立配置的视觉复核模型。判据与负对照见 13 号文档 §三 | ✅ |
| ~~排队输入~~ | 11 号 C 期。**R-52 已完成**：`runtime/inputQueue.ts` + `runtime/taskGate.ts`，顺带修掉「被拒的输入在面板上显示成已受理」 | ✅ |
| OAuth 登录 | GitHub / Google，目前只有账号密码 | 低 |
| agent 中途提问 | `ws/handler.ts` 的 `agent.confirm` 仍是空分支。**等待机制 R-52 已经建好**（`runtime/pendingRequests.ts`），只差把提问接上去 | 低 |
| AGPL-3.0 授权 | 需联系 PPTist 作者询价（决策 C） | **高风险** |

## 待确认

- [ ] **决策 C**：AGPL-3.0 授权 —— 需联系 PPTist 作者询价。**这是当前唯一可能导致推倒重来的风险**
- [ ] `objectName` 是否对图表 / 表格生效（走 graphicFrame，属性位置可能不同）
- [ ] 上游 `pptxtojson` 导入时是否解析动画
- [x] ~~Reviewer 角色调用 LLM 报 "Not Found"~~ —— 已加 `normalizeBaseUrl` 修正常见 baseUrl 填法，且异常现在自带 provider/model/baseUrl。**待实测确认是否根治**
