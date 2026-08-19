/**
 * 专属文件格式
 *
 * 「导出专属文件」写出的是一份加密过的 JSON（见 `hooks/useExport.ts` 的
 * `exportSpecificFile`），后缀是本应用自己的。fork 改名之后写出的是 `.rabbit`。
 *
 * **导入仍然收 `.pptist`。** 那是上游 PPTist 的后缀，文件内容格式一模一样 ——
 * 改名之前导出过的文件、以及从上游 PPTist 拿来的文件，没有理由打不开。
 * 所以「写」只有一个后缀，「读」接受两个。
 */

/** 导出时用的后缀（不含点） */
export const SPECIFIC_FILE_EXT = 'rabbit'

/** 导入时接受的后缀（不含点），第一个是自己的，其余是兼容的 */
export const SPECIFIC_FILE_EXTS = [SPECIFIC_FILE_EXT, 'pptist'] as const

/** 给 `<input type="file" accept>` 用 */
export const SPECIFIC_FILE_ACCEPT = SPECIFIC_FILE_EXTS.map(e => `.${e}`).join(',')

export const isSpecificFileName = (name: string): boolean =>
  (SPECIFIC_FILE_EXTS as readonly string[]).includes(name.split('.').pop()?.toLowerCase() ?? '')
