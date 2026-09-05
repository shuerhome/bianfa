<!--
  文件作用：用 Cloudflare Tunnel + Cloudflare Access 保护 VPS 的 SSH：Access 应用、只放行你邮箱的策略、短时 SSH 证书，
            以及 GitHub Actions 部署时如何通过 Access（service token）。VPS 的 22 端口对公网完全关闭。
  来源章节：第 9 章 8.4（「SSH 走 cloudflared access + Cloudflare Access 短时证书」、Tunnel 是新增单点）、8.5（deploy.sh 由 CI 经 Access 执行）、
            8.13（D3–5：建 tunnel、ufw deny、Access SSH、break-glass 演练）、第 10 章 9.4.5（管理面不暴露公网）。
  必须人工替换：<REPLACE_ME:domain> 根域 · <REPLACE_ME:admin-email> 你的登录邮箱 · <REPLACE_ME:team-name> Zero Trust 团队名 ·
            <REPLACE_ME:tunnel-token-ssh> bianfa-ssh Tunnel 的 token（只在安装那一刻用，不落盘）
  核实日期：2026-09-05（cloudflare-docs production 分支：cloudflare-one/…/use-cases/ssh/*、access-controls/…/short-lived-certificates-legacy.mdx、
            policies/index.mdx、service-credentials/service-tokens.mdx；cloudflared 源码 cmd/cloudflared/access/cmd.go）。
  凡标 [待核实] 的句子不要当事实引用。
-->

# Cloudflare Access 保护 SSH

## 0. 方案选择（先说清楚一个变化）

Cloudflare 现在给 SSH 四种做法（已核实 use-cases/ssh/index.mdx）。我们选 **「SSH with client-side cloudflared」+ 短时证书**：

| | 选用：client-side cloudflared + 短时证书 | 备选：Access for Infrastructure |
|---|---|---|
| 客户端需要 | `cloudflared` 二进制 | Cloudflare One Client（WARP）+ Gateway |
| CI runner 能用吗 | **能**（`cloudflared access ssh` 是纯 CLI，支持 service token） | 不能（要装 WARP 客户端并注册设备） |
| 文档状态 | 短时证书页面已改名为 **"Short-lived certificates (legacy)"**，标注 "Not recommended for new deployments"（已核实） | 官方推荐的新路径，含命令级审计日志 |
| 我们的判断 | 1–3 人团队 + GitHub Actions 部署，这是唯一两端都能跑的方案；`cloudflared access ssh` 本身没有被标 legacy | 以后需要「谁在服务器上敲了什么」的审计时再迁；迁移不影响 Tunnel 与 Access 应用 |

风险登记：legacy 标签意味着短时证书功能可能有日落时间表（本轮未见公告，[待核实]）。即使它下线，退化路径也很短：去掉证书相关的 `Match`/`IdentityFile` 三行，用普通 SSH 公钥 + Access 身份验证（§4.1 的基础配置）。

## 1. 服务器端：`bianfa-ssh` Tunnel（宿主机 systemd，不进 Docker）

理由见 dns-and-waf.md §2.1：Docker 栏或 Compose 出问题时，进机器的路不能也断。

1. Zero Trust 控制台 → **Networks → Tunnels → Create a tunnel**（Cloudflared 类型）→ 名 `bianfa-ssh`。
2. 在 VPS 上按控制台给的 Debian 命令安装 `cloudflared` 并注册为服务：
   ```sh
   sudo cloudflared service install <REPLACE_ME:tunnel-token-ssh>
   sudo systemctl status cloudflared
   ```
3. **Routes → Add route → Published application**：域选 `<REPLACE_ME:domain>`，子域 `ssh`；**Service 类型 SSH，地址 `localhost:22`**（已核实 ssh/tunnel-public-hostname 部分）。保存后 Cloudflare 自动创建橙云 CNAME `ssh → <UUID>.cfargotunnel.com`。
4. `sshd` 保持监听 `0.0.0.0:22`（不改成 127.0.0.1：给 KVM 紧急 `ufw allow from <你的IP> to any port 22` 留余地），由 `ufw default deny incoming` 保证公网不可达。验证：从外网 `nc -vz <REPLACE_ME:vps-ip> 22` 必须超时。

`/etc/ssh/sshd_config.d/10-bianfa.conf`（放 `.d` 目录并确认主文件的 `Include` 在最上面；官方提醒：如果 `Include` 在这些指令之后，被包含文件里的配置不会生效）：

```txt
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
TrustedUserCAKeys /etc/ssh/ca.pub          # §3 生成的 Cloudflare CA 公钥
AuthorizedPrincipalsFile /etc/ssh/principals/%u
AllowUsers deploy <REPLACE_ME:admin-unix-user>
```

## 2. Access 应用与策略

1. Zero Trust → **Access controls → Applications → Add an application → Self-hosted**。
   - Application name：`bianfa-ssh`
   - Application domain：`ssh.<REPLACE_ME:domain>`（无路径）
   - Session duration：`24 hours`（这是 Access 会话；短时证书本身另有更短的有效期 [待核实：证书有效期数值]）
2. **Policy 1 — `admin`**（人类，唯一）
   - Action：**Allow**
   - Include：**Emails** = `<REPLACE_ME:admin-email>`
   - （可选）Require：**Login Methods** = 你启用的 IdP；或 Country = 你常驻的国家
   - **不要**用 "Emails ending in @gmail.com" 这类宽匹配——那等于放行全世界的 Gmail。
3. **Policy 2 — `ci-deploy`**（机器，给 GitHub Actions）
   - Action：**Service Auth**（已核实：Service Auth 用于 service token / mTLS 这类不经 IdP 的认证；用 Allow 会弹 IdP 登录）
   - Include：**Service Token** = `bianfa-ci-deploy`（§5 创建）
4. 身份提供方：Zero Trust → Settings → Authentication。单人团队用默认的 **One-time PIN**（邮箱验证码）就够；想要硬件密钥再加 GitHub/Google IdP 并在 Policy 1 里 Require 它。
5. Access 是**默认拒绝**：不匹配任何 Allow/Service Auth 的请求一律拒（已核实 policies/index.mdx）。

## 3. 短时证书（免密登录 + 不再有长期私钥在笔记本里）

1. Zero Trust → **Access controls → Service credentials → SSH → Add a certificate**，Application 选 `bianfa-ssh` → **Generate certificate**，复制 **CA public key**（已核实路径与步骤）。
2. VPS：
   ```sh
   sudo install -m 600 /dev/stdin /etc/ssh/ca.pub <<'PUB'
   ecdsa-sha2-nistp256 <粘贴控制台给的整行公钥> open-ssh-ca@cloudflareaccess.org
   PUB
   sudo mkdir -p /etc/ssh/principals
   # Cloudflare 把证书 principal 固定为「邮箱 @ 前面的部分」（已核实）。
   # 邮箱是 alice@example.com → principal 是 alice。下面让 alice 可以登录为 unix 用户 <REPLACE_ME:admin-unix-user>：
   echo '<REPLACE_ME:admin-email-prefix>' | sudo tee /etc/ssh/principals/<REPLACE_ME:admin-unix-user>
   sudo sshd -t && sudo systemctl reload ssh
   ```
   如果 unix 用户名就等于邮箱前缀，可以不配 `AuthorizedPrincipalsFile`（官方「最简单的设置」）；但 Gmail 前缀往往不是你想要的 unix 用户名，所以这里统一用 principals 文件映射。官方文档给的等价写法是 `Match user … AuthorizedPrincipalsCommand /bin/echo '<prefix>'`，二选一。
3. 笔记本端，让 `cloudflared` 打印配置（已核实命令与模板）：
   ```sh
   cloudflared access ssh-config --hostname ssh.<REPLACE_ME:domain> --short-lived-cert
   ```
   写进 `~/.ssh/config`：
   ```txt
   Match host ssh.<REPLACE_ME:domain> exec "/usr/local/bin/cloudflared access ssh-gen --hostname %h"
     HostName ssh.<REPLACE_ME:domain>
     ProxyCommand /usr/local/bin/cloudflared access ssh --hostname %h
     IdentityFile ~/.cloudflared/ssh.<REPLACE_ME:domain>-cf_key
     CertificateFile ~/.cloudflared/ssh.<REPLACE_ME:domain>-cf_key-cert.pub
   ```
   `cloudflared` 路径按系统调整（macOS Homebrew：`$(brew --prefix cloudflared)/bin/cloudflared`）。
4. 登录：`ssh <REPLACE_ME:admin-unix-user>@ssh.<REPLACE_ME:domain>`。首次会弹浏览器走 Access 登录；之后 `ssh-gen` 自动向 Access 换一张短时证书，`cloudflared access ssh` 在 Tunnel 里把流量送到 VPS 的 22。

## 4. 备用与排错

### 4.1 不用短时证书的基础形态（证书功能下线时的退化路径）

```txt
Host ssh.<REPLACE_ME:domain>
  ProxyCommand /usr/local/bin/cloudflared access ssh --hostname %h
  IdentityFile ~/.ssh/id_ed25519_bianfa
```
服务器 `authorized_keys` 放公钥；Access 仍然挡在前面（没有 Access 会话根本到不了 sshd）。

### 4.2 排错顺序

1. `cloudflared access login https://ssh.<REPLACE_ME:domain>` 能否拿到 JWT → 不能就是 Access 策略/IdP 问题（Zero Trust → Logs → Access）。
2. `cloudflared tunnel info bianfa-ssh` 或控制台看 connector 是否在线 → 不在线就是 VPS 上的 systemd 服务。
3. VPS `journalctl -u ssh -f`，看 principal 是否匹配（`AuthorizedPrincipalsFile` 内容、CA 是否被信任）。

### 4.3 最后逃生口

Zero Trust 整体故障或把自己锁在外面：Hostinger 控制台的浏览器 KVM（本地控制台，不经网络鉴权）。这是全项目唯一不依赖 Cloudflare 的入口，密码放密码管理器并开 2FA。

## 5. GitHub Actions 部署（调用 `infra/vps/deploy.sh`）

CI 对 VPS 的全部动作经 `deploy` 用户的 forced command `infra/vps/deploy-entry.sh`：`ssh bianfa-prod current`（读线上 tag）、`ssh bianfa-prod deploy sha-<40hex>`（部署/回滚）、`ssh bianfa-prod deploy-with-env <tag> < env.prod`（仅首次与密钥变更）。短时证书需要「人」的身份，service token 拿不到证书；CI 因此用 **service token 过 Access + 专用部署密钥过 sshd**，并把这把密钥能做的事锁死在部署脚本上。

1. Zero Trust → **Access controls → Service credentials → Service tokens → Create**：名 `bianfa-ci-deploy`，Duration 1 年（到期前可配「一周前提醒」告警，已核实）。记下 Client ID / Client Secret，存 GitHub **Environment `prod`** secrets：`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`。§2 的 Policy 2 已引用它。
2. VPS 上建 `deploy` 用户，生成专用密钥对，私钥存 Environment `prod` 的 secret `VPS_DEPLOY_SSH_KEY`；公钥写进 `deploy` 的 `authorized_keys`，**用 forced command 锁死**：
   ```txt
   command="/srv/bianfa/app/infra/vps/deploy-entry.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA… bianfa-ci
   ```
   `deploy-entry.sh`（已在 `infra/vps/`）：只接受 `SSH_ORIGINAL_COMMAND` 为 `current`、`deploy <tag>`、`deploy-with-env <tag>`（`<tag>` 匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，服务端约定用 `sha-<40hex>`），后两者执行 `sudo /srv/bianfa/app/infra/vps/deploy.sh`；其它一律 `exit 64`。sudoers 只放这一条：
   ```txt
   deploy ALL=(root) NOPASSWD: /srv/bianfa/app/infra/vps/deploy.sh
   ```
3. 工作流片段：
   ```yaml
   - name: Install cloudflared
     run: |
       # pin 版本并可选 sha256 校验，见 backend.yml（不要用 latest）
       curl -fsSL -o cloudflared https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-linux-amd64
       chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/
   - name: Deploy over Access
     env:
       TUNNEL_SERVICE_TOKEN_ID: ${{ secrets.CF_ACCESS_CLIENT_ID }}        # cloudflared access ssh 读取的环境变量名（已核实源码）
       TUNNEL_SERVICE_TOKEN_SECRET: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}
     run: |
       mkdir -p ~/.ssh && install -m 600 /dev/stdin ~/.ssh/deploy <<< "${{ secrets.VPS_DEPLOY_SSH_KEY }}"
       printf '%s %s
' "ssh.<REPLACE_ME:domain>" "${{ vars.VPS_SSH_HOST_KEY }}" > ~/.ssh/known_hosts   # 指纹来自 VPS `cat /etc/ssh/ssh_host_ed25519_key.pub`
       cat >> ~/.ssh/config <<'CFG'
       Host bianfa-prod
         HostName ssh.<REPLACE_ME:domain>
         User deploy
         IdentityFile ~/.ssh/deploy
         ProxyCommand cloudflared access ssh --hostname %h
         StrictHostKeyChecking yes
         UserKnownHostsFile ~/.ssh/known_hosts
       CFG
       ssh bianfa-prod current                                # 记回滚目标
       ssh bianfa-prod deploy "sha-${{ github.sha }}"          # forced command 只认 current / deploy / deploy-with-env
   ```
   `--service-token-id` / `--service-token-secret` 也可作为 flag 传，环境变量更不容易被 `ps` 看到。主机指纹放 repository variable `VPS_SSH_HOST_KEY`，运行时写入 known_hosts，避免 CI 盲信主机指纹；换机后更新这一个变量即可。
4. 这样 CI 泄露的最坏情况是：攻击者能触发一次部署或回滚到**已存在**的镜像 tag，拿不到 shell、拿不到 R2 key、拿不到 `.env.prod`。

## 6. 核对清单

- [ ] `nc -vz <REPLACE_ME:vps-ip> 22` 从外网超时；`ufw status` 无 allow 规则
- [ ] `bianfa-ssh` Tunnel 在宿主机 systemd 里运行（不是 Docker），`ssh.<REPLACE_ME:domain>` 为橙云 CNAME
- [ ] Access 应用 `bianfa-ssh`：Policy `admin`（Allow, Emails 精确匹配）+ Policy `ci-deploy`（Service Auth）
- [ ] `/etc/ssh/ca.pub` 600；`TrustedUserCAKeys`、`AuthorizedPrincipalsFile` 生效；`PasswordAuthentication no`
- [ ] 笔记本 `ssh <user>@ssh.<REPLACE_ME:domain>` 免密进入；Access 日志里能看到这次登录
- [ ] CI 的 `deploy` 用户是 forced command；service token 到期提醒已配
- [ ] Hostinger KVM 密码在密码管理器里且演练过一次登录
- [ ] 以上全部在 D3–5 完成（第 9 章 8.13），后续所有部署依赖它
