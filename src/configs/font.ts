export const FONTS = [
  { label: '默认字体', value: '' },
  { label: '思源黑体', value: 'SourceHanSans' },
  { label: '思源宋体', value: 'SourceHanSerif' },
  { label: '文鼎PL楷体', value: 'WenDingPLKaiTi' },
  { label: '文鼎PL宋体', value: 'WenDingPLSongTi' },
  { label: '朱雀仿宋', value: 'ZhuQueFangSong' },
  { label: '霞鹜文楷', value: 'LXGWWenKai' },
  { label: '霞鹜新致宋', value: 'LXGWNeoZhiSong' },
  { label: '霞鹜新晰黑', value: 'LXGWNeoXiHei' },
  { label: '阿里巴巴普惠体', value: 'AlibabaPuHuiTi' },
  { label: '得意黑', value: 'DeYiHei' },
  { label: 'MiSans', value: 'MiSans' },
  { label: 'Source Serif 4', value: 'SourceSerif4' },
  { label: 'JetBrains Mono', value: 'JetBrainsMono' },
  { label: 'Literata', value: 'Literata' },
  { label: 'Inter', value: 'Inter' },
  { label: 'Roboto', value: 'Roboto' },
  { label: 'Open Sans', value: 'OpenSans' },
  { label: 'Montserrat', value: 'Montserrat' },
  { label: 'Source Sans Pro', value: 'SourceSansPro' },
  { label: 'Merriweather', value: 'Merriweather' },
  { label: 'Lato', value: 'Lato' },
]

/**
 * R-67 · 别名 → 字体的**真实家族名**
 *
 * `FONTS` 里那些 value（`LXGWNeoXiHei`、`SourceHanSans`…）是本项目自己发明的
 * `@font-face` 名字（见 `assets/styles/font.scss`，按文件名生成）。浏览器里它们
 * 成立，是因为同一份 CSS 既定义又引用；**出了浏览器就什么都不是** ——
 * 世界上没有任何一个字体叫 `LXGWNeoXiHei`。
 *
 * 导出 PPTX 时这些别名被原样写进 `<a:latin/ea/cs typeface="…">`，
 * 于是 PowerPoint / Keynote 一打开就报字体缺失（R-67）。
 *
 * ## 这张表的来源
 *
 * **从 `src/assets/fonts/*.woff2` 的 name 表里读出来的**，不是查网页抄的：
 * 取 nameID 16（首选家族名），没有则 nameID 1（家族名），
 * 且只认 platformID=3 / languageID=0x409（Windows 英文）那条 ——
 * PowerPoint 匹配的就是这条记录。
 *
 * 所以表里几个「看着不像」的名字都是对的，别顺手改成中文标签：
 *   - 得意黑的家族名是 `Smiley Sans`（作者起的英文名）
 *   - 霞鹜文楷这份子集是 GB Screen 版，家族名带后缀
 *   - 思源黑/宋是可变字重的 CN VF 子集，家族名同样带后缀
 *   - 朱雀仿宋当前版本自带 `(technical preview)`
 *
 * 换字体文件时**必须重新读一遍 name 表**再更新这里 —— 名字对不上不会报错，
 * 只会让缺失提示悄悄回来。
 *
 * ## 它不解决什么
 *
 * 名字写对 ≠ 对方机器上有这个字体。没装的话照样提示缺失、照样回退到系统字体，
 * 只是提示里显示的名字终于是个真名字了。要彻底消掉提示得替换成系统自带字体
 * 或嵌入字体 —— 那是另一个决定，不在这张表的职责里。
 */
export const FONT_FAMILY_ALIASES: Record<string, string> = {
  SourceHanSans: 'Source Han Sans CN VF',
  SourceHanSerif: 'Source Han Serif CN VF',
  WenDingPLKaiTi: 'AR PL KaitiM GB',
  WenDingPLSongTi: 'AR PL SungtiL GB',
  ZhuQueFangSong: 'Zhuque Fangsong (technical preview)',
  LXGWWenKai: 'LXGW WenKai GB Screen',
  LXGWNeoZhiSong: 'LXGW Neo ZhiSong',
  LXGWNeoXiHei: 'LXGW Neo XiHei',
  AlibabaPuHuiTi: 'Alibaba PuHuiTi 2.0',
  DeYiHei: 'Smiley Sans',
  MiSans: 'MiSans',
  SourceSerif4: 'Source Serif 4',
  JetBrainsMono: 'JetBrains Mono',
  Literata: 'Literata Book',
  Inter: 'Inter',
  Roboto: 'Roboto',
  OpenSans: 'Open Sans',
  Montserrat: 'Montserrat',
  SourceSansPro: 'Source Sans Pro',
  Merriweather: 'Merriweather',
  Lato: 'Lato',
}

/**
 * R-67 · 「替换为系统字体」用的对照表
 *
 * 名字写对只是让缺失提示里显示一个真名字，**装没装是另一回事**。
 * 雯雯的 Mac 上没有霞鹜新晰黑，Keynote 照样弹缺失框；而 Keynote 又
 * 完全忽略 pptx 里的嵌入字体，所以对她来说只剩「换成本机有的字体」这一条。
 *
 * ## 拉丁字体是真跨平台，中文字体不是
 *
 * Arial / Georgia / Courier New 在 macOS 和 Windows 上都预装，可以放心写。
 * **中文没有这种两边都在的名字**：PingFang SC 只在 macOS，微软雅黑只在 Windows，
 * 挑哪个都会让另一边看到提示。
 *
 * 这里选 macOS 一侧，因为那是当前确认的使用场景（Keynote）。
 * 要给 Windows 用户导出时，改这张表的中文那几行即可 —— 换成
 * `Microsoft YaHei` / `SimSun` / `KaiTi` / `FangSong`，其余不用动。
 *
 * ## 按风格归类，不是随便找个字体
 *
 * 宋体类落宋体、楷体类落楷体、黑体类落黑体 —— 替换会改变观感，
 * 但至少不该把一份宋体正文换成黑体。得意黑是紧凑展示体，
 * 落到 PingFang 会明显变宽，这是替换固有的代价，不是 bug。
 */
export const SYSTEM_FONT_SUBSTITUTES: Record<string, string> = {
  // 中文 · 黑体类
  SourceHanSans: 'PingFang SC',
  AlibabaPuHuiTi: 'PingFang SC',
  MiSans: 'PingFang SC',
  LXGWNeoXiHei: 'PingFang SC',
  DeYiHei: 'PingFang SC',
  // 中文 · 宋体类
  SourceHanSerif: 'Songti SC',
  LXGWNeoZhiSong: 'Songti SC',
  WenDingPLSongTi: 'Songti SC',
  // 中文 · 仿宋 / 楷体类
  ZhuQueFangSong: 'STFangsong',
  WenDingPLKaiTi: 'Kaiti SC',
  LXGWWenKai: 'Kaiti SC',
  // 拉丁 · 这三个名字两个平台都有，是真安全
  Inter: 'Arial',
  Roboto: 'Arial',
  OpenSans: 'Arial',
  Montserrat: 'Arial',
  SourceSansPro: 'Arial',
  Lato: 'Arial',
  SourceSerif4: 'Georgia',
  Literata: 'Georgia',
  Merriweather: 'Georgia',
  JetBrainsMono: 'Courier New',

  // 导入的 deck / 上游 PPTist 默认值会带 Windows 字体名，在 macOS 上同样缺失。
  // 键写成真实字体名而非别名 —— 它们本来就是真名字，不经过别名表那一层
  '微软雅黑': 'PingFang SC',
  'Microsoft YaHei': 'PingFang SC',
  '宋体': 'Songti SC',
  'SimSun': 'Songti SC',
  '黑体': 'PingFang SC',
  'SimHei': 'PingFang SC',
}

/**
 * 别名翻译成真实家族名，供导出用。
 *
 * 表里没有的原样返回：用户可能手填了 `Arial`、`PingFang SC` 这类真实字体名，
 * 那些本来就是对的，不该被这层碰。
 *
 * CSS 字体栈（`"A", B, sans-serif`）也可能出现在富文本的 inline `font-family` 里，
 * 这里只取**第一项**去翻译 —— OOXML 的 `typeface` 只能放一个名字，
 * 整条栈塞进去会得到一个谁都匹配不上的字符串。
 *
 * @param substitute 是否换成系统自带字体（导出对话框的「替换为系统字体」开关）。
 *   开：对方机器上一定有，不弹缺失框，但设计选的字体不生效。
 *   关：写真实家族名，装了字体的机器渲染完美，没装的仍会提示缺失。
 */
export const resolveFontFamily = (font: string, substitute = false): string => {
  if (!font) return font

  const first = font.split(',')[0].trim().replace(/^['"]|['"]$/g, '')

  if (substitute) {
    // 先按别名查，再按真实名查 —— 后者接住 `微软雅黑` 这种本来就是真名字的输入
    const real = FONT_FAMILY_ALIASES[first] || first
    return SYSTEM_FONT_SUBSTITUTES[first] || SYSTEM_FONT_SUBSTITUTES[real] || real
  }

  return FONT_FAMILY_ALIASES[first] || first
}