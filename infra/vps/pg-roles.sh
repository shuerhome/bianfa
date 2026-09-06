#!/usr/bin/env bash
# 已在运行的 PostgreSQL 上幂等同步应用角色（与 infra/docker/pg/initdb/01-roles-and-extensions.sh 同口径）。
# 用途：initdb 只在空数据目录首次启动时执行；之后新增角色（如 bianfa_worker）或改密码，都用本脚本。
# 用法：infra/vps/pg-roles.sh            （读 /srv/bianfa/.env.prod 里的 PG_*_PASSWORD，在 postgres 容器内以超级用户执行）
# 安全：密码只从 .env.prod 读并以 psql 变量传入，不出现在命令行/日志。
set -euo pipefail
BIANFA_ROOT="${BIANFA_ROOT:-/srv/bianfa}"
BIANFA_REPO="${BIANFA_REPO:-$BIANFA_ROOT/app}"
COMPOSE_DIR="${COMPOSE_DIR:-$BIANFA_REPO/infra/docker}"
ENV_FILE="${ENV_FILE:-$BIANFA_ROOT/.env.prod}"
[[ -r "$ENV_FILE" ]] || { echo "缺少 $ENV_FILE" >&2; exit 1; }
getv() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2- | tr -d '"'; }
DB=$(getv POSTGRES_DB); DB="${DB:-bianfa}"
APP_USER=$(getv PG_APP_USER); APP_USER="${APP_USER:-bianfa_app}"; APP_PW=$(getv PG_APP_PASSWORD)
WRK_USER=$(getv PG_WORKER_USER); WRK_USER="${WRK_USER:-bianfa_worker}"; WRK_PW=$(getv PG_WORKER_PASSWORD)
EXP_USER=$(getv PG_EXPORTER_USER); EXP_USER="${EXP_USER:-bianfa_exporter}"; EXP_PW=$(getv PG_EXPORTER_PASSWORD)
for v in APP_PW WRK_PW EXP_PW; do
  [[ -n "${!v}" && "${!v}" != *REPLACE_ME* ]] || { echo "$ENV_FILE 里 ${v/_PW/_PASSWORD} 未填" >&2; exit 1; }
done
compose() { docker compose --project-directory "$COMPOSE_DIR" --env-file "$ENV_FILE" "$@"; }

compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d "$DB" \
  -v app_user="$APP_USER" -v app_pw="$APP_PW" -v wrk_user="$WRK_USER" -v wrk_pw="$WRK_PW" \
  -v exp_user="$EXP_USER" -v exp_pw="$EXP_PW" -v dbname="$DB" <<'SQL'
-- 角色存在则只改密码/属性，不存在则创建（CREATE ROLE 无 IF NOT EXISTS；psql 变量在 $$ 里不展开，故用 \gexec）
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 100', :'app_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS CONNECTION LIMIT 20', :'wrk_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'wrk_user') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'exp_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'exp_user') \gexec
ALTER ROLE :"app_user" LOGIN PASSWORD :'app_pw' NOBYPASSRLS CONNECTION LIMIT 100;
ALTER ROLE :"wrk_user" LOGIN PASSWORD :'wrk_pw' BYPASSRLS CONNECTION LIMIT 20;
ALTER ROLE :"exp_user" LOGIN PASSWORD :'exp_pw';
ALTER ROLE :"app_user" SET statement_timeout = '60s'; ALTER ROLE :"app_user" SET lock_timeout = '5s';
ALTER ROLE :"wrk_user" SET statement_timeout = '60s'; ALTER ROLE :"wrk_user" SET lock_timeout = '5s';
GRANT CONNECT, TEMPORARY ON DATABASE :"dbname" TO :"app_user", :"wrk_user";
GRANT CONNECT ON DATABASE :"dbname" TO :"exp_user";
GRANT USAGE ON SCHEMA public TO :"app_user", :"wrk_user";
GRANT pg_monitor TO :"exp_user";
-- 迁移由超级用户 postgres 执行：其后建的对象自动授予两个应用角色 DML
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user", :"wrk_user";
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :"app_user", :"wrk_user";
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO :"app_user", :"wrk_user";
-- 已存在的对象补一遍（迁移 0002/0003… 本身也会 GRANT，这里兜底）
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_user", :"wrk_user";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_user", :"wrk_user";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO :"app_user", :"wrk_user";
-- pg-boss：schema 归 app 角色（api 入队、sync-ws 入队），worker 在里面建表并消费；两向默认权限
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION :"app_user";
GRANT USAGE, CREATE ON SCHEMA pgboss TO :"wrk_user";
GRANT USAGE ON SCHEMA pgboss TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"app_user" IN SCHEMA pgboss GRANT ALL ON TABLES TO :"wrk_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"app_user" IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO :"wrk_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"app_user" IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO :"wrk_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"wrk_user" IN SCHEMA pgboss GRANT ALL ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"wrk_user" IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"wrk_user" IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO :"app_user";
GRANT ALL ON ALL TABLES IN SCHEMA pgboss TO :"app_user", :"wrk_user";
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO :"app_user", :"wrk_user";
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgboss TO :"app_user", :"wrk_user";
SELECT rolname, rolbypassrls, rolconnlimit FROM pg_roles WHERE rolname IN (:'app_user', :'wrk_user', :'exp_user') ORDER BY 1;
SQL
echo "角色已同步：$APP_USER / $WRK_USER / $EXP_USER（数据库 $DB）"
# PgBouncer 的 userlist 与库密码同源，一起刷新
"$(dirname "${BASH_SOURCE[0]}")/render-pgbouncer-userlist.sh"
