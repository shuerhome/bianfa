<!--
  文件作用：这个域在 Cloudflare 上需要的全部 DNS 记录、哪些主机名走 Tunnel、WAF/限流/安全开关怎么设，
            以及 Cloudflare 反代源站读超时对 SSE 的含义与 Caddy/api 侧必须做的事。
  来源章节：第 1 章 S2 第 7 步（首 chunk < 100 s）、第 8 章 7.9（SSE 三件套 + 15 s 心跳）、第 9 章 8.4（Tunnel 拓扑 / break-glass）、
            8.5（Caddy `dynamic a`）、8.8（黑盒探测）、第 10 章 9.4（Cloudflare 前置 L7 兜底）、第 17 章 #34/#35（docs/status 站）。
  必须人工替换：<REPLACE_ME:domain> 根域 · <REPLACE_ME:tunnel-id-prod> / <REPLACE_ME:tunnel-id-ssh> 两个 Tunnel 的 UUID ·
            <REPLACE_ME:vps-ip> VPS 公网 IP（只在 break-glass 用）· <REPLACE_ME:pages-project> Cloudflare Pages 项目名 ·
            <REPLACE_ME:mail-provider-spf> 发信商的 SPF include · <REPLACE_ME:dmarc-mailbox> DMARC 报告邮箱
  核实日期：2026-09-05（cloudflare-docs production 分支；caddyserver/website 文档 + caddy 2.11.4 二进制 `caddy validate` 实测；cloudflared 源码；Docker Hub tags API）。
  凡标 [待核实] 的句子不要当事实引用。
-->

# DNS、Tunnel 与 WAF

## 1. DNS 记录表

| 名称 | 类型 | 目标 | 代理 | 谁创建 | 用途 |
|---|---|---|---|---|---|
| `api` | CNAME | `<REPLACE_ME:tunnel-id-prod>.cfargotunnel.com` | 橙云（必须） | Zero Trust 控制台加「Published application」路由时**自动创建** | REST + LLM SSE → Caddy → api ×2 |
| `ws` | CNAME | `<REPLACE_ME:tunnel-id-prod>.cfargotunnel.com` | 橙云（必须） | 同上，自动 | WebSocket → Caddy → sync-ws（Hocuspocus 4.6.0，C2） |
| `ssh` | CNAME | `<REPLACE_ME:tunnel-id-ssh>.cfargotunnel.com` | 橙云（必须） | 同上，自动 | Cloudflare Access 保护的 SSH（见 access-ssh.md） |
| `update` | Worker 自定义域 | （wrangler `custom_domain = true`） | 橙云 | `npx wrangler deploy` 自动 | latest.json 灰度 Worker |
| `cdn` | R2 自定义域 | （`wrangler r2 bucket domain add`） | 橙云 | wrangler 自动 | 安装包公开下载 |
| `@`（根域） | CNAME（Cloudflare 会自动扁平化） | `<REPLACE_ME:pages-project>.pages.dev` | 橙云 | 手工 / Pages 控制台 | 官网（静态站放 Pages，与 VPS 不同故障域）[待定：官网托管方式由产品侧拍板] |
| `www` | CNAME | `<REPLACE_ME:domain>` | 橙云 | 手工 | 用 Redirect Rule 301 到根域 |
| `docs` | CNAME | `<REPLACE_ME:pages-project>-docs.pages.dev` | 橙云 | Pages 控制台 | 帮助文档（第 17 章 #34） |
| `status` | CNAME | 状态页服务商给的目标 | 视服务商 | 手工 | 状态页必须与 VPS 异地（第 17 章 #35） |
| `@` | TXT | `v=spf1 include:<REPLACE_ME:mail-provider-spf> -all` | — | 手工 | 事务邮件（邀请/验证码）发信方的 SPF；**还没选发信商前先放 `v=spf1 -all`** 防冒名 |
| `_dmarc` | TXT | `v=DMARC1; p=quarantine; rua=mailto:<REPLACE_ME:dmarc-mailbox>` | — | 手工 | 稳定后改 `p=reject` |
| `<selector>._domainkey` | CNAME/TXT | 发信商提供 | — | 手工 | DKIM |

规则：

- **Tunnel 主机名必须是橙云**：灰云的 CNAME 指向 `cfargotunnel.com` 不会转发流量（CNAME 目标格式 `<UUID>.cfargotunnel.com`，多个主机名可指同一个 Tunnel）。
- **不要有任何 A/AAAA 记录指向 VPS**。公网 IP 只在 break-glass（§5）时临时出现；平时连 DNS 历史里都不该有它（换 VPS 时 Tunnel 指向新机器即可，不改 DNS，第 9 章 8.7）。
- 第 10 章 9.2 的 CSP 写的是 `wss://sync.bianfa.app`，本表按任务口径用 `ws.`；两处必须统一，否则 WebView 里 WebSocket 会被 CSP 拦掉。
- 开 DNSSEC（Cloudflare 一键）；CAA 记录暂不加：Cloudflare Universal SSL 会轮换签发 CA，配错 CAA 会让证书签发失败 [待核实：当前 Universal SSL 使用的 CA 列表]。

## 2. Tunnel 拓扑

### 2.1 两条 Tunnel，不是一条

| Tunnel | 跑在哪 | 副本 | 公开主机名 → 服务 | 为什么分开 |
|---|---|---|---|---|
| `bianfa-prod` | Docker Compose 里的 `cloudflared` 服务（`cloudflare/cloudflared:2026.8.3`，Docker Hub 2026-08-31 发布，本轮再次核实为最新 tag） | **2**（`deploy.replicas: 2`，同一个 token） | `api.<REPLACE_ME:domain>` → `http://caddy:80`；`ws.<REPLACE_ME:domain>` → `http://caddy:80` | 业务流量 |
| `bianfa-ssh` | **宿主机 systemd**（`cloudflared service install <token>`），不在 Docker 里 | 1 | `ssh.<REPLACE_ME:domain>` → `ssh://localhost:22` | Docker 或 Compose 栏挂掉时你还进得去；break-glass 脚本就是从这条路进去执行的 |

已核实的 Tunnel 事实（deploy-replicas 页）：每个 `cloudflared` 副本向 Cloudflare 建 **4 条出向连接**到至少两个数据中心；同一 Tunnel 最多 **25 个副本 / 100 条连接**；请求发给**地理上最近**的副本，失败再试其它副本，**没有轮询/哈希分发**（两副本都在同一台 VPS 上，这无所谓——我们要的是滚动重启不断线，不是负载分担）。第 9 章 8.8 第 7 条告警「健康 connector < 2」由 `healthcheck-worker` 的可选检查实现（读 `GET /accounts/{id}/cfd_tunnel/{tunnel}/connections`；Cloudflare 2026-07-09 changelog：2026-10-05 起 tunnel 对象里的 `connections` 字段下线，只能用这个专用端点）。

### 2.2 VPS 防火墙（以 Tunnel 架构为准，推翻第 10 章 9.4.5 的 `ufw allow 80,443` / `ufw limit 22`）

```sh
ufw default deny incoming
ufw default allow outgoing
ufw enable
# 没有任何 allow 入站规则。也不要 `limit 22`：22 只在 127.0.0.1 上被 cloudflared 访问。
```

cloudflared 需要的**出向**：`7844/tcp` 与 `7844/udp`（http2 / quic 协议，必需），以及 `443/tcp`（可选功能：更新检查、Access JWT 校验，缺了只是日志报错）—— 已核实 tunnel-with-firewall.mdx。`default allow outgoing` 已覆盖。

**Docker 会绕过 ufw**：任何 `ports:` 发布都会直接在 nat 表开洞，不经 ufw 的 INPUT 链。所以 compose 主文件里**一个 `ports:` 都不能有**（cloudflared 走出向，Caddy 只被 cloudflared 在 compose 网络内访问）；break-glass.sh 加 443 映射时才连带 `ufw allow 443/tcp`（见 infra/vps/break-glass.sh 文件头的解释）。

### 2.3 Caddy 侧分流（权威文件：`infra/docker/Caddyfile`）

Caddyfile **只维护一份**，在 `infra/docker/Caddyfile`；本节不再重复贴一份以免漂移。两个实测结论已落进那份文件：

1. 初稿的单行写法 `dynamic a { name api port 3000 refresh 5s }` **是解析错误**（Caddy 2.11.4 `caddy validate`：`Unexpected next token after '{' on same line`）；`{` 必须是一行最后一个 token，子块换行写。
2. reverse_proxy 文档明文 **"active health checks do not run for dynamic upstreams"**，`health_uri` 是死代码；改用被动 `fail_duration` + `lb_try_duration`。

路由约定：`/ws/*` → `sync-ws:4000`（WebSocket），`/api/llm/*` → `api:3000` 且 `flush_interval -1`（SSE 不缓冲），其余 → `api:3000`。**`ws.<domain>` 主机名不在 Caddy 里区分**——Tunnel 把 `ws.<domain>` 与 `api.<domain>` 都指到 `caddy:80`，客户端用 `wss://ws.<domain>/ws/…` 路径即可命中；break-glass 时退到 `wss://api.<domain>/ws/…` 同样成立。这样 Caddyfile 里没有任何 `<REPLACE_ME>`，break-glass.sh 的 sed 复用也不受影响。

- break-glass.sh 只把第一处 `:80 {` 改写成 `https://api.<domain> {`，所以站点块**必须**保持以 `:80 {` 开头，全局选项块（如果以后要加）放在它前面。
- Caddy 对 `reverse_proxy` 的 WebSocket 升级是自动的，不需要额外配置。
- Tunnel 公开主机名的「HTTP Host Header」留空即可（cloudflared 原样转发 `Host`，Caddy 靠它分流）。cloudflared → 源站默认 HTTP/1.1、`connectTimeout` 30 s、`keepAliveTimeout` 90 s、`tcpKeepAlive` 30 s（origin-parameters 字段存在；默认值除 tcpKeepAlive=30s、keepAliveConnections=100 外未逐一核实）。

## 3. WAF 与安全开关

### 3.1 先关掉会误伤桌面客户端的东西

桌面端的 REST/SSE 由 Rust `reqwest` 发起（第 8 章 7.9），WebSocket 由 Rust 发起，updater 由 `tauri-plugin-updater` 发起 —— **都不是浏览器，任何 Challenge 都解不了**。

| 设置 | 值 | 理由（已核实） |
|---|---|---|
| Bot Fight Mode（Free） | **关** | bot-fight-mode.mdx 原文："You cannot bypass or skip Bot Fight Mode using WAF custom rules or Page Rules"，它在独立的评估管线里，Skip/Bypass/Allow 都无效；要给自己的 API 客户端例外只能升 Pro 用 Super Bot Fight Mode 的 Skip 规则 |
| Browser Integrity Check | 对 `api` / `ws` / `update` **关**（用 Configuration Rule 按主机名关；或全局关） | 它按「可疑 HTTP 头」拦请求，非浏览器 UA 首当其冲；文档给的关法就是 Configuration Rule 按 hostname/path 表达式 |
| Security Level | 默认 Medium，**永远不要对 api 主机名开 I'm Under Attack** | 会对所有请求发 JS challenge |
| WAF 规则的 action | api/ws/update 只用 **Block**（Log 是 Enterprise 专属），不用任何 Challenge | 同上 |
| SSL/TLS 加密模式 | Full (strict) | Tunnel 场景下 edge→cloudflared 是 Cloudflare 内部链路，这个设置只在 break-glass 直连时生效——所以 Caddy 里**预装一张 Cloudflare Origin CA 证书**（15 年）备用，break-glass 时才不用现签 |
| Always Use HTTPS / 最低 TLS 1.2 | 开 / 1.2 | — |
| HSTS | 观察两周后开 | — |

### 3.2 Custom rules（Free 计划 **5 条**；动作 "All except Log"，均已核实 waf/custom-rules/index.mdx）

```txt
# R1（先别开）/api/llm/* 只放 SSE 客户端（第 1 章 S2 第 7 步：这条路径一律 SSE）
#   前提：桌面端 reqwest 调 LLM 接口时显式带 `Accept: text/event-stream`。Free 没有 Log 动作没法先观察，
#   所以必须在集成测试里断言这个头存在之后再启用，否则一开就是全量 AI 功能不可用。
(http.host eq "api.<REPLACE_ME:domain>"
  and starts_with(http.request.uri.path, "/api/llm/")
  and not any(http.request.headers["accept"][*] contains "text/event-stream"))
→ Block

# R2  扫描器噪音直接在边缘挡掉，不消耗 Tunnel/Caddy/api
(http.host in {"api.<REPLACE_ME:domain>" "ws.<REPLACE_ME:domain>"}
  and (http.request.uri.path contains "/wp-"
       or http.request.uri.path contains ".php"
       or http.request.uri.path contains "/.env"
       or http.request.uri.path contains "/.git"))
→ Block

# R3（可选，先观察再开）ws 主机名只接 WebSocket 握手
#   注意：HTTP/2 上的 WebSocket（RFC 8441）没有 Upgrade 头；桌面端 tokio-tungstenite 与浏览器目前都走 HTTP/1.1 Upgrade，
#   但这条规则误伤面不为零，Pro 计划可先用 Log 观察 [待核实：Cloudflare 边缘是否会把 h2 WebSocket 降为 h1 到源站]
(http.host eq "ws.<REPLACE_ME:domain>"
  and not any(lower(http.request.headers["upgrade"][*])[*] eq "websocket"))
→ Block
```

`any()`、`starts_with()`、`lower()`、`http.request.headers["<name>"][*]` 均在 rules-language functions 页（header 名小写）；`lower()` 只收 String，对数组要写成 `lower(field[*])[*]`（文档："Transformation functions that do not take arrays as an argument type require the `[*]` index notation"）—— R3 的写法就是这个形式。路径前缀 `/api/llm/` 与 `/auth/` 必须与 API 真实路由一致（第 1 章 S1 用的是 `/v1/…` 前缀，两处口径需统一）。

### 3.3 Rate limiting（Free：**1 条**、只能按 IP 计数、周期 **10 s**、封禁 **10 s**，已核实 partials/waf/rate-limiting-availability-by-plan）

```txt
表达式：(http.host eq "api.<REPLACE_ME:domain>" and starts_with(http.request.uri.path, "/auth/"))
特征：IP · 周期 10 s · 阈值 20 次 · 动作 Block · 持续 10 s
```

这是 L7 兜底，不是主防线：登录 5 次/15 分钟/账号、IP 60/min 等真正的限流在 api 的 Redis 滑动窗口里（第 10 章 9.4；Redis 只做限流计数与 Hocuspocus 广播，C8）。升到 Pro 后有 2 条规则、周期可到 1 分钟，再加一条 `/api/llm/*` 每 IP 30 次/分钟。

### 3.4 Cache Rules

- `cdn.<REPLACE_ME:domain>`：Cloudflare 默认按扩展名缓存（EXE/DMG/GZ/ZIP 在列，`.json` 明确不缓存、`.sig` 不在列；Free 单文件 512 MB 上限，已核实）。需要的话加一条「`hostname eq "cdn.<REPLACE_ME:domain>"` → Eligible for cache，Edge TTL 尊重源站」。
- `api` / `ws` / `update`：**不建任何缓存规则**。Worker 与 api 都发 `Cache-Control: no-store`。
- Free 计划请求体上限 100 MB：附件不经 api，直传 R2 的 S3 端点，不受此限。

## 4. 源站读超时（「100 秒」）与 SSE

### 4.1 已核实的数字（fundamentals/reference/connection-limits.mdx，2026-09-05 审查轮再次核实）

| 项 | 值 | 触发的状态码 | 可改？ |
|---|---|---|---|
| **Proxy Read Timeout**（等源站响应） | **125 s** | 524 | 仅 Enterprise（最高 6,000 s） |
| Proxy Write Timeout | 30 s | 524 | 否 |
| Proxy Idle Timeout（keep-alive 连接空闲） | 900 s | 520 | 否 |
| TCP Keep-Alive 间隔 | 30 s | 520 | 否 |
| 完成 TCP 握手 | 19 s | 522 | 否 |

**第 1 章、第 9 章、README 里的「100 秒」已过时**：当前文档写的是 125 秒。工程预算**仍按 100 秒**留余量，结论不变。

524 描述的是「源站在超时前没有给出 HTTP 响应」；对已经开始流式输出的响应，读超时是否重新计时官方页面没有明说。**按保守解释设计**：源站任意两个字节之间的静默都不得接近 125 s。第 8 章的 15 秒心跳同时满足两种解释。

### 4.2 api 侧必须做的（第 8 章 7.9 三件套的完整版）

1. 收到请求后**立刻**写响应头并 flush 一帧注释：`: connected\n\n` —— 不等第一个 LLM token。第 1 章 S2 的 8 步校验链里前 6 步（鉴权、authorize、aiGate、creditGuard…）都要在这之前完成，所以它们的总耗时必须远小于 125 s；有一步要查外部（如 Stripe）就先发 `: connected` 再查。
2. 响应头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no`（对 Caddy/Cloudflare 无效，但无害，防以后前面再加 nginx）；不要 `Content-Length`。
3. **每 15 s 一帧 `: ping\n\n`**（注释帧，客户端 SSE 解析器忽略）。上游 LLM 首 token 慢（推理型模型可到几十秒）是常态，没有这一条第一批用户就会看到 524。
4. 客户端断开时取消上游请求并写 ledger（S2 第 8 步「取消也要记已产生 output」）。
5. 任何**非 SSE** 的长请求（导出、批量操作）都改成「入队 pg-boss + 轮询/推送」（C8：队列是 pg-boss，不是 BullMQ）——这正是 524 页给的官方建议（"Implement status polling of large HTTP processes"）。

### 4.3 中间层不能把流攒成一坨

| 层 | 事实 | 结论 |
|---|---|---|
| Cloudflare 边缘压缩 | 默认压缩的 Content-Type 列表**不含** `text/event-stream` | 边缘不会因压缩而缓冲 SSE；`no-transform` 再保一层 |
| Caddy `reverse_proxy` | `flush_interval` 在 Content-Type 为 `text/event-stream`、Content-Length 未知时自动 -1（已核实 reverse_proxy 文档） | 已满足；Caddyfile 里仍显式写 `flush_interval -1` |
| Caddy `encode` | 默认响应匹配器包含 `header Content-Type text/*`，会命中 SSE | 能流但每帧多一次压缩 flush；干净的做法是 §2.3 那样把 `encode` 只放在 REST 的 handle 里 |
| cloudflared → 源站 | 默认 HTTP/1.1，`disableChunkedEncoding` 默认关 | 分块传输正常穿过 |
| WebSocket | 「WebSockets are supported on all Cloudflare plans」；空闲连接会被 Cloudflare 关闭，具体时长未公开；官方建议客户端 ping/pong | Hocuspocus 自带 ping/pong（默认 30 s），保持开启即可 |

## 5. Break-glass（Tunnel 或 Cloudflare Zero Trust 故障时 5 分钟内恢复）

脚本在 `infra/vps/break-glass.sh`（VPS 侧负责；本节只写 Cloudflare 侧要配合的动作）。前提：脚本按它文末的方法演练过、Origin CA 证书已提前签好放在 `/srv/bianfa/secrets/origin-ca.pem` / `origin-ca.key`（Cloudflare → SSL/TLS → Origin Server，最长 15 年）、你有这个 zone 的 DNS 编辑权限（放密码管理器，**不放 VPS**）。

1. 进 VPS：优先 `ssh ssh.<REPLACE_ME:domain>`（bianfa-ssh Tunnel 是宿主机 systemd，不随 Docker 栏一起挂）；连 Zero Trust 都挂了就用 Hostinger 控制台的浏览器 KVM（最后逃生口）。
2. `sudo /srv/bianfa/app/infra/vps/break-glass.sh`。脚本自己做：`ufw allow 443/tcp`、compose override 给 caddy 加 `0.0.0.0:443:443`、把主 Caddyfile 的 `:80` 站点变换成 `https://api.<REPLACE_ME:domain>`、轮询 `/healthz`。**它不改 DNS**——改 DNS 是最不可逆的一步，要有人看着。（脚本当前版本用 Caddy 自动 ACME；Origin CA 模式是本文件对脚本提出的增强需求，见 VPS 侧 notes。）
3. DNS（Cloudflare 控制台）：把 `api` 从 CNAME 改成 **A `<REPLACE_ME:vps-ip>`**。
   - Origin CA 证书模式：Proxy status 保持 **Proxied（橙云）**。Origin CA 证书只被 Cloudflare 边缘信任，所以必须橙云；zone 的 SSL/TLS 模式必须已是 Full (strict)（§3.1）。WAF、限流、DDoS 在这条路径上全部继续生效。
   - ACME 模式（脚本当前默认）：先把 A 记录设为 **DNS only（灰云）**让 Let's Encrypt 用 TLS-ALPN-01 直连 443 验证，脚本轮询通过后再改回橙云。灰云期间 WAF 不生效、源站 IP 暴露，所以 Origin CA 模式是首选。
   - 脚本目前只切 `api.<REPLACE_ME:domain>`。`ws.` 主机名在 break-glass 期间不可用；客户端的 WebSocket 地址应有退路 `wss://api.<REPLACE_ME:domain>/ws/…`（§2.3 的 `/ws/*` handle 就是为此保留的），或给 break-glass.sh 增加第二个主机名。
4. 恢复：`sudo /srv/bianfa/app/infra/vps/break-glass.sh --revert`，然后把 `api` 改回 CNAME → `<REPLACE_ME:tunnel-id-prod>.cfargotunnel.com`（最省事：Zero Trust → Tunnels → 该 tunnel → Routes 删掉再加一次这条 Published application，Cloudflare 会自动重建 CNAME）。
5. 演练节奏跟脚本走：每季度 `--drill`（不改 DNS），每半年一次带真实 DNS 切换（可加 `--staging`），把「执行到 healthz 200」的秒数写进 RUNBOOK，目标 ≤ 5 分钟。

## 6. 核对清单

- [ ] zone 里没有任何指向 VPS 的 A/AAAA；`api` `ws` `ssh` 三个 CNAME 都是橙云
- [ ] `update` 与 `cdn` 由 wrangler 自动创建，浏览器打开 `https://update.<REPLACE_ME:domain>/healthz` 返回 `ok`
- [ ] Bot Fight Mode 关；BIC 对 api/ws/update 关；api 主机名上没有任何 Challenge 动作
- [ ] R2 custom rule + 1 条 `/auth/*` 限流已启用；R1 只在集成测试断言 `Accept: text/event-stream` 之后启用；路径前缀与 API 路由一致
- [ ] `curl -N -H 'Accept: text/event-stream' https://api.<REPLACE_ME:domain>/api/llm/<ping-endpoint>` 能在 1 s 内看到 `: connected`，之后每 15 s 一个 `: ping`
- [ ] Caddyfile 用 `caddy validate --adapter caddyfile` 过一遍；`encode` 不作用于 SSE handle；`flush_interval -1` 在位；没有 `health_uri`（对 dynamic upstream 无效）
- [ ] `infra/vps/break-glass.sh --drill` 演练过并计时；Origin CA 证书在 `/srv/bianfa/secrets/`，DNS 编辑 token 在密码管理器里
- [ ] ufw：`default deny incoming`，无 allow 规则；compose 主文件无 `ports:`；cloudflared 日志显示 4×2 条连接已注册
