# Cloudflare Tunnel 落地手册（VPS 无公网入站端口）

> 作用：把第 9 章 8.4「VPS 无公网入站端口、全部经 Cloudflare Tunnel（cloudflared ×2 HA）、SSH 走 cloudflared access」落成可点击的步骤。
> 来源：第 9 章 8.4 / 8.5 / 8.13（D3–5）；第 1 章裁定（第 10 章 9.4.5 的 `ufw allow 80,443` / `ufw limit 22` 作废）；
> `infra/cloudflare/dns-and-waf.md` §2（两条 Tunnel 的拓扑、`ws.` 主机名）；`infra/cloudflare/access-ssh.md`（Access 应用 / 策略 / 短时证书 / CI service token 的控制台步骤——本文不重复，只写 VPS 侧与 CI 侧怎么接）。
> 核实（2026-09-05）：CLI 参数与环境变量名对照 cloudflared 源码 master（`cmd/cloudflared/tunnel/subcommands.go`、`linux_service.go`）；apt 安装对照 cloudflare-docs `production` 分支 partial `cloudflared-debian-install.mdx`；镜像 tag 对照 GitHub Releases / Docker Hub API。凡标 [待核实] 的句子不要当事实引用。来源见 §7。
> 必须人工替换：`<REPLACE_ME:domain>`（根域）、`<REPLACE_ME:tunnel-id-prod>`。文中不出现真实凭据。
> 配套脚本（同目录）：bootstrap.sh、deploy.sh + deploy-entry.sh、backup.sh + cron.d/bianfa、break-glass.sh、restore.sh、notify.sh。

## 0. 裁定

| 事项 | 裁定 | 理由 |
|---|---|---|
| 入站端口 | 一个都不开，`ufw default deny incoming`（bootstrap.sh --lockdown） | Tunnel 是出站连接（7844 UDP/TCP，可选 443/TCP），VPS 不需要入站 |
| Tunnel 数量 | **两条**：`bianfa-prod`（compose 内 cloudflared ×2，api/ws）+ `bianfa-ssh`（宿主机 systemd，ssh） | Docker 或 Compose 栈挂掉时进机器的路不能也断；break-glass 就是从 bianfa-ssh 进去执行的（dns-and-waf.md §2.1） |
| SSH 方式 | **client-side cloudflared**（`ProxyCommand cloudflared access ssh`）+ Access 自托管应用 | Access for Infrastructure 要求客户端装 WARP，GitHub Actions runner 不现实；`cloudflared access ssh` 本身没被标 legacy，且支持 service token |
| SSH 用户 | `ops`（人工，NOPASSWD sudo）+ `deploy`（CI，forced command → deploy-entry.sh，sudo 只能跑 deploy.sh） | CI 密钥泄露的最坏情况是「触发一次部署」，拿不到 shell（access-ssh.md §5） |
| 短时证书 | 可选；官方页面已标 legacy（"Not recommended for new deployments"） | 不启用时人工登录 = SSH 公钥 + Access 浏览器登录，安全边界在 Access 策略 |
| cloudflared 形态（prod） | compose 内 2 副本（`deploy.replicas: 2`，同一 token） | 同一 token = 同一 tunnel 的两个 connector（官方叫 replica）。只防进程级故障，整机故障靠 restore.sh |

## 1. `bianfa-prod`：建 tunnel、拿 token、起 cloudflared ×2

1. **Zero Trust → Networking → Tunnels → Create a tunnel**（Cloudflared 类型），名 `bianfa-prod`。
2. 创建后控制台给出各平台的安装命令，Docker 那条形如 `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJ...`。**不要直接跑**，只取 token（以后在该 tunnel → Overview 里可再看到）。
3. token 写进 `/srv/bianfa/.env.prod`：`CF_TUNNEL_TOKEN=eyJ...`（root:root 0600；正式由 CI 从 GitHub Environment secret 渲染，经 `deploy-with-env` 送达）。

compose 里的 cloudflared（对第 9 章 8.5 的补强；镜像 tag 已核实 = GitHub Releases 最新 2026.8.3，2026-08-31）：

```yaml
  cloudflared:
    image: cloudflare/cloudflared:2026.8.3
    command: tunnel --no-autoupdate --metrics 0.0.0.0:2000 run
    environment:
      TUNNEL_TOKEN: ${CF_TUNNEL_TOKEN}             # 等价于 run --token（已核实 TunnelTokenFlag env）；不进 docker inspect 的 Cmd
    deploy: { replicas: 2, resources: { limits: { memory: 128M } } }
    healthcheck:                                   # 镜像无 curl；用自带 ready 子命令（已核实：按 /ready 端点返回退出码）
      test: ["CMD", "cloudflared", "tunnel", "--metrics", "127.0.0.1:2000", "ready"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    restart: unless-stopped
```

核实点：`--token` ≡ env `TUNNEL_TOKEN`，另有 `--token-file` ≡ `TUNNEL_TOKEN_FILE`；`--metrics` ≡ `TUNNEL_METRICS`；`cloudflared tunnel --metrics <addr> ready` 在有 ≥1 条活动连接时退出码 0。出站需 7844 UDP/TCP（+443/TCP），`ufw default allow outgoing` 已覆盖，hPanel 外层防火墙若限出站也要放。不需要 `extra_hosts`——SSH 不走这条 tunnel。

```bash
cd /srv/bianfa/app/infra/docker && sudo docker compose --env-file /srv/bianfa/.env.prod up -d cloudflared
sudo docker compose --env-file /srv/bianfa/.env.prod ps cloudflared     # 两个 running (healthy)；控制台 tunnel 状态 Healthy
```

tunnel 四态：Healthy / Inactive（从未连过）/ Down（进程没了）/ Degraded（有连接失败）。**Healthy 只反映 cloudflared ↔ Cloudflare，api 挂了 tunnel 照样 Healthy**，黑盒探测 `/healthz`（healthcheck-worker）不能省。

token：拿到它的人能把自己的机器加进 tunnel 分走流量，与数据库口令同级保管。轮换：tunnel → Overview → **Refresh token**（旧 token 不能建新连接，已连的 connector 继续工作）→ 改 .env.prod → `compose up -d cloudflared`（两副本同时重建，几秒中断，放维护窗口）。

## 2. Public hostname 映射（bianfa-prod）

前置：**SSL/TLS → Overview** 加密模式 **Full (strict)**（Tunnel 下不参与，但 break-glass 切 A 记录时 Origin CA 模式必须）；**Always Use HTTPS** 开。

**Networking → Tunnels → bianfa-prod → Routes → Add route → Published application**（控制台菜单名以当期为准 [待核实：2026 年控制台把 Public hostname 改名为 Routes / Published application，本文按 cloudflare-docs 当前措辞]）：

| 子域 | Service | 说明 |
|---|---|---|
| `api` | **HTTP** · `caddy:80` | 同一 compose 网络用服务名 |
| `ws` | **HTTP** · `caddy:80` | WebSocket；Caddy 按 `host ws.<domain>` 分给 sync-ws（dns-and-waf.md §2.3）。Cloudflare 默认代理 WS。`/ws/*` 路径在 `api` 主机名下也通，是 break-glass 期间客户端的退路 |

添加时自动建 `api.<REPLACE_ME:domain> CNAME <REPLACE_ME:tunnel-id-prod>.cfargotunnel.com`（Proxied），**不要手建 A 记录**。连带要求（第 1 章 S2）：非流式 HTTP 有约 100 s 源站超时（524）→ `/api/llm/*` 一律 SSE，首 chunk 100 s 内。验证：`curl -fsS https://api.<REPLACE_ME:domain>/healthz` 200；`dig +short api.<REPLACE_ME:domain> @1.1.1.1` 是 Cloudflare 边缘 IP。

## 3. `bianfa-ssh`：宿主机 systemd + Access

三层：Tunnel 送 `ssh.<domain>` 到宿主机 22；Access 应用决定「谁能到 22」；sshd 决定「以什么身份登录」（公钥或短时证书）。控制台步骤（Access 应用、两条策略、service token、短时证书 CA）全在 `infra/cloudflare/access-ssh.md` §1–3、§5，这里只写 VPS 侧与 CI 侧。

### 3.1 VPS 侧（bootstrap.sh 完成）
- `cloudflared` 由 apt 安装（已核实 cloudflare-docs partial：keyring `/usr/share/keyrings/cloudflare-main.gpg`，源 `deb [signed-by=…] https://pkg.cloudflare.com/cloudflared any main`），`cloudflared service install <token>` 注册为 `cloudflared.service`（已核实 linux_service.go：token 作为可选位置参数，写入服务配置目录；单元命令行 `cloudflared --no-autoupdate …`）。token 经 `CF_TUNNEL_TOKEN_SSH` 环境变量传给 bootstrap，**不进 .env.prod**。
- 路由：**Tunnels → bianfa-ssh → Routes → Published application**：子域 `ssh`，Service 类型 **SSH**，地址 `localhost:22`（cloudflared 在宿主机，localhost 就是宿主机）。
- sshd：`PasswordAuthentication no`、`PermitRootLogin no`、`AllowUsers ops deploy`（`/etc/ssh/sshd_config.d/00-bianfa-hardening.conf`）。
- ufw（--lockdown 后）：`default deny incoming`；唯一 allow 是 `172.20.0.0/14 → 22/tcp`（docker 网段）——**备用路径**：宿主机 cloudflared 挂了而 compose 还活着时，给 bianfa-prod 临时加一条 `ssh → host.docker.internal:22` 路由（compose 的 cloudflared 需 `extra_hosts: ["host.docker.internal:host-gateway"]`）也能进来。fail2ban `ignoreip` 含回环与该网段。
- 可选短时证书（legacy）：`CF_ACCESS_SSH_CA_PUBKEY` + `OPS_PRINCIPALS` 传给 bootstrap，它写 `/etc/ssh/ca.pub` + `TrustedUserCAKeys` + `AuthorizedPrincipalsFile /etc/ssh/principals/%u`；证书 principal = 邮箱 `@` 前部分。

### 3.2 人工登录
装 cloudflared（macOS `brew install cloudflared`；Windows `winget install Cloudflare.cloudflared`；Linux 同上 apt 源）。`~/.ssh/config`：

```
Host bianfa-prod
  HostName ssh.<REPLACE_ME:domain>
  User ops
  ProxyCommand /usr/local/bin/cloudflared access ssh --hostname %h
  IdentityFile ~/.ssh/bianfa_ops_ed25519
```

首次 `ssh bianfa-prod` 弹浏览器做 Access 登录，24h 内不再弹。启用短时证书则改用 `cloudflared access ssh-config --hostname ssh.<REPLACE_ME:domain> --short-lived-cert >> ~/.ssh/config`。

### 3.3 CI（GitHub Actions）→ deploy 用户 → deploy-entry.sh
cloudflared 从环境变量读 service token（已核实 `cmd/cloudflared/access/cmd.go`：`--service-token-id`/`TUNNEL_SERVICE_TOKEN_ID`、`--service-token-secret`/`TUNNEL_SERVICE_TOKEN_SECRET`），Access 放行后 sshd 用 `deploy` 的公钥认证，forced command 只接受 `current` / `deploy <tag>` / `deploy-with-env <tag>`（stdin = 渲染好的 .env.prod）。**日常部署只用 `current` + `deploy`**，`deploy-with-env` 留给首次部署与密钥变更。**不需要 scp**——forced command 下 scp 也走不通。

```yaml
# .github/workflows/backend.yml 片段（日常部署；镜像 tag 为 sha-<40hex>）（environment: prod；Actions 用 pin 到 commit SHA 的版本，此处只示意 run 步骤）
- name: Install cloudflared (同 VPS 镜像版本)
  run: |
    curl -fsSL -o /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-linux-amd64
    sudo install -m 0755 /tmp/cloudflared /usr/local/bin/cloudflared
- name: Render .env.prod from secrets
  run: |   # 模板在仓库 infra/ci/env.prod.tmpl（<REPLACE_ME:...> 占位由 envsubst 替换；deploy.sh 会拒绝任何残留 REPLACE_ME）
    envsubst < infra/ci/env.prod.tmpl > "$RUNNER_TEMP/env.prod"
  env:
    TAG: ${{ github.ref_name }}
    CF_TUNNEL_TOKEN: ${{ secrets.CF_TUNNEL_TOKEN }}
    POSTGRES_PASSWORD: ${{ secrets.POSTGRES_PASSWORD }}
    # …其余 secrets 同理
- name: Deploy over Access
  env:
    TUNNEL_SERVICE_TOKEN_ID: ${{ secrets.CF_ACCESS_CLIENT_ID }}
    TUNNEL_SERVICE_TOKEN_SECRET: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}
  run: |
    install -d -m 700 ~/.ssh
    printf '%s\n' "${{ secrets.VPS_DEPLOY_SSH_KEY }}" > ~/.ssh/deploy; chmod 600 ~/.ssh/deploy
    printf 'ssh.<REPLACE_ME:domain> %s\n' "${{ vars.VPS_SSH_HOST_KEY }}" > ~/.ssh/known_hosts     # VPS: cat /etc/ssh/ssh_host_ed25519_key.pub
    printf 'Host bianfa-prod\n  HostName ssh.<REPLACE_ME:domain>\n  User deploy\n  IdentityFile ~/.ssh/deploy\n  ProxyCommand cloudflared access ssh --hostname %%h\n  StrictHostKeyChecking yes\n' > ~/.ssh/config
    PREV="$(ssh bianfa-prod current)"                 # 回滚目标
    ssh bianfa-prod deploy "sha-${{ github.sha }}"      # 日常部署不重推 .env.prod
    # 首次 / 密钥变更（人工或 workflow_dispatch）：ssh bianfa-prod deploy-with-env "sha-…" < "$RUNNER_TEMP/env.prod"
```

要点：工作流只在 `push: tags` / `workflow_dispatch` 上跑，**不要**用 `pull_request_target`（fork PR 会拿到 secrets）；secrets 放 GitHub **Environment `prod`**（可加 required reviewers）。换机后 `vars.VPS_SSH_HOST_KEY` 要更新（restore.sh 结尾提示）。

## 4. 两个 connector 的 HA 验证（D3–5 验收标准，记入 RUNBOOK §10）

### 4.1 静态核对
| 位置 | 期望 |
|---|---|
| 控制台 Tunnels → bianfa-prod → **Overview** | **2 个 connector ID**，Origin IP 相同，各 4 条连接；Healthy |
| 控制台 Tunnels → bianfa-ssh | 1 个 connector；Healthy；`systemctl is-active cloudflared` = active |
| `docker compose ps cloudflared` | 2 个 `running (healthy)` |
| `docker compose exec --index 1 cloudflared cloudflared tunnel --metrics 127.0.0.1:2000 ready; echo $?`（`--index 2` 同） | `0` |
| 宿主机对容器 IP 抓 `/ready`、`/metrics` | `readyConnections: 4`，两副本 `connectorId` 不同；`cloudflared_tunnel_ha_connections` 各 4 |

```bash
cd /srv/bianfa/app/infra/docker
for c in $(sudo docker compose --env-file /srv/bianfa/.env.prod ps -q cloudflared); do
  ip=$(sudo docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$c")
  echo "== $c"; curl -s "http://$ip:2000/ready"; echo; curl -s "http://$ip:2000/metrics" | grep '^cloudflared_tunnel_ha_connections'
done
```

### 4.2 故障切换演练
终端 A（笔记本）：`while true; do printf '%s %s\n' "$(date +%T)" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://api.<REPLACE_ME:domain>/healthz)"; sleep 1; done`

终端 B（VPS）：
```bash
cd /srv/bianfa/app/infra/docker
dc() { sudo docker compose --env-file /srv/bianfa/.env.prod "$@"; }
one=$(dc ps -q cloudflared | head -n1)
sudo docker stop "$one"      # 期望终端 A 全 200（最多 1–2 次非 200）；控制台 connector 变 1 个，tunnel 仍 Healthy
sleep 60; sudo docker start "$one"     # connector 恢复 2 个；再对另一个副本重复
dc stop cloudflared          # 两个都没了：终端 A 失败，tunnel 变 Down —— 这就是 break-glass 的触发场景；此时 ssh bianfa-prod 仍应能登录（bianfa-ssh 独立）
dc start cloudflared
```
记录时间戳：它是「Tunnel 全挂多久后决定 break-glass」的基线。

### 4.3 告警（第 9 章 8.8 第 7 条：健康 connector 数 < 2）
- Cloudflare 侧：dash → Notifications → Add → Cloudflare Tunnel 类别的健康通知（Healthy/Degraded/Down 变化）→ 邮箱 + webhook。[待核实] 通知项确切名称以控制台当前列表为准。
- Grafana Cloud 侧：Alloy 抓两副本 `:2000/metrics`；`sum(cloudflared_tunnel_ha_connections) < 8` 持续 5 分钟 → Telegram；`count(up{job="cloudflared"} == 1) < 2` 同理。healthcheck-worker 的 connector 检查是第三道（RUNBOOK §6.7）。

升级镜像：改 tag → `compose up -d cloudflared` 两副本同时重建（几秒中断）；要无中断就 `docker stop/rm` 单个容器后 `compose up -d cloudflared` 补齐那一个，再对另一个重复。宿主机 cloudflared 随 apt 升级（`apt-get install --only-upgrade cloudflared`，systemd 自动重启）。

## 5. Tunnel 挂了
先分清「Tunnel 挂」（cloudflarestatus.com、控制台 Down）还是「api 容器挂」。Tunnel 挂 → `sudo /srv/bianfa/app/infra/vps/break-glass.sh`（有 Origin CA 证书时自动选 `--mode origin-ca`：改 A 记录、保持橙云；否则 `--mode acme`：先灰云），按提示改 DNS，恢复后 `--revert` 并改回 CNAME；`--status` 随时查看；**必须平时演练**（脚本文末有方法）。整机挂 → `restore.sh`（新机同一 token 加入同一 tunnel；先确认旧机死透或 Refresh token）。

## 6. 常见坑
1. Service URL 写 `localhost`：在 compose 内的 cloudflared 里 localhost 是容器自己。api/ws 用 `caddy:80`；ssh 走宿主机 cloudflared 才能写 `localhost:22`。
2. Docker **发布**端口走 nat 表绕过 ufw——「无公网端口」的真正保证是 compose 里没有 `ports:`；bootstrap 用 `daemon.json "ip": "127.0.0.1"` 把疏忽的 `ports:` 压到回环（键名已对照 moby `config_linux.go`）。`ufw enable` 会重建内建链，bootstrap 随后 `systemctl restart docker` 让 Docker 重写规则（live-restore，容器不重启）。
3. Caddyfile 单行子块非法：第 9 章 8.5 与 dns-and-waf.md §2.3 里的 `dynamic a { name api port 3000 refresh 5s }` 必须展开成多行（caddy 2.11.4 实测报 "Unexpected next token after '{' on same line"）。break-glass.sh 生成配置前会 `caddy validate`，主文件本身写错时它会一起失败。
4. 短时证书 `Certificate invalid: name is not a listed principal`：检查 `/etc/ssh/principals/ops`（`sudo sshd -T -C user=ops | grep -i principals`）。
5. CI `cloudflared access ssh` bad handshake：多半是 Access 策略缺 Service Auth 或 secret 已轮换；先用 `curl -H "CF-Access-Client-Id: …" -H "CF-Access-Client-Secret: …" https://ssh.<REPLACE_ME:domain>` 单测 Access 层。`HostName` 必须是 Access 应用域名（`%h` 取它）。
6. CI 报 `deploy-entry: 只接受 …`：forced command 生效了但命令拼错；正确形式是 `ssh bianfa-prod deploy sha-<40hex>`（或 `current` / `deploy-with-env <tag> < env.prod`），不要带 `sudo`、不要带路径。

## 7. 核实来源（2026-09-05）
- cloudflared 源码 master：`cmd/cloudflared/tunnel/subcommands.go`（`ready` 子命令、`TUNNEL_TOKEN`/`TUNNEL_TOKEN_FILE`/`TUNNEL_METRICS`）、`cmd/cloudflared/linux_service.go`（`service install [TOKEN]`）；GitHub Releases 最新 2026.8.3（2026-08-31）。
- cloudflare-docs `production`：`src/content/partials/cloudflare-one/tunnel/cloudflared-debian-install.mdx`（apt 源与 keyring）。控制台路径与 Access 步骤见 access-ssh.md 的来源列表。
- Docker Hub API：caddy 2.11.4 / 2.11.4-alpine 存在（2026-08-12 / 06-24 更新）。
- docker/docs `content/manuals/engine/install/ubuntu.md`（deb822 docker.sources）；moby `daemon/config/config.go`、`config_linux.go`（daemon.json 键名）。
- 本轮**未能**直连核实（出口代理阻断）：developers.cloudflare.com 渲染页、pkg.cloudflare.com、docs.docker.com 渲染页——均改用其 GitHub 源仓库核实。Hostinger 浏览器 Terminal 的菜单路径 [待核实]。
