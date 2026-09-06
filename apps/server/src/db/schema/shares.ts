// docs/07 §6.1 的 shares / note_pins（团队共享本期实现）：
//   shares：grantee_kind 本期只有 user / link；link 类型用 token_hash（SHA-256，32 字节）识别；撤销写 revoked_at 不删行。
//   note_pins：只有 (user_id, note_id, always_on_top, pinned_at)，无任何窗口几何列（第 1 章 C14）。
// shares.id 的 DEFAULT uuidv7() 同 workspaces，由 custom migration 0002 在 PG ≥ 18 条件添加。
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { granteeKind, notePerm } from "./enums.js";
import { notes } from "./notes.js";
import { bytea } from "./types.js";

export const shares = pgTable(
  "shares",
  {
    id: uuid("id").primaryKey(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    granteeKind: granteeKind("grantee_kind").notNull(),
    granteeUserId: text("grantee_user_id").references(() => user.id, { onDelete: "cascade" }),
    tokenHash: bytea("token_hash"), // link：SHA-256(token)；原始 token 只出现在链接里
    perm: notePerm("perm").notNull().default("viewer"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "shares_grantee_shape",
      sql`(${t.granteeKind} = 'user' AND ${t.granteeUserId} IS NOT NULL AND ${t.tokenHash} IS NULL) OR (${t.granteeKind} = 'link' AND ${t.granteeUserId} IS NULL AND ${t.tokenHash} IS NOT NULL AND octet_length(${t.tokenHash}) = 32)`,
    ),
    uniqueIndex("shares_user_uq")
      .on(t.noteId, t.granteeUserId)
      .where(sql`${t.granteeKind} = 'user' AND ${t.revokedAt} IS NULL`),
    uniqueIndex("shares_token_uq").on(t.tokenHash).where(sql`${t.granteeKind} = 'link'`),
    index("shares_inbox_idx").on(t.granteeUserId, t.createdAt.desc()).where(sql`${t.granteeKind} = 'user'`),
  ],
);

export const notePins = pgTable(
  "note_pins",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    alwaysOnTop: boolean("always_on_top").notNull().default(false),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.noteId] }), index("note_pins_note_idx").on(t.noteId)],
);
