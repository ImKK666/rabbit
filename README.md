# Rabbit

一个「深度调研 → 生成 PPT → 可视化逐页用 AI 调整」的 agent 系统。

和市面上多数 AI PPT 工具的区别是：**生成之后还能继续用 AI 改，粒度到单个元素。**
选中一页里的某个元素，说一句「这个标题缩小两号」，它就改掉 —— 而不是回去改
prompt 整份重来。

当前状态：**架构设计完成，前端底座已就位，第一批改动已落地。**

## 文档

设计与决策全部在 [`docs/`](./docs/)，建议按顺序读：

| 文档 | 内容 |
|---|---|
| [00-vision.md](./docs/00-vision.md) | 最初的想法、五层能力目标、验收标准 |
| [01-landscape.md](./docs/01-landscape.md) | 11 个开源 AI PPT 项目的全量调研与对比 |
| [02-decision.md](./docs/02-decision.md) | 首轮选型结论（**路线已被 03 修正**） |
| [03-architecture.md](./docs/03-architecture.md) | 实机核对后的路线修正 · Deck Kernel 设计 · 图片与动画方案 · 决策 A~E |
| [04-changes.md](./docs/04-changes.md) | 前端底座的改动清单（代码里的 `TODO(R-NN)` 与此一一对应） |
| [05-pptx-export.md](./docs/05-pptx-export.md) | PPTX 导出与自研 OOXML writer 的设计与分期 |

[`docs/upstream/`](./docs/upstream/) 是上游 PPTist 自带的文档，其中
[`AI_PPT_SCHEMA.md`](./docs/upstream/AI_PPT_SCHEMA.md) 是面向 AI 生成的元素级契约，值得先看。

## 架构一句话

以 **PPTist**（Vue 3，JSON 元素模型）为渲染与编辑底座，在其数据模型之上自建
**Deck Kernel** —— 一个纯函数的变更 + 校验 + 事务层。agent 只能通过工具改
deck，且全部经 kernel 校验，永远不直接写 JSON。

选 JSON 元素模型而非自由式 HTML 的关键收益：**坐标是显式数字**，所以「元素重叠 /
出画布 / 空元素 / 对比度不足」这些检查是纯几何计算，不需要渲染成图再喂给 VLM。

## 目录

```
src/            前端（PPTist fork，Vue 3 + TypeScript + Vite）
public/         静态资源与模板
docs/           设计文档
docs/upstream/  上游 PPTist 自带文档
refs/           参考项目的浅克隆（不纳入版本控制）
```

单体仓库。后续的 Deck Kernel 与 FastAPI 后端也直接并进根目录。

## 开发

```bash
npm install
npm run dev          # 开发服务器
npm run type-check   # 类型检查
npm run build        # type-check + 构建
```

## 许可

**AGPL-3.0** —— 本仓库包含 [PPTist](https://github.com/pipipi-pikachu/PPTist)
的修改版本作为底座。fork 来源、修改记录与第三方参考出处见 [NOTICE](./NOTICE)。

> ⚠️ AGPL 的传染性覆盖网络服务。若要闭源商用，需先向 PPTist 作者取得独立授权
> —— 这是本项目当前最大的未决风险，见 [03-architecture.md](./docs/03-architecture.md)
> 的决策 C。
