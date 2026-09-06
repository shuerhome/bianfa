-- =============================================================================
-- 0007 · 安全码（security code）：注册时用户自选的一串字符，只用于「忘记密码」时重置密码，替代邮件验证 / 邮件重置。
-- -----------------------------------------------------------------------------
-- * 库里只存 argon2id（或 scrypt 回退）哈希；明文从不落库、不进日志（databaseHooks.user.create.before 里哈希后把明文丢掉）。
-- * security_code_set_at：最近一次设置 / 修改时间（/v1/me 返回给桌面端展示）。
-- * security_code：Better Auth 的 additionalFields.securityCode（注册 body 里的明文，input-only）要求 drizzle schema 里有对应列
--   （adapter 启动时做 schema diff），但 create.before hook 把它置为 undefined，adapter 从不写这列；CHECK (IS NULL) 兜底：
--   任何试图把明文写进来的路径都会被数据库拒绝。
-- * ADD COLUMN IF NOT EXISTS：幂等。
-- =============================================================================
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS security_code text CONSTRAINT user_security_code_never_stored CHECK (security_code IS NULL);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS security_code_hash text;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS security_code_set_at timestamptz;
