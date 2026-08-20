# 12 · 从「四角色剧本」到「一个 agent 的一问一答」

**方向决策（2026-08-20）**：把 deck 域的 4 个角色收成 1 个，编排从直线剧本换成
**单轮循环**，对话形状对齐 BitFun / Claude Code 的「一问一答 + 完整历史上下文」，
并让**思考块跨工具调用、跨轮次都保留下来**。

研究依据：[10-agent-runtime-study.md](./10-agent-runtime-study.md)（BitFun + Claude Code 的 runtime）。
本文是对 [11-agent-roadmap.md](./11-agent-roadmap.md) **§四「不要把剧本换成自由循环」的修正**，
修正的理由写在 §六，**原文不删**。

---

## 一 · 四角色现在花掉了什么（实测，不是估计）

`getSystemPrompt` 逐个量出来（2026-08-20，`server/` 下跑）：

| 角色 | system prompt |
|---|---:|
| planner | 6,193 字 |
| generator | 7,865 字 |
| reviewer | 6,154 字 |
| editor | 6,924 字 |

一次「生成一份 PPT」走 planner → generator → reviewer，**system prompt 合计 20,212 字**；
Reviewer 不过再修一轮就是 28,077 字。而四份 prompt 的**共同前缀（`CANVAS_CONTEXT`）是 5,115 字** ——
一次生成路径里它被原样送了 3 次，**其中 10,230 字是纯重复**。

但字数不是主要代价，**三次冷启动**才是：

1. **prompt cache 一个 token 都命不中。** 三次 `streamText` 是三个独立请求、三份不同的 system，
   前缀匹配从第一个字节就分叉了（见 `shared/prompt-caching.md` 的前缀不变式）。
2. **观察结果不共享。** Planner 用 `getDeck` 看过的东西，Generator 拿到的只是 Planner 的**文本**输出
   （`pipeline.ts:552`），要重新 `getDeck` 再看一遍；Reviewer 连 history 都不给（`pipeline.ts:565` 传 `[]`），
   `lintDeck` + `getDeck(includeElements)` 通读第三遍。**同一份 deck 被三个角色各读一次。**
3. **Planner 在决定一件代码已经定好的事。** 它的产出是「每页给一个版式名 + 内容」，
   而版式名的合法集合由 `describeLayouts()` 生成。这是 Generator 写第一页之前顺手能做的判断，
   不值一次独立的模型往返。
4. **Reviewer 的大部分职责已经代码化了。** `roles.ts:280` 自己写着「先跑 lintDeck，
   它会同时报几何问题和设计问题」。Reviewer 相对 lintDeck 的增量只剩两条：
   「空洞的套话」和「该用图表却排成文字」。

11 号文档 §一 那张表已经写过：「排版 / 配色 / 动画编排的天花板**已经靠代码化摸到了**」。
决策既然进了代码，再套一层「规划者 + 审查者」就只是在复述代码里已经定好的东西。

---

## 二 · 真正坏掉的不是角色数，是「历史」

这一条比角色数量严重得多，而且**砍角色之后会更严重**，不是更轻。

### 2.1 两家参照项目的形状是同一个

Claude Code 的整个 agent loop 就是一个 `while(true)`，跨轮状态收在一个 `State` record 里，
每个 continue 点写全字段（`query.ts:204`）。历史是**一个扁平的、只增不减的 `messages` 数组**
（`query.ts:1716`）：

```ts
messages: [...messagesForQuery, ...assistantMessages, ...toolResults]
```

数组里装的是**完整的 content block** —— thinking（带 signature）/ text / tool_use / tool_result。
下一轮用户输入直接 append 到同一个数组。**这就是「一问一答带历史上下文」的全部机制。**

BitFun 是同一个形状，只是分层更细：一个 Dialog Turn 由多个 **round** 组成
（`dialog_turn.rs` 的 `TurnStats { total_rounds, total_tools, … }`），
`execution_engine.rs` 头注释写的就是「Executes complete dialog turns, managing loops of multiple model rounds」。

**两家在这里做的是同一个选择，那多半是问题本身的形状。**

### 2.2 rabbit 现在把历史压扁成了纯文本

落库（`pipeline.ts:117` / `runtime/history.ts:47`）：

| 存的东西 | 存成什么 |
|---|---|
| assistant 文本 | `[Generator] 一段汇报` |
| 工具调用 | `role='tool'` 一行 `JSON.stringify({tool,args,result})` |
| **思考块** | **完全不落库**（`src/store/agent.ts:31` 注释明说「只存在于实时流里，不落库」） |

读回来（`runtime/history.ts:83` 的 `toHistoryTurns`）：

- 丢掉所有 `[Planner]` / `[Reviewer]` 行
- **丢掉所有 `role='tool'` 行** —— 工具调用轨迹在下一轮完全消失
- 每条截断到 **600 字**（`HISTORY_CONTENT_LIMIT`）
- 合并相邻同角色，再砍掉开头的 assistant
- 产出一个 `{ role, content }[]` 的纯文本列表

也就是说：**第二轮对话时，agent 不知道自己第一轮调过什么工具、看到过什么返回值、想过什么。**
它只看到一句被截断到 600 字的自我汇报。

用户说「刚才那页的标题再大一点」——「刚才那页」是哪页，agent 得从零 `getDeck` 猜。
用户说「按你刚才说的第二个方案做」—— 第二个方案是什么，600 字截断里没有。

### 2.3 为什么现在没爆

因为有两个绕法兜着，而**这两个绕法都会被这次改动打掉**：

- **deck 本身是外部状态容器。** 11 号文档 §二① 记过这条：「要接着做的信息全在 deck 里」。
  但它只兜得住「做到哪一步了」，兜不住「你上一轮为什么这么排」和「你说的第二个方案」。
- **续作不传 history**（`pipeline.ts:416`）—— 每轮从干净上下文起步。
  一问一答之后 history 就是真的历史，清零重来等于把对话删了。

---

## 三 · 思考中用工具：SDK 层已经通了，配置层没通

「思考中可以使用工具」的机制，就是**把上一步的 thinking block 原样带进下一步的 prompt**。
Claude Code 那段注释（`query.ts:151-163`）写得最清楚：

> Thinking blocks must be preserved for the duration of an assistant trajectory
> (a single turn, or if that turn includes a `tool_use` block then also its subsequent
> `tool_result` and the following assistant message).

BitFun 在消息模型上就显式建了这两个字段（`core/message.rs:51,63`）：
`reasoning_content` +「Anthropic extended thinking signature (**for passing back in multi-turn conversations**)」，
Anthropic 侧的 converter（`providers/anthropic/message_converter.rs:132`）把它们还原成 `thinking` block。

**rabbit 装着的这套依赖已经能做到这件事**（下面三条是读 `server/node_modules` 里实际装着的那份代码确认的，
不是查文档）：

| 位置 | 事实 |
|---|---|
| `ai@4.3.19` `dist/index.mjs:4083` | `toResponseMessages` 把 `reasoning` 放进 assistant message 的 content，`{...part, type:'reasoning'}` **保留 signature** |
| `ai@4.3.19` `dist/index.mjs:6002` | `streamText` 多步循环里 `responseMessages` 逐步累加，下一步的 prompt 带着前面每一步的 reasoning |
| `@ai-sdk/anthropic@1.2.12` `dist/index.mjs:334` | reasoning part → `{type:'thinking', thinking, signature}`；redacted 走 `redacted_thinking` |

**所以单次 `streamText` 调用内部，「思考 → 工具 → 思考 → 工具」现在就能跑。** 缺的是三件事：

### ① 模型那一端默认没开

`runtime/reasoning.ts:72`：anthropic 分支要 `AGENT_ANTHROPIC_THINKING_BUDGET` 环境变量才开，默认关。
google 默认开（`includeThoughts`），deepseek 靠 provider 认 `reasoning_content`。

### ② anthropic 这条路在现役模型上是 400（**新发现，记一笔**）

`@ai-sdk/anthropic@1.2.12` 的 zod schema（`dist/index.mjs:996`）**只认
`thinking: {type:'enabled', budgetTokens}`**。而 Anthropic 侧 Opus 4.7 起
（含 Opus 5 / Sonnet 5 / Fable 5）`budget_tokens` **已被移除，发过去直接 400**，
要用 `{type:'adaptive'}` + `output_config.effort`——这两个参数 SDK v4 发不出来。

也就是说 `reasoning.ts` 那个 anthropic 分支，**对 4.6 之后的模型是打不通的**。
只因为没人配过 anthropic（实际在用的是 deepseek / openai 兼容端点），所以一直没暴露。

顺带纠正一条容易照抄错的东西：Claude Code 里那个
`interleaved-thinking-2025-05-14` beta header（`constants/betas.ts:4`）
**在 4.6+ 上不需要了** —— adaptive thinking 自动带交错思考。别照着抄。

### ③ 跨轮全丢

见 §2.2 —— 思考块不落库。交错思考的收益现在只存在于**单轮内**，
用户一按回车问第二句，agent 就失忆了。

### ④ 一个会咬人的点：signature 绑 API key

Claude Code 的 `stripSignatureBlocks`（`utils/messages.ts:5061`）：

> Their signatures are bound to the API key that generated them; after a credential
> change (e.g. `/login`) they're invalid and the API rejects them with a 400.

rabbit 的模型配置是**管理员随时能改的**（`modelProviders.apiKey` 存在库里）。
换 provider / 换 key 之后，库里存的历史 thinking block 会让下一次请求当场 400。
**所以落库的 thinking block 必须记下是哪个 `modelConfigId` 产的，对不上就剥掉。**

---

## 四 · 方案

### 总体形状

```
现在：
  ws → runDeckTask
        ├ 有选中元素 → runRoleToCompletion('editor')
        └ 否则       → runRole('planner')
                       → runRoleToCompletion('generator')
                       → runRole('reviewer')
                       → [不过] runRoleToCompletion('generator')   ← 3~4 次冷启动

之后：
  ws → runDeckTask
        └ runTurn(messages)        ← 一个 agent、一份 prompt、一份工具全集
                                     输入 = 完整消息历史 + 这一轮用户输入
                                     输出 = 原样追加回同一个历史
```

### A · 消息历史换成完整 content block（**地基，先做**）

**存什么。** `messages` 表加两列，**`content` 列一个字不动** ——
面板渲染、分叉锚点（`forkFrom`）、会话标题都在用它，改它等于同时改三件事：

| 新列 | 作用 |
|---|---|
| `blocksJson TEXT`（可空） | 这条消息的完整 content 数组（AI SDK 的 `CoreMessage['content']`：reasoning / redacted-reasoning / text / tool-call / tool-result） |
| `modelConfigId INTEGER`（可空） | thinking signature 绑 key，换配置时据此剥（§3④） |

两列都可空 —— 老数据没有，读回来时退回现在的文本路径，不需要回填迁移。

**读回来。** `toHistoryTurns` 换成 `toModelMessages(rows, currentModelConfigId)`：

1. 有 `blocksJson` 且 `modelConfigId` 与本次一致 → 原样还原
2. `modelConfigId` 对不上 → 还原，但**剥掉 reasoning / redacted-reasoning**（抄 `stripSignatureBlocks`）
3. 没有 `blocksJson`（老数据）→ 走现在这条文本路径
4. **配对补全**：任何 `tool-call` 找不到配对的 `tool-result`，补一条 `isError` 的
   （抄 `yieldMissingToolResultBlocks`，`query.ts:123`）。**缺了下一轮请求直接 400**，这是硬要求

**怎么拿到 blocks。** `streamText` 的 `onStepFinish` 已经在拿 `toolCalls` / `toolResults` 了
（`pipeline.ts:317`），在同一处顺手取 reasoning + text 拼成 block 数组落库，
和现在的工具落库时机一致，改动面最小。

**上下文压缩。** 11 号文档 §二① 点名的隐藏成本，现在必须做了 —— 「续作不传 history」的绕法失效。
**这一版只做最简单的一步**：按 token 预算**从旧往新丢整轮**
（一轮 = 一条 user + 到下一条 user 之前的全部 assistant/tool），丢掉的换成一条摘要行。
**不抄 CC 那条五步流水线**（`applyToolResultBudget → snip → microcompact → context-collapse → autocompact`）——
09 号风险表那条「先只做最简单的一步，验证有效再加」。

### B · 编排换成单轮循环

`runDeckTask` 变成：

```
1. 载 deck / 建通道 / 定位会话              不变
2. 读历史 → CoreMessage[]                   ← A
3. 拼这一轮 user message（选中元素照旧 describeSelection 拼在前面）
4. runTurn(messages)                        ← 一次 streamText，maxSteps 沿用 512
5. 触顶 → 收口（改法见下）
6. 落库 + 收尾                              不变
```

**触顶收口改法。** 现在是「续作 3 轮，每轮不传 history」（`pipeline.ts:417`）。
一问一答之后不能清零，改抄 BitFun（`execution_engine.rs:534`）：触顶时**最后一轮不给工具**，
塞一条提示让它把话说完：

> 本轮已到步数上限。忽略未完成的工作，现在只给用户一个最终回答，
> 不要再调任何工具。总结已完成的部分，明确区分做完的和没做完的。

比「续作 3 轮」既省钱，又不会让用户看到半截。

**同时补上收益递减检测**（CC `query/tokenBudget.ts:45`，10 号文档可迁移清单第 6 条）：
续了 3 次以上且连续两次 token 增量 < 500，判定空转，提前停。

### C · 4 角色合成 1 个

**不是「把四份 prompt 拼起来」**，是：

- `CANVAS_CONTEXT` + `ANIMATION_GUIDE` 原样留 —— 那是域知识，和角色无关
- Generator 的工作顺序 / 硬要求 / 配图段留（它本来就是全集）
- Planner 那份**只留一句进 prompt**：「动手之前先想清楚整份稿子的叙事线和每页版式，
  别一页一页现编」。**计划本身作为思考块产出**，不再是一次独立的模型往返
- Reviewer 那份**降级成收尾要求**：「全部做完跑一次 lintDeck，errors 全修掉，warnings 逐条判断」——
  这句 Generator 的 prompt 里本来就有（`roles.ts:235`）
- Editor 那句「选中元素数据已经在消息里，别再花一轮去查」并进同一份 prompt

**`AgentRole` 类型不删，收窄成 `'deck'`。** 理由：`roleDefaults` / `userRolePreferences`
两张表按 role 分行，删掉这一维等于「一个用户只能配一个模型」，
而第二个域（research）进来时马上要按域配不同模型。这一版只是这个维度只有一个值。

迁移：`role='generator'` 那行改成 `'deck'`，其余三行删掉 ——
generator 是四个里唯一有全工具的，它的模型配置最接近新 agent 需要的。

### D · 思考

- **D1 · 单轮内交错思考**：机制已通（§三），**补一条判据守着**，
  否则 SDK 一升级它会静默破掉，而现在没有任何东西会报错
- **D2 · 跨轮思考**：靠 A 的 `blocksJson` 自动成立
- **D3 · 前端还原**：`src/store/agent.ts` 的 `hydrateLog` 要能还原 reasoning 条目
  （现在 `agent.ts:31` 明说不落库、重开看不到）
- **D4 · anthropic 那条路**：**这一版不修**。升 `@ai-sdk/anthropic` 要连带升 `ai` 到 v5，
  改动面比这整份方案还大，而实际在用的是 deepseek / openai 兼容端点。
  **但要在 `reasoning.ts` 头注释里写清楚「anthropic 分支只对 Opus 4.6 及更早有效」** ——
  把已知不通写下来，比让下一个人花两天查一个 404/400 划算

### E · 交互（**这一版不做**，登记依赖）

一问一答成立之后，BitFun 那套（11 号文档 C 期）才有意义：
`FINISHING` 态 · 派生状态 · 五模式按钮 `send|cancel|split|confirm|retry` · 排队输入。
**A 是它们的前置** —— 排队输入的第二条消息要能接在同一个历史后面。

---

## 五 · 分期、顺序、判据

> **落地记录（2026-08-20）：A / B / C / D 四期全部完成。** 实际分期与原计划有三处出入，
> 记在这里而不是改掉原文 —— 计划错在哪比计划本身有用：
>
> 1. **A 和 B 合成一次做了。** A 的「写入端」（每一步落 `response.messages`）就长在
>    B 要重写的那个循环里，分两次做等于把同一段代码写两遍。
>    可分离的是**纯函数**（`runtime/turnMemory.ts`），它先写、先测、先立负对照。
> 2. **D 提前，而且几乎没花额外的功夫。** 存的是 `response.messages` 原样，
>    思考块本来就在里面 —— 「让思考跨轮活下来」不是一件要单独做的事，
>    而是「存储改成模型视角」的副产品。
> 3. **判据 5（收益递减检测）作废。** 它是给「续作 N 轮」兜底的，而续作整个被
>    收口轮取代了。为一个已经不存在的机制实现一个检测，正是 11 号文档
>    「别为想象中的需求建抽象」那条要防的。
>
> **计划里没写、实测撞出来的一个真 bug**：`routes/conversation.ts` 的分叉
> 只复制了 `content`，不复制 `blocksJson` / `modelConfigId`。分叉出来的会话在面板上
> 看着是全的，agent 那边的历史却退化成纯文本 —— 工具调用和思考全丢，
> **而且没有任何东西会报错**。加列的时候最容易漏的就是这种「另一处也写这张表」。

### 顺序：A → B → C → D（**B 排在 C 前面是刻意的**）

先把编排从「3 次调用」压成「1 次调用」，但**仍然用 generator 那份 prompt 原封不动**。
这样能单独验证「少了 planner / reviewer 之后质量掉没掉」——
掉了就知道是**编排**的锅，不是 prompt 改写的锅。两件事混在一起就查不出来了。

### 判据（机器能判的）

| # | 判据 | 怎么判 | 状态 |
|---|---|---|---|
| 1 | 一轮任务后从库里还原的消息与 `streamText` 的 `response.messages` **逐块相等** | `runtime/__tests__/turnMemory.test.ts` + 端到端实测 | ✅ |
| 2 | 任何 `tool-call` 都有配对的 `tool-result` | 同上（含「缺结果」「孤儿结果」「顺序打乱」三种坏输入 + 一条不变式断言） | ✅ |
| 3 | `modelConfigId` 变化时 reasoning block 被剥掉，**其余块一字不动** | 同上 | ✅ |
| 4 | maxSteps 触顶时最后一轮不给工具 | `pipeline.ts` 的 `toolless` 分支 | ⚠️ 只有代码路径，**还没有判据**（要 mock model 才跑得到 512 步） |
| ~~5~~ | ~~连续两次 token 增量 < 500 时不再续作~~ | — | **作废**：续作机制已被收口轮取代 |
| 6 | 产出过 `lintDeck` 零 error | 端到端实测（见下） | ✅ errors 0 · warnings 0 |
| 7 | 单 agent 的工具配额与合并前的 generator 逐键相等 | `toolGroups.test.ts`（期望的 25 个键独立抄一份，不从新数据反推） | ✅ |
| 8 | 迁移后 `roleDefaults` 恰好一行且 `role='deck'` | 在种好四行旧数据的临时库上跑迁移，再跑一遍验幂等 | ✅ |
| 9a | **同一轮里，第二步的请求带着第一步的思考**（跨工具边界） | `interleavedThinking.test.ts` —— 挂假模型，直接截下发出去的 prompt | ✅ 我们这一侧 |
| 9b | **第二轮的请求带着第一轮的工具调用与结果**（跨轮） | `turnMemory.test.ts` + 端到端两轮实测 | ✅ |
| 9c | 上面那份思考**真的到得了模型** | `reasoningRelay.test.ts`（21 条）+ 端到端截请求体 | ✅ 补了一层回传，见下 |
| 10 | 重开会话能看到上一轮的思考块 | `src/store/__tests__/hydrateLog.test.ts` | ✅ |
| 11 | 现有测试全绿 | `npm test` → 37 文件 1370 条 | ✅ |

**判据 9 是这份方案的核心判据**，它的负对照是先跑出来的：把这组断言挂在旧的
`toHistoryTurns` 上，4 条红 3 条（工具调用、工具返回值、长汇报的结尾各丢一条）。
第 4 条（思考）当时是绿的，**但那是假绿** —— 思考在旧 schema 里根本没有存储位置，
是我把它伪装成一条 assistant 行才「过」的。一条为了变绿而写的断言比没有断言更糟，
它会让人以为这块被守着。

**端到端实测（真模型 deepseek-v4-pro、真库、真工具，跑完即删）**：

```
▶ 第一轮：在第一页加一个矩形，填充色用主色
  history=1 → getDesignTokens · getDeck · addShape → 「已加矩形，主色 #5b9bd5」

▶ 第二轮：刚才那个矩形是什么颜色？
  history=13 → 「#5b9bd5（主色 primary）」        ← 一个工具都没调
```

第二轮那句是整件事的判据：**旧版本答不上来**，因为工具调用在它的历史里根本不存在，
它必须重新 `getDeck` 才知道刚才加了什么。库里的行就是模型消息序列：

```
user → assistant[reasoning + tool-call ×2] → tool[tool-result ×2]
     → assistant[reasoning + tool-call]     → tool[tool-result]
     → assistant[text]
```

> **这段证据最初是错的，记一笔 —— 这是本轮最值得记的一次判据失效。**
>
> 第一次跑出来是 14 行、「8 个调用配 8 个结果」，我当时把它当成通过了。
> 实际上那是重复：`step.response.messages` **是累积的而不是这一步的**
>（SDK 里是 `[...recordedResponse.messages, ...stepMessages]`），
> 每步照单全存 → 第一步的消息被存了 N 次。用户重开会话，
> 3 次工具调用显示成 8 次，才暴露出来。
>
> **要命的是当时那条「调用数 == 结果数」的不变式没抓住它**：
> 整段重复时两边一起翻倍，等式照样成立。
> **一条对某类错误不敏感的判据，和没有判据是一样的** ——
> 而它绿着，反而让人以为这块被守住了。
>
> 现在盯的是「累积」这个性质本身（`interleavedThinking.test.ts`
> 的「落库不许重复」一组，含负对照：照单全存必须比最后一步的全量更长），
> 外加端到端数一次「实时看到几次工具调用 == 库里存了几个 tool-call」。

**合并 prompt 之后又跑了一次（阶段 C）**，同样是真模型、真库、跑完即删：

```
▶ 做一份 4 页的稿子，讲「为什么团队要用设计系统」
  「叙事线：封面抛出问题 → 痛点 → 转变 → 结论收束。风格选 vivid」
  → 建 4 页 · applyLayout · 自己跑 lintDeck · 设转场
  17 次工具调用，137 秒，一个上下文

▶ 第 3 页太满了，精简一下
  5 次工具调用，45 秒        ← 它知道第 3 页是哪页、上面有什么

lintDeck：errors 0 · warnings 0
```

第一句话值得看：**规划的活它自己在同一轮里做完了**（叙事线、风格、每页版式），
不再是一次独立的模型往返。这正是砍掉 Planner 的赌注 —— 赌赢了。

### 判据 9c：思考本来发不回去，补了一层才成立

**这条是专门查出来的，不是撞出来的** —— 而且它差一点就作为「已实现」交付了。

构造一条带 `reasoning` 块的 assistant 消息，截下各家 provider 真正发出去的请求体：

| provider | 原本 | 补了 `reasoningRelay` 之后 |
|---|---|---|
| anthropic | ✅ 在，signature 也在 | 不动（它本来就对，再补一次是错的） |
| deepseek | ❌ 被丢掉 | ✅ |
| openai（及一切 OpenAI 兼容端点） | ❌ 被丢掉 | ✅ |
| google | ❌ 被丢掉 | ⬜ 没做（wire 格式不是这套，要单独写） |

丢在 `@ai-sdk/openai-compatible` 的 assistant 转换分支：它只有 `case "text"`
和 `case "tool-call"` 两支，**没有 `case "reasoning"`**。deepseek 走的就是这个 converter。

**后果不是报错，是模型每一步都在重新推导。** 对照实验里，不回传时第二步的思考
是从工具结果重新算出来的，而不是接着第一步想的 —— 前一步的推理白费。

而且这**不只是质量问题**：DeepSeek 的文档写明，带了 `tools` 的请求在后续所有请求中
必须完整回传 `reasoning_content`，否则 400。这个 400 我复现出来了
（`The reasoning_content in the thinking mode must be passed back to the API.`），
只是当前调用形状下没触发 —— 属于潜伏故障。

**修法：`runtime/reasoningRelay.ts`。** 在 fetch 那一层按 `toolCallId`
把思考补回请求体。选 fetch 是因为**单轮内的多步消息是 SDK 自己拼的**
（`toResponseMessages` → `responseMessages`），我们的代码碰不到那个数组 ——
在 `providerOptions` 上做手脚只覆盖得了「我们自己从库里还原的消息」，
覆盖不了单轮内的第 2、3、4 步，而那正是「思考中调用工具」的主场。

端到端实测（走真实的 `runDeckTask`，在全局 fetch 上蹲点数）：

```
发出 3 次请求，HTTP 4xx/5xx 0 次
带工具调用的 assistant 消息 3 条 → 带上 reasoning_content 的 3 条 ✅
```

**已知没覆盖到的一处，记在案**：一轮的**最终回答**那条 assistant 消息没有工具调用，
也就没有键，跨轮时它那段思考带不回去。刻意接受 —— 最终回答的正文本身就是那段思考的结论，
而为它另造一套按位置匹配的键，会在历史被预算裁剪时错位。

### 规模

A 约 1 轮，B 约 1 轮，C 约 1 轮，D 约 1 轮。**合计四轮上下。**

---

## 六 · 保留意见与风险

### ① 这份方案推翻了 11 号文档 §四，理由要写清楚

11 号文档 §四 写的是「**不要**把剧本换成自由循环」，理由是
「剧本的可预测性正是『把决策挪进代码』在编排层的体现」。

**那个判断在当时是对的，但它把两件事混在一起了**：

- **排版决策**（坐标 / 字号 / 配色 / 动画编排）—— 确实必须留在代码里，这条不变
- **编排决策**（先规划再生成再审查）—— 这是**流程**，不是排版

单轮循环还给模型的只有第二样。`applyLayout` / `shapeCatalog` / `lintDeck` 一行不动，
排版层的自由度**一点没加**。11 号文档 §一 那条红线（「通用化只往 runtime 层加自由度，
不往排版层加自由度」）在这份方案下仍然成立。

### ② 砍掉 Reviewer = 让 agent 自己审自己

这是真实的风险。Reviewer 是唯一一个**用干净上下文看成品**的角色，
而 10 号文档 §2.5 记的 CC 三处死循环防护，本质都是「自己审自己会陷在里面」。

**缓解**：`lintDeck` 是纯几何 + 纯规则的判据，不受上下文污染影响，它承担了 Reviewer 的大部分职责。
真正丢掉的只有两条：「空洞的套话」和「该用图表却排成文字」。

> **已决策（2026-08-20）：这两条丢得起，先丢，后续再优化。**
> 决策者的原话是「可以丢，暂时无所谓，后续有方案去优化」。
> 记在这里是因为本仓库的规矩是记录决策而不是抹掉它 ——
> 半年后如果发现产出开始出现套话和「该画图表却排成列表」，
> 这段就是「什么时候、为什么把这两条放掉」的证据，
> 而不用重新争论一次要不要把 Reviewer 请回来。

**补救方向已经定了：不是把 Reviewer 加回来，是把这两条做进 lintDeck。**
理由很直接 —— **代码检查每次结果一样，再叫一次模型每次结果不一样**，
一个能当验收判据，另一个不能。这也是 11 号文档 §一 那条红线的方向：
决策往代码里挪，不往模型手里还。

### ③ 上下文从「永不累积」变成「必须管」

11 号文档 §二① 已经预告过这条。这一版只做最粗的一步（从旧往新丢整轮），
它一定不够好用 —— 但**做对一步比做错五步强**，等实测撞到再加。

### ④ 风险表

| 风险 | 影响 | 缓解 |
|---|---|---|
| 单 agent 质量掉 | 高 —— 这是整份方案的主要赌注 | 判据 6；且 B 与 C 分开做，能定位是编排还是 prompt |
| 套话 / 该画图表却排成列表 | 中 —— lintDeck 查不出，Reviewer 走了就没人查 | **已接受，先丢**（见 §六②）。真出问题时补进 lintDeck，不请回 Reviewer |
| thinking signature 跨 key 400 | 中高 —— 管理员换一次配置就炸 | 判据 3 + 负对照 |
| `tool-call` 缺配对 400 | 中高 —— 取消 / 崩溃后重开会话必现 | 判据 2 + 负对照 |
| 上下文压缩做得太粗 | 中 —— 长会话会丢关键上下文 | 只丢整轮不丢半轮；丢掉的留摘要行 |
| SDK 升级静默破掉交错思考 | 中 —— 现在完全没有判据守着 | 判据 9 |
| anthropic 分支已知不通 | 低 —— 实际没人在用 | 写进 `reasoning.ts` 头注释，不假装它能跑 |

---

## 七 · 待确认

- [ ] Editor 路径（有选中元素）要不要也走同一个 agent？
      倾向**要** —— 它和 generator 的工具集完全一样，差别只在用户消息里多了一段选中元素数据
- [ ] 历史的 token 预算给多少？（现在 `HISTORY_LIMIT = 24` 条 + 每条 600 字，
      换成 block 之后要按 token 算，不能按条算）
- [ ] 丢掉的整轮换成的「摘要行」由谁生成 —— 代码模板拼，还是叫一次便宜模型？
      倾向**代码模板**（「第 N 轮：用户要求 X，调用了 M 个工具」），叫模型是又一个失败面
- [ ] 单 agent 之后，`AGENT_MAX_STEPS_*` 的四个环境变量怎么收口（保留 `AGENT_MAX_STEPS` 一个够不够）
