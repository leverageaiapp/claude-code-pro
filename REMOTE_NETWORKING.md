# Remote Networking for claude-code-pro — 设计汇总

> **分支**：`feature/remote-networking`
> **目标**：给 claude-code-pro 增加"多设备互联"能力，让用户在家里 / 办公室 / 笔记本等多台设备上的 claude-code-pro 组成一张私有网络，出差时能从笔记本无缝连回家里的算力节点；同时保留"浏览器临时访问"通道（如手机、访客设备）。
> **愿景**：成为"普通人的 Agent 集群"——你的所有设备共同构成一个分布式算力 + 数据池。

---

## 0. TL;DR（决策速览）

| 维度 | 决策 |
|---|---|
| 主方案 | **Tailscale tsnet（用户态 WireGuard，sidecar 子进程模式）** |
| 兜底方案 | **Cloudflare Quick Tunnel**（保留，承担访客 / 手机浏览器 / 跨用户分享场景） |
| **sidecar 架构** | **方案 Y**：Go sidecar 只做 raw TCP 反向代理 + 控制 API；WS/PTY 逻辑全在 Node（详见 §3.4） |
| 客户端形态 | 单一 binary **双模式**：同一份 claude-code-pro 既可 host 也可 client |
| **Host/Client** | 默认 **client-only**（加入 tailnet 但不接受连接）；Host 模式需用户显式开启（详见 §8.2） |
| 多 Tab 策略 | 方案 B：Host 模式下远程可看到全部 Tab 并切换 |
| 认证（Mesh） | **A 方案 · 用户自带 Tailscale 账户**（零后端、零付费，详见 §5.7） |
| 认证（Tunnel） | token-in-URL + httpOnly cookie（per-share 独立 token，详见 §6.3） |
| **Tunnel 分享粒度** | **单个 Tab** per share，可并发分享多个 Tab；撤销即时生效（详见 §6.3） |
| 启动策略 | 默认**手动开关**；提供"启动时自动开启"的可选配置 |
| 二进制分发 | Go `tsnet-sidecar` + electron-builder `extraResources`（v1）；v2 转按需下载 |
| **网络场景** | **只考虑美国场景**。中国大陆网络（DERP 干扰、trycloudflare 干扰）v1 明确不优化 |

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

### Q4. 网络场景范围 — 只考虑美国

**v1 明确不优化中国大陆场景**。已知问题：

- Tailscale DERP 在国内被干扰：P2P 能通则勉强可用，走 DERP 则极慢或超时
- `*.trycloudflare.com` 在国内不稳定
- 美国用户无此问题

v1 的文档、测试、验收标准全部基于美国网络场景。国内用户若遇问题：
- Mesh 面可通过自建 DERP 或 headscale 自救（§4.3 的逃生通道已提供接口）
- Tunnel 面建议用户自行配置出境代理

未来若有国内用户规模，再单独设计。

---

## 3. 总体架构

### 3.1 分层视图

```
┌────────────────────────────────────────────────────────────────┐
│                    React Renderer (src/)                         │
│  Title Bar [🌐 三态] [🔗 share 数量]  ←  Remote Modal           │
│  Sidebar: FileTree + [My Devices]  ←  新增                      │
│  Tabs: Local Tab + Remote Tab（复用组件，数据源不同）           │
└────────────────────────────────────────────────────────────────┘
                            ↕ IPC
┌────────────────────────────────────────────────────────────────┐
│                 Electron Main (electron/)                        │
│  ────────── 权威数据层（所有 PTY / buffer / WS 协议）────────── │
│                                                                  │
│  ┌──────────────────────┐    ┌────────────────────────────┐   │
│  │ 现有功能               │    │ 新增：RemoteHub             │   │
│  │ • PTY (node-pty)      │───▶│ • PTY 数据扇出 fanout       │   │
│  │ • fs watch            │    │ • output buffer / seq 管理  │   │
│  │ • Claude IPC          │    │ • MeshServer (Express+WS)   │   │
│  └──────────────────────┘    │   → listen 127.0.0.1:<m>    │   │
│                               │ • LocalServer (Express+WS)  │   │
│                               │   → listen 127.0.0.1:<l>    │   │
│                               │ • MeshClient (outgoing WS)  │   │
│                               │ • TunnelManager             │   │
│                               │ • TsnetBridge               │   │
│                               └────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
         ↓ spawn                               ↓ spawn
┌────────────────────────┐         ┌───────────────────────────┐
│ cloudflared            │         │ tsnet-sidecar (Go 二进制) │
│ --url localhost:<l>    │         │ 纯网络层，不懂业务协议      │
│                         │         │ • tsnet.Server.Up()       │
│ 公网 URL:               │         │ • Listen on tailnet:4242  │
│ xxx.trycloudflare.com   │         │   ↓ 对每个 tailnet 连接:  │
└────────────────────────┘         │   io.Copy ↔ 127.0.0.1:<m>│
                                    │ • Dial peer via SOCKS5    │
                                    │   → 暴露给 Node outbound  │
                                    │ • Control HTTP on lo:<c>  │
                                    │   /status /peers /up /down│
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

### 3.4 关键架构决策：方案 Y（Go 只做网络层，WS/PTY 逻辑全在 Node）

曾考虑两方案：

- **方案 X**：WS 协议、buffer、扇出逻辑都在 Go sidecar 里实现，Node 通过自定义协议把 PTY 数据传给 Go
- **方案 Y（采用）**：Go sidecar 只做 ① tailnet listener → loopback 反向代理，② 控制 HTTP 暴露 peer/status 信息。WS server、output buffer、seq 管理、协议版本协商全部留在 Node Express

**选 Y 的理由**：

1. **维护复杂度差一个数量级**：方案 X 要在 Go 里重写 WS 协议、broadcast、buffer、seq —— 200-400 行 Go；方案 Y 的 Go 代码只是 `io.Copy` 双向拷贝，~20 行核心网络代码
2. **代码路径单一**：本地 UI 和 mesh peer 走同一套 Express/WS 逻辑，改一处生效所有通道
3. **延迟几乎无差**：loopback TCP 代理 < 0.5ms，对终端 I/O 完全无感
4. **兼容 GoGoGo 经验**：buffer 在 Node 里，WS 协议不变，已知可靠

Go sidecar 的完整职责就三件事：

```go
// ① 把 tailnet 进来的连接转给本机 Express（应用层数据）
for conn := range tailnetListener.Accept() {
    local, _ := net.Dial("tcp", "127.0.0.1:<mesh-server-port>")
    go io.Copy(local, conn)
    go io.Copy(conn, local)
}

// ② 暴露 SOCKS5 让 Node 的 outbound 连接走 tsnet（作为 client 连其他 peer）
srv.Loopback()  // tsnet 原生返回 SOCKS5 addr + credentials

// ③ 控制 HTTP：/status /peers /up /down /logout
// Node 通过本地 HTTP 调用 tsnet 的 LocalClient
```

Node 那边 outbound 连接其他 peer 用 `socks-proxy-agent`：

```ts
const agent = new SocksProxyAgent(`socks5h://tsnet:${cred}@${addr}`)
const ws = new WebSocket('ws://ubuntu-home:4242/mesh/ws', { agent })
// URL 里的 "ubuntu-home" 走 tsnet MagicDNS 解析
```

### 3.5 "刷新即恢复" 模式（继承 GoGoGo 的可靠性设计）

Sidecar 崩溃或重启时的恢复流程：

```
tsnet-sidecar 崩溃
    ↓
tailnet listener 死 → 所有 peer 的 WebSocket onclose 触发
    ↓
peer 侧客户端自动重连（标准 WS reconnect loop）
    ↓
Electron 主进程 child_process.on('exit') → 重启 sidecar
    ↓
sidecar 重新 Up() → tailnet listener 恢复
    ↓
peer 重连成功 → 发 { type:'sync', lastSeq:N }
    ↓
Node 端 server 从 output buffer 过滤 → 回 history-delta
    ↓
用户体感：2-3 秒卡顿，然后恢复。claude 会话不中断
```

**关键不变量**：

- output buffer / seq 计数器永远存在 Node 主进程里，和 sidecar 生命周期解耦
- PTY 进程由 Node 管理，sidecar 崩溃不影响 PTY
- 重启策略：前 3 次立即重启；后续指数退避（避免死循环）

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

**stdio JSON-RPC（用于启动握手与状态事件） + 本地 HTTP 控制端口（用于命令）**。

Go sidecar 启动流程：

```
Electron spawn → Go sidecar 启动
    ↓
Go 写 stdout: {"type":"ready","controlPort":47123,"socksPort":47124,"socksCred":"abc..."}
    ↓
Electron 解析 stdout，记下三个端口 + SOCKS 凭据
    ↓
后续所有命令走 HTTP: POST http://127.0.0.1:47123/up
    ↓
异步事件（login URL、状态变化）仍走 stdout:
  {"type":"auth_url","url":"https://login.tailscale.com/..."}
  {"type":"state","state":"running","ip":"100.64.1.23"}
  {"type":"state","state":"needs_login"}
  {"type":"peer_update","peers":[...]}
```

**控制 API**（本地 HTTP 127.0.0.1:<controlPort>，仅供 Electron 调用）：

| 路径 | 方法 | 用途 |
|---|---|---|
| `/status` | GET | 当前 tailnet 状态、设备 IP、hostname |
| `/peers` | GET | 列出 tailnet 内其他设备（name/IP/online/os） |
| `/up` | POST `{hostname, stateDir, controlURL?}` | 启动 tsnet；`controlURL` 可选指向 headscale |
| `/down` | POST | 停止 tsnet（保留 state，可再 up） |
| `/logout` | POST | 清除 state，下次需重新 OAuth |
| `/listen` | POST `{port}` | **启动 mesh listener**（Host 模式开启时调） |
| `/unlisten` | POST | **停止 mesh listener**（Host 模式关闭时调） |

**Mesh listener**（tsnet 内部，仅 Host 模式开启后存在）：

Go sidecar 收到 `/listen` 后：
1. `tsnet.Server.Listen("tcp", ":4242")` 拿到 tailnet listener
2. 对每个 `Accept()` 进来的连接，开 goroutine 双向 `io.Copy` 到 `127.0.0.1:<mesh-server-port>`
3. `/unlisten` 时关闭 listener，正在进行的连接自然断开

**Mesh server 路由**（Node Express，tailnet peer 通过代理访问）：

| 路径 | 方法 | 用途 |
|---|---|---|
| `/mesh/hello` | GET | 协议版本探测（无需鉴权） |
| `/mesh/ws` | WS | 终端会话（见 §6.1） |
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

### 4.6 Host / Client 模式（两个独立开关）

**默认状态**：加入 tailnet 后仅为 **Client**。Go sidecar 已跑 `tsnet.Server.Up()`，设备在 Tailscale admin 可见，**但不起 mesh listener**。其他 peer 调 `/mesh/*` 连过来会 ECONNREFUSED。

**两层开关**：

```
L1: [ Join tailnet ]  (加入 tailnet)
    默认: 用户手动开启
    副作用: 启动 Go sidecar，跑 tsnet.Server.Up()
    状态: Client-only · 可查看 My Devices 列表，可向其他 Host 发起连接

L2: [ Host Mode ]     (作为 Host 接受连接)
    默认: 关
    前置: L1 必须已开启
    副作用: 调 /listen，Go sidecar 起 tailnet listener
    状态: Host · 其他 tailnet peer 可连接，可查看 Tab，可输入命令
```

**状态机**：

```
Off ──[Join tailnet]──▶ Client ──[Enable Host]──▶ Host
 ▲                        │                          │
 │                        └─[Leave tailnet]──────────┤
 │                                                    │
 └──────────────[Leave tailnet]──────────────────────┘
```

**关闭 Host 模式的行为**：
- Go sidecar 收到 `/unlisten`，关掉 tailnet listener
- 所有已连的 remote peer 的 WebSocket 立即断开（close code 4001 "host_disabled"）
- My Devices 里其他设备看到我的 `[host]` 标记消失（通过 peer polling 或 Tailscale 元数据更新）

### 4.7 生命周期

- **App 启动时**：按用户上次状态恢复。默认什么都不做；若用户开启过"启动时自动加入 tailnet"，则自动 L1（但不自动 L2 Host）
- **App 退出时**：`SIGTERM` 发给 Go sidecar → sidecar 调 `tsnet.Server.Close()` 优雅下线 → 其他设备 peer_update 中看到离线
- **Sidecar 崩溃恢复**：Electron 主进程监听 sidecar 子进程 `exit` 事件：
  - 前 3 次：立即重启
  - 第 4 次起：指数退避（5s / 15s / 60s / 300s，封顶 5 分钟）
  - 状态栏图标显示重连中
  - 恢复后所有 peer WS 自动重连（详见 §3.5）
- **Sidecar 正常重启**（配置变更、账户切换等）：短暂 unavailable 窗口，peer 侧体验同"刷新即恢复"
- **单实例保护**：App 启动时写 PID 文件到 state-dir，检测到已有实例则 focus 已有窗口退出新实例（见 §11）

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

从 GoGoGo 借鉴，**增加 `tabId` 字段**支持多 Tab。

**握手消息（连接建立后立即交换）**：

| 类型 | 方向 | 结构 |
|---|---|---|
| `hello` | ← | `{ type, serverVersion, protocol, supported: [1, 2], peer: { name, os } }` |
| `hello-ack` | → | `{ type, protocol, client: { name, os } }` |

- `protocol` 整数，每次破坏性协议改动 +1，v1 起始值 `1`
- 不匹配时 server 发 `{ type:'error', code:'version_mismatch' }` 并 `close(4000)`
- UI 层收到 `version_mismatch` 时弹 toast "远程设备版本过旧/过新，请升级 claude-code-pro"

**会话消息**：

| 类型 | 方向 | 结构 |
|---|---|---|
| `tabs:list` | → | `{ type }` 请求 tab 列表 |
| `tabs:list` | ← | `{ type, tabs: [{ id, title, kind, cwd }] }` |
| `tab:subscribe` | → | `{ type, tabId }` 订阅某个 tab 的 PTY 流 |
| `tab:unsubscribe` | → | `{ type, tabId }` |
| `output` | ← | `{ type, tabId, seq, data }` |
| `input` | → | `{ type, tabId, data }` |
| `resize` | → | `{ type, tabId, cols, rows }` |
| `sync` | → | `{ type, tabId, lastSeq }` |
| `history` / `history-delta` | ← | `{ type, tabId, data[], lastSeq, truncated? }` |
| `exit` | ← | `{ type, tabId, code }` PTY 退出。重连时若 tab 已退出，history/delta 之后立即补发一条 |
| `tab:created` / `tab:closed` | ← | `{ type, tab }` host 通知新建 / 关闭（Mesh 多 tab 面） |
| `tab:new` | → | `{ type, cwd?, command? }` 请求 host 新建 tab（仅 mesh 面） |
| `tab:close-on-host` | → | `{ type, tabId }` 请求 host kill 此 tab 的 PTY（二次确认） |

**v0 Tunnel 面的简化约定**（每个 share 绑定单 Tab）：

- 会话消息可省略 `tabId` 字段（share 已隐式绑定 tab）
- 客户端发送的 `resize` 被服务端忽略——本地渲染进程是 PTY 尺寸权威，远程访客不应争抢
- `tabs:list` / `tab:subscribe` / `tab:unsubscribe` / `tab:new` / `tab:close-on-host` 在 Tunnel 面不使用；v1 Mesh 多 tab 场景才启用

**缓冲与历史**：

- 每个 Tab 独立环形 buffer，**上限 5000 条 chunk** / tab
- 10 tab 满载约 12MB 内存，可控
- 长跑会话（如 claude 输出几万行）：超过缓冲后较早的输出会被冲掉，断线重连只能拿到缓冲范围内的 delta。这是**预期行为**，UI 要在历史被冲时给一条灰色分隔线"(earlier output not retained)"
- **PTY 退出后的重连**：tab 退出时 buffer 不立即释放，保留为"墓碑"，新连上的客户端通过 sync 仍能拿到历史；发送 history/history-delta 后立即补一条 `exit` 消息，避免客户端陷入"无数据、无结束"的僵尸状态

### 6.2 Mesh 面 vs Tunnel 面的差异

| 项 | Mesh（tailnet） | Tunnel（cloudflared） |
|---|---|---|
| 认证 | Tailscale WG 层保证 + Host 总开关 | per-share token + httpOnly cookie |
| 访问范围 | 全部 Tab（仅 Host 模式下） | **仅 share 绑定的那个 Tab** |
| 新建 Tab | 允许（有 first-connect 提示，见 §8.7） | **禁止** |
| Close on Host | 允许（二次确认） | 禁止 |
| 文件系统 API | 允许（v2+） | 禁止 |
| 设置管理 API | 禁止（Settings 永远只能本机改） | 禁止 |
| 撤销 | 关 Host 开关即时断全部 | Stop Share 即时吊销 token |

### 6.3 Tunnel 面：per-tab share 的 URL 和 token 方案

**设计原则**：粒度 = 单个 Tab，每个 share 独立 token，Stop 即时吊销。

**架构**：

```
cloudflared (singleton, 按需启动) ──► 127.0.0.1:<local-server-port>
                                          │
                                   LocalServer (Node Express+WS)
                                          │
                                    路由: /t/:shareId/*
                          ┌───────────────┼───────────────┐
                          ↓               ↓               ↓
                   /t/sh-abc123/      /t/sh-def456/     ...
                      token: tk-xy       token: tk-zw
                      tabId:  claude-1   tabId:  dev-2
                      seq:    独立        seq:    独立
```

**share 生命周期**：

```
1. 用户在 Tab 右键选 "Share via Link"
    ↓
2. Electron 生成 shareId (UUID) + token (128-bit)
    ↓
3. 如果 cloudflared 还没跑：spawn cloudflared --url http://localhost:<local-server-port>
   → 拿到 https://xxx.trycloudflare.com
    ↓
4. 注册路由: /t/<shareId>/* → handler 绑定 tabId
    ↓
5. UI 显示:
   https://xxx.trycloudflare.com/t/<shareId>/?token=<token>
   用户复制或扫 QR 发给对方
    ↓
6. 对方打开 URL:
   - token 从 query 注入 httpOnly cookie（作用域限定 /t/<shareId>/）
   - URL 自动重定向去掉 token（history.replaceState）
   - xterm.js 页面连 /t/<shareId>/ws
    ↓
7. 用户点 [Stop]:
   - 删除路由 /t/<shareId>/*
   - 吊销 token（即使 cookie 还在，路由已不存在）
   - 对方 WS 立即断开，刷新页面看到 404
   - 若所有 share 都 stop：cloudflared 保持 5 分钟后自动关（避免频繁起停）
```

**安全保障**：

- token 和 shareId 都是随机生成，**知道其中一个无法推断另一个**
- cookie 作用域限定 `/t/<shareId>/` 路径，不会泄露到其他 share
- 没有 `/tabs:list`，访客**看不到其他 Tab** 的存在
- 没有 `/tab:new` / `/tab:close-on-host`，访客只能操作当前绑定的 Tab
- tunnel URL 和 token 的组合熵 ~10^40，不可爆破

**UI 上并发分享**：

- 每个 Tab 可独立分享
- 同时分享多个 Tab 时它们共用一个 cloudflared / tunnel URL，但 shareId 不同
- Remote Modal 的 Tunnel Tab 显示所有活跃 share 列表，每个有独立 Stop 按钮

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

### 7.5 并发输入语义：last-write-wins

多个输入源（本地键盘、mesh peer、tunnel visitor）同时写 PTY 时，**字节级交错**——就像两个人同时敲同一个键盘。这是协作终端的通病（tmate、tmux shared session 也一样）。

**设计决策**：不实现输入锁、不实现排他控制。用户应自行协调（通常通过 claude 会话的协作规范：谁在操作谁先喊一声）。

**已知后果**：
- 本地敲 `ls` 时远程同时敲 `cd ~` → PTY 收到字节交错的 `lcsd ~` 乱码
- 这在实际体验中很少发生，因为协作双方通常有共识
- UI 不需要特别处理，PTY 的乱码由 shell 的 echo 和 readline 体现，用户自然会看到

### 7.6 OAuth 登录 URL 的泄露防御

Go sidecar 通过 stdout 发 `{"type":"auth_url","url":"https://login.tailscale.com/..."}` 给 Electron。这个 URL 在时效内（通常 15 分钟）任何人打开都能加入 tailnet。

**防御**：
- **绝不写入日志文件**。Go sidecar 的 `UserLogf` 只能输出到 stdout 供 Electron 解析，不能同时写磁盘日志
- Electron 端收到 `auth_url` 后直接 `shell.openExternal(url)`，**不把 URL 打进 renderer console 或 debug store**
- 如果 `shell.openExternal` 失败（headless 场景，见 §4.3 方案 1）：UI 弹 Modal 显示 URL 让用户手动复制，同时明示"此 URL 有时效性，请勿分享"

### 7.7 "立即撤销所有远程访问" 应急按钮

Remote Modal 底部的红色按钮。触发流程：

1. 弹确认 Modal："此操作会立即把此机器从 tailnet 移除，并引导你在 Tailscale admin console 删除其他设备。是否继续？"
2. 确认后：
   - 调 `/logout`（sidecar 清 state-dir，下次需重新 OAuth）
   - 停所有活跃的 tunnel share
   - kill cloudflared 子进程
   - 打开浏览器到 `https://login.tailscale.com/admin/machines`
   - UI 弹提示："请在 Tailscale admin 中移除其他设备，再取消授权应用"

这个按钮**不能真正做到原子式全局撤销**（因为我们没有 Tailscale API 权限，A 方案下用户是自己 tailnet 的主人），但能做到"此机器立即断网 + 引导用户完成剩余操作"。文档和 UI 要明示这个限制。

---

## 8. UI 设计

### 8.1 标题栏

在 [src/App.tsx:176-190](src/App.tsx#L176-L190) Debug 按钮旁新增图标：

- **🌐 (Mesh)** 三态：
  - 灰色：未加入 tailnet
  - 绿色单圈 `◯`：Client-only（加入 tailnet 但未开 Host）
  - 金色双圈 `⊙`：Host 模式（接受连接中）
  - 黄色脉冲：连接中 / 重连中
- **🔗 (Tunnel)**：有活跃 share 时亮起，右下角角标显示活跃 share 数量（如 `🔗²`）

点击任一图标打开 Remote Modal 并切到对应 Tab。

### 8.2 Remote Modal

两个 Tab：**Mesh** 和 **Tunnel Share**。

#### 8.2.1 Mesh Tab

```
┌─────────────────────────────────────────────┐
│  Mesh Network · Tailscale                    │
│                                               │
│  [●]  已加入 tailnet                          │
│       设备名: ubuntu-home ▸                   │
│       IP:   100.64.1.23                      │
│                                               │
│  ─────────────────────────────────────       │
│                                               │
│  Host 模式                              [ ○ ] │
│  允许其他设备连接并操作此机器上的 Tab          │
│                                               │
│  ─────────────────────────────────────       │
│                                               │
│  My Devices (3)                              │
│   🟢 jack-mbp          [host]    → 连接      │
│   🟢 work-imac                  (client-only)│
│   ⚪ old-laptop        offline               │
│                                               │
│  ─────────────────────────────────────       │
│                                               │
│  □ 启动 app 时自动加入 tailnet                │
│  ▸ 高级：自定义 Coordination Server           │
│                                               │
│  🚨 立即撤销所有远程访问                      │
│                                               │
│  Powered by Tailscale · [帮助]                │
└─────────────────────────────────────────────┘
```

**启用 Host 模式时弹确认**：

> **启用 Host 模式？**
>
> 启用后，你 Tailscale 账户下的所有设备都能：
> - 查看此机器上所有已打开的 Tab
> - 输入命令（等同于在此机器本地键盘输入）
> - 新开终端并执行任意命令
>
> 这等于把此机器的 shell 权限授予 tailnet 内所有设备。只在你信任自己的所有设备时启用。
>
> [取消]  [我理解，启用]

关闭 Host 时即时生效，所有已连 peer 的 WS 收到 `close(4001, "host_disabled")`。

#### 8.2.2 Tunnel Share Tab

```
┌─────────────────────────────────────────────┐
│  Tunnel Share · Cloudflare                   │
│                                               │
│  ⚠ 数据经 Cloudflare 中继（非端到端加密）。   │
│    敏感会话请用 Mesh。                        │
│                                               │
│  ─────────────────────────────────────       │
│                                               │
│  Active Shares (2)                           │
│                                               │
│  🔗 claude-1                          [Stop] │
│     https://fx-ab.trycloudflare.com/t/sh-... │
│     [复制]  [QR]  · 已连接 1 人               │
│                                               │
│  🔗 dev-server                        [Stop] │
│     https://fx-ab.trycloudflare.com/t/sh-... │
│     [复制]  [QR]  · 未连接                   │
│                                               │
│  ─────────────────────────────────────       │
│                                               │
│  要分享某个 Tab，右键 Tab → Share via Link    │
└─────────────────────────────────────────────┘
```

分享动作发起点**不在这里**，在 Tab 的右键菜单（见 §8.6）。这里只是所有活跃 share 的总览与管理。

### 8.3 侧边栏：My Devices

在文件树上方新增区域：

```
▼ My Devices
  🟢 ubuntu-home (this) [host]
  🟢 jack-mbp          [host]
  🟢 work-imac                (client)
  ⚪ old-laptop        offline

▼ Files
  [文件树]
```

点击其他**host** 设备 → 侧边弹出 Tab 列表 → 选 Tab → 新开 "Remote Tab"。
点击 client-only 设备：灰色不可点，悬停提示"此设备未开启 Host 模式"。

### 8.4 Remote Tab 视觉标识

- Tab 标题前加小图标（🌐 远程）：`🌐 jack-mbp · claude-1`
- Tab 底部状态条显示 `jack-mbp @ 100.64.1.23 · tailnet`
- 网络异常时状态条变红并显示 `Reconnecting...`
- 右键菜单额外项：
  - `Close` (⌘W)：仅关闭 Remote Tab，host 的 PTY 继续跑
  - `Close on Host` (⌘⇧W)：请求 host 终止 PTY，**需要二次确认**

**Close on Host 确认**：

> **终止 ubuntu-home 上的 "claude-1"？**
>
> 此操作会在远端 kill 这个 PTY 进程，所有未保存的会话状态将丢失。
>
> [取消]  [Close on Host]

### 8.5 Tab Share 入口（右键菜单）

现有 Tab 右键菜单新增一项：

```
Tab 右键菜单
├── Rename
├── ───────
├── Share via Link...           ← 新增
├── ───────
└── Close
```

点击 "Share via Link..." 弹出：

```
┌──────────────────────────────────────────┐
│  Share "claude-1"                         │
│                                           │
│  This opens a public URL via Cloudflare   │
│  that lets anyone with the link view and  │
│  type in this terminal.                   │
│                                           │
│  ⚠ Data passes through Cloudflare         │
│    (not end-to-end encrypted).            │
│                                           │
│  [Cancel]        [Start Sharing]          │
└──────────────────────────────────────────┘
```

点 Start Sharing 后：

```
┌──────────────────────────────────────────┐
│  Sharing: claude-1                 [Stop] │
│                                           │
│  🔗 https://fx-ab.trycloudflare.com/     │
│     t/sh-abc/?token=tk-xy                 │
│                                           │
│  [Copy Link]    [Show QR Code]            │
│                                           │
│  ⚠ 关闭此 Modal 不会停止分享。            │
│    点 Stop 才能撤销访问。                 │
└──────────────────────────────────────────┘
```

分享中的 Tab，标题右侧加 🔗 小图标（和活跃 share 数量联动到标题栏 🔗²）。

### 8.6 Toast 提示系统

统一 toast 组件，几种场景：

**① Host 侧：新 peer 首次连接**（per-device 记忆）

```
┌──────────────────────────────────────────┐
│  🌐  jack-mbp 已连接                      │
│  现在可查看你的 Tab 并输入命令。          │
│  [知道了]  [断开此设备]  □ 此设备不再提示 │
└──────────────────────────────────────────┘
```

"断开此设备" 只 kick 这一个 peer（不影响其他连接，也不关 Host 模式）。
"不再提示"记忆到 [remoteStore.trustedPeers](src/stores/remoteStore.ts)。

**② Remote Tab 侧：首次关闭 Remote Tab**（全局记忆）

```
┌──────────────────────────────────────────┐
│  Remote Tab 已关闭                        │
│  此终端仍在 ubuntu-home 上运行，          │
│  可随时重新连接查看。                     │
│  [知道了]    □ 不再提示                   │
└──────────────────────────────────────────┘
```

**③ 协议版本不匹配**

```
┌──────────────────────────────────────────┐
│  ⚠ 远程设备版本不兼容                      │
│  jack-mbp 的 claude-code-pro 版本过旧，   │
│  无法建立连接。请双方升级到最新版。        │
│  [知道了]  [查看文档]                     │
└──────────────────────────────────────────┘
```

**④ sidecar 重连中**（状态栏脉冲 + 非阻断 toast）

```
┌──────────────────────────────────────────┐
│  🌐 Mesh 重连中...                         │
│  (第 2 次尝试，下次 15 秒后)              │
└──────────────────────────────────────────┘
```

### 8.7 状态存储

新建 [src/stores/remoteStore.ts](src/stores/remoteStore.ts)（Zustand + persist）：

```ts
interface RemoteState {
  mesh: {
    joined: boolean           // L1: 是否加入 tailnet
    host: boolean             // L2: 是否开启 Host 模式
    autoJoinOnStart: boolean  // 启动时自动加入（仅 L1）
    deviceName: string
    customControlURL?: string // headscale 自定义
    status: 'off' | 'connecting' | 'client' | 'host' | 'error'
    tailnetIp?: string
    peers: Peer[]
    trustedPeers: string[]    // 已勾选"不再提示"的 peer 名字
  }
  tunnel: {
    shares: Share[]           // 活跃 share 列表
    cloudflaredRunning: boolean
    tunnelUrl?: string
  }
  toasts: {
    remoteTabCloseMuted: boolean
  }
}

interface Peer {
  name: string
  ip: string
  isHost: boolean
  online: boolean
  os?: string
}

interface Share {
  shareId: string
  tabId: string
  createdAt: number
  connectedClients: number
  url: string  // 完整可分享 URL（含 token）；仅在 create 时得到，重启后为空字符串
}
```

**v0 实现注记**：
- `url` 字段替代了原设计中的 `token` —— token 仅在 `remote:share:create` 调用返回值里出现一次，随后只保留整条 URL，避免渲染进程长期持有裸 token
- `tabTitle` 不在 store 里冗余保存，UI 按需从 `tabStore.tabById(tabId)` 解析
- 应用重启后 `remoteStore` 清空，通过 `refreshStatus()` 重新从主进程拉 `list()`——但 `list()` 不返回 URL，所以 UI 把这些"孤儿 share"标为"URL 不可用，请 Stop 后重新分享"

`tunnel.shares` 不 persist（应用重启 shares 失效，cloudflared URL 每次重启也变）。`mesh.trustedPeers` 和 `toasts.remoteTabCloseMuted` persist。

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

### 9.5 平台差异注意事项

**Windows 特殊处理**：
- electron-builder 的 `extraResources.from` 路径用 forward slash 或 `path.posix` 风格，**不要用 backslash**，否则 Windows CI 会失败
- Go 二进制文件名必须带 `.exe` 后缀：`tsnet-sidecar.exe`
- `child_process.spawn` 启动 Go sidecar 时 Windows 需要 `windowsHide: true` 避免弹 cmd 窗口
- PID 文件路径 `%APPDATA%\claude-code-pro\sidecar.pid` 要先确保父目录存在

**macOS 特殊处理**：
- `extraResources` 打包的二进制必须被主 app 的 codesign 链接认可；需在 `electron-builder.mac.binaries` 里显式列出 tsnet-sidecar 和 cloudflared 路径
- 首次运行可能触发 "Cannot verify developer" 弹窗，必须完成公证（notarization）
- Rosetta 兼容：Intel Mac 运行 arm64 二进制会失败，必须按 arch 打包分发

**Linux 特殊处理**：
- AppImage 里 `extraResources` 路径在运行时映射到 `$APPDIR/resources/`；要用 `process.resourcesPath` 正确取路径
- Go 二进制要 `chmod +x`——electron-builder 的 `extraResources` 默认保留权限位，但建议在 postinstall 脚本里兜底一次

### 9.6 验证清单（每个平台 release 前跑）

| 项 | Linux x64 | Linux arm64 | macOS x64 | macOS arm64 | Win x64 |
|---|---|---|---|---|---|
| tsnet-sidecar 能启动 | ✅ | ✅ | ✅ | ✅ | ✅ |
| cloudflared 能启动 | ✅ | ✅ | ✅ | ✅ | ✅ |
| OAuth URL 能在系统浏览器打开 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Mesh 跨机器连接成功 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tunnel URL 能被访问 | ✅ | ✅ | ✅ | ✅ | ✅ |
| App 退出时 sidecar + cloudflared 被清理 | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## 10. 路线图

### v0 — Cloudflare Tunnel · per-Tab Share（访客通道）

**目标**：用户可以右键任一 Tab "Share via Link"，生成独立 URL 发给别人访问。
**工作量**：~500 行 TS

**模块清单**：
- `electron/remote/tunnel-manager.ts`：启停 cloudflared，解析 URL（参考 GoGoGo `src/cloudflare-tunnel.ts`）
- `electron/remote/local-server.ts`：Express + WS，`/t/:shareId/*` 路由，per-share token 鉴权
- `electron/remote/output-buffer.ts`：per-tab 环形 buffer + seq 管理（用 v1 也用）
- `electron/remote/pty-fanout.ts`：PTY `onData` 改造为多路广播（本地 IPC + local-server + mesh-server 预留口）
- `electron/remote/web/`：xterm.js 前端（从 GoGoGo 搬 `public/` 并适配 per-share URL）
- `src/stores/remoteStore.ts`：tunnel 部分（shares[]）
- UI：
  - 标题栏 🔗 按钮（活跃 share 数角标）
  - Remote Modal 的 Tunnel Share Tab（§8.2.2）
  - Tab 右键菜单 "Share via Link..."（§8.5）
  - "Data passes through Cloudflare" 警告文案
- 协议：WS hello/hello-ack（§6.1），为 v1 mesh 复用

**验收**：
- 在 Ubuntu 上右键 Tab → Share via Link → 得到 URL
- MacBook 浏览器打开 URL → 自动 cookie 鉴权 → 看到那个 Tab 的终端
- 输入、resize、历史同步 / delta 重连工作
- 开多个 share 并发，互不干扰
- Stop 单个 share 后该 URL 404，其他 share 继续可用
- 关闭 app 时所有 share + cloudflared 自动清理

### v1 — Tailscale Mesh（设备互联）

**目标**：多台设备通过 tailnet 互联，Host/Client 开关清晰。
**工作量**：Go sidecar ~150 行 + TS ~600 行

**模块清单**：
- `native/tsnet-sidecar/main.go`：tsnet.Server + stdio JSON 事件 + 控制 HTTP + TCP 反向代理
- `electron/remote/tsnet-bridge.ts`：spawn sidecar + stdio 解析 + 控制 API 封装
- `electron/remote/mesh-server.ts`：Express + WS，复用 output-buffer（`/mesh/*` 路由）
- `electron/remote/mesh-client.ts`：通过 sidecar 暴露的 SOCKS5 连其他 peer
- `src/stores/remoteStore.ts`：mesh 部分完整（peers, trustedPeers, host 状态等）
- UI：
  - 标题栏 🌐 三态图标（§8.1）
  - Remote Modal 的 Mesh Tab + Host 开关二次确认（§8.2.1）
  - 侧边栏 My Devices（§8.3）
  - Remote Tab 组件（§8.4）
  - Toast 系统：peer first-connect、remote tab close、version mismatch、reconnecting（§8.6）
  - 应急撤销按钮（§7.7）
  - headscale Custom Control URL 高级选项（§4.3）
- PID 文件单例保护（§11）

**验收**：
- 两台 Ubuntu + MacBook 都装 claude-code-pro、各自用同一 Tailscale 账户授权
- 都能在 My Devices 看到对方
- Ubuntu 开 Host 模式后，MacBook 可连进来查看全部 Tab + 新开 Tab + 输入
- Host 收到 first-connect toast
- 关掉 Host → MacBook 端立即断开
- Sidecar 手动 kill 测试：peer 自动重连，claude 会话不丢
- 协议版本不匹配时 UI 正确报错

### v2 — 体验打磨

**工作量**：TBD
- 跨设备文件拖拽传输
- 远程项目的 "Open Folder"（调用远端 fs API）
- 跨用户分享：Tailscale Sharing API 集成（等官方开放）或引导至 admin console
- Passkey 支持（Tunnel 面升级到 WebAuthn）
- 按需下载 tsnet-sidecar（installer 瘦身）
- **系统托盘常驻**：关闭窗口时继续在后台跑 mesh / tunnel（§4.7 结构已预留）
- "启动时自动加入 tailnet" 的失败回退策略（过期授权时降级为未启用，不卡住）
- 并发分享多 Tab 时 cloudflared 的连接池优化

### v3 — 生态
- LM Studio 互联（利用 LM Link 的 tailnet 发现 LM Studio 设备并调用其模型）
- 真正的"跨用户 mesh"协作（等 Tailscale Sharing API 开放后做）

---

## 11. 风险、约束与 v1 明确不做的事

### 11.1 已知风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 用户没有 Tailscale 账户，注册流程卡住 | 高 | Modal 里提供清晰引导；Google/GitHub 一键登录无痛 |
| tsnet-sidecar 在 macOS 上被 Gatekeeper 拦 | 高 | 必须和主 app 一起公证；CI 流程要测 |
| 系统装了 Tailscale 客户端导致路由冲突（LM Link Issue #1692） | 中 | 文档里明示；提供"只用 Tunnel 不用 Mesh"的 fallback |
| installer 体积增加 30MB+ | 中 | v2 迁移到按需下载 |
| 交叉编译 Go 6 平台的 CI 复杂度 | 中 | 用 Go 原生 cross-compile，不用 CGO（tsnet 纯 Go）|
| CF Tunnel 经过 Cloudflare 中间人 | 中 | UI 明示警告；敏感场景引导用 Mesh |
| Tailscale 免费额度变更 | 低 | 100 设备对个人用户冗余很大 |
| OAuth URL 被日志文件泄露 | 高 | Go sidecar 严禁写 URL 到日志；Electron 不写入 debug store（§7.6）|
| 并发输入导致乱码 | 低 | 预期行为，不实现输入锁（§7.5）|

### 11.2 设计约束（单实例、重名等）

**单实例保护**：
- App 启动时在 state-dir 写 `sidecar.pid` 锁文件
- 检测到已有实例存活：聚焦原窗口，退出新进程
- 实现简单、保护状态一致性（避免两个 sidecar 争 4242 端口、两个同名设备出现在 tailnet）

**设备重名处理**：
- Tailscale 对同名设备自动加 `-1`、`-2` 后缀（对 MagicDNS 名字也生效）
- UI 在 My Devices 列表里显示 Tailscale 上报的**实际** hostname，而非本地配置的期望名
- 用户发现重名后可在"设备名"字段里改名，sidecar 重启应用

**长会话 history 丢失的 UX**：
- 输出缓冲 5000 条/tab 是硬上限
- 超过后较早输出会被冲掉
- 断线重连时若 `lastSeq` 早于缓冲起点：
  - 协议层返回完整 `history` 而非 `history-delta`
  - xterm 渲染时在顶部加一行灰色分隔：`─── earlier output not retained ───`
- 用户需知道"长会话 + 长断线 = 历史会丢"

### 11.3 v1 明确不做的事（defer 列表）

- ❌ 中国大陆网络优化（Q4）
- ❌ 跨用户 Mesh 分享（用 Tunnel 代替，§6.3）
- ❌ Tailscale Sharing API 集成（等官方开放）
- ❌ 系统托盘常驻（结构留好，v2 实现）
- ❌ 按需下载 tsnet-sidecar（v1 打包进 installer）
- ❌ Passkey / WebAuthn（Tunnel 继续用 token）
- ❌ Device Pairing（mesh 面不加额外应用层认证）
- ❌ Per-Tab mesh 访问控制（Host 开关是最小粒度）
- ❌ 头 headless 服务器 Electron 支持（OAuth URL fallback 可用，但 Electron 本身启不起来）
- ❌ 远程文件系统 API（v2）

### 11.4 未决问题（需要实机或社区验证，不阻塞 v0）

1. **实机验证 LM Link 细节**（30 分钟）
   - 装 LM Studio 0.4.8+
   - `ls ~/.lmstudio/extensions/frameworks/`
   - `strings lmlink-connector | grep tsnet`
   - `lsof -p <pid>` 看监听端口
   - 抓本地环回流量看 Electron↔连接器协议

2. **Tailscale ToS 对"应用内嵌 tsnet"的态度**：免费计划 100 设备/用户，若大量 claude-code-pro 用户都注册节点会不会被视为滥用？需看 [Tailscale ToS](https://tailscale.com/terms) 或直接问 support。

3. **是否使用 Ephemeral 节点**：
   - `Ephemeral: true` 离线 ~5 分钟后自动删设备
   - 对桌面应用**不合适**（用户关机一晚上不应该设备消失）
   - 初步决策：**不用 Ephemeral**，用户自己在 admin 删设备
   - v1 落地时再 double-check

4. **Go sidecar 和 Electron ABI 兼容性**：node-pty 是 native 模块要 rebuild，Go sidecar 是独立子进程理论上无 ABI 耦合。但 Electron 升级时 PATH、spawn 行为可能有变化，需要 CI 覆盖 Electron major 版本升级场景。

5. **cloudflared npm 包 vs 系统安装**：GoGoGo 用 npm 包 `cloudflared` 自动下载二进制。需验证 Electron asar 解包 + Gatekeeper 公证链能否走通。

---

## 12. v0 开工清单

开始写代码前要先做的 3 件事：

### 12.1 实机验证 LM Link（可选，建议做，30 分钟）

装一次 LM Studio 0.4.8+ 并启用 LM Link，确认 §5.3 的"未确认"条目：
- `~/.lmstudio/extensions/frameworks/` 下连接器的目录命名模式
- `strings lmlink-connector | grep -i tsnet` 确认 tsnet 被 static link
- `lsof -p <pid>` 看 controlPort 和监听端口
- 抓包看 Electron↔连接器的 wire protocol 是 JSON-RPC 还是 gRPC

**如果与文档推测吻合**：增加信心继续按方案 Y 实现。
**如果有关键差异**：修订设计。

### 12.2 Go sidecar spike（建议做，~1 天）

在 `native/tsnet-sidecar/` 写 100-150 行 Go，验证：
- `tsnet.Server.Up()` + stdio JSON 事件流
- OAuth URL 能通过 `LocalClient.WatchIPNBus` 拿到
- `tsnet.Server.Listen()` + `io.Copy` 反向代理到 127.0.0.1
- `Server.Loopback()` 暴露 SOCKS5 让 Node client 用
- 两台 Linux 之间端到端通

**跳过条件**：如果实在想快，可以等 v1 阶段再做 spike，v0 只用 cloudflared 路径不依赖 Go。

### 12.3 v0 代码骨架

从 GoGoGo 搬起来改：

- `electron/remote/tunnel-manager.ts` ← 参考 [src/cloudflare-tunnel.ts](../GoGoGo/src/cloudflare-tunnel.ts)
- `electron/remote/local-server.ts` ← 参考 [src/web-server.ts](../GoGoGo/src/web-server.ts)，路由改为 `/t/:shareId/*`
- `electron/remote/output-buffer.ts` ← 新写，per-tab 环形 buffer + seq
- `electron/remote/pty-fanout.ts` ← 改造现有 `electron/main.ts:379-382` PTY 扇出
- `electron/remote/web/` ← 搬 [public/](../GoGoGo/public/) 并适配 per-share URL
- UI：标题栏 🔗、Remote Modal Tunnel Share Tab、Tab 右键菜单

### 12.4 验收标准（见 §10 v0 验收）

跑通即可 commit。随后进入 v1 Mesh 实现。

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
