/**
 * 工具组装配 —— 域无关
 *
 * 拆层前的形状是 `getToolSubset(role)` 里一个 switch：
 * 「planner/reviewer 拿这 5 个，generator/editor 拿全集」。
 * 那个形状有两个问题，接第二个域之前必须先解决：
 *
 *   1. 组合规则写在控制流里，看不出「谁能做什么」，也没法测
 *   2. 它假设只有一个域。第二个域进来时，`allTools` 是哪个域的？
 *      switch 里要不要再加一层判断？—— 每加一个域就要改一次角色定义
 *
 * 改成数据之后：**域声明自己有哪些组，agent 声明自己要哪些组**，
 * 这个文件只负责按名字挑出来。它不知道 deck 是什么，也不该知道。
 *
 * 类型上刻意保持返回 `Partial<T>`：orchestrator 依赖这个形状，
 * 换成精确类型会连带碰上 Vercel AI SDK 把 toolCalls 推断成 `never` 的老问题
 * （见 orchestrator.ts 里那处 as 转换的注释）。
 */

/** 组名 → 该组包含的工具键。值用 `readonly` 是为了让调用方能安全地 `as const satisfies` */
export type ToolGroupMap<T> = Readonly<Record<string, readonly (keyof T)[]>>

/**
 * 按组名挑出工具子集。
 *
 * **未知组名抛错，不静默跳过。**
 *
 * 这条和 `budget.ts` 对非法环境变量「一律忽略退回默认，不报错」的处置**故意相反**，
 * 因为两者的输入来源不同：
 *   - `AGENT_MAX_STEPS=abc` 是用户在部署环境里打错的字，
 *     启动失败比「用了默认值」更糟
 *   - 工具组名是**代码里的常量**，打错就是程序员的错。
 *     静默跳过的表现是「agent 突然什么都不会做了」，
 *     那种故障比启动时抛一条明确的错难查一个数量级
 *
 * 重复组名是允许的（两个组共享同一个工具很正常），后写的覆盖先写的，结果一样。
 */
export const selectToolGroups = <T extends object>(
  all: T,
  groups: ToolGroupMap<T>,
  wanted: readonly string[],
): Partial<T> => {
  const selected: Partial<T> = {}

  for (const groupName of wanted) {
    const keys = groups[groupName]
    if (!keys) {
      const available = Object.keys(groups).sort().join(', ')
      throw new Error(`未知的工具组 "${groupName}"，可用的组：${available}`)
    }
    for (const key of keys) selected[key] = all[key]
  }

  return selected
}

/**
 * 找出没有被任何组收录的工具。
 *
 * 这条是给测试用的，守的是一个**会静默发生**的退化：
 * 往域里加了第 24 个工具、忘了归组 —— 编译过、测试过、agent 永远拿不到它。
 * 和第七轮动画那条「死词表是 0 个」是同一类判据：
 * **能力存在但没有任何一条路径够得着，等于不存在，而且不会有人报错。**
 */
export const findUngroupedTools = <T extends object>(
  all: T,
  groups: ToolGroupMap<T>,
): (keyof T)[] => {
  const grouped = new Set<PropertyKey>()
  for (const keys of Object.values(groups)) {
    for (const key of keys) grouped.add(key as PropertyKey)
  }
  return (Object.keys(all) as (keyof T)[]).filter(key => !grouped.has(key as PropertyKey))
}
