# 07 · Agent 功能测试脚本

覆盖全部 **15 个工具**的分轮测试。每轮一个 prompt，直接粘进 Agent 面板。

分轮不是为了好看：**单轮塞太多，失败时无法定位是哪个工具坏的**。分开跑，哪轮红就查哪块。

改动依据见 [04-changes.md](./04-changes.md)，工具实现在 `server/src/agent/tools.ts`。

## 工具清单与角色可达性

| 类 | 工具 | Planner | Generator | Reviewer | Editor |
|---|---|:-:|:-:|:-:|:-:|
| 读 | `getDeck` `getSlide` `findElements` `lintDeck` | ✓ | ✓ | ✓ | ✓ |
| 写 | `addSlide` `updateSlide` `deleteSlide`<br>`addElement` `updateElement` `deleteElement`<br>`setTheme` | — | ✓ | — | ✓ |
| 动画 | `setAnimationPreset` `addAnimation` `removeAnimation` | — | ✓ | — | ✓ |
| 背景 | `setSlideBackground` | — | ✓ | — | ✓ |

**只有 Generator 和 Editor 拿得到全部 15 个**，所以覆盖测试必须走这两条路径。

路由规则（`orchestrator.ts`）：

```
画布有选中元素 → Editor 单角色处理
没有选中       → Planner → Generator → Reviewer →（不过则 Generator 再修一轮）
```

步数预算：Planner/Reviewer 12 · **Generator 48** · Editor 24。超限会推一条 `⚠ 达到步数上限` 到面板。

## 覆盖矩阵

| 轮次 | 覆盖工具 | 目的 |
|---|---|---|
| **R1** 建 | getDeck · setTheme · addSlide · setSlideBackground · addElement · updateElement · setAnimationPreset · addAnimation | 从零建 deck，走通写入主路径 |
| **R2** 改删查 | findElements · getSlide · updateSlide · removeAnimation · deleteElement · lintDeck · deleteSlide · getDeck(includeElements) | 增量修改 + 级联删除 + 校验 |
| **R3** 负向探针 | addElement · addAnimation · lintDeck | **验证闸门会拒绝非法输入**（这一轮期望看到 error） |
| **R4** Editor | 全部 15 个可用 | 选中元素的局部编辑路径 |
| **R5** 自由式 | 不限 | 测判断力和步数上限，不是覆盖测试 |

R1 + R2 的并集就是 15/15。

## 测试前置

1. 后端起着：`cd server && bun run dev`
2. 前端起着：`npm run dev`
3. **新建一个空 deck**（新建的 `slidesJson` 默认是 `[]`，零页 —— R1 就是从空态开始的）
4. 四个角色都在设置页配好模型，尤其是 **Reviewer**（历史上这个角色报过 `Not Found`）
5. 开着服务端控制台，盯 `[llm]` 和 `[agent]` 两类日志

---

## R1 · 建

> 【功能测试 R1】请严格按顺序执行，每一步都真实调用对应工具，不要合并、不要跳过。
>
> 主题：用「深海蓝」科技风做一份《Deck Kernel 设计要点》。
>
> 1. 先 `getDeck` 看当前状态（可能是空的）。
> 2. `setTheme`：backgroundColor `#0a0e27`、fontColor `#e6ecff`、fontName `Microsoft YaHei`、themeColors 用 `["#00d4ff","#7c5cff","#ff6b9d","#ffc857","#3ddc97","#5b9bd5"]`。
> 3. `addSlide` 建封面页，id 用 `slide_cover`，type=cover，背景 solid `#0a0e27`，页内放一个 id=`el_cover_title` 的 title 文本。
> 4. `addSlide` 建内容页，id 用 `slide_body`，type=content，背景用 linear 渐变从 `#0a0e27` 到 `#1a2244`。页内放：一个 id=`el_body_title` 的 title 文本，以及两张并排卡片 id=`el_card_a` / `el_card_b`（用 text 元素带 fill=`#1a2244`，内容分别讲「纯函数可单测」和「agent 只能调工具」）。
> 5. `addSlide` 建结束页，id 用 `slide_end`，type=end，页内放一个 id=`el_end_title` 的 title 文本。
> 6. `addElement` 在封面页加一个 id=`el_cover_sub`、textType=subtitle 的副标题。
> 7. `updateElement` 把 `el_cover_sub` 的 top 改成 320。
> 8. `setSlideBackground` 把结束页背景设成 solid `#0a0e27`。
> 9. `setAnimationPreset` 给内容页 `slide_body` 套 `sequential`，effect 用 fade-up，duration 600。
> 10. `addAnimation` 单独给 `el_cover_title` 加一条 fade-down（type=in，duration=500，trigger=click），动画 id 用 `anim_cover_1`。
>
> 做完后列出你实际调用的工具名和各调用几次。

**预期**：10 次工具调用全部 `ok: true`；画布实时出现三页；内容页动画数 = 3（preset 展开的）。

---

## R2 · 改删查

> 【功能测试 R2】在同一份 deck 上继续，严格按顺序，每步真实调用工具。
>
> 1. `findElements`，不传 slideId、textType 传 `title` —— 列出全 deck 的标题。
> 2. `findElements`，slideId 传 `slide_body`、不传 textType —— 列出该页所有元素。
> 3. `getSlide` 读 `slide_body` 完整数据，报告它此刻的 animations 数组长度。
> 4. `updateSlide` 给 `slide_body` 设置 remark = `本页讲 kernel 的纯度纪律`，turningMode 设成 `slideIn`。**这步不要用 setSlideBackground。**
> 5. `removeAnimation` 删掉 `el_card_b` 身上的动画（用 elementIds 参数）。
> 6. `deleteElement` 删掉 `el_card_a`（它带动画，动画应该被级联清掉）。
> 7. `lintDeck` 检查 —— **如果报告里出现「孤儿动画」错误，说明级联删除失效，请如实报告，不要自己修**。
> 8. `deleteSlide` 删掉 `slide_end`。
> 9. `getDeck` 传 includeElements=true，输出最终结构。
>
> 汇报三件事：实际调用的工具清单（名 × 次数）、第 7 步 lintDeck 的原始返回、有没有工具报错及错误原文。

**预期**：9 次调用全 ok；第 7 步 lintDeck 的 `issues` 里**不应有**孤儿动画；第 9 步显示 2 页。

---

## R3 · 负向探针（期望看到失败）

这一轮专门验证 kernel 闸门真的会挡住非法输入。**agent 报告原始错误即为通过，不要让它自己修。**

> 【功能测试 R3】这是一次**故意的错误输入测试**，目的是检验后端校验是否生效。
> 请按顺序执行，每一步**如实报告返回的原始 JSON**，**不要自动纠正、不要重试**。
>
> 1. `addElement` 在 `slide_body` 加一个 text 元素，id=`el_bad_1`，只给 id / type / left / top / width / height / rotate / content，**故意不给 defaultFontName 和 defaultColor**。
> 2. `addElement` 再加一个 id=`el_body_title` 的 text 元素（**故意用一个已存在的 id**），字段给全。
> 3. `addElement` 加一个 id=`el_bad_3` 的 text 元素，**width 故意设成 0**，其余字段给全。
> 4. `addAnimation` 给 `el_body_title` 加一条 effect=`exit-fade` 但 **type 故意写成 `in`** 的动画。
> 5. `addElement` 连加两个 text 元素 id=`el_ov_a` / `el_ov_b`，**位置完全一样**（left 100 / top 100 / width 300 / height 100），字段给全。
> 6. `lintDeck` 看最终报告。
>
> 汇报：每一步是 ok 还是 error，error 的原文是什么；第 6 步 lintDeck 的完整 issues。

**预期**：

| 步骤 | 预期结果 |
|---|---|
| 1 缺必填字段 | ❌ `text 元素校验失败 —— defaultFontName: Required...` |
| 2 重复 id | ❌ `元素 id "el_body_title" 已存在于第 N 页` |
| 3 width=0 | ❌ `width: Number must be greater than 0` |
| 4 effect/type 不自洽 | ❌ `动画效果 "exit-fade" 属于 out，不能标成 type="in"` |
| 5 完全重叠 | ✅ 加得进去，但返回里带 `warnings: ["文本元素 ... 重叠 100%"]` |
| 6 lintDeck | 报出第 5 步的重叠 |

**任何一条本该 ❌ 的返回了 `ok: true`，就是闸门漏了。**

---

## R4 · Editor 路径

**这一轮 prompt 触发不了，必须先在画布上点选一个元素** —— Editor 是靠前端传 `selectedElementIds` 路由的。

先在画布点中封面标题 `el_cover_title`，然后：

> 把选中的元素改成主题强调色 `#00d4ff`、字号 40px，水平居中（画布宽 1000）。
> 然后给它加一个 grow-shrink 强调动画（duration 800，trigger click）。
> 最后 `lintDeck` 确认没引入新问题。

**预期**：Agent 面板里 Editor 角色**不应该**出现 `findElements` / `getSlide` 调用 —— 选中元素的完整数据已经预注入到 prompt 里了。如果它还是先查了一遍，说明预注入没生效。

---

## R5 · 自由式（测能力上限，不是覆盖测试）

新建一个空 deck，然后：

> 用「深海蓝」科技风做一份 6 页的《为什么 agent 不能直接写 deck JSON》，
> 每页要有标题、配色统一、关键元素加入场动画，最后自查一遍排版。

这轮看的是判断力和步数：

- Generator 有没有在 48 步内做完（做不完会推 `⚠ 达到步数上限`）
- 有没有主动用 `setAnimationPreset` 而不是逐个 `addAnimation`
- Reviewer 有没有真的挑出问题并触发 Generator 修正轮

## 服务端日志观察点

```
[llm] baseUrl 规范化: "..." → "..."     ← 说明管理员填的 baseUrl 被修正了
[llm] {role} → provider=... model=...   ← 四个角色各自解析到哪个模型
[agent] {role} → calling generateText (maxSteps=N)
[agent] {role} truncated at maxSteps=N  ← 步数耗尽，任务只做了一半
[agent] task failed: [reviewer] 模型调用失败：Not Found
        provider="..." model="..." baseUrl="..."
        提示：404 通常是模型名不在该 provider 上，或 baseUrl 少了/多了版本段
```

最后一条是给历史上那个 `Reviewer Not Found` 准备的 —— 现在报错自带 provider / model / baseUrl，不用再猜。

## 已知限制（测出来也别当 bug 报）

| 限制 | 说明 |
|---|---|
| 无图片生成 / 搜索工具 | agent 只能填外部 URL。`asset://` 链路前端已就绪（R-10/R-11），后端工具还没做 |
| 无 `fillFromTemplate` | R-09 未完成，自由式失败没有模板回退 |
| 无事务 / 回滚 | 逐工具提交，中途失败会留半成品 |
| 无并发控制 | agent 跑的时候用户手改画布，会被下一条 `agent.deck` 整份覆盖 |
| lint 无文字溢出检测 | 需要字体测量，不在 kernel 纯函数范围内 |
