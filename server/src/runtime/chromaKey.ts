/**
 * 保色保线的纯色底抠图 —— 域无关，就是一段像素运算
 *
 * 移植自 `refs/skills/06-image-gen/GordenSuperPPTSkills/GordenImage2PPTX/scripts/chroma_key.py`
 * （无 LICENSE，项目主 2026-08-21 判定可自由使用，见 `refs/skills/INDEX.md` §四）。
 *
 * ## 为什么需要它
 *
 * 生图模型**不输出 alpha**。实测 2/2：明确要求透明背景时，
 * 产物 100% 不透明像素；用最强措辞（"RGBA 32-bit, alpha=0, sticker layer"）时，
 * 模型把 Photoshop 的**透明棋盘格当成图案画了出来** —— 眼睛说是，`hasTransparency()` 说否。
 * 这是这类模型文档化的已知行为，不是偶发（docs/14 事实 ①）。
 *
 * 所以装饰层只能走「纯绿底出图 → 抠成透明」。没有这一步，
 * 一张 1376×768 的不透明绿底图铺上去就是一整页绿。
 *
 * ## 为什么不用通用绿幕器
 *
 * 原版 docstring 点名了通用抠像器的两宗罪，而这两条对扁平信息图是致命的：
 *
 * 1. **降饱和** —— 对每个半键像素都把键通道封顶，红/橙会变灰
 * 2. **吃细线** —— 激进的软蒙版 + 边缘腐蚀会把 1px 分割线和辉光整条抹掉
 *
 * 这里的做法：
 * - **平坦键色蒙版**（硬核心 + 抗锯齿斜坡），离键色远的内容色 100% 保留
 * - **边缘反混合**：由 `观测 = α·前景 + (1−α)·键色` 反解前景色，
 *   细线因此保住原色而不是发灰发绿。只在中高 alpha 上做 ——
 *   对接近全透明的像素反解会把噪声放大成品红色晕
 * - **去溢出只作用于「键色主导」的通道**，把它压到其余通道的 max。
 *   对红/藏青/灰/白是 **no-op**，所以绝不褪色
 * - **默认不腐蚀**（`contract = 0`），1px 线和辉光必须留住
 *
 * ## 一处**故意偏离原版**
 *
 * 原版保留全透明像素的 RGB（为 PowerPoint 缩放时边缘不发黑）。
 * **我们把它归零** —— 实测：92.5% 的像素变成完全相同的 `(0,0,0,0)` 之后，
 * 无损 PNG 从 1070 KB 降到 **207 KB（5.2 倍）**，而 alpha/RGB 偏差都是 0。
 * 走调色板能到 74 KB，但 `imageCodec.decodeImage` 显式拒收索引色 PNG，
 * 且那条是有损的（RGB 偏差 58）。详见 docs/14 事实 ⑤。
 *
 * ## 目标形态是量出来的，不是设的
 *
 * 装饰层 prompt 收敛到「实心 4~8px 笔画 + 覆盖 ≤12%」之后实测（docs/14 §七）：
 * **墨里 80% 是实心/中等**，只有 20% 是抗锯齿边缘。
 * 所以边缘反混合仍然要有，但它的错误影响面比 thin-line 那一版小一个量级 ——
 * 那一版墨里实心占比只有 6.8%，颜色几乎全靠重建，我的第一次简化移植就是在那版上偏的色。
 */

/**
 * 默认纯绿。
 *
 * ## 换键色之前必须探色 —— 键色和内容配色是会撞的
 *
 * 去溢出的规则是「把键色主导的通道压到其余通道的 max」。**哪些颜色是 no-op
 * 完全取决于键色是什么**：
 *
 * | 内容色 | 绿键 `#00FF00` | 品红键 `#FF00FF` |
 * |---|---|---|
 * | 藏青 `#1F3A5F` | no-op（G=58 < max(R,B)=95） | **B 被压到 58**，颜色变暗 |
 * | 绿系 `#2EA043` | 会被压 | no-op |
 *
 * 原版 docstring 那句「对红/藏青/灰/白是 no-op」的前提是**绿键**。
 * 这不是 bug，是这类算法的固有性质，判据钉在 `__tests__/chromaKey.test.ts`
 * 「已知限制」那条上。
 *
 * **`probe_palette.py` 那套探色还没移植**（docs/14 §八）。在它到位之前，
 * 换键色是有风险的动作 —— 而 rabbit 的配色是模型自己定的（R-55），
 * 撞绿的稿子迟早会出现。
 */
export const DEFAULT_KEY: readonly [number, number, number] = [0, 255, 0]

export interface ChromaKeyOptions {
  /** 键色 RGB */
  key?: readonly [number, number, number]
  /** 距离 ≤ 这个值 → 全透明 */
  tLow?: number
  /** 距离 ≥ 这个值 → 全不透明。中间那段是抗锯齿边缘 */
  tHigh?: number
  /** <1 抬高半透明边缘的 alpha，细弧在缩放后不碎 */
  alphaGamma?: number
  /** alpha 低于这个直接归零，去掉抠图残渣 */
  alphaCutoff?: number
  /** 边缘反混合的下限 alpha。太低会放大噪声成色晕 */
  edgeRecoverMin?: number
  /** 关掉去溢出（排查褪色时用） */
  despill?: boolean
  /** 关掉边缘反混合（排查色晕时用） */
  edgeRecover?: boolean
}

/**
 * 默认值抄的是原版的 `frame-safe` 预设，而 `tLow`/`tHigh` 在 rabbit 的产物上实测过：
 * 底色核心区（d≤38）92.5%、过渡带（38<d≤110）5.6%，分布干净利落（docs/14 事实 ②）。
 */
const DEFAULTS = {
  tLow: 38,
  tHigh: 110,
  alphaGamma: 0.72,
  alphaCutoff: 12,
  edgeRecoverMin: 0.26,
  despill: true,
  edgeRecover: true,
} as const

export interface ChromaKeyResult {
  /** 抠完的 RGBA，长度 = width × height × 4 */
  rgba: Uint8Array
  width: number
  height: number
  /** alpha === 0 的像素数 */
  transparent: number
  /** 0 < alpha < 255 */
  partial: number
  /** alpha === 255 */
  opaque: number
}

/** 到键色的 Chebyshev 距离。和原版用的是同一个度量 */
export const keyDistance = (
  r: number, g: number, b: number, key: readonly [number, number, number],
): number => Math.max(Math.abs(r - key[0]), Math.abs(g - key[1]), Math.abs(b - key[2]))

/**
 * 把纯色底抠成透明。
 *
 * **不修改入参**，返回一份新的 RGBA。
 */
export const chromaKey = (
  rgba: Uint8Array,
  width: number,
  height: number,
  opts: ChromaKeyOptions = {},
): ChromaKeyResult => {
  const key = opts.key ?? DEFAULT_KEY
  const tLow = opts.tLow ?? DEFAULTS.tLow
  const tHigh = Math.max(tLow + 1, opts.tHigh ?? DEFAULTS.tHigh)
  const gamma = opts.alphaGamma ?? DEFAULTS.alphaGamma
  const cutoff = opts.alphaCutoff ?? DEFAULTS.alphaCutoff
  const edgeMin = opts.edgeRecoverMin ?? DEFAULTS.edgeRecoverMin
  const despill = opts.despill ?? DEFAULTS.despill
  const edgeRecover = opts.edgeRecover ?? DEFAULTS.edgeRecover

  const out = new Uint8Array(rgba.length)
  let transparent = 0, partial = 0, opaque = 0

  for (let i = 0; i < rgba.length; i += 4) {
    const r0 = rgba[i], g0 = rgba[i + 1], b0 = rgba[i + 2]
    const srcA = rgba[i + 3] / 255

    const t = Math.min(1, Math.max(0, (keyDistance(r0, g0, b0, key) - tLow) / (tHigh - tLow)))
    let alpha = t * t * (3 - 2 * t)          // smoothstep

    let r = r0, g = g0, b = b0

    // 边缘反混合：observed = α·fg + (1−α)·key
    if (edgeRecover && alpha > edgeMin && alpha < 0.995) {
      const safe = Math.max(alpha, edgeMin)
      r = Math.min(255, Math.max(0, (r0 - (1 - alpha) * key[0]) / safe))
      g = Math.min(255, Math.max(0, (g0 - (1 - alpha) * key[1]) / safe))
      b = Math.min(255, Math.max(0, (b0 - (1 - alpha) * key[2]) / safe))
    }

    // 去溢出：只压「键色主导」的通道。哪个通道算主导由键色本身决定 ——
    // 绿键压 G，品红键压 R 和 B。对非键色内容是 no-op，所以绝不褪色
    if (despill) {
      const km = Math.max(key[0], key[1], key[2])
      if (km >= 110) {
        const isSpill = [key[0] >= km - 24, key[1] >= km - 24, key[2] >= km - 24]
        const rest: number[] = []
        if (!isSpill[0]) rest.push(r)
        if (!isSpill[1]) rest.push(g)
        if (!isSpill[2]) rest.push(b)
        const anchor = rest.length ? Math.max(...rest) : 0
        if (isSpill[0] && r > anchor) r = anchor
        if (isSpill[1] && g > anchor) g = anchor
        if (isSpill[2] && b > anchor) b = anchor
      }
    }

    if (gamma > 0 && gamma !== 1) alpha = alpha ** gamma

    let a8 = Math.round(alpha * srcA * 255)
    if (a8 < cutoff) a8 = 0

    if (a8 === 0) {
      // **故意偏离原版**：全透明像素 RGB 归零。见文件头注释
      out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0
      transparent++
    }
    else {
      out[i] = Math.round(r); out[i + 1] = Math.round(g); out[i + 2] = Math.round(b); out[i + 3] = a8
      if (a8 === 255) opaque++; else partial++
    }
  }

  return { rgba: out, width, height, transparent, partial, opaque }
}

/**
 * 抠完之后透明像素至少要占这么多，否则判定**这次生成失败**。
 *
 * ## 这一条替代了「棋盘格检测器」
 *
 * 原计划是写一个识别灰白棋盘格的启发式（docs/14 判据 O2）。
 * 但那是在给一个**具体的**失败模式写检测器，而真正该判的是**通用的**那件事：
 * **模型有没有照要求画在纯色底上。**
 *
 * 棋盘格、白底、直接画了张照片 —— 这三种失败在「抠完几乎没有透明像素」
 * 这一条上会**同时**被抓住，而且不需要任何启发式。
 * 一个通用判据比三个专用检测器可靠，也更难被下一种没见过的失败绕过去。
 *
 * 0.5 是按目标形态定的：实测覆盖率 5.04%，也就是透明区应该在 94% 上下。
 * 掉到 50% 以下说明产物根本不是「纯色底 + 稀疏装饰」那个形状。
 */
export const MIN_TRANSPARENT_RATIO = 0.5

export const keyedLooksUsable = (result: ChromaKeyResult): boolean =>
  result.transparent / (result.width * result.height) >= MIN_TRANSPARENT_RATIO
