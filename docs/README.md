# Rabbit · 文档

一个「深度调研 → 生成 PPT → 可视化逐页用 AI 调整」的 agent 系统。

当前状态：**架构设计完成，前端底座已并入仓库根目录，第一批改动已落地。**

## 怎么读

| 文档 | 内容 | 什么时候看 |
|---|---|---|
| [00-vision.md](./00-vision.md) | 最初的想法、实现目标、验收标准 | 想知道我们到底要做什么 |
| [01-landscape.md](./01-landscape.md) | 开源项目全量调研与对比 | 想知道轮子有没有人造过 |
| [02-decision.md](./02-decision.md) | 首轮选型结论（**路线已被 03 修正**） | 想知道当初为什么那么选 |
| [03-architecture.md](./03-architecture.md) | **实机核对后的路线修正 · Deck Kernel 设计 · 图片与动画方案 · 决策 A~E** | 准备写第一行代码 |
| [04-changes.md](./04-changes.md) | **前端底座改动清单**（代码里 `TODO(R-NN)` 与此一一对应）+ 进度 | 要动前端代码 |
| [05-pptx-export.md](./05-pptx-export.md) | PPTX 导出与**自研 OOXML writer** —— pptxgenjs 能力边界、`elId → spid` 映射、动画树结构、E1~E6 分期 | 要做导出 |
| [06-backend.md](./06-backend.md) | 后端技术决策（Bun / Hono / Drizzle / AI SDK / WebSocket）与不用 Python 的理由 | 要动后端 |
| [07-agent-test.md](./07-agent-test.md) | 覆盖全部工具的分轮功能测试脚本 + 预期结果对照 | 要验证 agent 是否正常 |
| [08-expressiveness.md](./08-expressiveness.md) | **产出「没有新意」的五个根因诊断** + 动画扩容 / 工具扩容 / prompt 重写三条工作线 | 要提升生成质量 |
| [09-powerpoint-verify.md](./09-powerpoint-verify.md) | 45 个动画 + 12 转场在真实 PowerPoint 里的人工验证手册 | 要验动画导出是否真的能播 |
| [10-agent-runtime-study.md](./10-agent-runtime-study.md) | **BitFun 与 Claude Code 的 runtime / 交互规则研究** —— 阻塞式提问、权限闸门、取消语义、单一权威写者、上下文压缩 | 要动 agent 编排或交互 |
| [11-agent-roadmap.md](./11-agent-roadmap.md) | **通用 agent 化路线** —— 目标架构、A~D 分期、机器可判的验收判据、四笔隐藏成本 | 要规划 agent 的下一步 |
| [upstream/](./upstream/) | 上游 PPTist 自带文档，其中 [`AI_PPT_SCHEMA.md`](./upstream/AI_PPT_SCHEMA.md) 是面向 AI 生成的元素级契约 | 要产出符合底座 schema 的数据 |

## 一页速览

**要做的事**：几句话丢进去，agent 自己去深度调研；或者喂给它现成的资料（PDF、Word、txt、图片、网页、参考 PPT），产出一份 PPT。生成完之后有可视化前端，可以逐页选中元素、用自然语言让 AI 调整。整条链路由多个 agent 协作完成。

**调研的核心发现**：这套需求拆成 5 层能力（摄入 / 调研 / 生成 / 编辑 / 调整），**没有任何一个开源项目 5 层都强**。分水岭很清楚——

- [DeepPresenter](https://github.com/icip-cas/PPTAgent)（ACL 2026）前半段最强：多 agent、深度调研、沙箱工具、**渲染后反思回改**
- [Presenton](https://github.com/presenton/presenton) 后半段最强：拖拽画布 + 一整套作用在幻灯片数据上的 agent 工具集
- 两者之间没人打通

**当前选型**：以 **PPTist** 为渲染与编辑底座，在其 JSON 元素模型之上自建 **Deck Kernel**（纯函数的变更 + 校验 + 事务层），agent 只能通过工具改 deck、且全部经 kernel 校验。详见 [03-architecture.md](./03-architecture.md)。

> 02 原本选的是 Presenton 打底。四个项目源码都读过、Presenton 也本地跑过之后改掉了 —— 它装完 1.8G、chat agent 单目录 11,807 行、实测效果一般。改选 PPTist 的关键理由是它的 JSON 元素模型带**语义标注**（`textType` / `slideType`），且**坐标是显式数字**，让「重叠 / 越界 / 空元素」这类检查从「渲染 + VLM」退化成纯几何计算。

**最大的技术风险**：不再是排版成品率（JSON 模型下大部分校验变成静态 lint），而是 **PPTist 的 AGPL-3.0 授权** —— 深度集成构成衍生作品，且 AGPL 传染覆盖网络服务。这条不解决可能推倒重来。

---

调研时间：2026-08-17。Star 数与许可证均为当日通过 GitHub API 查询，功能判定基于 README 与源码核对。
