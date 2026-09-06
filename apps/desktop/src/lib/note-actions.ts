// 主窗 / 命令面板 / 设置共用的便笺动作：都通过 Y.Doc meta 写入（CRDT 语义），再由 Rust 落投影列。
import { getMetaMap, type NoteColor, type ZMode } from "@bianfa/shared";
import {
  noteNew,
  noteWindowClose,
  noteWindowOpen,
  noteWindowSetColor,
  noteWindowSetZmode,
} from "../ipc/commands.js";
import { withNoteDoc } from "./doc-store.js";

export async function openNote(noteId: string): Promise<void> {
  await noteWindowOpen(noteId, true);
}

export async function closeNote(noteId: string): Promise<void> {
  await noteWindowClose(noteId);
}

export async function createNote(color?: NoteColor): Promise<string> {
  const { noteId } = await noteNew(color ? { color } : {});
  return noteId;
}

/** 删除到回收站：meta.deletedAt = now（30 天可恢复） */
export async function trashNote(noteId: string): Promise<void> {
  await withNoteDoc(noteId, (doc) => {
    getMetaMap(doc).set("deletedAt", Date.now());
  });
}

/** 恢复：meta.deletedAt = null */
export async function restoreNote(noteId: string): Promise<void> {
  await withNoteDoc(noteId, (doc) => {
    getMetaMap(doc).set("deletedAt", null);
  });
}

export async function setNoteColor(noteId: string, color: NoteColor, windowOpen: boolean): Promise<void> {
  await withNoteDoc(noteId, (doc) => {
    getMetaMap(doc).set("color", color);
  });
  if (windowOpen) await noteWindowSetColor(noteId, color).catch(() => undefined);
}

export async function setNoteZMode(noteId: string, zMode: ZMode): Promise<void> {
  await withNoteDoc(noteId, (doc) => {
    getMetaMap(doc).set("zMode", zMode);
  });
  await noteWindowSetZmode(noteId, zMode).catch(() => undefined);
}
