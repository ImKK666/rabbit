# R — 阶段化工作流重设计（策划稿 + 硬闸门 + 执行守卫）

> 状态：**R-63 已实现并三绿提交**（策划稿层 / 闸门升级 / 守卫①② / prompt 六阶段 /
> 前端方案卡片）；R-64（守卫③④ + pageIndex 寻址）与 R-65（方案可视化进度）见 §九。
> 来源：数据库调用日志实测（2026-08-21，会话 70 / 76）+ 两个参照项目
> （`refs/skills/03-agent-frameworks/ppt-agent-workflow-san` 的
> 「约束流程不约束实现」、`refs/skills/06-image-gen/GordenSuperPPTSkills` 的
> 「文件化门禁 + 大纲层决策 + 页级 QA」）。
> 红线不变：deck 只能经 kernel 变更；版式几何由代码确定；单一权威写者。

## 一、现状的问题（日志实测，不是印象）

| 现象 | 数据 | 根因 |
|---|---|---|
| 重试风暴 | 5 页的稿子 `generateBackdrop` 打 85 次、84 次失败；本地限流倒计时 52s→2s 被当自旋时钟；上游配额耗尽后还在打 | 限流由 LLM 处理，拒绝信息在邀请重试 |
| 整页重排风暴 | 50 页稿子 `applyLayout` 169 次，同一批 36 页 8 分钟内被整体重排三轮（换色→再换色）；平均每页 3.4 次 | 模型拿 applyLayout 当「改色工具」，每次都是模板全量重建 |
| 无视用户规则 | 用户明确「一页一页」，23 个回合一次编辑多页，最多一回合 15 页 | 规则只写在 prompt 里，没有结构性约束 |
| 风格趋同 | 5 个部门分组 pattern 序列一模一样（`section→cards→bullets→…→stat` 整组复制）；354 次 applyLayout 只有 17 次带 variant | pattern 选择发生在「边做边想」的执行层，没有任何一层强制去重 |
| 打错页 | 用户说「第二页」，agent 一直打 dashboard（前面删过 5 次页，id↔页码漂移） | 工具只认 slideId，模型拿旧页序寻址 |
| 盲等 | reflectRender 4 次全部白等 20 秒（页面没开） | 超时结果不改变后续行为 |

一句话：**rabbit 现在是「单 agent mutation 循环」——流程只存在于 prompt 的软约束里。
两个参照的共同点是：把「想清楚」从 prompt 里的一句话，升级成一个必须交付、
必须过关、独立于执行层的阶段。**

## 二、两个参照的流程骨架（只搬骨架，不搬渲染方式）

### ppt-agent-workflow-san —— 阶段化 + 人肉闸门

```
澄清需求 → 判断要不要调研 → 整理资料 → 调研简报 → 大纲 → 策划稿 →
样稿 → 【停下来等人确认】→ 规模化 → 复核交付
```

- 核心：**约束流程，不约束实现**；内容先于设计；视觉打磨推迟到叙事线成立之后
- 中间层「**策划稿**」（逐页规划卡：目的 / 要记住什么 / 证据 / 信息层级 / 视觉形式）
  是它认为最大的质量收益
- review-gate 是**流程的一部分**：重要稿件在规模化之前必须停一次，让人看中间产物
- 产物分层：不每次都做到底，停在哪层由需要决定

### GordenSuperPPTSkills —— 产物文件 + 硬门禁

```
阶段1：确认 → outline.json（每页不重复框架 + 统一配色 + 厚内容）→ 每页提示词 →
       imagegen 逐页出图 → 合成（门禁：imagegen-manifest.json 缺一页即判失败）
阶段2：逐页 探色 → 复刻背景 → 提取框架 → 图标表 → 抠图切片 → 定位 → 取文字 →
       合成 → 视觉 QA 回校循环（每页一个闭环）
```

- 门禁是**硬件的**：没有 manifest 文件 = 阶段失败 = 不许进入下一阶段，模型自评不算数
- **风格决策全部发生在 outline 层，之后每页独立执行**；失败只重出那一页
- 页级 QA 闭环：合成 → 对比 → 改 layout → 再合成，循环到贴合
- 内容优先：把「排版太简单」归因于内容太薄（每页 ≥4 模块 × 标题+要点+指标）

## 三、rabbit 新流程（六阶段）

rabbit 是**交互式编辑器**（画布实时同步、kernel 确定性排版），不能照搬
Gorden 的「整页出图再逆向」；搬的是**阶段结构**：

```
┌─ 阶段 0 · 规划（新）────────────────────────────────────────┐
│ 想清楚叙事线 + 逐页版式 → setPlan 落策划稿 → 校验不过当场拒 │
│ [重要稿件] askUser 闸门：方案给用户看，确认后才往下走        │
└─────────────────────────────────────────────────────────────┘
  阶段 1 · 定调        setTheme 一次（锚点色 + 字体 + 质感 + artDirection）
  阶段 2 · 建页        按策划稿逐页：addSlide → applyLayout(照 plan 的 pattern/variant)
                       ├ 守卫① applyLayout 防抖：同页本轮重排即拒
                       ├ 守卫② 换色风暴：逐页换色被指回 setTheme
                       └ 每页 reflectRender（页级，见守卫④）
  阶段 3 · 整稿校验     lintDeck（新增 lint ⑫ 策划稿一致性）
  阶段 4 · 生成图层     generateBackdrop / addOrnament
                       └ 守卫③ 限流不自旋：拒绝 = 本回合禁用，配额耗尽 = 本任务禁用
  阶段 5 · 收口         整稿 reflectRender + 收尾话术（现有 FINALIZE 机制不动）
```

对照两个参照：阶段 0+闸门 = san 的「大纲→策划稿→review-gate」合并层；
守卫③④ = Gorden 的「失败只重出该页 + 页级 QA」；
守卫①② = 治日志里那两场风暴的针对性护栏。

## 四、阶段产物与落点

| 阶段 | 产物 | 载体 | 校验 |
|---|---|---|---|
| 0 | 策划稿 | `conversations.plan_json`（新列，迁移 0009）+ 下行 `agent.plan` 面板展示 | kernel `validatePlan`（P1–P8，写时拒错） |
| 1 | 主题 | `decks.theme_json`（现有） | lint ⑨ 等现有规则 |
| 2 | 页面 | `decks.slides_json`（现有） | kernel 现有校验 + 守卫①② |
| 3 | 校验结果 | — | lintDeck + **lint ⑫ 策划稿一致性** |
| 4 | 图层 | assets 表 + 元素（现有） | 现有 O1/O6 等 |
| 5 | 收尾话术 | 消息历史（现有） | — |

策划稿是 **conversation 级**而不是 deck 级：同一份 deck 的两个会话可以有两个意图
（「扩到 50 页」vs「打磨封面」），方案跟着会话走；fork 的新会话不带旧方案（新方向）。
它留在会话历史里随上下文每轮回灌（setPlan 的参数本身就在历史里），
另存 `plan_json` 一列是为了**不被历史截断丢掉** + 面板随时能读。

## 五、策划稿 schema 与校验（kernel 纯函数）

```ts
interface DeckPlan {
  version: 1
  narrative: string        // 一句话叙事线（闸门时给用户看）
  styleIntent: string      // 一句话视觉意图（闸门时给用户看）
  sections: PlanSection[]
}
interface PlanSection {
  id: string               // 如 s01
  title: string
  purpose: string          // 这段要干什么
  slides: PlanSlide[]
}
interface PlanSlide {
  id: string               // 将来直接当 slideId
  title: string
  purpose: string          // 这页的目的
  keyMessage: string       // 观众要记住的一句话（P6 非空）
  pattern: LayoutPattern
  variant?: 'A' | 'B'      // 仅三个支持变体的版式可传
  modules: number          // 并列模块数（内容密度基线前置）
}
```

`validatePlan(plan): { ok, errors }` —— 8 条规则，全部可单测：

| # | 规则 | 治什么 |
|---|---|---|
| P1 | pattern 必须在版式清单内；variant 只对 `title-center/bullets/cards` 且 ∈ {A,B} | 幻影版式 |
| P2 | 相邻两页 pattern 不同（B 变体算不同结构） | 相邻雷同（现有 lint 前置） |
| P3 | 单一 pattern ≤ 全篇内容页 40% | 一个版式占满（现有 lint 前置） |
| P4 | 节奏页（section/stat/quote/full-figure/end）间隔 ≤ 4 内容页 | 连排内容页（现有 lint 前置） |
| **P5** | **任意两个 section 的 pattern 序列签名相同 → error** | **日志里 5 组模板整组复制** |
| P6 | 内容页 `modules ≥ 3` 且 `keyMessage` 非空 | 内容太薄（密度基线前置） |
| P7 | slide/section id 全局唯一、非空 | 映射失效 |
| P8 | 页数 ≥ 2（封面 + 至少一页），narrative/styleIntent 非空 | 空方案 |

三条前置 lint（P2–P4）**搬到规划层**的意思是：以前建完页才报、报完靠 169 次
applyLayout 修；现在方案写错当场拒，改方案是改一段 JSON，不是重排 36 页。

**lint ⑫ 策划稿一致性**（建页后，`lintPlanAdherence(plan, deck)`）：
每页实际 pattern 与策划稿声明不一致 → warning「这页版式偏离策划稿」；
plan 里声明了但 deck 里没有的页 → warning「策划稿里的页还没建」。
只提醒不拒绝（局部调整 / 中途改主意是合法的），但漂移会被看见。

## 六、闸门设计（askUser 升级）

- **位置**：setPlan 之后、setTheme 之前 —— san 的顺序是「内容方向确认先于视觉投入」，
  现在正好反着来（先投视觉再问方向，问完还要返工）
- **对象**：策划稿本身，不是一句方向。问题形如：
  「方案已定：〈narrative 一句〉，共 N 页、M 段、版式序列〈摘要〉。按这个方案做吗？
  是 = 照方案做，否 = 重新规划」
- **触发条件**：沿用现有「重要稿件」清单（对外 / 管理层 / 销售 / 技术密集 / 方向分岔），
  **新增自动升级**：页数 ≥ 12 或段落 ≥ 3 一律视为重要（50 页那种稿子不可能不重要）
- 每个任务最多一次、超时按自己判断继续（沿用现有机制，`askTool.ts` 不用重写，
  只改 prompt 里闸门一节 + 问题模板引用方案）
- 前端：`agent.ask` 面板上方就是刚渲染的 `agent.plan` 卡片，用户看着方案点「是/否」
- 用户说「直接做」→ 跳过闸门，但 setPlan 照写（校验和 lint ⑫ 仍然生效）

## 七、执行纪律（工具层守卫，pipeline/kernel 可测）

### 守卫① applyLayout 防抖（治 169 连击）

工具层按轮记录：`slideId → 本轮已排 (pattern, variant, contentHash)`。

- 同页本轮再次 applyLayout 且 pattern+variant+内容签名全同 → 拒绝：
  「这一页已经是这个版式，无需重排。局部改用 updateElement，换结构才许重排」
- 同页本轮再次 applyLayout 但只换了显式颜色 → 走守卫②的判定

合法的重排（换 pattern、换 variant、内容真的变了）不受影响。

### 守卫② 换色风暴（治「改色 = 重排全篇」）

applyLayout 带显式 `primaryColor/accentColor/backgroundColor` 时，工具检查本轮：

- 这套显式色已在 **≥3 个不同页**出现过 → 拒绝并指路：
  「你在逐页传同一套覆盖色 —— 这是整份换色，用 setTheme 改主题锚点，
  已经排过的页会自动继承，不要逐页重排」
- 覆盖色与主题锚点冲突但只出现在个别页 → 放行（个别页破例是现有设计），
  但 lint ⑨/⑩ 那套「颜色真的被改过」的判据继续兜底

### 守卫③ 限流不自旋（治 85 连击）

- 本地限流拒绝 → 结果**不再带倒计时**，写「被限流。**本回合该工具已禁用**，
  用别的方案继续，不要重试」；同一回合后续调用直接拒绝，连限流器都不查
- 上游配额耗尽（429 兜底 / 中转站额度）→「**本任务该工具禁用**，走无底图方案」，
  任务级状态，后续回合也拒绝
- gemini 形状保留配置限额；openai 形状本来就放行（R-62），不受影响

### 守卫④ reflectRender 页级 + 断线短路（治盲等）

- 新增可选 `slideIds` 参数：阶段 2 每页排完量那一页（Gorden 的页级 QA 闭环），
  阶段 5 再整稿量一次
- 任务内**第一次**测量超时（页面没开）→ 标记 `viewportClosed`，
  本任务后续所有 reflectRender **立即返回**「浏览器未连接，跳过测量」，
  不再每次白等 20 秒

### 页码寻址（治打错页）

`getSlide / applyLayout / updateElement / generateBackdrop / addOrnament` 增加
可选 `pageIndex`（人类第几页，1 起）：调用时按**此刻**的 deck 顺序解析成 slideId，
结果回带「第 N 页 = slideId X」。模型可以一直用人类页码说话，
id↔页码漂移由代码当场解决。

## 八、prompt 工作顺序改写（roles.ts）

`DECK_AGENT_PROMPT` 的「工作顺序」一节整体重写为六阶段（对应第三节）：

- 步骤 0 从「先想清楚」改成「**想清楚 → setPlan 落策划稿**（校验不过会拒）→
  重要稿件 askUser 闸门」。策划稿是给**方案**不是给成品，改起来便宜
- 步骤 3 强调**按策划稿逐页建**：pattern/variant 照方案抄，要改先改方案
  （setPlan 重写）再改页 —— 漂移会被 lint ⑫ 点名
- 「一页一页」从用户偏好升级为流程默认：排完一页再排下一页，
  一次排多页会把上一页的细节忘掉；守卫①②会让整批重排直接失败
- 段落结构多样性：同一份稿子里两个段落不要用同一套版式序列
  （策划稿校验 P5 会拒，等于把这条从「建议」变成「错误」）
- 删掉「重试」相关的旧措辞（限流/底图失败段落），替换成守卫③的新语义
- 局部调整分支（选中元素）不动：不进阶段 0，不写方案

## 九、实现分期

### R-63 · 核心闭环（第一阶段）

1. `server/src/domains/deck/plan.ts`：`DeckPlan` 类型 + `validatePlan`（P1–P8）+
   `lintPlanAdherence`（lint ⑫）+ `planSignature`（P5 用）
2. 迁移 0009：`conversations.plan_json TEXT`；`db/schema.ts` 同步
3. `server/src/domains/deck/planTool.ts`：`setPlan`（校验→落库→发 `agent.plan`）+
   `getPlan`；pipeline 按轮装配（同 askTool 模式，不 import db 进 tools.ts）
4. `roles.ts`：工作顺序六阶段重写 + 闸门一节重写
5. 守卫①②：`tools.ts` applyLayout 防抖 + 换色风暴（每轮状态在 accessor 侧）
6. 闸门升级：`askTool.ts` 问题模板 + prompt 触发条件（页数/段落自动升级）
7. 前端：`AgentPanel.vue` 渲染 `agent.plan` 卡片；`websocket.ts` 加消息类型
8. 测试：`validatePlan` 判据组（含会话 76 那 5 组复制结构的负对照）+
   守卫①②负对照 + planTool 落库/发射 + lint ⑫ 漂移 + events fixtures 更新

### R-64 · 执行纪律（第二阶段）

- 守卫③ 限流不自旋（ornamentTool / assetTools 限流路径）+ 任务级禁用状态
- 守卫④ reflectRender 页级参数 + viewportClosed 短路（reflectTool / pendingRequests）
- pageIndex 寻址（5 个页级工具）+ 解析结果回带页码
- 测试 + 判据

### R-65 · 可视化（第三阶段，可选）

- 策划稿面板：段落折叠 + 每页卡片（pattern / 模块数 / keyMessage），
  执行进度按「已建 / 未建」打勾

## 十、风险与边界

- **守卫①②可能误伤**：合法场景是「换 pattern/variant 重排」或「内容真的变了」，
  都放行；被拒场景提示语必须指路（updateElement / setTheme / 改方案），
  不能只回一个 false
- **闸门默认化可能烦人**：普通小稿子不闸（沿用清单 + 页数/段落阈值），
  只有大稿子和重要稿子停；「直接做」可以跳过
- **plan 与 deck 漂移**：lint ⑫ 只 warning 不 block —— 局部调整和合理改主意不能被
  锁死；执行层偏离方案是可见的，由用户和后续 lint 判断
- **历史截断**：方案同时存在于历史（setPlan 参数）和 `plan_json` 列，截断后
  `getPlan` 仍可取回
- 现有 1834 条测试的红线：kernel 只加纯函数不动既有 lint；applyLayout 行为变化
  只在守卫路径上，正常路径逐字节不变

## 十一、验收判据

1. `validatePlan` 对会话 76 的 5 组同构方案结构判 error（负对照）
2. 模拟「同页重排 ×36」：守卫①第二次即拒，不再产生版本号风暴
3. 模拟「逐页换色」：守卫②第 3 页起拒，指路 setTheme
4. 模拟限流：同一回合第二次调用直接拒绝，倒计时不再出现在任何结果里
5. 模拟页面未开：reflectRender 第一次超时后，后续调用 0 等待立即返回
6. 全量测试 + `bunx tsc --noEmit` + `vue-tsc --build` 三绿
