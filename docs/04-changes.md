# 04 · PPTist 改动清单

**仓库根目录就是** [PPTist](https://github.com/pipipi-pikachu/PPTist) v2.0.0 的 fork（浅克隆自 `refs/PPTist`，HEAD `e491258` / 2026-08-16，已剔除 `.git`）—— 单体仓库，前端直接在根，后续组件（Deck Kernel、FastAPI 后端）也并进来。**AGPL-3.0，`LICENSE` 必须保留。**

PPTist 自带的文档已并入 [`docs/upstream/`](./upstream/)（`AI_PPT_SCHEMA.md` 等），避免和本项目的 `docs/` 混淆。

本文是改动的**唯一权威清单**。代码里的 `TODO(R-NN)` 标记对应这里的编号。

设计依据见 [03-architecture.md](./03-architecture.md)。

## 已定的四个决策

| | 问题 | 结论 |
|---|---|---|
| Q1 | 动画词表约束层级 | **前端也砍**，92 → 26，`effect` 收窄成联合类型，编译期拦非法值 |
| Q2 | PPTX 动画导出 | **保留 pptxgenjs 做基础生成，自研 OOXML writer 注入 `<p:timing>` 动画树。导出留在前端，不迁 Python。** 完整方案见 [05-pptx-export.md](./05-pptx-export.md) |
| Q3 | 旧 AI 路径 | **保留并改造成 agent 工具** `fillFromTemplate`，自由式失败时可回退 |
| Q4 | 变更下发方式 | **整份 deck 替换**（`setSlides`），MVP 不做细粒度 patch |

## 改动清单

状态：`○` 未开始 · `◐` 进行中 · `●` 完成

### 接口层

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-01** | `src/services/index.ts:11` | `SERVER_URL` 从 `https://server.pptist.cn` 改指自建后端 | ○ |
| **R-02** | `src/services/index.ts` | 新增 agent 通道：任务提交 + SSE 事件流 + 整份 deck 下发 | ○ |

### 数据模型

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-03** | `src/types/slides.ts` | `PPTAnimation` 加 `exportBehavior?: 'native' \| 'web-only' \| 'flatten'`；新增 `AnimationExportBehavior` 类型 | ● |
| **R-04** | `src/types/slides.ts` | `PPTAnimation.effect` 从 `string` 收窄成 `AnimationEffect` 联合类型（**25 个**，不是 26 —— `path` 运动路径 PPTist 无对应概念，排除） | ● |
| — | `PPTImageElement.src` | **零改动** —— 本来吃任意字符串，`asset://` 是纯约定 | ● |

### 变更入口

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-05** | `src/store/slides.ts` | 级联删除孤儿动画。新增 `pruneOrphanAnimations()`，在 **`updateSlide` 和 `deleteElement` 两处**都调<br>⚠️ **踩坑记录**：UI 的元素删除**不走 `deleteElement`**，走的是 `updateSlide({ elements })`（`hooks/useDeleteElement.ts:28`）。只修 `deleteElement` 会完全漏掉真实路径 | ● |
| **R-06** | `src/store/slides.ts` | 加 `version: number`，每次变更自增，用于和服务端对齐、防覆盖 | ● |

### 动画

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-07** | `src/configs/animation.ts` | **92 → 25**，整体重写。每项带 `cssClass`（网页）+ `pptx`（`presetId` / `presetClass` / `presetSubtype` / `motion` / `scaleFrom·To` / `rotateFrom·To` / `fade` / `effectFilter`）。新增 `ANIMATION_DEFS` 扁平表、`getAnimationCssClass()`、`isAnimationEffect()` | ● |
| **R-21** | `src/assets/styles/animation-extra.scss`（新）<br>`src/main.ts` | 补齐 animate.css 无法表达的 **12 个**效果：擦除（animate.css 完全没有）、缩放强度分级、旋转进入、强调强度分级。全部挂 `animate__` 前缀 —— 换前缀会让 `useExecPlay` 按前缀移除类名的清理逻辑失效 | ● |
| **R-22** | `views/Screen/hooks/useExecPlay.ts`<br>`views/Editor/Toolbar/ElementAnimationPanel.vue` | `effect` 不再等于 CSS 类名，改经 `getAnimationCssClass()` 解析（共 4 处）；`addAnimation` / `updateElementAnimation` / `runAnimation` 的 `effect` 参数类型收窄 | ● |
| **R-15** | 新增 | `addAnimation({elId, effect, after?})` —— 不给 agent 裸数组，插入位置有语义 | ○ |
| **R-16** | 新增 | `applyAnimationPreset(slideId, 'sequential-fade' \| 'title-then-content' \| 'none')` —— agent 选意图，kernel 展开成合法时间线 | ○ |

### 导出

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
**方案见 [05-pptx-export.md](./05-pptx-export.md)**（分 E1~E6 六期，含已核实的 pptxgenjs 能力边界）。

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-08** | `src/hooks/useExport.ts` | **保留 pptxgenjs 不动**，仅在每次 `addText` / `addImage` / `addShape` / … 时补 `objectName: el.id`（用于 `elId → spid` 映射），导出末尾接入 OOXML 后处理 | ○ |
| **R-17** | `src/utils/ooxml/`（新） | 自研 OOXML writer：jszip 解包 → 注入 `<p:timing>` → 重新打包。核心是纯函数 `buildTimingXml(animations, spidMap)` | ○ |
| **R-23** | `package.json` | `jszip` 提升为直接依赖（现在只是 pptxgenjs 的传递依赖） | ○ |
| **R-24** | 工程 | 引入 vitest —— OOXML 正确性无法肉眼检查，必须对地面真相做快照测试 | ○ |

> `useExport.ts` 里的 `toAST`（富文本解析）、`toPoints`（SVG 转几何）、latex 渲染成图、表格主题色推导、`special` 形状退化 —— **这些全部原样保留**，这正是不迁 Python 的主要理由。

### 资产

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-10** | `src/utils/assetUrl.ts`（新） | `asset://<sha256>` 解析器，统一收口 | ● |
| **R-11** | `views/components/element/ImageElement/index.vue`<br>`.../BaseImageElement.vue`<br>`hooks/useSlideBackgroundStyle.ts`<br>`Toolbar/.../ImageStylePanel.vue`<br>`Toolbar/common/ElementFilter.vue`<br>`Toolbar/SlideDesignPanel/index.vue` | 所有 `src` 消费点接 R-10；`asset://pending/<id>` 渲染骨架屏 | ● |

### 旧 AI 路径

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-09** | `src/hooks/useAIPPT.ts`（538 行） | 保留模板匹配，包装成 agent 工具 `fillFromTemplate(slideType, content, templateId?)` | ○ |
| — | `useAIPPT.ts:71-112` `getAdaptedFontsize` | **必须留** —— canvas `measureText` 逐级缩字号（下限 10px），文字溢出的唯一现成解法 | ● |
| **R-18** | `src/types/AIPPT.ts` | `AIPPTSlide` 保留作为 `fillFromTemplate` 的入参类型 | ○ |

### 历史 / 撤销

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-12** | `src/store/snapshot.ts` | 一次 agent 动作 = 一个整份快照（配合 Q4 的整份替换）。撤销 = 整体回退一次 agent 动作。上限 20 可能要调 | ● |

### Agent UI（新增）

| ID | 改什么 | 状态 |
|---|---|---|
| **R-13** | 对话面板 · 选中元素 → agent 上下文 · SSE 事件流展示 · pending 资产骨架屏 | ○ |

### 工程配置

| ID | 位置 | 改什么 | 状态 |
|---|---|---|---|
| **R-14** | `package.json` | `pptist@2.0.0` → `rabbit-editor@0.1.0`；补 `license` / `description`；`homepage` 改指本仓库；移除 `prepare: husky install`（`.husky/` 已删） | ● |
| **R-19** | `NOTICE`（新） | AGPL-3.0 第 5 条要求的「显著标明已修改及日期」。含上游原作信息（作者 / 基线提交 `e491258`）、无担保声明、逐条修改记录、第三方参考出处 | ● |
| **R-20** | `.github/` `.husky/` | 已删。`commitlint.config.cjs` 留着 —— 现在是死配置（钩子已删），但将来在仓库根做约定式提交时可当参考 | ● |

## 实施顺序

按 [03-architecture.md](./03-architecture.md) 第九节的原则：**先做不需要 LLM 的部分**。

**第一批 · 纯前端，可立即验证 —— ✅ 已完成（2026-08-17）**
`R-05` → `R-07` `R-21` `R-22` `R-03` `R-04` → `R-14` `R-19` `R-20`

验证结果：`npm run type-check` exit 0 零错误；`npm run build` exit 0（5.56s）；
12 个自定义动画类全部确认进入产物 CSS。

**第二批 · 资产层 —— ✅ 已完成（2026-08-17）**
`R-10` → `R-11`

验证结果：`npm run type-check` exit 0 零错误；`npm run build` exit 0（5.29s）；
`rbAssetShimmer` keyframes 与 `.rb-asset-skeleton` 类确认进入产物 CSS；
`asset://` 协议字面量确认进入产物 JS。
共 8 个文件：1 个解析器（新）、1 个骨架屏样式（新）、6 个消费点接入。

**第三批 · 后端接管（R-06 / R-12 已完成 2026-08-17，R-01 / R-02 待后端就绪）**
`R-01` → `R-02` → `R-06` → `R-12`

R-06：`SlidesState.version` 计数器，11 个变更 action 均自增，`setSlides` + `setTheme` 复合
调用不重复计。R-12：快照表加 `source: 'user' | 'agent'` 和 `actionLabel`，新增
`addAgentSnapshot()` 不走 300ms 防抖。`npm run build` exit 0（5.20s）。

**第四批 · 导出迁移（工作量最大）**
`R-08` → `R-17`

**第五批 · Agent**
`R-09` `R-18` `R-15` `R-16` → `R-13`

## 待确认

- [x] ~~**Q2 细化**~~ —— 已定：保留 pptxgenjs + 自研 OOXML writer，见 [05-pptx-export.md](./05-pptx-export.md)
- [x] ~~`pptxgenjs` 是否真无动画 API~~ —— 已核实：产物里 `grep -c "p:timing"` = **0**，`p:transition` 同样为 0，确认零支持
- [ ] **决策 C**：AGPL-3.0 授权 —— 需联系 PPTist 作者询价。**这是当前唯一可能导致推倒重来的风险**
- [ ] `objectName` 是否对图表 / 表格生效（走 graphicFrame，属性位置可能不同）⚠️ 见 05 的 E2
- [ ] 上游 `pptxtojson` 导入时是否解析动画 ⚠️
