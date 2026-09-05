-- =============================================================================
-- infra/vps/restore-checks.sql —— 恢复演练的业务校验（restore.sh 与 .github/workflows/restore-drill.yml 共用）
-- -----------------------------------------------------------------------------
-- 契约（restore-drill.yml 文件头）：`psql -X -tA [-F '|']` 下**恰好输出一行**
--     users|notes|writes_24h|last_write_age_hours
--   note_updates 为空时 last_write_age_hours = -1。
--   restore.sh 用 `psql -X -v ON_ERROR_STOP=1 -tA`（无 -F），drill 用 `-At -F '|'`——所以这里自己把四个值拼成
--   **一列文本**，两种调用方式输出逐字节相同。
-- 表名来源：第 4 章 DDL（notes / note_updates，created_at timestamptz）；用户表按第 1 章裁定 C9「Better Auth 表为权威」，
--   Better Auth 默认表名是 "user"（单数）。**apps/api 的 schema 定稿后必须回来核对这三个表名**——
--   任何一个不存在，psql 会在 ON_ERROR_STOP 下直接失败，drill 与 restore.sh 都会把它当作恢复失败（这是想要的行为：
--   宁可演练红灯，不要一个恒返回 0|0|0|-1 的假绿灯）。
-- 阈值不在这里判：drill 在 bash 里判 users>0、notes>0、last_write_age_hours ∈ [0, MAX_STALENESS_H]。
-- 必须人工替换：无。
-- =============================================================================
\set ON_ERROR_STOP on

SELECT
      (SELECT count(*) FROM "user")::text
  || '|' || (SELECT count(*) FROM notes WHERE deleted_at IS NULL)::text
  || '|' || (SELECT count(*) FROM note_updates WHERE created_at >= now() - interval '24 hours')::text
  || '|' || COALESCE(
               (SELECT round(extract(epoch FROM (now() - max(created_at))) / 3600.0, 2)::text FROM note_updates),
               '-1'
             );
