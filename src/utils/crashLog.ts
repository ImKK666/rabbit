/**
 * 崩溃捕获 —— 让白屏说得出话
 *
 * ## 为什么需要它
 *
 * `main.ts` 里一个全局错误处理都没有，于是 Vue 渲染期出错 = **静默白屏**：
 * 页面没了，控制台跟着没了，用户能提供的信息只有「它白了」。
 *
 * R-58 交付后实测就撞上这个：「思考完调用工具直接白屏」——
 * 而**具体哪个工具、什么错误，一概不知道**。没有这份记录，
 * 排查只能靠猜；而我第一个猜的方向（离屏渲染的自激循环）
 * 被负对照当场证伪了 —— 探针里退回到出 bug 的那版，照样跑得好好的。
 *
 * **猜错不要紧，要紧的是没有东西能把猜错这件事告诉你。**
 *
 * ## 为什么要落 localStorage
 *
 * 白屏之后用户的第一反应是刷新，而刷新会带走内存里的一切。
 * 所以记录必须活过一次刷新 —— 这也是它和「打一行 console.error」的区别。
 *
 * 上限 20 条的环形缓冲：崩溃常常是连环的（一次渲染错误会连带触发好几条），
 * 不设上限的话真正的**第一条**会被后面的噪音挤出视野，
 * 而第一条才是有信息量的那条。
 */

/** 存哪儿。带版本号，形状改了不至于读到旧结构 */
export const CRASH_LOG_KEY = 'rabbit.crashlog.v1'

/** 最多留几条。留的是**最早**的几条 —— 首条才是根因 */
export const MAX_CRASHES = 20

export interface CrashRecord {
  /** ISO 时间戳 */
  at: string
  /** 哪条路捕获的 */
  source: 'vue' | 'window' | 'promise'
  message: string
  stack?: string
  /** Vue 专有：出错的组件与生命周期钩子 */
  component?: string
  hook?: string
  /** 出错时页面在干什么 —— 排查「哪个工具」全靠它 */
  note?: string
}

const clip = (s: unknown, n: number): string => {
  const t = typeof s === 'string' ? s : String(s)
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 把任意抛出来的东西整成一条记录。**不能再抛** —— 它跑在错误处理路径上 */
export const formatCrash = (
  err: unknown,
  source: CrashRecord['source'],
  extra: { component?: string, hook?: string, note?: string } = {},
): CrashRecord => {
  const e = err as { message?: unknown, stack?: unknown } | null
  return {
    at: new Date().toISOString(),
    source,
    message: clip(e?.message ?? err, 500),
    ...(e?.stack ? { stack: clip(e.stack, 2000) } : {}),
    ...(extra.component ? { component: clip(extra.component, 120) } : {}),
    ...(extra.hook ? { hook: clip(extra.hook, 60) } : {}),
    ...(extra.note ? { note: clip(extra.note, 300) } : {}),
  }
}

/**
 * 往环形缓冲里塞一条。
 *
 * **满了之后丢新的，不丢旧的。** 和常见的 ring buffer 反着来是刻意的：
 * 一次崩溃往往连环触发十几条，而**第一条**才是根因，
 * 后面的都是它的余波。丢旧留新等于把唯一有用的那条挤掉。
 */
export const pushCrash = (
  existing: CrashRecord[],
  record: CrashRecord,
  max: number = MAX_CRASHES,
): CrashRecord[] => (existing.length >= max ? existing : [...existing, record])

/** 读回来。存储被清过、写坏了、或者根本没有 —— 一律当空处理，绝不抛 */
export const readCrashLog = (storage: Pick<Storage, 'getItem'> = localStorage): CrashRecord[] => {
  try {
    const raw = storage.getItem(CRASH_LOG_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as CrashRecord[] : []
  }
  catch { return [] }
}

/**
 * 落盘。**整段包在 try 里** —— 无痕模式下 `setItem` 会抛 QuotaExceeded，
 * 而在错误处理路径上再抛一次异常，会把原始错误彻底盖掉。
 */
export const writeCrashLog = (
  records: CrashRecord[],
  storage: Pick<Storage, 'setItem'> = localStorage,
): void => {
  try { storage.setItem(CRASH_LOG_KEY, JSON.stringify(records)) }
  catch { /* 存不下就算了，控制台那份还在 */ }
}

export const clearCrashLog = (storage: Pick<Storage, 'removeItem'> = localStorage): void => {
  try { storage.removeItem(CRASH_LOG_KEY) }
  catch { /* 同上 */ }
}

/** 记一条。`note` 用来带上「出错时在干什么」，比如正在跑哪个工具 */
export const recordCrash = (
  err: unknown,
  source: CrashRecord['source'],
  extra: { component?: string, hook?: string, note?: string } = {},
): CrashRecord => {
  const record = formatCrash(err, source, extra)
  writeCrashLog(pushCrash(readCrashLog(), record))
  // 控制台那份照打 —— 页面还活着的时候它更方便
  console.error(`[crash:${source}]`, record.message, record.component ?? '', err)
  return record
}

// ---------------------------------------------------------------------------
// 崩溃横幅
// ---------------------------------------------------------------------------

/**
 * 上次崩过就在页面顶上挂一条横幅，带一键复制。
 *
 * ## 为什么是纯 DOM，不做成 Vue 组件
 *
 * **崩溃可能就发生在 Vue 挂载期间** —— 那种情况下 Vue 组件根本渲染不出来，
 * 做成组件的横幅等于没有。而这条横幅要服务的正是最糟的那个场景。
 *
 * 顺带也不依赖任何构建期的样式：全部内联，因为样式表也可能没加载上。
 *
 * ## 为什么要有它 —— 「打开控制台」不是所有人都做得到
 *
 * Safari 的开发者菜单**默认是关的**，要先去设置里勾「显示网页开发者功能」。
 * 一个排查步骤如果要求用户先改浏览器设置，那它在现实里就是不会被执行的。
 */
export const showCrashBanner = (
  records: CrashRecord[],
  doc: Document = document,
): HTMLElement | null => {
  if (records.length === 0) return null
  try {
    const first = records[0]
    const bar = doc.createElement('div')
    bar.style.cssText = [
      'position:fixed', 'inset:0 0 auto 0', 'z-index:2147483647',
      'background:#7f1d1d', 'color:#fff', 'padding:10px 14px',
      'font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      'display:flex', 'gap:12px', 'align-items:flex-start',
      'box-shadow:0 2px 8px rgba(0,0,0,.3)',
    ].join(';')

    const text = doc.createElement('div')
    text.style.cssText = 'flex:1;min-width:0'
    const head = doc.createElement('div')
    head.style.cssText = 'font-weight:600;margin-bottom:2px'
    head.textContent = `上次运行崩了（记录到 ${records.length} 条，下面是第一条 —— 它才是根因）`
    const body = doc.createElement('div')
    body.style.cssText = 'opacity:.9;word-break:break-all'
    body.textContent = [first.source, first.component, first.hook, first.message]
      .filter(Boolean).join(' · ')
    text.append(head, body)

    const mkBtn = (label: string) => {
      const b = doc.createElement('button')
      b.textContent = label
      b.style.cssText = [
        'flex:0 0 auto', 'background:#fff', 'color:#7f1d1d', 'border:0',
        'border-radius:4px', 'padding:5px 10px', 'cursor:pointer',
        'font:inherit', 'font-weight:600',
      ].join(';')
      return b
    }

    const copy = mkBtn('复制全部')
    copy.onclick = () => {
      const payload = JSON.stringify(records, null, 2)
      // `navigator.clipboard` 在非 https / 非 localhost 下不存在，
      // 所以必须有 textarea 那条老路 —— 否则「复制」按钮在一半环境里是死的
      const fallback = () => {
        const ta = doc.createElement('textarea')
        ta.value = payload
        ta.style.cssText = 'position:fixed;opacity:0'
        doc.body.appendChild(ta)
        ta.select()
        try { doc.execCommand('copy') } finally { ta.remove() }
      }
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(payload).then(
          () => { copy.textContent = '已复制 ✓' },
          () => { fallback(); copy.textContent = '已复制 ✓' },
        )
      }
      else { fallback(); copy.textContent = '已复制 ✓' }
    }

    const dismiss = mkBtn('清除')
    dismiss.onclick = () => { clearCrashLog(); bar.remove() }

    bar.append(text, copy, dismiss)
    doc.body.appendChild(bar)
    return bar
  }
  catch {
    // 横幅自己不能成为第二个故障点
    return null
  }
}
