// IPC 形状的投影：@bianfa/shared projectNoteDoc（content/contentText/checklist/attachments/meta）
// + contentBigram（bigram shingles）+ bodyHtml（@tiptap/static-renderer 预渲染，未聚焦窗口零 JS 显示）。
import { createEditorExtensions, type PMJson, projectNoteDoc, toBigramShingles } from "@bianfa/shared";
import { renderToHTMLString } from "@tiptap/static-renderer/pm/html-string";
import type * as Y from "yjs";
import type { NoteProjection } from "../ipc/types.js";

let staticExtensions: ReturnType<typeof createEditorExtensions> | null = null;

function getStaticExtensions() {
  if (!staticExtensions) staticExtensions = createEditorExtensions({ collaboration: false });
  return staticExtensions;
}

/** PM JSON → HTML 字符串（image 的 src 为 bianfa://att/<id>，显示时再换 attachment_local_url） */
export function renderBodyHtml(content: PMJson): string {
  try {
    return renderToHTMLString({ content, extensions: getStaticExtensions() });
  } catch {
    return "";
  }
}

export function buildProjection(doc: Y.Doc): NoteProjection {
  const p = projectNoteDoc(doc);
  return {
    content: p.content,
    contentText: p.contentText,
    contentBigram: toBigramShingles(p.contentText),
    bodyHtml: renderBodyHtml(p.content),
    color: p.meta.color,
    zMode: p.meta.zMode,
    createdAt: p.meta.createdAt,
    updatedAt: p.meta.updatedAt,
    deletedAt: p.meta.deletedAt,
    schemaVersion: p.meta.schemaVersion,
    attachmentIds: p.attachmentIds,
    checklist: p.checklistItems,
  };
}
