#!/usr/bin/env bash
# =============================================================================
# infra/vps/restore.sh —— 灾难恢复：新机上把 prod 从 R2 备份拉起来，并把 Tunnel 切到新机（分步、带确认、计时）
# 来源：第 9 章 8.7：开新机 → clone + compose up（含 pg 镜像构建）→ pgBackRest restore → Tunnel 指向新机（不改 DNS）。RTO ≤ 40 min。
#       桌面端 offline-first，宕机期间用户照常写便笺，所以这里追求「确定性」不追求「快」。也可在本机做 PITR（--target-time）。
# 用法（root）：restore.sh [--repo <git-url>] [--git-ref main] [--tag <镜像 TAG>] [--env-from /path/rendered.env.prod]
#                        [--target-time '2026-09-05 02:00:00+00'] [--set <backup-label>] [--skip-amcheck] [--yes]
# 前置：新机已 `bootstrap.sh --prepare`（先不要 --lockdown，恢复完、Access SSH 验证过再锁）。手边有：仓库地址（私有仓库带凭据
#   的 URL 或 root 的 deploy key）、.env.prod 内容（CF_TUNNEL_TOKEN 同一个 tunnel；PGBACKREST_* 口令与 R2 key）、上次部署的镜像 TAG。
# 必须人工替换：无。可选：infra/vps/restore-checks.sql 放业务校验 SQL（用户数/便笺数/24h 写入量），存在则执行。
# 「把 tunnel 指到新机」：远程管理 tunnel 由 token 标识，新机用同一 token 起 cloudflared 就以新 connector 加入同一 tunnel，路由不用改
#   （tunnel-setup.md §1）。要做的是：(a) 确保旧机 cloudflared 已死透——否则两台同时在线，Cloudflare 按地理最近分流，写入分叉比停机
#   严重；(b) 旧机状态不明时先 Networking → Tunnels → 该 tunnel → Overview → Refresh token，新 token 写进新机 .env.prod。
#   SSH 用的 bianfa-ssh tunnel 是宿主机 systemd（bootstrap.sh 的 CF_TUNNEL_TOKEN_SSH），同理。
# 恢复后本机 SSH host key 变了：CI 的 known_hosts / VPS_SSH_HOST_KEY 要更新。
# PGDATA：postgres:18 镜像默认 PGDATA=/var/lib/postgresql/18/docker、VOLUME=/var/lib/postgresql（已核实 docker-library/postgres
#   18/trixie/Dockerfile：「in 18+, PGDATA has changed … VOLUME has moved from /var/lib/postgresql/data to /var/lib/postgresql」）。
#   第 9 章 8.5/8.7 写的 /var/lib/postgresql/data 是 17 及以前的路径。本脚本从容器环境读 PGDATA，不硬编码；compose 的卷挂载与
#   pg/pgbackrest.conf 的 pg1-path 必须与容器里的 PGDATA 一致，否则 restore 会写到错的目录。
# =============================================================================
set -euo pipefail

BIANFA_ROOT="${BIANFA_ROOT:-/srv/bianfa}"
BIANFA_REPO="${BIANFA_REPO:-$BIANFA_ROOT/app}"
COMPOSE_DIR="${COMPOSE_DIR:-$BIANFA_REPO/infra/docker}"
ENV_FILE="${ENV_FILE:-$BIANFA_ROOT/.env.prod}"
LOG_DIR="${LOG_DIR:-$BIANFA_ROOT/log}"
RUN_DIR="${RUN_DIR:-$BIANFA_ROOT/run}"
TAG_FILE="${TAG_FILE:-$BIANFA_ROOT/.tag.current}"
STANZA="${STANZA:-bianfa}"
PG_SERVICE="${PG_SERVICE:-postgres}"
OPS_USER="${OPS_USER:-ops}"
CHECKS_SQL="${CHECKS_SQL:-$BIANFA_REPO/infra/vps/restore-checks.sql}"

GIT_URL=""; GIT_REF="main"; TAG=""; ENV_FROM=""; TARGET_TIME=""; BACKUP_SET=""; SKIP_AMCHECK=0; ASSUME_YES=0
while (( $# )); do
  case "$1" in
    --repo) GIT_URL="$2"; shift ;;       --git-ref) GIT_REF="$2"; shift ;;   --tag) TAG="$2"; shift ;;
    --env-from) ENV_FROM="$2"; shift ;;  --target-time) TARGET_TIME="$2"; shift ;;  --set) BACKUP_SET="$2"; shift ;;
    --skip-amcheck) SKIP_AMCHECK=1 ;;    --yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "未知参数 $1" >&2; exit 64 ;;
  esac
  shift
done
[[ $EUID -eq 0 ]] || { echo "请以 root 执行" >&2; exit 1; }
mkdir -p "$LOG_DIR" "$RUN_DIR"
LOG="$LOG_DIR/restore.log"; T0=$(date +%s); T_STEP=$T0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./notify.sh
source "$SCRIPT_DIR/notify.sh"

ts() { date -u +%FT%TZ; }
logline() { printf '%s %s\n' "$(ts)" "$*" | tee -a "$LOG" >&2; }
die() { logline "FAIL: $*"; notify_fail "灾难恢复中断 / disaster restore aborted：$*" "$(tail -n 20 "$LOG" 2>/dev/null || true)"; exit 1; }
step() {   # 打印上一步耗时与累计耗时
  local now; now=$(date +%s)
  printf '\n\033[1;34m==> [+%3ds / 累计 %4ds] %s\033[0m\n' "$(( now - T_STEP ))" "$(( now - T0 ))" "$*"
  printf '%s STEP %s (+%ds, total %ds)\n' "$(ts)" "$*" "$(( now - T_STEP ))" "$(( now - T0 ))" >> "$LOG"
  T_STEP=$now
}
confirm() { (( ASSUME_YES )) && return 0; local a; read -r -p "$1 [y/N] " a; [[ "$a" == y || "$a" == Y ]] || die "用户取消：$1"; }
ask()     { (( ASSUME_YES )) && return 0; local a; read -r -p "$1 [y/N] " a; [[ "$a" == y || "$a" == Y ]]; }
compose() { docker compose --project-directory "$COMPOSE_DIR" --env-file "$ENV_FILE" "$@"; }
psql_q()  { compose exec -T -u postgres "$PG_SERVICE" psql -X -v ON_ERROR_STOP=1 -tA -c "$1"; }
# root 操作 ops 所有的仓库会触发 git 的 dubious-ownership 保护（git ≥ 2.35.2），用 safe.directory 放行这一处
git_repo() { git -c "safe.directory=$BIANFA_REPO" -C "$BIANFA_REPO" "$@"; }
# 在 postgres 镜像里跑一条 sh（不经 docker-entrypoint.sh，不起 PG）
pg_sh() { compose run --rm --no-deps -T --entrypoint sh "$PG_SERVICE" -c "$1"; }

step "0/8 前置检查"
[[ -f /var/lib/bianfa/prepared ]]    || logline "警告：没找到 /var/lib/bianfa/prepared，看起来没跑过 bootstrap.sh --prepare"
[[ -f /var/lib/bianfa/locked_down ]] && logline "提示：本机已 lockdown；确认你现在是经 Access SSH 进来的"
systemctl is-active --quiet docker || die "docker 未运行"
docker compose version >/dev/null 2>&1 || die "docker compose 不可用"
id -u "$OPS_USER" >/dev/null 2>&1 || die "没有用户 ${OPS_USER}（先跑 bootstrap.sh --prepare）"
cat <<EOF
  仓库 ${GIT_URL:-<沿用 ${BIANFA_REPO}>} @ ${GIT_REF} · 镜像 TAG ${TAG:-<从 ${TAG_FILE} 或交互输入>}
  时间点 ${TARGET_TIME:-<最新：回放全部可用 WAL>} · 备份集 ${BACKUP_SET:-<自动选择>}
EOF
confirm "开始恢复？"

step "1/8 获取仓库"
if [[ -d "$BIANFA_REPO/.git" ]]; then
  git_repo fetch -q --all --tags
  git_repo checkout -q -f "$GIT_REF"
  git_repo pull -q --ff-only 2>/dev/null || true     # detached（tag）时失败，忽略
else
  [[ -n "$GIT_URL" ]] || die "本机没有 ${BIANFA_REPO}，需要 --repo <git-url>"
  install -d -m 755 -o "$OPS_USER" -g "$OPS_USER" "$BIANFA_ROOT"
  git clone -q --branch "$GIT_REF" "$GIT_URL" "$BIANFA_REPO"
fi
chown -R "$OPS_USER:$OPS_USER" "$BIANFA_REPO"
[[ -d "$COMPOSE_DIR" ]] || die "仓库里没有 ${COMPOSE_DIR}"
logline "代码就位：$(git_repo rev-parse --short HEAD 2>/dev/null || echo '?')"

step "2/8 环境文件"
[[ -n "$ENV_FROM" ]] && install -o root -g root -m 600 "$ENV_FROM" "$ENV_FILE"
[[ -f "$ENV_FILE" ]] || die "缺少 ${ENV_FILE}：用 --env-from <渲染好的文件>，或手工 install -m600 后重跑"
chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
if grep -q REPLACE_ME "$ENV_FILE"; then grep -n REPLACE_ME "$ENV_FILE" | cut -d= -f1 >&2; die "${ENV_FILE} 仍有占位符"; fi
ln -sfn "$ENV_FILE" "$COMPOSE_DIR/.env.prod"
for k in CF_TUNNEL_TOKEN PGBACKREST_REPO1_CIPHER_PASS PGBACKREST_REPO1_S3_KEY PGBACKREST_REPO1_S3_KEY_SECRET; do
  grep -qE "^${k}=." "$ENV_FILE" || die "${ENV_FILE} 缺少 ${k}"
done
echo "  提醒：旧机可能还活着的话，现在去 Zero Trust → Networking → Tunnels → bianfa-prod → Overview → Refresh token，把新 token 写进 .env.prod 再继续。"
confirm "已确认旧机 cloudflared 不会再连上同一个 tunnel（旧机已销毁 / 已 Refresh token）？"

step "3/8 镜像 TAG"
[[ -z "$TAG" && -s "$TAG_FILE" ]] && TAG=$(tr -d '[:space:]' < "$TAG_FILE")
if [[ -z "$TAG" ]]; then
  (( ASSUME_YES )) && die "需要 --tag（非交互模式）"
  read -r -p "输入要恢复的镜像 TAG（GitHub Releases 或 Telegram 最后一条 deploy 成功消息）：" TAG
fi
[[ "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "非法 TAG: ${TAG}"
export TAG; printf '%s\n' "$TAG" > "$TAG_FILE"
compose config -q 2>>"$LOG" || die "compose 配置校验失败，见 ${LOG}"
compose config --services | grep -qx "$PG_SERVICE" || die "compose 里没有服务 ${PG_SERVICE}"

step "4/8 拉取镜像 + 构建自建镜像（postgres：pgvector + pg_bigm + pgbackrest）"
# --ignore-buildable：跳过有 build: 的服务（已核实 compose pull 选项）；build 不带服务名 = 构建所有带 build: 的服务
compose pull --quiet --ignore-buildable >>"$LOG" 2>&1 || die "镜像拉取失败（ghcr 不可达或 TAG=${TAG} 不存在）"
compose build --quiet >>"$LOG" 2>&1 || die "镜像构建失败，见 ${LOG}"

step "5/8 pgBackRest restore"
PGDATA=$(pg_sh 'printf %s "$PGDATA"' 2>>"$LOG" | tr -d '\r')
[[ -n "$PGDATA" ]] || die "读不到 postgres 容器的 PGDATA"
logline "PGDATA=${PGDATA}（pg/pgbackrest.conf 的 pg1-path 与 compose 卷挂载必须与它一致）"
if compose ps --services --status running 2>/dev/null | grep -qx "$PG_SERVICE"; then
  confirm "postgres 容器正在运行，restore 前必须停掉。停止？"; compose stop "$PG_SERVICE" >>"$LOG" 2>&1
fi
# 数据目录必须存在且属 postgres（新卷从镜像复制已有目录；这里兜底），非空则问是否 --delta
pg_sh "install -d -o postgres -g postgres -m 700 '${PGDATA}'" >>"$LOG" 2>&1 || die "无法创建 ${PGDATA}"
RESTORE_ARGS=(restore --log-level-console=info)
if pg_sh "[ -n \"\$(ls -A '${PGDATA}' 2>/dev/null)\" ]" >/dev/null 2>&1; then
  confirm "数据目录 ${PGDATA} 非空。用 --delta 按校验和覆盖恢复（现有数据将被备份内容替换）？"; RESTORE_ARGS+=(--delta)
fi
[[ -n "$BACKUP_SET" ]]  && RESTORE_ARGS+=(--set="$BACKUP_SET")
[[ -n "$TARGET_TIME" ]] && RESTORE_ARGS+=(--type=time "--target=${TARGET_TIME}" --target-action=promote)
logline "pgbackrest --stanza=${STANZA} ${RESTORE_ARGS[*]}"
# 凭据经 compose env_file 进容器；以 postgres 用户执行，直接写卷。restore 会写 postgresql.auto.conf（restore_command）+ recovery.signal
compose run --rm --no-deps -T -u postgres --entrypoint pgbackrest "$PG_SERVICE" --stanza="$STANZA" "${RESTORE_ARGS[@]}" 2>&1 | tee -a "$LOG" \
  || die "pgbackrest restore 失败（口令错？R2 key 错？stanza 名？pg1-path≠PGDATA？见 ${LOG}）"

step "6/8 启动 PostgreSQL、回放 WAL、校验"
compose up -d --no-deps "$PG_SERVICE" >>"$LOG" 2>&1
for i in $(seq 1 120); do
  compose exec -T -u postgres "$PG_SERVICE" pg_isready -q 2>/dev/null && break
  (( i == 120 )) && die "PostgreSQL 10 分钟内没就绪，看 docker compose logs ${PG_SERVICE}"; sleep 5
done
# 最新恢复：回放完全部归档 WAL 后自动 promote；--target-time 时由 --target-action=promote 结束恢复
for i in $(seq 1 360); do
  [[ "$(psql_q "select pg_is_in_recovery()" 2>/dev/null || echo '?')" == "f" ]] && break
  (( i == 360 )) && die "30 分钟后仍在 recovery；看 postgres 日志（restore_command 从 R2 拉 WAL 失败？）"; sleep 5
done
logline "已 promote；timeline=$(psql_q "select timeline_id from pg_control_checkpoint()" 2>/dev/null || echo '?')"
if (( ! SKIP_AMCHECK )); then
  if compose exec -T -u postgres "$PG_SERVICE" sh -c 'command -v pg_amcheck' >/dev/null 2>&1; then
    # --install-missing：库里没建 amcheck 扩展时自动建（以 postgres 超级用户执行）
    compose exec -T -u postgres "$PG_SERVICE" pg_amcheck --all --install-missing --jobs=2 2>&1 | tee -a "$LOG" | tail -n 5 \
      || die "pg_amcheck 报错（索引/堆损坏？考虑 --set 用更早的备份）"
  else
    logline "镜像里没有 pg_amcheck，跳过"
  fi
fi
psql_q "select datname || ' ' || pg_size_pretty(pg_database_size(datname)) from pg_database where not datistemplate" | tee -a "$LOG"
psql_q "select 'user_tables=' || count(*) from pg_stat_user_tables" | tee -a "$LOG"
if [[ -f "$CHECKS_SQL" ]]; then
  compose exec -T -u postgres "$PG_SERVICE" psql -X -v ON_ERROR_STOP=1 -tA < "$CHECKS_SQL" | tee -a "$LOG" || die "业务校验 SQL 失败"
else
  logline "没有 ${CHECKS_SQL}（用户数/便笺数/24h 写入量），建议补上"
fi
confirm "校验结果正确？继续启动全部服务（含 cloudflared，新 connector 加入 tunnel 开始接流量）"

step "7/8 启动全部服务（cloudflared ×2 加入同一 tunnel）"
compose up -d --wait --wait-timeout 300 >>"$LOG" 2>&1 || { compose ps -a 2>&1 | tee -a "$LOG"; die "有服务未健康，见 docker compose ps / logs"; }
compose ps 2>&1 | tee -a "$LOG"
DOMAIN=$(grep -E '^BIANFA_DOMAIN=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '"' || true)
if [[ -n "$DOMAIN" ]]; then
  for i in 1 2 3 4 5 6; do
    curl -fsS --max-time 10 "https://api.${DOMAIN}/healthz" >/dev/null 2>&1 && { logline "外部 https://api.${DOMAIN}/healthz OK"; break; }
    (( i == 6 )) && logline "警告：外部 healthz 仍不通。到 Zero Trust → Networking → Tunnels 看 connector 是否已注册为本机"; sleep 10
  done
fi

step "8/8 收尾：cron + 新 timeline 上的第一份全量备份"
[[ -f "$BIANFA_REPO/infra/vps/cron.d/bianfa" ]] && install -m 644 -o root -g root "$BIANFA_REPO/infra/vps/cron.d/bianfa" /etc/cron.d/bianfa
if ask "现在做一次 pgbackrest full（新 timeline 上的第一份完整备份，强烈建议）？"; then
  "$BIANFA_REPO/infra/vps/backup.sh" full || logline "full 备份失败，记得手工补：backup.sh full"
else
  logline "跳过 full 备份，记得手工补：backup.sh full"
fi

TOTAL=$(( $(date +%s) - T0 ))
cat <<EOF

================================================================================
  恢复完成，用时 ${TOTAL}s（RTO 目标 ≤ 2400s）。剩余人工事项：
  [ ] 控制台 Tunnels → bianfa-prod：connector 只剩本机（2 个，同一 Origin IP）；bianfa-ssh：本机 systemd cloudflared 在线
  [ ] 客户端实测登录 + 同步一条便笺
  [ ] 经 Access SSH 登录成功后执行 bootstrap.sh --lockdown（本机公网 22 可能还开着）
  [ ] 更新 CI 的 known_hosts / VPS_SSH_HOST_KEY（cat /etc/ssh/ssh_host_ed25519_key.pub）   [ ] Alloy 在新机上报，7 条告警仍生效
  [ ] Origin CA 证书放回 /srv/bianfa/secrets/（break-glass 首选模式要用）
  [ ] Hostinger 新机开每周快照；销毁旧机前再快照一份   [ ] 事后复盘：为什么挂、RTO 实测、哪一步卡住
================================================================================
EOF
notify_ok "灾难恢复完成 / disaster restore done：TAG=${TAG}，时间点 / target=${TARGET_TIME:-latest}，用时 / took ${TOTAL}s。剩余人工清单见 restore.sh 输出 / remaining manual steps: see restore.sh output"
exit 0
