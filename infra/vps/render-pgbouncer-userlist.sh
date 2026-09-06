#!/usr/bin/env bash
# 把 .env.prod 里的 PG_APP_* / PG_WORKER_* 渲染成 PgBouncer userlist（"user" "password" 每行一个），
# 供 compose 的 configs.pgbouncer_userlist.file 只读挂载。幂等；权限 0400、属主 70:70（容器内 pgbouncer 用户）；密码不出现在命令行/日志。
# 由 pg-roles.sh 与 deploy.sh 自动调用；改了库密码后重跑本脚本再 `dc up -d --force-recreate pgbouncer`。
set -euo pipefail
BIANFA_ROOT="${BIANFA_ROOT:-/srv/bianfa}"
ENV_FILE="${ENV_FILE:-$BIANFA_ROOT/.env.prod}"
OUT="${PGBOUNCER_USERLIST_FILE:-$BIANFA_ROOT/pgbouncer-userlist.txt}"
[[ -r "$ENV_FILE" ]] || { echo "缺少 $ENV_FILE" >&2; exit 1; }
getv() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2- | tr -d '"'; }
APP_USER=$(getv PG_APP_USER); APP_USER="${APP_USER:-bianfa_app}"; APP_PW=$(getv PG_APP_PASSWORD)
WRK_USER=$(getv PG_WORKER_USER); WRK_USER="${WRK_USER:-bianfa_worker}"; WRK_PW=$(getv PG_WORKER_PASSWORD)
for v in APP_PW WRK_PW; do
  [[ -n "${!v}" && "${!v}" != *REPLACE_ME* ]] || { echo "$ENV_FILE 里 ${v/_PW/_PASSWORD} 未填" >&2; exit 1; }
done
umask 077
tmp="$(mktemp "${OUT}.XXXXXX")"
printf '"%s" "%s"\n"%s" "%s"\n' "$APP_USER" "$APP_PW" "$WRK_USER" "$WRK_PW" > "$tmp"
# compose 对 configs 的 uid/gid/mode 不生效（首台机器实测被忽略）：文件在容器里保持宿主机属主，
# 而 pgbouncer 进程是 uid 70（alpine postgres），所以宿主机上直接把文件给 70:70、0400，root 仍可读写。
chown 70:70 "$tmp" 2>/dev/null || true
chmod 0400 "$tmp"; mv -f "$tmp" "$OUT"
echo "userlist 已写入 $OUT（$(wc -l < "$OUT") 个用户）"
