# DSH Link

**一套 DSH 宿主插件 + 一个 uni-app 移动端：在手机上管理并使用多台电脑上的 dsh。**

> 状态：**设计已完成，代码是骨架**。协议、锁屏状态机、网关、4 个页面与双皮肤都能构建、能自测，
> 但端到端链路尚未打通（配对、E2E、会话转发未实现）。施工路线见 [`docs/00-项目总览.md`](docs/00-项目总览.md)。

## 这是什么

| 子工程 | 说明 |
|---|---|
| `plugin/` | DSH 宿主插件 `dsh-link`：多设备 WSS 网关 + PC 端锁屏（锁 dsh 的操作能力，不锁操作系统） |
| `app/` | uni-app 移动端 `@dsh-link/app`：设备列表 / 会话 / 对话 / 设置，双皮肤（MOSS · 550W）× 明暗 |
| `shared/protocol/` | 两侧共用的唯一契约：帧格式、47 个方法名、错误码、锁屏策略、加密原语布局 |
| `docs/` | 10 份设计文档 + 15 屏可点原型 + 23 张设计图 + 2 段演示录屏 |

## 快速开始

三份工程各自装依赖、各自构建，互不干扰（没有 workspace 根）：

```bash
# ① 共享协议（先编，另外两个依赖它）
cd shared/protocol && npm install && npm test      # 24 passed

# ② PC 端插件
cd ../../plugin && npm install && npm test           # 10 passed
cd .. && DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add "dsh-link@link:$PWD/plugin"

# ③ App
cd app && npm install
npm run typecheck                                    # vue-tsc，0 error
npm run build:h5                                     # 产物 dist/build/h5，284KB
npm run dev:h5
```

> `shared/protocol` 是**源码依赖**：插件通过 `file:../shared/protocol` 引用它的 `dist/`，
> App 通过 vite alias 直接引 `src/`。改了协议要 `cd shared/protocol && npm run build`。

## 当前实现状态

| 工程 | 已验证 | 尚未实现 |
|---|---|---|
| `shared/protocol` | 帧编解码、序号窗口、nonce 布局、方法白名单、锁屏策略纯函数（24 项测试） | E2E 握手（只留了 `Aead` 接口） |
| `plugin` | 锁屏状态机（scrypt/票据/限速/审计）、明文 WS 网关、`/dsh-link` HTTP 面、浏览器侧锁层（10 项测试） | 配对与设备认证、E2E、47 个方法里 42 个、中继 |
| `app` | 4 个页面、5 个 moss 组件、双皮肤、store、传输层 | `transport.ts` 尚未接线，界面为演示数据 |

## 安全边界（重要）

- 目前**没有传输层加密，也没有载荷级 E2E**。网关只用明文 WS，且 `conn.authenticated` 从不置真
  （所以除 `ping` 外一律拒绝——是 fail-closed 的，但这是流程没写完的副作用）。
- **不要在公网暴露 7443 端口**，也不要在开放 WiFi 下使用。E2E 落地前，它只适合回环或受信局域网。
- 锁屏是"锁 dsh 的操作能力"，**不是操作系统锁屏**，挡人不挡进程。

## 设计与施工文档

按顺序读：

1. [`docs/00-项目总览.md`](docs/00-项目总览.md) — 工程地图、十分钟上手、十一条需求对应位置
2. [`docs/01-可行性分析.md`](docs/01-可行性分析.md) — 需求逐条判定、五条硬约束、风险
3. [`docs/02-技术方案.md`](docs/02-技术方案.md) — 架构、协议、鉴权、文件、插件、部署、测试
4. [`docs/03-产品设计.md`](docs/03-产品设计.md) — 场景、竞品、优先级、流程、指标、路线
5. [`docs/04-UI设计.md`](docs/04-UI设计.md) / [`docs/08-页面UI设计.md`](docs/08-页面UI设计.md) — tokens、断点、逐屏施工图
6. [`docs/05-视觉与动效-MOSS.md`](docs/05-视觉与动效-MOSS.md) — 双皮肤、扫描线、CRT、动效与触感
7. [`docs/06-锁屏与远程安全.md`](docs/06-锁屏与远程安全.md) — 威胁模型、三层强制点、逃生口
8. [`docs/07-详细设计.md`](docs/07-详细设计.md) — 数据模型、12 组 RPC 契约、状态机、算法、时序
9. [`docs/09-网络访问机制.md`](docs/09-网络访问机制.md) — 局域网/中继/Overlay、稳定性、攻击面与代码差距

**原型**：直接打开 [`docs/prototype/index.html`](docs/prototype/index.html)（15 屏、双皮肤、四档画幅、支持深链）。

## License

MIT
