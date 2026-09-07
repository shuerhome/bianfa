// 平台总管理员名单（迁移 0009）。刻意不放在 "user" 的一列上，也刻意不进 authSchema：
// Better Auth 碰不到它，api 进程（bianfa_app）也只有 SELECT —— 写入靠 RLS 关死，见 0009 的注释。
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.js";

export const platformAdmin = pgTable("platform_admin", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  /** 授予者：引导脚本写 'bootstrap'，由别的总管理员授予时写其 userId */
  grantedBy: text("granted_by"),
  note: text("note"),
});
