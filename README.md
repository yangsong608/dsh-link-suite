# DSH Link

**一套 DSH 宿主插件 + 一个 uni-app 移动端：在手机上管理并使用电脑上的 dsh。**

> 状态：**端到端可用**。配对、网关、会话转发、对话、产物、文件预览、模型切换、队列、
> plan/todo、genui 组件渲染都已跑通；真机验证过的项见下表。已知限制也写在下面，不藏。
>
> **2026-10-24：移动端已迁出为独立工程 [`../moss-ai-app/`](../moss-ai-app/)**（还要继续加新功能），
> 本仓库保留插件 + 共享协议；路径变更说明见 [`docs/14-工程结构变更-app迁出.md`](docs/14-工程结构变更-app迁出.md)。

## 这是什么

| 子工程 | 说明 |
|---|---|
| `plugin/` | DSH 宿主插件 `dsh-link`：多设备 WSS 网关（默认 7443）+ `/dsh-link` 本机 HTTP 面 |
| `shared/protocol/` | 两侧共用的唯一契约：帧格式、**57 个方法**、错误码、锁屏策略 |
| `../moss-ai-app/`（独立工程） | MOSS 移动端：设备 / 会话 / 对话 / 设置，MOSS 皮肤 × 明暗。2026-10-24 自 `app/` 迁出，协议包已内嵌 |
| `docs/` | 设计文档、页面 UI、可点原型、验收记录与截图 |

## 能做什么

**连接**
- 扫码配对（PC 生成二维码 / 手机扫码），PC 侧可审批
- 设备在线状态、重命名、修改地址、移除、手动重连
- 断线自动重连（1s→30s 退避）；网关自愈（每 15s 检查）
- 网关开关与端口在 DSH 设置面板里可改，**配对依赖网关运行**

**会话**
- 按工作区分组、搜索、新建、改名、归档
- 实时状态（在跑/空闲/待批准）由宿主广播推送
- 长会话按窗口渲染（最近 150 条，可展开）+ 内存上限

**对话**
- 历史回放、流式文字、工具合并、停止、附件上传（图片内联 / 文件走 `fs.upload`）
- 模型目录与切换（会话级）
- 消息队列：运行中发送自动进队列，可插话 / 改 / 删
- Markdown 渲染：标题、列表、代码块、引用、**表格**、链接、加粗斜体
- **genui（`dsh-ui`）组件子集**：text / list / steps / table / keyvalue / callout / stat /
  badge / divider / code / json / chart(bars) / **choice（可点选）**
- plan 计划条与 todo 清单（`/plan` 投影、`todo_write` 工具）

**产物与文件**
- 产物列表（宿主投影 → 事件记录 → 按修改时间兜底，三级，`approximate` 如实标注）
- 文件浏览：目录逐层进入，按格式渲染（Markdown / JSON 美化 / CSV 表格 / 代码行号 / 图片）

**其它**
- 费用与峰谷：转发 `dsh-cost-meter` 的金额，复用它的 `peakPhaseAt` 判定峰谷
- 锁屏层（默认**关闭**，需要时在配置里显式开启并设密码）

## 快速开始

协议与插件各自装依赖、各自构建（没有 workspace 根）；移动端在独立工程 `moss-ai-app/` 里：

```bash
# ① 共享协议（先编，另外两个依赖它）
cd shared/protocol && npm install && npm test

# ② PC 端插件
cd ../../plugin && npm install && npm test

# 装进 profile（本机没有 dsh 在 PATH 上时用完整调用）
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  --expose-internals "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" \
  plugin --profile desktop add "dsh-link@link:$PWD/plugin"

# ③ 移动端（独立工程 moss-ai-app，已迁出本仓库）
cd ../moss-ai-app && npm install
npm run typecheck
npm run build:h5          # H5 产物可用于 QA
```

App 端（安卓）用 HBuilderX 打包。**前端改动必须重新打包才能到手机**，热更不能替代。

## 自测与验收

```bash
node scripts/check.mjs      # 协议 + 插件（+ ../moss-ai-app 存在时连它一起）全绿才算通过
```

- 协议：帧编解码、序号窗口、方法白名单、锁屏策略
- 插件：manifest、锁屏、设备表、限流、适配器、changes、上传、prompt+附件、会话创建、网关 e2e
- App：`vue-tsc` + uni 构建（独立工程 `../moss-ai-app`，不在本仓库时自动跳过）
- 真机/夹具截图与逐条验收记录见 [`docs/13-验收状态.md`](docs/13-验收状态.md)

## 已知限制（如实列出）

| 限制 | 原因 |
|---|---|
| `ask_user_question` 这类提问**只能在电脑上回答** | 它走宿主 UI 的请求/响应流，不写 `userQuestions` 投影；手机端调 `answer()` 永远 false（探针已验证投影为空） |
| 手机端可答题的路径是 `dsh-ui` 的 `choice` | 点选后作为一条消息发回，纯客户端行为，已验证可用 |
| 产物列表可能是「按修改时间推测」 | 宿主事件不带 `meta.diffs`，投影只覆盖本进程跑过的轮次 |
| 没有 E2E 加密 | 只适合回环或受信局域网，**不要暴露到公网** |
| 锁屏默认关闭 | 曾经默认开启，把用户锁在门外；现在需要显式配置 |

## 安全边界

- 网关默认只监听局域网，明文 WS；**不要在公网暴露 7443**
- 配对是显式动作：PC 生成码 + 手机扫码；设备可随时撤销
- `fs.*` 只读且限定工作区根目录内，路径经 `realpath` 校验，符号链接逃逸也会被拦

## 文档

1. [`docs/00-项目总览.md`](docs/00-项目总览.md) — 工程地图与能力表
2. [`docs/02-技术方案.md`](docs/02-技术方案.md) — 架构、协议、鉴权
3. [`docs/03-产品设计-v2.md`](docs/03-产品设计-v2.md) / [`docs/08-页面UI设计-v2.md`](docs/08-页面UI设计-v2.md)
4. [`docs/09-网络访问机制.md`](docs/09-网络访问机制.md) — 局域网/中继、攻击面
5. [`docs/13-验收状态.md`](docs/13-验收状态.md) — **逐条验收（含根因与截图）**
6. [`docs/14-工程结构变更-app迁出.md`](docs/14-工程结构变更-app迁出.md) — **app → moss-ai-app 迁移记录与路径映射**

原型：[`docs/prototype/index.html`](docs/prototype/index.html)

## License

MIT
