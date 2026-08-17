# 01 · 开源项目调研

调研时间 2026-08-17。Star 数、许可证、最后更新时间通过 GitHub API 当日查询；功能判定基于各项目 README 与源码核对，标注了核对方式的地方是我实际读过代码的。

## 一、核心发现

**这套需求的五层能力，没有任何一个开源项目全都强。**

分水岭非常清楚：

- **DeepPresenter** 前半段（摄入 / 调研 / 生成）最强，但没有可视化编辑器
- **Presenton** 后半段（编辑 / 调整）最强，五层都有但调研那层只是「搜索增强」
- **PPTist** 编辑器最强，但 AI 只有改写扩写，没有 agent
- 三者之间没有人打通

另一个高频陷阱：**绝大多数开源 AI PPT 工具只做一次性生成，改不动。** 100 多个项目里，真正做到「选中它、跟 AI 说改哪儿」的只有三个。

## 二、按能力层的最优选

| 层 | 最强 | 备选 | 说明 |
|---|---|---|---|
| 摄入 | MinerU | Docling、MarkItDown | 中文/公式/表格 MinerU 无对手 |
| 调研 | DeepPresenter（内置） | DeerFlow、gpt-researcher | 后两者是独立框架，可挂载 |
| 生成 | DeepPresenter | Presenton | 差距在「渲染后反思」 |
| 编辑 | PPTist | Presenton、Oh My PPT | PPTist 接近桌面 PowerPoint |
| 调整 | Presenton | Oh My PPT | Presenton 工具集最完整 |

## 三、关键洞察：底层数据模型决定 agent 能改多细

挑项目最容易踩的坑，是只看 UI 好不好看。真正决定「AI 能不能听懂『把第三页副标题缩小两号』」的，是这个项目**把幻灯片存成了什么**。

| 底层模型 | agent 改动粒度 | 代表项目 | 取舍 |
|---|---|---|---|
| **JSON 元素模型** | 最细，可精确改单个属性 | PPTist、Presenton | 最可控，做产品最稳 |
| **HTML / 代码** | 灵活但版式不可控 | LandPPT、open-slide、DeepPresenter | 自由度高，容易改出溢出错位，必须靠 lint 兜底 |
| **整页图片** | 只能框选重绘 | banana-slides | 好看，但做不了「字号改成 24」 |
| **原生 PPTX XML** | 保真最高，最难驾驭 | PPTAgent、各种 PPTX MCP | XML 冗长冗余，LLM 直改容易崩，需要中间表示 |

**对我们的含义**：生成阶段可以用 HTML 拿自由度，但落到编辑器时必须转成 JSON 元素模型，否则第 5 层（agent 精确调整）做不可靠。这个转换点是架构里最关键的一处设计。

## 四、全量对比

| 项目 | Star | 许可 | 可视化编辑 | LLM 调整已有页 | 底层模型 | 换自己的模型 | 可编辑 PPTX |
|---|---:|---|---|---|---|---|---|
| [Presenton](https://github.com/presenton/presenton) | 9,626 | Apache-2.0 | 拖拽画布 | 对话 agent + 工具集 | JSON + HTML 模板 | 任意 | 是 |
| [PPTist](https://github.com/pipipi-pikachu/PPTist) | 9,257 | AGPL-3.0 | 最强，近似 Office | 仅改写/扩写 | JSON 元素模型 | 自己接 | 是 |
| [banana-slides](https://github.com/Anionex/banana-slides) | 15,475 | AGPL-3.0 | 框选区域 | 口头改指定区域 | 整页图片 | 任意图像模型 | Beta |
| [open-slide](https://github.com/1weiho/open-slide) | 6,515 | MIT | 点选加批注 | 交给 coding agent | React 代码 | 任意 | 仅 HTML/PDF |
| [PPTAgent / DeepPresenter](https://github.com/icip-cas/PPTAgent) | 4,923 | MIT | WebUI，非编辑器 | 编辑动作 API | PPTX → HTML 表示 | 任意 | 是 |
| [LandPPT](https://github.com/sligter/LandPPT) | 3,550 | 自定义 | 在线编辑 | 侧边栏对话 | HTML | 任意 / Ollama | 需商业组件 |
| [presentation-ai](https://github.com/allweonedev/presentation-ai) | 2,997 | MIT | 文档式编辑 | 以生成为主 | Plate 富文本 | 任意 / Ollama | 是 |
| [Oh My PPT](https://github.com/arcsin1/oh-my-ppt) | 1,881 | Apache-2.0 | 全元素可选 | 选中即改 + 对话 | HTML（自研互转） | 任意 / Ollama | 是（≈100%） |
| [slides-grab](https://github.com/NomaDamas/slides-grab) | 1,176 | MIT | 浏览器编辑 | 交给 coding agent | HTML + lint 门禁 | 任意 | 实验性 |
| [OpenPPT](https://github.com/YOOTeam/OpenPPT) | 1,095 | AGPL-3.0 | 功能极全 | AI 对话 + 语音 | JSON 元素模型 | **锁定云端** | 是 |
| [ai-to-pptx](https://github.com/SmartSchoolAI/ai-to-pptx) | 1,461 | GPL-3.0 | 在线编辑 | 以生成为主 | 模板 + PPTX | DeepSeek 等 | 是 |

## 五、重点项目详解

### DeepPresenter / PPTAgent — 前半段的天花板

`MIT · 4,923★ · Python · 2026-08-10 更新` · [arXiv 2602.22839](https://arxiv.org/abs/2602.22839)（**ACL 2026**）

中科院计算所出品。原始 PPTAgent 发表于 EMNLP 2025，2025-12 发布的 DeepPresenter 是大版本升级，几乎就是我们想要的前半段：

- **Deep Research Integration** — 接 Tavily，Researcher agent 做意图自适应的信息检索与综合，不是照固定流程跑
- **多 agent 架构** — Planner / Research / SubAgent，角色用 YAML 配置，各自带 domain-specific 的 prompt 和工具集
- **Agent 沙箱** — 独立的 `deeppresenter-sandbox` 镜像做隔离执行，20~30 个工具
- **多格式输入** — 接 MinerU 做 PDF 解析，CLI 直接挂附件：`pptagent generate "Q4 Report" -f data.xlsx -f charts.pdf -p "10-12"`
- **自由式视觉设计** — 不受模板约束，论文称多样性是模板方案的两倍以上（模板基线只有 0.17–0.35）
- **环境反思（Environment-Grounded Reflection）** — **自主规划、渲染、然后针对渲染后的缺陷回改**。这是它和所有其他项目的本质区别：别人都是盲改，它是看着结果改
- **微调模型** — 放出了 [DeepPresenter-9B](https://huggingface.co/Forceless/DeepPresenter-9B)（含 GGUF 量化），论文称小模型也有竞争力，成本大幅下降

**原始 PPTAgent 的核心贡献也很有用**：把 PPTX 转成 LLM 可读的 HTML 表示，再暴露五个专用 API 让模型执行编辑动作。这套抽象是「LLM 怎么可靠地改 PPTX」的现成答案。另附 PPTEval 评测框架（Content / Design / Coherence 三维打分）。

**缺什么**：没有可视化逐页编辑器。WebUI（`localhost:7861`）是生成和编排界面，我没有找到画布编辑的证据。**不支持 Windows 原生，需要 WSL。**

部署有三种：`uvx pptagent` CLI、源码构建、Docker Compose（`deeppresenter-host` + `deeppresenter-sandbox` 两个镜像）。

### Presenton — 后半段的天花板，且五层都有

`Apache-2.0 · 9,626★ · TypeScript + Python · 2026-08-14 更新`

定位是 Gamma / Canva 的开源自托管替代。它的 AI 编辑不是「换 prompt 重新生成」——读了源码 `servers/fastapi/services/chat/tools.py`，后端注册了一整套 agent 工具直接操作演示文稿数据：

```
addOutline / updateOutline / deleteOutline
addNewSlide / addNewSlideLayout / updateSlide / deleteSlide / saveSlide
addElement / updateElement / deleteElement
addComponent / createComponent / updateComponent / deleteComponent
getAvailableLayouts / getAvailableBlocks / getContentSchemaFromLayoutId
getTemplateSummary / getPresentationTheme / setPresentationTheme
searchSlide / getSlideAtIndex / readSourceDocuments / generateAssets
```

**全是作用在已有 deck 上的定点修改。这套工具集设计是本项目最值得直接复用的东西。**

翻它的环境变量清单，发现摄入和调研它也都有：

| 能力 | 实现 |
|---|---|
| 文档解析 | **LiteParse**（内置，`LITEPARSE_DPI` / `LITEPARSE_NUM_WORKERS`） |
| 联网搜索 | `WEB_GROUNDING` + `WEB_SEARCH_PROVIDER=auto/native/searxng/tavily/exa` |
| 记忆 | **Mem0**（可指向本地 Ollama，不需要 OpenAI key 初始化） |
| 文生图 | `dall-e-3 / gpt-image-1.5 / gemini_flash / nanobanana_pro / pexels / pixabay / comfyui / open_webui` |
| 参考 PPT | **AI Template Generation** — 从现有 PPTX 反向生成可复用模板 |
| 模型 | OpenAI / Gemini / Vertex / Azure / Bedrock / Anthropic / Ollama / LM Studio / OpenRouter / Fireworks / Together / Cerebras / LiteLLM / 任意 OpenAI 兼容 |

还有：多用户工作区 + 管理后台、MCP server、生成 API（同步/异步/webhook/iframe 嵌入）、Electron 桌面版、Docker（支持 GPU）。

**缺什么**：调研那层只是「搜索增强」（最多 10 条结果注入 context），不是多轮深度调研。自定义模板要用 HTML + Tailwind 写，中文排版细节要自己调。

### PPTist — 编辑器天花板，但只是底座

`AGPL-3.0 · 9,257★ · Vue 3 · 2026-08-16 更新`

这个赛道里**可视化编辑体验最好的**，几乎还原了桌面 PowerPoint 的常用操作：右键菜单、几十个快捷键、参考线标尺、母版、动画、演示时的画笔黑板激光笔。不依赖 UI 组件库，二次开发很好改。

AI 侧只有：模板式 AIPPT 生成 + 编辑器内的 AI 改写 / 扩写 / 缩写。**没有对话式调整 agent。**

但它提供 `doc/AI_PPT_SCHEMA.md`——面向 AI 直接生成页面数据的结构定义。**这是它作为底座的核心价值：后端 agent 只要产出符合该 schema 的 JSON，前端负责渲染、编辑、导出。**

作者在 README 里说得很直白：PPTist 更适合作为结构化生成结果的**承载、编辑和二次加工底座**，而不是开箱即用的完整 AIPPT 商业方案。

**风险**：AGPL-3.0，闭源商用需联系作者购买独立授权。PPTX 导入约 85% 还原，无法保证保真。同作者的 [pptxtojson](https://github.com/pipipi-pikachu/pptxtojson) 可用于浏览器端解析 PPTX。

### Oh My PPT — 改存量 PPT 最强

`Apache-2.0 · 1,881★ · Electron · 2026-08-09 更新`

本地优先桌面端。README 原话：「一切可见元素皆可拖拽和调整大小，**一切元素皆可检选并让 AI 修改**」，加上对话式修改单页。主进程有独立 agent runtime（`src/main/agent-runtime`，含 agent / events / job coordinator / resource lock）。

杀手锏是 **PPTX 往返保真**：导入导出还原度均宣称接近 100%，底层是自研的 [@arcsin1/pptx2json](https://www.npmjs.com/package/@arcsin1/pptx2json) 和 [@arcsin1/html2pptx](https://www.npmjs.com/package/@arcsin1/html2pptx)，不走图片。导入时还会提取原文件风格供复用——**正好对应「参考 PPT」这个输入模式**。

多尺寸画布（16:9 / 4:3 / 9:16 / 1:1 / 小红书）。

**风险**：2026-04 才建仓，很年轻；复杂形状、图表、动画的还原仍在打磨；桌面端为主，不是 Web 服务。

### 其余项目的一句话结论

| 项目 | 结论 |
|---|---|
| **LandPPT** | 工作流最完整（文档→大纲→HTML→侧边栏对话打磨→讲稿配音→分享页），支持按角色路由模型控成本。但**导出标准可编辑 PPTX 依赖 Apryse 商业许可**，许可证也是自定义的 |
| **OpenPPT** | 编辑器功能极全（ChatPPT 开源版），但 **AI 走 ChatPPT 云端，换不了自己的模型**——直接违反硬约束。近一年没更新 |
| **banana-slides** | Star 最高，图像生成路线，「框选区域 + 口头改」交互很好。但页面是图片，做不了元素级精确指令 |
| **open-slide / slides-grab** | slides-as-code 路线，点选元素写批注 → coding agent 批量应用。**slides-grab 的 lint + 设计门禁值得抄** |
| **presentation-ai** | Gamma 风格，Plate 富文本编辑，文档式而非画布式。以生成为主 |

## 六、可挂载的独立组件

这几个不是 PPT 项目，但是我们架构里要用的零件。

### 摄入层

| 工具 | 许可 | 强项 | 适用 |
|---|---|---|---|
| **[MinerU](https://mineru.net/)** | Apache-2.0 衍生 | **中文 / 公式 / 表格最强**，CJK 版面检测无对手。支持 PDF、Word、PPT、Excel、图片、网页 URL | 我们的主力 |
| **[Docling](https://github.com/docling-project/docling)** | MIT | 格式最广（含邮件、音视频），纯 CPU 可跑，Linux Foundation 托管，与 LangChain/LlamaIndex 一流集成 | 备选 / 补格式 |
| **MarkItDown** | MIT | 快、轻，Office 文档为主（DOCX 约 0.38s/17页） | 快速降级路径 |

⚠️ 注意：MarkItDown 的 PDF 输出只保留文字，公式会乱码，图片仅提取图题——**不能作为主力**。Marker 是 GPL-3.0 + RAIL-M 权重许可，商用有营收阈值限制，**避开**。

### 调研层

| 框架 | 许可 | 架构 |
|---|---|---|
| **[gpt-researcher](https://github.com/assafelovic/gpt-researcher)** | Apache-2.0 · 28.9k★ | Planner Agent 拆解研究问题 → Execution Agents 并行抓取 |
| **[DeerFlow](https://github.com/bytedance/deer-flow)** | MIT · 25k+★ | 字节出品。Coordinator-Planner-Researcher-Coder-Reporter 流水线，基于 LangGraph，子 agent 并行 + Docker 沙箱，**每个子 agent 可绑不同 LLM**，支持 human-in-the-loop |

现实差距：开源 deep research 在报告排版、来源渲染、异常处理上仍不及厂商版。价值在可控性、成本和数据驻留。

索引：[Awesome-Deep-Research](https://github.com/DavidZWZ/Awesome-Deep-Research)（ACL 2026 KnowFM）

### 校验层（渲染后检查）

| 项目 | 可抄什么 |
|---|---|
| **[slides-grab](https://github.com/NomaDamas/slides-grab)** | lint + 设计门禁，专门拦溢出错位这类 HTML 方案通病 |
| **[hands-on-deck](https://github.com/EveryInc/hands-on-deck)** | 面向 agent 的 PowerPoint CLI，**补丁式编辑** + lint + validate |
| **[OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)** | 28.5k★，本地优先 Office CLI，不装 Office 也能创建/检查/编辑/渲染 |

### 参考清单

**[ningzimu/awesome-ai-ppt](https://github.com/ningzimu/awesome-ai-ppt)** — 100+ 个 AI PPT / PPTX 自动化项目，按 HTML 式 / 图片式 / PPTX 库式分类，标注可编辑性。本次调研的候选池有一部分来自它。

## 七、许可证清单

商用闭源时的分类：

**干净（Apache-2.0 / MIT）**
Presenton · PPTAgent/DeepPresenter · Oh My PPT · open-slide · slides-grab · presentation-ai · Docling · DeerFlow · gpt-researcher

**受限（AGPL / GPL）**
PPTist · banana-slides · OpenPPT（均 AGPL-3.0）· ai-to-pptx · veasion/AiPPT（GPL-3.0）

**需额外确认**
LandPPT（自定义许可，且导出可编辑 PPTX 需 Apryse 商业授权）· Marker（GPL-3.0 + RAIL-M 权重许可，有营收阈值）

---

下一步：[02-decision.md](./02-decision.md) — 基于以上调研的选型结论和整合架构。
