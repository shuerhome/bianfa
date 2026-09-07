-- 0009：平台总管理员（platform admin）。
--
-- ① 谁是总管理员：单独一张 platform_admin 表，不放 "user" 上的可写列。
--    写入权限用 **RLS** 而不是 REVOKE 来关：0002 第 185 行与 infra/vps/pg-roles.sh 都会对 public 下
--    所有表做一次 blanket GRANT，REVOKE 会被下一次运维原样打回来；而 bianfa_app 是 NOBYPASSRLS，
--    RLS 开了却没有写策略，就是写不进去，跟 GRANT 给没给无关。授予总管理员只能走超级用户 / bianfa_worker
--    （即 infra/vps/platform-admin.sh），api 进程即使被完全攻陷也铸不出一个新的总管理员。
--
-- ② 冻结：新增 "user".frozen_at，不复用 banned —— jobs/account-purge.ts 已经把 banned 当作
--    「已匿名化的墓碑账号」标记在用，两者共用一列会让解冻误复活被清除的账号。
--    冻结时同时把 banned 置 true：老镜像的 verify-bearer 只认 banned，这样即使回滚到不认识 frozen_at
--    的旧镜像，Bearer 这一面依然是关着的；解冻只在 deleted_at IS NULL 时才清 banned。
CREATE TABLE IF NOT EXISTS platform_admin (
	"user_id" text PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" text,
	"note" text
);--> statement-breakpoint
ALTER TABLE platform_admin ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS platform_admin_read ON platform_admin;--> statement-breakpoint
-- 只读策略：bianfa_app 能看见名单（中间件要判定），但没有任何写策略 → INSERT/UPDATE/DELETE 一律被拒
CREATE POLICY platform_admin_read ON platform_admin FOR SELECT TO bianfa_app USING (true);--> statement-breakpoint
GRANT SELECT ON platform_admin TO bianfa_app;--> statement-breakpoint
-- 0000 的 ALTER DEFAULT PRIVILEGES 会自动给新建表授予 INSERT/UPDATE/DELETE，0002 与 pg-roles.sh 还会再 blanket
-- GRANT 一次，所以这条 REVOKE 随时可能被下一次运维打回来 —— 它**不是**安全边界，只是让越权写法当场报
-- permission denied 而不是静默无效。真正的边界是上面那条「只有 SELECT 策略」的 RLS：实测 bianfa_app 的
-- INSERT 直接被策略拒绝（42501），而 UPDATE/DELETE 因为没有对应策略，看不到任何行，影响 0 行后正常返回
-- ——「删成功了」但一行没删。读代码的人要知道这一点，别把 DELETE 没报错当成边界失效。
REVOKE INSERT, UPDATE, DELETE ON platform_admin FROM bianfa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_admin TO bianfa_worker;--> statement-breakpoint

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "frozen_by" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "frozen_reason" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_frozen_idx" ON "user" ("frozen_at") WHERE "frozen_at" IS NOT NULL;
