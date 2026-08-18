# 09 · PowerPoint 人工验证清单

08-expressiveness.md 第四节的五条验收标准里，前三条已经落成 `lintDeck` 的自动规则，
第四条**「导出的动画在真实 PowerPoint 里能正常播放」只能人工验**。这份文档是那次人工验证的操作手册。

前置阅读：[08-expressiveness.md](./08-expressiveness.md) · [05-pptx-export.md](./05-pptx-export.md)

## 一 · 为什么必须验

这是 04-changes.md 里挂了很久的 **E3 地面真相**：

25 个动画效果从来没在真实 PowerPoint 里打开确认过，只有单测背书 ——
**而单测只能证明 XML 长得符合预期，证明不了 PowerPoint 认。**

这一轮把 25 扩到 45，同时改了时间线的基础结构（见下），风险按决策 P2 是「批量扩、最后一起验」。
所以样本按**能二分定位的粒度**切好了：一类滤镜一份文件，一份文件里一页一个效果。
哪份打不开、哪页不动，直接就把问题夹到了一个 filter 家族或一条代码分支上。

### 这一轮动过的、最需要盯的四处

| 改动 | 原来 | 现在 | 错了会怎样 |
|---|---|---|---|
| **时间线嵌套层数** | 2 层 `<p:par>` | 3 层（点击步 / 子步 / 效果） | 整页动画连成一串自动播完，不停下来等点击 |
| **退场 visibility 时机** | `delay="0"` | `delay="dur-1"` | 元素先瞬间消失，淡出动画对着空气播 |
| **强调回弹结构** | 裹在嵌套的 `<p:seq nodeType="mainSeq">` 里 | 两段 `animScale` 平铺，第二段带 `delay` | 一页出现两条主时间线，PowerPoint 可能整段忽略 |
| **`effectFilter` 词表** | 只有硬编码的 `wipe(r)` | 完整 OOXML 滤镜表，`wipe(right)` 等规范写法 | 效果不播，元素直接出现（无动画） |

`wipe` 的 presetID 也从 5（Checkerboard）改成了 22（Wipe）—— 原来效果能播，但动画窗格里显示成「棋盘」。

## 二 · 生成样本

```bash
npm run samples          # → samples/animations/*.pptx，20 份
```

仓库里已经带了一份生成好的。改了 `buildTimingXml.ts` / `configs/animation.ts` 之后重新跑一遍即可。

生成器是 `scripts/build-animation-samples.ts`，它和真实导出路径**共用要害部分**：
`buildSpidMap` / `buildTimingXml` / `buildTransitionXml`，以及「transition 在前、timing 在后」的注入顺序。
不共用的只有喂给 pptxgenjs 的方式。所以样本能证明「动画树本身 PowerPoint 认」，
不能证明「复杂元素的几何也对」—— 后者由第五节的真实导出验证。

## 三 · 怎么验

### 环境

**至少在真 PowerPoint 里过一遍**（macOS 或 Windows 桌面版，不是 Web 版 —— Web 版对动画的支持是子集）。
有条件再补 WPS 和 Keynote，那是「其他 PPT 软件」这条硬约束的实际检验。

### 每份文件的操作

1. 双击打开 → **不报「需要修复」就算第一关过了**（结构合法）
2. `Shift + F5` 从当前页开始放映
3. 每页点一次鼠标，看方块是不是按标题写的效果动
4. 回到编辑态，右键方块 →「动画窗格」，看效果名对不对

### 逐份清单

先验这三份，它们最可能暴露结构性问题：

| 文件 | 页数 | 看什么 | 不对的话说明 |
|---|---:|---|---|
| **trigger-sequencing** | 5 | ①点三次出三个 ②点一次三个同时出 ③点一次三个依次出 ④**不用点**第一个就自己出 ⑤方块**淡出**而不是瞬间消失 | 三层 `<p:par>` 嵌套或退场 `<p:set>` 时机不对 |
| **filter-wipe** | 5 | 四个方向的擦除，方向是否符合标题（"自左擦除" = 从左边开始揭开） | `filter` 字符串写法或方向映射不对 |
| **behavior-motion** | 10 | 位移方向是否符合标题（"自下淡入" = 从下方飞上来） | `presetSubtype` 方向位掩码或 `ppt_x/ppt_y` 公式不对 |

前三份都过了，再扫剩下的：

| 文件 | 页数 | 效果 |
|---|---:|---|
| filter-blinds | 3 | 百叶窗横 / 竖 / 退出 |
| filter-checkerboard | 1 | 棋盘 |
| filter-dissolve | 2 | 溶解进 / 出 |
| filter-randombar | 1 | 随机线条 |
| filter-strips | 1 | 阶梯状 |
| filter-box | 1 | 盒状展开 |
| filter-circle | 2 | 圆形展开 / 收拢 |
| filter-diamond | 1 | 菱形展开 |
| filter-plus | 1 | 十字展开 |
| filter-wedge | 1 | 楔入 |
| filter-wheel | 1 | 轮辐（4 辐） |
| filter-fade | 2 | 淡入 / 淡出（对照组，这个一定要能播） |
| behavior-scale | 10 | 缩放进退 + 6 档强调（**强调类要能回到原大小**） |
| behavior-rotate | 2 | 旋转进入 / 陀螺旋转（**陀螺旋转要转满一整圈**） |
| behavior-opacity | 1 | 闪烁（**要变暗再变回来**，不是停在半透明） |
| **slide-transitions** | 12 | 翻页转场。翻页时看整页怎么切进来 |
| all-effects | 45 | 全量矩阵，前面都过了再看这份，用来查漏 |

`slide-transitions` 里 **slideX3D / slideY3D / rotate 三页是已知降级**（PPTX 基础规范里没有 3D 推移和整页旋转，
p14/p15 扩展换个软件就不播）。它们分别退化成普通左右推移 / 上下推移 / newsflash，**这不是 bug**。

### 记录结果

按这个格式回报，我按它决定修哪里：

```
环境：PowerPoint for Mac 16.9x / Windows 365
filter-wipe        ✅
filter-blinds      ❌ 第 2 页（blinds-v）不动，元素直接出现
trigger-sequencing ⚠️ 第 4 页需要点一下才开始
...
```

「不动 / 直接出现」和「动了但方向反了」是完全不同的两类问题，请分开写：
前者是 filter 字符串不被识别，后者是方向映射写反了，修的地方不一样。

## 四 · 已知的取舍（不用报）

| 现象 | 原因 |
|---|---|
| 3D 推移变成普通推移 | 基础 schema 没有，p14/p15 扩展非 PowerPoint 不播 |
| 转场时长只有慢/中/快三档 | 只写 `spd`，没写 `p14:dur`（那需要 `mc:AlternateContent` 包一层） |
| 网页预览的百叶窗 / 棋盘 / 溶解和 PowerPoint 里节奏不一样 | `cssExact: false`，CSS 只能用 mask 做近似，**PPTX 侧才是保真的那边** |
| 渐变背景导出后变成一个平均色 | pptxgenjs 不支持渐变填充，属于既有限制 |
| 没设过转场的页面导出后没有转场 | 刻意的 —— 不给用户没设过的页面凭空加动画 |

## 五 · 顺带验一下真实导出

样本只覆盖动画树。真实导出还要看几何和文本，所以额外做一次端到端：

1. 起服务，让 agent 做一份 5~6 页的演示文稿（提示词里要求包含图表、表格、流程形状）
2. 编辑器里导出 PPTX
3. PowerPoint 打开，看：
   - 文字有没有溢出文本框、字号层级是否还在
   - 形状的圆角有没有被拉成椭圆角（`pathFormula` 重算那条逻辑）
   - 图表的数据和图例对不对得上
   - 表格的表头底色、列宽比例对不对
   - 动画是否按页播放，顺序是否符合阅读顺序

第 3 步里任何一项不对，都比样本里的问题更值得优先修 —— 那是用户真正会遇到的路径。
