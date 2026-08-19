/**
 * 版式核查用的样本内容（开发工具，不参与打包）
 *
 * `inspect-layout-order.ts`（看出场顺序）和 `layout-sheet.ts`（看长什么样）
 * 共用这一份。**刻意只有一份**：两边各写一套样本，看到的就不是同一页，
 * 「顺序对了但版面歪了」这种问题会在两个工具之间的缝里漏掉。
 *
 * 图片用的是 COS 上真实存在的 12 张（第十七 / 十八轮实测传上去的），
 * 不是占位图 —— 遮罩浓度、cover 裁剪、文字压不压得住，**只有真照片能回答**。
 * 合成的灰块永远是「刚好压得住」。
 */

import type { SlideTheme } from '../src/types/slides'
import type { LayoutContent, LayoutPattern } from '../server/src/domains/deck/layouts'

/** 浅色主题：仓库默认那一套 */
export const THEME_LIGHT: SlideTheme = {
  themeColors: ['#2f6feb', '#f2596b', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
  fontColor: '#1a1a1a',
  fontName: '',
  backgroundColor: '#ffffff',
  shadow: { h: 3, v: 3, blur: 2, color: '#808080' },
  outline: { width: 2, color: '#525252', style: 'solid' as const },
}

/** 深色主题：`buildPalette` 的 dark 分支（surface / 遮罩浓度 / onPrimary 全走另一条路） */
export const THEME_DARK: SlideTheme = {
  ...THEME_LIGHT,
  themeColors: ['#4f7df3', '#ffd166', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
  fontColor: '#f2f4f8',
  backgroundColor: '#12141c',
}

/**
 * COS 上真实存在的图，`asset://<hash>` 直接可解析。
 * 宽高是**库里记的真实解码像素**，不是请求时的比例 —— 第十八轮那个
 * 「报原图尺寸、给缩略图」的 bug 就是从这里来的。
 */
export const FIGURES = {
  /** 1280×853 横图，机房走道 */
  hall: { src: 'asset://abcd522317cbcebd6ac6c0e061f16b66bc475fa98abaad1e23758a2f7150ac5c', width: 1280, height: 853 },
  /** 1280×719 横图，机柜蓝光 */
  rack: { src: 'asset://2ad34340c4e01c1f2a35a3c7f6d1455da1f20ffe3e4b994b8f916c46dce82ea4', width: 1280, height: 719 },
  /** 853×1280 **竖图** —— 塞进横向的 panel / backdrop 时裁剪最狠，最容易露馅 */
  tall: { src: 'asset://25f6b655358ae81672a0b31ae0365cade14683aab441e3604f2c02da643fbc84', width: 853, height: 1280 },
  /** 1280×720 抽象蓝光 */
  glow: { src: 'asset://3a73d7d546d0889850da32404812d103a703c560620039ef4891303cd422e28c', width: 1280, height: 720 },
  /** 1376×768 生图，抽象科技背景 */
  abstract: { src: 'asset://08337a7bf7d52aea36a39919862f1f308046eb45f7a2087f39448e016333370c', width: 1376, height: 768 },
  /**
   * 1280×853 **白底亮图**（机器人 / 白背景）。专门用来试 backdrop 遮罩 ——
   * 遮罩浓度那两个常量（0.82 / 0.78）是拍脑袋定的，而**它们只会在最亮的照片上失效**。
   * 拿机房那种深色照片去看，怎么调都「没问题」。
   */
  bright: { src: 'asset://9c569d32c4d0de2eea6431337a27f29ec56c84f4a057e5236e17d4e4b75f50a6', width: 1280, height: 853 },
  /** 1280×820 户外强光（太阳能板），第二张亮图 */
  outdoor: { src: 'asset://33e8d6092041c0e9027ca3ca1b4ba061af9111980cdfa0f96ce9ea22be1f9ace', width: 1280, height: 820 },
} as const

/** 内容给满 —— 可选字段（eyebrow / subtitle / body）全部填上，暴露最多的元素 */
export const FULL: Record<LayoutPattern, LayoutContent> = {
  'title-center': { title: '年度产品回顾', subtitle: '2026 上半年', eyebrow: 'ANNUAL REVIEW' },
  'title-split': { title: '重新定义协作', subtitle: '一个更快的工作方式', eyebrow: '产品发布' },
  'section': { title: '市场表现', subtitle: '三个季度的关键数据', eyebrow: '02' },
  'bullets': {
    title: '三个核心结论',
    subtitle: '本季度复盘的结论摘要',
    items: [
      { title: '响应更快', body: '端到端时延从 800ms 降到 200ms' },
      { title: '成本更低', body: '单位成本下降 40%' },
      { title: '零运维', body: '不再需要专职值班' },
    ],
  },
  'cards': {
    title: '产品能力',
    subtitle: '三块能力互相独立又能组合',
    items: [
      { title: '实时协作', body: '多人同时编辑同一份文稿' },
      { title: '版本回溯', body: '任意时点可回滚' },
      { title: '权限分级', body: '按组织架构继承' },
    ],
  },
  'compare': {
    title: '迁移前后',
    items: [
      { title: '迁移前', body: '三套系统各自维护，数据对不上' },
      { title: '迁移后', body: '单一数据源，口径统一' },
    ],
  },
  'timeline': {
    title: '演进路线',
    items: [
      { label: '2024', title: '立项', body: '完成技术选型' },
      { label: '2025', title: '内测', body: '首批 20 家客户' },
      { label: '2026', title: '正式发布', body: '全量开放' },
    ],
  },
  'stat': { stat: { value: '87%', label: '客户续约率', note: '同比提升 12 个百分点' }, eyebrow: '关键指标' },
  'quote': { quote: '最好的界面是没有界面。', source: '—— 某产品负责人' },
  'end': { title: '谢谢', subtitle: 'hello@example.com' },
  'image-grid': {
    title: '三块核心能力',
    subtitle: '每一块都可以单独采购',
    items: [
      { title: '实时协作', body: '多人同时编辑同一份文稿' },
      { title: '版本回溯', body: '任意时点可回滚' },
      { title: '权限分级', body: '按组织架构继承' },
    ],
  },
  'split-figure': {
    title: '为什么是现在',
    subtitle: '三个条件同时成熟',
    items: [
      { title: '算力便宜了', body: '单位推理成本三年降到 1/40' },
      { title: '模型能用了', body: '长上下文与工具调用都已可靠' },
      { title: '需求真实', body: '首批客户已经在付费' },
    ],
  },
  'full-figure': { title: '把复杂留给自己', subtitle: '把简单留给用户', eyebrow: '产品理念' },
}

/** 只给必填字段 —— 条件元素全部缺席，编排里的「可选项」会不会串位 */
export const MINIMAL: Record<LayoutPattern, LayoutContent> = {
  'title-center': { title: '年度产品回顾' },
  'title-split': { title: '重新定义协作' },
  'section': { title: '市场表现' },
  'bullets': { title: '三个核心结论', items: [{ title: 'A' }, { title: 'B' }] },
  'cards': { title: '产品能力', items: [{ title: 'A' }, { title: 'B' }] },
  'compare': { title: '迁移前后', items: [{ title: 'A' }, { title: 'B' }] },
  'timeline': { title: '演进路线', items: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] },
  'stat': { stat: { value: '87%' } },
  'quote': { quote: '少即是多。' },
  'end': { title: '谢谢' },
  'image-grid': { title: '三块能力', items: [{ title: 'A' }, { title: 'B' }] },
  'split-figure': { title: '为什么是现在', items: [{ title: 'A' }, { title: 'B' }] },
  'full-figure': { title: '把复杂留给自己' },
}

/**
 * 内容顶满 —— 长标题、满额 items、每条都带长正文。
 *
 * 版面塌不塌只有这一档看得出来：`fitFontSize` 降级降得对不对、
 * 卡片正文会不会溢出底板、时间轴标签会不会互相撞。
 * 「内容给满」那一档其实是**偏短**的理想内容，永远排得好看。
 */
export const DENSE: Record<LayoutPattern, LayoutContent> = {
  'title-center': {
    title: '面向下一个十年的企业级智能协作平台演进路线',
    subtitle: '从单点工具到统一工作空间，我们用三年时间重构了全部底层能力',
    eyebrow: 'PRODUCT STRATEGY 2026',
  },
  'title-split': {
    title: '面向下一个十年的企业级智能协作平台演进路线',
    subtitle: '从单点工具到统一工作空间，我们用三年时间重构了全部底层能力',
    eyebrow: '年度产品战略发布会',
  },
  'section': { title: '第二部分 · 市场表现与竞争格局分析', subtitle: '覆盖三个季度、七个细分行业的完整数据', eyebrow: '02' },
  'bullets': {
    title: '本季度复盘得出的六条核心结论',
    subtitle: '结论按影响面从大到小排列，每条都附了对应的量化指标与责任团队',
    items: [
      { title: '端到端响应时延显著下降', body: '从 800ms 降到 200ms，P99 由 2.4s 收敛到 610ms，覆盖全部核心链路' },
      { title: '单位服务成本下降四成', body: '主要来自调度器重写与冷热分层存储，机器数量减少 38% 而吞吐提升 12%' },
      { title: '运维彻底转为自动化', body: '不再需要专职值班，告警自愈率 91%，人工介入从每周 14 次降到 1.2 次' },
      { title: '客户续约率创历史新高', body: '87% 的年度续约率，同比提升 12 个百分点，头部客户续约率 96%' },
      { title: '生态伙伴数量翻倍', body: '接入伙伴从 40 家增至 96 家，其中 23 家完成深度集成认证' },
      { title: '安全合规全面达标', body: '通过等保三级与 SOC2 Type II，全年零重大安全事件' },
    ],
  },
  'cards': {
    title: '四块彼此独立又能自由组合的产品能力',
    subtitle: '每一块都可以单独采购，组合使用时共享同一套权限与审计体系',
    items: [
      { title: '实时协作编辑', body: '多人同时编辑同一份文稿，冲突自动合并，支持离线续写与断线重连后的状态对齐' },
      { title: '全量版本回溯', body: '任意时点可回滚，保留完整操作链路，支持按人、按时间段、按元素三个维度检索' },
      { title: '组织级权限分级', body: '按组织架构自动继承，支持临时授权与到期自动回收，全部操作留痕可审计' },
      { title: '开放集成能力', body: '提供 REST 与 Webhook 双通道，官方维护七种语言的 SDK，平均接入耗时两个工作日' },
    ],
  },
  'compare': {
    title: '迁移前后的关键差异对照',
    items: [
      { title: '迁移前：三套系统各自为政', body: '数据分散在三套独立系统里，口径互不相同，每月对账需要两名分析师花四天时间手工核对，且结论经常对不上。新增一个指标平均需要三周开发周期，跨系统的问题定位往往要拉三个团队开会。' },
      { title: '迁移后：单一数据源统一口径', body: '所有指标从同一份事实表派生，口径在定义层就统一，对账工作完全自动化。新增指标只需在语义层声明，当天即可上线；跨域问题在一个界面里就能追到根因，平均定位时间从两天降到二十分钟。' },
    ],
  },
  'timeline': {
    title: '过去五年的完整演进路线',
    items: [
      { label: '2022', title: '立项与技术选型', body: '完成三套方案的对比验证，确定自研路线' },
      { label: '2023', title: '内部试点', body: '两个业务线先行接入，跑通核心链路' },
      { label: '2024', title: '小范围公测', body: '首批 20 家客户，收敛出 143 条改进项' },
      { label: '2025', title: '正式商用发布', body: '全量开放，同步上线伙伴生态计划' },
      { label: '2026', title: '平台化与生态', body: '开放底层能力，96 家伙伴完成接入' },
    ],
  },
  'stat': {
    stat: {
      value: '87.4%',
      label: '年度客户续约率，头部客户达到 96%',
      note: '同比提升 12 个百分点。这个数字背后是全年 143 项产品改进与平均 4.2 小时的工单响应时延，也是我们判断产品已经跨过 PMF 的最主要依据。',
    },
    eyebrow: '本年度最关键的一个指标',
  },
  'quote': {
    quote: '最好的界面是没有界面。用户来这里不是为了使用软件，是为了把手上的事情做完 —— 每多一次点击、每多一个需要理解的概念，都是我们没做完的工作。',
    source: '—— 某产品负责人，2026 年度产品战略会',
  },
  'end': { title: '谢谢观看，欢迎随时联系我们', subtitle: 'hello@example.com · 400-800-1234 · 深圳市南山区科技园' },
  'image-grid': {
    title: '三块彼此独立又能自由组合的产品能力',
    subtitle: '每一块都可以单独采购，组合使用时共享同一套权限与审计体系',
    items: [
      { title: '实时协作编辑', body: '多人同时编辑同一份文稿，冲突自动合并，支持离线续写' },
      { title: '全量版本回溯', body: '任意时点可回滚，保留完整操作链路，支持三个维度检索' },
      { title: '组织级权限分级', body: '按组织架构自动继承，支持临时授权与到期自动回收' },
    ],
  },
  'split-figure': {
    title: '为什么是现在：三个条件同时成熟',
    subtitle: '任何一个单独出现都不足以支撑，三个叠加才构成拐点',
    items: [
      { title: '算力成本进入可承受区间', body: '单位推理成本三年降到 1/40，且仍在以每年 60% 的速度下降' },
      { title: '模型能力跨过可用线', body: '长上下文、工具调用与结构化输出三项都已稳定到可以进生产' },
      { title: '真实付费需求已经出现', body: '首批 20 家客户全部续约，其中 6 家把预算提高了一倍以上' },
      { title: '基础设施配套齐了', body: '向量库、可观测、评测框架都有成熟选型，不必自己造' },
    ],
  },
  'full-figure': {
    title: '把复杂留给自己，把简单留给用户',
    subtitle: '这句话说起来轻巧，落到工程上是三年重写了两次底层调度器',
    eyebrow: '产品理念 · 二〇二六',
  },
}

/** 一个版式在联系表里要看的所有变体 */
export interface Variant {
  key: string
  label: string
  /** 说明这一格专门想看什么 —— 联系表上直接印出来，免得看完不知道该看哪 */
  watch: string
  content: LayoutContent
  theme: SlideTheme
}

/**
 * 图片变体默认用哪张图：**故意给「最难裁」的那一张**。
 *
 * panel 的框是竖长条（400×562），给它横图才会被裁得最狠；
 * backdrop 是横的（1000×562），给它横图裁得最少。
 * 反过来配（panel 配竖图）看着都好，等于什么都没验到 ——
 * 第一版就是这么写的，结果「配图」和「配图（竖图）」两格出来一模一样。
 */
const figureFor = (slot: 'panel' | 'backdrop'): typeof FIGURES[keyof typeof FIGURES] =>
  slot === 'panel' ? FIGURES.hall : FIGURES.rack

export const variantsFor = (
  pattern: LayoutPattern,
  imageSlot: 'panel' | 'backdrop' | 'overlay' | null,
  /** 这个版式吃不吃「每条自己的图」（image-grid） */
  itemImage = false,
): Variant[] => {
  const out: Variant[] = [
    { key: 'full', label: '内容给满', watch: '常规观感：留白、层次、对齐', content: FULL[pattern], theme: THEME_LIGHT },
    { key: 'dense', label: '内容顶满', watch: '会不会溢出 / 字号降级对不对 / 元素互撞', content: DENSE[pattern], theme: THEME_LIGHT },
    { key: 'minimal', label: '只给必填', watch: '可选元素缺席时版面塌不塌', content: MINIMAL[pattern], theme: THEME_LIGHT },
    { key: 'dark', label: '深色主题', watch: 'surface / border / 遮罩在深色下够不够分明', content: FULL[pattern], theme: THEME_DARK },
  ]

  if (imageSlot) {
    out.push(
      {
        key: 'image',
        label: `配图（${imageSlot}）`,
        watch: imageSlot === 'backdrop' ? '遮罩浓度：文字压得住吗、照片还剩几分' : 'cover 裁剪：主体裁掉了没、出血对不对',
        content: { ...FULL[pattern], image: figureFor(imageSlot) },
        theme: THEME_LIGHT,
      },
      {
        key: 'image-tall',
        label: '配图（竖图）',
        watch: '极端比例：横向框里塞竖图，裁剪会不会把主体切没',
        content: { ...FULL[pattern], image: FIGURES.tall },
        theme: THEME_LIGHT,
      },
      {
        key: 'image-dense',
        label: '配图 + 内容顶满',
        watch: '图占掉版面之后，长文案还放得下吗',
        content: { ...DENSE[pattern], image: figureFor(imageSlot) },
        theme: THEME_LIGHT,
      },
    )

    // backdrop 的遮罩浓度只会在**最亮的照片**上失效，深色机房照怎么调都「没问题」。
    // 这一格是负对照：它红了，说明那两个常量真的不够
    if (imageSlot === 'backdrop' || imageSlot === 'overlay') {
      out.push({
        key: 'image-bright',
        label: '配图（白底亮图）',
        watch: '遮罩的极限：白底照片上文字还读得出来吗',
        content: { ...FULL[pattern], image: FIGURES.bright },
        theme: THEME_LIGHT,
      })
    }
  }

  // 每条各配一张图（image-grid）—— 故意给三张比例不同的，
  // 三格并排时裁剪不一致会立刻看出来
  if (itemImage) {
    const pool = [FIGURES.hall, FIGURES.tall, FIGURES.rack]
    const withItemImages = (c: LayoutContent): LayoutContent => ({
      ...c,
      items: (c.items ?? []).map((it, i) => ({ ...it, image: pool[i % pool.length] })),
    })
    out.push(
      {
        key: 'item-images',
        label: '每条配图',
        watch: '三格图裁得一不一致、图和字的比例对不对',
        content: withItemImages(FULL[pattern]),
        theme: THEME_LIGHT,
      },
      {
        key: 'item-images-dense',
        label: '每条配图 + 内容顶满',
        watch: '长文案下图片带会不会被挤没',
        content: withItemImages(DENSE[pattern]),
        theme: THEME_LIGHT,
      },
    )
  }

  return out
}
