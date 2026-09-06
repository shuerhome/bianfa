// Y.Doc 冻结约定（规格 02 §3）：一条便笺 = 一个 Y.Doc，guid === noteId。
//   getXmlFragment('body')  Tiptap 正文（Collaboration 必须显式 field: 'body'）
//   getMap('meta')          color / zMode / createdAt / updatedAt / deletedAt / schemaVersion（LWW-per-key）
//   getMap('ext')           预留扩展字段；已定义 key：import
// 改动本文件的任何 key 名或语义 = 需要迁移器。
import * as Y from "yjs";
import { z } from "zod";
import { DEFAULT_NOTE_COLOR, isNoteColor, noteColorSchema } from "./colors.js";
import { SCHEMA_VERSION } from "./editor/version.js";

export const BODY_FIELD = "body";
export const META_MAP = "meta";
export const EXT_MAP = "ext";

/** meta.zMode：0 普通 / 1 置顶 / 2 贴桌面（单字段避免 pinned 与 deskPinned 同真） */
export const ZMode = { normal: 0, pinned: 1, desktop: 2 } as const;
export type ZMode = (typeof ZMode)[keyof typeof ZMode];
export const zModeSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

/**
 * Transaction origin 约定（规格 02 §3 / 01 C15）。
 * - local：本地编辑。编辑器内 y-tiptap 的 ySyncPlugin 用 binding 自身做 origin，客户端落库时归为 'local'。
 * - ai：AI 写入，必须在客户端 transact 内落地；在 UndoManager.trackedOrigins 内，一次 Ctrl+Z 整段回滚。
 * - remote：服务端/其它端应用过来的 update；不在 trackedOrigins，UniqueID 也跳过。
 * - import：迁移导入。
 */
export const Origins = {
  local: "local",
  remote: "remote",
  import: "import",
  ai: "ai",
} as const;
export type Origin = (typeof Origins)[keyof typeof Origins];

export const noteMetaSchema = z.object({
  color: noteColorSchema,
  zMode: zModeSchema,
  /** Unix ms UTC；创建时写一次，之后不改；导入取原始 CreatedAt */
  createdAt: z.number().int().nonnegative(),
  /** Unix ms UTC；每个持久化批次写一次（≤1 次/2s） */
  updatedAt: z.number().int().nonnegative(),
  /** Unix ms UTC 或 null；删除写 ms，恢复写 null */
  deletedAt: z.number().int().nonnegative().nullable(),
  /** 文档用到的最高 PM schema 版本 */
  schemaVersion: z.number().int().positive(),
});
export type NoteMeta = z.infer<typeof noteMetaSchema>;

export const noteMetaPatchSchema = noteMetaSchema.partial();
export type NoteMetaPatch = z.infer<typeof noteMetaPatchSchema>;

/** ext.import：迁移来源记录（规格 02 §3） */
export const EXT_IMPORT_KEY = "import";
export const importExtSchema = z.object({
  source: z.enum(["plum.sqlite", "snt", "json"]),
  externalId: z.string().min(1),
  contentSource: z.enum(["LastServerVersion", "Text"]),
  degraded: z.boolean(),
  hasInk: z.boolean(),
  originalTheme: z.string().nullable(),
});
export type ImportExt = z.infer<typeof importExtSchema>;

export interface NoteDocInit {
  /** 覆盖默认 meta；未给的键取默认值（color=graphite、zMode=0、createdAt=updatedAt=now、deletedAt=null、schemaVersion=SCHEMA_VERSION） */
  meta?: NoteMetaPatch;
  /** 写入 ext map 的键值；值必须是 Yjs 可存的 JSON 值 */
  ext?: Readonly<Record<string, unknown>>;
  /** 初始化事务的 origin，默认 Origins.local */
  origin?: unknown;
  /** createdAt/updatedAt 的缺省来源，默认 Date.now() */
  now?: number;
}

/** 与 Y.Doc 实例化方式绑定：guid = noteId，gc 开启（服务端 note_updates 走 append-only，快照由 worker 合成） */
export function createNoteDoc(noteId: string, init: NoteDocInit = {}): Y.Doc {
  if (!noteId) throw new Error("createNoteDoc: noteId is required");
  const doc = new Y.Doc({ guid: noteId, gc: true });
  const now = init.now ?? Date.now();
  const patch = noteMetaPatchSchema.parse(init.meta ?? {});
  const createdAt = patch.createdAt ?? now;
  const meta: NoteMeta = {
    color: patch.color ?? DEFAULT_NOTE_COLOR,
    zMode: patch.zMode ?? ZMode.normal,
    createdAt,
    updatedAt: patch.updatedAt ?? createdAt,
    deletedAt: patch.deletedAt ?? null,
    schemaVersion: patch.schemaVersion ?? SCHEMA_VERSION,
  };
  doc.transact(() => {
    const map = doc.getMap(META_MAP);
    for (const [key, value] of Object.entries(meta)) map.set(key, value);
    if (init.ext) {
      const ext = doc.getMap(EXT_MAP);
      for (const [key, value] of Object.entries(init.ext)) ext.set(key, value);
    }
    // 保证 body 类型在首个 update 里就已声明，其它端不会先看到一个只有 meta 的文档
    doc.getXmlFragment(BODY_FIELD);
  }, init.origin ?? Origins.local);
  return doc;
}

export function getBody(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(BODY_FIELD);
}

export function getMetaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(META_MAP);
}

export function getExtMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(EXT_MAP);
}

const isMs = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * 读取 meta，对缺失/非法值给缺省：color 未知 → graphite，zMode 非 0/1/2 → 0，
 * createdAt 缺失 → 0（1970，投影列会明显暴露问题而不是伪造时间），updatedAt 缺失 → createdAt，
 * deletedAt 非法 → null，schemaVersion 非法 → SCHEMA_VERSION。永不抛错。
 */
export function readMeta(doc: Y.Doc): NoteMeta {
  const map = getMetaMap(doc);
  const color = map.get("color");
  const zMode = map.get("zMode");
  const createdAtRaw = map.get("createdAt");
  const updatedAtRaw = map.get("updatedAt");
  const deletedAtRaw = map.get("deletedAt");
  const schemaVersionRaw = map.get("schemaVersion");
  const createdAt = isMs(createdAtRaw) ? Math.trunc(createdAtRaw) : 0;
  return {
    color: isNoteColor(color) ? color : DEFAULT_NOTE_COLOR,
    zMode: zMode === 1 || zMode === 2 ? zMode : ZMode.normal,
    createdAt,
    updatedAt: isMs(updatedAtRaw) ? Math.trunc(updatedAtRaw) : createdAt,
    deletedAt: isMs(deletedAtRaw) ? Math.trunc(deletedAtRaw) : null,
    schemaVersion:
      typeof schemaVersionRaw === "number" && Number.isInteger(schemaVersionRaw) && schemaVersionRaw > 0
        ? schemaVersionRaw
        : SCHEMA_VERSION,
  };
}

/**
 * 在一个 transact 内写入 meta 的若干键（LWW-per-key）。patch 先过 zod 校验，非法值抛错。
 * 值为 undefined 的键跳过；deletedAt 要清除请显式传 null。
 */
export function writeMeta(doc: Y.Doc, patch: NoteMetaPatch, origin: unknown): NoteMeta {
  const validated = noteMetaPatchSchema.parse(patch);
  doc.transact(() => {
    const map = getMetaMap(doc);
    for (const [key, value] of Object.entries(validated)) {
      if (value !== undefined) map.set(key, value);
    }
  }, origin);
  return readMeta(doc);
}

/** 读取 ext.import；缺失或形状不对 → null */
export function readImportExt(doc: Y.Doc): ImportExt | null {
  const raw = getExtMap(doc).get(EXT_IMPORT_KEY);
  const parsed = importExtSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function writeImportExt(doc: Y.Doc, value: ImportExt, origin: unknown): void {
  const validated = importExtSchema.parse(value);
  doc.transact(() => {
    getExtMap(doc).set(EXT_IMPORT_KEY, validated);
  }, origin);
}

// ── updateV2 薄封装：全链路（note_updates.update_v2 / ydoc_updates.update_v2 / 快照）统一 v2 编码 ──

export function encodeStateV2(doc: Y.Doc, encodedTargetStateVector?: Uint8Array): Uint8Array {
  return Y.encodeStateAsUpdateV2(doc, encodedTargetStateVector);
}

export function encodeStateVector(doc: Y.Doc): Uint8Array {
  return Y.encodeStateVector(doc);
}

export function applyUpdateV2(doc: Y.Doc, update: Uint8Array, origin: unknown = Origins.remote): void {
  Y.applyUpdateV2(doc, update, origin);
}

export function mergeUpdatesV2(updates: readonly Uint8Array[]): Uint8Array {
  return Y.mergeUpdatesV2(updates as Uint8Array[]);
}

export function diffUpdateV2(update: Uint8Array, stateVector: Uint8Array): Uint8Array {
  return Y.diffUpdateV2(update, stateVector);
}

/** 从一组 updateV2（快照 + 增量，按顺序）重建 Y.Doc；用于 projector / 导出 / 版本回放 */
export function openNoteDoc(
  noteId: string,
  updates: readonly Uint8Array[],
  origin: unknown = Origins.remote,
): Y.Doc {
  const doc = new Y.Doc({ guid: noteId, gc: true });
  doc.transact(() => {
    for (const update of updates) Y.applyUpdateV2(doc, update, origin);
  }, origin);
  return doc;
}
