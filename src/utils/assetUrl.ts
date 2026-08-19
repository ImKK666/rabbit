/**
 * R-10 · `asset://` 解析器
 *
 * deck JSON 里的图片一律**内容寻址**，只存 `asset://<sha256>`，
 * 不存文件路径、不存远程 URL（决策 E，见 docs/03-architecture.md 第五节）：
 *
 *   - 同 prompt 同 hash 命中缓存，agent 重生成 5 次不会留下 5 个孤儿
 *   - 两页用同一张图只存一份
 *   - deck JSON 与文件位置解耦 —— 导出打包、导入去重、离线打开都成立
 *
 * `PPTImageElement.src` / `SlideBackgroundImage.src` 本来就吃任意字符串，
 * 所以 **schema 零改动**，`asset://` 是纯约定，由本文件独家解释。
 *
 * ## 文法
 *
 * ```
 * asset://<sha256>           64 位 hex，内容寻址，解析成 <baseUrl>/<hash>
 * asset://pending/<taskId>   资产生成中，尚无 hash，前端渲染骨架屏（R-11）
 * 其它任意字符串              原样透传（http(s): / data: / blob: / 相对路径）
 * ```
 *
 * 刻意不收 `asset://<hash>.png` 这类带扩展名的写法，也不收 query ——
 * 一个 hash 只对应一个 URL，MIME 由资产库用 `Content-Type` 给出。
 *
 * `pending` 这一档存在的理由：让异步生成不污染 kernel 的纯函数性。
 * agent 调 `plan_asset()` 立刻拿到 pending id 就能继续排版，
 * 图片就绪后由一个 patch 把它换成 `asset://<hash>`，kernel 里零异步代码。
 *
 * ## 用法纪律
 *
 * **只在渲染时解析，解析结果绝不写回 deck。** 写回的必须是 `asset://` 原串 ——
 * 一旦把 `https://host/assets/<hash>` 存进 deck，上面三条好处全部失效。
 *
 * ## 纯度
 *
 * 不依赖 Vue / HTTP / 文件系统，只做字符串解析。
 * 将来 Deck Kernel 的资产引用校验（对 manifest 查 hash 是否声明）直接复用这份文法。
 */


export const ASSET_PROTOCOL = 'asset://'
export const ASSET_PENDING_SEGMENT = 'pending/'

/** sha256 十六进制摘要。大小写都收，解析结果统一规范化成小写 */
const SHA256_REGEXP = /^[0-9a-fA-F]{64}$/

/** pending 任务 id。按 nanoid 字符集放宽，但不允许出现 `/` 以免和文法二义 */
const TASK_ID_REGEXP = /^[A-Za-z0-9_-]{1,64}$/

const DEFAULT_ASSET_BASE_URL = '/assets'

/**
 * 资产库根地址。
 *
 * **普通变量，不是 ref —— 这是量过的，不是省事。**
 *
 * 消费点全都写成 `computed(() => parseAssetUrl(props.elementInfo.src))`
 * （`ImageElement/index.vue`、`BaseImageElement.vue`、`useSlideBackgroundStyle.ts`），
 * 而 computed 追踪不到普通变量 —— 看起来这里非 ref 不可。
 * 第十八轮真改成 `shallowRef` 试过，**负对照证明它没有作用**：改回普通变量，
 * 浏览器里图照样正常加载。
 *
 * 因为**时序本来就是对的**：`App.vue` 在登录后立刻同步根地址，
 * 而画布只可能在登录之后才打开 —— 图片组件被创建时，computed 第一次求值
 * 读到的已经是新值，不存在「需要重算」的旧缓存。
 *
 * **它成立的前提是那个时序。** 哪天出现「根地址还没到位，画布就已经渲染了图片」
 * 的路径（比如把同步挪到更晚、或加一条不经登录的预览入口），
 * 表现会是**一张图都加载不出来而控制台毫无报错** —— 那时才该换成 ref，
 * 而不是现在为一个不存在的场景把本文件从「零依赖」变成依赖 Vue。
 */
let assetBaseUrl = DEFAULT_ASSET_BASE_URL

/**
 * 设置资产库根地址（末尾斜杠会被去掉）。
 *
 * 由 `App.vue` 在登录后调用，值来自 `GET /api/assets/base-url`
 * （形如 `https://<bucket>.cos.<region>.myqcloud.com/rabbit`，含 key 前缀）。
 *
 * 这里留 setter 而不是直接 import services，是为了不让 utils 反向依赖 services。
 * 拿不到时**不要调用**：默认值 `/assets` 必然 404，但那比设一个坏地址好排查。
 */
export const setAssetBaseUrl = (baseUrl: string) => {
  assetBaseUrl = baseUrl.replace(/\/+$/, '')
}

export const getAssetBaseUrl = () => assetBaseUrl

/** 非 `asset://` 引用，原样透传 */
export interface PlainAssetRef {
  kind: 'plain'
  url: string
}

/** `asset://<sha256>`，已解析成可直接请求的地址 */
export interface HashAssetRef {
  kind: 'hash'
  url: string
  /** 规范化成小写的 sha256 */
  hash: string
}

/** `asset://pending/<taskId>`，资产生成中 */
export interface PendingAssetRef {
  kind: 'pending'
  url: ''
  taskId: string
}

/** 形如 `asset://` 但不合文法 */
export interface InvalidAssetRef {
  kind: 'invalid'
  url: ''
  raw: string
  /** 人类可读的原因，供将来的资产引用 lint 直接上报 */
  reason: string
}

export type AssetRef = PlainAssetRef | HashAssetRef | PendingAssetRef | InvalidAssetRef

export const isAssetUrl = (src: string): boolean => !!src && src.startsWith(ASSET_PROTOCOL)

/**
 * 解析一个图片引用
 * @param src `PPTImageElement.src` / `SlideBackgroundImage.src` 的原始值
 */
export const parseAssetUrl = (src: string): AssetRef => {
  if (!isAssetUrl(src)) return { kind: 'plain', url: src || '' }

  const body = src.slice(ASSET_PROTOCOL.length)

  if (body.startsWith(ASSET_PENDING_SEGMENT)) {
    const taskId = body.slice(ASSET_PENDING_SEGMENT.length)
    if (!TASK_ID_REGEXP.test(taskId)) {
      return { kind: 'invalid', url: '', raw: src, reason: 'pending 任务 id 为空或含非法字符' }
    }
    return { kind: 'pending', url: '', taskId }
  }

  if (!SHA256_REGEXP.test(body)) {
    return { kind: 'invalid', url: '', raw: src, reason: '不是 64 位十六进制 sha256' }
  }

  const hash = body.toLowerCase()
  return { kind: 'hash', url: `${assetBaseUrl}/${hash}`, hash }
}

/**
 * 取可直接喂给 `<img src>` / CSS `url()` 的地址
 *
 * pending 与非法引用一律返回空串 —— 调用方据此决定渲染骨架屏还是留空。
 * **不要**把原串塞回 `<img src>` 兜底：浏览器认不得 `asset:` 协议，
 * 只会得到一个破图，还会把「生成中」和「引用坏了」混成同一种观感。
 */
export const resolveAssetUrl = (src: string): string => parseAssetUrl(src).url

/** 是否为生成中的资产（渲染骨架屏的判据） */
export const isPendingAsset = (src: string): boolean => parseAssetUrl(src).kind === 'pending'

/**
 * sha256 → `asset://<hash>`，写进 deck 用
 *
 * 不做校验：调用方（资产库 / kernel）本来就持有真实摘要，
 * 校验重复放这里只会给出一个「看起来合法」的错误值。
 */
export const toAssetUrl = (hash: string): string => `${ASSET_PROTOCOL}${hash.toLowerCase()}`

/** 任务 id → `asset://pending/<taskId>`，写进 deck 用 */
export const toPendingAssetUrl = (taskId: string): string => `${ASSET_PROTOCOL}${ASSET_PENDING_SEGMENT}${taskId}`
