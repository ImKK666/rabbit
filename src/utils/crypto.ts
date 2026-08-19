import CryptoJS from 'crypto-js'

/**
 * 专属文件（`.rabbit`）的加解密。
 *
 * 说明白一点：**这不是安全措施，是混淆。** 密钥就写在这里，会原样打进前端产物，
 * 任何人打开 devtools 都能拿到。它的作用只是让导出的文件不是一眼可读的明文，
 * 所以换个密钥值不改变任何安全性质。
 *
 * **不兼容旧密钥。** 改名前导出的文件、以及上游 PPTist 的 `.pptist` 文件解不开，
 * 这是有意的（见 `configs/specificFile.ts`）。
 */
const CRYPTO_KEY = 'rabbit'

/**
 * 加密
 * @param msg 待加密字符串
 */
export const encrypt = (msg: string) => {
  return CryptoJS.AES.encrypt(msg, CRYPTO_KEY).toString()
}

/**
 * 解密
 * @param ciphertext 待解密字符串
 */
export const decrypt = (ciphertext: string) => {
  const bytes = CryptoJS.AES.decrypt(ciphertext, CRYPTO_KEY)
  return bytes.toString(CryptoJS.enc.Utf8)
}
