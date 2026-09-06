// 跨端 DTO（服务端 API ↔ 桌面端 IPC）。时间一律 Unix ms UTC；颜色只传枚举名。
import { z } from "zod";
import { noteColorSchema } from "./colors.js";
import { zModeSchema } from "./doc.js";

export const workspaceKindSchema = z.enum(["personal", "team"]);
export type WorkspaceKind = z.infer<typeof workspaceKindSchema>;

/** 顺序即权限高低（规格 02 §1.2 note_perm） */
export const NOTE_PERMS = ["viewer", "commenter", "editor", "manager"] as const;
export const notePermSchema = z.enum(NOTE_PERMS);
export type NotePerm = z.infer<typeof notePermSchema>;

export function permRank(perm: NotePerm): number {
  return NOTE_PERMS.indexOf(perm);
}

/** actual 是否 ≥ required（manager ≥ editor ≥ commenter ≥ viewer） */
export function permAtLeast(actual: NotePerm, required: NotePerm): boolean {
  return permRank(actual) >= permRank(required);
}

export const platformSchema = z.enum(["windows", "macos", "linux"]);
export type Platform = z.infer<typeof platformSchema>;

/** 列表窗口 / 列表接口只回这些字段（规格 02 §6.8） */
export const TITLE_MAX_CHARS = 120;
export const EXCERPT_MAX_CHARS = 120;

export const noteListItemSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  excerpt: z.string(),
  color: noteColorSchema,
  zMode: zModeSchema,
  updatedAt: z.number().int().nonnegative(),
  deletedAt: z.number().int().nonnegative().nullable().optional(),
});
export type NoteListItem = z.infer<typeof noteListItemSchema>;
