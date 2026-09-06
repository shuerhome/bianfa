// 账号侧的 B2 路由（规格 04 §6.2）：POST /claim（幂等；确保个人工作区）、POST /sync/token（30/min/device）、
// POST /me/export、GET /me/export/:job_id（§7.9：pg-boss export.build → R2 exports/<user>/<job>.zip，预签名 24 h）。
// /me 本体、devices、delete 归 B1（auth.v1Routes）。
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { uuidv7 } from "../db/ids.js";
import { AppError, errors, respondError } from "../http/errors.js";
import { uuidV7, validate } from "../http/validate.js";
import { iso, num, one, toDate } from "../services/db-util.js";
import { QUEUES } from "../services/queue.js";
import { PRESIGN_EXPORT_SECONDS } from "../services/storage.js";
import { ensurePersonalWorkspace } from "../services/workspaces.js";
import { signSyncToken } from "../sync/token.js";
import { auditIn, type RouteDeps, type RouteEnv, userTx } from "./context.js";

const claimSchema = z.object({ local_user_id: z.uuid() }).strict();
const tokenSchema = z.object({ max_schema_version: z.number().int().min(1).max(100).optional() }).strict();
const jobParam = z.object({ job_id: uuidV7 }).strict();
const exportSchema = z.object({ scope: z.literal("user").optional() }).strict();

export const EXPORT_MIN_INTERVAL_HOURS = 24;

export function accountRoutes(deps: RouteDeps): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();

  app.post("/claim", validate("json", claimSchema), async (c) => {
    const { local_user_id } = c.req.valid("json");
    const uid = c.var.auth.userId;
    const out = await userTx(c, deps, async (tx) => {
      const me = await one<{ name: string }>(tx, sql`SELECT name FROM "user" WHERE id = ${uid}`);
      const wsId = await ensurePersonalWorkspace(tx, uid, `${me?.name ?? "我"} 的便笺`);
      const inserted = await one<{ local_user_id: string }>(
        tx,
        sql`INSERT INTO claimed_local_ids (local_user_id, user_id) VALUES (${local_user_id}::uuid, ${uid})
            ON CONFLICT (local_user_id) DO NOTHING RETURNING local_user_id`,
      );
      if (!inserted) {
        const owner = await one<{ user_id: string }>(
          tx,
          sql`SELECT user_id FROM claimed_local_ids WHERE local_user_id = ${local_user_id}::uuid`,
        );
        if (owner && owner.user_id !== uid) throw errors.conflict("claimed_by_other");
      }
      return { wsId, claimedBefore: !inserted };
    });
    return c.json({ personal_workspace_id: out.wsId, claimed_before: out.claimedBefore });
  });

  app.post("/sync/token", validate("json", tokenSchema.optional()), async (c) => {
    const auth = c.var.auth;
    const key = auth.deviceId ?? auth.sessionId ?? auth.userId;
    const rl = await deps.rateLimiter.hit("sync_token", key, 30, 60);
    if (!rl.ok) return respondError(c, errors.rateLimited(rl.retryAfter));
    const body = c.req.valid("json") ?? {};
    const { token, expiresIn, expiresAt } = await signSyncToken(deps.env.SYNC_TOKEN_SECRET, {
      sub: auth.userId,
      did: auth.deviceId,
      sid: auth.sessionId,
      msv: body.max_schema_version ?? 1,
    });
    c.header("Cache-Control", "no-store");
    return c.json({ token, expires_in: expiresIn, expires_at: expiresAt });
  });

  app.post("/me/export", validate("json", exportSchema.optional()), async (c) => {
    const uid = c.var.auth.userId;
    const job = await userTx(c, deps, async (tx) => {
      const recent = await one<{ id: string; status: string; created_at: Date }>(
        tx,
        sql`SELECT id, status, created_at FROM export_jobs
             WHERE user_id = ${uid} AND scope = 'user' AND status <> 'failed'
               AND created_at > now() - make_interval(hours => ${EXPORT_MIN_INTERVAL_HOURS})
             ORDER BY created_at DESC LIMIT 1`,
      );
      if (recent) {
        throw new AppError(429, "export_rate_limited", {
          job_id: recent.id,
          status: recent.status,
          retry_after: Math.max(
            1,
            Math.ceil(
              ((toDate(recent.created_at)?.getTime() ?? Date.now()) +
                EXPORT_MIN_INTERVAL_HOURS * 3600_000 -
                Date.now()) /
                1000,
            ),
          ),
        });
      }
      const id = uuidv7();
      await tx.execute(
        sql`INSERT INTO export_jobs (id, user_id, scope, status, expires_at)
            VALUES (${id}::uuid, ${uid}, 'user', 'queued', now() + interval '24 hours')`,
      );
      await auditIn(tx, c, { action: "export.requested", targetType: "export_job", targetId: id });
      return { id };
    });
    try {
      await deps.queue.send(
        QUEUES.exportBuild,
        { job_id: job.id, user_id: uid },
        { retryLimit: 3, retryDelay: 60, retryBackoff: true },
      );
    } catch (err) {
      deps.log.warn({ err: (err as Error).message }, "export.build enqueue failed");
      await userTx(c, deps, (tx) =>
        tx.execute(
          sql`UPDATE export_jobs SET status = 'failed', error = 'queue_unavailable', finished_at = now() WHERE id = ${job.id}::uuid`,
        ),
      );
      throw errors.serviceUnavailable("queue_unavailable");
    }
    return c.json({ job_id: job.id, status: "queued" }, 202);
  });

  app.get("/me/export/:job_id", validate("param", jobParam), async (c) => {
    const { job_id } = c.req.valid("param");
    const uid = c.var.auth.userId;
    const job = await userTx(c, deps, async (tx) => {
      const row = await one<{
        id: string;
        status: string;
        storage_key: string | null;
        byte_size: string | null;
        error: string | null;
        expires_at: Date | null;
        created_at: Date;
        finished_at: Date | null;
      }>(
        tx,
        sql`SELECT id, status, storage_key, byte_size, error, expires_at, created_at, finished_at
              FROM export_jobs WHERE id = ${job_id}::uuid AND user_id = ${uid}`,
      );
      if (!row) throw errors.notFound();
      const expired =
        row.status === "ready" &&
        row.expires_at !== null &&
        (toDate(row.expires_at)?.getTime() ?? 0) < Date.now();
      if (row.status === "ready" && !expired) {
        await auditIn(tx, c, { action: "export.downloaded", targetType: "export_job", targetId: row.id });
      }
      return { ...row, status: expired ? "expired" : row.status };
    });
    let downloadUrl: string | null = null;
    if (job.status === "ready" && job.storage_key && deps.storage) {
      const remaining = job.expires_at
        ? Math.floor(((toDate(job.expires_at)?.getTime() ?? Date.now()) - Date.now()) / 1000)
        : PRESIGN_EXPORT_SECONDS;
      downloadUrl = await deps.storage.presignGet(job.storage_key, {
        expiresIn: Math.max(60, Math.min(PRESIGN_EXPORT_SECONDS, remaining)),
        downloadName: `bianfa-export-${job.id}.zip`,
      });
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      job: {
        id: job.id,
        status: job.status,
        byte_size: job.byte_size === null ? null : num(job.byte_size),
        error: job.error,
        expires_at: iso(job.expires_at),
        created_at: iso(job.created_at),
        finished_at: iso(job.finished_at),
        download_url: downloadUrl,
      },
    });
  });

  return app;
}
