// 附件（服务端 src/routes/attachments.ts）。上传（presign → PUT R2 → commit）由 Rust `attachment_upload` 完成——
// WebView 没有网络；这里只封装读取签名 URL：GET /v1/attachments/:id/url?note_id= → { url, mime, expires_in }（5 min）。
import { apiJson } from "./http.js";

export interface AttachmentUrl {
  url: string;
  mime: string;
  /** 秒 */
  expiresIn: number;
  /** 本地估算的过期时刻（ms） */
  expiresAt: number;
}

export async function fetchAttachmentUrl(attachmentId: string, noteId: string): Promise<AttachmentUrl> {
  const r = await apiJson<{ url: string; mime: string; expires_in: number }>(
    "GET",
    `/v1/attachments/${encodeURIComponent(attachmentId)}/url`,
    { query: { note_id: noteId } },
  );
  const expiresIn = r.expires_in ?? 300;
  return { url: r.url, mime: r.mime, expiresIn, expiresAt: Date.now() + expiresIn * 1000 };
}
