#!/usr/bin/env bash
# 一次性（幂等）创建桌面端 OAuth 公共客户端 bianfa-desktop：用当前 TAG 的 api 镜像里的 dist/auth-bootstrap.js，
# 以 bianfa_app 经 PgBouncer 写 oauthClient 表。首次部署跑一次；重复执行只会更新同一条记录。
set -euo pipefail
BIANFA_ROOT="${BIANFA_ROOT:-/srv/bianfa}"
BIANFA_REPO="${BIANFA_REPO:-$BIANFA_ROOT/app}"
COMPOSE_DIR="${COMPOSE_DIR:-$BIANFA_REPO/infra/docker}"
ENV_FILE="${ENV_FILE:-$BIANFA_ROOT/.env.prod}"
compose() { docker compose --project-directory "$COMPOSE_DIR" --env-file "$ENV_FILE" "$@"; }
# 用当前已部署的 tag（deploy.sh 成功后写 .tag.current），而不是 .env.prod 里可能过时的 TAG
CUR="$(tr -d '[:space:]' < "$BIANFA_ROOT/.tag.current" 2>/dev/null || true)"
[[ -n "$CUR" ]] && export TAG="$CUR"
echo "使用镜像 tag：${TAG:-<.env.prod 中的 TAG>}"
compose run --rm --no-deps -T api node dist/auth-bootstrap.js
