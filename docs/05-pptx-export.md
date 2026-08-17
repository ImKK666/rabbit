# 05 · PPTX 导出与自研 OOXML Writer

对应 [04-changes.md](./04-changes.md) 的 **R-08 / R-17**，是决策 Q2 的最终方案。

## 一、结论

**保留 pptxgenjs 做基础生成，自研 OOXML writer 补它做不到的部分。导出留在前端，不迁 Python。**

```
PPTist Slide[]
     │
     ├─ ① pptxgenjs        9 种元素 → .pptx 字节流（沿用现有 useExport.ts 逻辑）
     │
     ├─ ② 自研 OOXML Writer  解包 → 注入 <p:timing> 动画树 → 重新打包
     │
     └─ ③ saveAs           可编辑且带原生动画的 .pptx
```

分工边界很清楚：**pptxgenjs 负责它擅长的（文本 / 图片 / 形状 / 图表 / 表格几何与样式），我们只负责它完全没有的（动画时间线）。** 不重写它已经做对的部分。

### 为什么不迁 Python

前一版方案曾建议把导出整条迁到 Python（`python-pptx` + `lxml`），理由是库更成熟。放弃的原因：

| | 迁 Python | **保留 pptxgenjs + 自研 writer** |
|---|---|---|
| 要重写的量 | 9 种元素的全部几何与样式逻辑 | 只写动画树 |
| 已解决的问题会丢 | `toAST` 富文本解析 · `toPoints` SVG 转几何 · latex 渲染成图 · 表格主题色推导 · `special` 形状退化 | **全部保留** |
| 离线导出 | ✗ 必须联服务端 | **✓ 纯前端** |
| 新增依赖 | Python 运行时 + 打包链路 | jszip（已是 pptxgenjs 的依赖） |

`useExport.ts` 里那些脏活是 PPTist 多年踩坑攒下来的，扔掉重写不划算。

## 二、已核实的事实

`pptxgenjs@3.12.0`，全部从 `node_modules/pptxgenjs` 读源码确认：

| 事实 | 依据 |
|---|---|
| **零动画支持** | 全部产物里 `grep -c "p:timing"` = **0**；`p:transition` 同样为 0 |
| 可拿到原始字节 | `write({ outputType })`，`JSZIP_OUTPUT_TYPE = 'arraybuffer' \| 'base64' \| 'binarystring' \| 'blob' \| 'nodebuffer' \| 'uint8array'` |
| **jszip 可用** | `dependencies: { jszip: '^3.7.1', image-size, https, @types/node }` |
| **能给形状打标记** | `objectName?: string`（`types/index.d.ts:1279`，v3.10.0 起取代旧字段） |
| objectName 落点 | 源码模板 `<p:cNvPr id="{idx+2}" name="{opt.objectName}">` |
| 形状 id 规律 | `id = idx + 2`（在该页对象列表中的序号），源码里有注释强调这个值必须连续 |
| **注入点** | slide XML 以 `…</p:clrMapOvr></p:sld>` 结尾 |

注入点符合 ECMA-376 对 `CT_Slide` 的顺序约束：

```
<p:sld>
  <p:cSld>…</p:cSld>          必需
  <p:clrMapOvr>…</p:clrMapOvr>  可选
  <p:transition/>              可选  ← 幻灯片切换，暂不做
  <p:timing/>                  可选  ← 我们要注入的位置
</p:sld>
```

所以直接在 `</p:clrMapOvr>` 之后、`</p:sld>` 之前插入即可，**不需要重排任何既有节点**。

⚠️ jszip 目前是**传递依赖**。要在我们代码里直接 import，应提升为直接依赖，避免 pptxgenjs 将来换实现时断掉。

## 三、最大的难点：elId → spid 映射

我们的动画条目引用的是 PPTist 的 `elId`（nanoid）：

```ts
PPTAnimation { elId: 'V3sQ1nB7xK', effect: 'fade-up', trigger: 'click', duration: 1000 }
```

而 OOXML 的动画目标引用的是形状的数字 id：

```xml
<p:tgtEl><p:spTgt spid="5"/></p:tgtEl>
```

**这两者之间没有天然联系。映射错了不会报错，只会让动画作用在错误的元素上。**

两条路：

| 做法 | 可靠性 |
|---|---|
| 依赖 `id = idx + 2` 的序号规律，构建时记录调用顺序 | 脆。pptxgenjs 内部可能插入占位符、跳号、或版本间改规则 |
| **给每个形状设 `objectName: element.id`，再从 XML 里按 `name` 反查 `id`** | **稳。标记由我们自己写入，自己读回** |

**采用后者。** 具体：

1. `useExport.ts` 里每次 `addText` / `addImage` / `addShape` / … 时传 `objectName: el.id`
2. 解包后解析 slide XML，扫所有 `<p:cNvPr id="X" name="Y">`，建 `Map<elId, spid>`
3. 写动画树时用这张表把 `elId` 翻成 `spid`
4. **查不到就跳过该动画并告警** —— 宁可少一个动画，不要作用错元素

⚠️ 需要验证：`objectName` 是否对全部 9 种元素类型都生效（图表和表格走的是 graphicFrame，可能是另一套 `<p:nvGraphicFramePr>`，属性名和位置都要单独确认）。

## 四、要写的 OOXML 动画结构

`<p:timing>` 内部是一棵时间节点树，大致形状：

```
<p:timing>
  <p:tnLst>
    <p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">
      <p:childTnLst>
        <p:seq concurrent="1" nextAc="seek">
          <p:cTn id="2" dur="indefinite" nodeType="mainSeq">
            <p:childTnLst>
              ── 每个「点击步」一个 <p:par>，nodeType 由 trigger 决定 ──
              ── 步内包含具体行为节点，targetEl 指向 spid ──
```

关键映射：

| 我们的字段 | OOXML |
|---|---|
| `trigger: 'click'` | `nodeType="clickEffect"` |
| `trigger: 'meantime'` | `nodeType="withEffect"` |
| `trigger: 'auto'` | `nodeType="afterEffect"` |
| `duration: 1000` | `<p:cTn dur="1000">`（毫秒） |
| `pptx.presetId` | `<p:cTn presetID="…">` |
| `pptx.presetClass` | `<p:cTn presetClass="entr\|emph\|exit">` |
| `pptx.presetSubtype` | `<p:cTn presetSubtype="…">` |
| `pptx.fade` | `<p:animEffect transition="in" filter="fade">` |
| `pptx.effectFilter: 'wipe'` | `<p:animEffect … filter="wipe(…)">` |
| `pptx.scaleFrom/To` | `<p:animScale>` 的 `<p:from>` / `<p:to>` |
| `pptx.rotateFrom/To` | `<p:animRot>` 的 `from` / `to` |
| `pptx.motion` | `<p:anim>` 对 `ppt_x` / `ppt_y` 做位移 |
| `elId` | `<p:tgtEl><p:spTgt spid="…"/></p:tgtEl>` |

`presetId` / `presetClass` / `presetSubtype` / `scaleFrom·To` / `rotateFrom·To` 的具体取值已经在 [`src/configs/animation.ts`](../src/configs/animation.ts) 的 `ANIMATION_DEFS` 里定好了（25 个效果全覆盖），writer 只负责把它们摆进正确的 XML 位置。

### ⚠️ 不要凭记忆写这棵树

上面的结构是方向性的，**嵌套细节、必需属性、节点先后顺序都很挑**，写错的典型表现是 PowerPoint 静默忽略整个 `<p:timing>`，或者弹「需要修复」。

**实施第一步必须是取得地面真相**：在 PowerPoint 里手工做几个只含单一动画的 .pptx（每种 presetClass 至少一个），解包读 `ppt/slides/slide1.xml`，照抄它的结构。这比读规范快得多也准得多。

```bash
unzip -o sample.pptx -d /tmp/s && xmllint --format /tmp/s/ppt/slides/slide1.xml
```

参考实现：[`refs/oh-my-ppt/src/main/animation/pptx-animation-map.ts`](../refs/oh-my-ppt) 只给出 preset 取值，**不含 XML 生成**（那部分在它闭源的 `@arcsin1/html2pptx` npm 包里）。所以 XML 这一层没有现成代码可抄，只能自己写。

## 五、分期实施

刻意把风险最高的一环（XML 正确性）放在最后，前面每一期都能独立验证。

| 期 | 内容 | 验收标准 |
|---|---|---|
| **E1** | 打包链路脚手架：`write({outputType:'arraybuffer'})` → jszip 解包 → **原样重新打包** → `saveAs` | 产出的 .pptx 与不经处理的完全等价，PowerPoint 正常打开。**先把 ZIP 环节的坑踩完，再碰 XML** |
| **E2** | `elId → spid` 映射：给 9 种元素都加 `objectName`，解析 XML 建表 | 单测：给定 deck，映射表覆盖全部元素且无重复；图表 / 表格单独确认 |
| **E3** | 地面真相采样：手工制作参考 .pptx，解包记录真实 XML，落到 `docs/upstream/` 旁边或测试固件里 | 每个 presetClass（entr / emph / exit）至少一份样本 |
| **E4** | Writer 打通一个效果（`fade`）端到端 | 导出的 .pptx 在 PowerPoint 里能看到淡入 |
| **E5** | 铺满 25 个效果 + trigger 时间线（click / meantime / auto 的串接） | 逐效果人工过一遍；时间线顺序正确 |
| **E6** | 校验与兜底：`exportBehavior` 为 `web-only` 时跳过并提示；spid 查不到时告警；`flatten` 语义落地 | 导出前给出动画损失清单 |

### 测试

Writer 的核心应写成**纯函数**：

```ts
buildTimingXml(animations: PPTAnimation[], spidMap: Map<string, number>): string
```

不碰 DOM、不碰 ZIP、不碰文件系统 —— 这样才能对着 E3 采集的地面真相做快照测试。

⚠️ **PPTist 目前没有测试框架**。OOXML 正确性恰恰是最不能靠肉眼检查的东西，建议在 E3 之前引入 vitest（Oh My PPT 用的也是 vitest + happy-dom，可参考其 `tests/unit/` 的组织方式）。

## 六、不在本次范围内

| 项 | 说明 |
|---|---|
| 幻灯片切换动画 | `Slide.turningMode` → `<p:transition>`。同一个注入机制能覆盖，但先把元素动画做完 |
| 图片 / PDF 导出 | 保持现状，`html-to-image` 现成，不需要 OOXML |
| PPTX **导入**的动画还原 | 反向解析 `<p:timing>` → `PPTAnimation`。上游 `pptxtojson` 是否处理动画未确认 ⚠️ |

## 七、风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| **OOXML 动画树写错，PowerPoint 静默忽略** | 高 | E3 先取地面真相；纯函数 + 快照测试；每期人工在 PowerPoint 里过 |
| **`elId → spid` 映射错位**（动画作用在错误元素上，且不报错） | 高 | 用 `objectName` 标记而非序号规律；查不到就跳过 + 告警 |
| 图表 / 表格的 `objectName` 可能不生效 | 中 | E2 单独确认 graphicFrame 的属性位置 |
| jszip 是传递依赖 | 低 | 提升为直接依赖 |
| pptxgenjs 升级改变 XML 输出 | 低 | 注入逻辑只依赖 `</p:clrMapOvr>` 锚点和 `name` 属性，都是 OOXML 规范约束的稳定结构；锁定次版本号 |

---

**前置依赖**：本方案不阻塞第二批（资产层 R-10 / R-11）和第三批（后端接管）。E1~E2 可以随时插入，E3 起需要一台装了 PowerPoint 的机器来采集地面真相。
