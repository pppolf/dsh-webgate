# dsh-webgate — DSH 远程访问插件

一个 **DeepSeek Harness（DSH）生态插件**，让手机或任何设备远程访问本机运行的
`dsh web`（DeepSeek Harness 浏览器界面），支持三种访问方式：

| # | 方式 | 适用场景 | 需要什么 | 安全 |
|---|---|---|---|---|
| 1 | **内网访问**（默认开启） | 手机与电脑同一 Wi-Fi/内网 | 无 | ⚠️ 网内无密码（可另配登录门户） |
| 2 | **外网 · cloudflared 一键隧道** | 临时应急、不想碰服务器 | 下载一个二进制 | ⚠️ 链接即权限（随机 URL） |
| 3 | **外网 · frp + 自有服务器反代** | 长期稳定、有域名/服务器 | 一台公网服务器（推荐 Caddy） | ✅ 密码登录门户 + HTTPS |

---

## 功能总览

- **内网直连**：把 webserver 默认绑定 `0.0.0.0`，自动信任局域网 IPv4/IPv6 与
  `主机名.local`，设置页「手机访问」展示**二维码**；
- **cloudflared 快速隧道**：插件托管 cloudflared 进程，公网域名自动加入信任列表；
- **frp 隧道 + 自有服务器**：插件托管 frpc（断线自动重连），配合服务端 frps 与
  Caddy 反代 + 自有域名；
- **登录门户**（frp 方式的推荐安全层）：内置零依赖 Web 登录页 + scrypt 密码校验 +
  30 天 HttpOnly Cookie 会话 + 每 IP 限速，彻底解决 iOS Safari 对 Basic Auth 的
  弹框死循环；
- **开箱即用的兼容修复**：
  - 页面注入 UUID v4 polyfill（`crypto.randomUUID` 在 http://局域网 IP 等非安全
    上下文不存在，会导致客户端崩溃）；
  - 自动选中最近会话（新来源浏览器不再停在空状态）；
  - `Cache-Control: no-store`（防止手机缓存旧版页面）；
  - 设置持久化 shim（远程浏览器设置页可正常读写）。

---

## 安装

要求：DSH `0.1.0-rc.6`（`dsh --version`），且至少启动过一次 `dsh web`。

### 方式 A：DSH 原生插件命令（推荐）

`dsh plugin --profile web add <来源>` 会运行 pnpm 安装，并**自动把本插件注册进
profile 的 bundles 层**（DSH 会检测包声明的 `dsh.bundle` 并自动追加），装完重启
`dsh web` 即生效：

```bash
# 1) npm（推荐）
dsh plugin --profile web add dsh-webgate

# 2) Git 仓库
dsh plugin --profile web add github:<你的用户名>/dsh-webgate

# 3) 本地目录（开发/试用，免发布）
dsh plugin --profile web add link:/Users/you/dsh-webgate   # 符号链接，改源码即时生效
dsh plugin --profile web add file:/Users/you/dsh-webgate   # 复制一份，与源码解耦

# 卸载 / 更新
dsh plugin --profile web remove dsh-webgate
dsh plugin --profile web update dsh-webgate
```

### 方式 B：仓库自带脚本

```bash
cd dsh-webgate
./install.sh            # 安装到 ~/.dsh/profiles/web（符号链接，默认不重启）
./install.sh --restart  # 安装并立即重启 dsh web
./install.sh --copy     # 复制而非符号链接
```

重启后打开 `http://127.0.0.1:3080` → 设置 → **手机访问** 即可看到二维码与地址。
卸载：`./uninstall.sh`（然后重启 dsh web）。

### 发布到 npm

包名 `dsh-webgate`（未加作用域，无冲突）。首次发布：

```bash
cd dsh-webgate
npm login        # 首次需要浏览器/OTP 认证
git tag v0.2.0   # 可选：给版本打 git 标签
npm publish
```

以后每次发新版：改 `package.json` 的 `version` → 提交 → `npm publish`。

---

## 配置参考

所有配置都在 web profile 的补丁层
`~/.dsh/profiles/web/cordis.patch.yml` 里（对 `lan-access` 行做覆盖）：

```yaml
- id: lan-access
  config:
    printBootLine: true        # 启动时打印 URL + 终端二维码
    injectBrowser: true        # 注入 window.__DSH_LAN__（二维码/地址数据）

    # —— 方式 2：cloudflared 一键隧道 ——
    tunnelEnabled: false
    tunnelBinary: /Users/you/.dsh/bin/cloudflared

    # —— 方式 3：frp + 自有服务器 ——
    frpEnabled: false
    frpcBinary: /Users/you/.dsh/bin/frpc
    frpcConfig: /Users/you/.dsh/frpc.toml
    extraHosts:                # 需要信任的公网域名（围栏放行）
      - dsh.example.com

    # —— 登录门户（frp 方式推荐开启）——
    portalEnabled: false
    portalUser: admin
    portalPasswordHash: "<salt>$<hash>"   # scrypt，见下文生成方法
    portalPort: 8081
```

注意：补丁行会**整体替换**目标行的 config，请把需要的键都写上。修改后需重启
`dsh web` 生效。

---

## 方式 1：内网访问（默认，零配置）

装好插件并重启后即为开启状态：

1. 启动日志会打印 `LAN URL: http://<局域网IP>:3080` + 终端二维码；
2. 电脑浏览器打开 `http://127.0.0.1:3080` → 设置 → 手机访问，用手机相机扫码；
3. 手机也可直接打开 `http://<局域网IP>:3080`，或 `http://<电脑名>.local:3080`。

**安全提示**：局域网模式没有密码，同一网络内的设备都能操作 Agent（含执行命令）。
只在可信 Wi-Fi 使用；敏感设置/凭据默认仍仅限本机。如需密码，可配合登录门户
（把 frpc 的 `localPort` 指向门户端口即可，见方式 3）。

---

## 方式 2：cloudflared 一键隧道（免费、免注册）

```bash
# 1) 下载二进制（macOS arm64）
mkdir -p ~/.dsh/bin && cd ~/.dsh/bin
curl -sL -o cloudflared.tgz "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
tar xzf cloudflared.tgz

# 2) 在 cordis.patch.yml 开启
#    tunnelEnabled: true
#    tunnelBinary: /Users/you/.dsh/bin/cloudflared

# 3) 重启 dsh web
```

启动日志与「手机访问」设置页会给出 `https://<随机名>.trycloudflare.com` + 二维码。
**任何人拿到链接即可操作 Agent，切勿公开分享；每次重启地址会变。**
中国大陆网络下 trycloudflare.com 可能被污染/重置，此时请用方式 3。

---

## 方式 3：frp + 自有服务器（稳定、可带域名和登录门户）

架构：

```
手机/浏览器 → Cloudflare(可选,橙云) → 服务器 Caddy(HTTPS) → frps(:7080,仅本机)
            → frpc(你的Mac, 自动重连) → 登录门户(:8081) → dsh web(:3080)
```

### 3.1 服务器端（Ubuntu + root）

```bash
# 把部署脚本传到服务器（非破坏式：自动备份并追加 Caddy 站点，绝不覆盖）
scp deploy/frp-server-setup.sh root@<服务器IP>:/root/
ssh root@<服务器IP> 'FRP_TOKEN=<随机token> FRP_DOMAIN=dsh.example.com   FRP_AUTH_USER=admin FRP_AUTH_PASS=<强密码> bash /root/frp-server-setup.sh'
```

脚本会自动：安装 frps（systemd）→ 端口加固（7080 仅本机可访问）→ 安装/升级 Caddy
→ 追加带 TLS 的站点（用 `caddy hash-password` 生成 Basic Auth 哈希）。

服务器端还需自行完成：
- 云安全组放行 **7000/TCP**（frp 控制）、**80/443**（Caddy）；
- 域名 A 记录指向服务器 IP；如用 Cloudflare 橙云 + 源证书，见下节。

### 3.2 电脑端

```bash
# 1) 下载 frpc（macOS arm64）
mkdir -p ~/.dsh/bin && cd /tmp
curl -sL -o frp.tgz "https://github.com/fatedier/frp/releases/latest/download/frp_$(curl -sL https://api.github.com/repos/fatedier/frp/releases/latest | grep -o 'tag_name": "v[0-9.]*' | cut -d'"' -f3)_darwin_arm64.tar.gz"
tar xzf frp.tgz && cp frp_*_darwin_arm64/frpc ~/.dsh/bin/frpc && chmod +x ~/.dsh/bin/frpc

# 2) 写 ~/.dsh/frpc.toml
```

```toml
serverAddr = "<服务器IP>"
serverPort = 7000
auth.method = "token"
auth.token = "<与服务器一致的token>"

[[proxies]]
name = "dsh"
type = "http"
localIP = "127.0.0.1"
localPort = 8081          # 指向登录门户；不用门户时填 3080
customDomains = ["dsh.example.com"]
```

然后在 `cordis.patch.yml` 开启 `frpEnabled`、填写 `frpcBinary`/`frpcConfig`、
`extraHosts: [dsh.example.com]`，重启 dsh web。

### 3.3 登录门户（推荐）

1. 生成密码哈希（在 Mac 上执行）：

   ```bash
   node -e 'import("/Users/you/dsh-webgate/lib/portal.js").then(m => console.log(m.hashPassword("你的密码")))'
   ```

2. 在 `cordis.patch.yml` 开启：

   ```yaml
   portalEnabled: true
   portalUser: admin
   portalPasswordHash: "<上一步输出>"
   portalPort: 8081
   ```

3. 服务器 Caddy 的 dsh 站点块去掉 basic_auth（登录交给门户）：

   ```
   dsh.example.com {
       tls /etc/caddy/dsh-origin.pem /etc/caddy/dsh-origin.key   # 或让 Caddy 自动 HTTPS
       reverse_proxy 127.0.0.1:7080
   }
   ```

门户特性：表单登录页、scrypt 校验（恒定时间比较）、每 IP 10 次/分钟限速、
HttpOnly+Secure+SameSite=Lax Cookie（30 天）、会话跨重启保留
（`~/.dsh/auth-sessions.json`）。**开启门户后，DSH 的 settings/credentials 等
"仅本机"接口对登录用户可用**（门户改写 Host/Origin 充当信任边界），手机设置页可
正常使用。

### 3.4 可选：Cloudflare 橙云 + 源证书

- Cloudflare 创建 Origin Certificate（15 年）→ 传到服务器 → Caddy `tls` 指向它；
- DNS 记录改**橙云**，SSL 模式选**完全（严格）**；
- 好处：隐藏服务器真实 IP、边缘防护。

---

## 工作原理（写给想深入了解的人）

- **绑定与信任**：bundle patch 把 webserver 默认 host 改为 `0.0.0.0`（CLI 拒绝该
  值，配置层是绑定策略的合法位置）；DSH 的 `/api` 浏览器信任围栏（防 DNS
  rebinding / 跨站）通过 `lanAccessHosts` 服务获得本机 IP/主机名/额外域名列表。
  connection 行在**启动时快照**该数组，因此运行后新增的域名（如隧道公网名）由插件
  直接追加进快照（`syncSnapshotTrust`）。
- **会话引导**：GUI 的"当前会话"选择按浏览器来源存于 localStorage；插件在页面加载前
  注入脚本，为新来源自动选中最近活跃会话（仅在无选择时写入）。
- **兼容修复**：UUID v4 polyfill（非安全上下文无 `crypto.randomUUID`）、
  `Cache-Control: no-store`、设置持久化 shim（改写服务出去的 ui-settings bundle 中
  的 loopback 分支；该替换是版本敏感的，匹配失败会自动跳过）。
- **登录门户**：零依赖 Node http 反向代理 + WS 升级转发 + Cookie 会话，位于 frp 与
  DSH 之间；转发时把 Host/Origin 改写为回环地址，使 DSH 的围栏与"仅本机"接口放行。

## 安全模型

- 内网/隧道本身**无鉴权**；插件只解决"可达性 + 围栏放行"；
- 需要鉴权时开启**登录门户**（方式 3 推荐）：只有通过密码登录的设备能触达 DSH；
- DSH 原生的"仅本机"接口（settings/credentials 等）在门户后面才对远程放开，
  绕过门户直连的请求仍受 DSH 自身规则约束；
- cloudflared 快速隧道链接即权限，请当密码一样保管。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 页面能开但对话/工作区全空 | 多为旧版页面缓存：强刷/无痕打开（插件已加 no-store） |
| `crypto.randomUUID is not a function` | 插件注入的 polyfill 未生效：确认已重启 dsh web |
| 手机打不开，电脑正常 | 检查手机网络能否到目标地址；Tailscale 等未内置 |
| frpc 反复报 connect 超时 | 服务器安全组未放行 7000/TCP，或 frps 未运行 |
| 公网域名 401/弹框循环 | 服务器 Caddy 上还留着 basic_auth：改为登录门户 |
| 设置页 403 | 走门户时自动修复；直连（绕过门户）属 DSH 安全设计 |

## 文件结构

```
dsh-webgate/
├── package.json            # dsh.bundle.patch + dsh.client 双端声明
├── cordis.patch.yml        # bundle patch：webserver 覆盖 + connection 行 + lan-access 行
├── lib/
│   ├── index.js            # node 端：信任列表/隧道/门户/注入/启动打印
│   ├── portal.js           # 登录门户（零依赖，供 index.js 引用）
│   ├── client.js           # 浏览器端：设置页「手机访问」（经典 script bundle）
│   └── qr.js               # 纯 JS QR 编码器（SVG/终端）
├── deploy/
│   └── frp-server-setup.sh # 服务器端一键部署（frps + Caddy，非破坏式）
├── install.sh / uninstall.sh
├── test-qr.mjs             # QR 编码自检
└── README.md
```

## 开发说明

- 这是标准 DSH **bundle 插件**：`dsh.bundle.patch` 指向 `cordis.patch.yml`
  （补丁层），`dsh.client` 声明浏览器端入口（`exports["./client"]`）；
- 客户端 bundle 是 `window.__ModuleLoader__.load({id, factory})` 经典脚本，
  只能 require 静态种子（react、@deepseek-ai/cordis、…）或 roster 中的
  `dsh.client` 包；跨插件协作走 cordis service（本插件使用 `slots`、
  `lanAccessHosts`）；
- `install.sh` 默认符号链接：改源码后重启即生效；跑过
  `dsh plugin --profile web ...`（pnpm 管理）后需重跑 `./install.sh`；
- node 端零第三方运行时依赖（仅 node 内置模块）。

## License

MIT