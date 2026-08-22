/**
 * deck 域的编排剧本
 *
 * 从 `agent/orchestrator.ts` 整体搬过来（A4b，见 docs/11-agent-roadmap.md）。
 * 搬的理由是分层：这些代码全部是 deck 专属的 —— 剧本、deck 持久化、
 * 会话与消息落库 —— 放在装配层里，`domains/deck/` 反而没有 deck 的编排。
 *
 * 留在装配层的只有两样：**任务注册表实例**（跨域共享）和**占坑 / 注销**。
 * 那是「同一份 deck 同时只跑一个任务」这条并发约束，与域无关。
 *
 * ── R-50：从「四角色直线剧本」换成「一个 agent 的单轮循环」 ──
 * 见 docs/12-single-agent.md。原来这里是
 *   有选中元素 → Editor；否则 Planner → Generator → Reviewer →（不过）Generator 修正
 * 三到四次冷启动，三个角色对同一份 deck 各读一次，prompt cache 一个 token 都命不中。
 *
 * 现在是一次 `runTurn`：输入是**完整的消息历史**，输出原样追加回同一份历史。
 * 这就是「一问一答带上下文」的全部机制，两个参照项目
 * （Claude Code 的 `queryLoop`、BitFun 的 round 循环）收敛到的是同一个形状。
 *
 * **这一版仍然用 generator 那份 prompt，一个字没改。** 刻意的：
 * 先只换编排，才验得出「少了 Planner / Reviewer 之后质量掉没掉」——
 * 和 prompt 改写混在一起就查不出是谁的锅了。合并 prompt 是下一步（阶段 C）。
 *
 * ── 会话为什么留在 deck 域 ──
 * `conversations.deckId` 是指向 `decks` 的硬外键，会话在**表结构层面**就绑死了 deck。
 * 真正解耦要一次数据迁移（加 `workspace_kind`，默认 `'deck'`），
 * 而在第二个域真的需要会话之前，那次迁移是纯粹的风险。
 */

import { streamText, type LanguageModel, type CoreMessage } from 'ai'
import { eq, and, desc } from 'drizzle-orm'
import type { ServerWebSocket } from 'bun'
import type { Slide, SlideTheme } from '@/types/slides'
import { db } from '@server/db'
import { decks, conversations, messages, type AgentRole } from '@server/db/schema'
import type { WsUserData, ServerMessage } from '@server/ws/handler'
// 域 → runtime 是允许的方向（反过来不行，由 runtime/__tests__/boundary.test.ts 守）
import { resolveMaxSteps } from '@server/runtime/budget'
import { makeConversationTitle } from '@server/runtime/history'
import {
  toModelMessages,
  serializeBlocks,
  type ModelMessage,
  type StoredRow,
  type AssistantBlock,
  type ToolResultBlock,
  type UserBlock,
  type LoadedImage,
} from '@server/runtime/turnMemory'
import { fetchImages, collectImageRefs } from '@server/runtime/imageFetch'
import { resolveModelForRole, inspectRoleModel, type ResolvedModel } from '@server/runtime/llm'
import { createReasoningRelay } from '@server/runtime/reasoningRelay'
import { imageCapabilityAvailable, publicAssetBaseUrl } from '@server/runtime/assetConfig'
import { resolveAssetUrl } from '@/utils/assetUrl'
import { createAgentTools, type DeckState } from './tools'
import { createAssetTools, type AssetTools } from './assetTools'
import { createReflectTools, reflectVisualAvailable } from './reflectTool'
import { createOrnamentTools } from './ornamentTool'
import { createAskTool } from './askTool'
import { createPlanTools } from './planTool'
import { validatePlan, type DeckPlan } from './plan'
import { getSystemPrompt, getToolSubset } from './roles'
import { createDeckChannel, type DeckChannel } from './channel'
// 单一真相源在 kernel —— lint ⑨ 拿它当「颜色真的被改过」的参照物（R-60）
import { DEFAULT_THEME } from './kernel'

/** 这个域唯一的 agent */
const AGENT_ROLE: AgentRole = 'deck'
const AGENT_LABEL = 'Agent'

/**
 * 触顶之后的收口提示。**抄 BitFun 的 `FINALIZE_AFTER_MAX_ROUNDS_REMINDER`**
 * （`execution_engine.rs:534`）。
 *
 * 原来的做法是「带着当前进度续作，最多 3 轮，每轮不传 history」。
 * 那个做法有两个前提，这一版都没了：
 *   - 「续作不传 history」靠的是「要接着做的信息全在 deck 里」。
 *     一问一答之后 history 就是真的历史，清零重来等于把对话删了
 *   - 512 步还没做完，绝大多数情况是**陷在重试里**，不是任务真有那么大。
 *     让它再跑 3×512 步只是把钱烧得更久
 *
 * 所以改成：最后跑一轮**不给任何工具**的，把话说完再停。
 * 用户看到的是一个交代得清楚的半成品，而不是一句「达到上限」然后没有下文；
 * 想接着做，再发一句「接着做完」就是新的一轮 —— 而这一轮**看得见上一轮的全部历史**。
 */
const FINALIZE_PROMPT = [
  '本轮已经达到步数上限，不能再调用任何工具了（调了也会失败）。',
  '',
  '现在只做一件事：**给用户一个最终回答**。',
  '- 说清楚已经做完了什么（第几页、用了什么版式）',
  '- 说清楚还差什么、为什么差',
  '- 不要重新规划，也不要说「我将要……」——你已经不能动手了',
  '',
  '用户想接着做的话，会再发一句话，那时你看得到这一轮的全部记录。',
].join('\n')

const send = (ws: ServerWebSocket<WsUserData>, msg: ServerMessage) => {
  ws.send(JSON.stringify(msg))
}

/**
 * 角色循环拿到的下行通道。
 *
 * `runTurn` 对 ws 的用法**只有发消息**一种；换成通道之后它不再知道
 * WebSocket 的存在，取消回收与落库这两件事也就有了唯一的入口。
 *
 * 只取 `emit` / `commit` 两个能力：`drain` / `stats` 是收尾时才用的，
 * 给循环看见只会多出「谁该负责排干」的歧义。
 */
type TaskChannel = Pick<DeckChannel, 'emit' | 'commit'>

interface StepToolCall { toolCallId: string, toolName: string, args: Record<string, unknown> }
interface StepToolResult { toolCallId: string, result: unknown }

const loadDeckState = async (deckId: number, userId: number): Promise<{ deckRow: typeof decks.$inferSelect, state: DeckState } | null> => {
  const row = await db.select().from(decks)
    .where(and(eq(decks.id, deckId), eq(decks.userId, userId)))
    .get()
  if (!row) return null

  const slides: Slide[] = JSON.parse(row.slidesJson)
  const theme: SlideTheme = row.themeJson ? JSON.parse(row.themeJson) : { ...DEFAULT_THEME }

  return {
    deckRow: row,
    state: { slides, theme, version: row.version },
  }
}

const saveDeckState = async (deckId: number, state: DeckState) => {
  await db.update(decks).set({
    slidesJson: JSON.stringify(state.slides),
    themeJson: JSON.stringify(state.theme),
    version: state.version,
    updatedAt: new Date(),
  }).where(eq(decks.id, deckId))
}

const saveMessage = async (
  conversationId: number,
  role: 'user' | 'assistant' | 'system' | 'tool',
  content: string,
  blocksJson?: string,
) => {
  await db.insert(messages).values({ conversationId, role, content, blocksJson })
}

/**
 * R-63：把会话里存的策划稿读回来。
 *
 * 存进去时经过 validatePlan，正常路径不会再验一遍；但库里是外部世界
 * （手改、老版本写入），读回来必须走一次校验拿类型收窄 ——
 * 坏数据当「没有方案」处理，绝不让它把 lint ⑫ 或 setPlan 炸掉。
 */
const parseStoredPlan = (json: string | null | undefined): DeckPlan | null => {
  if (!json) return null
  try {
    const check = validatePlan(JSON.parse(json))
    return check.ok ? check.plan : null
  }
  catch {
    return null
  }
}

/**
 * 落一条**模型消息**。
 *
 * `blocksJson` 存的是模型视角的完整 content 数组，直接来自
 * `streamText` 每一步的 `response.messages` —— 也就是 SDK 内部
 * `toResponseMessages` 的产物，一个字节都不重新拼。
 *
 * **这是判据 1「从库里还原的消息与 `response.messages` 逐块相等」
 * 之所以结构上成立、而不是靠我逐个字段维护的原因。** 自己拼一遍
 * 迟早会和 SDK 的形状漂开，而漂开时没有任何东西会报错。
 *
 * `content` 列仍然只装给人看的那一份（面板渲染、会话标题、分叉锚点都读它），
 * 语义没变。
 */
const saveModelMessage = async (
  conversationId: number,
  msg: CoreMessage,
  modelConfigId: number,
) => {
  if (msg.role !== 'assistant' && msg.role !== 'tool') return
  const raw = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
  const blocks = dropEmptyReasoning(raw as AssistantBlock[])
  if (blocks.length === 0) return

  await db.insert(messages).values({
    conversationId,
    role: msg.role,
    content: humanSummary(msg.role, blocks as AssistantBlock[] | ToolResultBlock[]),
    blocksJson: serializeBlocks(blocks as AssistantBlock[] | ToolResultBlock[]),
    modelConfigId,
  })
}

/**
 * 丢掉**空的思考块**。
 *
 * deepseek 在最后一条消息上会发一个空的 reasoning 分片。实时流那边已经挡了
 * （不转发空增量），但**落库这条路是另一条** —— 上一版只补了前者，
 * 于是实时看着正常、重开会话又冒出一个「思考完成 0 字」的空壳。
 * **两条路都要挡，各挡各的。**
 *
 * 判据是「文本为空 **且** 没有 signature」，不是单看文本：
 * Anthropic 的空文本思考块可能带着 signature（验签用），
 * 那种丢了下一次请求会 400。宁可留一个看不见的块，也不能丢一个验签凭据。
 */
const dropEmptyReasoning = (blocks: AssistantBlock[]): AssistantBlock[] =>
  blocks.filter((b) => {
    if (b.type !== 'reasoning') return true
    const r = b as { text?: string, signature?: string }
    return !!r.text?.trim() || !!r.signature
  })

/**
 * 给人看的那一份。面板重开会话时读的是这一列。
 *
 * 工具调用的**参数在 assistant 消息里，结果在 tool 消息里** ——
 * 它们本来就是两条模型消息，面板要显示成一条就得自己配对（见前端 `hydrateLog`）。
 * 这里各存各的，不在存储层提前合并：合并了就和 `blocksJson` 对不上，
 * 而对得上正是这一版的全部意义。
 */
const humanSummary = (
  role: 'assistant' | 'tool',
  blocks: AssistantBlock[] | ToolResultBlock[],
): string => {
  if (role === 'tool') {
    return JSON.stringify((blocks as ToolResultBlock[]).map(b => ({
      tool: b.toolName,
      result: typeof b.result === 'string' ? b.result : JSON.stringify(b.result),
    })))
  }
  const text = (blocks as AssistantBlock[])
    .filter((b): b is Extract<AssistantBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('')
  if (text) return text
  const calls = (blocks as AssistantBlock[]).filter(b => b.type === 'tool-call')
  return JSON.stringify(calls.map(c => ({
    tool: (c as { toolName: string }).toolName,
    args: (c as { args: unknown }).args,
  })))
}

/**
 * 收尾动作的统一包装：**失败只记日志，绝不向上抛**。
 *
 * 这条是实测撞出来的。任务跑着的时候演示文稿被删掉（另一个标签页、
 * 别的客户端），catch 分支里那句 `saveMessage` 会撞
 * `FOREIGN KEY constraint failed` —— 而它在 **catch 里**，再抛就没人接了：
 * `runAgentTask` 是 fire-and-forget 调的（`ws/handler.ts`），
 * 未捕获的 rejection 直接把**整个后端进程**带走，所有用户的所有任务一起死。
 *
 * **只有收尾动作能这么吞。** 主路径上的写库失败必须往上抛
 * （见 `runtime/commit.ts` ③：吞掉的话工具会回一句 ok，
 * agent 不会重试，那次修改从此谁也不知道丢了）。
 */
const settle = async (what: string, run: () => Promise<unknown>) => {
  try {
    await run()
  }
  catch (err) {
    console.error(`[agent] 收尾动作「${what}」失败（已忽略，不影响任务结果）:`, err)
  }
}

/**
 * 定位本次任务写进哪条会话。
 *
 * 前端带 conversationId → 续那条（记忆也从那条载入）
 * 不带                  → 新开一条，标题取首句输入，记忆为空
 *
 * 带了但对不上（多标签页里被删掉之类）不报错，自动新开一条并把新 id 推回前端 ——
 * 让前端自愈，比甩一个错误让用户手动刷新体面。
 */
const resolveConversation = async (
  userId: number,
  deckId: number,
  conversationId: number | undefined,
  prompt: string,
) => {
  if (conversationId !== undefined) {
    const found = await db.select().from(conversations)
      .where(and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
        eq(conversations.deckId, deckId),
      ))
      .get()
    if (found) return found
    console.warn(`[agent] conversation #${conversationId} 不属于 deck #${deckId}，改为新建`)
  }

  return db.insert(conversations)
    .values({ userId, deckId, title: makeConversationTitle(prompt) })
    .returning()
    .get()
}

const touchConversation = async (conversationId: number) => {
  await db.update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
}

/**
 * 从库里取多少行。
 *
 * 一行现在是**一条模型消息**（不再是「一条给人看的日志」），一轮任务
 * 动辄产生上百条，所以旧的 24 条上限在这个单位下没有意义了。
 *
 * 真正的裁剪由 `toModelMessages` 的字符预算做，而且它**按整轮丢**；
 * 这里的 400 只是别把一条几年的会话整个读进内存的兜底。
 * 取的是最后 400 条，可能从半轮中间切开 —— `dropLeadingNonUser`
 * 和配对修复会把切口处理干净。
 */
const ROW_LIMIT = 400

const loadRows = async (conversationId: number): Promise<StoredRow[]> => {
  const rows = await db.select().from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.id))
    .limit(ROW_LIMIT)
    .all()

  return rows.reverse().map(r => ({
    role: r.role,
    content: r.content,
    blocksJson: r.blocksJson,
    modelConfigId: r.modelConfigId,
  }))
}

/**
 * 连接类故障 —— 和「配置错了」是两回事，给用户看的话术也该不一样。
 *
 * 实测撞到过 `ECONNRESET`（deepseek 在流到一半时把 socket 关了）。
 * 它长得像代码崩了（一大段堆栈），实际上重发一次就好 ——
 * 而且**现在重发是廉价的**：历史都在库里，说一句「接着做」就能续上，
 * 不像以前要从头再来。同样的代码、同样的 prompt 连跑八次零复现，
 * 所以它是网络抖动，不是我们这边的状态问题。
 */
const isConnectionError = (raw: string): boolean =>
  /ECONNRESET|socket connection was closed|ETIMEDOUT|ECONNREFUSED|EPIPE|fetch failed|network|The operation was aborted due to timeout/i
    .test(raw)

/**
 * 给模型调用的异常补上「是哪个 agent、哪个 provider、哪个模型、哪个 baseUrl」。
 *
 * 上游 SDK 对 404 只抛一句 "Not Found"，落到用户界面上完全无从排查。
 */
const withModelContext = async <T>(
  role: AgentRole,
  model: LanguageModel,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run()
  }
  catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    const desc = (model as { __rabbitDescribe?: string }).__rabbitDescribe
      ?? `model="${typeof model === 'string' ? model : model.modelId}"`
    const raw = err instanceof Error ? err.message : String(err)

    // 网络掉线不是配置问题，别让用户去查 baseUrl 和模型名 ——
    // 已经做完的部分都落库了，接着说一句就能续
    if (isConnectionError(raw)) {
      throw new Error(
        `与模型的连接中断了（${raw.split('\n')[0].slice(0, 80)}）。\n`
        + '已经做完的部分都保存下来了 —— 再发一句「接着做」就能从这里续上。',
        { cause: err },
      )
    }

    const hint = /not found|404/i.test(raw)
      ? '\n提示：404 通常是模型名不在该 provider 上，或 baseUrl 少了/多了版本段（如 /v1）。'
      : ''
    throw new Error(`[${role}] 模型调用失败：${raw}\n${desc}${hint}`, { cause: err })
  }
}

/**
 * 把选中元素的完整数据写成一条**本轮附加消息**。
 *
 * 之前只传 id，Editor 必须先 findElements / getSlide 才知道自己在改什么 ——
 * 一次局部微调白白多两轮 LLM 往返。
 *
 * **不落库**：这是选中那一刻的快照，下一轮它就过期了。
 * 存进历史的话，agent 下次会拿着一份旧坐标去「改」一个已经被移动过的元素。
 */
const describeSelection = (state: DeckState, selectedElementIds: string[]): string => {
  const lines: string[] = []
  for (const id of selectedElementIds) {
    const slide = state.slides.find(s => s.elements.some(e => e.id === id))
    const el = slide?.elements.find(e => e.id === id)
    if (!slide || !el) {
      lines.push(`- ${id}：未找到（可能已被删除）`)
      continue
    }
    const index = state.slides.indexOf(slide)
    lines.push(`- 位于第 ${index + 1} 页（slideId=${slide.id}）：\n${JSON.stringify(el, null, 2)}`)
  }
  return `（本轮附加信息，不属于对话历史）用户在画布上选中了以下元素，`
    + `这是它们**此刻**的完整数据，直接用，不必再查：\n${lines.join('\n')}`
}

interface TurnInput {
  userId: number
  conversationId: number
  state: DeckState
  channel: TaskChannel
  signal: AbortSignal
  assetTools: AssetTools | null
  /** 这一轮要不要给视觉复核那一档（几何测量那一档永远给） */
  visual: boolean
  /** 本轮附加、不落库的消息（选中元素快照 / 收口提示） */
  extra?: string
  /** 收口轮：不给任何工具，只让它把话说完 */
  toolless?: boolean
  /** R-63：本任务开始时的策划稿（从会话读，可能为 null） */
  initialPlan: DeckPlan | null
  /**
   * R-68 · 历史里的 `asset://` 图片怎么解析成可取的 URL。
   *
   * 由 `runDeckTask` 建好传进来（根地址是一次库读，不该每轮重来）。
   * 对象存储没配时为 undefined —— 那时历史里也不会有图。
   */
  resolveAssetUrl?: (src: string) => string
}

interface TurnResult {
  text: string
  state: DeckState
  truncated: boolean
}

/**
 * 跑一轮。
 *
 * 输入是**库里的完整历史**（含刚存进去的这句用户输入），
 * 输出的每一条模型消息原样追加回同一份历史 —— 下一轮它们就是上下文。
 */
const runTurn = async ({
  userId, conversationId, state, channel, signal, assetTools, visual, extra, toolless, initialPlan,
  resolveAssetUrl,
}: TurnInput): Promise<TurnResult> => {
  channel.emit({ type: 'agent.status', status: 'thinking', message: `${AGENT_LABEL} 正在思考...` })

  /**
   * 思考回传器，**一轮一个**。
   *
   * 「思考中调用工具」在 OpenAI wire 格式的 provider 上全靠它：
   * `@ai-sdk/openai-compatible` 的 converter 会把思考块丢掉，
   * 模型于是每一步都在重新推导。它在 fetch 那一层按 toolCallId 把思考补回去。
   * 理由和实测见 `runtime/reasoningRelay.ts` 的头注释。
   *
   * 不做成全局的：键是 toolCallId，跨任务共用一张表只会无限长，
   * 而一轮之内的那几十条正好够用。
   */
  const relay = createReasoningRelay()

  let resolved: ResolvedModel
  try {
    resolved = await resolveModelForRole(AGENT_ROLE, userId, relay)
    const { model: m } = resolved
    console.log(`[agent] model resolved: ${typeof m === 'string' ? m : m.modelId} (config #${resolved.configId})`)
  }
  catch (err) {
    console.error('[agent] model resolution failed:', err instanceof Error ? err.message : err)
    throw err
  }

  // 历史必须在拿到 configId **之后**读 —— 剥不剥思考块取决于它是不是同一个配置
  const rows = await loadRows(conversationId)

  /**
   * R-68 · 把历史里那些图的字节取回来。
   *
   * **必须内联给模型**，不能只给 URL：给 URL 等于要求 provider 自己去下载，
   * 中转站往往取不到（实测报 "Unable to download content from the provided
   * URL before the timeout"）。取不到的图会被跳过，不影响这一轮别的内容。
   */
  const imageRefs = resolveAssetUrl ? collectImageRefs(rows.map(r => r.blocksJson)) : []
  let loadImage: ((src: string) => LoadedImage | undefined) | undefined
  if (imageRefs.length && resolveAssetUrl) {
    const { images, failures } = await fetchImages(imageRefs, resolveAssetUrl)
    if (failures.length) {
      console.warn(`[agent] ${failures.length} 张历史图片取不回来，本轮跳过：`, failures)
    }
    console.log(`[agent] 带 ${images.size} 张图进模型`)
    loadImage = (src: string) => images.get(src)
  }

  const history = toModelMessages(rows, {
    modelConfigId: resolved.configId,
    loadImage,
  })
  // 先从还原出来的历史里学一遍 —— 上一轮那些思考也要跟着回传，
  // 否则「接着做完」这种续问又回到从零推导
  relay.learn(history)

  const messagesForModel: ModelMessage[] = extra
    ? [...history, { role: 'user', content: extra }]
    : history

  const accessor = {
    get: () => state,
    set: (newState: DeckState) => {
      state = newState 
    },
    // 每一次成功的 mutation 都在这里落库 + 推画布。合成一次之后
    // 不可能再出现「画布有、库里没有」，刷新即丢
    onChange: () => channel.commit(state),
  }
  // deck 工具和图片工具分开建、在这里合并 —— **`tools.ts` 绝不能 import
  // `assetTools.ts`**：后者经 `db/index.ts` 拉 `bun:sqlite`，
  // 一旦让 tools.ts 依赖它，kernel / toolCommit / toolGroups 那几个测试
  // 会全部在 vitest 里加载失败
  /**
   * 渲染后反思工具**建在这一轮里**，不是整份任务建一次。
   *
   * 因为它要读「此刻的 deck」，而此刻的 deck 只有 `accessor` 知道 ——
   * `state` 在 runTurn 里是个局部绑定，工具每改一次就重新赋值一次。
   * 在 `runDeckTask` 那层建的话，闭包捕获的是**开跑那一刻**的 state，
   * agent 辛苦排完 14 页，量到的却是一份空稿子，而且不会有任何东西报错。
   */
  const reflect = createReflectTools({
    userId,
    getSlides: () => accessor.get().slides,
    emit: msg => channel.emit(msg),
    signal,
  }, { visual })

  /**
   * 装饰层工具和反思工具一样**建在这一轮里** —— 理由逐字相同：
   * 它要读「此刻的 deck」才知道哪些矩形被占了，而那只有 `accessor` 知道。
   * 在 `runDeckTask` 那层建的话，闭包捕获的是开跑那一刻的空稿子，
   * 于是装饰会以为整页都是空的、画得满页都是，**而且不会有任何东西报错**。
   */
  const ornament = createOrnamentTools({
    userId,
    getSlides: () => accessor.get().slides,
    // 三个锚点色从**此刻的主题**取。R-56 之后颜色回到了主题上，
    // 所以这里读 theme 而不是每页的 paletteOverride
    getAnchorColors: () => {
      const t = accessor.get().theme
      // `themeColors` 是数组（第一个是主色）。取「背景 + 主色 + 字色」三个锚点 ——
      // 和 R-55 划的那三个「模型自己定」的锚点是同一组
      return [t?.backgroundColor, t?.themeColors?.[0], t?.fontColor]
        .filter((c): c is string => !!c)
    },
    // R-60: 艺术流派同样从主题取，没写时由工具按页回落质感档位默认
    getArtDirection: () => accessor.get().theme?.artDirection,
    emit: msg => channel.emit(msg),
  })

  // R-61：确认闸门。和反思/装饰层一样建在这一轮里 ——
  // 它只依赖通道和取消信号，不读 deck 状态，但按轮装配让
  // 「取消即作废在等提问」随任务生命周期一起走
  const ask = createAskTool({ emit: msg => channel.emit(msg), signal })

  /**
   * R-63：策划稿。状态是这一轮的局部绑定（和 deck state 同一个道理），
   * 落库走 `save` 回调写回 conversations 行 —— planTool 自己不碰库
   * （见 planTool.ts 头注释）。任务开始时从会话读来的方案就是 `initialPlan`。
   */
  const plan = initialPlan
  const planAccessor = { get: () => plan }
  const planTools = createPlanTools({
    get: () => plan,
    save: async (p) => {
      await db.update(conversations)
        .set({ planJson: JSON.stringify(p) })
        .where(eq(conversations.id, conversationId))
    },
    emit: msg => channel.emit(msg),
  })

  const allTools = {
    ...createAgentTools(accessor, planAccessor), ...(assetTools ?? {}), ...reflect.tools, ...ornament, ...ask, ...planTools,
  }
  const tools = toolless ? undefined : getToolSubset(AGENT_ROLE, allTools, { assets: !!assetTools })
  const system = getSystemPrompt(AGENT_ROLE)
  const maxSteps = toolless ? 1 : resolveMaxSteps(AGENT_ROLE)

  console.log(`[agent] streamText maxSteps=${maxSteps} history=${messagesForModel.length} toolless=${!!toolless}`)

  // 思考块是否处于「打开」状态 —— 只有真收到过 reasoning 才需要在步末发收拢信号。
  // 不开 reasoning 的模型一条都不会发，前端也就不会画出一个空思考块
  let reasoningOpen = false

  /**
   * 已经落库的模型消息条数。
   *
   * **`step.response.messages` 是累积的，不是这一步的** ——
   * SDK 里那行是 `messages: [...recordedResponse.messages, ...stepMessages]`。
   * 照单全存的话，第一步的消息会被存 N 次（N = 总步数），
   * 重开会话时历史里全是重复的工具调用。
   *
   * 这个 bug 上线过一次，而且**当时那条「调用数 == 结果数」的不变式没抓住它** ——
   * 整段重复时两边一起翻倍，等式照样成立。判据对不敏感的错误是看不见的，
   * 现在由 `interleavedThinking.test.ts` 的「不许重复」一组盯着。
   */
  let savedCount = 0

  const { model, providerOptions } = resolved
  const result = await withModelContext(AGENT_ROLE, model, async () => {
    const stream = streamText({
      model,
      // 让模型把思考带回来。哪个 provider 需要什么参数见 reasoning.ts
      providerOptions,
      system,
      messages: messagesForModel as CoreMessage[],
      tools,
      maxSteps,
      abortSignal: signal,
      onStepFinish: async (step) => {
        if (reasoningOpen) {
          channel.emit({ type: 'agent.reasoning.done', role: AGENT_ROLE })
          reasoningOpen = false
        }

        if (step.text) {
          channel.emit({ type: 'agent.text', role: AGENT_ROLE, content: step.text })
        }

        // tools 是 `Partial<DeckTools>`（角色只拿工具子集），SDK 因此把这两个
        // 数组的元素推断成 `never` —— 在这里收窄回可用形状
        const calls = (step.toolCalls ?? []) as unknown as StepToolCall[]
        const results = (step.toolResults ?? []) as unknown as StepToolResult[]

        for (const tc of calls) {
          const hit = results.find(tr => tr.toolCallId === tc.toolCallId)
          channel.emit({
            type: 'agent.tool',
            tool: tc.toolName,
            args: tc.args,
            result: hit === undefined
              ? undefined
              : typeof hit.result === 'string' ? hit.result : JSON.stringify(hit.result, null, 2),
          })
        }

        // 这一步的思考要在**下一步的请求发出去之前**记下来 ——
        // onStepFinish 正好在两次请求之间，是唯一的时机。
        // 这里喂全量没关系：learn 往 Map 里写，重复写是幂等的
        const all = step.response.messages
        relay.learn(all as unknown as { role: string, content: unknown }[])

        // **只落这一步新增的那几条。** all 是累积的，见 savedCount 的说明。
        // 落库失败不能吞（吞了就是「画布有、历史没有」），交给外层的 catch
        for (const m of all.slice(savedCount)) {
          await saveModelMessage(conversationId, m as CoreMessage, resolved.configId)
        }
        savedCount = all.length
      },
    })

    // **必须把流读干**。text / steps / finishReason 都是 promise，但它们只在流
    // 跑完后才 settle —— 光 await 它们不会驱动流，整个 agent 会永久挂起，
    // 表现就是「开始工作」之后再无下文，没有任何报错。
    //
    // 用 for-await 而不是 consumeStream()：后者会把错误**吞掉**再返回，
    // 之后那三个 promise 就再也不 settle 了 —— 换来的是同一种挂起，只是更难查。
    for await (const part of stream.fullStream) {
      if (part.type === 'reasoning') {
        // **空增量直接丢掉。** deepseek 在最后一条消息上会发一个空的 reasoning
        // 分片，转发出去前端就会画出一个「思考完成 0 字」的空壳
        // —— 一个什么都没有的块比没有块更让人以为出了问题
        if (!part.textDelta) continue
        reasoningOpen = true
        channel.emit({ type: 'agent.reasoning', role: AGENT_ROLE, delta: part.textDelta })
      }
      else if (part.type === 'error') throw part.error
    }

    const [text, steps, finishReason] = await Promise.all([
      stream.text, stream.steps, stream.finishReason,
    ])
    return { text, steps, finishReason }
  })

  // 一轮一行，**只为了「这件事到底有没有发生」看得见**。
  // 思考回传坏掉的表现不是报错，是模型悄悄变笨 —— 没有这行日志，
  // 它哪天不工作了没有任何人会发现（`reasoningRelay.ts` 头注释里那条教训）
  console.log(`[agent] 本轮回传了 ${relay.size()} 段思考（0 表示这个 provider 不需要或没生效）`)

  // 步数耗尽是静默的：SDK 直接返回，agent 以为自己做完了。
  // 不提示的话，用户看到的就是「莫名其妙做了一半」
  const truncated = !toolless
    && result.steps.length >= maxSteps
    && result.finishReason === 'tool-calls'

  return { text: result.text, state, truncated }
}

export interface DeckTaskInput {
  ws: ServerWebSocket<WsUserData>
  deckId: number
  prompt: string
  selectedElementIds?: string[]
  conversationId?: number
  /**
   * R-68 · 用户随这句话一起发来的图片，`asset://<sha256>` 引用。
   *
   * 只作为**给模型看的材料**，不进 deck。上限与文法在 `ws/handler.ts` 挡过一道，
   * 这里不再重复校验 —— 那道挡在协议边界，是唯一该管这件事的地方。
   */
  images?: string[]
  /**
   * 取消信号，由装配层从任务注册表拿。
   *
   * 剧本不自己 new AbortController，也不碰注册表：
   * 「同一份 deck 同时只跑一个任务」是**跨域的并发约束**，归 runtime 管；
   * 这里只负责在收到信号时停下来。
   */
  signal: AbortSignal
}

/**
 * deck 域的编排剧本 —— 一次用户输入 = 一轮。
 *
 * 占坑 / 注销由装配层（`agent/orchestrator.ts`）负责，这里进来时已经持有坑位。
 */
export const runDeckTask = async ({
  ws, deckId, prompt, selectedElementIds, conversationId, images, signal,
}: DeckTaskInput) => {
  const { userId } = ws.data

  // 下行通道：取消闸门 + 状态提交。接线本身在 channel.ts（那里测得到），
  // 这里只把两个 IO 端点交给它 —— WebSocket 和库
  const channel = createDeckChannel({
    signal,
    deliver: msg => send(ws, msg),
    persist: next => saveDeckState(deckId, next),
  })

  const loaded = await loadDeckState(deckId, userId)
  if (!loaded) {
    channel.emit({ type: 'error', message: '演示文稿不存在' })
    return
  }

  // 图片工具整份任务只建一次：它要 deckId（票据落库）和通道（发进度叙事）
  const assetTools = await imageCapabilityAvailable()
    ? createAssetTools({ userId, deckId, emit: msg => channel.emit(msg) })
    : null
  if (!assetTools) {
    console.log(`[agent] deck:${deckId} 图片能力未装配（对象存储或取图开关未就绪），本次不给图片工具`)
  }

  /**
   * 视觉复核这一档要不要装配。**整份任务只探一次**（它读库）。
   *
   * 几何测量那一档不需要任何配置，永远装配 —— 所以这里探的只是「要不要额外
   * 叫一个视觉模型看图」，而不是「有没有反思能力」。
   */
  const visual = await reflectVisualAvailable(userId)

  /**
   * R-68 · 历史里 `asset://` 图片的解析器。
   *
   * 根地址读一次库就够了 —— 它是全局配置，一轮任务里不会变。
   * 没配对象存储时为 undefined，那时历史里本来也不会有图。
   *
   * `resolveAssetUrl` 显式传 base，不走 `utils/assetUrl` 的模块级全局：
   * 那个全局只在浏览器里被 `App.vue` 设过，服务端进程里永远是默认值。
   */
  const assetBase = await publicAssetBaseUrl()
  const resolveHistoryAsset = assetBase
    ? (src: string) => resolveAssetUrl(src, assetBase)
    : undefined

  /**
   * R-68 · 带了图但模型读不了图 —— **当场说清楚，不要把请求打到模型**。
   *
   * 打过去的话拿回来的是 provider 的原始报错（往往只是一句 400），
   * 用户看到那句话既不知道是自己的模型选错了，也不知道该去哪改。
   *
   * 前端会在按钮上挡一道（不支持时置灰），这里是那道挡不住时的兜底：
   * 换模型和发消息之间有时间差，前端拿到的能力也可能是旧的。
   */
  if (images?.length) {
    const info = await inspectRoleModel(AGENT_ROLE, userId)
    if (!info.ok || !info.supportsVision) {
      const why = info.ok
        ? '当前模型不支持识图'
        : `当前模型不可用（${info.reason}）`
      channel.emit({
        type: 'agent.status',
        status: 'error',
        message: `${why}。请在设置里换一个勾了「能读图」的模型，或去掉图片再发。`,
      })
      return
    }
  }

  const conv = await resolveConversation(userId, deckId, conversationId, prompt)
  // 前端据此把新建的会话挂进列表，也用来纠正对不上的 conversationId
  channel.emit({ type: 'agent.conversation', id: conv.id, title: conv.title })

  // **先存用户这句，再读历史。** 和旧版相反：旧版的 history 是另一份东西，
  // 当轮 prompt 要单独拼在后面；现在用户这句本来就是历史的最后一条，
  // 分开处理只会制造「存的和送的不一致」
  //
  // R-68：带图时 `content` 列仍写人话（面板、会话标题、分叉锚点都读它，
  // 空着会让标题变成空白），图片走 `blocksJson`
  if (images?.length) {
    const blocks: UserBlock[] = [
      ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
      ...images.map(src => ({ type: 'image' as const, src })),
    ]
    const shown = prompt || `[图片 ${images.length} 张]`
    await saveMessage(conv.id, 'user', shown, serializeBlocks(blocks))
  }
  else {
    await saveMessage(conv.id, 'user', prompt)
  }

  let { state } = loaded

  try {
    const selection = selectedElementIds?.length
      ? describeSelection(state, selectedElementIds)
      : undefined

    let result = await runTurn({
      userId, conversationId: conv.id, state, channel, signal,
      assetTools, visual, extra: selection, initialPlan: parseStoredPlan(conv.planJson),
      resolveAssetUrl: resolveHistoryAsset,
    })
    state = result.state

    // 触顶不是失败，是「这一轮不能再动手了」。跑一轮不给工具的把话说完，
    // 而不是续作 3×512 步 —— 理由见 FINALIZE_PROMPT
    if (result.truncated && !signal.aborted) {
      channel.emit({
        type: 'agent.status',
        status: 'thinking',
        message: `${AGENT_LABEL} 达到步数上限，正在收尾…`,
      })
      result = await runTurn({
        userId, conversationId: conv.id, state: result.state, channel, signal,
        assetTools, visual, extra: FINALIZE_PROMPT, toolless: true,
        initialPlan: parseStoredPlan(conv.planJson),
        resolveAssetUrl: resolveHistoryAsset,
      })
      state = result.state
      channel.emit({
        type: 'agent.text',
        role: AGENT_ROLE,
        content: '⚠ 本轮达到步数上限，已按当前进度收尾。再发一句「接着做完」可以继续。',
      })
    }

    // 收尾再提交一次。绝大多数时候这和最后一次 mutation 提交的内容相同，
    // 但 state 是从返回值接回来的，最后统一提交一次才敢说
    // 「剧本返回时库里就是最终态」—— 而且它和中途每一次走的是同一条路径
    await channel.commit(state)
    channel.emit({ type: 'agent.status', status: 'done', message: '任务完成' })
  }
  catch (err) {
    console.error('[agent] task failed:', err)
    if (signal.aborted) {
      // 取消路径下这条发不出去（闸门会回收它），前端的取消回执由
      // ws/handler.ts 当场回过了。留着是为了非取消的失败路径共用同一段代码
      channel.emit({ type: 'agent.status', status: 'error', message: '任务已取消' })
    }
    else {
      const msg = err instanceof Error ? err.message : '未知错误'
      channel.emit({ type: 'agent.status', status: 'error', message: msg })
    }
    // 已经在处理一个错误了，这里再抛第二个就没人接得住 —— 见 settle
    await settle('落库错误消息', () =>
      saveMessage(conv.id, 'system', `错误: ${err instanceof Error ? err.message : '未知错误'}`))
  }
  finally {
    // 排队中的提交必须全部落地才算收尾 —— 否则「任务结束了」和
    // 「库里是最终态」之间还留着一个窗口，而那正是这一轮要关掉的东西
    await settle('排干在途提交', () => channel.drain())

    // 无论成败都刷新时间戳，会话列表按「最近活动」排序才准
    await settle('刷新会话时间戳', () => touchConversation(conv.id))

    const { delivered, reclaimed, committed } = channel.stats()
    if (reclaimed > 0) {
      console.log(`[agent] deck:${deckId} 取消后回收在途事件 ${reclaimed} 条（已投递 ${delivered} 条，落库 ${committed} 次）`)
    }
  }
}
