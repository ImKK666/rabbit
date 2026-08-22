import { describe, it, expect } from 'vitest'
import { ensureContentTypes } from '../contentTypes'

const TYPES_OPEN = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'

/** pptxgenjs 产物里那几条硬编码的 Default，够用即可 */
const baseXml = `${TYPES_OPEN}`
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="jpeg" ContentType="image/jpeg"/>'
  + '<Default Extension="png" ContentType="image/png"/>'
  + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
  + '</Types>'

describe('ensureContentTypes', () => {
  it('已被 Default 覆盖的扩展名不重复声明', () => {
    const result = ensureContentTypes(baseXml, ['ppt/media/image-1-2.png', 'ppt/slides/slide1.xml'])
    expect(result.added).toEqual([])
    expect(result.uncovered).toEqual([])
    expect(result.xml).toBe(baseXml)
  })

  it('已被 Override 覆盖的 part 不算缺失', () => {
    const result = ensureContentTypes(baseXml, ['ppt/presentation.xml'])
    expect(result.uncovered).toEqual([])
  })

  // 首字符就是点的 part：OPC 的 `_rels/.rels` 扩展名就是 rels，
  // 按「点必须在中间」去判会把包里每一份 .rels 都误报成缺内容类型
  it('.rels 这种整段是扩展名的 part 认得出来', () => {
    const result = ensureContentTypes(baseXml, ['_rels/.rels', 'ppt/slides/_rels/slide1.xml.rels'])
    expect(result.uncovered).toEqual([])
    expect(result.added).toEqual([])
  })

  // 背景图那条路 pptxgenjs 从不写声明，只靠硬编码的几条 Default 兜着 ——
  // 一张 webp 背景就足以让整个文件打不开
  it('补上未声明但认得出的扩展名', () => {
    const result = ensureContentTypes(baseXml, ['ppt/media/Slide-1-image-1.webp'])
    expect(result.added).toEqual(['webp'])
    expect(result.xml).toContain('<Default Extension="webp" ContentType="image/webp"/>')
    expect(result.uncovered).toEqual([])
  })

  it('同一扩展名只补一条', () => {
    const result = ensureContentTypes(baseXml, ['ppt/media/a.webp', 'ppt/media/b.webp'])
    expect(result.added).toEqual(['webp'])
    expect(result.xml.match(/Extension="webp"/g)).toHaveLength(1)
  })

  // 这正是本次事故的形状：asset URL 的域名带点，pptxgenjs 对整条路径
  // split('.') 后把 `com/rabbit/<hash>` 当成扩展名，产出一个无扩展名的 part
  it('无扩展名的 part 如实报出来，不假装补上了', () => {
    const orphan = 'ppt/media/Slide-1-image-1.com/rabbit/' + 'a'.repeat(64)
    const result = ensureContentTypes(baseXml, [orphan])
    expect(result.added).toEqual([])
    expect(result.uncovered).toEqual([orphan])
    expect(result.xml).toBe(baseXml)
  })

  it('认不出的扩展名不瞎声明', () => {
    const result = ensureContentTypes(baseXml, ['ppt/media/mystery.xyz'])
    expect(result.added).toEqual([])
    expect(result.uncovered).toEqual(['ppt/media/mystery.xyz'])
  })
})
