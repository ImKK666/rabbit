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

**542 个单测**（vitest）：
assetUrl 19 + spidMap 8 + buildTimingXml 110 + buildTransitionXml 21 + shapeCatalog 38 +
kernel 53 + kernel-elements 79 + design 30 + layouts 143 + history/baseUrl 41。

`npm run build` exit 0（前端），`bunx tsc --noEmit` exit 0（后端），`npx vitest run` 全绿。

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

## 待完成

| 项 | 说明 | 优先级 |
|---|---|---|
| **E3 地面真相** | 导出的动画在真实 PowerPoint 里逐个验，样本已生成（`samples/animations/`），清单见 [09-powerpoint-verify.md](./09-powerpoint-verify.md) | **高** |
| **图片 / 图标能力** | 08 号文档诊断 ① 里最大的一条，本轮按决策 P1 只定了接口（`server/src/agent/assets.ts`），provider 未接 | **高** |
| R-09 / R-18 | 旧 AI 路径包装成 agent 工具 `fillFromTemplate` | 中 |
| 事务 / 回滚 | 逐工具提交，中途失败留半成品。Oh My PPT 的 job/rollback 还没抄 | 中 |
| 并发控制 | agent 跑时用户手改画布会被整份 `agent.deck` 覆盖 | 中 |
| 图片资产存储 | 对象存储（S3/R2），图片能力落地的前置 | 中 |
| 图标命名 | `configs/shapes.ts` 里「其他形状」「线性」两类共 51 个图标字形没有可靠名字，agent 用不了 | 低 |
| 调研摄入 | MinerU / 联网搜索，目前 TODO | 低 |
| OAuth 登录 | GitHub / Google，目前只有账号密码 | 低 |
| AGPL-3.0 授权 | 需联系 PPTist 作者询价（决策 C） | **高风险** |

## 待确认

- [ ] **决策 C**：AGPL-3.0 授权 —— 需联系 PPTist 作者询价。**这是当前唯一可能导致推倒重来的风险**
- [ ] `objectName` 是否对图表 / 表格生效（走 graphicFrame，属性位置可能不同）
- [ ] 上游 `pptxtojson` 导入时是否解析动画
- [x] ~~Reviewer 角色调用 LLM 报 "Not Found"~~ —— 已加 `normalizeBaseUrl` 修正常见 baseUrl 填法，且异常现在自带 provider/model/baseUrl。**待实测确认是否根治**
