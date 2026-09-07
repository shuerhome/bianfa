#!/usr/bin/env bash
# 平台总管理员名单的运维入口（迁移 0009）。
#
#   ./platform-admin.sh list
#   ./platform-admin.sh grant you@example.com "首个总管理员"
#   ./platform-admin.sh revoke someone@example.com
#
# 走 worker 容器而不是 api 容器：platform_admin 表开了 RLS 且只有 SELECT 策略，
# api 用的 bianfa_app 是 NOBYPASSRLS 写不进去；worker 的 DATABASE_URL 是 bianfa_worker（BYPASSRLS）。
# 这也正是这套设计想要的性质 —— api 进程即使被完全攻陷，也铸不出一个新的总管理员。
set -euo pipefail
BIANFA_ROOT="${BIANFA_ROOT:-/srv/bianfa}"
BIANFA_REPO="${BIANFA_REPO:-$BIANFA_ROOT/app}"
COMPOSE_DIR="${COMPOSE_DIR:-$BIANFA_REPO/infra/docker}"
ENV_FILE="${ENV_FILE:-$BIANFA_ROOT/.env.prod}"
compose() { docker compose --project-directory "$COMPOSE_DIR" --env-file "$ENV_FILE" "$@"; }

if [[ $# -lt 1 ]]; then
  echo "用法：$0 list | grant <邮箱> [备注] | revoke <邮箱>" >&2
  exit 2
fi

# .env.prod 是 root:root 0600（infra/vps/bootstrap.sh），非 root 跑只会拿到一句 docker compose 的读取错误
[[ $EUID -eq 0 ]] || { echo "请用 sudo 运行（要读 $ENV_FILE）" >&2; exit 1; }

# 用当前已部署的 tag（deploy.sh 成功后写 .tag.current），而不是 .env.prod 里可能过时的 TAG
CUR="$(tr -d '[:space:]' < "$BIANFA_ROOT/.tag.current" 2>/dev/null || true)"
# 命令行前置的 TAG= 优先：镜像里还没有 dist/platform-admin.js 时，可以 TAG=<新 tag> 临时指定一次
[[ -n "$CUR" ]] && export TAG="${TAG:-$CUR}"
echo "使用镜像 tag：${TAG:-<.env.prod 中的 TAG>}"
compose run --rm --no-deps -T worker node dist/platform-admin.js "$@"
