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

**771 个单测**（vitest，截至 2026-08-19 第十轮）：
layouts 224 + buildTimingXml 114 + kernel-elements 100 + animation 71 + kernel 53 +
shapeCatalog 38 + design 30 + history 26 + buildTransitionXml 21 + assetUrl 19 +
reasoning 18 + baseUrl 15 + budget 15 + animation-reach 11 + animationSteps 8 + spidMap 8。

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

## 待完成

| 项 | 说明 | 优先级 |
|---|---|---|
| **applyLayout 返回创建的元素** | 省掉每页一次 `getSlide` 回读（实测 13 次），是当前最大的一块步数浪费 | 中 |
| **查清 updateElement 改宽度** | 实测 24 次里 17 次只改 `width`。是 `applyLayout` 估宽不够，还是模型多手？ | 中 |
| 思考过程落库 | 现在只在实时流里，重开会话看不到。要不要存、存多少（很占地方）没定 | 低 |
| **E3 地面真相** | 导出的动画在真实 PowerPoint 里逐个验，样本已生成（`samples/animations/`），清单见 [09-powerpoint-verify.md](./09-powerpoint-verify.md)。**网页侧已在无头浏览器里逐帧验完**（R-36），剩下的确实只有 PowerPoint 那一半 | **高** |
| **`in` / `out` 光圈方向** | `box-in` / `circle-in` / `diamond-in` / `plus-in` 网页侧一律「自中心向外张开」。若 PowerPoint 的 `filter=circle(in)` 实际是「自外向内收拢」，这四个方向就是反的 —— 只能开 PowerPoint 看，判法见 [09](./09-powerpoint-verify.md) 第三节 | **高** |
| **图片 / 图标能力** | 08 号文档诊断 ① 里最大的一条，本轮按决策 P1 只定了接口（`server/src/agent/assets.ts`），provider 未接 | **高** |
| R-09 / R-18 | 旧 AI 路径包装成 agent 工具 `fillFromTemplate` | 中 |
| 事务 / 回滚 | 逐工具提交，中途失败留半成品。Oh My PPT 的 job/rollback 还没抄 | 中 |
| 并发控制 | agent 跑时用户手改画布会被整份 `agent.deck` 覆盖 | 中 |
| 图片资产存储 | 对象存储（S3/R2），图片能力落地的前置 | 中 |
| 图标命名 | `configs/shapes.ts` 里「其他形状」「线性」两类共 51 个图标字形没有可靠名字，agent 用不了 | 低 |
| 调研摄入 | MinerU / 联网搜索，目前 TODO | 低 |
| OAuth 登录 | GitHub / Google，目前只有账号密码 | 低 |
| agent 中途提问 | `ws/handler.ts` 的 `agent.confirm` 是空分支，需要 agent 暂停等待机制 | 低 |
| AGPL-3.0 授权 | 需联系 PPTist 作者询价（决策 C） | **高风险** |

## 待确认

- [ ] **决策 C**：AGPL-3.0 授权 —— 需联系 PPTist 作者询价。**这是当前唯一可能导致推倒重来的风险**
- [ ] `objectName` 是否对图表 / 表格生效（走 graphicFrame，属性位置可能不同）
- [ ] 上游 `pptxtojson` 导入时是否解析动画
- [x] ~~Reviewer 角色调用 LLM 报 "Not Found"~~ —— 已加 `normalizeBaseUrl` 修正常见 baseUrl 填法，且异常现在自带 provider/model/baseUrl。**待实测确认是否根治**
