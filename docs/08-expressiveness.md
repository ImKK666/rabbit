# 08 · 表现力升级

**问题**：agent 产出的 PPT 和动画「太没有新意」。

这不是玄学，有五个可指认的技术原因。本文是诊断 + 规划，执行交给后续会话。

前置阅读：[04-changes.md](./04-changes.md)（改动清单）· [05-pptx-export.md](./05-pptx-export.md)（导出方案）· [03-architecture.md](./03-architecture.md) 第六节（动画决策）

## 一 · 诊断

### ① 零图片能力 —— 最大的一条

后端一个图片工具都没有。`asset://` 解析器和 pending 骨架屏在前端早就就绪（R-10 / R-11），但 agent 手里没有 `searchImage` / `generateImage`，也不知道任何可用 URL，**所以每一份 deck 都是纯文字**。纯文字排得再好也像 Word 大纲。

### ② 25 个动画在 OOXML 层面只有 5 种行为

`src/configs/animation.ts` 里 25 个 effect，实际只映射到 **5 个 presetId**：

| presetId | 用了几次 | 承担的效果 |
|---:|---:|---|
| 2 | 10 | fade-up/down/left/right · slide-×4 · fly-in · exit-fly |
| 6 | 6 | scale-in · zoom-in · exit-scale · exit-zoom · … |
| 31 | 5 | pulse-×3 · grow-shrink-×3 |
| 5 | 2 | wipe · exit-wipe |
| 10 | 2 | fade · exit-fade |

**5 个预设 × 方向/缩放/淡入参数 = 25 个标签。** 换的只是参数，观感当然雷同。

更要命的是 `PptxAnimationPreset.effectFilter` 的类型是**单个字面量**：

```ts
effectFilter?: 'wipe'        // src/configs/animation.ts
```

`buildTimingXml.ts:140` 里也只有这一个分支：

```ts
if (preset.effectFilter === 'wipe') { … filter = `wipe(${dir})` }
```

而 OOXML `<p:animEffect filter="...">` 的标准词表有二十来个（blinds / checkerboard / circle / diamond / dissolve / plus / randombar / wedge / wheel / strips / box / split / barn …），**每一个都是 PowerPoint 原生、导出必然能放**。泛化这个分支大约十行代码。

**好消息**：writer 其实已经实现了 `animRot`（旋转，`buildTimingXml.ts:217`）和 `presetSubtype`（`:234`），只是词表里几乎没用起来。能力是有的，词表没跟上。

### ③ prompt 在主动劝退形状

`server/src/agent/roles.ts` 的 `CANVAS_CONTEXT` 里三条硬指引：

> 「圆角矩形不容易用 path 表达，**可以改用 text 元素带 fill 属性来代替卡片效果**」
> 「做卡片效果用 text 元素 + fill 属性，**不要用 shape 叠 text**」
> 「用 setSlideBackground 设置页面背景色，**不要用铺满画布的 shape**」

于是每页都是「文本框 + 背景色」。而 `src/configs/shapes.ts` 有 **151 个现成形状**（矩形 / 常用形状 / 箭头 / 其他形状 / 线性，全带 SVG path），**agent 完全不知道它们存在**。

这三条当初是为了绕开「agent 写不对 SVG path」，代价是把表现力砍到只剩色块。

### ④ 没有版式词汇，也没有设计系统

Planner 的输出格式是 `{action, target, detail}` —— 操作步骤，不是版式。全流程没有任何「对称 / 非对称 / 大图压字 / 时间轴 / 对比 / 网格」的概念，也没有字号阶梯、间距节奏、颜色角色分配。

prompt 里那个 `36px 标题 / 20px 卡片标题 / 14px 正文` 的示例，模型会照抄到天荒地老。

### ⑤ 页面转场完全没接

`SLIDE_ANIMATIONS` 有 12 种转场，但 `<p:transition>` 导出是零支持（`src/hooks/useExport.ts` 开头的注释自己写着），agent 也没有对应工具。整整一个动画品类缺席。

## 二 · 已定决策

| | 决策 | 结论 |
|---|---|---|
| **P1** | 图片能力 | **本轮不实现**。只做形状 / 图标 / 图表。**但要把图库检索和生图的接口留出来**，标 TODO |
| **P2** | 动画扩容与 PowerPoint 验证的顺序 | **直接批量扩，最后一起验**。风险见第五节 |
| **P3** | 本轮范围 | 三条线 A / B / C 全做 |

## 三 · 三条工作线

```
A · 动画扩容（全部必须可导出）
  A1  泛化 effectFilter：'wipe' → 完整 OOXML filter 词表
  A2  扩 presetId：现只有 5 个，用起已实现的 animRot / presetSubtype
  A3  每个新效果补一份 CSS keyframes（animation-extra.scss）
  A4  页面转场接进导出：12 种 → <p:transition>，加 setSlideTransition 工具
  A5  buildTimingXml 单测同步扩（现 31 个）

B · 工具扩容（现 15 个）
  B1  图片        searchImage / generateImage —— 本轮只定接口，标 TODO
  B2  形状        addShape，按名字从 151 个形状库选，不让 agent 写 SVG path
  B3  图表        addChart（PPTist 原生支持，configs/chart.ts 已有配置）
  B4  表格        addTable
  B5  线条        addLine（分隔线 / 箭头 / 连接线，configs/lines.ts）
  B6  版式        applyLayout(slideId, pattern) —— 语义版式模板
  B7  排版        alignElements / distributeElements —— 纯几何，便宜且立竿见影
  B8  转场        setSlideTransition

C · prompt 重写（「没新意」主要靠这条治）
  C1  CANVAS_CONTEXT：删掉三条「别用 shape」，换成形状库 + 版式词汇
  C2  设计系统：字号阶梯、间距栅格、颜色角色（主 / 辅 / 强调 / 背景 / 文字）
  C3  Planner：输出改成「每页选一个版式 + 内容」，不再是操作步骤流水账
  C4  Generator：多样性压力 —— 同一份 deck 内相邻页不得复用同一版式
  C5  Reviewer：从「几何合法」升级到「设计质量」（留白、对齐、层次、对比度）
  C6  15 个工具的 description 逐条重写
```

### A 线的关键情报

**别指望抄 Oh My PPT。** `refs/oh-my-ppt/src/main/animation/pptx-animation-map.ts` 虽然有 438 行，但**它覆盖的也正好是那 5 个 presetId**（2 / 5 / 6 / 10 / 31）。这条参考路已经走到头了。

剩下两条可靠来源：

1. **ECMA-376** 对 `CT_TLAnimateEffectBehavior` / `presetID` 的定义
2. **反解地面真相** —— 在 PowerPoint 里手工做一份带目标动画的 PPTX，解压读 `ppt/slides/slideN.xml` 的 `<p:timing>`。这是唯一能 100% 确认 presetId 和 filter 写法的办法

第 2 条同时也是 A4 的做法：转场的 `<p:transition>` 结构照样可以这么反解。`useExport.ts` 的注释里已经记了 ECMA-376 对 `CT_Slide` 的顺序约束：`cSld → clrMapOvr → transition → timing`，插入点是确定的。

### B1 图片接口（本轮只定义，不实现）

按 [03-architecture.md](./03-architecture.md) 第五节的设计，接口形状定死、实现留空：

```
plan_asset({ kind: 'image' | 'icon', prompt, targetBox: {width, height},
             fit: 'cover' | 'contain', elementId })
  → 立即返回 asset://pending/<id>，任务入队
  → 完成后一个 patch 把 pending 换成 asset://<sha256>
  → 前端 pending 状态渲染骨架屏（已实现）
```

**本轮不要把这两个工具注册给 LLM** —— 一个永远返回「未接入」的工具只会白白浪费 agent 的步数预算。定义类型和 provider 接口、留 `TODO` 标记即可。

### C 线的版式词表（建议起点，执行时可增删）

| 页型 | 版式 |
|---|---|
| 封面 | 大标题居中 · 左文右图 · 全幅背景压字 |
| 目录 | 编号列表 · 网格卡片 |
| 内容 | 单点强调（大数字/大字）· 二栏对比 · 三栏并列 · 时间轴 · 流程箭头 · 大图压字 · 图表主导 · 引用语 |
| 转场 | 章节号 + 标题 |
| 结尾 | 致谢 · 联系方式 |

## 四 · 验收标准

「有没有新意」是主观的，但可以拆出几条能自动检查的：

| 检查 | 判据 | 方式 |
|---|---|---|
| 版式多样性 | 同一份 deck 内相邻页不使用同一版式 | 可写进 Reviewer / lint |
| 非文本元素 | 每页至少含一个形状 / 图表 / 线条 | 自动 |
| 动画多样性 | 单份 deck 用到的 effect 种类 ≥ 3，且不全是 fade 系 | 自动 |
| 导出保真 | 新增效果在真实 PowerPoint 里能正常播放 | **人工，只能你来** |
| 主观 | 你看着不再无语 | 你说了算 |

前三条建议直接落成 `lintDeck` 的新规则或 Reviewer 的检查项 —— 变成机器能判的，才不会退化。

## 五 · 风险

**E3 地面真相仍未做。** 现有 25 个效果从来没在真实 PowerPoint 里打开验证过，只有 31 个单测背书 —— 而单测只能证明 XML 长得符合预期，证明不了 PowerPoint 认。

按决策 P2 直接批量扩容，意味着如果 `<p:timing>` 的基础结构有问题，错误会被放大数倍。**缓解办法：扩容过程中每加一类 filter 就导出一份最小样本留档，最后集中在 PowerPoint 里逐个过**，这样出问题时能二分定位，而不是面对一个全红的 60 效果矩阵。

次要风险：

- **收紧的校验闸门会挡住新元素类型** —— `server/src/agent/kernel.ts` 的 `PASSTHROUGH_ELEMENT_TYPES` 目前只对 chart / table 做基础几何校验。B3 / B4 落地时要补严格 schema，否则等于开了后门
- **工具数量膨胀** —— 现 15 个，B 线做完约 23 个。每个工具的 description 都占 system prompt，工具越多模型选择越容易犯迷糊。C6 重写描述时要连带考虑「哪些工具该合并」
- **步数预算** —— Generator 现在 48 步。版式变复杂、元素变多之后要重新评估
