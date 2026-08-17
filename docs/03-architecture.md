# 03 · 整合架构与 Agent 框架设计

基于 [02-decision.md](./02-decision.md) 的选型，加上对 PPTist / Presenton / Oh My PPT / DeepPresenter **四个项目的实机源码核对**（2026-08-17，本地浅克隆于 `refs/`）。

本文修正了 02 的路线选择。带 ⚠️ 的仍是未经运行验证的假设，带 `文件:行号` 的是我实际读过的代码。

## 一、路线修正：改以 PPTist 为底座

02 选的是**路线 A（Presenton 打底）**。实机跑过之后改掉了。

### 实测结论

| 项目 | 实测发现 | 判断 |
|---|---|---|
| **Presenton** | Docker 免用可行（Electron 开发模式，macOS 原生导出二进制 `convert-darwin-arm64` 存在）。但装完 `node_modules` + `.venv` 共 **1.8G**，chat agent 目录单独 **11,807 行**（`memory_layer.py` 一个文件 4,883 行）。实测生成效果一般 | **过重** |
| **PPTist** | 纯前端 49,595 行，无服务端。JSON 元素模型 + 语义标注最干净。但 **AI 只有模板填充和改写，零 agent** | **选它当底座** |
| **Oh My PPT** | 121,028 行，React + LangGraph。但页面本体是**磁盘 HTML 文件**，agent 靠 CSS selector + grep 源码改文件。工具只有 6 个，全是文件级 | 借鉴，不采用 |
| **DeepPresenter** | 生成侧多 agent 最完整（5 个角色 YAML），`agents/env.py` 是 MCP 客户端。编辑 API 只到段落/图片替换，够不着元素属性 | 借鉴，可选挂载 |

### 三条路的本质差异

| | Presenton | Oh My PPT | **我们（PPTist 底座）** |
|---|---|---|---|
| 页面存储 | JSON 元素树（DB） | HTML 文件（磁盘） | **JSON 元素树** |
| 寻址方式 | `elementPath` 路径 | CSS selector | **扁平 `id`（nanoid）** |
| AI 改法 | `updateElement` 属性补丁 | agent 重写整个 HTML 文件 | **属性补丁 + 校验闸门** |
| 工具数量 | 32 | 6 | 待定 |
| 类比 | 结构化 API 调用 | coding agent 改代码 | 结构化 API + 事务 |

扁平 `id` 是三者里**最不容易改错目标**的寻址方式。

### 一个决定性的额外收益：校验变便宜了

自由式 HTML 路线要查排版必须**渲染成图 + VLM 看**，因为坐标藏在 CSS 里。JSON 模型里坐标是显式数字：

| 检查项 | HTML 路线 | JSON 路线 |
|---|---|---|
| 元素重叠 | 渲染 + VLM | **矩形求交，纯几何** |
| 出画布 | 渲染 + VLM | **和 1000×562.5 比大小** |
| 空元素 / 缺字段 | 渲染 + VLM | **schema 校验** |
| 对比度不足 | 渲染 + VLM | **颜色计算** |
| 文字溢出框 | 渲染 + VLM | 需字体测量 ⚠️ |

**02 的决策 2 说「渲染后校验必做」，在 JSON 路线下大部分退化成静态 lint** —— 确定性、快、可写单测。只有文字溢出真需要测量，而 PPTist 已有 canvas `measureText` 实现（`useAIPPT.ts` 的 `getAdaptedFontsize`，逐级缩字号，下限 10px），可直接复用。

这条大幅降低 MVP 难度，是选 PPTist 最实在的收益。

## 二、PPTist 给了什么，缺了什么

### 白送的三样（都是最难自己造的）

**1 · 稳定寻址** —— 每元素一个 nanoid，扁平数组 + `groupId` 分组，不是树。

**2 · 类型化细粒度变更** —— `store/slides.ts` 的 action 已经是 agent 工具集的形状：

```
setSlides / addSlide / updateSlide / deleteSlide / updateSlideIndex
addElement / updateElement / deleteElement / removeElementProps
setTheme / setViewportSize / setViewportRatio / setTemplates
```

**3 · 语义标注**（最被低估的一条）

```
textType   title | subtitle | content | item | itemTitle | notes | header | footer | partNumber | itemNumber
imageType  pageFigure | itemFigure | background
slideType  cover | contents | transition | content | end
```

agent 能说「找这页的 title 元素」，而不是「找坐标 (124, 32) 那个文本框」。**Oh My PPT 靠 CSS selector + grep 源码才能做到的定位，PPTist 一个字段解决。**

### 缺的四样（要我们写，且都不需要 LLM）

| | 要求 | PPTist 现状 |
|---|---|---|
| 4 | **原子事务 + 回滚** | 只有 UI 级 undo（`store/snapshot.ts`），不是事务 |
| 5 | **运行时校验** | 只有 TS 类型，运行时零校验 |
| 6 | **可观测（读回 + 看效果）** | 无读 API，无 lint 反馈 |
| 7 | **并发控制** | agent 与用户同时改会冲突 |

### 坐标系与画布

```
逻辑宽 1000 × 逻辑高 562.5（16:9），原点左上，单位逻辑 px
store/slides.ts:53   viewportSize: 1000
store/slides.ts:54   viewportRatio: 0.5625
```

非像素、非 EMU。[`docs/upstream/AI_PPT_SCHEMA.md`](./upstream/AI_PPT_SCHEMA.md)（20KB）已是面向 AI 生成的元素级契约，明确标注「专用于 AI 生成，并非完整数据定义」——**但上游没有配套实现，这条路是留给外部接的**。

### 后端接口面极小

`src/services/index.ts` 全部内容只有 4 个端点，默认指向作者的托管服务 `https://server.pptist.cn`（**该服务端不在本仓库内**）：

```
POST /tools/aippt_outline    生成大纲    SSE 流
POST /tools/aippt            生成幻灯片  SSE 流
POST /tools/ai_writing       AI 改写     SSE 流
POST /tools/img_search       图片搜索    JSON
```

payload 带 `provider` / `model` 字段。**这 4 个端点是我们要接管的全部接口面。**

## 三、核心：Deck Kernel

### 它不是服务，不是 store，是纯函数库

```
Deck Kernel
  输入：deck JSON + 一个变更意图
  输出：新 deck JSON + 变更记录   或   校验失败原因（带可读理由）
```

不依赖 Vue、不依赖 HTTP、不依赖数据库、不依赖 LLM。

**理由：一个 agent 框架好不好用，八成取决于变更层能不能被独立测试。** Presenton 的 `tools.py`（1,776 行）与 service 深度耦合；Oh My PPT 的工具直接读写文件 —— 两家都不好单测。这是我们能明确做得更好的地方。

### 分层

```
┌─ PPTist 前端（Vue 3）──────────────────────────────┐
│  画布 · 直接操作 · 选中元素 → elementId              │
│  Pinia slides store  ←→  补丁应用器                  │
└────────────────────────────────────────────────────┘
              ↕  Deck Protocol（JSON + SSE）
┌─ Python 后端 ──────────────────────────────────────┐
│  Agent 编排层（多角色，各绑不同模型）                  │
│    Planner · Generator · Reviewer · Editor           │
│         ↓ 只能通过工具改东西，不能直接写 JSON           │
│  ┌──────────────────────────────────────────────┐  │
│  │ Tool Layer                                   │  │
│  │  读：getDeck / getSlide / findElements        │  │
│  │      （支持按 textType 语义查询）              │  │
│  │  写：updateElement / addElement / ...         │  │
│  │  每工具 = pydantic schema + 前置校验           │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │ ★ Deck Kernel（纯函数）                       │  │
│  │   schema 校验 · 事务 · 回滚 · 变更日志         │  │
│  │   text-run ↔ HTML 字符串 转换                 │  │
│  │   动画时间线（排序 · 级联 · PPTX 可映射性）      │  │
│  │   几何 lint（重叠 · 越界 · 图片比例适配）        │  │
│  │   资产引用校验（对注入的 manifest 查 hash）      │  │
│  └──────────────────────────────────────────────┘  │
│  Job 层：队列 · 资源锁 · 事件流 · 回滚点              │
└────────────────────────────────────────────────────┘
              ↕
     MinerU（摄入）      DeerFlow（调研）
```

**一条硬规则：agent 永远不直接写 deck JSON，只能调工具；工具全部经 kernel 校验。**

这是 Oh My PPT 那条路最大的隐患（agent 自由重写 HTML，零守门），不重复。

### 纯度纪律

图片字节、文件系统、字体测量、截图**都不进 kernel**。kernel 只认识 `asset://<hash>` 字符串，校验时对外部注入的 manifest 查 hash 是否声明。

```
不纯的服务（kernel 之外，依赖注入）
  ├── AssetStore     文件系统 · sha256 · 去重 · 导出打包
  ├── ImageProvider  生成 / 图库 / 图标检索 / 本地
  └── Renderer       字体测量 · 截图
```

## 四、文本模型（决策 B）

PPTist 最大的软肋：

```ts
interface PPTTextElement {
  content: string   // ← HTML 字符串，含内联样式
  defaultFontName: string
  defaultColor: string
}
```

「把标题缩小两号」不是 `fontSize: 24 → 20`，而是**解析 HTML → 找内联 `font-size` → 改 → 序列化回去**。

PPTist 自己用正则干这事（`useAIPPT.ts:114-115` 两条正则抠 `font-size` / `font-family`）。正则对付人写的 HTML 尚可，对付 agent 反复改写会累积脏数据。

**推荐做法**：agent 侧建 text-run 结构化视图，读时从 HTML 解析进来，写时序列化回去，agent 只碰结构化视图。

```
{ text, fontSize, color, bold, italic, underline, ... }[]
```

PPTist 侧零改动，脏数据隔离在转换层。代价是转换保真度要测。⚠️

## 五、图片与资产（决策 E）

### 现状：Presenton 的做法不够

```python
class GenerateAssetItemInput:
    kind: Literal["image", "icon"]
    prompt: str
# 就这两个字段 —— 没有目标尺寸、没有宽高比
class GenerateAssetsInput:
    assets: list[...] = Field(min_length=1, max_length=12)
```

图片在不知道要放进多大的框时就生成了，比例对不上只能后期裁切或硬拉变形。

### 设计

**1 · 内容寻址，deck 里只存 `asset://<sha256>`**

`PPTImageElement.src` 本来就吃任意字符串，所以**不改 schema**，PPTist 侧只加一个 `asset://` 解析器。

- 同 prompt 同 hash 命中缓存，agent 重生成 5 次不留 5 个孤儿
- 两页同图只存一份
- deck JSON 与文件位置解耦：导出打包、导入去重、离线打开都成立

**2 · 异步生成不污染 kernel 的纯函数性**

```
agent: plan_asset(intent)                          → 立刻返回 pending id，任务入队
agent: updateElement(src: 'asset://pending/<id>')  → 同步、合法、可继续排版
job 完成 → 一个 patch 把 pending 换成 asset://<hash>
前端: pending 状态渲染骨架屏
```

N 张图并行生成，agent 不阻塞，kernel 里零异步代码。

**3 · 生成请求必须带目标几何**（补 Presenton 的短板）

```
{ kind, prompt, targetBox: {width, height}, fit: 'cover'|'contain', elementId }
```

按目标比例挑 provider 最近的支持比例；生成后 kernel **自动算 `clip.range`** 不变形填满框。lint 规则：实际比例与框偏差超阈值且无 `clip` → 告警。

这在 JSON 模型里是纯计算；HTML 路线必须先渲染才知道。

**4 · icon 走检索，不走生成**

抄 Presenton：fastembed embedding + 缓存图标索引做向量检索（`PRESENTON_FASTEMBED_ICON_CACHE_DIR`）。生成的图标风格不统一还贵。

```
kind: 'icon'  → 向量检索固定图标集
kind: 'image' → 生成 or 图库
```

**5 · 成本控制**

- 批量上限（抄 Presenton 的 12）
- 「配图按需」落成 **planner 决策**而非每页默认：planner 每页输出 `needsFigure: boolean`，整份 deck 一个预算上限
- prompt hash 缓存

### Provider 取两家并集

| 来源 | provider |
|---|---|
| Presenton | dall-e-3 · gpt-image-1.5 · gemini_flash · nanobanana_pro · **pexels / pixabay**（图库）· **comfyui / open_webui**（本地） |
| Oh My PPT | gemini · **jimeng / jimeng-v4（即梦）· seedream · siliconflow** · agnes-ai |

Oh My PPT 一半是国内服务 —— 对「中文优先」这条硬约束是加分项。

抽象成四类：`generate | stock | icon-search | local`。

## 六、动画（决策 D）

### 关键发现：PPTist 的动画导不出去

| | PPTist | Oh My PPT |
|---|---|---|
| 效果数 | **92**（40 入场 + 40 退场 + 12 强调） | **26** |
| 词表来源 | `animate.css` 类名（`ANIMATION_CLASS_PREFIX = 'animate__'`） | OOXML preset |
| 导出 PPTX | **零支持** —— `useExport.ts` 里 animation 零匹配 | `pptx-animation-map.ts` 438 行 |
| 校验 | 无 | `data-anim-validator.ts` 278 行 |

Oh My PPT 每个效果映射到真实 PowerPoint preset：

```ts
export type PptxPresetClass = 'entr' | 'emph' | 'exit'
fade: { presetId: 10, presetClass: 'entr', fade: true }
```

**它词表少三分之二，因为只收「网页能演」∩「PPTX 能表达」的交集。** PPTist 取 animate.css 全集 —— 数量好看，一个都带不走。

另一个隐患：孤儿动画是**读时过滤**（`store/slides.ts:78`），删元素不清理其动画，数组永久累积垃圾。人手操作无所谓，agent 反复增删会迅速脏掉。

### 四个决策

**1 · 词表取交集，不取并集**

直接拿 Oh My PPT 的 `pptx-animation-map.ts` 当规格（26 个），映射到 PPTist 的 `effect` 字段。**主动不暴露 92 个里的 66 个。**

这是特性不是缺陷：agent 只能从 PPTX-safe 效果里选，就永远产不出「导出后动画悄悄消失」的 deck。

真要网页专属效果，显式标注，让损失是声明的而非导出时才发现：

```ts
{ effect, exportBehavior: 'native' | 'web-only' | 'flatten' }
```

**2 · 动画是时间线，引用完整性归 kernel**

`trigger` 把条目串成序列（`click` = 新一步，`meantime` = 与上条同时，`auto` = 上条之后），是有序时间线不是集合。两条硬要求：

- `deleteElement` **必须级联删除该元素的动画** —— 写时清理，不是读时过滤
- 插入位置有语义 → 暴露 `addAnimation({elId, effect, after?})`，不给 agent 裸数组

**3 · 给 agent 语义 API，不给裸条目**

「让这页元素依次淡入」不该要求 agent 吐 6 条顺序和 trigger 都正确的条目：

```
applyAnimationPreset(slideId, preset: 'sequential-fade' | 'title-then-content' | 'none', opts)
```

kernel 内部展开成合法条目序列。**agent 选意图，kernel 保证结构合法** —— 和 PPTist 模板填充不崩排版同一个道理。

**4 · 动画 lint（全是廉价确定性检查）**

- 孤儿动画（`elId` 不在 elements）→ error，可自动修
- 单元素动画数 > N → warning
- 整页动画总时长 > 页面停留时间 → warning
- 导出目标为 PPTX 但存在 `web-only` 效果 → 导出时 warning

## 七、待定决策清单

| | 决策 | 选项 | 倾向 |
|---|---|---|---|
| **A** | 权威状态在哪边 | 服务端 / 前端 / 混合 | **生成期服务端权威（含资产），交互编辑期前端持 deck 但资产始终服务端托管**。图片这块推翻了「可以先不锁死」的说法 —— 生成在服务端、资产是文件、导出要打包 |
| **B** | 文本模型 | 保留 HTML 字符串 + 转换层 / 改 PPTist schema 成结构化 text-run | **保留 + 转换层**（PPTist 零改动） |
| **C** | AGPL-3.0 | 接受开源义务 / 买独立授权 / 换 Presenton 前端 | **未定，需尽快找作者问授权报价**。可并行开工，不阻塞 |
| **D** | 动画导出契约 | 只做 PPTX-safe 子集 / 允许 web-only 但标注 / 两套并行 | **只做子集 + 显式标注** |
| **E** | 资产存储 | content-addressed + `asset://` / 存文件路径 / 存远程 URL | **content-addressed** |

## 八、从三家各抄什么

| 来源 | 抄什么 |
|---|---|
| **Presenton** | 工具集的**分类与粒度**（outline / slide / element / component / theme / assets / context 七类，32 个）；每工具一个 schema；`getSlideAtIndex` 先读后写的纪律；SSE 进度流；图标向量检索；批量上限 |
| **Oh My PPT** | **job + rollback 模型**（`edit-jobs/`、`page-edit-rollback.ts`）；**资源锁**（`agent-runtime/lock/`）；**事件流**（`agent-runtime/events/`）；`verify_completion` 当结构闸门；**`pptx-animation-map.ts` 直接当动画规格** |
| **DeepPresenter** | `agents/env.py` 的 **MCP 客户端架构**（工具可插拔）；`roles/*.yaml` 的**角色绑不同模型**；`tools/reflect.py` 的**渲染后反思**（129 行，四家里唯一有的） |

Oh My PPT 的 job/lock/event 价值被低估 —— 它是唯一认真处理「agent 改到一半失败了怎么办」和「用户与 agent 同时改怎么办」的。这两个问题在 demo 里不存在，在真实产品里天天发生。

## 九、实施顺序

**先做 kernel 里不需要 LLM 的部分** —— 能单测、能立刻验证、是后面所有 agent 行为的地基。

1. **deck schema + 运行时校验** —— 把 `types/slides.ts` 翻成 pydantic，加运行时校验
2. **几何 lint** —— 重叠 / 越界 / 空元素 / 对比度，纯函数 + 单测
3. **事务 + 回滚 + 变更日志**
4. **动画时间线** —— 26 词表 + 级联删除 + 语义 preset 展开
5. **text-run ↔ HTML 转换层** —— 保真度测试
6. **AssetStore** —— content-addressed，先只支持上传，不接 provider
7. **Tool Layer** —— 包装 1~6，每工具一个 schema
8. —— 到这里为止零 LLM，全部可测 ——
9. Agent 编排 + 4 个端点接管
10. ImageProvider 接入
11. 渲染后反思（抄 `reflect.py`）
12. MinerU 摄入 / DeerFlow 调研挂载

## 十、风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| **AGPL-3.0 授权未定** | **高** —— 不解决可能推倒重来 | 立即联系作者询价（决策 C） |
| text-run ↔ HTML 转换失真 | 高 | 第 5 步专门做保真度测试；失真严重则回退到改 PPTist schema |
| 动画词表砍到 26 后表现力不足 | 中 | 先按交集做，不够再用 `web-only` 显式扩展 |
| 图片比例与框不匹配 | 中 | 生成请求带 `targetBox`，kernel 自动算 `clip` |
| PPTist 导入 PPTX 仅约 85% 还原 | 中 | 「参考 PPT」这个输入模式受影响；备选是抄 Oh My PPT 的 `pptx2json` |
| 前端权威 / 服务端权威切换成本 | 中 | kernel 写成纯函数，两边共用同一套逻辑（决策 A） |

---

**下一步**：PPTist 已并入仓库根目录（单体仓库，后续 Deck Kernel 与 FastAPI 后端也并进来）。逐环节的改动清单见 [04-changes.md](./04-changes.md)，随进展回填。
