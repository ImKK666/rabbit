/**
 * 一问一答的记忆层 —— 库里的一行 ↔ 模型看到的一条消息
 *
 * 纯函数，不 import `ai` 也不碰库，理由和 `reasoning.ts` / `history.ts` 一样：
 * 它得能在 vitest 里裸跑（`db/index.ts` 会拉 `bun:sqlite`，测试环境加载不了）。
 * 类型是照 AI SDK v4 的 `CoreMessage` 手抄的等价形状 —— 抄错了会在
 * `pipeline.ts` 那个赋值点编译报错，那里是唯一的对账处。
 *
 * ## 存储契约：一行 = 一条模型消息
 *
 * 这是这一版最重要的一个决定。`messages` 表原来一行装的是
 * 「一条给人看的日志」（`[Generator] 汇报` / 一次工具调用的 JSON），
 * 现在改成**一行装一条模型消息**，顺序就是 `streamText` 吐出来的
 * `response.messages` 的顺序：
 *
 *   user  → assistant[reasoning, text, tool-call…] → tool[tool-result…] → assistant[…] → …
 *
 * 为什么值得这么改：判据 1 要求「从库里还原的消息与 `response.messages`
 * **逐块相等**」。存储只要不是模型视角，这条判据就永远只能靠人眼比对。
 *
 * **旧行的落库顺序其实是错的**，这一版顺手修掉：`pipeline.ts` 原来在
 * `onStepFinish` 里逐条落 tool 行，而 assistant 汇报要等整个角色跑完才落，
 * 于是库里是 `user, tool, tool, …, assistant` —— 工具结果排在发起调用的
 * assistant **前面**。旧路径把 tool 行整个丢掉了，所以一直没人发现。
 *
 * ## 三条 400 红线（都是 Anthropic 侧的硬要求）
 *
 * 1. **每个 `tool-call` 必须有配对的 `tool-result`**。缺了下一轮请求直接 400。
 *    取消、崩溃、进程被 kill 都会留下这种半截状态，所以配对是**读回来时修**，
 *    不是指望写的时候不出错（`repairToolPairing`）
 * 2. **首条必须是 user**。过滤 / 截断之后开头可能剩下 assistant（`dropLeadingNonUser`）
 * 3. **thinking block 的 signature 绑在生成它的 API key 上**。管理员换一次 provider
 *    或 key，库里的旧 signature 就会被拒。所以每行记下是哪个 `modelConfigId` 产的，
 *    对不上就把思考块剥掉（`stripForeignReasoning`）—— 抄的是 Claude Code 的
 *    `stripSignatureBlocks`
 *
 * ## 刻意没做的事
 *
 * **不合并相邻同角色消息。** 旧的 `toHistoryTurns` 会合并，理由写的是
 * 「Anthropic 要求严格交替」。实测 `@ai-sdk/anthropic` 的
 * `convertToAnthropicMessagesPrompt` 自己有 `groupIntoBlocks`，
 * 相邻同角色它会归并，`tool` 角色也会并进 user 块。
 * 我们再合一次不但多余，还有害：把两条各带思考块的 assistant 拼起来会产生
 * `[reasoning, text, reasoning, text]`，而思考块在 assistant turn 里的位置是有约束的。
 * **能让下游做对的事就别在上游动手。**
 */

/** 模型的思考。`signature` 是 Anthropic 用来验签的，跨 key 会失效 */
export interface ReasoningBlock { type: 'reasoning', text: string, signature?: string }
/** 被 provider 加密的思考。我们看不懂，但必须原样带回去 */
export interface RedactedReasoningBlock { type: 'redacted-reasoning', data: string }
export interface TextBlock { type: 'text', text: string }
export interface ToolCallBlock {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  args: unknown
}
export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  result: unknown
  isError?: boolean
}

export type AssistantBlock =
  | ReasoningBlock | RedactedReasoningBlock | TextBlock | ToolCallBlock

/**
 * R-68 · 用户消息里的一张图，**存的是 `asset://<sha256>` 原串**。
 *
 * 不存真实 URL，理由和 deck 里那些图完全一样（决策 E）：换桶、挂 CDN 之后
 * 所有历史会话跟着走。也不存 base64 —— 那会让 `HISTORY_CHAR_BUDGET`
 * 的字符预算被一张图吃光，而预算存在的意义正是控制带进模型的规模。
 */
export interface StoredImageBlock { type: 'image', src: string }

/** 用户消息落库时的一块 */
export type UserBlock = TextBlock | StoredImageBlock

/**
 * 模型看到的一张图。AI SDK v4 的 image part 收 `URL`，
 * 和 `domains/deck/reflectTool.ts` 里视觉复核用的是同一种形状。
 */
export interface ImagePart { type: 'image', image: URL }

/** 模型看到的用户消息内容块 */
export type UserContentPart = TextBlock | ImagePart

export type ModelMessage =
  | { role: 'user', content: string | UserContentPart[] }
  | { role: 'assistant', content: AssistantBlock[] }
  | { role: 'tool', content: ToolResultBlock[] }

/** 库里的一行。`blocksJson` / `modelConfigId` 为空表示这是这一版之前的老数据 */
export interface StoredRow {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  blocksJson?: string | null
  modelConfigId?: number | null
}

/**
 * 补给失配工具调用的结果文本。
 *
 * 抄 Claude Code 的 `yieldMissingToolResultBlocks`：它在中断时给每个未完成的
 * `tool_use` 补一条 `is_error` 的结果。措辞写成模型看得懂的一句话，
 * 而不是内部错误码 —— 下一轮它读到这个会知道「那一步没做成，要重来」。
 */
export const INTERRUPTED_TOOL_RESULT
  = '这次调用没有返回结果（任务被中断或进程退出）。需要的话重新调一次。'

/**
 * 带进模型的历史规模上限，**按字符算不按 token 算**。
 *
 * 不装 tokenizer 的理由：这份历史里中文正文和 JSON 工具参数混在一起，
 * 中文约 1 字 1 token，JSON 约 4 字 1 token —— 拿任何一个系数去估，
 * 另一半都会错到离谱。字符数是个诚实的粗尺子，**它不假装自己是 token 数**。
 *
 * 120k 字的量级依据：现役模型 1M 上下文，按最坏情况（全中文，1:1）估，
 * 历史占 12% 左右，给 system prompt、当轮输入和 512 步的工具往返留足余量。
 */
export const HISTORY_CHAR_BUDGET = 120_000

/** 老数据单条的截断长度。与 `history.ts` 的 `HISTORY_CONTENT_LIMIT` 保持一致 */
const LEGACY_CONTENT_LIMIT = 600

const isToolCall = (b: AssistantBlock): b is ToolCallBlock => b.type === 'tool-call'
const isReasoning = (b: AssistantBlock): boolean =>
  b.type === 'reasoning' || b.type === 'redacted-reasoning'

/** 一条消息 + 它是哪个模型配置产的（剥思考块要用） */
interface Carried { msg: ModelMessage, modelConfigId: number | null }

/**
 * 把 blocks 序列化成一行 —— 写库那一端用。
 *
 * 单独一个函数而不是让调用方 `JSON.stringify`：将来要加压缩或换格式时，
 * 读写两端会一起改，而它俩现在就在同一个文件里，改漏不了。
 */
export const serializeBlocks = (
  blocks: AssistantBlock[] | ToolResultBlock[] | UserBlock[],
): string => JSON.stringify(blocks)

/**
 * R-68 · 用户消息的 blocks → 模型看到的 content。
 *
 * `resolve` 把 `asset://<hash>` 变成可直接取的 URL。**取不到就把这张图丢掉**，
 * 而不是塞一个坏 URL 进去：坏 URL 会让整轮请求 4xx，丢一张图只是少一张图。
 * 丢弃会在 `toModelMessages` 的调用方留下痕迹吗？不会 —— 所以这条路径
 * 只在「没给 resolver」和「引用坏了」两种情况下走，两种都不该在正常运行时出现。
 *
 * 全是图没有文字时也返回数组（不退化成字符串）—— 只发图让模型描述是合理用法。
 */
const userBlocksToContent = (
  blocks: UserBlock[],
  resolve?: (src: string) => string,
): UserContentPart[] => {
  const parts: UserContentPart[] = []

  for (const b of blocks) {
    if (b.type === 'text') {
      parts.push(b)
      continue
    }
    if (b.type !== 'image' || !resolve) continue

    const url = resolve(b.src)
    if (!url) continue
    try {
      parts.push({ type: 'image', image: new URL(url) })
    }
    catch {
      // resolve 给了个不合法的 URL。同上：丢这一张，别让它炸掉整轮
    }
  }

  return parts
}

/**
 * 库里的一行 → 一条模型消息。返回 null 表示这行不进模型
 * （system 行是错误日志；老的 tool 行没有 toolCallId，带进去必然配不上对 → 400）。
 */
const rowToCarried = (
  row: StoredRow,
  resolveAsset?: (src: string) => string,
): Carried | null => {
  const modelConfigId = row.modelConfigId ?? null

  if (row.blocksJson) {
    const blocks = parseBlocks(row.blocksJson)
    // 脏数据不能炸掉整轮对话，退回按老数据处理
    if (blocks) {
      // R-68：带图的用户消息。没有 blocksJson 的用户行走下面的纯文本路径，
      // 所以老会话完全不受影响
      if (row.role === 'user') {
        const content = userBlocksToContent(blocks as UserBlock[], resolveAsset)
        return content.length > 0
          ? { msg: { role: 'user', content }, modelConfigId }
          // 图全丢了、文字也没有 → 退回 content 列的纯文本，至少还剩一句话
          : { msg: { role: 'user', content: row.content }, modelConfigId }
      }
      if (row.role === 'assistant') {
        return blocks.length > 0
          ? { msg: { role: 'assistant', content: blocks as AssistantBlock[] }, modelConfigId }
          : null
      }
      if (row.role === 'tool') {
        return blocks.length > 0
          ? { msg: { role: 'tool', content: blocks as ToolResultBlock[] }, modelConfigId }
          : null
      }
    }
  }

  // ── 以下是这一版之前的老数据，按原来的语义处理，不改行为 ──
  if (row.role === 'user') {
    return { msg: { role: 'user', content: row.content }, modelConfigId }
  }
  if (row.role === 'assistant') {
    // Planner / Reviewer 是老剧本一轮任务内部的中间过程，对下一轮没有参考价值
    if (row.content.startsWith('[Planner]') || row.content.startsWith('[Reviewer]')) return null
    const text = truncateLegacy(row.content)
    return { msg: { role: 'assistant', content: [{ type: 'text', text }] }, modelConfigId }
  }
  // system（错误日志）和老的 tool 行都不进模型
  return null
}

const parseBlocks = (json: string): unknown[] | null => {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : null
  }
  catch {
    return null
  }
}

const truncateLegacy = (content: string): string =>
  content.length > LEGACY_CONTENT_LIMIT
    ? `${content.slice(0, LEGACY_CONTENT_LIMIT)}…（已截断）`
    : content

/**
 * 剥掉不是本次模型配置产出的思考块。
 *
 * signature 绑 API key，换 provider / 换 key 之后旧 signature 会让请求 400。
 * **剥的是思考，不是整条消息** —— 文本和工具调用照留，那部分和 key 无关。
 * 剥完如果 assistant 什么都不剩，整条丢掉（空 content 的 assistant 同样会被拒）。
 */
const stripForeignReasoning = (carried: Carried[], modelConfigId: number | null): Carried[] => {
  const out: Carried[] = []
  for (const c of carried) {
    if (c.msg.role !== 'assistant' || c.modelConfigId === modelConfigId) {
      out.push(c)
      continue
    }
    const kept = c.msg.content.filter(b => !isReasoning(b))
    if (kept.length === 0) continue
    out.push({ ...c, msg: { role: 'assistant', content: kept } })
  }
  return out
}

/** 首条必须是 user —— 过滤和裁剪之后开头可能剩下 assistant */
const dropLeadingNonUser = (msgs: ModelMessage[]): ModelMessage[] => {
  let i = 0
  while (i < msgs.length && msgs[i].role !== 'user') i++
  return i === 0 ? msgs : msgs.slice(i)
}

/**
 * 这条消息占多少字符预算。
 *
 * 带图的用户消息按 `JSON.stringify` 算，于是一张图只记它的 URL 长度 ——
 * **这正是存 `asset://` 而不是 base64 的收益**：一张图在预算里约等于一行字，
 * 不会把整份历史挤掉。真实的 token 成本在模型那边（一张图几百到上千 token），
 * 这里的预算管的是「历史规模」，两者本来就不是一回事。
 */
const messageChars = (m: ModelMessage): number =>
  typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length

/**
 * 按预算从旧往新丢 —— **丢整轮，不丢半轮**。
 *
 * 一轮 = 一条 user + 到下一条 user 之前的全部 assistant / tool。
 * 半轮地丢会切断 tool-call ↔ tool-result 的配对，那正是 400 的来源；
 * 而按轮丢之后剩下的第一条必然还是 user，判据 2 那条红线自动成立。
 *
 * 丢掉的部分留一行交代，**由代码模板拼，不叫模型**：
 * 叫一次模型去总结是又一个会失败、会超时、会花钱的东西，
 * 而这行字的全部作用只是让 agent 知道「前面还有过对话，只是看不到了」。
 */
const trimToBudget = (msgs: ModelMessage[], charBudget: number): ModelMessage[] => {
  const turns: ModelMessage[][] = []
  for (const m of msgs) {
    if (m.role === 'user' || turns.length === 0) turns.push([m])
    else turns[turns.length - 1].push(m)
  }

  const sizes = turns.map(t => t.reduce((n, m) => n + messageChars(m), 0))
  let total = sizes.reduce((a, b) => a + b, 0)
  if (total <= charBudget) return msgs

  let dropped = 0
  // 至少留最后一轮 —— 全丢光等于把用户刚说的话也删了
  while (dropped < turns.length - 1 && total > charBudget) {
    total -= sizes[dropped]
    dropped++
  }
  if (dropped === 0) return msgs

  const note: ModelMessage = {
    role: 'user',
    content: `（此前还有 ${dropped} 轮对话，因超出上下文预算已省略。`
      + `需要早先的细节就用工具重新查，不要凭印象编。）`,
  }
  return [note, ...turns.slice(dropped).flat()]
}

/**
 * 修复 tool-call ↔ tool-result 的配对。**这一步必须在最后**，
 * 前面每一道（剥思考、丢轮次、掐首条）都可能制造出新的失配。
 *
 * 三件事一起做完：
 *   - 缺结果的调用 → 补一条 `isError` 的（否则下一轮 400）
 *   - 多出来的结果（对不上任何调用）→ 丢掉（同样会 400）
 *   - 结果按调用的顺序重排 → 产出确定，测试才能逐块比对
 */
const repairToolPairing = (msgs: ModelMessage[]): ModelMessage[] => {
  const out: ModelMessage[] = []
  let i = 0

  while (i < msgs.length) {
    const m = msgs[i]

    if (m.role !== 'assistant') {
      // 没有前置调用的 tool 消息是孤儿，整条丢掉
      if (m.role !== 'tool') out.push(m)
      i++
      continue
    }

    out.push(m)
    i++
    const calls = m.content.filter(isToolCall)
    if (calls.length === 0) continue

    // 紧跟着的 tool 消息全部收进来 —— 一个 assistant 的调用可能被拆成几条结果
    const results: ToolResultBlock[] = []
    while (i < msgs.length && msgs[i].role === 'tool') {
      results.push(...(msgs[i] as { content: ToolResultBlock[] }).content)
      i++
    }

    out.push({
      role: 'tool',
      content: calls.map(call =>
        results.find(r => r.toolCallId === call.toolCallId)
        ?? {
          type: 'tool-result',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: INTERRUPTED_TOOL_RESULT,
          isError: true,
        }),
    })
  }

  return out
}

export interface ToModelMessagesOptions {
  /**
   * 本次要用的模型配置 id。**必填，且不给默认值** ——
   * 少传一个参数就悄悄不剥思考块的话，换 key 之后炸的是线上，
   * 而不是这里。给不出 id 的调用方传 `null`，那会把所有思考块都剥掉（保守但安全）。
   */
  modelConfigId: number | null
  charBudget?: number
  /**
   * R-68 · `asset://<sha256>` → 可直接取的 URL。
   *
   * **不给的话带图的历史会丢掉图**（只留文字）。做成注入而不是在这里
   * import `assetConfig`，是因为那个模块拉 `db/index.ts`（`bun:sqlite`），
   * 一 import 本文件就再也不能在 vitest 里裸跑 —— 而"能裸跑"正是
   * 这个文件所有判据的前提（见文件头）。
   */
  resolveAssetUrl?: (src: string) => string
}

/**
 * 库里的历史 → 带进模型的消息序列。
 *
 * 顺序是有讲究的，每一步都可能给下一步制造麻烦，所以配对修复排在最后：
 *   解析 → 剥外来思考 → 掐掉开头的非 user → 按预算丢整轮 → 修配对
 */
export const toModelMessages = (
  rows: StoredRow[],
  { modelConfigId, charBudget = HISTORY_CHAR_BUDGET, resolveAssetUrl }: ToModelMessagesOptions,
): ModelMessage[] => {
  const carried = rows
    .map(row => rowToCarried(row, resolveAssetUrl))
    .filter((c): c is Carried => c !== null)

  const msgs = stripForeignReasoning(carried, modelConfigId).map(c => c.msg)

  return repairToolPairing(trimToBudget(dropLeadingNonUser(msgs), charBudget))
}
