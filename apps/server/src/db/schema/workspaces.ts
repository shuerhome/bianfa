// 规格 02 §1.2 workspaces（外键按 §0 改 text 指向 Better Auth 表）。
// id 的 DEFAULT uuidv7() 只在 PG ≥ 18 由 custom migration 0002 条件添加（本地 PG16 没有该函数）；服务端永远自己生成 id。
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth.js";
import { notePerm, workspaceKind } from "./enums.js";

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey(),
    kind: workspaceKind("kind").notNull(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }), // M3 前恒 NULL
    teamId: text("team_id").references(() => team.id, { onDelete: "set null" }), // NULL = org 全员
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    defaultNotePerm: notePerm("default_note_perm").notNull().default("editor"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "ws_shape",
      sql`(${t.kind} = 'personal' AND ${t.ownerUserId} IS NOT NULL AND ${t.orgId} IS NULL AND ${t.teamId} IS NULL) OR (${t.kind} = 'team' AND ${t.orgId} IS NOT NULL AND ${t.ownerUserId} IS NULL)`,
    ),
    uniqueIndex("workspaces_personal_uq").on(t.ownerUserId).where(sql`${t.kind} = 'personal'`),
    index("workspaces_org_idx").on(t.orgId, t.teamId),
  ],
);
