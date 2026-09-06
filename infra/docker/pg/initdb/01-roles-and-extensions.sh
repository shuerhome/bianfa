#!/usr/bin/env bash
# =============================================================================
# bianfa · Postgres 首次初始化：扩展 + 应用角色 + worker 角色 + 监控角色 + pg-boss schema
# -----------------------------------------------------------------------------
# 来源：第 1 章 C6（pg_bigm）/ C8（pg-boss 的 schema）/ S3（应用角色经 PgBouncer）；第 9 章 8.6（pg_stat_statements）；
#       第 10 章（应用角色非 owner → RLS 生效；statement_timeout 设在角色上，不设全局）；
#       规格 02 §9-16（worker 用独立 BYPASSRLS 角色 bianfa_worker，projector / GC 不必伪造用户上下文）。
# 运行时机：官方 entrypoint 只在 PGDATA 为空的**第一次**启动时执行 /docker-entrypoint-initdb.d/*.sh，
#          以 OS 用户 postgres 经 unix socket 连接（pg_hba local peer）。之后改角色/密码要手工 ALTER ROLE。
# 密码来源：compose 注入的 PG_APP_PASSWORD / PG_WORKER_PASSWORD / PG_EXPORTER_PASSWORD，用 psql 变量 :'x' 传入，不拼接进 SQL 字串。
# 与 apps/server/drizzle 的关系：迁移 0000 会在角色不存在时建 NOLOGIN 占位（CI 没有本脚本）；prod 先跑本脚本，迁移看到角色已存在就跳过。
# 必须人工替换：无。
# =============================================================================
set -euo pipefail

: "${POSTGRES_DB:?}"
: "${PG_APP_USER:=bianfa_app}"
: "${PG_APP_PASSWORD:?PG_APP_PASSWORD 未设置}"
: "${PG_WORKER_USER:=bianfa_worker}"
: "${PG_WORKER_PASSWORD:?PG_WORKER_PASSWORD 未设置}"
: "${PG_EXPORTER_USER:=bianfa_exporter}"
: "${PG_EXPORTER_PASSWORD:?PG_EXPORTER_PASSWORD 未设置}"

psql -v ON_ERROR_STOP=1 --no-password --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v app_user="$PG_APP_USER" -v app_pw="$PG_APP_PASSWORD" \
     -v wrk_user="$PG_WORKER_USER" -v wrk_pw="$PG_WORKER_PASSWORD" \
     -v exp_user="$PG_EXPORTER_USER" -v exp_pw="$PG_EXPORTER_PASSWORD" \
     -v dbname="$POSTGRES_DB" <<'SQL'
-- ---- 扩展（shared_preload_libraries 里的两个 .so 已由 Dockerfile 自检保证存在）----
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_bigm;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- 应用角色：api / sync-ws 使用（worker 用下面的 bianfa_worker），经 PgBouncer；不是表 owner，RLS 对它生效 ----
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 100;                       -- PgBouncer 池 25+5 + sync-ws 直连 LISTEN，留余量（worker 走 bianfa_worker，不占这里）
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


-- ---- worker 角色：仅 worker 进程（projector / 附件 GC / 邮件 / 结算）使用，同样经 PgBouncer ----
-- BYPASSRLS：RLS 只对 api / sync-ws 的 bianfa_app 生效（规格 02 §9-16）；仍非 owner、无 DDL，DML 靠下面的默认权限。
CREATE ROLE :"wrk_user" LOGIN PASSWORD :'wrk_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS
  CONNECTION LIMIT 20;                        -- 单 worker 进程：pg-boss 池 10 + 业务池 10
ALTER ROLE :"wrk_user" SET statement_timeout = '60s';   -- worker 不得单条语句超 60s，长任务分批（规格 01 §5）
ALTER ROLE :"wrk_user" SET lock_timeout = '5s';
GRANT CONNECT, TEMPORARY ON DATABASE :"dbname" TO :"wrk_user";
GRANT CREATE ON DATABASE :"dbname" TO :"wrk_user";   -- pg-boss 的 CREATE SCHEMA IF NOT EXISTS 先查库级 CREATE 权限
GRANT USAGE ON SCHEMA public TO :"wrk_user";
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"wrk_user";
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"wrk_user";
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO :"wrk_user";
-- pg-boss 的 schema 归应用角色；worker 也会在里面建表（pg-boss start() 自迁移），api 要能入队、worker 要能消费：
-- 两个角色在 pgboss 内建的对象互相授予 ALL（默认权限按创建者绑定，所以要两个方向各写一遍）。
-- ---- pg-boss（C8）：schema 与全部对象归 worker 角色（分区表要求同一 owner）；api / sync-ws 只入队 ----
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION :"wrk_user";
GRANT USAGE, CREATE ON SCHEMA pgboss TO :"wrk_user";
GRANT USAGE ON SCHEMA pgboss TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"app_user" IN SCHEMA pgboss GRANT ALL ON TABLES TO :"wrk_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"app_user" IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO :"wrk_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"app_user" IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO :"wrk_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"wrk_user" IN SCHEMA pgboss GRANT ALL ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"wrk_user" IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"wrk_user" IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO :"app_user";

-- ---- 监控角色：Alloy postgres_exporter 直连，只读 ----
CREATE ROLE :"exp_user" LOGIN PASSWORD :'exp_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 5;
ALTER ROLE :"exp_user" SET statement_timeout = '10s';
GRANT pg_monitor TO :"exp_user";
GRANT CONNECT ON DATABASE :"dbname" TO :"exp_user";
SQL

echo "[initdb] roles ${PG_APP_USER} / ${PG_WORKER_USER} / ${PG_EXPORTER_USER}, schema pgboss, extensions vector/pg_bigm/pg_stat_statements/pgcrypto ready"
