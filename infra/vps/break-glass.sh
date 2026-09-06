#!/usr/bin/env bash
# =============================================================================
# infra/vps/break-glass.sh —— Cloudflare Tunnel 全挂时，5 分钟内绕过 Tunnel、公网直连本机 443 恢复服务
#
# !!! 这个脚本必须在平时演练过。第 9 章 8.13 把「写 break-glass 脚本并演练一次」排在 D3–5，早于任何业务代码。
# !!! 没演练过的 break-glass = 事故当天第一次运行一段没人跑过的代码。演练方法见文末：每季度 --drill（2 分钟，不改 DNS、
# !!! 不碰证书签发）；每半年一次带真实 DNS 切换的完整演练（维护窗口）。
#
# 来源：第 9 章 8.4「ufw allow 443 + 打开 Caddy :443 端口映射 + 改一条 DNS A 记录」；infra/cloudflare/dns-and-waf.md §5、
#       infra/RUNBOOK.md §7.1（--mode origin-ca 首选、--status、证书放 /srv/bianfa/secrets/origin-ca.{pem,key}）。
# 做什么：
#   1) ufw allow 443/tcp；
#   2) compose override（不改主文件）给 caddy 加 0.0.0.0:443:443，并换一份 Caddyfile：= 主 Caddyfile 原样（`:80` 站点保留，
#      Tunnel 一旦恢复照样能走）+ 追加一份 `:80` 站点块的复制，地址改为 https://api.<d>, https://ws.<d>，加 tls 一行。
#      路由只维护一份（复制是脚本做的），全局选项里加 auto_https disable_redirects（否则 Caddy 会给 :80 加 HTTP→HTTPS 跳转，
#      Tunnel 路径会进跳转循环）。生成结果先 `caddy validate` 再上线。
#   3) TLS 三种模式（--mode）：
#        origin-ca  首选（有 /srv/bianfa/secrets/origin-ca.{pem,key} 时的默认值）：Cloudflare Origin CA 证书（15 年），
#                   DNS 改 A 记录并**保持橙云**——WAF/限流/DDoS 都还在，源站 IP 不暴露；zone SSL 模式必须已是 Full (strict)。
#        acme       没有 Origin CA 证书时的备用：Let's Encrypt TLS-ALPN-01 只需 443，但 A 记录要先**灰云**（LE 要直连本机），
#                   拿到证书后再改橙云。--staging 用 LE staging CA 演练（不消耗正式限速；证书浏览器不信任）。
#        internal   Caddy 内部 CA 自签，仅 --drill 用。
#   4) 打印你要手改的 DNS 记录——脚本不自动改 DNS，那是最不可逆的一步；
#   5) 轮询 /healthz：先 --resolve 打本机（证明 443/证书/路由都通），再打公网域名（证明 DNS 已切、边缘已连上）。
#   --revert 反向恢复；--status 只查看。
# 必须人工替换：无。读取 .env.prod 的 BIANFA_DOMAIN（站点 api.<d> 与 ws.<d>）、ACME_EMAIL（acme 模式）。
# 为何 Docker 发布端口后还要 ufw allow：Docker nat 规则绕过 ufw，`ports:` 一加公网其实就通；bootstrap 用 daemon.json
#   "ip": "127.0.0.1" 把默认绑定压到回环，这里显式写 0.0.0.0；ufw 那条让两处一致、--revert 时也有明确的东西可删。
#   容器内非 root 绑 443：Docker 默认给容器 net.ipv4.ip_unprivileged_port_start=0，caddy 以 USER 10001 跑也能绑。
# =============================================================================
set -euo pipefail

BIANFA_ROOT="${BIANFA_ROOT:-/srv/bianfa}"
BIANFA_REPO="${BIANFA_REPO:-$BIANFA_ROOT/app}"
COMPOSE_DIR="${COMPOSE_DIR:-$BIANFA_REPO/infra/docker}"
ENV_FILE="${ENV_FILE:-$BIANFA_ROOT/.env.prod}"
LOG_DIR="${LOG_DIR:-$BIANFA_ROOT/log}"
RUN_DIR="${RUN_DIR:-$BIANFA_ROOT/run}"
SECRETS_DIR="${SECRETS_DIR:-$BIANFA_ROOT/secrets}"
ORIGIN_CERT="${ORIGIN_CERT:-$SECRETS_DIR/origin-ca.pem}"
ORIGIN_KEY="${ORIGIN_KEY:-$SECRETS_DIR/origin-ca.key}"
MAIN_CADDYFILE="${MAIN_CADDYFILE:-$COMPOSE_DIR/Caddyfile}"
BG_HOSTS="${BG_HOSTS:-api ws}"                  # 要直连的子域；Origin CA 证书需覆盖它们（签 *.<d> 即可）
OVERRIDE="$RUN_DIR/compose.break-glass.yml"
BG_CADDYFILE="$RUN_DIR/Caddyfile.break-glass"
MARKER="$RUN_DIR/break-glass.active"
POLL_MINUTES="${POLL_MINUTES:-10}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./notify.sh
source "$SCRIPT_DIR/notify.sh"

ACTION=enter; MODE=""; DRILL=0; STAGING=0; ASSUME_YES=0
while (( $# )); do
  case "$1" in
    --revert) ACTION=revert ;;
    --status) ACTION=status ;;
    --mode) MODE="$2"; shift ;;
    --drill) DRILL=1 ;;       # 演练：tls internal，不碰 ACME/Origin CA、不改 DNS、不发 Telegram
    --staging) STAGING=1 ;;   # acme 模式用 LE staging CA：要改 DNS，不消耗正式限速（证书浏览器不信任）
    --yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "未知参数 $1" >&2; exit 64 ;;
  esac
  shift
done
[[ $EUID -eq 0 ]] || { echo "请用 sudo 执行" >&2; exit 1; }
mkdir -p "$LOG_DIR" "$RUN_DIR"
LOG="$LOG_DIR/break-glass.log"
ts() { date -u +%FT%TZ; }
logline() { printf '%s %s\n' "$(ts)" "$*" | tee -a "$LOG" >&2; }
die() { logline "FAIL: $*"; exit 1; }
env_get() { grep -E "^${1}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '"'"'" || true; }

[[ -r "$ENV_FILE" ]] || die "缺少 $ENV_FILE"
DOMAIN=$(env_get BIANFA_DOMAIN); ACME_EMAIL=$(env_get ACME_EMAIL)
[[ -n "$DOMAIN" && "$DOMAIN" != *REPLACE_ME* ]] || die ".env.prod 里 BIANFA_DOMAIN 未设置"
HOSTS=(); for h in $BG_HOSTS; do HOSTS+=("${h}.${DOMAIN}"); done
HOST="${HOSTS[0]}"                              # 轮询与提示用第一个（api.<d>）
SITE_ADDR=""; for h in "${HOSTS[@]}"; do SITE_ADDR+="${SITE_ADDR:+, }https://${h}"; done
COMPOSE_MAIN="$COMPOSE_DIR/docker-compose.yml"
for f in compose.yaml compose.yml docker-compose.yaml; do [[ -f "$COMPOSE_MAIN" ]] || COMPOSE_MAIN="$COMPOSE_DIR/$f"; done
[[ -f "$COMPOSE_MAIN" ]] || die "找不到 compose 主文件（$COMPOSE_DIR）"
compose()    { docker compose --project-directory "$COMPOSE_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_MAIN" "$@"; }
compose_bg() { compose -f "$OVERRIDE" "$@"; }

# 模式选择：--drill ⇒ internal；否则 --mode 给定值；否则有 Origin CA 证书 ⇒ origin-ca，没有 ⇒ acme
if (( DRILL )); then MODE=internal; fi
if [[ -z "$MODE" ]]; then
  if [[ -r "$ORIGIN_CERT" && -r "$ORIGIN_KEY" ]]; then MODE=origin-ca; else MODE=acme; fi
fi
case "$MODE" in origin-ca|acme|internal) ;; *) die "--mode 只接受 origin-ca | acme | internal" ;; esac
[[ "$MODE" == origin-ca && ! ( -r "$ORIGIN_CERT" && -r "$ORIGIN_KEY" ) ]] && die "origin-ca 模式需要 $ORIGIN_CERT 与 $ORIGIN_KEY（Cloudflare → SSL/TLS → Origin Server 签发，root 0600）"
(( STAGING )) && [[ "$MODE" != acme ]] && die "--staging 只对 --mode acme 有意义"
# 本机轮询是否需要 -k：internal/staging 证书不被系统信任；Origin CA 也只被 Cloudflare 边缘信任
CURL_K=""; [[ "$MODE" != acme || $STAGING -eq 1 ]] && CURL_K="-k"

public_ip() {   # 默认路由出口地址（Hostinger 公网 IP 直接配在网卡上）；兜底问外部服务
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')
  [[ -n "$ip" ]] || ip=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  printf '%s' "$ip"
}

# 生成 Caddyfile：主文件原样 + 追加 `:80` 站点块的复制（地址换成 https 主机名，插一行 tls）。
# 已用 caddy 2.11.4 实测：`https://a, https://b, :80 { tls <cert> <key> }` 会报「server listening on [:80] is HTTP, but attempts to
# configure TLS connection policies」，所以不能把 :80 和 https 地址放同一个块，只能复制块。
# 站点块边界：从 `^:80 {` 行到下一行首为 `}` 的行（caddy fmt 格式）。单行 `{ ... }` 形式的子块在 Caddyfile 里本来就非法。
make_caddyfile() {
  [[ -f "$MAIN_CADDYFILE" ]] || die "找不到主 Caddyfile：$MAIN_CADDYFILE"
  grep -qE '^[[:space:]]*:80[[:space:]]*\{[[:space:]]*$' "$MAIN_CADDYFILE" \
    || die "主 Caddyfile 里没找到独占一行的 ':80 {' 站点块，无法自动变换；手写 $BG_CADDYFILE 后加 MAIN_CADDYFILE= 重跑"
  local tlsline="" c key extra=""
  local -a chunks=()          # 要注入的全局选项，每项一个（可多行的）块
  case "$MODE" in
    internal)  tlsline="tls internal" ;;
    origin-ca) tlsline="tls /etc/caddy/certs/origin-ca.pem /etc/caddy/certs/origin-ca.key" ;;
    acme)      if [[ -n "$ACME_EMAIL" && "$ACME_EMAIL" != *REPLACE_ME* ]]; then chunks+=("  email ${ACME_EMAIL}"); else logline "警告：.env.prod 没有 ACME_EMAIL，Let's Encrypt 将无联系邮箱"; fi
               (( STAGING )) && chunks+=("  acme_ca https://acme-staging-v02.api.letsencrypt.org/directory") ;;
  esac
  chunks+=("  auto_https disable_redirects")
  # 没映射 443/udp，别对外宣告 h3。servers 子块必须多行——`servers { protocols h1 h2 }` 单行写法 caddy 报错（2.11.4 实测）
  chunks+=($'  servers {\n    protocols h1 h2\n  }')
  # 主文件已有同名全局选项（email/acme_ca/auto_https/servers）时沿用主文件的，不重复注入（重复键 caddy 报错）
  for c in "${chunks[@]}"; do
    key=$(awk 'NR==1{print $1}' <<<"$c")
    if grep -qE "^[[:space:]]+${key}([[:space:]]|$)" "$MAIN_CADDYFILE"; then
      logline "主 Caddyfile 已有全局选项 ${key}，沿用（不注入）"
      [[ "$key" == acme_ca && $STAGING -eq 1 ]] && logline "警告：主文件的 acme_ca 覆盖了 --staging，可能消耗正式 LE 限速"
      continue
    fi
    extra+="$c"$'\n'
  done
  {
    echo "# 由 break-glass.sh 于 $(ts) 生成（mode=${MODE}），勿手改；来源 ${MAIN_CADDYFILE}"
    if grep -qE '^\{[[:space:]]*$' "$MAIN_CADDYFILE"; then
      # 主文件已有全局选项块：把我们的选项插到它的 `{` 之后
      awk -v extra="${extra%$'\n'}" 'BEGIN{done=0} !done && /^\{[[:space:]]*$/ {print; if (extra!="") print extra; done=1; next} {print}' "$MAIN_CADDYFILE"
    else
      printf '{\n%s}\n' "$extra"
      cat "$MAIN_CADDYFILE"
    fi
    echo
    echo "# ---- break-glass：:80 站点块的复制，直连 443 用（Tunnel 恢复后 :80 那份照常服务） ----"
    awk -v addr="$SITE_ADDR" -v tl="$tlsline" '
      BEGIN{inb=0}
      !inb && /^[[:space:]]*:80[[:space:]]*\{[[:space:]]*$/ {inb=1; print addr " {"; if (tl!="") print "  " tl; next}
      inb {print}
      inb && /^\}[[:space:]]*$/ {inb=0}' "$MAIN_CADDYFILE"
  } > "$BG_CADDYFILE.tmp"
  mv -f "$BG_CADDYFILE.tmp" "$BG_CADDYFILE"
}

make_override() {
  {
    cat <<EOF
# 由 break-glass.sh 于 $(ts) 生成（mode=${MODE}）。与主文件合并：-f $(basename "$COMPOSE_MAIN") -f $(basename "$OVERRIDE")
# Compose 合并规则：ports 追加；volumes 按容器内路径合并、override 优先（这里覆盖 /etc/caddy/Caddyfile）。
services:
  caddy:
    ports:
      - "0.0.0.0:443:443"     # 显式 0.0.0.0：daemon.json "ip": "127.0.0.1" 使不写宿主 IP 的映射只绑回环
    volumes:
      - ${BG_CADDYFILE}:/etc/caddy/Caddyfile:ro
EOF
    [[ "$MODE" == origin-ca ]] && echo "      - ${SECRETS_DIR}:/etc/caddy/certs:ro"
  } > "$OVERRIDE"
}

validate_caddyfile() {
  local img; img=$(compose config --images caddy 2>/dev/null | head -n1)
  [[ -n "$img" ]] || die "读不到 caddy 服务的镜像名"
  local -a vols=(-v "$BG_CADDYFILE:/etc/caddy/Caddyfile:ro")
  [[ "$MODE" == origin-ca ]] && vols+=(-v "$SECRETS_DIR:/etc/caddy/certs:ro")
  # 官方 caddy 镜像没有 ENTRYPOINT（CMD 是 caddy run …），所以可以直接给 caddy validate；validate 会真的加载证书文件
  docker run --rm "${vols[@]}" "$img" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >>"$LOG" 2>&1 \
    || die "生成的 Caddyfile 未通过 caddy validate，见 $LOG（cat $BG_CADDYFILE）"
}

have_ufw() { command -v ufw >/dev/null 2>&1; }   # 共存模式（bootstrap --coexist）不装 ufw：端口本来就没被防火墙挡

ufw_delete_443() {
  have_ufw || return 0
  ufw --force delete allow in 443/tcp >/dev/null 2>&1 || true
  local n   # 兜底：按编号倒序删掉所有带 break-glass 注释的 443 规则（ufw status numbered 每行形如 "[ 3] 443/tcp ALLOW IN Anywhere # break-glass"）
  while read -r n; do [[ -n "$n" ]] && { ufw --force delete "$n" >>"$LOG" 2>&1 || true; }; done \
    < <(ufw status numbered 2>/dev/null | awk -F'[][]' '/443\/tcp/ && /break-glass/ {gsub(/ /,"",$2); print $2}' | sort -rn)
}

# 轮询 URL 直到 200；$1=描述 $2=截止秒 其余=curl 参数。返回 0/1
poll() {
  local what="$1" deadline="$2"; shift 2
  while (( $(date +%s) < deadline )); do
    # shellcheck disable=SC2086
    if curl $CURL_K -fsS --max-time 10 "$@" >/dev/null 2>>"$LOG"; then return 0; fi
    sleep 5
  done
  logline "超时：${what} 仍不可达"
  return 1
}

do_status() {
  echo "break-glass 状态："
  if [[ -f "$MARKER" ]]; then echo "  ACTIVE  —— $(cat "$MARKER")"; else echo "  inactive（无 $MARKER）"; fi
  echo "  ufw 443 规则： $(ufw status 2>/dev/null | grep -E '443/tcp' | tr '\n' ';' || echo '无')"
  echo "  caddy 端口：   $(docker ps --filter 'name=caddy' --format '{{.Names}} {{.Ports}}' 2>/dev/null | tr '\n' ';' || true)"
  echo "  override：     $([[ -f "$OVERRIDE" ]] && echo "$OVERRIDE 存在" || echo 无)"
  echo "  Origin CA：    $([[ -r "$ORIGIN_CERT" ]] && { openssl x509 -in "$ORIGIN_CERT" -noout -enddate 2>/dev/null || echo "$ORIGIN_CERT（无法解析）"; } || echo "无（将用 acme 模式）")"
  echo "  域名解析：     ${HOST} → $(dig +short "$HOST" @1.1.1.1 2>/dev/null | tr '\n' ' ' || echo '?')"
}

do_enter() {
  [[ -f "$MARKER" ]] && logline "注意：已处于 break-glass 状态（$(cat "$MARKER")），将重新生成配置并重建 caddy"
  local ip; ip=$(public_ip); [[ -n "$ip" ]] || die "拿不到本机公网 IPv4"
  if (( ! ASSUME_YES && ! DRILL )); then
    cat <<'EOF'

  break-glass 将把本机 443 暴露到公网并要求你手改 DNS。先确认：
    - 挂的是 Tunnel（Zero Trust → Networking → Tunnels 状态 Down，或 cloudflarestatus.com 有事故），
      而不是 api 容器自己挂了——后者 break-glass 帮不上忙，去看 docker compose ps / logs。
    - 你有 Cloudflare DNS 编辑权限，人在键盘前。
EOF
    local p; read -r -p '输入 BREAK GLASS 继续：' p; [[ "$p" == "BREAK GLASS" ]] || die "未确认"
  fi
  local start; start=$(date +%s)
  logline "enter: mode=${MODE} drill=${DRILL} staging=${STAGING} ip=${ip} hosts=${HOSTS[*]}"
  (( DRILL )) || notify_warn "break-glass 开始 / started（${MODE}）：绕过 Tunnel 直连 / bypassing Tunnel, direct to ${ip}:443 by ${SUDO_USER:-root}"
  make_caddyfile; make_override; validate_caddyfile
  if have_ufw; then
    ufw allow in 443/tcp comment 'break-glass' >>"$LOG" 2>&1 || die "ufw allow 443 失败"
  else
    logline "无 ufw（共存模式）：跳过放行 443；确认 hPanel 外层防火墙没有拦 443"
  fi
  compose_bg up -d --no-deps --force-recreate caddy >>"$LOG" 2>&1 || die "caddy 重建失败，见 $LOG"
  printf '%s mode=%s drill=%s ip=%s\n' "$(ts)" "$MODE" "$DRILL" "$ip" > "$MARKER"

  # 阶段 1：本机直连（--resolve 不依赖 DNS）。acme 模式要等 DNS 切过去 LE 才能签，所以这一步只对 origin-ca/internal 做。
  if [[ "$MODE" != acme ]]; then
    local deadline=$(( $(date +%s) + 60 )) ok=0
    while (( $(date +%s) < deadline )); do
      # shellcheck disable=SC2086
      if curl $CURL_K -fsS --max-time 5 --resolve "${HOST}:443:${ip}" "https://${HOST}/healthz" >/dev/null 2>>"$LOG"; then ok=1; break; fi
      # 公网 IP 不在网卡上（NAT 型 VPS）时打回环兜底
      # shellcheck disable=SC2086
      if curl $CURL_K -fsS --max-time 5 --resolve "${HOST}:443:127.0.0.1" "https://${HOST}/healthz" >/dev/null 2>>"$LOG"; then ok=1; logline "注意：经 127.0.0.1 可达但经 ${ip} 不可达，本机可能在 NAT 后"; break; fi
      sleep 3
    done
    (( ok )) || die "本机 443 不通：看 docker compose logs caddy / ufw status / hPanel 外层防火墙 / 证书文件（$(( $(date +%s) - start ))s）"
    logline "本机 443 OK：证书握手 + /healthz 200（$(( $(date +%s) - start ))s）"
  fi

  if (( DRILL )); then
    echo; echo "演练成功（$(( $(date +%s) - start ))s）：443 可达、自签证书握手成功、/healthz 200。不要改 DNS。执行  $0 --revert --drill  恢复。"
    return 0
  fi

  cat <<EOF

================================================================================
  本机已监听 0.0.0.0:443，ufw 已放行。现在去改 DNS（脚本不代劳）：
  dash.cloudflare.com → ${DOMAIN} → DNS → Records，对下列每个名字：${HOSTS[*]}
    现为 CNAME → <tunnel-uuid>.cfargotunnel.com（Proxied）；改成  A  ${ip}  TTL Auto
EOF
  case "$MODE" in
    origin-ca) cat <<EOF
    Proxy status 保持 **Proxied（橙云）**：Origin CA 证书只被 Cloudflare 边缘信任，灰云直连浏览器会报证书错误。
    前提：SSL/TLS 模式已是 Full (strict)（否则边缘不会校验 Origin CA，但也能通）。WAF/限流/DDoS 在这条路径全部继续生效。
EOF
    ;;
    acme) cat <<EOF
    第一步：Proxy status = **DNS only（灰云）**——Let's Encrypt 要直连本机 443 做 TLS-ALPN-01；橙云下验证会失败。
    第二步：下面轮询显示证书就位后，可改回 Proxied（橙云）恢复 WAF/DDoS；前提是 SSL/TLS 模式已是 Full (strict)。
    $( (( STAGING )) && echo "[staging] 证书由 LE staging 签发，浏览器不信任，仅用于演练。" )
EOF
    ;;
  esac
  echo "================================================================================"; echo
  logline "轮询公网 https://${HOST}/healthz（等你改 DNS + 传播），最多 ${POLL_MINUTES} 分钟"
  if poll "https://${HOST}/healthz（公网）" $(( $(date +%s) + POLL_MINUTES * 60 )) "https://${HOST}/healthz"; then
    logline "break-glass 生效：https://${HOST} 公网可用（$(( $(date +%s) - start ))s）"
    notify_ok "break-glass 生效 / active（${MODE}）：https://${HOST} 已直连 / now direct to ${ip}:443（用时 / took $(( $(date +%s) - start ))s）。Tunnel 恢复后执行 --revert 并把 DNS 改回 CNAME / when the Tunnel is back: run --revert and restore the CNAME"
    return 0
  fi
  logline "本机侧已就位但公网仍不通。常见：DNS 还没改/没传播、acme 模式下还是橙云、LE 限速（看 docker compose logs caddy）、hPanel 外层防火墙挡 443"
  notify_fail "break-glass：本机 443 已就位，但 ${POLL_MINUTES} 分钟内 https://${HOST} 公网仍不可达，需人工排查（DNS 改了吗？） / local 443 is up but https://${HOST} still unreachable after ${POLL_MINUTES} min; check DNS"
  exit 1
}

do_revert() {
  logline "revert（drill=${DRILL}）"
  compose up -d --no-deps --force-recreate caddy >>"$LOG" 2>&1 || die "caddy 恢复失败，见 $LOG"
  ufw_delete_443; rm -f "$MARKER" "$OVERRIDE" "$BG_CADDYFILE"
  if (( DRILL )); then echo "已恢复：443 关闭，Caddy 回到主 Caddyfile。"; return 0; fi
  cat <<EOF

================================================================================
  本机 443 已关闭，Caddy 已回到 Tunnel-only（:80 内网）。把 DNS 改回去：
  dash.cloudflare.com → ${DOMAIN} → DNS → Records → ${HOSTS[*]}：删除 A 记录，恢复 CNAME → <tunnel-uuid>.cfargotunnel.com（Proxied）。
  最省事：Zero Trust → Networking → Tunnels → bianfa-prod → Routes，把这些 Published application 删掉再加一次，CNAME 自动重建。
  验证：dig +short ${HOST} @1.1.1.1 是 Cloudflare 边缘 IP；curl -fsS https://${HOST}/healthz 200。
================================================================================
EOF
  notify_ok "break-glass 已退出 / reverted：443 关闭、Caddy 回到 Tunnel-only / 443 closed, Caddy back to Tunnel-only。记得把 ${HOSTS[*]} 的 DNS 改回 CNAME / restore the CNAME for ${HOSTS[*]}"
}

case "$ACTION" in enter) do_enter ;; revert) do_revert ;; status) do_status ;; esac
exit 0

# 演练（写在脚本里，因为事故当天你不会去翻 wiki）
# 1) 季度（≈2 分钟；不改 DNS、不碰证书签发；线上流量仍走 Tunnel → caddy:80）：
#      sudo break-glass.sh --drill  →  sudo break-glass.sh --revert --drill
#    验证：ufw 出现/消失 443 规则；docker ps 里 caddy 出现/消失 0.0.0.0:443->443；主 Caddyfile / compose 未被改动（git status 干净）。
# 2) 半年（维护窗口，真实 DNS 切换，≈10 分钟）：--mode origin-ca（或没有证书时 --mode acme --staging）→ 按提示改 A 记录 →
#      轮询通过 → --revert → DNS 改回 CNAME。记录从执行到 healthz 200 的秒数；目标 ≤ 5 分钟。
# 3) 事故真来时：不要先读注释。直接 sudo break-glass.sh，按屏幕提示改 DNS。
# 4) Origin CA 证书到期（15 年）前重签：openssl x509 -in /srv/bianfa/secrets/origin-ca.pem -noout -enddate；--status 也会打印。
