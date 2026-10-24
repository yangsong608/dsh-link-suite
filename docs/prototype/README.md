# prototype · 高保真原型、出图与录屏
> 注（2026-10-24）：文中 `app/...` 路径已迁出为独立工程 `moss-ai-app/...`（工作区根），阅读时按新位置理解。详见 [14-工程结构变更-app迁出.md](14-工程结构变更-app迁出.md)。

这个目录有四件事：

1. `index.html` —— 单文件的**可点击原型**，双皮肤（MOSS / 550W）× 明暗，15 个 screen，四档画幅。
2. `capture.mjs` —— 把各个 screen 批量截成 `docs/ui/*.png`，就是 `08-页面UI设计.md` §7 那 23 张图。
3. `record.mjs` —— 录两段演示视频 `docs/ui/demo-*.mp4`，见 `08` §7.1。
4. `shot-app.mjs` —— 截 **App 真跑起来**的样子（`app-h5-devices.png`）。它和上面 23 张不是一回事，见下。

原型不是"示意图"，它和真实 App 用同一套令牌与同一批尺寸（`08` §2 的栅格、字号阶梯、间距刻度）。
所以它最有用的时候不是给人看，而是**出图时能保证图里的间距就是实现时的间距**。

## 设计图 ≠ 实现凭证

| | 出处 | 证明什么 |
|---|---|---|
| `../ui/p*.png`（23 张） | `index.html` | **设计定了**。它按 `08` 的尺寸施工，但它是手写的，不代表 App 能渲染 |
| `./app-h5-devices.png` | `moss-ai-app/dist/build/h5` | **代码跑起来了**。这是 `moss-ai-app/src` 编译后的真东西 |

这两张混着看是这类项目最常见的自欺：原型很漂亮，App 一跑是白屏。
所以 `shot-app.mjs` 单独存在——它跑的是编译产物，不是原型。

---

## 跑起来

```bash
npm install          # 只有 puppeteer-core，不下载 Chromium
npm run serve        # http://localhost:8788
npm run shot         # 23 张设计图
npm run shot:app     # App 实现凭证（先在 moss-ai-app/ 跑 build:h5）
npm run verify       # 四档断点自检（不出图）
npm run record       # 2 段录屏
```

打开后可以直接点：设备卡 → 会话 → 对话/执行过程/产物，队列条能展开，
文件行能进预览，仓库能进 diff，设置里能切皮肤。
把窗口拉到 834 / 1194 宽可以看平板竖屏与双栏，拉到 844×390 可以看手机横屏。

## 出图

```bash
node capture.mjs              # 23 张全出，写到 ../ui/
node capture.mjs p3-trace     # 只重截匹配到的那张
node capture.mjs tab          # 只重截平板那五张
```

脚本用**系统 Chrome**（找不到就报错让你装，或用 `CHROME_PATH` 指定），
不用 `puppeteer` 是因为后者每次都下一份 100MB+ 的 Chromium，为了 23 张图不值。

四件事它替你处理了：

| 处理 | 为什么 |
|---|---|
| `?shot=1` | 跳过 1.4s 冷启动动画。那是给第一次打开的人看的，不该出现在设计图里 |
| 等 `document.fonts.ready` | 等宽字形没加载完就截，行号列会错半像素——而这张图就是要给人看等宽对齐的 |
| 量一次横向溢出 | 溢出会被 `overflow:hidden` 裁掉，**在截图上根本看不出来**，只能量 |
| `scroll` / `scrollTo` | 聊天记录有历史，不滚动就截不到"最新那句"。`scroll` 滚到底，`scrollTo` 把某个元素顶到顶部 |

## 画幅（四档，不是一种）

| 名称 | 尺寸 | 用在哪 |
|---|---|---|
| `PHONE` | 390×844 @3x | `p1`–`p12` + `p6-file-image`，手机竖屏 |
| `PHONE_LANDSCAPE` | 844×390 @3x | `p17`，手机横屏（**故意不出侧栏**） |
| `TAB_PORTRAIT` | 834×1194 @2x | `p13` `p14`，平板竖屏 |
| `TAB_LANDSCAPE` | 1194×834 @2x | `p15` `p16`，平板横屏（对话 + 执行过程双栏） |

断点为什么都带 `min-height`、横屏为什么只压壳不砍信息，见 `08` §5。
**加一张图 = 在 `SHOTS` 里加一行并选对 `viewport`**，别用手机图放大冒充平板。

## 验断点（不出图）

```bash
node verify-layout.mjs
```

截图能证明"某一档长这样"，但证明不了"另一档没串味"。断点最典型的翻车是
844×390 的手机横屏被判成平板——侧栏一出来正文就没了，而**那张截图看上去只是"有点窄"**。

所以这个脚本不截图，直接量四档下的 `rail` / `tabbar` / `side` 的 `display` 与几何宽度，
外加"有没有横向溢出"和"控制台有没有报错"。任一档不符就退出码 1，适合接 CI。
期望值写在脚本顶部的 `CASES` 里，改断点时必须同步改它——不然它就是在骗人。

## 录屏

```bash
node record.mjs              # 两段都录
node record.mjs phone        # 只录手机
```

`record.mjs` 走 CDP 的 `Page.startScreencast` 直接拿渲染帧，不是录屏软件——
录屏会带进鼠标、通知和窗口边框，而这里要的只是界面上发生的事。

两个坑写在代码注释里，这里点一下：

- **每帧时长按时间戳算**，不是固定 30fps。screencast 只在画面变化时出帧，静止的两秒只来一两帧；
  按固定帧率拼会把停顿压掉、把动作拉长。
- **`frame.html` 是录屏用的放大画框**。headless 的 screencast 只按 CSS 像素出帧（视口 DSF 3 也给 390×844），
  想要 780×1688 的清晰度，只能把 390×844 的页面塞进一个 `transform: scale(2)` 的 iframe——
  transform 是矢量的，文字按 2 倍重新栅格化，是"更清晰"而不是"放大后糊"。

编码器默认找 imageio-ffmpeg 自带的那份（本机没装系统 ffmpeg）：

```bash
pip install imageio-ffmpeg
python -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"
```

## 参数

| 参数 | 作用 |
|---|---|
| `?shot=1` | 跳过冷启动动画（出图/录屏必带） |
| `?skin=550w` \| `?skin=moss` | 强制皮肤。`auto` 的规则是"只有锁屏切 550W"，出对比图时要绕过它 |
| `?light=1` | 浅色模式 |
| `?frame=pc` | 摘掉侧栏，用来截 **dsh 侧锁屏**（它是电脑窗口整屏的状态，不能按手机宽度出图） |
| `?mode=image` | 文件预览切**图片形态**（等比适配 + 最大高 60vh）。代码与图片是同一页的两种渲染，不是两页 |

## 加一个页面

1. 在 `index.html` 里加 `<section class="screen" id="s-xxx">…</section>`；
2. 把 id 后面的名字加进脚本顶部的 `screens` 数组（深链 `index.html#xxx` 才能用）；
3. 在 `capture.mjs` 的 `SHOTS` 里加一行，`file` 按 `08` 的 `pN-名字` 命名；
4. 如果这一页有"要滚到最新"的列表，记得给它加 `scroll`。

## 一条规矩

**这张图里的每一个数字，都得能在 `08` 里找到出处。** 反过来说，`08` 改了尺寸，
这里必须跟着改并重出图——图比文字更容易被信任，一张过期的图比一段过期的文字危害更大。
