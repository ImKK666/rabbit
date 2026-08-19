/**
 * 层边界判据 —— `runtime/` 不得依赖 `domains/` 或装配层
 *
 * 这是 docs/11-agent-roadmap.md 第七节判据 1 的落地。
 *
 * 为什么需要它：拆层是一次纯搬家，搬完的那一刻边界是对的，
 * 但没有任何东西阻止下一次「顺手」在 runtime 里 import 一个 deck 的类型。
 * 等到阶段 D2 接第二个域时才发现地基被污染，已经晚了 ——
 * 那时候「接新域要改几处 runtime」这个唯一的验收判据已经被消解掉了。
 *
 * 抄的是 BitFun 的 `pnpm run check:core-boundaries`（见 docs/10 第 1.1 节）：
 * 它把 crate 依赖方向做成了 CI 检查，而不是写在文档里靠人自觉。
 *
 * ── 判定写成纯函数的理由 ──
 * `collectBoundaryViolations` 不读磁盘，只吃 { path, source } 数组。
 * 这样才能喂合成的违规输入验证它真的会红 —— 见文件末尾的负对照。
 * **全绿的检查器和没有检查器是一回事。**
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'

/** `runtime/` 不许依赖的两层：域，以及装配层 */
const RUNTIME_FORBIDS = ['@server/domains/', '@server/agent/'] as const

/**
 * `domains/` 不许依赖装配层。
 *
 * 域可以依赖 runtime（那是它的地基），域之间暂不互相依赖也不强制，
 * 但**域绝不能依赖装配层** —— 装配层的职责是把域接进 runtime，
 * 反向依赖会让「换一种装配方式」变成要改域的代码。
 */
const DOMAIN_FORBIDS = ['@server/agent/'] as const

export type SourceFile = { path: string; source: string }
export type BoundaryViolation = { path: string; specifier: string; reason: string }

/**
 * 抽出一个文件里所有 import / export-from 的模块说明符。
 *
 * 用正则而不是 TS AST：这里只需要认出字符串字面量，
 * 而拉一个 parser 进来会让这条检查本身变成需要维护的东西。
 * 覆盖 `import x from 'y'` / `import 'y'` / `export * from 'y'` / `import type ... from 'y'`。
 * **`import type` 一样要查** —— 类型依赖同样是依赖方向，
 * 编译期抹掉不代表设计上可以反向依赖。
 */
export const extractSpecifiers = (source: string): string[] => {
  const out: string[] = []
  const re = /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) out.push(m[1]!)
  return out
}

/**
 * 找出越界依赖。
 *
 * 两类都查：
 *   ① 别名形式 `@server/domains/...`、`@server/agent/...`
 *   ② 相对路径爬出 runtime/ 之后落进 domains/ 或 agent/ ——
 *      光查别名会漏掉 `../../domains/deck/kernel` 这种写法，
 *      而那正是「顺手改一下」最可能写出来的形状
 *
 * @param layerRoot 被守护的层根，仓库根的相对路径，如 `server/src/runtime`
 * @param forbidden 该层不许依赖的别名前缀
 */
export const collectBoundaryViolations = (
  files: readonly SourceFile[],
  layerRoot: string,
  forbidden: readonly string[] = RUNTIME_FORBIDS,
): BoundaryViolation[] => {
  const violations: BoundaryViolation[] = []
  /** 别名前缀换算成仓库根相对目录，供相对路径落点判断复用 —— 两处必须同源，否则会各守各的 */
  const forbiddenDirs = forbidden.map(p => p.replace('@server/', 'server/src/').replace(/\/$/, ''))

  for (const file of files) {
    for (const specifier of extractSpecifiers(file.source)) {
      const alias = forbidden.find(p => specifier.startsWith(p))
      if (alias) {
        violations.push({
          path: file.path,
          specifier,
          reason: `${layerRoot} 不得依赖 ${alias.replace('@server/', 'server/src/')}*`,
        })
        continue
      }

      if (!specifier.startsWith('.')) continue

      // 相对路径：解析成仓库根的相对路径再判断落点
      const landed = join(dirname(file.path), specifier)
      if (landed.startsWith(`${layerRoot}/`) || landed === layerRoot) continue

      const escaped = forbiddenDirs.find(d => landed.startsWith(`${d}/`))
      if (escaped) {
        violations.push({
          path: file.path,
          specifier,
          reason: `相对路径爬出 ${layerRoot} 落进 ${escaped}`,
        })
      }
    }
  }

  return violations
}

const REPO_ROOT = resolve(__dirname, '../../../..')

const readLayer = (layerRoot: string): SourceFile[] => {
  const abs = join(REPO_ROOT, layerRoot)
  const out: SourceFile[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.endsWith('.ts')) {
        out.push({
          path: relative(REPO_ROOT, full).replaceAll('\\', '/'),
          source: readFileSync(full, 'utf-8'),
        })
      }
    }
  }
  walk(abs)
  return out
}

describe('层边界：runtime/ 不依赖 domains/ 与装配层', () => {
  const files = readLayer('server/src/runtime')

  it('扫到了 runtime 层的文件（防止判据因为路径写错而空跑）', () => {
    // 没有这条，目录改名之后检查会「零文件、零违规、全绿」地静默失效
    expect(files.length).toBeGreaterThanOrEqual(5)
    expect(files.map(f => f.path)).toContain('server/src/runtime/llm.ts')
  })

  it('runtime/ 零越界依赖', () => {
    expect(collectBoundaryViolations(files, 'server/src/runtime')).toEqual([])
  })
})

describe('层边界：domains/ 不依赖装配层', () => {
  // 域可以依赖 runtime（那是地基），但反向依赖装配层会让
  // 「换一种装配方式」变成要改域的代码
  const files = readLayer('server/src/domains')

  it('扫到了 domains 层的文件（防止判据空跑）', () => {
    expect(files.length).toBeGreaterThanOrEqual(8)
    expect(files.map(f => f.path)).toContain('server/src/domains/deck/pipeline.ts')
  })

  it('domains/ 零越界依赖', () => {
    expect(collectBoundaryViolations(files, 'server/src/domains', DOMAIN_FORBIDS)).toEqual([])
  })

  it('负对照：域 import 装配层会被抓到', () => {
    const bad: SourceFile[] = [{
      path: 'server/src/domains/deck/pipeline.ts',
      source: "import { cancelAgentTask } from '@server/agent/orchestrator'\n",
    }]
    expect(collectBoundaryViolations(bad, 'server/src/domains', DOMAIN_FORBIDS)).toHaveLength(1)
  })

  it('域依赖 runtime 是允许的方向，不该误报', () => {
    const ok: SourceFile[] = [{
      path: 'server/src/domains/deck/pipeline.ts',
      source: "import { resolveMaxSteps } from '@server/runtime/budget'\n",
    }]
    expect(collectBoundaryViolations(ok, 'server/src/domains', DOMAIN_FORBIDS)).toEqual([])
  })
})

describe('负对照：判据本身真的会红', () => {
  // 全绿的检查器和没有检查器是一回事 —— 这一组喂的是合成的违规输入
  it('抓得到别名形式的越界', () => {
    const bad: SourceFile[] = [
      {
        path: 'server/src/runtime/llm.ts',
        source: "import { applyLayout } from '@server/domains/deck/layouts'\n",
      },
    ]
    const found = collectBoundaryViolations(bad, 'server/src/runtime')
    expect(found).toHaveLength(1)
    expect(found[0]!.specifier).toBe('@server/domains/deck/layouts')
  })

  it('抓得到装配层的越界', () => {
    const bad: SourceFile[] = [
      {
        path: 'server/src/runtime/budget.ts',
        source: "import { runAgentTask } from '@server/agent/orchestrator'\n",
      },
    ]
    expect(collectBoundaryViolations(bad, 'server/src/runtime')).toHaveLength(1)
  })

  it('抓得到相对路径爬出去的越界（别名检查漏掉的那种）', () => {
    const bad: SourceFile[] = [
      {
        path: 'server/src/runtime/history.ts',
        source: "import type { DeckState } from '../domains/deck/tools'\n",
      },
    ]
    const found = collectBoundaryViolations(bad, 'server/src/runtime')
    expect(found).toHaveLength(1)
    expect(found[0]!.reason).toContain('相对路径爬出')
  })

  it('`import type` 同样算越界 —— 类型依赖也是依赖方向', () => {
    const bad: SourceFile[] = [
      {
        path: 'server/src/runtime/llm.ts',
        source: "import type { DeckState } from '@server/domains/deck/tools'\n",
      },
    ]
    expect(collectBoundaryViolations(bad, 'server/src/runtime')).toHaveLength(1)
  })

  it('`export ... from` 也要抓 —— 转出去和引进来是同一个方向', () => {
    const bad: SourceFile[] = [
      {
        path: 'server/src/runtime/index.ts',
        source: "export { buildLayout } from '@server/domains/deck/layouts'\n",
      },
    ]
    expect(collectBoundaryViolations(bad, 'server/src/runtime')).toHaveLength(1)
  })

  it('层内相对 import 与外部依赖不误报', () => {
    const ok: SourceFile[] = [
      {
        path: 'server/src/runtime/llm.ts',
        source: [
          "import { createOpenAI } from '@ai-sdk/openai'",
          "import { normalizeBaseUrl } from './baseUrl'",
          "import { db } from '@server/db'",
          "import type { Slide } from '@/types/slides'",
          "import { z } from 'zod'",
        ].join('\n'),
      },
    ]
    expect(collectBoundaryViolations(ok, 'server/src/runtime')).toEqual([])
  })
})

describe('extractSpecifiers', () => {
  it('认得出四种写法', () => {
    const source = [
      "import a from 'x1'",
      "import 'x2'",
      "export * from 'x3'",
      "import type { T } from 'x4'",
    ].join('\n')
    expect(extractSpecifiers(source)).toEqual(['x1', 'x2', 'x3', 'x4'])
  })

  it('不把普通字符串误当成 import', () => {
    // 「注释里写了 import 字样」和「字符串里出现路径」都不该命中
    const source = [
      "const msg = 'import from @server/domains/deck/kernel'",
      '// import { x } from "@server/agent/orchestrator" —— 这行是注释',
    ].join('\n')
    expect(extractSpecifiers(source)).toEqual([])
  })
})
