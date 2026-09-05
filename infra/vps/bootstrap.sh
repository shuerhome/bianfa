#!/usr/bin/env bash
# =============================================================================
# !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
# !!! 警告：--lockdown 后 ufw 默认拒绝全部入站（22/80/443 全关），公网 SSH 就没了。唯一登录路径：                        !!!
# !!!   ssh ops@ssh.<domain>  （ProxyCommand cloudflared access ssh --hostname %h；宿主机 systemd 里的 bianfa-ssh tunnel） !!!
# !!! --lockdown 之前必须：bianfa-ssh tunnel（宿主机 cloudflared.service）= Healthy，并从另一台机器用                     !!!
# !!! cloudflared access ssh 成功登录过一次。锁死自己的最后逃生口：Hostinger hPanel → VPS → Manage → Overview → Terminal    !!!
# !!! （浏览器 noVNC 控制台，不经网络 SSH）→ `ufw disable`。root 口令要提前存进密码管理器，否则控制台也进不去，只剩重装。   !!!
# !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
# infra/vps/bootstrap.sh —— 新 VPS 从零到「可以 docker compose up」（幂等；root 执行）
# 来源：第 9 章 8.4/8.5/8.13（D3–5）、第 10 章 9.4.5（其 `ufw limit 22 / allow 80,443` 是 Tunnel 前旧稿，按第 1 章裁定作废）、
#       infra/cloudflare/access-ssh.md（ops 人工用户 + deploy CI 用户 forced command；bianfa-ssh tunnel 跑宿主机 systemd，
#       Docker 挂了也进得去）、infra/cloudflare/dns-and-waf.md §2.2。
#       Docker 按 docs.docker.com apt 源方式安装（2026-09-05 核实 docker/docs ubuntu.md：deb822 /etc/apt/sources.list.d/docker.sources，
#       Signed-By /etc/apt/keyrings/docker.asc）。cloudflared 按 pkg.cloudflare.com（核实 cloudflare-docs partial
#       cloudflared-debian-install.mdx：keyring /usr/share/keyrings/cloudflare-main.gpg，suite 固定为 any）。
#       适用 Ubuntu 24.04/22.04、Debian 12/13。
# 用法：--prepare（阶段 A：包、UTC、ops/deploy 用户、sshd、Docker、目录、unattended-upgrades、cron、fail2ban、宿主机 cloudflared；不动防火墙）
#       → clone 到 /srv/bianfa/app、填 .env.prod、compose up -d cloudflared、按 tunnel-setup.md / access-ssh.md 配 Access、
#         从笔记本 Access SSH 登录成功 →
#       --lockdown（阶段 B：ufw deny incoming，仅放行 docker 网段 → 22 作为备用路径）。无参数 = A+B，B 前要输入确认短语；--yes 跳过确认。
# 必须人工替换（环境变量传入；不要改脚本里的默认值）：
#   OPS_SSH_PUBKEY          = <REPLACE_ME:ops-user-ed25519-public-key>          必填：人工运维用户 ops 的公钥（没有它 --prepare 拒绝执行，防锁死）
#   DEPLOY_SSH_PUBKEY       = <REPLACE_ME:deploy-ci-ed25519-public-key>         可选：CI 用户 deploy 的公钥（forced command → deploy-entry.sh）
#   CF_TUNNEL_TOKEN_SSH     = <REPLACE_ME:cloudflare-tunnel-token-bianfa-ssh>   可选：bianfa-ssh tunnel 的 token（cloudflared service install，
#                                                                                只用一次、不落 .env.prod；cloudflared 自己存到 /etc/cloudflared）
#   CF_ACCESS_SSH_CA_PUBKEY = <REPLACE_ME:cloudflare-access-ssh-ca-public-key>  可选：Access 短时证书 CA（legacy）
#   OPS_PRINCIPALS          = <REPLACE_ME:email-prefixes-comma-separated>       可选：允许证书登录 ops 的邮箱前缀
# 不做：clone / compose up（restore.sh 或首次部署）、Grafana Alloy（8.8）、hPanel 外层防火墙（建议也设拒绝入站）、Origin CA 证书
#       （放 /srv/bianfa/secrets/origin-ca.{pem,key}，break-glass.sh 用）。
# =============================================================================
set -euo pipefail

OPS_USER="${OPS_USER:-ops}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
BIANFA_ROOT="${BIANFA_ROOT:-/srv/bianfa}"          # 运行时状态：.env.prod / .tag.current / log / run / secrets
BIANFA_REPO="${BIANFA_REPO:-$BIANFA_ROOT/app}"     # git checkout（与状态分开，clone 才能落到空目录）
ENV_FILE="${ENV_FILE:-$BIANFA_ROOT/.env.prod}"
LOG_DIR="${LOG_DIR:-$BIANFA_ROOT/log}"
RUN_DIR="${RUN_DIR:-$BIANFA_ROOT/run}"
SECRETS_DIR="${SECRETS_DIR:-$BIANFA_ROOT/secrets}"
STATE_DIR="/var/lib/bianfa"
DOCKER_POOL_BASE="${DOCKER_POOL_BASE:-172.20.0.0/14}"   # 固定容器网段；ufw 只放行它 → sshd（备用路径）
OPS_SSH_PUBKEY="${OPS_SSH_PUBKEY:-<REPLACE_ME:ops-user-ed25519-public-key>}"
DEPLOY_SSH_PUBKEY="${DEPLOY_SSH_PUBKEY:-<REPLACE_ME:deploy-ci-ed25519-public-key>}"
CF_TUNNEL_TOKEN_SSH="${CF_TUNNEL_TOKEN_SSH:-<REPLACE_ME:cloudflare-tunnel-token-bianfa-ssh>}"
CF_ACCESS_SSH_CA_PUBKEY="${CF_ACCESS_SSH_CA_PUBKEY:-<REPLACE_ME:cloudflare-access-ssh-ca-public-key>}"
OPS_PRINCIPALS="${OPS_PRINCIPALS:-<REPLACE_ME:email-prefixes-comma-separated>}"
ALLOW_NO_OPS_KEY="${ALLOW_NO_OPS_KEY:-0}"           # =1 才允许在没有 ops 公钥时执行 --prepare（例如先用 Access CA）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ENTRY="$BIANFA_REPO/infra/vps/deploy-entry.sh"
DEPLOY_SH="$BIANFA_REPO/infra/vps/deploy.sh"
export DEBIAN_FRONTEND=noninteractive

DO_PREPARE=0; DO_LOCKDOWN=0; ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --prepare) DO_PREPARE=1 ;; --lockdown) DO_LOCKDOWN=1 ;; --yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 64 ;;
  esac
done
(( DO_PREPARE || DO_LOCKDOWN )) || { DO_PREPARE=1; DO_LOCKDOWN=1; }

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[fail] %s\033[0m\n' "$*" >&2; exit 1; }
is_placeholder() { [[ -z "$1" || "$1" == *REPLACE_ME* ]]; }

[[ $EUID -eq 0 ]] || die "请以 root 执行（sudo -i）"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu) DOCKER_REPO_URL="https://download.docker.com/linux/ubuntu"; DOCKER_SUITE="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}" ;;
  debian) DOCKER_REPO_URL="https://download.docker.com/linux/debian"; DOCKER_SUITE="${VERSION_CODENAME:-}" ;;
  *) die "只支持 Ubuntu / Debian，当前: ${ID:-unknown}" ;;
esac
[[ -n "$DOCKER_SUITE" ]] || die "读不到发行版代号"
install -d -m 755 "$STATE_DIR"

# ============================================================================= 阶段 A
step_base_packages() {
  log "基础软件包 + UTC/NTP（Access 证书对时钟敏感；cron 按 UTC）"
  apt-get update -qq
  # python3：backup.sh 解析 pgbackrest JSON；python3-systemd：fail2ban backend=systemd 必需（--no-install-recommends 不会带上它）
  apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg git jq python3 python3-systemd ufw fail2ban \
    unattended-upgrades cron logrotate openssh-server sudo dnsutils util-linux
  timedatectl set-timezone UTC 2>/dev/null || warn "timedatectl 失败"
  timedatectl set-ntp true 2>/dev/null || true
}

_ensure_user() {   # $1=user $2=gecos；建用户 + ~/.ssh/authorized_keys 骨架（不输出到 stdout）
  id -u "$1" >/dev/null 2>&1 || adduser --disabled-password --gecos "$2" "$1" >&2
  local home; home=$(getent passwd "$1" | cut -d: -f6)
  install -d -m 700 -o "$1" -g "$1" "$home/.ssh"
  [[ -f "$home/.ssh/authorized_keys" ]] || : > "$home/.ssh/authorized_keys"
  chmod 600 "$home/.ssh/authorized_keys"; chown "$1:$1" "$home/.ssh/authorized_keys"
}
_home_of() { getent passwd "$1" | cut -d: -f6; }

step_users() {
  log "用户：${OPS_USER}（人工；NOPASSWD sudo——docker 组本身等价 root，不假装分权，边界在 Access）+ ${DEPLOY_USER}（CI；forced command）"
  if is_placeholder "$OPS_SSH_PUBKEY" && [[ "$ALLOW_NO_OPS_KEY" != 1 ]]; then
    die "OPS_SSH_PUBKEY 是占位符。本脚本会把 sshd 改成只允许 ${OPS_USER}/${DEPLOY_USER} 用密钥登录，没有 ops 公钥 = 把自己锁在外面。
      用法：OPS_SSH_PUBKEY='ssh-ed25519 AAAA… you@laptop' $0 --prepare   （只用 Access CA 时加 ALLOW_NO_OPS_KEY=1）"
  fi
  local home
  _ensure_user "$OPS_USER" "bianfa ops"; home=$(_home_of "$OPS_USER")
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$OPS_USER" > /etc/sudoers.d/90-bianfa-ops
  chmod 440 /etc/sudoers.d/90-bianfa-ops
  visudo -cf /etc/sudoers.d/90-bianfa-ops >/dev/null || die "sudoers 语法错误（ops）"
  if is_placeholder "$OPS_SSH_PUBKEY"; then
    warn "OPS_SSH_PUBKEY 是占位符：未给 ${OPS_USER} 装公钥（ALLOW_NO_OPS_KEY=1）。--lockdown 前必须有 Access CA + principals"
  else
    grep -qxF "$OPS_SSH_PUBKEY" "$home/.ssh/authorized_keys" || printf '%s\n' "$OPS_SSH_PUBKEY" >> "$home/.ssh/authorized_keys"
  fi

  _ensure_user "$DEPLOY_USER" "bianfa CI deploy"; home=$(_home_of "$DEPLOY_USER")
  # 只允许 sudo 跑 deploy.sh；deploy-entry.sh（forced command）负责只接受 deploy <tag> / deploy-with-env <tag>
  printf '%s ALL=(root) NOPASSWD: %s\n' "$DEPLOY_USER" "$DEPLOY_SH" > /etc/sudoers.d/91-bianfa-deploy
  chmod 440 /etc/sudoers.d/91-bianfa-deploy
  visudo -cf /etc/sudoers.d/91-bianfa-deploy >/dev/null || die "sudoers 语法错误（deploy）"
  if is_placeholder "$DEPLOY_SSH_PUBKEY"; then
    warn "DEPLOY_SSH_PUBKEY 是占位符：CI 暂时无法部署。之后可重跑 DEPLOY_SSH_PUBKEY='…' $0 --prepare"
  else
    # authorized_keys 整行由我们生成：forced command + 禁掉转发/pty
    printf 'command="%s",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty %s\n' "$DEPLOY_ENTRY" "$DEPLOY_SSH_PUBKEY" \
      > "$home/.ssh/authorized_keys"
    chmod 600 "$home/.ssh/authorized_keys"; chown "$DEPLOY_USER:$DEPLOY_USER" "$home/.ssh/authorized_keys"
  fi
  [[ -x "$DEPLOY_ENTRY" ]] || warn "${DEPLOY_ENTRY} 还不存在/不可执行（仓库尚未 clone 到 ${BIANFA_REPO}）；clone 后 CI 才能部署"
}

step_sshd() {
  log "sshd 加固（第 10 章 9.4.5）+ 可选 Access 短时证书 CA"
  install -d -m 755 /etc/ssh/sshd_config.d
  # 00- 前缀：sshd 取同一指令「第一次出现」的值，Include 在主配置顶部，00-* 压过 50-cloud-init.conf 的 PasswordAuthentication yes
  cat > /etc/ssh/sshd_config.d/00-bianfa-hardening.conf <<EOF
# 由 infra/vps/bootstrap.sh 生成；改脚本重跑，不要手改。
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers ${OPS_USER} ${DEPLOY_USER}
X11Forwarding no
AllowAgentForwarding no
MaxAuthTries 4
LoginGraceTime 30
ClientAliveInterval 60
ClientAliveCountMax 3
EOF
  local f
  for f in /etc/ssh/sshd_config.d/*.conf; do
    [[ "$f" == */0[01]-bianfa-* ]] || sed -i -E 's/^[[:space:]]*PasswordAuthentication[[:space:]]+yes/PasswordAuthentication no/' "$f"
  done
  if is_placeholder "$CF_ACCESS_SSH_CA_PUBKEY"; then
    rm -f /etc/ssh/sshd_config.d/01-bianfa-access-ca.conf
    warn "CF_ACCESS_SSH_CA_PUBKEY 是占位符：不启用短时证书（人工登录 = 公钥 + Access 浏览器登录）"
  else
    printf '%s\n' "$CF_ACCESS_SSH_CA_PUBKEY" > /etc/ssh/ca.pub; chmod 600 /etc/ssh/ca.pub
    # 证书 principal = 邮箱前缀 ≠ Unix 用户名 ops → AuthorizedPrincipalsFile 按用户映射。不用 Match 块：
    # 放在 sshd_config.d 片段末尾会把主配置 Include 之后的指令全吞进 Match 上下文。
    install -d -m 755 /etc/ssh/principals
    if is_placeholder "$OPS_PRINCIPALS"; then
      warn "OPS_PRINCIPALS 是占位符：CA 已信任但没有邮箱前缀被允许登录 ${OPS_USER}"; : > "/etc/ssh/principals/${OPS_USER}"
    else
      tr ',' '\n' <<<"$OPS_PRINCIPALS" | sed 's/[[:space:]]//g' | grep -v '^$' > "/etc/ssh/principals/${OPS_USER}"
    fi
    chmod 644 "/etc/ssh/principals/${OPS_USER}"
    printf '# Cloudflare Access 短时证书（legacy，见 access-ssh.md §3）\nTrustedUserCAKeys /etc/ssh/ca.pub\nAuthorizedPrincipalsFile /etc/ssh/principals/%%u\n' \
      > /etc/ssh/sshd_config.d/01-bianfa-access-ca.conf
  fi
  sshd -t || die "sshd 配置校验失败，未重载"
  # Ubuntu 24.04 的 ssh.service 是 socket 激活的：没有活动连接时它可能不在运行，`systemctl reload` 会失败 → 用 reload-or-restart
  systemctl reload-or-restart ssh.service 2>/dev/null || systemctl reload-or-restart sshd.service 2>/dev/null || true
  sshd -T 2>/dev/null | grep -qi '^passwordauthentication no' || die "生效配置仍允许密码登录，检查 sshd_config.d/*"
}

step_docker() {
  log "Docker Engine（官方 apt 源 ${DOCKER_REPO_URL} ${DOCKER_SUITE}）"
  local pkg
  for pkg in docker.io docker-doc docker-compose podman-docker containerd runc; do
    dpkg -s "$pkg" >/dev/null 2>&1 && apt-get remove -y -qq "$pkg" || true
  done
  install -m 0755 -d /etc/apt/keyrings
  [[ -s /etc/apt/keyrings/docker.asc ]] || { curl -fsSL "${DOCKER_REPO_URL}/gpg" -o /etc/apt/keyrings/docker.asc; chmod a+r /etc/apt/keyrings/docker.asc; }
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: ${DOCKER_REPO_URL}
Suites: ${DOCKER_SUITE}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  rm -f /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  # daemon.json（键名已对照 moby daemon/config/config.go、config_linux.go：log-driver / log-opts / live-restore / ip / default-address-pools）：
  #   "ip": "127.0.0.1" —— 不写宿主 IP 的 ports: 只绑回环，这是「无公网端口」真正的兜底（Docker 发布端口走 nat 表，在 ufw INPUT 链之前
  #   就被转走，ufw 管不住；break-glass 显式写 0.0.0.0）；default-address-pools 固定容器网段，ufw 才能精确放行「容器 → 宿主机 sshd」。
  local tmp; tmp=$(mktemp)
  cat > "$tmp" <<EOF
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "3" },
  "live-restore": true,
  "ip": "127.0.0.1",
  "default-address-pools": [ { "base": "${DOCKER_POOL_BASE}", "size": 24 } ]
}
EOF
  if ! cmp -s "$tmp" /etc/docker/daemon.json 2>/dev/null; then
    if [[ -f /etc/docker/daemon.json ]] && docker network ls -q --filter type=custom 2>/dev/null | grep -q .; then
      warn "daemon.json 变了但已有自定义网络：address-pools 只对新建网络生效，需 compose down 后重建"
    fi
    install -m 644 "$tmp" /etc/docker/daemon.json
    systemctl restart docker
  fi
  rm -f "$tmp"
  systemctl enable --now docker >/dev/null
  usermod -aG docker "$OPS_USER"
  docker compose version >/dev/null || die "docker compose 插件不可用"
}

step_dirs() {
  log "目录 ${BIANFA_ROOT}"
  install -d -m 755 -o "$OPS_USER" -g "$OPS_USER" "$BIANFA_ROOT"
  install -d -m 755 -o root -g root "$LOG_DIR"
  install -d -m 700 -o root -g root "$RUN_DIR"
  install -d -m 700 -o root -g root "$SECRETS_DIR"     # Origin CA 证书放这里（break-glass.sh）
  if [[ ! -f "$ENV_FILE" ]]; then
    # 只放模板；真值由 CI 从 GitHub Environment secrets 渲染后覆盖（deploy-with-env）。各脚本发现 REPLACE_ME 会拒绝运行。
    cat > "$ENV_FILE" <<'EOF'
# /srv/bianfa/.env.prod —— 生产环境变量。root:root 0600，不进 git。由 CI 渲染覆盖；此文件仅为模板。
TAG=<REPLACE_ME:initial-image-tag>
BIANFA_DOMAIN=<REPLACE_ME:example.com>
ACME_EMAIL=<REPLACE_ME:ops-email-for-lets-encrypt>
# bianfa-prod tunnel（compose 里的 cloudflared ×2）。bianfa-ssh tunnel 的 token 不在这里（宿主机 cloudflared 自己保存）
CF_TUNNEL_TOKEN=<REPLACE_ME:cloudflare-tunnel-token-bianfa-prod>
POSTGRES_PASSWORD=<REPLACE_ME:postgres-superuser-password>
# pgBackRest（第 9 章 8.7）：只有 postgres 容器需要；口令为何必须留在 VPS 见 backup.sh 头部
PGBACKREST_REPO1_CIPHER_PASS=<REPLACE_ME:32-bytes-random-kept-in-password-manager>
PGBACKREST_REPO1_S3_KEY=<REPLACE_ME:r2-bianfa-backups-rw-access-key-id>
PGBACKREST_REPO1_S3_KEY_SECRET=<REPLACE_ME:r2-bianfa-backups-rw-secret-access-key>
# Telegram（notify.sh）
TG_BOT_TOKEN=<REPLACE_ME:telegram-bot-token>
TG_CHAT_ID=<REPLACE_ME:telegram-chat-id>
EOF
  fi
  chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
  # compose 的 env_file: [.env.prod] 相对 compose 目录解析 → 符号链接指向真身（.gitignore 要忽略它）
  [[ -d "$BIANFA_REPO/infra/docker" ]] && ln -sfn "$ENV_FILE" "$BIANFA_REPO/infra/docker/.env.prod"
  return 0
}

step_unattended() {
  log "unattended-upgrades（只装安全更新；不自动重启。Docker 源不在默认 Origins 里，docker-ce 不自动升级——想要的）"
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\nAPT::Periodic::AutocleanInterval "7";\n' > /etc/apt/apt.conf.d/20auto-upgrades
  printf 'Unattended-Upgrade::Automatic-Reboot "false";\nUnattended-Upgrade::Remove-Unused-Dependencies "true";\nUnattended-Upgrade::Remove-Unused-Kernel-Packages "true";\n' > /etc/apt/apt.conf.d/52bianfa-unattended
  systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
}

step_cron() {
  log "cron（备份 + 镜像清理）与 logrotate"
  [[ -f "$SCRIPT_DIR/cron.d/bianfa" ]] || die "找不到 ${SCRIPT_DIR}/cron.d/bianfa：请从仓库 infra/vps/ 目录运行"
  install -m 644 -o root -g root "$SCRIPT_DIR/cron.d/bianfa" /etc/cron.d/bianfa
  printf '%s/*.log {\n  weekly\n  rotate 8\n  compress\n  delaycompress\n  missingok\n  notifempty\n  copytruncate\n}\n' "$LOG_DIR" > /etc/logrotate.d/bianfa
  systemctl enable --now cron >/dev/null 2>&1 || true
}

step_fail2ban() {
  log "fail2ban（sshd jail，systemd 后端）"
  # Debian 12 / Ubuntu 24.04 没有 /var/log/auth.log，backend=auto 启动失败 → backend=systemd（需要 python3-systemd，上面已装）。
  # ignoreip 含回环与 docker 网段：SSH 只从宿主机 cloudflared（127.0.0.1）或备用的 cloudflared 容器进来，封了它们 = 封掉所有人。
  # fail2ban 在此主要兜底 break-glass 期间及「有人把 22 开回公网」的误操作。
  cat > /etc/fail2ban/jail.d/bianfa-sshd.local <<EOF
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 ${DOCKER_POOL_BASE}
backend = systemd

[sshd]
enabled = true
maxretry = 3
bantime = 1h
findtime = 10m
EOF
  systemctl enable fail2ban >/dev/null 2>&1 || true
  systemctl restart fail2ban || die "fail2ban 启动失败：journalctl -u fail2ban"
}

step_cloudflared_host() {
  log "宿主机 cloudflared（bianfa-ssh tunnel → localhost:22；不在 Docker 里，Docker 挂了也进得去）"
  if ! command -v cloudflared >/dev/null; then
    install -d -m 0755 /usr/share/keyrings
    [[ -s /usr/share/keyrings/cloudflare-main.gpg ]] || curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    # 已核实 cloudflare-docs：suite 固定为 any，与发行版代号无关
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -qq
    apt-get install -y -qq cloudflared
  fi
  if systemctl is-enabled --quiet cloudflared 2>/dev/null; then
    echo "cloudflared.service 已安装（$(systemctl is-active cloudflared 2>/dev/null || true)）；要换 token 先 cloudflared service uninstall"
  elif is_placeholder "$CF_TUNNEL_TOKEN_SSH"; then
    warn "CF_TUNNEL_TOKEN_SSH 是占位符：未注册 bianfa-ssh tunnel。之后手工：sudo cloudflared service install <token>（token 不要落盘到别处）"
  else
    # 已核实 cloudflared linux_service.go：service install [TOKEN] 创建 cloudflared.service，token 写入服务配置目录
    cloudflared service install "$CF_TUNNEL_TOKEN_SSH" || die "cloudflared service install 失败"
    systemctl enable --now cloudflared >/dev/null 2>&1 || true
    sleep 3
    if systemctl is-active --quiet cloudflared; then
      echo "cloudflared.service 运行中；到 Zero Trust → Tunnels 看 bianfa-ssh 是否 Healthy"
    else
      warn "cloudflared.service 未运行：journalctl -u cloudflared -n 50"
    fi
  fi
}

# ============================================================================= 阶段 B
lockdown_preflight() {
  local home has_key=0 has_ca=0
  home=$(getent passwd "$OPS_USER" | cut -d: -f6)
  [[ -s "$home/.ssh/authorized_keys" ]] && has_key=1
  [[ -s /etc/ssh/ca.pub && -s "/etc/ssh/principals/${OPS_USER}" ]] && has_ca=1
  (( has_key || has_ca )) || die "${OPS_USER} 既无 authorized_keys 也无可用 Access CA/principals：锁下去就进不来了。先补 OPS_SSH_PUBKEY。"
  sshd -T 2>/dev/null | grep -qi '^passwordauthentication no' || die "sshd 仍允许密码登录"
  systemctl is-active --quiet docker || die "docker 未运行"
  if ! systemctl is-active --quiet cloudflared 2>/dev/null; then
    warn "宿主机 cloudflared.service（bianfa-ssh）没有运行。锁定后 SSH 只剩备用路径（bianfa-prod tunnel 加 ssh 路由 → host.docker.internal:22）或 Hostinger 浏览器 Terminal。"
  fi
  if (( ! ASSUME_YES )); then
    printf '\n  即将：ufw default deny incoming（22/80/443 全关），仅放行 %s → 22/tcp（容器 → 宿主机 sshd 的备用路径）。\n  请确认已从另一台机器经 ssh %s@ssh.<domain>（cloudflared access ssh）登录成功，且 root 口令已存密码管理器。\n\n' "$DOCKER_POOL_BASE" "$OPS_USER"
    local phrase; read -r -p '输入 I HAVE TESTED CLOUDFLARED SSH 继续：' phrase
    [[ "$phrase" == "I HAVE TESTED CLOUDFLARED SSH" ]] || die "未确认，退出。"
  fi
}

step_ufw_lockdown() {
  log "ufw：默认拒绝全部入站（不开 22/80/443）"
  local rule
  for rule in 'allow 22/tcp' 'limit 22/tcp' 'allow OpenSSH' 'allow 80/tcp' 'allow 443/tcp' 'allow 80,443/tcp' 'allow 22' 'allow 443'; do
    # shellcheck disable=SC2086
    ufw --force delete $rule >/dev/null 2>&1 || true      # 清掉模板预置的放行
  done
  ufw default deny incoming  >/dev/null
  ufw default allow outgoing >/dev/null   # cloudflared 出站 7844 udp/tcp + 443、apt、R2、Telegram
  ufw allow in proto tcp from "$DOCKER_POOL_BASE" to any port 22 comment 'sshd <- cloudflared container (fallback)' >/dev/null
  ufw --force enable >/dev/null
  # ufw enable/reload 会重建 iptables 内建链，Docker 追加在 FORWARD 上的规则可能被清掉 → 重启 dockerd 让它重新写入
  # （live-restore: true，容器不重启；cloudflared 连接会闪断几秒后自动重连）
  systemctl restart docker
  ufw status verbose
  date -u +%FT%TZ > "$STATE_DIR/locked_down"
}

main() {
  if (( DO_PREPARE )); then
    step_base_packages; step_users; step_sshd; step_docker; step_dirs; step_unattended; step_cron; step_fail2ban; step_cloudflared_host
    date -u +%FT%TZ > "$STATE_DIR/prepared"
    log "阶段 A 完成。"
    cat <<EOF
下一步（仍在公网 SSH 可用时做）：
  1. su - ${OPS_USER} -c 'git clone <repo-url> ${BIANFA_REPO}'；chmod +x ${BIANFA_REPO}/infra/vps/*.sh（git 已带可执行位则不用）
  2. 填 ${ENV_FILE}（至少 CF_TUNNEL_TOKEN / BIANFA_DOMAIN / TG_BOT_TOKEN / TG_CHAT_ID）；ln -sfn ${ENV_FILE} ${BIANFA_REPO}/infra/docker/.env.prod
  3. cd ${BIANFA_REPO}/infra/docker && sudo docker compose --env-file ${ENV_FILE} up -d cloudflared  → 控制台 bianfa-prod Healthy、2 个 connector
  4. 按 infra/vps/tunnel-setup.md + infra/cloudflare/access-ssh.md 配 ssh.<domain> 路由（bianfa-ssh）+ Access 应用，
     从笔记本 cloudflared access ssh 登录成功；（可选）CI 密钥：DEPLOY_SSH_PUBKEY='…' $0 --prepare 再跑一次
  5. 再跑：$0 --lockdown
EOF
  fi
  if (( DO_LOCKDOWN )); then
    lockdown_preflight; step_ufw_lockdown
    log "阶段 B 完成：公网 SSH 已关闭。以后只能经 cloudflared access ssh（bianfa-ssh）或 Hostinger 浏览器 Terminal 登录。"
  fi
}
main
