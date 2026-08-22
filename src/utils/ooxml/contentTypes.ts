/**
 * R-67 · [Content_Types].xml 兜底
 *
 * OPC 的强制约束：包里每个 part 都必须能拿到内容类型 —— 要么扩展名命中一条
 * `<Default>`，要么自己有一条 `<Override>`。拿不到，PowerPoint 判文件损坏。
 *
 * pptxgenjs 在这件事上有个洞：写 [Content_Types].xml 时它跳过 `rel.type === 'image'`
 * 的 rel（pptxgen.es.js:6315），而**背景图的 rel.type 恰好就是 `'image'`**
 * （普通图元是 `'image/png'` 这种，不会被跳）。也就是说背景图从不自带声明，
 * 全靠它硬编码的那几条 Default（jpeg/jpg/png/gif/svg）兜着。
 *
 * 我们的资产管线目前只产 png / jpeg（`runtime/imageCodec.ts` 的 ImageFormat），
 * 正好在那几条里 —— 但**这正是本次事故的形状：一个没写下来的前提悄悄失效**。
 * 导入来的 deck、外链图片都可能是 webp，那时又是一次「文件损坏」而无人知道为什么。
 *
 * 所以按产物的实际内容再扫一遍，缺什么补什么。补不了的（认不出的扩展名、
 * 或压根没有扩展名）**如实报出来**，不假装没事 —— 上一次就是因为没人报，
 * 才让一份坏文件走到了用户手里。
 */

/** 只声明我们敢担保的类型。认不出的宁可报错，也不瞎写一条 Default */
const MEDIA_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  wma: 'audio/x-ms-wma',
}

const TYPES_OPEN_TAG = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'

export interface ContentTypesResult {
  xml: string
  /** 补进去的扩展名，供日志 */
  added: string[]
  /** 仍然没有内容类型的 part —— 这份文件打不开，必须让人看见 */
  uncovered: string[]
}

/**
 * 确保每个 part 都有内容类型。
 *
 * @param contentTypesXml 产物里的 [Content_Types].xml 原文
 * @param partNames zip 里所有 part 的路径（不含目录项），如 `ppt/media/image-1-2.png`
 */
export const ensureContentTypes = (contentTypesXml: string, partNames: string[]): ContentTypesResult => {
  const declared = new Set(
    [...contentTypesXml.matchAll(/<Default\s+Extension="([^"]+)"/g)].map(m => m[1].toLowerCase())
  )
  const overridden = new Set(
    [...contentTypesXml.matchAll(/<Override\s+PartName="([^"]+)"/g)].map(m => m[1])
  )

  const added: string[] = []
  const uncovered: string[] = []
  const additions: string[] = []

  for (const part of partNames) {
    if (overridden.has(`/${part}`)) continue

    // 末段里的点才算扩展名 —— `media/a.b/c` 的 `c` 是没有扩展名的，
    // 对整条路径 split('.') 正是 pptxgenjs 栽跟头的地方，别重蹈。
    //
    // 首字符就是点也算：OPC 的 `_rels/.rels` 扩展名就是 `rels`，
    // 按「点必须在中间」去判会把包里每一份 .rels 都误报成缺内容类型
    const segment = part.slice(part.lastIndexOf('/') + 1)
    const dot = segment.lastIndexOf('.')
    const ext = dot === -1 ? '' : segment.slice(dot + 1).toLowerCase()

    if (ext && declared.has(ext)) continue

    const contentType = ext ? MEDIA_CONTENT_TYPES[ext] : undefined
    if (!contentType) {
      uncovered.push(part)
      continue
    }

    declared.add(ext)
    added.push(ext)
    additions.push(`<Default Extension="${ext}" ContentType="${contentType}"/>`)
  }

  const xml = additions.length
    ? contentTypesXml.replace(TYPES_OPEN_TAG, `${TYPES_OPEN_TAG}${additions.join('')}`)
    : contentTypesXml

  return { xml, added, uncovered }
}
