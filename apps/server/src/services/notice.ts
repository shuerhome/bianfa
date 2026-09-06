// kill switch 公告（规格 04 §7.8）：API 不持私钥，只原样下发部署脚本放置的静态 JSON（NOTICE_FILE）；
// 形状 { v:1, payload:<base64url(JSON)>, sig:<base64(ed25519)> }；文件缺失 / 空 / 形状不对 → 204（fail-open 在客户端）。
// 按 mtime 缓存，最多 30 s 重新 stat 一次。
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

export const noticeEnvelopeSchema = z
  .object({
    v: z.literal(1),
    payload: z.string().regex(/^[A-Za-z0-9_-]+$/),
    sig: z.string().regex(/^[A-Za-z0-9+/=_-]+$/),
  })
  .strict();
export type NoticeEnvelope = z.infer<typeof noticeEnvelopeSchema>;

export interface NoticeLoader {
  load(): Promise<NoticeEnvelope | null>;
}

export function createNoticeLoader(
  file: string | undefined,
  opts: { ttlMs?: number; now?: () => number } = {},
): NoticeLoader {
  const ttlMs = opts.ttlMs ?? 30_000;
  const now = opts.now ?? Date.now;
  let cached: { mtimeMs: number; value: NoticeEnvelope | null; checkedAt: number } | undefined;
  return {
    async load() {
      if (!file) return null;
      const t = now();
      if (cached && t - cached.checkedAt < ttlMs) return cached.value;
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(file)).mtimeMs;
      } catch {
        cached = { mtimeMs: -1, value: null, checkedAt: t };
        return null;
      }
      if (cached && cached.mtimeMs === mtimeMs) {
        cached.checkedAt = t;
        return cached.value;
      }
      let value: NoticeEnvelope | null = null;
      try {
        const text = (await readFile(file, "utf8")).trim();
        if (text.length > 0) {
          const parsed = noticeEnvelopeSchema.safeParse(JSON.parse(text));
          value = parsed.success ? parsed.data : null;
        }
      } catch {
        value = null;
      }
      cached = { mtimeMs, value, checkedAt: t };
      return value;
    },
  };
}
