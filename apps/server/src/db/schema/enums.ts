// 规格 02 §1.2 / docs/07 §6.1 的枚举类型。note_perm 的声明顺序即权限高低（max(anyenum) 可直接取最高权限）。
import { pgEnum } from "drizzle-orm/pg-core";

export const workspaceKind = pgEnum("workspace_kind", ["personal", "team"]);
export const notePerm = pgEnum("note_perm", ["viewer", "commenter", "editor", "manager"]);
// shares.grantee_kind：本期只有 user / link；team / org 共享将来用 ALTER TYPE ... ADD VALUE 追加
export const granteeKind = pgEnum("grantee_kind", ["user", "link"]);

export type WorkspaceKind = (typeof workspaceKind.enumValues)[number];
export type NotePerm = (typeof notePerm.enumValues)[number];
export type GranteeKind = (typeof granteeKind.enumValues)[number];
