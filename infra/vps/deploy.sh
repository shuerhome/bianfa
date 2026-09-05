#!/usr/bin/env bash
# =============================================================================
# infra/vps/deploy.sh —— 生产部署（由 CI 经 Cloudflare Access SSH 调用，或运维手工执行）
#
#   CI：  ssh bianfa-prod deploy-with-env v1.2.3 < rendered.env.prod   # 经 deploy 用户的 forced command（deploy-entry.sh）
#   手工：sudo /srv/bianfa/app/infra/vps/deploy.sh v1.2.3 [--services "api sync-ws worker"] [--no-prune] [--env-from FILE]
#
# 来源：第 9 章 8.5 的 deploy.sh 原型。本版在其基础上补齐：
#   - 写 /srv/bianfa/.tag.current（成功后才写；回滚用的是写之前的旧值）
#   - `docker compose up --wait --wait-timeout` 健康检查失败 → 自动回滚到上一个 tag；两次结果都推 Telegram
#   - 拉镜像失败在改动任何容器之前就退出（ghcr 不可达 / tag 不存在时什么都不动）
#   - --env-from FILE：先把 CI 渲染好的 .env.prod 装到 /srv/bianfa/.env.prod（root:root 0600，旧文件留 .env.prod.prev），
#     这样 CI 不需要 scp（deploy 用户是 forced command，只有这一条路进来）
#   - 部署前后各一条 Telegram（notify.sh）
#   - docker image prune -af --filter until=168h（第 9 章：不清理镜像，50 GB 盘三个月就满）
#   - flock 防并发；部署记录追加到 /srv/bianfa/log/deploy.log
# 明确不追求零停机：Compose 对同一服务多副本是同时重建不是滚动（第 9 章 8.5），接受约 5 秒 API 中断，
# 桌面端 offline-first + 指数退避重试兜底。
# 必须人工替换：无。路径可用环境变量覆盖（见下方默认值）。
# 前置：compose 文件里应用镜像用 ${TAG} 引用；服务名 api / sync-ws / worker（第 9 章 8.5；sync-ws = Hocuspocus，C2）。
#      基础设施（postgres/pgbouncer/redis/caddy/cloudflared）不在部署路径上，升级它们走维护窗口。
# =============================================================================
set -euo pipefail

BIANFA_ROOT="${BIANFA_ROOT:-/srv/bianfa}"
BIANFA_REPO="${BIANFA_REPO:-$BIANFA_ROOT/app}"
COMPOSE_DIR="${COMPOSE_DIR:-$BIANFA_REPO/infra/docker}"
ENV_FILE="${ENV_FILE:-$BIANFA_ROOT/.env.prod}"
LOG_DIR="${LOG_DIR:-$BIANFA_ROOT/log}"
RUN_DIR="${RUN_DIR:-$BIANFA_ROOT/run}"
TAG_FILE="${TAG_FILE:-$BIANFA_ROOT/.tag.current}"
SERVICES="${SERVICES:-api sync-ws worker}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-120}"
PRUNE_UNTIL="${PRUNE_UNTIL:-168h}"
# .env.prod 里至少要有的键（--env-from 时校验，防止 CI 渲染模板漏了 secret 名）
ENV_REQUIRED_KEYS="${ENV_REQUIRED_KEYS:-TAG BIANFA_DOMAIN CF_TUNNEL_TOKEN POSTGRES_PASSWORD}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./notify.sh
source "$SCRIPT_DIR/notify.sh"

usage() { echo "用法: $0 <TAG> [--services \"api sync-ws worker\"] [--no-prune] [--env-from FILE]"; }

TAG_NEW="${1:-}"; shift || true
NO_PRUNE=0; ENV_FROM=""
while (( $# )); do
  case "$1" in
    --services) SERVICES="$2"; shift 2 ;;
    --no-prune) NO_PRUNE=1; shift ;;
    --env-from) ENV_FROM="$2"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *) usage >&2; exit 64 ;;
  esac
done
[[ -n "$TAG_NEW" ]] || { usage >&2; exit 64; }
[[ "$TAG_NEW" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "非法 TAG: $TAG_NEW" >&2; exit 64; }
[[ $EUID -eq 0 ]] || { echo "请用 sudo 执行" >&2; exit 1; }
[[ -d "$COMPOSE_DIR" ]] || { echo "缺少 compose 目录 $COMPOSE_DIR" >&2; exit 1; }
mkdir -p "$LOG_DIR" "$RUN_DIR"

exec 9>"$RUN_DIR/deploy.lock"
flock -n 9 || { echo "另一个部署正在进行（$RUN_DIR/deploy.lock）" >&2; exit 75; }

LOG="$LOG_DIR/deploy.log"
ts() { date -u +%FT%TZ; }
logline() { printf '%s %s\n' "$(ts)" "$*" | tee -a "$LOG" >&2; }

# --env-from：校验后原子替换 .env.prod（在任何 compose 操作之前）
if [[ -n "$ENV_FROM" ]]; then
  [[ -s "$ENV_FROM" ]] || { echo "--env-from 文件不存在或为空: $ENV_FROM" >&2; exit 1; }
  if grep -q 'REPLACE_ME' "$ENV_FROM"; then echo "$ENV_FROM 仍含 REPLACE_ME 占位符，拒绝安装" >&2; exit 1; fi
  for k in $ENV_REQUIRED_KEYS; do
    grep -qE "^${k}=." "$ENV_FROM" || { echo "$ENV_FROM 缺少 ${k}=…（CI 渲染模板漏了？）" >&2; exit 1; }
  done
  [[ -f "$ENV_FILE" ]] && cp -a "$ENV_FILE" "$ENV_FILE.prev"
  install -o root -g root -m 600 "$ENV_FROM" "$ENV_FILE"
  rm -f "$ENV_FROM"
  logline "已安装新的 $ENV_FILE（旧文件在 $ENV_FILE.prev）"
fi

[[ -r "$ENV_FILE" ]] || { echo "缺少 $ENV_FILE" >&2; exit 1; }
if grep -q 'REPLACE_ME' "$ENV_FILE"; then echo "$ENV_FILE 仍含 REPLACE_ME 占位符，拒绝部署" >&2; exit 1; fi
ln -sfn "$ENV_FILE" "$COMPOSE_DIR/.env.prod"     # compose 的 env_file: [.env.prod] 相对 compose 目录解析；.gitignore 要忽略它

compose() { docker compose --project-directory "$COMPOSE_DIR" --env-file "$ENV_FILE" "$@"; }

# 约定「一切变更走 git」：VPS 上手改过 compose/Caddyfile 只告警不阻断（事故时可能就是故意改的）
if command -v git >/dev/null && [[ -d "$BIANFA_REPO/.git" ]]; then
  dirty=$(git -c "safe.directory=$BIANFA_REPO" -C "$BIANFA_REPO" status --porcelain 2>/dev/null | grep -v 'infra/docker/\.env\.prod$' || true)
  [[ -z "$dirty" ]] || logline "警告：$BIANFA_REPO 工作区不干净（VPS 上手改过文件？）："$'\n'"$dirty"
fi

TAG_PREV=""
[[ -s "$TAG_FILE" ]] && TAG_PREV=$(tr -d '[:space:]' < "$TAG_FILE")
SSH_FROM="${SSH_CLIENT:-${SSH_CONNECTION:-local}}"; SSH_FROM="${SSH_FROM%% *}"
ACTOR="${SUDO_USER:-${USER:-root}}@${SSH_FROM}"
START=$(date +%s)

[[ "$TAG_PREV" == "$TAG_NEW" ]] && logline "TAG 未变化（$TAG_NEW），仍执行 up 以修复漂移"
logline "deploy start: ${TAG_PREV:-<none>} -> ${TAG_NEW} by ${ACTOR} services=[${SERVICES}]"
notify_info "deploy 开始：${TAG_PREV:-<none>} → ${TAG_NEW}（${SERVICES}）by ${ACTOR}"

export TAG="$TAG_NEW"

# 0) 校验 compose 文件 + 服务名，别在半路发现 YAML 坏了或服务名拼错
if ! compose config -q 2>>"$LOG"; then
  logline "compose config 校验失败"
  notify_fail "deploy ${TAG_NEW} 中止：compose 配置无效（见 deploy.log）"
  exit 2
fi
known_services=$(compose config --services 2>/dev/null || true)
for s in $SERVICES; do
  grep -qx "$s" <<<"$known_services" || { logline "compose 里没有服务 ${s}（已有：$(tr '\n' ' ' <<<"$known_services")）"; notify_fail "deploy ${TAG_NEW} 中止：compose 里没有服务 ${s}"; exit 2; }
done

# 1) 拉镜像：失败则什么都没改，直接退出
# shellcheck disable=SC2086
if ! compose pull --quiet $SERVICES >>"$LOG" 2>&1; then
  logline "镜像拉取失败，未改动任何容器"
  notify_fail "deploy ${TAG_NEW} 中止：镜像拉取失败（ghcr 不可达或 tag 不存在）" "$(tail -n 15 "$LOG")"
  exit 2
fi

rollback() {
  local reason="$1"
  compose ps -a >>"$LOG" 2>&1 || true
  # shellcheck disable=SC2086
  compose logs --no-color --tail 80 $SERVICES >>"$LOG" 2>&1 || true
  if [[ -z "$TAG_PREV" ]]; then
    logline "健康检查失败（${reason}）且没有上一个 tag，无法回滚；保持现状等待人工处理"
    notify_fail "deploy ${TAG_NEW} 失败（${reason}），且无上一个 tag 可回滚。需要人工介入。" "$(compose ps -a 2>&1 | tail -n 20)"
    exit 3
  fi
  logline "健康检查失败（${reason}），回滚到 ${TAG_PREV}"
  # shellcheck disable=SC2086
  if TAG="$TAG_PREV" compose up -d --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" $SERVICES >>"$LOG" 2>&1; then
    logline "回滚成功：现为 ${TAG_PREV}"
    notify_fail "deploy ${TAG_NEW} 失败（${reason}），已自动回滚到 ${TAG_PREV}。" "$(tail -n 40 "$LOG")"
    exit 1
  fi
  logline "回滚也失败了"
  notify_fail "deploy ${TAG_NEW} 失败，且回滚到 ${TAG_PREV} 也失败。生产可能不可用，立即人工介入。" "$(compose ps -a 2>&1 | tail -n 20)"
  exit 3
}

# 2) 重建应用服务并等健康（api 有 healthcheck；没有 healthcheck 的服务 --wait 只等到 running）
# shellcheck disable=SC2086
if ! compose up -d --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" $SERVICES >>"$LOG" 2>&1; then
  rollback "compose --wait 超时或容器不健康"
fi

# 3) 二次确认：容器内直接打 /healthz。用 node -e fetch 而不是 wget —— 与 compose 的 healthcheck 同一条命令，
#    不假设 node:24-alpine 镜像里有 wget（stack 审查指出两者不一致会误判回滚）。node 不存在（126/127）只记日志。
if grep -qx api <<<"$SERVICES" && compose ps --services --status running 2>/dev/null | grep -qx api; then
  rc=0
  compose exec -T api node -e "fetch('http://127.0.0.1:3000/healthz',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) ;;
    126|127) logline "api 容器内无 node 可执行（rc=$rc），跳过容器内二次探测" ;;
    *) rollback "api /healthz 探测失败（rc=$rc）" ;;
  esac
fi

# 4) 外部路径（经 Cloudflare Tunnel）：失败只告警不回滚——可能是边缘/Tunnel 的问题而不是这次镜像的问题
DOMAIN=$(grep -E '^BIANFA_DOMAIN=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '"' || true)
EXTERNAL_NOTE=""
if [[ -n "$DOMAIN" ]]; then
  if curl -fsS --max-time 10 --retry 3 --retry-delay 3 "https://api.${DOMAIN}/healthz" >/dev/null 2>&1; then
    EXTERNAL_NOTE="外部 /healthz OK"
  else
    EXTERNAL_NOTE="外部 https://api.${DOMAIN}/healthz 不通（容器内健康；怀疑 Tunnel/边缘）"
    notify_warn "deploy ${TAG_NEW}：${EXTERNAL_NOTE}"
  fi
fi

# 5) 记录当前 tag（原子写）
printf '%s
' "$TAG_NEW" > "$TAG_FILE.tmp" && chmod 0644 "$TAG_FILE.tmp" && mv -f "$TAG_FILE.tmp" "$TAG_FILE"   # 0644：deploy-entry.sh 的 current 子命令要能读
logline "deploy ok: ${TAG_NEW}（prev=${TAG_PREV:-<none>}）"

# 6) 清理镜像。-a：连带删除 7 天内没被任何容器使用的带 tag 旧镜像（只删 dangling 的话磁盘照样满）。
#    上一个 tag 的镜像通常 < 7 天，会保留；若已超期被删，回滚时从 ghcr 重新拉取。
if (( ! NO_PRUNE )); then
  docker image prune -af --filter "until=${PRUNE_UNTIL}" >>"$LOG" 2>&1 || true
  docker builder prune -f --filter "until=${PRUNE_UNTIL}" >>"$LOG" 2>&1 || true
fi

ELAPSED=$(( $(date +%s) - START ))
notify_ok "deploy 完成：${TAG_NEW}（prev ${TAG_PREV:-<none>}，${ELAPSED}s）${EXTERNAL_NOTE:+ · ${EXTERNAL_NOTE}}"
exit 0
