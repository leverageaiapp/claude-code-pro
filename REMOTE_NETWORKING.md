# Remote Networking for claude-code-pro — 设计汇总

> **分支**：`feature/remote-networking`
> **目标**：给 claude-code-pro 增加"多设备互联"能力，让用户在家里 / 办公室 / 笔记本等多台设备上的 claude-code-pro 组成一张私有网络，出差时能从笔记本无缝连回家里的算力节点；同时保留"浏览器临时访问"通道（如手机、访客设备）。
> **愿景**：成为"普通人的 Agent 集群"——你的所有设备共同构成一个分布式算力 + 数据池。

---

## 0. TL;DR（决策速览）

| 维度 | 决策 |
|---|---|
| 主方案 | **Tailscale tsnet（用户态 WireGuard，sidecar 子进程模式）** |
| 兜底方案 | **Cloudflare Quick Tunnel**（保留，承担访客 / 手机浏览器场景） |
| 客户端形态 | 单一 binary **双模式**：同一份 claude-code-pro 既是 host（被连接）也是 client（连接到远程） |
| 多 Tab 策略 | 方案 B：远程可看到 host 已打开的所有 Tab 并切换 |
| 认证（主方案 v1） | **A 方案 · 用户自带 Tailscale 账户**（零后端、零付费，详见 §5.7） |
| 认证（兜底方案） | token-in-URL + httpOnly cookie（照搬 GoGoGo） |
| 启动策略 | 默认**手动开关**；提供"启动时自动开启"的可选配置 |
| 二进制分发 | Go 写的 `tsnet-sidecar` + electron-builder `extraResources` 打包（v1），未来可改为首次使用按需下载（LM Link 方式） |

---

## 1. 背景与场景

### 1.1 用户痛点

- 家里有一台 Ubuntu 台式机，长时间开机，适合跑长任务、存大量数据、作为 agent 的"永久大脑"
- 出差用 MacBook，只有上网能力，**没法访问家里那台机器**
- 传统方案（SSH + 端口转发 / VPS 跳板 / 公司 VPN）对普通用户门槛高、配置繁琐
- 已经在研究 Cloudflare Quick Tunnel，但那只解决"把服务挂到公网 URL"，不解决"多设备组网"

### 1.2 产品愿景："普通人的 Agent 集群"

```
        Tailnet（E2E 加密 mesh，WireGuard）
┌──────────────┬──────────────┬──────────────┬──────────────┐
│              │              │              │              │
家里 Ubuntu   办公室 iMac   MacBook (外出)   iPad          访客 / 手机
[host]        [host]        [client]       [xterm 浏览器] [xterm 浏览器]
claude-code   claude-code   claude-code    通过 CF Tunnel  通过 CF Tunnel
-pro          -pro          -pro           连家里 Ubuntu   短期访问
 │             │             │
 ├── 本地 PTY    ├── 本地 PTY    └── 无 PTY，远程操作上面两台
 ├── 本地文件    ├── 本地文件
 └── 可遥控其他  └── 可遥控其他
    tailnet 节点    tailnet 节点
```

每台装了 claude-code-pro 的设备**自动发现彼此**，在侧边栏显示 "My Devices" 列表，点任一设备即可像本地一样操作它的终端、浏览文件、发起 claude 会话。

---

## 2. 用户提出的三个决策点，对应的调研结论

### Q1. Tailscale tsnet 作为主方案 — ✅ 确认采用（A 方案）

**关键证据**：
- Tailscale tsnet 是官方 Go 库，让应用**作为 tailnet 节点**，完全在**用户空间**运行
- **不占用系统 VPN 槽位**（macOS/iOS NetworkExtension 独占痛点彻底解决）
- **LM Studio LM Link**（2026 年 2 月上线）是几乎 1:1 重合的先例：同样是 Electron + 本地 AI 工具 + 多设备互联，走的就是这条路
- 免费计划（6 用户 / 100 设备）对个人集群绰绰有余
- NAT 穿透 + DERP 全球中继基础设施成熟，CGNAT 家宽 + 公司网络开箱即用

**认证走 A 方案：用户自带 Tailscale 账户**（详细对比见 §5.7）。理由摘要：
- **零运维、零付费**（B 方案自建 Hub 需签 Tailscale B2B 合同，$5k+/年起）
- **用户隐私更好**（每个用户是自己 tailnet 的主人，我们无法插手他们的 ACL）
- **数据主权清晰**（用户随时可以删号走人，不被锁定）
- 目标用户（开发者）对 Tailscale 品牌无心智障碍

LM Studio 选 B 方案是因为他们有商业模式和品牌诉求；我们 v1 不需要。

### Q2. Cloudflare Tunnel 是否保留？会和 Tailscale 冲突吗？ — ✅ 保留，不冲突，但有**权限继承**问题需要注意

用户具体问题："网络中本来就有四台设备，CF 连接过来后，加入的是哪个？"

**技术答案：CF 访问者不会"加入"tailnet**。两者在概念上完全正交：

| 维度 | Tailscale | Cloudflare Tunnel |
|---|---|---|
| 身份模型 | 设备级强身份（公钥 + OAuth） | URL + token 弱身份 |
| 工作模式 | 双向 mesh（任意两节点互联） | 单向 ingress（访问者 → 指定 host 上的 service） |
| 解决的问题 | "我的设备之间互联" | "把某个服务暴露给访客" |
| 加密 | WireGuard E2E（peer 之间） | TLS（访客 ↔ CF 边缘）+ TLS（边缘 ↔ host） |

**CF 访问的是哪台设备？**

- 谁启动了 `cloudflared tunnel --url http://localhost:<port>`，谁就是 **entry point**
- CF 访客打开 `https://xxx.trycloudflare.com` → 连到的是 **entry point 那台设备** 的 local web server
- 访客**没有 tailnet 身份**，无法 P2P 直连其他 3 台设备

**但要注意"权限继承"问题**：

CF 访客通过 entry point 的 web UI 操作，如果那个 UI 本身支持"切换到其他 tailnet 节点"，那访客就**间接继承**了 entry point 的 tailnet 权限——这相当于"一个弱身份通道可以触达整个 tailnet"。

**设计结论**：
- CF Tunnel 暴露的 UI 必须是**受限版**，默认只能操作**本机 Tab**，不能切换到其他 tailnet 节点
- 若将来允许 CF 访客遥控其他 tailnet 节点，必须有**显式开关** + **二次授权**
- 这一点在代码里要明确体现为两个不同的 web server 路由树：`/local/*`（CF 可达）vs `/mesh/*`（仅 tailnet 可达）

### Q3. LM Link 实现细节深度调研 — ✅ 已完成（见 §5）

关键发现：LM Link 是一个**单独的 Go 二进制**（`lmlink-connector`）作为 sidecar，**不是编译进 Electron**。这为我们提供了明确的技术蓝图。详见第 5 节。

---

## 3. 总体架构

### 3.1 分层视图

```
┌────────────────────────────────────────────────────────────────┐
│                    React Renderer (src/)                         │
│  Title Bar [🌐]  ←  Remote Modal                                │
│  Sidebar: FileTree + [My Devices]  ←  新增                      │
│  Tabs: Local Tab + Remote Tab（复用组件，数据源不同）           │
└────────────────────────────────────────────────────────────────┘
                            ↕ IPC
┌────────────────────────────────────────────────────────────────┐
│                 Electron Main (electron/)                        │
│                                                                  │
│  ┌──────────────────────┐    ┌────────────────────────────┐   │
│  │ 现有功能               │    │ 新增：RemoteHub             │   │
│  │ • PTY (node-pty)      │    │ • PTY 数据扇出               │   │
│  │ • fs watch            │──▶│ • MeshServer (Express+WS)   │   │
│  │ • Claude IPC          │    │ • LocalServer (Express+WS)  │   │
│  └──────────────────────┘    │ • MeshClient (WS client)    │   │
│                               │ • TunnelManager (cloudflared)│   │
│                               │ • TsnetBridge (spawn Go)    │   │
│                               └────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
         ↓ spawn                               ↓ spawn
┌────────────────────────┐         ┌───────────────────────────┐
│ cloudflared            │         │ tsnet-sidecar (Go 二进制) │
│ (兜底通道，手动开)       │         │ - tsnet.Server.Up()       │
│ --url http://localhost  │         │ - userspace WireGuard     │
│                         │         │ - Listen on tailnet:4242  │
└────────────────────────┘         │ - Control HTTP on lo:<r>  │
                                    └───────────────────────────┘
                                              ↕ WireGuard P2P
                                         其他设备的 tsnet-sidecar
```

### 3.2 两条独立的通信面

**Mesh 面**（Tailscale 内）：
- 由 `tsnet-sidecar` 启动 listener，bind 到 tailnet IP
- WebSocket 协议（和 GoGoGo 一致：output/input/resize/sync/history）
- 消息里带 `tabId`，支持多 Tab
- **无额外认证层**：默认假设同一 tailnet 内的设备完全互信（和 LM Link 一致）
- 强身份由 Tailscale 的设备证书保证

**Local/Tunnel 面**（Cloudflare Tunnel 内）：
- Express + WS 直接 bind 到 `127.0.0.1:<port>`
- cloudflared 转发 `https://xxx.trycloudflare.com` → `localhost:<port>`
- **token-in-URL + httpOnly cookie** 认证（照搬 GoGoGo）
- 默认**只能访问本机 Tab**，不能跨节点遥控

### 3.3 关键设计：PTY 数据扇出

现有 [electron/main.ts:379-382](electron/main.ts#L379-L382) 只把 PTY 数据发给本地 React UI：

```ts
// 现状
ptyProc.onData((data) => {
  mainWindow?.webContents.send(`terminal:data:${tabId}`, data)
})
```

改造为**三路扇出**（本地 UI / mesh 远程 / tunnel 远程 同时镜像）：

```ts
// 新设计
ptyProc.onData((data) => {
  mainWindow?.webContents.send(`terminal:data:${tabId}`, data)  // 本地
  meshServer?.broadcast(tabId, data)                             // Tailnet 内远程
  localServer?.broadcast(tabId, data)                            // CF Tunnel 远程
})
```

输入反向：任一来源的 input（本地键盘 / mesh ws / tunnel ws）都 `ptyProc.write()`，等效于在本地键入。

---

## 4. Tailscale tsnet 集成方案

### 4.1 分发策略

有两种选择：

**选项 1：打包进 installer（v1 采用）**
- `tsnet-sidecar` 预编译 5 个平台（darwin-arm64、darwin-x64、win-x64、linux-x64、linux-arm64），放 `native/tsnet-sidecar/<platform>-<arch>/`
- electron-builder 用 `extraResources` 打包
- 优点：离线可用、签名流程简单
- 缺点：installer 增大 ~15–25MB / 平台

**选项 2：首次使用按需下载（未来可迁移）**
- 参考 LM Link：`~/.lmstudio/extensions/frameworks/lmlink-connector-*/`
- 优点：installer 小、可独立更新 sidecar
- 缺点：需要自己的分发 CDN + 签名校验 + 离线用户不可用
- **v1 不做**，产品稳定后再优化

### 4.2 sidecar 协议（Electron ↔ Go 子进程）

**推荐：stdio JSON-RPC + 本地 HTTP 控制端口**

Go sidecar 启动后：
- stdout 输出 `{"type":"ready","port":<随机本地端口>}` 等结构化事件
- Electron 解析 stdout，拿到端口后所有 RPC 走 `http://127.0.0.1:<port>`

控制 API（本地 HTTP，仅供 Electron 调用）：

| 路径 | 方法 | 用途 |
|---|---|---|
| `/status` | GET | 返回 tailnet 状态、设备 IP、hostname、login URL（如未授权） |
| `/peers` | GET | 列出 tailnet 内其他设备（name/IP/online） |
| `/up` | POST | 启动 tsnet |
| `/down` | POST | 停止 tsnet |
| `/logout` | POST | 清除 state，切换账户 |

Mesh 监听（tsnet 内部，供其他节点 peer-to-peer 访问）：

| 路径 | 方法 | 用途 |
|---|---|---|
| `/mesh/ws` | WS | 终端会话（和 CF 通道同协议，只是没有 token 校验） |
| `/mesh/tabs` | GET | 列出本机已打开 Tab |
| `/mesh/health` | GET | 心跳检测 |

### 4.3 认证流程 — A 方案：用户自带 Tailscale 账户

**v1 确定走 A 方案**（对比 B/C 方案的完整分析见 §5.7）。让用户直接授权给自己的 tailnet，我们不跑任何后端：

```
用户点击"启用 Mesh 网络"
    ↓
Electron 调 POST /up → Go sidecar: tsnet.Server.Up()
    ↓
tsnet 返回 login URL: https://login.tailscale.com/a/XXXXX
（通过 LocalClient.WatchIPNBus() 监听 ipn.Notify.BrowseToURL）
    ↓
Go sidecar 把 URL 发给 Electron (stdio event)
    ↓
Electron: shell.openExternal(url) — 系统浏览器打开
    ↓
用户在浏览器登录 Google/GitHub/Microsoft → 授权给自己的 tailnet
    ↓
tsnet 检测到 ipn.Running 状态 → Go sidecar 发 {"type":"running"} 给 Electron
    ↓
Electron UI 从"等待授权"切到"已连接"
```

**对用户体验**：一次性 OAuth，之后所有设备自动互相可见。如果用户还没 Tailscale 账户，login 页面会引导注册（免费、Google 一键登录）。

**v1 就可以做的高级选项**：设置里暴露"自定义 Coordination Server URL"输入框（tsnet 原生支持 `Server.ControlURL`），高级用户可指向自己搭的 [headscale](https://github.com/juanfont/headscale) 实例，完全脱离 Tailscale 公司基础设施。默认隐藏，不干扰普通用户。

**未来可选升级到 B 方案**（详见 §5.7.5 触发条件），但 v1 / v2 都不做。

### 4.4 设备命名

- 默认 hostname：`claude-code-pro-<os.hostname()>`，例如 `claude-code-pro-ubuntu-home`、`claude-code-pro-jack-mbp`
- 用户可在设置里改，写入 `~/.claude-code-pro/device-name`
- Tailnet 内设备互相通过这个 hostname 访问（MagicDNS 会解析成 tailnet IP）

### 4.5 State 目录

- macOS: `~/Library/Application Support/claude-code-pro/tsnet/`
- Linux: `~/.config/claude-code-pro/tsnet/`
- Windows: `%APPDATA%\claude-code-pro\tsnet\`

通过 Electron 的 `app.getPath('userData')` 统一拿到。

### 4.6 生命周期

- App 启动时：**不自动开启 mesh**，用户手动点击"启用"按钮（保持克制，避免偷跑网络）
- 设置里提供「下次启动自动开启」选项
- App 退出时：`SIGTERM` 发给 Go sidecar，sidecar 调 `tsnet.Server.Close()` 优雅下线（其他设备会看到离线状态）
- 崩溃恢复：Electron 主进程监听 sidecar 子进程的 `exit` 事件，自动重启（最多 3 次避免死循环）

---

## 5. LM Link 深度调研要点

### 5.1 确认的事实（高置信度）

- **架构**：独立 Go 二进制 `lmlink-connector`，不是编译进 Electron，是 sidecar 子进程
- **路径**（macOS 示例）：`~/.lmstudio/extensions/frameworks/lmlink-connector-mac-arm64-apple-metal-advsimd-0.0.5/lmlink-connector`
- **技术栈**：内部 import `tailscale.com/tsnet`（从错误日志 `tsnet_up_failed` 反推）
- **分发**：不打包进 installer，**首次使用时按需下载**（类似 LM Studio 已有的 llama.cpp 变体下载机制）
- **通信**：bind 到 `127.0.0.1:<random>`，Electron 用 HTTP/WS 和它对话
- **身份**：LM Studio Hub 作为身份提供方，用户登录 Hub → Hub 后台调 Tailscale API 铸造 auth key → sidecar 用 auth key 预授权启动 tsnet（所以用户看不到 Tailscale 登录 URL）
- **加密**：依赖 WireGuard E2E，应用层**走明文 HTTP 在 WG 隧道内**，没用 ListenTLS

### 5.2 推断的事实（中置信度）

- 打包方式：electron-builder 的 `extraResources` 或类似机制，配合下载器
- 平台覆盖：darwin arm64/x64、win x64/arm64、linux x64/arm64（6 平台）
- 签名：macOS 公证、Windows EV 签名（连接器作为独立二进制单独签）
- 设备命名：hostname + 用户可改，UI 里按朋友好的名字显示（不暴露 `.ts.net` 域名）
- 状态：Starting / Online / Offline / Disconnected

### 5.3 未确认 / 需要实机验证

- 连接器和 Electron 主进程的具体 RPC 协议（估计是 WebSocket-RPC 或 JSON-RPC over HTTP）
- Tailscale ACL 是否由 Hub 自动配置（FAQ 暗示是）
- 是否使用 `Ephemeral: true` 节点（退出即删设备）

### 5.4 已知冲突 / 问题

- **和系统 Tailscale 可能冲突**（Issue #1692）：用户装了系统 Tailscale 并开 exit node 后，LM Link 超时。原因是系统 tailscaled 的路由规则可能截获 DERP 流量。LM Studio 的 FAQ 声称"可共存"实际上只对了一半。
- **二进制不在 installer 里**（Issue #1648）：多用户系统下第二个用户登录看不到连接器，需要重新装。

### 5.5 我们能从 LM Link 拿走的设计

✅ **拿走**：
1. Go sidecar 二进制架构（避免 N-API C++ 胶水代码的维护噩梦）
2. stdio + 本地 HTTP 的双通道 IPC 设计
3. 用户友好的设备命名和状态模型
4. Ephemeral 节点策略（避免设备列表越积越多）
5. "应用层明文 HTTP + WG 层加密"的简化方案

❌ **不抄**：
1. 自建 Hub 作为身份提供方 — v1 直接用 Tailscale 账户
2. 首次下载连接器 — v1 直接 extraResources 打包
3. 关闭 telemetry / 隐藏 Tailscale 品牌 — v1 不介意让用户看到"Powered by Tailscale"

### 5.6 参考代码 / 开源项目

| 项目 | 价值 |
|---|---|
| [tailscale/tsnet (Go 标准库)](https://pkg.go.dev/tailscale.com/tsnet) | 官方文档和 API 参考 |
| [shayne/tsnet-serve](https://github.com/shayne/tsnet-serve) | 最小 tsnet CLI，sidecar 骨架起点 |
| [tailscale/golink](https://github.com/tailscale/golink) | 生产级 tsnet app 范例，ListenTLS + WhoIs 模式 |
| [Yeeb1/SockTail](https://github.com/Yeeb1/SockTail) | 单二进制 SOCKS5 + tsnet，构建流程参考 |
| [tailscale/libtailscale](https://github.com/tailscale/libtailscale) | C 绑定，如果未来要 N-API 集成 |

### 5.7 基础设施分层 · 自建 vs 复用 · 方案决策

讨论 LM Link 时容易把 "LM Studio 自建了 Tailscale 替代品" 和 "LM Studio 在 Tailscale 上盖了一层"混淆。这一节把基础设施拆开看清楚，再决定我们走哪条路。

#### 5.7.1 Tailscale 本身的三层基础设施

```
┌─────────────────────────────────────────────────┐
│  控制平面（Coordination Server）                  │
│  login.tailscale.com（Tailscale 公司运营）        │
│  • 设备注册、OAuth 认证                            │
│  • 公钥交换、ACL 下发                              │
│  • 看得到：谁在哪台设备、谁跟谁能通                 │
│  • 看不到：数据内容（端到端 WG 加密）               │
└─────────────────────────────────────────────────┘
                    ↕ 控制信令（TLS）
┌─────────────────────────────────────────────────┐
│  数据中继平面（DERP Relays）                      │
│  全球 20+ 中继（Tailscale 公司运营）               │
│  • P2P 打不通时兜底                                │
│  • 只转发 WireGuard 密文，看不到明文               │
│  • CGNAT / 对称 NAT / 企业防火墙的救生索           │
└─────────────────────────────────────────────────┘
                    ↕ 兜底
┌─────────────────────────────────────────────────┐
│  数据面（P2P WireGuard）                          │
│  • 设备之间直连，优先路径                          │
│  • 约 90% 场景能打通                               │
│  • 真正传输用户数据                                │
└─────────────────────────────────────────────────┘
```

#### 5.7.2 LM Studio 实际自建了什么

**只有身份代理一层**。其余全部复用 Tailscale：

| 层级 | 运营方 | LM Studio 的角色 |
|---|---|---|
| 身份层 | **LM Studio Hub** | ✅ 自建（Google OAuth → 代理铸造 Tailscale auth key）|
| Tailscale 控制平面 | Tailscale 公司 | ❌ 通过 B2B API 程序化租用 |
| DERP 中继 | Tailscale 公司 | ❌ 复用 |
| P2P 数据面 | 设备之间 | 不需要"建"——WireGuard 协议本身 |

#### 5.7.3 LM Studio 几乎可以肯定是付费 Tailscale 客户

**未 100% 公开证据，但推理链很强**：

1. LM Link FAQ 原文 "we create a dedicated network programmatically [...] with full control over the ACL" —— "programmatically + full ACL control" 是 Tailscale **免费个人计划不提供**的能力
2. LM Link 设备**不占用户的 100 台免费额度**，说明设备挂在 LM Studio 名下的 tailnet（多租户隔离是企业功能）
3. Tailscale 有专门的 **"Embedded Tailscale / Tailscale for Platforms"** 商业产品（2024+），就是给 LM Studio 这种"嵌入 Tailscale 到自家产品"的公司用的
4. Tailscale 博客那篇 [LM Link 联合宣传](https://tailscale.com/blog/lm-link-remote-llm-access) 本身是商业合作的标志产物
5. DERP 中继带宽对免费用户有公平使用限制，稳定服务几十万用户的 LLM 推理流量不可能免费

**具体金额未公开**。业内类似 Embedded 合同通常 $5k–$50k/年起步，随 MAU 和流量扩张。

#### 5.7.4 三方案对比

| 方案 | 身份 | 控制面 | 中继 | 我们的成本 | 用户体验 |
|---|---|---|---|---|---|
| **A. 用户自带 Tailscale 账户** | Tailscale | Tailscale | Tailscale | **零** | 一次 OAuth，看到 Tailscale 品牌 |
| **B. 学 LM Link · 自建 Hub** | 我们（Hub）| Tailscale（付费 API）| Tailscale | 后端服务 + B2B 合同（$5k+/年） | 用户只看到 Google 登录，不知道 Tailscale |
| **C. 完全自主 · headscale + 自建 DERP** | 我们 | 我们（headscale） | 我们（全球 VPS 集群） | 重运维（全球中继 + 合规 + 隐私政策） | 品牌独立，但成本高 |

**依赖风险**：
- **A 方案**：依赖 Tailscale 的控制面 + DERP 永久可用。最坏情况 Tailscale 倒闭时，[headscale](https://github.com/juanfont/headscale) 可接替控制面（tsnet 客户端能配置替换 coordination server 地址）；DERP 不可用则仅 P2P 能通的场景可用
- **B 方案**：比 A 多一个 Hub 单点。Hub 挂了所有新用户无法首次授权，已授权的设备仍能继续用（auth key 已下发）
- **C 方案**：完全自主，但这基本等于"重做一个 Tailscale"。考虑到 Tailscale 有几十人团队专注全球 DERP 优化和 NAT 穿透算法，我们很难做好

#### 5.7.5 v1 决策：确定走 A 方案

**零运维、零付费、用户隐私最好**：

1. **零运维成本**：我们不跑任何后端服务，所有用户白嫖自己的 Tailscale 免费额度（6 用户 / 100 设备，对个人集群绰绰有余）
2. **零付费**：A 方案成本曲线是**常数 0**，无论用户数增长到多少；B 方案成本随用户数线性增长
3. **用户隐私更好**：每个用户是自己 tailnet 的主人。只有本人的 Google/GitHub 账户权限能加设备。B 方案中 Hub 运营方（我们）理论上能在后台操作 ACL，把自己的设备加进用户 tailnet——这是结构性的信任问题
4. **数据主权清晰**：用户随时可在 Tailscale 后台删号或移除设备，不被锁定
5. **符合 claude-code-pro 定位**：这是一个本地优先的工具，不想变成"需要注册我们账户的 SaaS"
6. **"Powered by Tailscale" 不是痛点**：只出现在 Remote Modal 底部一行字。目标用户（开发者）大多已经知道 Tailscale，反而是信任加分项

**未来条件满足才考虑升级到 B 方案**：

- 用户群明确扩展到非技术人群，Tailscale 的存在成为心智障碍
- 产品走商业化路径，需要中心化设备发现 / 组织协作功能
- 监管要求审计设备连接元数据

**C 方案不在路线图上**。产品方向明确不是"给企业做私有部署"。

#### 5.7.6 A 方案下的备选：让重度用户自己跑 headscale

对于强隐私 / 不想依赖 Tailscale 的高级用户，我们可以在设置里暴露一个可选项：**"使用自定义 coordination server"**。tsnet 的 `Server.ControlURL` 字段支持指向 headscale 实例。这几乎零代码成本（tsnet 原生支持），只是 UI 里多加一个输入框和文档指引。

- 对普通用户：界面默认隐藏，不干扰 A 方案体验
- 对高级用户：自己搭 headscale 就能完全脱离 Tailscale 公司基础设施
- 我们不运营 headscale，不承担运维

这是个 v1 就可以做的一个小口子，成本几乎为零，但给用户留了"逃生通道"。

---

## 6. 协议设计

### 6.1 WebSocket 消息格式（Mesh 和 Tunnel 共用）

从 GoGoGo 借鉴，**增加 `tabId` 字段**支持多 Tab：

| 类型 | 方向 | 结构 |
|---|---|---|
| `tabs:list` | → | `{ type }` 请求 tab 列表 |
| `tabs:list` | ← | `{ type, tabs: [{ id, title, kind }] }` |
| `tab:subscribe` | → | `{ type, tabId }` 订阅某个 tab 的 PTY 流 |
| `tab:unsubscribe` | → | `{ type, tabId }` |
| `output` | ← | `{ type, tabId, seq, data }` |
| `input` | → | `{ type, tabId, data }` |
| `resize` | → | `{ type, tabId, cols, rows }` |
| `sync` | → | `{ type, tabId, lastSeq }` |
| `history` / `history-delta` | ← | `{ type, tabId, data[], lastSeq }` |
| `tab:created` / `tab:closed` | ← | `{ type, tab }` 通知新建 / 关闭 |

### 6.2 Mesh 面 vs Tunnel 面的差异

| 项 | Mesh（tailnet） | Tunnel（cloudflared） |
|---|---|---|
| 认证 | Tailscale WG 层保证 | token-in-URL + cookie |
| 访问范围 | 全部 Tab + `tabs:list` + `tab:subscribe` 任意 | **仅限当前 focused Tab 或预设暴露的 Tab** |
| 新建 Tab 权限 | 允许 | **禁止**（减少攻击面） |
| 文件系统 API | 允许（未来） | 禁止 |
| 设置管理 API | 禁止（Settings 永远只能本机改） | 禁止 |

---

## 7. 安全模型

### 7.1 Mesh 面威胁模型

**假设**：同一 tailnet 内的所有设备 = 用户的所有设备 = 完全互信。

**理由**：
- Tailscale 设备加入 tailnet 需要 OAuth 认证 + （首次）用户在 Admin Console 显式 approve
- 恶意设备想加入用户 tailnet 必须先拿到用户 Google/GitHub 账户权限 —— 到那一步 claude-code-pro 的数据已经是次要问题
- 和 LM Link / Tailscale SSH 等成熟产品的威胁模型一致

**额外加固**（非必须，未来可加）：
- 应用层再加一次 device pairing（二维码互扫）：即使 tailnet 有其他设备，只有 pair 过的才能 RPC
- ACL 限制端口：通过 Tailscale ACL 把 claude-code-pro 的 4242 端口限制给 tag `claude-code-pro` 的设备，避免其他应用误连

### 7.2 Tunnel 面威胁模型

**假设**：tunnel URL 可能泄露，必须有应用层认证。

**分层防御**（照搬 GoGoGo）：
1. tunnel URL 本身：~10^15 熵的随机子域名，不可枚举
2. 128-bit token：首次访问 URL query 传入 → httpOnly cookie
3. Origin 校验、CSP、常数时间比较、速率限制
4. **访问范围白名单**：CF 访客默认只能操作 focused Tab，无法切换到 tailnet 其他节点

### 7.3 关键边界：Tunnel 访客不能翻 Tailscale 的墙

**这是 Q2 讨论的核心安全决策**：

```ts
// Mesh server
app.get('/mesh/devices', meshAuth, (req, res) => res.json(peers))
// ↑ 仅 tailnet 内可达，且 meshAuth 验证 Tailscale 客户端证书

// Tunnel server
app.get('/local/tabs', tokenAuth, (req, res) => res.json(localTabs))
// ↑ 公网可达（通过 CF），只暴露本机数据
// ❌ 没有 /local/devices，没有 /local/switch-to-device/:name
```

两个 server 是**独立的 Express 实例**、**独立的端口**、**独立的 WebSocket**。Go sidecar 只开 mesh server；cloudflared 的 `--url` 指向 local server。物理隔离，防止配置错误导致串线。

### 7.4 Cloudflare Tunnel 自身的信任模型

CF Tunnel 意味着 **Cloudflare 看到了明文 HTTP**（他们是中间人）。这是 CF Tunnel 本质决定的，无法避免。

- **后果**：CF 原则上能看到终端输出、你输入的命令
- **缓解**：如果用户极端敏感，应该**只用 Tailscale 不开 Tunnel**
- **权衡**：Tunnel 的价值在于"不装 app 的访客也能连"，这个便利性值这个代价
- 文档里必须**明示**：Tunnel 开启时数据经 Cloudflare；Tailscale 是 E2E 加密

---

## 8. UI 设计

### 8.1 标题栏

在 [src/App.tsx:176-190](src/App.tsx#L176-L190) Debug 按钮旁新增两个图标：

- **🌐 (Mesh)**：Tailscale 状态。未启用灰色；已启用绿点；正在连接黄色脉冲
- **🔗 (Tunnel)**：Cloudflare Tunnel 状态。未启用灰色；已启用带 URL tooltip

### 8.2 Remote Modal（点击 🌐 或 🔗 打开）

两个 Tab：

**Mesh（Tailscale）Tab**：
- 启用开关
- 当前设备名（可改）
- 我的设备列表（其他 tailnet 节点）：name / IP / 状态 / 连接按钮
- 登录 / 登出按钮
- 底部："Powered by Tailscale · [帮助文档]"

**Tunnel（Cloudflare）Tab**：
- 启用开关
- 当前 tunnel URL + 复制按钮 + 二维码
- token（隐藏，可一键重新生成）
- 警告文案："此通道会让 Cloudflare 看到你的数据明文。敏感操作请用 Mesh。"

### 8.3 侧边栏：My Devices

在文件树上方新增区域：

```
▼ My Devices
  🟢 ubuntu-home (this)
  🟢 jack-mbp
  ⚪ work-imac (offline)

▼ Files
  [文件树]
```

点击其他设备 → 弹出该设备的 Tab 列表 → 选 Tab → 新开一个 "Remote Tab"（Tab 标题带设备名前缀：`[jack-mbp] claude-1`）。

### 8.4 Remote Tab 视觉标识

- Tab 标题前加小图标（🌐 远程）
- Tab 底部状态条显示 `jack-mbp @ 100.64.1.23 · tailnet`
- 网络异常时状态条变红并显示 `Reconnecting...`

### 8.5 状态存储

新建 [src/stores/remoteStore.ts](src/stores/remoteStore.ts)（Zustand + persist）：

```ts
interface RemoteState {
  mesh: {
    enabled: boolean
    autoStart: boolean
    deviceName: string
    status: 'off' | 'connecting' | 'online' | 'error'
    tailnetIp?: string
    peers: Peer[]
  }
  tunnel: {
    enabled: boolean
    autoStart: boolean
    url?: string
    token?: string
  }
}
```

---

## 9. 打包与分发

### 9.1 需要打包的外部二进制

| 二进制 | 来源 | 大小 | 分发方式 |
|---|---|---|---|
| `tsnet-sidecar` | 我们自己写的 Go 程序 | ~15–25MB（stripped）/ 平台 | `extraResources`（v1），未来按需下载 |
| `cloudflared` | npm 包 `cloudflared`（已有先例在 GoGoGo） | ~30MB / 平台 | npm 包自动下载（首次 `remote:tunnel:enable` 时触发） |

### 9.2 electron-builder 配置

```json
{
  "extraResources": [
    {
      "from": "native/tsnet-sidecar/${platform}-${arch}/",
      "to": "tsnet-sidecar/",
      "filter": ["**/*"]
    }
  ],
  "asarUnpack": [
    "**/node_modules/cloudflared/bin/**"
  ],
  "mac": {
    "binaries": [
      "Contents/Resources/tsnet-sidecar/tsnet-sidecar"
    ]
  }
}
```

### 9.3 签名与公证

- **macOS**：tsnet-sidecar 和 cloudflared 都必须**和主 app 一起签名 + 公证**，否则 Gatekeeper 阻止执行
- **Windows**：EV 证书签 exe（cloudflared 本身已签，tsnet-sidecar 要我们自己签）
- **Linux**：无需签名

### 9.4 CI 集成

新增 GitHub Actions workflow `build-tsnet-sidecar.yml`：
- 在 `native/tsnet-sidecar/` 目录下跑 `go build` 交叉编译 6 个平台
- 产物 commit 到仓库（或用 LFS）/ 或每次 release 时触发 electron-builder 流程重新编

---

## 10. 路线图

### v0 — Cloudflare Tunnel（访客通道）
**目标**：手机浏览器 / 临时访客能访问
**工作量**：~400 行代码
- `electron/remote/tunnel.ts`：启停 cloudflared（参考 GoGoGo）
- `electron/remote/local-server.ts`：Express + WS（token 认证，仅本机 Tab）
- `electron/remote/web/`：xterm.js 前端（照搬 GoGoGo）
- UI：标题栏 🔗 按钮 + Modal
- PTY 扇出改造

**验收**：
- 在 Ubuntu 上点击启用 → 得到 URL
- 手机浏览器打开 URL + 扫码填 token → 看到当前 focused Tab 的终端
- 输入、resize、历史同步工作正常

### v1 — Tailscale Mesh（设备互联）
**目标**：多设备 mesh 网络互联
**工作量**：~800 行代码 + Go sidecar ~200 行
- `native/tsnet-sidecar/`：Go 程序（tsnet + stdio JSON + 控制 HTTP）
- `electron/remote/tsnet-bridge.ts`：spawn + stdio 解析 + 控制 API 调用
- `electron/remote/mesh-server.ts`：通过 sidecar 的 tailnet listener 起 WS server
- `electron/remote/mesh-client.ts`：连接到其他节点的 WS
- `src/stores/remoteStore.ts`：持久化状态
- 侧边栏 My Devices + Remote Modal 的 Mesh Tab
- Remote Tab 组件（复用 Terminal，替换数据源）

**验收**：
- 两台 Ubuntu + MacBook 都装 claude-code-pro，各自启用 mesh
- 都能看到对方设备在 My Devices 列表
- 点击对方设备 → 列出对方的 Tab → 选一个 → 在 Remote Tab 里能输入输出
- 设备离线后状态更新 + 重连

### v2 — 体验打磨
**工作量**：TBD
- 跨设备文件拖拽传输
- 远程项目的 "Open Folder"（调用远端 fs API）
- 设备配对二维码（tsnet OAuth 之外加一层应用层信任）
- Passkey 支持（Tunnel 面升级到 WebAuthn）
- 按需下载 tsnet-sidecar（installer 瘦身）
- 系统托盘常驻 + 启动时自动 mesh

### v3 — 生态
- LM Studio 互联（利用 LM Link 的 tailnet 发现 LM Studio 设备并调用其模型）
- 多人共享 tailnet（配合 Tailscale 的多用户功能）

---

## 11. 风险与未决问题

### 已知风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 用户没有 Tailscale 账户，注册流程卡住 | 高 | Modal 里提供清晰引导；Google/GitHub 一键登录无痛 |
| tsnet-sidecar 在 macOS 上被 Gatekeeper 拦 | 高 | 必须和主 app 一起公证；CI 流程要测 |
| 系统装了 Tailscale 客户端导致路由冲突（LM Link Issue #1692） | 中 | 文档里明示；提供"只用 Tunnel 不用 Mesh"的 fallback |
| installer 体积增加 30MB+ | 中 | v2 迁移到按需下载 |
| 交叉编译 Go 6 平台的 CI 复杂度 | 中 | 用 Go 原生 cross-compile，不用 CGO（tsnet 纯 Go）|
| CF Tunnel 经过 Cloudflare 中间人 | 中 | UI 明示警告；敏感场景引导用 Mesh |
| Tailscale 免费额度变更 | 低 | 100 设备对个人用户冗余很大 |

### 未决问题（需要实机验证）

1. **LM Link 的具体 IPC 协议**：建议装一次 LM Studio + Charles Proxy 抓包 1 小时，把推测的细节变成事实
2. **Go sidecar 和 node-pty 是否 Electron ABI 兼容**：node-pty 是 native 模块要 rebuild，Go sidecar 是独立进程无 ABI 问题，理论上不冲突但需要验证
3. **Tailscale 免费计划对"应用内嵌 tsnet 设备"的政策**：免费计划 100 设备/用户，但如果大量用户的 claude-code-pro 都注册 tsnet 节点，会不会被 Tailscale 视为滥用？需要看 ToS 或直接问他们
4. **是否需要 Ephemeral 节点**：`Ephemeral: true` 意味着离线 ~5 分钟后设备从列表消失。对桌面应用合适吗？（用户关机一晚上再开不应该设备消失）初步判断：**不用 Ephemeral**，设备显式退出才删除
5. **如果用户同一台机器开多个 claude-code-pro 实例**：state-dir 冲突，需要锁或 per-instance dir

---

## 12. 下一步

1. **实机验证 LM Link 细节**（30 分钟）
   - 装 LM Studio 0.4.8+
   - `ls ~/.lmstudio/extensions/frameworks/`
   - `strings lmlink-connector | grep tsnet`
   - `lsof -p <pid>` 看监听端口
   - 抓本地环回流量看 Electron↔连接器协议

2. **写一个最小 Go tsnet spike**（1 天）
   - 100 行左右的 sidecar
   - 在两台 Linux 之间验证 `tsnet.Server.Up()` + `Listen("tcp", ":4242")` 的可行性
   - 测试 stdio JSON-RPC + OAuth URL 传递

3. **从 v0（Cloudflare Tunnel）开始落地**
   - 先打通单通道，把 PTY 扇出 / web server / UI 骨架立好
   - 再在此基础上加 mesh 面

确认方案后进入 v0 实现。

---

## 附录 A：关键参考链接

### Tailscale / tsnet
- [tsnet 官方文档](https://tailscale.com/kb/1244/tsnet)
- [tsnet.Server API 参考](https://tailscale.com/docs/reference/tsnet-server-api)
- [The subtle magic of tsnet](https://tailscale.com/blog/tsup-tsnet)
- [libtailscale 博客](https://tailscale.dev/blog/libtailscale)
- [Tailscale 免费计划](https://tailscale.com/pricing)
- [Userspace networking mode](https://tailscale.com/kb/1112/userspace-networking)

### LM Link
- [LM Link 产品页](https://lmstudio.ai/link)
- [LM Link FAQ](https://lmstudio.ai/docs/lmlink/basics/faq)
- [Tailscale × LM Link 博客（2026-02）](https://tailscale.com/blog/lm-link-remote-llm-access)
- [LM Studio Bug #1722（连接器路径）](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1722)
- [LM Studio Bug #1692（系统 Tailscale 冲突）](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1692)

### 参考开源实现
- [shayne/tsnet-serve](https://github.com/shayne/tsnet-serve) — sidecar 骨架
- [tailscale/golink](https://github.com/tailscale/golink) — 生产级 tsnet 应用
- [Yeeb1/SockTail](https://github.com/Yeeb1/SockTail) — 单二进制 tsnet 打包
- [dceddia/electron-napi-rs](https://github.com/dceddia/electron-napi-rs) — Electron 原生模块模板

### 替代方案（已评估但未选）
- [Iroh (P2P QUIC)](https://www.iroh.computer/) — 备选方案，无需账户
- [headscale (Tailscale 控制面自托管)](https://github.com/juanfont/headscale)
- [Slack Nebula](https://github.com/slackhq/nebula)

### 内部参考项目
- `/home/tan/workspace/GoGoGo` — Cloudflare Tunnel + PTY + WS 原型参考
