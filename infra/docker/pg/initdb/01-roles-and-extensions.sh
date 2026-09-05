#!/usr/bin/env bash
# =============================================================================
# bianfa · Postgres 首次初始化：扩展 + 应用角色 + 监控角色 + pg-boss schema
# -----------------------------------------------------------------------------
# 来源：第 1 章 C6（pg_bigm）/ C8（pg-boss 的 schema）/ S3（应用角色经 PgBouncer）；第 9 章 8.6（pg_stat_statements）；
#       第 10 章（应用角色非 owner → RLS 生效；statement_timeout 设在角色上，不设全局）。
# 运行时机：官方 entrypoint 只在 PGDATA 为空的**第一次**启动时执行 /docker-entrypoint-initdb.d/*.sh，
#          以 OS 用户 postgres 经 unix socket 连接（pg_hba local peer）。之后改角色/密码要手工 ALTER ROLE。
# 密码来源：compose 注入的 PG_APP_PASSWORD / PG_EXPORTER_PASSWORD，用 psql 变量 :'x' 传入，不拼接进 SQL 字串。
# 必须人工替换：无。
# =============================================================================
set -euo pipefail

: "${POSTGRES_DB:?}"
: "${PG_APP_USER:=bianfa_app}"
: "${PG_APP_PASSWORD:?PG_APP_PASSWORD 未设置}"
: "${PG_EXPORTER_USER:=bianfa_exporter}"
: "${PG_EXPORTER_PASSWORD:?PG_EXPORTER_PASSWORD 未设置}"

psql -v ON_ERROR_STOP=1 --no-password --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v app_user="$PG_APP_USER" -v app_pw="$PG_APP_PASSWORD" \
     -v exp_user="$PG_EXPORTER_USER" -v exp_pw="$PG_EXPORTER_PASSWORD" \
     -v dbname="$POSTGRES_DB" <<'SQL'
-- ---- 扩展（shared_preload_libraries 里的两个 .so 已由 Dockerfile 自检保证存在）----
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_bigm;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- 应用角色：api / sync-ws / worker 共用，经 PgBouncer；不是表 owner，RLS 对它生效 ----
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 100;                       -- PgBouncer 池 25+5 + sync-ws 直连 LISTEN，留余量
ALTER ROLE :"app_user" SET statement_timeout = '60s';    -- 全局不设（会误伤 pgbackrest/迁移），只卡应用角色
ALTER ROLE :"app_user" SET lock_timeout = '5s';
GRANT CONNECT, TEMPORARY ON DATABASE :"dbname" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";
-- 迁移由超级用户 postgres 执行；其在 public 新建的表/序列自动授予应用角色 DML（不含 DDL / TRUNCATE）
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO :"app_user";

-- ---- pg-boss（C8）：它会自己 CREATE SCHEMA IF NOT EXISTS pgboss 并建表；schema 归应用角色，不必给它 CREATE ON DATABASE ----
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION :"app_user";

-- ---- 监控角色：Alloy postgres_exporter 直连，只读 ----
CREATE ROLE :"exp_user" LOGIN PASSWORD :'exp_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 5;
ALTER ROLE :"exp_user" SET statement_timeout = '10s';
GRANT pg_monitor TO :"exp_user";
GRANT CONNECT ON DATABASE :"dbname" TO :"exp_user";
SQL

echo "[initdb] roles ${PG_APP_USER} / ${PG_EXPORTER_USER}, schema pgboss, extensions vector/pg_bigm/pg_stat_statements/pgcrypto ready"
