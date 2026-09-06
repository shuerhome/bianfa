// 导出（specs/02 §6.10）：txt / md / json；内容 JS 生成，Rust 只写盘（export_write）。
import { encodeStateV2, openNoteDoc, pmJsonToMarkdown, projectNoteDoc, titleFromText } from "@bianfa/shared";
import { exportWrite, noteLoadDoc, notesList, pickDirectory } from "../ipc/commands.js";
import type { ExportFile } from "../ipc/types.js";
import { fromB64, toB64, utf8ToB64 } from "./base64.js";

export type ExportFormat = "txt" | "md" | "json";

const safeName = (title: string, id: string): string => {
  const base = title.replace(/[\\/:*?"<>|\n\r\t]/g, "_").trim().slice(0, 40) || "untitled";
  return `${base}-${id.slice(0, 8)}`;
};

export async function buildExportFiles(format: ExportFormat, noteIds?: string[]): Promise<ExportFile[]> {
  const list = await notesList({ includeTrashed: false });
  const targets = noteIds ? list.filter((n) => noteIds.includes(n.id)) : list;
  const files: ExportFile[] = [];
  const jsonNotes: unknown[] = [];
  for (const n of targets) {
    const bundle = await noteLoadDoc(n.id);
    const updates: Uint8Array[] = [];
    if (bundle.snapshotB64) updates.push(fromB64(bundle.snapshotB64));
    for (const u of bundle.updatesB64) updates.push(fromB64(u));
    const doc = openNoteDoc(n.id, updates, "export");
    const p = projectNoteDoc(doc);
    const title = titleFromText(p.contentText);
    const name = safeName(title, n.id);
    if (format === "txt") files.push({ relPath: `txt/${name}.txt`, contentB64: utf8ToB64(p.contentText) });
    else if (format === "md") {
      const front = `---\ncolor: ${p.meta.color}\npinned: ${p.meta.zMode === 1}\ncreated: ${new Date(p.meta.createdAt).toISOString()}\nupdated: ${new Date(p.meta.updatedAt).toISOString()}\nid: ${n.id}\n---\n\n`;
      files.push({ relPath: `markdown/${name}.md`, contentB64: utf8ToB64(front + pmJsonToMarkdown(p.content)) });
    } else {
      jsonNotes.push({
        id: n.id,
        color: p.meta.color,
        zMode: p.meta.zMode,
        createdAt: p.meta.createdAt,
        updatedAt: p.meta.updatedAt,
        deletedAt: p.meta.deletedAt,
        schemaVersion: p.meta.schemaVersion,
        text: p.contentText,
        markdown: pmJsonToMarkdown(p.content),
        content: p.content,
        attachmentIds: p.attachmentIds,
        stateV2B64: toB64(encodeStateV2(doc)),
      });
    }
    doc.destroy();
  }
  if (format === "json") {
    files.push({
      relPath: "notes.json",
      contentB64: utf8ToB64(JSON.stringify({ exportedAt: new Date().toISOString(), count: jsonNotes.length, notes: jsonNotes }, null, 2)),
    });
  }
  return files;
}

/** 选目录 → 生成 → 写盘；用户取消返回 null */
export async function exportNotes(format: ExportFormat, title: string, noteIds?: string[]): Promise<number | null> {
  const dir = await pickDirectory({ title });
  if (!dir.path) return null;
  const files = await buildExportFiles(format, noteIds);
  const res = await exportWrite(dir.path, files);
  return res.written;
}
