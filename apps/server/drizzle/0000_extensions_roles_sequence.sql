-- =============================================================================
-- 0000 · 扩展 + 角色 + 默认权限 + 序列（custom migration，drizzle 表达不了的对象）
-- -----------------------------------------------------------------------------
-- * 扩展：prod 由 initdb/01-roles-and-extensions.sh 首次启动时装好；CI 不跑 initdb（规格 01 §11-8），
--   所以迁移自带 CREATE EXTENSION IF NOT EXISTS（两边都幂等）。pg_bigm 必须先于 0001 的 GIN 索引。
-- * 角色：prod 的 bianfa_app / bianfa_worker 由 initdb 建成 LOGIN 版本（密码来自 .env.prod）；
--   CI / 本地没有它们时建 NOLOGIN 占位，只为让 0002 的 RLS 策略 `TO bianfa_app` 与授权语句能引用。
--   CREATE ROLE 没有 IF NOT EXISTS，用 DO 块按 pg_roles 判断。BYPASSRLS 需要超级用户 —— 迁移本来就必须由超级用户跑。
-- * 默认权限：prod 的 initdb 已配 `ALTER DEFAULT PRIVILEGES FOR ROLE postgres`；CI 的迁移角色是 bianfa（超级用户），
--   这里不带 FOR ROLE（= 当前执行角色），使后续迁移建的表/序列自动授予两个应用角色。0002 末尾再对已有对象补一次显式 GRANT。
-- * 序列 global_lsn：change feed 唯一权威顺序（规格 02 §1.3），notes.lsn / note_updates.lsn DEFAULT nextval('global_lsn')。
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_bigm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bianfa_app') THEN
    CREATE ROLE bianfa_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bianfa_worker') THEN
    CREATE ROLE bianfa_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO bianfa_app, bianfa_worker;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bianfa_app, bianfa_worker;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO bianfa_app, bianfa_worker;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO bianfa_app, bianfa_worker;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS global_lsn;
