// 附件路由（规格 04 §6.4 / 02 §8 / 01 S1）：
//   POST /attachments/presign {attachment_id, workspace_id, hash, size, mime} → 命中去重 {exists:true} | presigned PUT 15 min
//   POST /attachments/commit {attachment_id} → 校验对象存在、大小一致、magic bytes → status=committed
//   GET  /attachments/:id/url?note_id= → authorizeNote(viewer) 于引用它的 note → 5 min 签名 GET
// R2 未配置 → 503 attachments_disabled；配额与 ≤10 MB 在 presign 执行（去重范围 = workspace）。
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { errors } from "../http/errors.js";
import { uuidV7, validate } from "../http/validate.js";
import { authorizeNote } from "../services/authorize.js";
import { iso, num, one } from "../services/db-util.js";
import {
  ATTACHMENT_MAX_BYTES,
  checkStorageQuota,
  planForWorkspace,
  storageUsedBytes,
} from "../services/quota.js";
import {
  attachmentStorageKey,
  type ObjectStorage,
  PRESIGN_GET_SECONDS,
  PRESIGN_PUT_SECONDS,
  sniffImageMime,
} from "../services/storage.js";
import { requireWritableWorkspace } from "../services/workspaces.js";
import { type RouteDeps, type RouteEnv, userTx } from "./context.js";

const MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const presignSchema = z
  .object({
    attachment_id: uuidV7,
    workspace_id: uuidV7,
    /** BLAKE3-256 hex（64 字符） */
    hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
    size: z.number().int().min(1).max(ATTACHMENT_MAX_BYTES),
    mime: z.enum(MIMES),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    blurhash: z.string().max(200).optional(),
  })
  .strict();
const commitSchema = z.object({ attachment_id: uuidV7 }).strict();
const idParam = z.object({ id: uuidV7 }).strict();
const urlQuery = z.object({ note_id: uuidV7 }).strict();

export function attachmentRoutes(deps: RouteDeps): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();

  function storage(): ObjectStorage {
    if (!deps.storage) throw errors.serviceUnavailable("attachments_disabled");
    return deps.storage;
  }

  app.post("/attachments/presign", validate("json", presignSchema), async (c) => {
    const body = c.req.valid("json");
    const st = storage();
    const hashHex = body.hash.toLowerCase();
    const out = await userTx(c, deps, async (tx) => {
      const ws = await requireWritableWorkspace(tx, c.var.auth.userId, body.workspace_id);
      const existing = await one<{ id: string }>(
        tx,
        sql`SELECT id FROM attachments WHERE workspace_id = ${ws.id}::uuid AND content_hash = decode(${hashHex}, 'hex')
              AND status = 'committed' AND NOT encrypted AND deleted_at IS NULL LIMIT 1`,
      );
      if (existing) return { exists: true as const, attachmentId: existing.id };
      const plan = await planForWorkspace(tx, ws);
      const used = await storageUsedBytes(
        tx,
        ws.kind === "personal"
          ? { kind: "personal", ownerUserId: ws.owner_user_id as string }
          : { kind: "team", orgId: ws.org_id as string },
      );
      const quota = checkStorageQuota(used, body.size, plan);
      if (!quota.ok)
        throw errors.conflict("quota_exceeded", {
          used: quota.used,
          limit: quota.limit,
          incoming: body.size,
        });
      const key = attachmentStorageKey(ws.id, hashHex);
      const row = await one<{ id: string; status: string; workspace_id: string }>(
        tx,
        sql`INSERT INTO attachments (id, workspace_id, created_by, content_hash, byte_size, mime, width, height, blurhash, storage_key)
            VALUES (${body.attachment_id}::uuid, ${ws.id}::uuid, ${c.var.auth.userId}, decode(${hashHex}, 'hex'), ${body.size}, ${body.mime},
                    ${body.width ?? null}, ${body.height ?? null}, ${body.blurhash ?? null}, ${key})
            ON CONFLICT (id) DO UPDATE SET id = attachments.id
            RETURNING id, status, workspace_id`,
      );
      if (!row || row.workspace_id !== ws.id) throw errors.conflict("attachment_id_taken");
      if (row.status === "committed") return { exists: true as const, attachmentId: row.id };
      return { exists: false as const, attachmentId: row.id, key, plan };
    });
    if (out.exists) return c.json({ exists: true, attachment_id: out.attachmentId });
    const uploadUrl = await st.presignPut(out.key, { contentType: body.mime, contentLength: body.size });
    return c.json({
      exists: false,
      attachment_id: out.attachmentId,
      upload_url: uploadUrl,
      method: "PUT",
      headers: { "Content-Type": body.mime, "Content-Length": String(body.size) },
      expires_in: PRESIGN_PUT_SECONDS,
    });
  });

  app.post("/attachments/commit", validate("json", commitSchema), async (c) => {
    const { attachment_id } = c.req.valid("json");
    const st = storage();
    const att = await userTx(c, deps, async (tx) => {
      const row = await one<{
        id: string;
        workspace_id: string;
        status: string;
        storage_key: string;
        byte_size: string | number;
        mime: string;
      }>(
        tx,
        sql`SELECT id, workspace_id, status, storage_key, byte_size, mime FROM attachments WHERE id = ${attachment_id}::uuid`,
      );
      if (!row) throw errors.notFound();
      await requireWritableWorkspace(tx, c.var.auth.userId, row.workspace_id);
      return row;
    });
    if (att.status === "committed") return c.json({ attachment_id: att.id, status: "committed" });
    const head = await st.head(att.storage_key);
    if (!head) throw errors.conflict("object_missing");
    if (head.size !== num(att.byte_size))
      throw errors.conflict("size_mismatch", { expected: num(att.byte_size), actual: head.size });
    const magic = await st.readHead(att.storage_key, 16);
    const sniffed = magic ? sniffImageMime(magic) : null;
    if (sniffed !== att.mime) {
      await st.delete(att.storage_key).catch(() => {});
      throw new (await import("../http/errors.js")).AppError(400, "invalid_image", { detected: sniffed });
    }
    const committed = await userTx(c, deps, (tx) =>
      one<{ id: string; committed_at: Date }>(
        tx,
        sql`UPDATE attachments SET status = 'committed', committed_at = now() WHERE id = ${att.id}::uuid AND status = 'pending'
            RETURNING id, committed_at`,
      ),
    );
    return c.json({ attachment_id: att.id, status: "committed", committed_at: iso(committed?.committed_at) });
  });

  app.get("/attachments/:id/url", validate("param", idParam), validate("query", urlQuery), async (c) => {
    const id = c.req.valid("param").id;
    const noteId = c.req.valid("query").note_id;
    const st = storage();
    const att = await userTx(c, deps, async (tx) => {
      const auth = await authorizeNote(tx, c.var.auth.userId, noteId, "viewer");
      // 权限在 note 不在 blob：附件必须被该 note 引用（projector 投影），或与 note 同 workspace（投影尚未跑完的窗口期）
      const row = await one<{ id: string; storage_key: string; mime: string; status: string }>(
        tx,
        sql`SELECT a.id, a.storage_key, a.mime, a.status FROM attachments a
             WHERE a.id = ${id}::uuid AND a.deleted_at IS NULL AND a.status = 'committed'
               AND (EXISTS (SELECT 1 FROM attachment_refs r WHERE r.note_id = ${noteId}::uuid AND r.attachment_id = a.id)
                    OR a.workspace_id = ${auth.workspaceId}::uuid)`,
      );
      if (!row) throw errors.notFound();
      return row;
    });
    const url = await st.presignGet(att.storage_key, { expiresIn: PRESIGN_GET_SECONDS });
    c.header("Cache-Control", "private, no-store");
    return c.json({ url, mime: att.mime, expires_in: PRESIGN_GET_SECONDS });
  });

  return app;
}
