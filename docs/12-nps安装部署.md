# nps / npc 安装部署指南

> 本文所有地址、域名、密钥均为**占位示例**，请替换成你自己的。
> 目标：让手机在**任意网络**（4G / 公司网 / 家里）都能连上 PC 上的 MOSS Link。

---

## 0. 先读懂这张图

```
  手机 App                公网服务器                 你的 PC
     │                       │                        │
     │   wss://示例域名       │                        │
     ├──────────────────────►│  nps（服务端）          │
     │                       │       │                │
     │                       │       │ 隧道（出站）    │
     │                       │       ▼                │
     │                       │   ◄─────── npc（客户端）│
     │                       │                        │
     │                       │       ────────────────►│ 127.0.0.1:7443
     │                       │                        │ dsh-link 网关
```

**关键点：npc 是主动向外连的**，所以你的 PC / 家里网络**不需要公网 IP、不需要开端口**。
这是内网穿透的全部意义。

---

## 1. 名词与前置条件

| 角色 | 装在哪 | 作用 |
|---|---|---|
| **nps**（服务端） | 一台有公网 IP 的服务器 | 接收手机连接，转发给 npc |
| **npc**（客户端） | 你的 PC 或同局域网任意机器 | 主动连 nps，把流量转给本机 7443 |

**你需要的**：

- 一台公网服务器（1 核 1G 足够，nps 很轻）
- 一个域名（**推荐**，见 §7「为什么需要域名」）
- 服务器安全组放行：`8024`（npc 连入）、`80`/`443`（手机访问）、`8080`（管理台，建议只对内）

---

## 2. 方案 A：Docker 部署（推荐）

### 2.1 服务器上装 nps

```bash
# ① 建配置目录
mkdir -p /opt/nps/conf

# ② 先跑一次生成默认配置（没有配置文件时容器会创建模板）
docker run -d --name nps --restart=always \
  -p 8080:8080 \
  -p 8024:8024 \
  -p 80:80 \
  -p 443:443 \
  -v /opt/nps/conf:/conf \
  yisier/nps:latest

# ③ 看日志，记下初始账号密码（admin / 123 通常需要首次登录后改）
docker logs nps | head -30
```

> 镜像来源：`yisier/nps`（Docker Hub 上维护较勤的一支）。
> 若拉取失败，可换 `docker pull ffdfgdfg/nps`，或用 §3 的源码编译方式。

### 2.2 修改 nps 配置

编辑 `/opt/nps/conf/nps.conf`（宿主机上的，容器内是 `/conf/nps.conf`）：

```ini
# ── 管理台 ──────────────────────────────────────────
web_host=0.0.0.0
web_port=8080
web_username=改成你的用户名
web_password=改成你的强密码

# ── npc 接入端口 ────────────────────────────────────
bridge_port=8024

# ── 域名转发 ────────────────────────────────────────
# 手机从公网访问用的端口
http_proxy_port=80
https_proxy_port=443
# 关键：让 nps 自己管理证书（见 §5）
https_just_proxy=true

# ── 其他 ────────────────────────────────────────────
# 关闭在线安装（避免容器内自动升级失败）
allow_user_register=false
```

重启生效：

```bash
docker restart nps
```

### 2.3 在 PC 上装 npc

```bash
docker run -d --name npc --restart=always \
  --network host \
  -e NPC_SERVER=<你的公网IP或域名>:8024 \
  -e NPC_VKEY=<在 nps 管理台「客户端」里新建并复制的密钥> \
  -e NPC_TYPE=tcp \
  yisier/npc:latest
```

`--network host` 的作用：容器内的 `127.0.0.1` 才是宿主机，npc 才能把流量转给本机的 7443。
macOS 上 Docker Desktop 的 `host` 网络行为不同（见 §8 排障），此时建议用 §3 的二进制方式。

---

## 3. 方案 B：二进制部署（跨平台，最省心）

### 3.1 服务器（Linux）

```bash
# 下载（版本号请去 release 页确认最新）
V=0.26.10
wget https://github.com/ehang-io/nps/releases/download/v${V}/linux_amd64_server.tar.gz
tar -xzf linux_amd64_server.tar.gz
cd nps

# 安装到系统目录（会生成 /etc/nps/conf/nps.conf）
sudo ./nps install
sudo nps start
```

编辑 `/etc/nps/conf/nps.conf`，按 §2.2 的字段改。

```bash
sudo nps restart
```

### 3.2 PC（macOS / Windows / Linux）

```bash
# 以 macOS arm64 为例
V=0.26.10
wget https://github.com/ehang-io/nps/releases/download/v${V}/darwin_arm64_client.tar.gz
tar -xzf darwin_arm64_client.tar.gz
./npc -server=<公网IP或域名>:8024 -vkey=<客户端密钥> -type=tcp
```

Windows 下载 `windows_amd64_client.tar.gz`，解压后：

```powershell
.\npc.exe -server=<公网IP或域名>:8024 -vkey=<客户端密钥> -type=tcp
```

**开机自启**（macOS，可选）：

```bash
# 写成 launchd 服务
cat > ~/Library/LaunchAgents/com.example.npc.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.npc</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/npc</string>
    <string>-server=<公网IP或域名>:8024</string>
    <string>-vkey=<客户端密钥></string>
    <string>-type=tcp</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.example.npc.plist
```

---

## 4. 在 nps 管理台配隧道

访问 `http://<服务器>:8080`，用 §2.2 的账号登录。

### 4.1 先建客户端

「客户端」→ 新建：

| 字段 | 值 |
|---|---|
| 备注 | 我的 Mac |
| 唯一验证密钥 | 点生成，**复制下来给 npc 用** |
| 压缩 | 开 |
| 加密 | 开（nps 自己的传输加密，与 MOSS Link 的 E2E 是两回事）|

保存后「客户端」列表里应出现 **在线** 状态。

### 4.2 再建隧道（两种选一种）

#### 方式一：域名转发（有域名时**首选**）

「域名转发」→ 新建：

| 字段 | 值 |
|---|---|
| 域名 | `dsh.example.com`（换成你的） |
| 目标 | `客户端` → 选刚建的「我的 Mac」 |
| 内网目标 | `127.0.0.1:7443` |
| 证书 | 见 §5 |

**为什么首选它**：TLS 在 nps 上终止，手机到 nps 之间是**密文**，而
MOSS Link 网关本身是明文 WebSocket——这样公网段才不是裸奔。

#### 方式二：TCP 隧道（无域名时）

「TCP 隧道」→ 新建：

| 字段 | 值 |
|---|---|
| 模式 | 服务端端口 |
| 服务端端口 | `8443`（随便挑一个没占用的） |
| 目标 | 「我的 Mac」 |
| 内网目标 | `127.0.0.1:7443` |

访问方式是 `ws://<服务器IP>:8443`。

> ⚠️ **重要**：TCP 隧道是**裸 TCP 转发，不提供 TLS**。
> 而 MOSS Link 的网关当前是明文 WebSocket（E2E 尚未实现），
> 所以走 TCP 隧道 = **把会话内容明文放到公网**。
> 没有域名时，建议先只用局域网；等 E2E 实现后再开这条。

---

## 5. 证书（域名转发必读）

### 5.1 用 Let's Encrypt（推荐）

在服务器上（**不用 Docker**，好操作）：

```bash
sudo apt install certbot
sudo certbot certonly --standalone -d dsh.example.com
# 证书在 /etc/letsencrypt/live/dsh.example.com/
```

把两个文件的内容贴进 nps 管理台的「域名转发 → 证书」：

```
fullchain.pem  →  证书内容
privkey.pem    →  私钥内容
```

自动续期后需要重新贴（或用脚本调 nps API）。**3 个月一次，别忘了。**

### 5.2 自签证书为什么不行

uni-app 的 WebSocket 无法自定义 TLS 校验（不能 pin），iOS 要把根证书装进
系统信任区，Android 7+ 用户安装的 CA 默认不被 App 信任。
**自签这条路在移动端走不通**——这也是本项目坚持"局域网不加密 + 应用层 E2E"
而不是"自签 https"的原因（见 `09-网络访问机制.md` §1.4）。

---

## 6. 接上 MOSS Link

### 6.1 改插件配置

```yaml
# ~/.dsh/profiles/<你的profile>/cordis.patch.yml
- id: dsh-link
  name: dsh-link
  config:
    gateway:
      enabled: true
      port: 7443
      bind: lan
      # 公网可达地址。配上它之后：
      #   1. 配对二维码优先用这个地址（任何网络都能连）
      #   #   2. 设置页候选地址列表里它排第一
      relayUrl: wss://dsh.example.com/dshlink
      # 必须加：否则从域名访问时 Origin 不在白名单，WebSocket 被 403
      allowedOrigins:
        - https://dsh.example.com
```

重启 DSH 后，设置页「手机连接地址」里应出现 `wss://dsh.example.com/dshlink`。

### 6.2 验证链路的三个环节

**环节 1：npc 在线**

nps 管理台「客户端」显示 **在线**。不在线就查 npc 日志：

```bash
docker logs npc --tail 50     # Docker 方式
# 或直接看终端输出
```

**环节 2：WebSocket 升级是否被透传**

这是**最容易翻车的一步**：很多 nps 版本默认不透传 `Upgrade` 头，
表现为"能打开网页，但 WebSocket 连不上"。

```bash
# 在任意一台公网机器上执行
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://dsh.example.com/dshlink
```

| 返回 | 含义 |
|---|---|
| `101 Switching Protocols` | ✅ 通了 |
| `400` / `426` | 没透传 Upgrade，检查 nps 版本与 vhost 配置 |
| `502` / `504` | npc 没连上，或内网目标写错 |
| `403` | MOSS Link 的 Origin 白名单没加你的域名 |

**环节 3：手机实测**

1. 手机**关掉 WiFi**，用 4G
2. 打开 App → 添加电脑 → 扫码（或手工填 `wss://dsh.example.com/dshlink`）
3. 能配对成功、能拉会话列表，就算通

---

## 7. 为什么建议买域名

| | 有域名 | 无域名 |
|---|---|---|
| 手机到公网 | **wss 密文**（nps 终止 TLS） | ws 明文（需 E2E 兜底） |
| 证书 | Let's Encrypt 免费 | 无 |
| 需要开端口 | 只要 443 | 要额外开一个高位端口 |
| IP 变动 | 改 DNS 即可 | 要重新配 App |

一个域名一年几十块，换来的是"公网段是密文"。**值得。**

---

## 8. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| npc 一直离线 | 密钥错 / `8024` 没放行 / 服务器防火墙 | 查 npc 日志；`telnet <服务器> 8024` |
| 管理台打不开 | `8080` 没放行，或 `web_host` 是 127.0.0.1 | 改配置 + 放行端口 |
| 网页能开，WebSocket 连不上 | `Upgrade` 没透传 | 见 §6.2 环节 2；升级 nps 或换 TCP 隧道 |
| 手机连上了但收不到消息 | `allowedOrigins` 没加域名 → 403 | 改配置重启 |
| Docker 方式 npc 连不上本机 | macOS 的 `--network host` 行为不同 | 改用 §3 的二进制方式 |
| 证书过期后连不上 | Let's Encrypt 90 天 | 续期后重新贴证书 |
| 配对了但发消息报 `host/unavailable` | 会话方法未实现（当前 M2 范围） | 正常，见 `00-项目总览.md` 状态表 |

---

## 9. 安全检查清单

上线前过一遍：

- [ ] nps 管理台**已改**默认账号密码
- [ ] `8080` 不对公网开放（或用 nps 的 IP 白名单）
- [ ] 用域名转发而非 TCP 隧道（除非已有 E2E）
- [ ] `allowedOrigins` 只列自己的域名，不要写 `*`
- [ ] 证书有效期已确认
- [ ] 在手机上验证过：配对码 2 分钟后确实失效
- [ ] 在手机上验证过：撤销设备后该设备立即断连

---

## 10. 附：一条命令检查全链路

```bash
# 把占位值替换成你的，全绿就算通
HOST=dsh.example.com
echo "① DNS:";        dig +short $HOST
echo "② HTTPS:";      curl -s -o /dev/null -w "%{http_code}\n" https://$HOST
echo "③ WS 升级:";    curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://$HOST/dshlink
```

期望：`①` 有 IP、`②` 返回 200/404、`③` 返回 **101**。
