# 15 · 两份参考的借鉴、版式扩展决策规则与透明通道接入

前置：本文是 R-60（风格趋同五件套）的续篇。前两节是对
`refs/skills/` 里两份参考的分析摘录（完整材料在 refs 里，不入版本控制），
后两节是据此立下的 Rabbit 自己的规则与接入设计。

## 一 · 两份参考各给什么

### GordenSuperPPTSkills（`refs/skills/06-image-gen/`）

**思路**：让图像模型当"画师"——先生成每页一张海报级成品图（阶段 A），
再把图片逆向拆成四层还原成可编辑 PPTX（阶段 B）：

```
背景图(复刻/擦除) + 框架图(绿幕提取,含一切图表图形+填充+辉光) + 图标/艺术字(方格表→切片) + 文字(GPT 视觉→真文本框)
```

**提示词侧值得抄的**（`image-prompt-guide.md`）：

1. **内容优先**：「排版太简单几乎都是每页内容太薄」—— 每页 ≥4 模块 ×
   (标题+2~3 要点+1 特大指标) ≈ 20+ 信息点；内容不够先做厚内容，
   绝不用放大字号填白、绝不编数据。→ **R-61 已进 prompt**（内容密度基线）
2. **每页一个不重复的复杂视觉框架**：结构→形式映射表（房子型/莫比乌斯环/
   Bento/同心圆雷达/鱼骨/漏斗/金字塔/仪表盘…）。→ **R-61 已落 3 个
   内容结构型版式**（quadrant / funnel / pyramid），其余见下一节决策规则
3. **出图铁律**：画面描述与 verbatim 文字必须合并出图，占位符图判失败重出
4. **QA 硬门禁**：`layout_guard` 拦混合坐标系（缩略图量坐标 + 源图尺寸）、
   拦全粗体正文（>85% bold）、拦小字号（<6pt）；`placement_qa` /
   `visual_compare_qa` 把 bbox 画回源图做视觉对位。→ **R-61 已抄
   全粗体/小字号两条**（lint ⑪）；坐标系那条 Rabbit 单一坐标系天然成立

**QA 反馈环**是它最值钱的部分：每页至少一轮「合成预览 → 对位检查 → 修
layout → 再合成」，且承认「生成层会漂移」，贴层文字按**最终生成图**的
视觉锚点回校，而不是按源图 bbox。

### ppt-agent-workflow-san（`refs/skills/03-agent-frameworks/`）

**思路**：把 PPT 当工程做。两个 skill 串一条线：先出**可审阅的中间产物
停下来等人确认**（ppt-workflow），再 preset 驱动转可编辑 PPTX
（html-slide-to-pptx）。

**值得抄的**：

1. **约束流程，不约束实现**（"Constrain the workflow, not the
   implementation"）—— skill 只定义「什么时候必须停、必须问、必须说
   局限」，工具选型留给宿主 agent。这正是 Rabbit runtime/domains 分层的同款哲学
2. **策划稿这个缺失的中间层**：大纲直接跳到成片是质量损失的主源；
   逐页策划卡（目的/观众记住什么/证据/表达形式/层级）是最大的实际收益
3. **Review gate**：对外/管理层/销售/技术密集/事实易变的稿子必须出中间
   产物停下来确认。→ **R-61 已接**（`askUser` 全链路）
4. **诚实降级**：环境缺调研就明说 source-limited，绝不装成调研过
5. **preset 决策规则**：复用/扩展/新建的判据是「页面家族 = 信息架构」，
   不是"长得像"。→ 下一节原样移植成 Rabbit 的版式扩展规则

## 二 · 版式扩展决策规则（移植 preset-decision-rules）

版式库（`LAYOUT_PATTERNS`）是 Rabbit 的"preset 库"。加新版式 / 新变体 /
新风格之前，先按这套判。**判据是信息架构，不是视觉相似。**

| 改动 | 什么时候可以 | 什么时候不行 |
|---|---|---|
| **复用**现有版式 | 只是字数/标签/条数在小范围变化 | — |
| **变体 B**（`LAYOUT_VARIANTS`） | 同一信息架构的另一种**成熟结构**：区域顺序不变、对象语法不变，只是局部排法不同（卡片网格 vs 分栏无卡） | 区域顺序变了、叙事类型变了、需要按页打补丁才能塞进去 |
| **新版式**（`LAYOUT_PATTERNS` + meta + builder + 判据） | 内容结构在库里**没有对应物**（R-61 的象限/漏斗/金字塔正是这种：之前 SWOT/转化/层级只能塞进 bullets/cards，结构表达不出来） | 只是配色/字号/装饰不同 —— 那是 style / signature 的地盘，不是版式的地盘 |
| **新质感档位**（`PALETTE_STYLES`） | 一种**场合**（editorial/soft 补的是「有观点」与「温柔」两种没被覆盖的场合） | 想换一批"更好看的色"—— 色值由锚点色派生，不是档位 |

**红旗（= 必须新版式）**：①「看着像，但内容逻辑不同」；②「强制特例三处
就能塞进去」；③ builder 里出现按页/按内容硬编码的分支；④ QA 判据要另写一套。
**最后一条原则：宁可要一个诚实的小版式，也不要一个聪明但不诚实的复用。**

判据义务（新加版式必须过的）：`layouts.test.ts` 的 metadata / 最大条数
不溢出（clampedIds 为空）/ 动画全覆盖 / 出场顺序三规则 / 暗色主题可读 /
id 稳定；`layoutImage.test.ts` 的图片位表同步更新。

## 三 · GPT 生图接口调研（2026-08 时点）

来源：[openai/codex PR #37788（原生透明迁移）](https://github.com/openai/codex/pull/37788)、
[openai/skills 的 image-api.md](https://github.com/openai/skills/blob/main/skills/.system/imagegen/references/image-api.md)、
[fal 的 GPT Image 2 vs 1.5 对比（2026-05 更新）](https://fal.ai/learn/tools/gpt-image-2-vs-gpt-image-1-5)、
[OpenAI 社区透明背景讨论](https://community.openai.com/t/having-trouble-getting-transparent-backgrounds-in-chatgpt-images/1380143)。

**结论一句话：透明通道是"完善"的 —— 而且官方已经从绿幕路线整条迁到原生 alpha。**

### 模型线

| 模型 | 透明通道 | 说明 |
|---|---|---|
| `gpt-image-2` | ❌ 不支持 `background=transparent` | 最新旗舰；支持 3840×2160；edit 恒定 high fidelity |
| **`gpt-image-1.5`** | ✅ **`background: transparent` + `output_format: png/webp`** | 官方指定透明输出的模型；`input_fidelity` 可切；1024² high ≈ $0.133/张（Image 2 ≈ $0.211） |
| `gpt-image-1` / `gpt-image-1-mini` | 见 API 文档，1.5 是当前推荐 | 旧档 / 轻量档 |

### Generations 端点（`POST /v1/images/generations`）

- 参数：`model` / `prompt` / `n`(1-10) / `size`(1024²·1536×1024·1024×1536·auto)
  / `quality`(low·medium·high·auto) / **`background`(transparent·opaque·auto)**
  / `output_format`(png·jpeg·webp) / `output_compression` / `moderation`
- **`background` 是"输出透明行为"，与提示词里的场景背景是两个东西** ——
  拼提示词时不要混

### Edits 端点（`POST /v1/images/edits`）

- 最多 **16 张输入图**；`gpt-image-1.5` 高保真保留**前 5 张**
- `mask` 可选，**提示词引导、形状不保证精确**
- `input_fidelity`：low（默认）/ high；high 显著增加输入 token
- 输入图与 mask 均须 < 50MB
- 文档未见 edits 输出的 `background: transparent`（编辑通常保留原背景）——
  **"提取式"出透明层仍要绿幕，原生透明只覆盖"从零生成"这一侧**

### 对 Rabbit 的三个直接结论

1. 装饰层 / 底图是"从零生成"→ **可以直接要原生透明**，绿幕及其全部风险
   （褪色/丢线/键色撞色，docs/14 实测过的那一堆）可以退役
2. "提取式"（从渲染截图剥框架图）走 edits → 没有透明输出 → 若做这条
   仍用现有 `chromaKey.ts`
3. 代码里 provider 是"一个 baseUrl + 一个模型名"的自由配置（`asset_sources`
   表），**接入 1.5 不需要新代码路径**，只需要 provider 配 `gpt-image-1.5`
   + 请求体带 `background` / `output_format`

## 四 · 「透明通道图片做排版」的接入设计

目标（决策者原话）：接入 image2 那套思路，生产透明通道的图片来做排版。
红线（docs/11）：排版结构仍由确定性代码出，图片层只承载"质感"，不承载"结构"。

### 路线：原生 alpha 优先，绿幕保底

| | 原生 alpha（`background=transparent`） | 绿幕抠图（现有 `chromaKey.ts`） |
|---|---|---|
| 适用 | **从零生成**：装饰层、底图、图标表、贴图素材 | **提取式**：从渲染图剥层；或 provider 不支持 transparent 时 |
| 质量 | 模型自带的边缘 alpha，无褪色无丢线 | 保色保线已实测，但键色撞色/细线风险是结构性的 |
| 判据 | 保留 O1（不压文字）；**O2「必须是纯色底」退役**；新增「alpha 通道真实存在且角落透明」 | 现有全套 O1~O5 |
| 成本 | 一样 | 一样 |

### 三个落地形态（按顺序）

**① 装饰层升级（改动最小，收益直接）**
`generateBackdrop` / `addOrnament` 的提示词删掉纯色底要求，改为
「transparent background, output PNG with alpha」；provider 为
gpt-image-1.5 时请求带 `background:'transparent'`、`output_format:'png'`；
provider 不透明能力时自动回落绿幕（配置里加 `supportsAlpha` 位）。
装饰层省掉键色、`chromaKey` 调用与 O2 判定；backdrop 不透明无感。

**② 图标表生成（新工具 `generateIconSet`，Rabbit 目前完全没有的能力）**
语义清单（「盾牌 / 增长箭头 / 灯泡 …」+ 目标色）→ 透明底 N×N 网格 →
**按 alpha 连通域切片**（现有 `slice_grid` 思路，纯函数）→ 每枚一个
`asset://` 图标资产 → agent 用 `addElement` 摆进页面。
判据：网格不画分割线、每格元素完整不粘连、切片后 alpha 连通域数 ==
请求数、无文字。这是 Gorden B4 在红线内的合法形态 —— 图标是装饰不是结构。

**③ 框架/质感层（最后做，最要小心）**
"整页透明 PNG 的装饰性框架"（面板描边、缎带、连接线）叠在版式之上。
**红线内做法的关键**：框架图只许画"不承载结构的质感"（描边粗细、阴影、
纹理），不允许它代替版式引擎的几何（卡片位置/尺寸仍由 `applyLayout` 出）。
落法：以版式的元素坐标生成**负空间装饰框架**（复用 `occupiedRectsOf`），
但只允许描边与纹理、禁止实心色块 —— 判据在 `lintOrnament` 同款：
占用矩形内平均 alpha 上限收紧到个位数，且实心色块占比判不合格。

### 待办（04-changes 待完成表）

| 项 | 优先级 |
|---|---|
| asset_sources / 生图运行时加 `supportsAlpha`，generations 请求带 `background/output_format` | 高 |
| 装饰层原生 alpha 改造 + 判据替换（O2 退役） | 高 |
| `generateIconSet`（透明图标表 + 切片） | 中 |
| 框架/质感层 | 低（先看前两项效果） |

---

调研时间：2026-08-21。API 参数以
[openai/skills 的 image-api.md](https://github.com/openai/skills/blob/main/skills/.system/imagegen/references/image-api.md)
为准，模型支持面以当日各来源交叉核对。
