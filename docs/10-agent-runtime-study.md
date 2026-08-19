# 10 · 成熟 agent runtime 研究：BitFun 与 Claude Code

两个已经在真实产品里跑的 agent 系统，读它们的 **runtime** 和 **交互规则**。

目的不是抄代码，是看「同一个问题，两家各自收敛到了什么形状」——
**两家在同一处做同样的选择，那多半是问题本身的形状；两家分歧的地方，才是需要我们自己判断的。**

调研时间：2026-08-19。两个仓库都浅克隆在 `refs/`（`.gitignore` 里，不入库）。

## 零 · 先说可信度，这决定每一条结论能不能拿来用

| | 仓库 | 来源 | 可信度 |
|---|---|---|---|
| **BitFun** | [GCWing/BitFun](https://github.com/GCWing/BitFun) `405c1c7` | MIT，**正经开源仓库** | 高 —— 是作者自己写的源码 |
| **Claude Code** | [Haleclipse/ClaudeCodeRev](https://github.com/Haleclipse/ClaudeCodeRev) `ffe4eab` | **无任何授权声明**，从 npm 包 sourcemap 还原 | 分两级，见下 |

ClaudeCodeRev 是 `@anthropic-ai/claude-code@2.1.88` 的还原产物，**内部并不同质**：

- **1902 个文件从 `cli.js.map` 的 `sourcesContent` 抽出** —— sourcemap 是无损的，这批是真源码
- **146 个是 `gen-stubs.ts` 按 import 分析自动生成的 stub**，文件头标着 `@generated-stub`，
  **里面的类型是推断的，不是真的**
- 4 个分类器 prompt 是「从调用处推断」的，同样不可信

> **实测踩到过一次**：`src/query/transitions.ts` 是 stub，把 `Continue` 推断成 `{ type: 'continue' }`。
> 而真实代码里每个 continue 点写的都是 `transition: { reason: 'token_budget_continuation' }` ——
> 它明显带 `reason` 字段。**差一点就把推断出来的类型当成人家的设计写进结论。**
>
> 读之前先 `grep -l '@generated-stub'`。这条和仓库那句「不猜，跑出来看」是同一件事：
> **先确认哪些是观测、哪些是推断。**

本文引用的 CC 代码路径，都已确认**不是** stub：`query.ts` · `QueryEngine.ts` ·
`query/tokenBudget.ts` · `query/stopHooks.ts` · `query/config.ts` · `coordinator/coordinatorMode.ts`。

**授权提示**：ClaudeCodeRev 无 license 字段 = 默认保留全部权利，原件是闭源商业软件。
本文记录的是**设计判断**，不是代码。不要把它的代码搬进 `server/`，那比 AGPL 更难拆
（AGPL 至少在条件下授予权利，这个一条都没授，且没有 `NOTICE` 可以声明归属）。

---

## 一 · BitFun：为「多个观众同时在看」而设计

Rust workspace（46 crate、1714 个 `.rs`）+ React 前端（2270 个 `.ts/.tsx`）。
桌面 / CLI / 手机 web / IM Bot / peer 设备五种形态**同时**连同一个会话。

### 1.1 决策层与执行层是两个 crate，边界由 CI 守

`src/crates/execution/agent-runtime`（4.2 万行）只放**可移植的决策与事实**，
禁止依赖 `bitfun-core`、Tauri、具体 service。它的 `AGENTS.md` 用一整段逐项列举归属：

> 归这里：queue policy、cancellation routing、confirmation gate/wait-channel、
> user-question 契约、scheduled-job 状态转移、prompt-cache policy…
> 留在 core：具体 scheduler 执行、session 元数据 IO、event emitter 接线、
> 权限 UI 呈现、具体 tool 执行。

**这就是我们 `kernel.ts` 的纪律，做到了 crate 边界级别，并且用 `pnpm run check:core-boundaries` 机器守着。**
我们的边界只存在于「纯函数」这个约定和单测里，没有任何东西阻止有人往 kernel 里 import 一个 db 客户端。

> 现成的答案：`kernel.ts` 顶到 `max-lines: 1500` 要拆时，
> **按「决策 vs 执行」拆，不按「功能」拆。**

### 1.2 阻塞式提问：`user_questions.rs`

四个机制，每个都在解决一个具体的失败：

**① 待答提问是进程内活状态，不进会话历史**

```rust
/// This is process-local live state, not persisted Session history. Product
/// surfaces use it to re-attach after an event gap without restarting or
/// cancelling the Dialog Turn that is waiting for the answer.
```

**② drop guard 把提问的寿命绑在等待它的 tool future 上**（`:113-142`）

```rust
/// Cancelling a Dialog Turn drops the future and therefore removes the
/// request instead of leaving an unanswerable stale interaction behind.
#[must_use = "keep the registration alive while awaiting the user response"]
pub struct UserInputRegistration { … }
```

取消任务 → future 被 drop → 提问自动消失。**没有任何一处代码需要记得清理它。**
drop 时还比对 `registration_sequence`，只删属于自己那次注册的条目 ——
防的是同一 `tool_id` 被重新注册后旧 guard 误删新提问（ABA）。

**③ 邮箱带单调 `revision`，可按 session 拉快照重连补齐**（`pending_question_snapshot`）。
权限那边同款，还多一个 `snapshot_barrier: Arc<StdRwLock<()>>`，
保证快照读不到「批量注册做了一半」的中间态。

**④ 传输层不支持就不注册这个工具**（`ask_user_question_available_in_context`）。
对应仓库级铁律：

> 阻塞式交互必须可以远程应答……**只能靠桌面窗口解除的阻塞会让远程控制和 Dispatch 任务死锁。**

### 1.3 权限闸门是纯函数，两个反直觉设计

`permission.rs:52`：`plan_permission_intents(intents, policy, grants, case_sensitivity)`
→ `Allowed | Denied(intent) | RequiresApproval(vec)`。

- **一条 deny 短路整批**，需批准的保持输入顺序 → 请求构造确定性，可测
- **`bash` 走不对称匹配**（`:85-106`）：allow 规则要求**资源精确相等**，ask / deny 规则允许通配。
  **放行必须窄，拦截可以宽。**
- **`requiresFreshApproval`**（`:150-156`）：单次意图可声明「即使记住过也要重新问」，凌驾已存 grant

### 1.4 事件队列：取消时回收在途分片

`event_queue.rs`（1162 行）。优先级队列 Critical > High > Normal > Low，批量 10
（注释：「降到 10 是为了降延迟」）。三个机制：

- **`execution_generation`** —— turn 带世代号，陈旧的 interrupt / recover 事件按世代丢弃
- **`is_reclaimable_stream_data`**（`:181-202`）—— 收到某 turn 的 `DialogTurnInterrupted` 后，
  队列里**该 turn 尚未投递的 `TextChunk` / `ThinkingChunk` 直接扔掉**
- **`LegacyDequeueAck`** —— fence，某事件必须先进入投递流，生产者才能发依赖它的后续事件

### 1.5 会话状态机：4 个状态，子阶段不进状态

`src/web-ui/src/flow_chat/state-machine/`：

```
IDLE · PROCESSING · FINISHING · ERROR
```

子阶段（starting / compacting / thinking / streaming / finalizing / tool_calling / tool_confirming）
放在 `context.processingPhase`，**明确声明「不影响主状态逻辑」**，只喂 UI 细节。
这是防状态机爆炸的关键克制。

**`FINISHING` 是大多数实现漏掉的那个**：后端已报完成，前端还在排干迟到的事件。两条边值得看：

```ts
// Cancellation logic: USER_CANCEL enters FINISHING until the backend confirms
// the old execution has settled, so queued input cannot race tail writes.
PROCESSING: { USER_CANCEL: FINISHING, … }
FINISHING:  { USER_CANCEL_FAILED: PROCESSING, … }
```

取消**不是**立刻回 IDLE —— 否则用户排队的下一条输入会和上一轮的收尾写入抢跑。
`USER_CANCEL_FAILED` 退回 PROCESSING：**取消没成功就不要骗用户说停了。**

> **两处值得记的观察**
>
> 1. `types.ts:15-19` 的注释仍写着「用户点取消 → 立刻切 IDLE……无需等待后端」，
>    和现在的转移表矛盾 —— 老设计被竞态推翻后注释没跟上。
>    **连这种工程纪律的项目也会有文档漂移。**
> 2. Rust 侧的 `session_state.rs` 只有 `Idle / Processing / Error` 三态，**没有 `Finishing`**。
>    后端知道自己什么时候完事，不需要它；`FINISHING` 是**纯前端概念**，
>    存在只为给 UI 一个排干迟到事件的地方。**不要把它加进后端协议。**

### 1.6 UI 不读状态机，读一个派生对象

`derivedState.ts` 的 `deriveSessionState()` 把状态机压成 `SessionDerivedState`。
最值得抄的是**一个按钮五种模式**：

```ts
sendButtonMode: 'send' | 'cancel' | 'split' | 'confirm' | 'retry'
```

| 情况 | 模式 |
|---|---|
| 跑着 + 用户没打字 | `cancel` |
| 跑着 + 用户打了字 | `split`（既能取消也能排队追加） |
| 有待确认工具 | `confirm` |
| 报错 | `retry`；报错且有草稿 → `split` |

**`queuedInput` 是一等公民**：agent 在跑时输入框永不禁用（`isInputDisabled: false` 写死），
内容排队。它把「用户想插话」和「用户想打断」区分成了两个动作。

### 1.7 TurnOwnership：并发问题的解法不是锁

`session-stream/turnOwnership.ts`，112 行：

> 执行中的 Turn 归 runtime 流所有，已落定的 Turn 归持久化记录所有，
> **所有权在终止事件上恰好转移一次**。
> 这就是历史和实时事件能共用一份投影而不打架的原因：
> **它们对同一个 Turn 永远不会同时权威，所以没有任何东西需要调和。**

```ts
persistedMayWrite(turnId) { return !this.executing.has(turnId) }  // 挡迟到的 checkpoint 把进行中的 turn 画成「已中断的历史」
runtimeMayWrite(turnId)   { return !this.settled.has(turnId) }    // 挡终止后迟到的实时事件
```

还有一句点破要害：

> **刻意不从投影推导**：问「这个 Turn 在屏幕上看起来完成了吗」正是这个契约要消除的那种检查。
> 所有权由有序事件本身决定。

### 1.8 交互规则的写法本身值得抄

`flow_chat/components/modern/AGENTS.md` 开宗明义：

> **It is the rules.** The reasoning, the measurements, and the failures each rule
> was written against live in the documents below.

结尾定义什么配进这份文件：

> **一条规则属于这里，当且仅当评审者读 diff 就能抓到它的违反**；
> 其余的 —— 理由、数字、它是为哪次翻车写的 —— 属于那份长文档。

规则本身几乎每条都能看出背后那次事故：

- 「保留的尾部留白必须只由 `scroller.clientHeight` 算出。**静态预留可以，反应式补偿不行** ——
  不许从测得的内容高度、折叠差值、动画时长或流式速率推导。」
- 「`.virtual-item-wrapper` 里不许有挂载动画……行是在进入渲染窗口时挂载的，不是内容到达时。
  **要在 wrapper 上取消，不要在组件里改 —— 这个已经在局部被打过四次补丁，每次都复发。**」
- 「一次用户动作只落位一次。先导航到 Turn 再瞄准其中某项，必须在同一个 task 里做完 ——
  隔几帧的两次落位，读者看到的是两次移动。」

还有一条可观测性设计，和我们「负对照」是同一个道理：

> 所有对 `scrollTop` 的写入必须经过登记处（`useFlowChatViewportOwner`），带 owner 名和优先级。
> **一个「拒绝」移动视口的写者也要说出来** —— 登记处记录发生了的写入；
> **没发生的写入在别处完全不可见，而「什么都没发生」才是更常见的报障。**

---

## 二 · Claude Code：为「一个调用方读一条流」而设计

### 2.1 循环形状：一个扁平的 `while(true)` 生成器

`src/query.ts:241` 的 `queryLoop` 是 `AsyncGenerator<…, Terminal>`。
整个 agent loop 就是**一个函数里的一个 while 循环**，1729 行，无递归、无状态机类、无事件总线。

出口 `Terminal { reason }`：`completed` · `stop_hook_prevented` · `hook_stopped` ·
`aborted_tools` · `max_turns`。

### 2.2 `State` record：让「忘了重置标志」变成不可能

跨轮状态收在一个 9 字段的 `State` 里（`:204-217`），循环体开头解构，然后：

```ts
// Continue sites write `state = { ... }` instead of 9 separate assignments.
```

**每个 continue 点必须写全 9 个字段**，于是「这一轮要不要重置 `hasAttemptedReactiveCompact`」
变成一个无法遗漏的显式决策。这个手法救下来的 bug 就在同一个文件里（见 2.5 ②）。

每个 continue 点还带 `transition: { reason }`，注释写明用途：

> Why the previous iteration continued.
> **Lets tests assert recovery paths fired without inspecting message contents.**

—— 为了可测试性而记录「为什么继续」。

### 2.3 跑不完怎么办：token 预算 + 收益递减

`query/tokenBudget.ts:45`：

```ts
const isDiminishing =
  tracker.continuationCount >= 3 &&
  deltaSinceLastCheck < DIMINISHING_THRESHOLD &&   // 500
  tracker.lastDeltaTokens < DIMINISHING_THRESHOLD

if (!isDiminishing && turnTokens < budget * COMPLETION_THRESHOLD) { … continue }  // 0.9
```

**它不只问「预算用完没」，还问「还在产出吗」** —— 续了 3 次以上、
且连续两次 token 增量都不到 500，判定收益递减，提前停。

续作方式是**注入一条 `isMeta: true` 的 nudge 用户消息**，继续同一个循环。
`agentId` 存在（即子 agent）则完全不给预算续作。

`maxTurns` 是**入参不是常数**（`QueryParams.maxTurns`），触顶时 yield 一条
`max_turns_reached` 附件消息再返回。

### 2.4 上下文压缩是一条有序流水线，顺序本身是契约

```
applyToolResultBudget → snip → microcompact → context-collapse → autocompact
```

每一步的次序都有注释解释为什么不能换：

> Enforce per-message budget on aggregate tool result size. **Runs BEFORE microcompact** ——
> cached MC operates purely by `tool_use_id` (never inspects content), so content
> replacement is invisible to it and the two compose cleanly.

> Apply snip before microcompact (**both may run — they are not mutually exclusive**).
> `snipTokensFreed` is plumbed to autocompact so its threshold check reflects what snip removed.

### 2.5 三处死循环防护，每处都是事故留下的疤

**① stop hook 遇到 API 错误直接跳过**（`:1258`）

> The model never produced a real response — hooks evaluating it create a
> **death spiral: error → hook blocking → retry → error → …**

**② `hasAttemptedReactiveCompact` 在 stop-hook 阻塞续作时必须保留**（`:1292`）

> Resetting to false here caused an **infinite loop: compact → still too long → error →
> stop hook blocking → compact → … burning thousands of API calls.**

注意它在 `next_turn` 那个 continue 点是 `false`（正常推进要重置），只在这一条路径保留 ——
**这正是 2.2 那个「9 个字段必须写全」手法防的 bug 类型。**

**③ `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`**，且中间态错误对 SDK 调用方**扣住不发**（`:166-174`）

> Yielding early leaks an intermediate error to SDK callers that
> **terminate the session on any `error` field** —— the recovery loop keeps running
> but nobody is listening.

### 2.6 中断：每个 `tool_use` 都必须配一个 `tool_result`

`yieldMissingToolResultBlocks`（`:123`）在中断时给每个未完成的 tool_use 补一条
`is_error: true` 的 tool_result。这是 Anthropic API 的硬要求 —— 缺了下一轮请求直接 400。

两个细节：

- `signal.reason !== 'interrupt'` 才发中断消息 —— 「用户提交新输入打断」时不发，
  因为紧跟着的那条用户消息本身就说明了上下文
- **中断路径也要检查 `maxTurns`**（`:1506`）—— 否则「中断」会掩盖「其实也到上限了」

### 2.7 没还原出来的部分

`coordinator/workerAgent.ts` 是 stub（3 行），`assistant/` 5 个文件里 4 个是 stub。
**CC 的多 agent 协作那一半基本没还原出来** —— `coordinatorMode.ts` 只能看到工具白名单和
env gate（`CLAUDE_CODE_COORDINATOR_MODE` + statsig `tengu_scratch`）。

要学多角色编排，**BitFun 的 `custom_subagent.rs` / `subagent_task.rs` / `agents.rs` 是完整的，这边不是。**

---

## 三 · 两家的分歧，以及我们该站哪边

| | Claude Code | BitFun |
|---|---|---|
| loop 载体 | 进程内 async generator | port-backed 决策层 + core 执行层，跨 crate |
| 状态 | 函数局部 `State` record | 状态机 + 事件日志 + 持久化投影 |
| 观众 | **一个**（CLI / SDK） | **N 个**，各自处于不同重连状态 |
| 中断 | `AbortController.signal` | 事件世代号 + 队列回收 + 所有权转移 |
| 提问 | `canUseTool` 回调，同步等 | 注册表 + revision 快照 + drop guard |

**分歧的根源是「有几个观众」。**
CC 假设只有一个调用方在读这条流，abort 一置位、生成器一返回就干净了。
BitFun 假设随时有 N 个客户端在不同重连状态上看同一个会话，
所以必须把「谁现在权威」「哪些事件已陈旧」显式建模。

> **rabbit 在这条轴上更靠近 BitFun**：我们有 WebSocket、有指数退避的无限重连、
> 有前端画布这个第二权威、还有多会话切换。
> **两家做法冲突时，照 BitFun 那边抄。**

反过来，**单循环内部的纪律照 CC 抄** —— `State` record 写全字段、
`transition.reason`、收益递减、死循环防护，这些和观众数量无关。

---

## 四 · 可迁移清单

按「rabbit 现在缺什么」排，不按原项目的重要性排。
落地计划见 [11-agent-roadmap.md](./11-agent-roadmap.md)。

| # | 拿什么 | 出处 | 治 rabbit 的什么 |
|---|---|---|---|
| 1 | **单一权威写者**（TurnOwnership） | BitFun `turnOwnership.ts` | 「agent 跑时用户手改画布被全量 `agent.deck` 覆盖」—— 真实改动丢失 |
| 2 | ✅ **取消回收在途事件**（世代号未做） | BitFun `event_queue.rs` | `cancelAgentTask` 只 `abort()`，在途 `agent.text` / `agent.tool` 照发。**已落地**（`runtime/cancellation.ts`）。世代号刻意没抄：BitFun 需要它是因为事件在优先级队列里可能延迟出队，我们的 send 在调用点同步发。唯一会让它变必要的路径是 `cancelAllMatching`，目前零调用方 |
| 3 | **提问注册表 + revision 快照 + drop guard** | BitFun `user_questions.rs` | `ws/handler.ts` 的 `agent.confirm` 空分支；且我们无限重连，pending 提问必丢 |
| 4 | **`FINISHING` 态 + 派生状态 + 五模式按钮 + 排队输入** | BitFun state-machine | agent 跑时用户只能干等；「插话」和「打断」现在是同一个动作 |
| 5 | **权限闸门（纯函数 + 不对称匹配）** | BitFun `permission.rs` | 通用化之后必须有 —— 域内路线下不需要 |
| 6 | **收益递减检测** | CC `tokenBudget.ts:59` | 现在硬跑满 3 轮续作，空转也跑 |
| 7 | **`State` 写全字段 + `transition.reason`** | CC `query.ts:204,1302` | 续作时哪些标志该重置是隐式的；测试只能靠翻消息内容判断走没走某条路 |
| 8 | **上下文压缩流水线** | CC `query.ts:369-430` | 通用化之后「续作不传 history」的绕法失效 —— 见 11 号文档 |
| 9 | **规则 / 理由分离的文档结构** | BitFun `modern/AGENTS.md` | 我们的规则散在 `04-changes.md` 的叙述里，评审 diff 时抓不到违反 |

---

## 五 · 判断错过的地方

**① 差点把 stub 当真源码。**
`query/transitions.ts` 的 `Continue` 类型是自动生成的推断值，我读到它时没有先查文件头。
是后面读到真实 continue 点写着 `transition: { reason: … }` 才发现对不上。
**对着一个「还原出来的」仓库，第一件事应该是分清哪些是观测哪些是推断**，
而不是读到矛盾了才回头查。

**② 先用 grep 啃了半天才被提醒有 LSP。**
更糟的是 LSP 实测两个都不能直接用：插件只是接线壳子，
`rust-analyzer` / `typescript-language-server` 二进制都要另装。
装完 rust-analyzer 之后实测：`documentSymbol` 可用，
`workspaceSymbol` / `findReferences` 全空 —— 因为没有 cargo，建不出 crate 图，
它退到了 detached-file 模式。**「装了插件」和「LSP 能用」之间隔着两层。**

**③ 一开始按「读代码」的方式读 BitFun，收益远低于读它的 `AGENTS.md`。**
那个仓库把设计判断写在离代码最近的指南里，
`flow_chat/components/modern/AGENTS.md` 217 行的信息量超过我读的任何 2000 行实现。
**成熟仓库里，最该先读的是它写给「改这块代码的人」的那份文件。**
