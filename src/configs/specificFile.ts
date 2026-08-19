/**
 * 专属文件格式
 *
 * 「导出专属文件」写出的是一份加密过的 JSON（见 `hooks/useExport.ts` 的
 * `exportSpecificFile`），后缀 `.rabbit`，密钥见 `utils/crypto.ts`。
 *
 * **和上游 PPTist 的 `.pptist` 不互通，也不打算互通。** 后缀不认、密钥也换了。
 * 这是 fork 改名时的有意选择：留一条兼容路径意味着后缀、密钥、
 * 提示文案三处都要长期挂着两套值，而这个格式只在本应用内部导入导出，
 * 换不来什么。
 */

/** 专属文件后缀（不含点） */
export const SPECIFIC_FILE_EXT = 'rabbit'

/** 给 `<input type="file" accept>` 用 */
export const SPECIFIC_FILE_ACCEPT = `.${SPECIFIC_FILE_EXT}`

export const isSpecificFileName = (name: string): boolean =>
  name.split('.').pop()?.toLowerCase() === SPECIFIC_FILE_EXT
