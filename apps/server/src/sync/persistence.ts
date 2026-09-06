// 持久化（规格 03 §1.5）：onLoadDocument 建行 + 重建状态；onStoreDocument 单事务 FOR UPDATE → diffUpdateV2 → 追加 →
// 压缩 → 同事务入队 pg-boss `note.project`。
// * 事务自管 BEGIN / set_config('app.user_id') / COMMIT（与 db/client.ts withUserTx 语义相同），因为 pg-boss 12.30 的
//   send(name, data, { db: { executeSql } }) 用调用方给的连接执行 INSERT —— 把事务里的 pg 连接交给它即同一事务。
// * pg-boss 实例只做入队：migrate/supervise/schedule 全关（schema 与队列由 worker 建）；未就绪时惰性启动、失败下次再试。
// * 入队失败 = 事务回滚 = 本次不持久化；Hocuspocus 把文档留在内存，这里再按退避重试 storeDocumentHooks，避免 SIGTERM 前丢失。
// * 日志绝不含 update 字节、正文或 token。
import type { Document, Hocuspocus, onLoadDocumentPayload, onStoreDocumentPayload } from "@hocuspocus/server";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { PgBoss } from "pg-boss";
import * as Y from "yjs";
import { type Db, withUserTx } from "../db/client.js";
import { isUuid } from "../db/ids.js";
import * as schema from "../db/schema/index.js";
import type { Logger } from "../log.js";
import {
  appendNoteUpdate,
  type CompactionThresholds,
  type DocStoreExecutor,
  isEmptyUpdateV2,
  loadNoteState,
  lockNoteHead,
} from "../notes/doc-store.js";
import { parseDocumentName, SyncAuthError } from "./auth.js";
import type { SyncContext } from "./connections.js";
import type { SyncMetrics } from "./metrics.js";

export const PROJECT_QUEUE = "note.project";
/** projector 的输入（03 §4）：`{ note_id, seq }`；singletonKey = note_id，2 s 槽去抖（next-slot，保证提交后必有一次投影） */
export interface ProjectJob {
  note_id: string;
  seq: number;
}
export const PROJECT_DEBOUNCE_SECONDS = 2;

export interface BossHandle {
  enqueueProject(client: pg.PoolClient, job: ProjectJob): Promise<void>;
  stop(): Promise<void>;
}

export interface BossOptions {
  connectionString: string;
  logger: Logger;
  applicationName?: string;
}

/** 惰性启动的 pg-boss 入队器（只 send，不跑维护） */
export function createBoss(opts: BossOptions): BossHandle {
  let boss: PgBoss | undefined;
  let starting: Promise<PgBoss> | undefined;

  async function ensure(): Promise<PgBoss> {
    if (boss) return boss;
    if (!starting) {
      starting = (async () => {
        const b = new PgBoss({
          connectionString: opts.connectionString,
          max: 2,
          application_name: opts.applicationName ?? "bianfa-sync",
          migrate: false,
          supervise: false,
          schedule: false,
        });
        b.on("error", (err) => opts.logger.warn({ err: errMessage(err) }, "pg-boss error"));
        try {
          await b.start();
        } catch (err) {
          await b.stop({ graceful: false, close: true, timeout: 1_000 }).catch(() => {});
          throw err;
        }
        boss = b;
        return b;
      })().finally(() => {
        starting = undefined;
      });
    }
    return starting;
  }

  return {
    async enqueueProject(client, job) {
      const b = await ensure();
      await b.sendDebounced(
        PROJECT_QUEUE,
        job,
        { db: { executeSql: (text, values) => client.query(text, values ?? []) } },
        PROJECT_DEBOUNCE_SECONDS,
        job.note_id,
      );
    },
    async stop() {
      const b = boss;
      boss = undefined;
      if (b) await b.stop({ graceful: false, close: true, timeout: 1_000 }).catch(() => {});
    },
  };
}

/**
 * 与 db/client.ts withUserTx 同语义（BEGIN → set_config('app.user_id', $1, true) → fn → COMMIT），
 * 但把底层 pg 连接一并交给回调，供 pg-boss 在同一事务内入队。
 */
export async function withUserClientTx<T>(
  pool: pg.Pool,
  userId: string,
  fn: (client: pg.PoolClient, tx: DocStoreExecutor) => Promise<T>,
): Promise<T> {
  if (!userId) throw new TypeError("withUserClientTx: userId 必须是非空字符串");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const result = await fn(client, drizzle(client, { schema }));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }
}

export interface PersistenceOptions {
  pool: pg.Pool;
  db: Db;
  logger: Logger;
  metrics: SyncMetrics;
  boss: BossHandle;
  compaction?: CompactionThresholds | undefined;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

interface Tracked {
  /** 状态字节上界（load/store 时校准为精确值，之后按收到的 update 累加） */
  size: number;
  /** 上次成功持久化（或加载）时的快照；相同即无变化，跳过 */
  lastStored: Y.Snapshot | null;
  retry: NodeJS.Timeout | null;
  attempts: number;
}

export interface StoreOutcome {
  stored: boolean;
  seq: number;
  compacted: boolean;
  stateBytes: number;
  /** 本次写入的 update V2 字节数（未写入为 0） */
  diffBytes: number;
  /** 未写入的原因 */
  skipped?: "snapshot_unchanged" | "empty_diff";
}

export interface Persistence {
  onLoadDocument(payload: onLoadDocumentPayload<SyncContext>): Promise<void>;
  onStoreDocument(payload: onStoreDocumentPayload<SyncContext>): Promise<void>;
  afterUnloadDocument(payload: { documentName: string }): Promise<void>;
  /** onChange：累加收到的 update 字节 */
  noteChange(documentName: string, bytes: number): void;
  stateSize(documentName: string): number;
  stop(): void;
}

const LOAD_ORIGIN = { source: "local", skipStoreHooks: true } as const;

export function createPersistence(opts: PersistenceOptions): Persistence {
  const { pool, db, logger, metrics, boss } = opts;
  const retryBaseMs = opts.retryBaseMs ?? 5_000;
  const retryMaxMs = opts.retryMaxMs ?? 60_000;
  const tracked = new Map<string, Tracked>();
  let stopped = false;

  function track(name: string): Tracked {
    let t = tracked.get(name);
    if (!t) {
      t = { size: 0, lastStored: null, retry: null, attempts: 0 };
      tracked.set(name, t);
    }
    return t;
  }

  async function onLoadDocument({ document, documentName, context }: onLoadDocumentPayload<SyncContext>) {
    const ref = parseDocumentName(documentName);
    if (!ref) throw new SyncAuthError("forbidden", "bad document name");
    const t = track(documentName);
    if (ref.kind === "inbox") return; // 信号房：空 Doc、不持久化
    const userId = context?.userId;
    if (!userId) throw new Error("onLoadDocument: missing user context");

    const state = await withUserTx(
      userId,
      async (tx) => {
        if (context.createIfMissing) {
          await tx.execute(sql`
            INSERT INTO notes (id, workspace_id, created_by, created_at, updated_at)
            VALUES (${ref.noteId}::uuid, ${ref.workspaceId}::uuid, ${userId}, now(), now())
            ON CONFLICT (id) DO NOTHING`);
        }
        const r = await tx.execute<{ workspace_id: string; gone: boolean }>(sql`
          SELECT workspace_id::text AS workspace_id,
                 (purged_at IS NOT NULL OR (purge_after IS NOT NULL AND purge_after < now())) AS gone
            FROM notes WHERE id = ${ref.noteId}::uuid`);
        const row = r.rows[0];
        if (!row) throw new SyncAuthError("forbidden", "note not visible");
        if (row.workspace_id !== ref.workspaceId) throw new SyncAuthError("forbidden", "workspace mismatch");
        if (row.gone) throw new SyncAuthError("gone", "note purged");
        return loadNoteState(tx, ref.noteId);
      },
      db,
    );
    if (state.stateV2) Y.applyUpdateV2(document, state.stateV2, LOAD_ORIGIN);
    t.size = state.stateV2?.byteLength ?? 0;
    t.lastStored = Y.snapshot(document);
    t.attempts = 0;
    logger.debug({ documentName, headSeq: state.headSeq, stateBytes: t.size }, "document loaded");
  }

  function pickContext(lastContext: SyncContext | undefined, document: Document): SyncContext | null {
    if (lastContext?.userId) return lastContext;
    let fallback: SyncContext | null = null;
    for (const c of document.getConnections() as Array<{ context?: SyncContext; readOnly: boolean }>) {
      if (!c.context?.userId) continue;
      if (!c.readOnly) return c.context;
      fallback ??= c.context;
    }
    return fallback;
  }

  async function resolveDeviceId(tx: DocStoreExecutor, deviceId: string | null): Promise<string | null> {
    if (!deviceId || !isUuid(deviceId)) return null;
    const r = await tx.execute<{ ok: number }>(sql`SELECT 1 AS ok FROM device WHERE id = ${deviceId}::uuid`);
    return r.rows.length > 0 ? deviceId : null;
  }

  async function store(
    document: Document,
    noteId: string,
    ctx: SyncContext,
    t: Tracked,
  ): Promise<StoreOutcome> {
    // 快照与编码必须在同一同步段取得（await 期间可能有新 update 到达）
    const snap = Y.snapshot(document);
    const state = Y.encodeStateAsUpdateV2(document);
    if (t.lastStored && Y.equalSnapshots(snap, t.lastStored)) {
      return {
        stored: false,
        seq: -1,
        compacted: false,
        stateBytes: state.byteLength,
        diffBytes: 0,
        skipped: "snapshot_unchanged",
      };
    }
    const outcome = await withUserClientTx(pool, ctx.userId, async (client, tx): Promise<StoreOutcome> => {
      const head = await lockNoteHead(tx, noteId);
      if (!head) throw new Error("note row missing (deleted or not visible)");
      const diff = head.crdtSv ? Y.diffUpdateV2(state, head.crdtSv) : state;
      if (isEmptyUpdateV2(diff)) {
        return {
          stored: false,
          seq: head.headSeq,
          compacted: false,
          stateBytes: state.byteLength,
          diffBytes: diff.byteLength,
          skipped: "empty_diff",
        };
      }
      const deviceId = await resolveDeviceId(tx, ctx.deviceId);
      const { seq, compacted } = await appendNoteUpdate(tx, {
        noteId,
        updateV2: diff,
        authorId: ctx.userId,
        deviceId,
        fullStateV2: state,
        ...(opts.compaction ? { thresholds: opts.compaction } : {}),
      });
      await boss.enqueueProject(client, { note_id: noteId, seq });
      return { stored: true, seq, compacted, stateBytes: state.byteLength, diffBytes: diff.byteLength };
    });
    t.lastStored = snap;
    t.size = outcome.stateBytes;
    t.attempts = 0;
    return outcome;
  }

  function scheduleRetry(
    instance: Hocuspocus,
    document: Document,
    payload: onStoreDocumentPayload<SyncContext>,
    t: Tracked,
  ) {
    if (stopped || t.retry) return;
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** t.attempts);
    t.attempts += 1;
    t.retry = setTimeout(() => {
      t.retry = null;
      if (stopped || document.isDestroyed || instance.documents.get(document.name) !== document) return;
      void instance.storeDocumentHooks(document, payload, true);
    }, delay);
    t.retry.unref();
  }

  async function onStoreDocument(payload: onStoreDocumentPayload<SyncContext>) {
    const { document, documentName, lastContext, instance, lastTransactionOrigin } = payload;
    const ref = parseDocumentName(documentName);
    if (ref?.kind !== "note") return;
    logger.debug(
      {
        documentName,
        origin: (lastTransactionOrigin as { source?: string } | undefined)?.source ?? "unknown",
      },
      "store requested",
    );
    const ctx = pickContext(lastContext, document);
    if (!ctx) {
      logger.debug({ documentName }, "store skipped: no user context on this replica");
      return;
    }
    const t = track(documentName);
    const end = metrics.storeSeconds.startTimer();
    try {
      const outcome = await store(document, ref.noteId, ctx, t);
      logger.debug(
        {
          documentName,
          seq: outcome.seq,
          compacted: outcome.compacted,
          stateBytes: outcome.stateBytes,
          diffBytes: outcome.diffBytes,
          skipped: outcome.skipped,
        },
        outcome.stored ? "document stored" : "document unchanged for storage",
      );
    } catch (err) {
      metrics.storeFailures.inc();
      logger.error(
        { documentName, err: errMessage(err), attempt: t.attempts },
        "onStoreDocument failed; document stays in memory, retry scheduled",
      );
      scheduleRetry(instance, document, payload, t);
      throw err;
    } finally {
      end();
    }
  }

  return {
    onLoadDocument,
    onStoreDocument,
    async afterUnloadDocument({ documentName }) {
      const t = tracked.get(documentName);
      if (t?.retry) clearTimeout(t.retry);
      tracked.delete(documentName);
    },
    noteChange(documentName, bytes) {
      track(documentName).size += bytes;
    },
    stateSize(documentName) {
      return tracked.get(documentName)?.size ?? 0;
    },
    stop() {
      stopped = true;
      for (const t of tracked.values()) {
        if (t.retry) clearTimeout(t.retry);
        t.retry = null;
      }
    },
  };
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
  }
  return String(err);
}
