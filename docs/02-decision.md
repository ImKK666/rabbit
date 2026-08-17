# 02 · 选型结论与整合架构

基于 [01-landscape.md](./01-landscape.md) 的调研。**这份文档里的结论尚未经过实机验证**，标注了 ⚠️ 的地方是必须先跑一遍才能确认的假设。

## 一、三条可选路线

### 路线 A · Presenton 打底，补调研深度 ← **推荐**

```
用户输入（几句话 / 文档 / 图片 / 网页 / 参考PPT）
        │
        ├─→ 深度调研（DeerFlow 或 gpt-researcher）──→ 研究报告
        │
        └─→ 文档解析（MinerU）──────────────────→ 结构化材料
                        │
                        ▼
              Presenton（作为文档输入喂进去）
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   画布编辑器      chat agent 工具集    PPTX/PDF 导出
   （现成）          （现成）            （现成）
```

**优点**
- 最难自己写的后半段（画布编辑器 + agent 工具集）**完全是现成的**
- 许可干净（Apache-2.0），商用无负担
- 前半段接口清晰：调研产出报告，当文档喂进去就行，不需要改 Presenton 核心
- 它自带的 MCP server 意味着调研 agent 可以直接作为 MCP tool 挂上去

**代价**
- 生成质量受 Presenton 的模板体系约束，上限低于 DeepPresenter 的自由式设计
- ⚠️ 它内置的 LiteParse 中文效果未知，可能要换成 MinerU
- 自定义模板要写 HTML + Tailwind，中文排版要自己调

**工作量估计**：闭环 1–2 周

### 路线 B · DeepPresenter 出内容 + 另一个前端做编辑

质量上限最高——DeepPresenter 的多 agent + 深度调研 + **渲染后反思**是别人没有的。

**但摩擦点在交接格式**：DeepPresenter 导出 PPTX → PPTist 导入只有约 85% 还原，一来一回保真度就掉了，而且这个损失是不可逆的。

如果要走这条，**别走 PPTX 交接**。正确做法是让 DeepPresenter 的 HTML 中间产物直接对齐到编辑器的数据结构——这才是真正的工作量所在，而且是全新代码。

**工作量估计**：4–8 周，且有失败风险

### 路线 C · PPTist 当画布，agent 层全自己写

```
MinerU/Docling 摄入  →  DeerFlow 调研  →  自研生成 agent
        │
        ▼
输出符合 AI_PPT_SCHEMA 的 JSON
        │
        ▼
Schema 校验层（不合规则重试/修复）
        │
        ▼
注入 PPTist slides store  →  人工编辑 + agent 调整  →  导出
```

最可控，编辑器体验最好（PPTist 接近桌面 PowerPoint）。调整层直接抄 Presenton 的工具集设计，作用在 PPTist 的 JSON 上。

**代价**：工作量最大；**PPTist 是 AGPL-3.0**，闭源商用要买独立授权。

**工作量估计**：6–10 周

## 二、结论：走路线 A，但把 DeepPresenter 当能力挂进来

不是二选一。具体做法：

1. **以 Presenton 为主干**，拿到它的编辑器 + agent 工具集 + 导出能力
2. **摄入层换成 MinerU**（如果实测 LiteParse 中文不行）
3. **调研层挂 DeerFlow**（MIT，子 agent 可绑不同模型，正好符合成本分层的需求）
4. **把 DeepPresenter 当作可选的「高质量内容引擎」**，通过 CLI / MCP 调用，产出物作为素材进 Presenton，而不是拼两个前端
5. **渲染后校验必须自己做**（Presenton 没有），抄 slides-grab 的 lint 门禁思路

理由：用户价值最高、自己最难造的是**后半段**（选中元素→说一句话→改掉）。前半段（调研、解析）接口清晰、可替换、可渐进增强。先把闭环跑通，再逐层换掉不满意的部分。

## 三、必须提前定的五个技术决策

### 决策 1 · 中间表示：JSON 还是 HTML

**这是整个架构最关键的一处设计。**

- **JSON 元素模型**：agent 能精确改单个属性，可靠性高，但版式自由度受限
- **HTML**：自由度高、好看，但 agent 改代码容易改出溢出错位

**建议的混合方案**：生成阶段用 HTML 拿自由度 → 落到编辑器时转成 JSON 元素模型 → 第 5 层的精确调整在 JSON 上做。

⚠️ **这个 HTML→JSON 转换的保真度是路线 A 的最大未知数，必须在第一周就验证。** Oh My PPT 的 `@arcsin1/html2pptx` 和 PPTist 的 `pptxtojson` 是两个可参考的现成实现。

### 决策 2 · 渲染后校验：必做，不能推迟

DeepPresenter 论文的核心贡献就是这个（environment-grounded reflection），实验数据表明它能显著缓解自由式生成的失败。

```
生成 → 渲染成图 → VLM 检查（溢出/重叠/异常留白/文字被截）
     → 有问题？→ 回改 → 再渲染 → 直到通过或达到重试上限
```

**没有这一环，自由式生成的成品率会低到没法用。** 这是必须进 MVP 的功能，不是优化项。

现成可抄的实现：[slides-grab](https://github.com/NomaDamas/slides-grab) 的 lint + 设计门禁、[hands-on-deck](https://github.com/EveryInc/hands-on-deck) 的 lint/validate + 补丁式编辑。

### 决策 3 · 摄入层不要自己写

用 **MinerU**（中文/公式/表格最强，支持 PDF、Word、PPT、Excel、图片、网页 URL 全格式），难解的降级到 **Docling**。

图片和网页也统一走它们，**不要为每种格式单独写解析器**。

避开 Marker（GPL-3.0 + RAIL-M 权重许可，商用有营收阈值）。

### 决策 4 · 「参考 PPT」有三种做法，要选一种

| 做法 | 代表实现 | 得到什么 |
|---|---|---|
| 提取**版式功能类型 + 内容 schema** | PPTAgent 原始能力 | 学会「这类页面该怎么排」 |
| 从 PPTX **反推可复用模板** | Presenton 的 AI Template Generation | 直接得到一套模板 |
| 导入时**提取视觉风格** | Oh My PPT | 配色、字体、质感 |

三者目标不同。**建议先做第二种**（Presenton 现成），因为它直接接入主干，不需要新代码。

### 决策 5 · 模型分层路由

LandPPT 和 DeerFlow 都这么干，**不做的话成本会失控**：

| 角色 | 建议档位 |
|---|---|
| 调研检索 | 便宜模型跑量 |
| 大纲规划 | 强推理模型 |
| 单页生成 | 中档 |
| **反思/审查** | 强模型（多模态，要看渲染图） |
| 文本改写 | 便宜模型 |

DeepPresenter 的 [DeepPresenter-9B](https://huggingface.co/Forceless/DeepPresenter-9B) 微调模型值得评估——如果生成质量够，成本能降一个数量级。

## 四、待验证清单

动手前必须先跑一遍确认的假设：

- [ ] Presenton 的 chat agent 实际改页面的成功率如何？工具调用是否稳定？
- [ ] Presenton 的 LiteParse 对中文 PDF / Word 的解析质量，是否需要换 MinerU
- [ ] Presenton 自定义模板（HTML + Tailwind）写中文排版的实际工作量
- [ ] DeepPresenter 跑通所需的实际环境成本（Docker 双镜像 + WSL + Playwright + MinerU）
- [ ] DeepPresenter 自由式产出的成品率，以及它导出的 PPTX 质量
- [ ] HTML → JSON 元素模型的转换保真度（决策 1 的关键未知数）
- [ ] DeerFlow 挂载方式：作为前置步骤还是 MCP tool

**建议的第一步**：两个都在本地跑起来实测。DeepPresenter 可以直接 `uvx pptagent generate "..." -o test.pptx` 命令行试，不用先搭全套；Presenton 一条 docker 命令。**比看 README 判断准得多。**

## 五、风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| **自由式生成成品率低** | 高 | 渲染后校验必须进 MVP（决策 2） |
| HTML→JSON 转换失真 | 高 | 第一周就验证；备选方案是全程用 JSON，牺牲自由度 |
| Presenton 中文排版效果差 | 中 | 自己写模板，或改用 PPTist 当渲染层（但踩 AGPL） |
| 深度调研成本失控 | 中 | 模型分层路由（决策 5）+ 调研轮次上限 |
| PPTX 导出保真度不足 | 中 | 参考 Oh My PPT 的 html2pptx 自研路线 |
| 依赖项目停止维护 | 低 | 选的都是近三个月有更新的项目 |

---

**下一步动作**：跑「待验证清单」里的前两项，结果回填到本文档，再决定是否调整路线。
