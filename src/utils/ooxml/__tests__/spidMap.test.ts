import { describe, it, expect } from 'vitest'
import { parseSpidEntries, buildSpidMap } from '../spidMap'

const SLIDE_XML_FIXTURE = `
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="V3sQ1nB7xK"/>
          <p:cNvSpPr/>
          <p:nvPr/>
        </p:nvSpPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="3" name="aB9cDeFgHi"/>
          <p:cNvSpPr/>
          <p:nvPr/>
        </p:nvSpPr>
      </p:sp>
      <p:pic>
        <p:nvPicPr>
          <p:cNvPr id="4" name="xY7zW2kLmN"/>
          <p:cNvPicPr/>
          <p:nvPr/>
        </p:nvPicPr>
      </p:pic>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>
`

describe('parseSpidEntries', () => {
  it('extracts all named cNvPr entries (skipping empty names)', () => {
    const entries = parseSpidEntries(SLIDE_XML_FIXTURE)
    expect(entries.length).toBe(3)
  })

  it('excludes the group root (id=1) because its name is empty', () => {
    const entries = parseSpidEntries(SLIDE_XML_FIXTURE)
    const root = entries.find(e => e.spid === 1)
    expect(root).toBeUndefined()
  })

  it('parses spid and name correctly', () => {
    const entries = parseSpidEntries(SLIDE_XML_FIXTURE)
    const text = entries.find(e => e.spid === 2)
    expect(text).toEqual({ spid: 2, name: 'V3sQ1nB7xK' })
  })

  it('handles self-closing cNvPr tags', () => {
    const xml = '<p:cNvPr id="5" name="selfClose123"/>'
    const entries = parseSpidEntries(xml)
    expect(entries).toEqual([{ spid: 5, name: 'selfClose123' }])
  })
})

describe('buildSpidMap', () => {
  it('builds elId → spid map from slide XML', () => {
    const map = buildSpidMap(SLIDE_XML_FIXTURE)
    expect(map.get('V3sQ1nB7xK')).toBe(2)
    expect(map.get('aB9cDeFgHi')).toBe(3)
    expect(map.get('xY7zW2kLmN')).toBe(4)
  })

  it('does not include entries with empty name', () => {
    const map = buildSpidMap(SLIDE_XML_FIXTURE)
    expect(map.has('')).toBe(false)
  })

  it('returns empty map for XML without cNvPr', () => {
    const map = buildSpidMap('<p:sld></p:sld>')
    expect(map.size).toBe(0)
  })

  it('first occurrence wins on duplicate names', () => {
    const xml = '<p:cNvPr id="2" name="dup"/><p:cNvPr id="3" name="dup"/>'
    const map = buildSpidMap(xml)
    expect(map.get('dup')).toBe(2)
  })
})
