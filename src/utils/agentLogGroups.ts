/**
 * agent 面板的「思考过程」分组 —— 纯函数
 *
 * 一次任务在面板上长这样：
 *   想 → 调工具 → 想 → 调工具 → 想 → **说一句给用户听的话**
 *
 * 前面一长串是**过程**，最后那句才是**结果**。做完之后回看，
 * 想看的几乎总是最后那句，而过程能占掉整屏 ——
 * 一次 17 步的任务要滚十几屏才找得到「它到底做了什么」。
 *
 * 所以把**连续的 reasoning / tool / asset 收成一组**，收起时只留一行摘要。
 *
 * ## 为什么按「连续」分，而不是「一轮一组」
 *
 * agent 中途也会说话（「规范拿到了，现在建 4 个空页」），
 * 那句话本身就是天然的分段点 —— 每一组正好是
 * 「它接下来要说的那句话背后的思考」，读起来是一段对话记录。
 *
 * 「一轮一组」得先知道**哪句 text 是最后一句**，而那在流式过程中判不了：
 * 每来一条新消息，「最后一句」都可能变，块会在跑的时候忽大忽小。
 * 按连续分则每一组的起点一旦确定就不再变。
 *
 * 抽成纯函数是因为这条规则**坏掉的时候不会报错**，
 * 只会表现成「面板看起来怪怪的」——那种东西必须有判据守着。
 */

/** 只列分组用得上的字段，面板里的完整类型见 `store/agent.ts` */
export interface GroupableEntry {
  type: string
  /** reasoning 才有 */
  content?: string
}

/** 归进「过程」的三种条目。text / status 是结果与状态，留在组外 */
const PROCESS_TYPES = new Set(['reasoning', 'tool', 'asset'])

export interface GroupStat {
  /** 这一组里思考的总字数 */
  chars: number
  tools: number
  assets: number
  /** 组内最后一条的下标 —— 判断「这组是不是还在长」要用 */
  end: number
}

/**
 * 每条日志属于哪一组。
 *
 * 返回值与输入等长：第 i 项是它所属组的**起始下标**，不在任何组里的是 -1。
 * 用起始下标当组 id，而不是另发一个自增 id —— 日志是只增不改的数组，
 * 起始下标天然稳定，且组头那一行「只在 `groupStartOf[i] === i` 时渲染」
 * 一个条件就够了。
 */
export const groupStartOf = (log: readonly GroupableEntry[]): number[] => {
  const map: number[] = []
  let start = -1
  for (let i = 0; i < log.length; i++) {
    const e = log[i]
    if (!PROCESS_TYPES.has(e.type)) {
      start = -1
      map[i] = -1
      continue
    }
    if (start === -1) start = i
    map[i] = start
  }
  return map
}

/** 每组一份统计，键是组的起始下标 */
export const groupStats = (log: readonly GroupableEntry[]): Map<number, GroupStat> => {
  const starts = groupStartOf(log)
  const m = new Map<number, GroupStat>()
  for (let i = 0; i < log.length; i++) {
    const e = log[i]
    const s = starts[i]
    if (s < 0) continue
    const g = m.get(s) ?? { chars: 0, tools: 0, assets: 0, end: i }
    if (e.type === 'reasoning') g.chars += e.content?.length ?? 0
    else if (e.type === 'tool') g.tools++
    else if (e.type === 'asset') g.assets++
    g.end = i
    m.set(s, g)
  }
  return m
}

/**
 * 组头那一行显示什么。
 *
 * 只报**发生过的**那几项：一次纯思考不该显示「调用 0 个工具」，
 * 那种「0 个」的措辞会让人以为出了问题（这一版修的那个
 * 「思考完成 0 字」空壳就是同一类毛病）。
 */
export const summarizeGroup = (stat: GroupStat | undefined): string => {
  if (!stat) return '思考'
  const bits: string[] = []
  if (stat.chars) bits.push(`思考 ${stat.chars} 字`)
  if (stat.tools) bits.push(`调用 ${stat.tools} 个工具`)
  if (stat.assets) bits.push(`取图 ${stat.assets} 张`)
  return bits.length ? bits.join(' · ') : '思考'
}
