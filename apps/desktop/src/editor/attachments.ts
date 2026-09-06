// 图片入口（specs/02 §8）：粘贴 / 拖入 → attachment_import（Rust 解码重编码 WebP、BLAKE3 去重）→ 插 image 节点。
import type { Editor } from "@tiptap/core";
import { attachmentImport } from "../ipc/commands.js";
import { toB64 } from "../lib/base64.js";

export const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type AttachmentFailure = "unsupported" | "too_large" | "failed";

export interface ImportOutcome {
  inserted: number;
  failures: AttachmentFailure[];
}

export function pickImageFiles(items: Iterable<File>): { ok: File[]; failures: AttachmentFailure[] } {
  const ok: File[] = [];
  const failures: AttachmentFailure[] = [];
  for (const f of items) {
    if (!f.type.startsWith("image/")) continue;
    if (!ALLOWED_IMAGE_MIMES.has(f.type)) failures.push("unsupported");
    else if (f.size > MAX_IMAGE_BYTES) failures.push("too_large");
    else ok.push(f);
  }
  return { ok, failures };
}

export async function importImageFiles(editor: Editor, noteId: string, files: File[]): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { inserted: 0, failures: [] };
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = await attachmentImport({ noteId, bytesB64: toB64(bytes), mime: file.type });
      editor
        .chain()
        .focus()
        .insertContent({
          type: "image",
          attrs: {
            attachmentId: info.id,
            w: info.width || null,
            h: info.height || null,
            blurhash: info.blurhash || null,
            alt: file.name || null,
          },
        })
        .run();
      outcome.inserted += 1;
    } catch {
      outcome.failures.push("failed");
    }
  }
  return outcome;
}

export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const files: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length === 0) files.push(...Array.from(dt.files ?? []));
  return files;
}
