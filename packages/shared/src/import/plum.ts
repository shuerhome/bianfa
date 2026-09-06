// 原版便笺 JSON 导入（规格 02 §7）：tools/export_sticky_notes.py 的 notes.json 产物。
// import_source = 'json'，external_id 沿用原 GUID；已删除条目不在文件内。
import { z } from "zod";
import { type NoteColor, noteColorSchema } from "../colors.js";
import { type ImportExt, type NoteMeta, Origins, ZMode } from "../doc.js";
import { SCHEMA_VERSION } from "../editor/version.js";
import { inlineLinesToPmJson } from "../markdown.js";
import { type PMJson, prosemirrorJsonToNoteDoc } from "../projector.js";

export const plumExportAttachmentSchema = z.object({
  /** 相对 LocalState 的路径，如 media/abc123.png */
  path: z.string(),
  mime: z.string().nullable(),
});

/** 原值为逻辑像素；display_id 与 Tauri 显示器名不对应，匹配失败落主屏 */
export const plumExportWindowSchema = z.object({
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  w: z.number().int().optional(),
  h: z.number().int().optional(),
  display_id: z.string().optional(),
});

export const plumExportNoteSchema = z.object({
  external_id: z.string().min(1),
  source: z.literal("plum.sqlite"),
  title: z.string(),
  markdown: z.string(),
  text: z.string(),
  color: noteColorSchema,
  original_theme: z.string().nullable(),
  pinned: z.boolean(),
  is_open: z.boolean(),
  window: plumExportWindowSchema.nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  attachments: z.array(plumExportAttachmentSchema),
  has_ink: z.boolean(),
  content_source: z.enum(["LastServerVersion", "Text"]),
  import_degraded: z.boolean(),
});

export const plumExportFileSchema = z.object({
  exported_at: z.string(),
  source_db: z.string(),
  count: z.number().int().nonnegative(),
  notes: z.array(plumExportNoteSchema),
});

export type PlumExportAttachment = z.infer<typeof plumExportAttachmentSchema>;
export type PlumExportWindow = z.infer<typeof plumExportWindowSchema>;
export type PlumExportNote = z.infer<typeof plumExportNoteSchema>;
export type PlumExportFile = z.infer<typeof plumExportFileSchema>;

export function parsePlumExportFile(input: unknown): PlumExportFile {
  return plumExportFileSchema.parse(input);
}

/** 与导出器一致的合理区间：1990 ~ 2100 */
const MIN_VALID_MS = -631152000000;
const MAX_VALID_MS = 4102444800000;

/** ISO 8601 → Unix ms；null / 无法解析 / 超出 1990–2100 → null */
export function plumTimeToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return ms > MIN_VALID_MS && ms < MAX_VALID_MS ? ms : null;
}

export interface PlumDocInit {
  externalId: string;
  title: string;
  content: PMJson;
  /** 导出器给的纯文本（投影前的参考值） */
  text: string;
  meta: NoteMeta;
  ext: { import: ImportExt };
  /** 是否在桌面打开（→ note_window_state.is_open） */
  isOpen: boolean;
  window: PlumExportWindow | null;
  attachments: PlumExportAttachment[];
  hasInk: boolean;
  degraded: boolean;
  /** 时间缺失/非法时用 now 兜底；此处记录发生了哪些兜底 */
  fallbacks: { createdAt: boolean; updatedAt: boolean };
}

export interface PlumImportOptions {
  /** 时间兜底与 meta.updatedAt 的缺省来源，默认 Date.now() */
  now?: number;
  /** 覆盖颜色映射（默认信任导出器已映射好的 10 色枚举） */
  color?: NoteColor;
}

/** 单条导出记录 → Y.Doc 初始化材料（颜色、时间、正文 PM JSON、ext.import） */
export function plumNoteToDocInit(note: PlumExportNote, options: PlumImportOptions = {}): PlumDocInit {
  const now = options.now ?? Date.now();
  const createdParsed = plumTimeToMs(note.created_at);
  const updatedParsed = plumTimeToMs(note.updated_at);
  const createdAt = createdParsed ?? updatedParsed ?? now;
  const updatedAt = updatedParsed ?? createdAt;
  const content = inlineLinesToPmJson(note.markdown);
  const importExt: ImportExt = {
    source: "json",
    externalId: note.external_id,
    contentSource: note.content_source,
    degraded: note.import_degraded,
    hasInk: note.has_ink,
    originalTheme: note.original_theme,
  };
  return {
    externalId: note.external_id,
    title: note.title,
    content,
    text: note.text,
    meta: {
      color: options.color ?? note.color,
      zMode: note.pinned ? ZMode.pinned : ZMode.normal,
      createdAt,
      updatedAt,
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
    },
    ext: { import: importExt },
    isOpen: note.is_open,
    window: note.window,
    attachments: note.attachments,
    hasInk: note.has_ink,
    degraded: note.import_degraded,
    fallbacks: { createdAt: createdParsed === null, updatedAt: updatedParsed === null },
  };
}

/** 单条导出记录 → 新 Y.Doc（origin 'import'）；noteId 由调用方生成（UUIDv7） */
export function plumNoteToNoteDoc(note: PlumExportNote, noteId: string, options: PlumImportOptions = {}) {
  const init = plumNoteToDocInit(note, options);
  const doc = prosemirrorJsonToNoteDoc(init.content, { noteId, meta: init.meta, ext: init.ext }, Origins.import);
  return { doc, init };
}
