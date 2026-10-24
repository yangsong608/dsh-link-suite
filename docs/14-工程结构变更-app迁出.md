# 14 · 工程结构变更：app/ 迁出为独立工程 moss-ai-app

> 日期：2026-10-24
> 一句话：`dsh-link-suite/app/` 整体迁出到工作区根的 **`moss-ai-app/`**，因为移动端还要继续加 DSH Link 之外的新功能；本仓库保留插件与共享协议。

## 为什么

原 `app/` 是 dsh-link 套件的配套移动端，工程边界即"远程使用电脑上的 dsh"。接下来移动端要长出其它功能，继续挂在套件里会让：

- 套件的 README / CI / check 都要为"与 dsh-link 无关的功能"买单；
- 移动端的迭代节奏被套件的协议/插件发版节奏拖住。

所以把移动端独立成产品工程 **moss-ai-app**，dsh-link 远程模块成为它的第一个能力域。

## 迁了什么

| 原位置 | 新位置 | 说明 |
|---|---|---|
| `app/`（整目录，含 src/tools/resources/.hbuilderx） | `../moss-ai-app/` | 应用本体原样迁移 |
| `app` 里 `@dsh-link/protocol` 的别名（指向 `../shared/protocol/src`） | 别名改指 `../moss-ai-app/protocol/src`（内嵌副本） | 见下节 |
| `app/tools/moss-render/` 内硬编码路径 | 已修正（`../../src/static`、`moss-ai-app/dist/build/h5`） | 渲染/截图工具随应用走 |
| `package.json` 的 `typecheck:app` / `build:app` / `install:all` | 改指 `../moss-ai-app` | 命令保留，路径更新 |
| `scripts/check.mjs` 的 app 步骤 | 改指 `../moss-ai-app`，目录不存在时自动跳过 | CI 上无该目录也能全绿 |
| `.github/workflows/ci.yml` | 移除 `npm --prefix app ci` | CI 只管协议 + 插件 |
| `.gitignore` 的 `app/tools/moss-render/assets3d` 行 | 已删除 | 3D 资产符号链接随应用走 |

## 协议包的双份与同步规则（重要）

迁出后协议源码有两份：

| 位置 | 谁用 |
|---|---|
| `dsh-link-suite/shared/protocol` | 宿主插件 `dsh-link`（读 dist/） |
| `moss-ai-app/protocol` | 移动端（vite/tsconfig 别名直接吃 src/） |

两者**必须保持契约一致**（帧格式、57 个方法名、错误码、锁屏策略）。改协议时：

1. 两侧同改；
2. 两侧各自跑 `npm run test:protocol`（frame / qr / pairing 单测两边都带）；
3. 真机联调前 diff 一下 `src/methods.ts`（或 `METHODS` 列表）确认一致。

只给移动端加新功能、不动远程链路时**不需要碰 protocol/**。

## 文档中的路径怎么读

本次变更前写成的设计/验收文档（01–13）保留原样作为历史记录，文中所有 `app/...` 路径**读作 `moss-ai-app/...`**：

| 文中写法 | 现在实际位置 |
|---|---|
| `app/src/**` | `moss-ai-app/src/**` |
| `app/src/manifest.json` | `moss-ai-app/src/manifest.json` |
| `app/tools/moss-render/**` | `moss-ai-app/tools/moss-render/**` |
| `app/dist/build/h5` | `moss-ai-app/dist/build/h5` |

受影响文档：`02-技术方案.md`、`04-UI设计.md`、`05-视觉与动效-MOSS.md`、`07-详细设计.md`、`08-页面UI设计.md`（含 v2）、`09-网络访问机制.md`、`13-验收状态.md`、`docs/prototype/README.md`；这些文件开头已加同样的提示。截图产物 `docs/screenshots/`、`docs/prototype/*.png` 不重拍。

## 验证记录（迁移当次）

- `moss-ai-app`：`npm run typecheck`、`npm run build:h5` 通过；`protocol` 单测通过。
- `dsh-link-suite`：`node scripts/check.mjs` 通过（协议 + 插件）。
- 交叉引用 grep：`moss-ai-app` 内已无 `../shared/protocol` 残留；`dsh-link-suite` 内可执行脚本已无 `app/` 旧路径（历史文档除外）。

## 想回退

app 的迁移在 dsh-link-suite 的 git 历史里（迁移提交），`git show`/`git revert` 那次提交即可恢复旧结构；`moss-ai-app/` 直接删除即可。
