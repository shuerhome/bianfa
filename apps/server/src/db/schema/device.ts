// 规格 02 §1.1 自建 device 表（docs/06 §5.2.6）：客户端生成 UUIDv7 作 id。
import { sql } from "drizzle-orm";
import { check, inet, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.js";

export const device = pgTable(
  "device",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").notNull(),
    appVersion: text("app_version").notNull(),
    lastIp: inet("last_ip"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [check("device_platform_check", sql`${t.platform} IN ('windows', 'macos', 'linux')`)],
);
