/**
 * R-17 · elId → spid 映射
 *
 * OOXML 动画目标引用的是形状的数字 id（spid）：
 *   <p:tgtEl><p:spTgt spid="5"/></p:tgtEl>
 *
 * 而 PPTist 的动画条目引用的是 nanoid（elId）：
 *   PPTAnimation { elId: 'V3sQ1nB7xK', ... }
 *
 * 两者之间没有天然联系。映射错了不会报错，只会让动画作用在错误的元素上。
 *
 * 方案（docs/05-pptx-export.md 第三节）：
 *   E2 给每个形状设 objectName: el.id（useExport.ts，R-08 已完成）
 *   → 落到 <p:cNvPr id="X" name="Y">
 *   → 本文件从 slide XML 里按 name 反查 id，建 Map<elId, spid>
 *   → 查不到就跳过该动画并告警（宁可少一个动画，不要作用错元素）
 *
 * 纯函数、不依赖 DOM、不依赖 jszip — 调用方负责从 zip 里拿到 XML 字符串。
 */

export interface SpidEntry {
  spid: number
  name: string
}

/**
 * 从一页 slide XML 里提取所有 <p:cNvPr id="..." name="..."> 条目
 *
 * 用正则而非 DOMParser：
 * 1. 这段 XML 是 pptxgenjs 自己拼的，结构极其规律
 * 2. 不依赖浏览器 DOM，将来 Deck Kernel（Node 侧）也能复用
 * 3. 只需要 id 和 name 两个属性，解析整棵 DOM 树浪费
 *
 * 正则匹配 `<p:cNvPr` 或 `<xdr:cNvPr`（图表嵌入用 xdr 命名空间）。
 * 属性顺序 id 在前 name 在后是 pptxgenjs 的固定模板，但正则两个方向都收
 * 以防万一。
 */
const CNVPR_REGEX = /<(?:p|xdr):cNvPr\s[^>]*?id="(\d+)"[^>]*?name="([^"]*)"[^>]*?\/?>/g
const CNVPR_REGEX_REV = /<(?:p|xdr):cNvPr\s[^>]*?name="([^"]*)"[^>]*?id="(\d+)"[^>]*?\/?>/g

export const parseSpidEntries = (slideXml: string): SpidEntry[] => {
  const entries: SpidEntry[] = []
  const seen = new Set<number>()

  for (const regex of [CNVPR_REGEX, CNVPR_REGEX_REV]) {
    regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = regex.exec(slideXml)) !== null) {
      const isReversed = regex === CNVPR_REGEX_REV
      const spid = parseInt(isReversed ? m[2] : m[1], 10)
      const name = isReversed ? m[1] : m[2]
      if (!seen.has(spid) && name) {
        seen.add(spid)
        entries.push({ spid, name })
      }
    }
  }

  return entries
}

/**
 * 从一页 slide XML 构建 elId → spid 映射
 *
 * @returns Map，key 是 PPTist 的 elId（objectName 写进去的值），value 是 OOXML spid
 */
export const buildSpidMap = (slideXml: string): Map<string, number> => {
  const map = new Map<string, number>()
  for (const entry of parseSpidEntries(slideXml)) {
    if (!map.has(entry.name)) {
      map.set(entry.name, entry.spid)
    }
  }
  return map
}
