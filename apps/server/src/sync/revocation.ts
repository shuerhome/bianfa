// LISTEN authz_revoked / notes_changed（规格 03 §1.7、§2.6；08 X4）+ 60 s 周期全量重校验（03 §1.4）。
// * 1 条 DATABASE_URL_DIRECT 直连（db/direct.ts：掉线退避 1 s → 30 s 重连并重新 LISTEN）；重连后立即全量重校验
//   （断开期间的 NOTIFY 已丢）；断开 > 60 s 由 /healthz 503（health.ts）。
// * scope 'note' → 只关该用户在该 document 上的文档级连接（Hocuspocus 4.6 Connection.close() 只发该文档的 CLOSE 帧，
//   socket 与其它文档不受影响）；其余 scope（org/team/workspace/session/user）→ 关该用户全部 socket。
// * notes_changed {workspace_id, note_id, version} → inbox:<ws> 房间 relayStateless {t:'bump'}（每副本各自 LISTEN，
//   所以不走 broadcastStateless 的 Redis 转发，避免重复）。
import type { Hocuspocus } from "@hocuspocus/server";
import { createDirectClient, type DirectClient } from "../db/direct.js";
import type { Logger } from "../log.js";
import { type AuthzCache, type DocumentRef, inboxDocumentName, parseDocumentName } from "./auth.js";
import type { ConnectionRegistry, SyncConnection } from "./connections.js";
import type { ListenStatus } from "./health.js";
import type { SyncMetrics } from "./metrics.js";

export const AUTHZ_REVOKED_CHANNEL = "authz_revoked";
export const NOTES_CHANGED_CHANNEL = "notes_changed";

export const REVOKE_SCOPES = ["note", "org", "team", "workspace", "session", "user"] as const;
export type RevokeScope = (typeof REVOKE_SCOPES)[number];

export interface RevocationPayload {
  user_id: string;
  scope: RevokeScope;
  id: string;
}

export type RevokeAction = { kind: "close_document"; noteId: string } | { kind: "close_user" };

/** 08 X4：note → 只关该 document；其余一律关该用户全部连接 */
export function scopeToAction(scope: RevokeScope, id: string): RevokeAction {
  return scope === "note" ? { kind: "close_document", noteId: id } : { kind: "close_user" };
}

export function parseRevocation(raw: string): RevocationPayload | null {
  try {
    const v = JSON.parse(raw) as Partial<RevocationPayload>;
    if (typeof v.user_id !== "string" || !v.user_id) return null;
    if (typeof v.scope !== "string" || !(REVOKE_SCOPES as readonly string[]).includes(v.scope)) return null;
    return { user_id: v.user_id, scope: v.scope, id: typeof v.id === "string" ? v.id : "*" };
  } catch {
    return null;
  }
}

export interface NotesChangedPayload {
  workspace_id: string;
  note_id?: string;
  version?: number;
}

export function parseNotesChanged(raw: string): NotesChangedPayload | null {
  try {
    const v = JSON.parse(raw) as Partial<NotesChangedPayload>;
    if (typeof v.workspace_id !== "string" || !v.workspace_id) return null;
    const out: NotesChangedPayload = { workspace_id: v.workspace_id };
    if (typeof v.note_id === "string") out.note_id = v.note_id;
    if (typeof v.version === "number") out.version = v.version;
    return out;
  } catch {
    return null;
  }
}

export const CLOSE_AUTHZ_REVOKED = { code: 4403, reason: "authz_revoked" } as const;
export const CLOSE_GONE = { code: 4410, reason: "gone" } as const;
export const CLOSE_DOWNGRADED = { code: 4403, reason: "downgraded" } as const;

export function revokedStateless(noteId: string): string {
  return JSON.stringify({ t: "authz.revoked", note_id: noteId });
}

export function bumpStateless(workspaceId: string, version: number | undefined): string {
  return JSON.stringify({ t: "bump", workspace_id: workspaceId, version: version ?? null });
}

export interface RevocationDeps {
  directUrl: string | undefined;
  logger: Logger;
  metrics: SyncMetrics;
  registry: ConnectionRegistry;
  cache: AuthzCache;
  getHocuspocus: () => Hocuspocus | undefined;
  recheckIntervalMs?: number;
  pollIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  now?: () => number;
}

export interface Revocation {
  start(): void;
  stop(): Promise<void>;
  status(): ListenStatus;
  handleAuthzRevoked(raw: string): void;
  handleNotesChanged(raw: string): void;
  /** 全量重校验所有活动 (user, document)；返回统计 */
  recheckAll(): Promise<{ checked: number; closed: number }>;
}

export function createRevocation(deps: RevocationDeps): Revocation {
  const { logger, metrics, registry, cache } = deps;
  const now = deps.now ?? Date.now;
  const recheckIntervalMs = deps.recheckIntervalMs ?? 60_000;
  // 直连客户端不暴露事件，只能轮询 connected；间隔要短于最小重连退避（1 s），否则短暂掉线会被漏掉、重连后的全量重校验不触发
  const pollIntervalMs = deps.pollIntervalMs ?? 100;

  let client: DirectClient | undefined;
  let up = false;
  let everUp = false;
  let downSince: number | null = null;
  let pollTimer: NodeJS.Timeout | undefined;
  let recheckTimer: NodeJS.Timeout | undefined;
  let recheckInFlight: Promise<{ checked: number; closed: number }> | undefined;

  function closeDocumentConnections(
    conns: SyncConnection[],
    noteId: string,
    event: { code: number; reason: string },
  ) {
    for (const c of conns) {
      try {
        c.sendStateless(revokedStateless(noteId));
        metrics.messages.labels("out", "stateless").inc();
      } catch {
        /* socket 可能已关 */
      }
      c.close(event);
    }
  }

  function handleAuthzRevoked(raw: string) {
    const payload = parseRevocation(raw);
    if (!payload) {
      logger.warn({ channel: AUTHZ_REVOKED_CHANNEL }, "ignoring malformed authz_revoked payload");
      return;
    }
    metrics.authzRevoked.labels(payload.scope).inc();
    const action = scopeToAction(payload.scope, payload.id);
    if (action.kind === "close_document") {
      cache.invalidateNote(payload.user_id, action.noteId);
      const conns = registry.connectionsOf(payload.user_id, action.noteId);
      closeDocumentConnections(conns, action.noteId, CLOSE_AUTHZ_REVOKED);
      logger.info({ scope: payload.scope, userId: payload.user_id, closed: conns.length }, "authz revoked");
      return;
    }
    cache.invalidateUser(payload.user_id);
    const sockets = registry.socketsOf(payload.user_id);
    for (const s of sockets) {
      for (const c of s.connections) {
        try {
          c.sendStateless(revokedStateless(c.context.noteId ?? "*"));
          metrics.messages.labels("out", "stateless").inc();
        } catch {
          /* ignore */
        }
      }
      s.webSocket.close(CLOSE_AUTHZ_REVOKED.code, CLOSE_AUTHZ_REVOKED.reason);
    }
    logger.info({ scope: payload.scope, userId: payload.user_id, sockets: sockets.length }, "authz revoked");
  }

  function handleNotesChanged(raw: string) {
    const payload = parseNotesChanged(raw);
    if (!payload) return;
    const hp = deps.getHocuspocus();
    const doc = hp?.documents.get(inboxDocumentName(payload.workspace_id));
    if (!doc) return;
    doc.relayStateless(bumpStateless(payload.workspace_id, payload.version));
    metrics.messages.labels("out", "stateless").inc(doc.getConnectionsCount());
  }

  async function recheckAll(): Promise<{ checked: number; closed: number }> {
    if (recheckInFlight) return recheckInFlight;
    recheckInFlight = (async () => {
      const groups = new Map<string, { userId: string; ref: DocumentRef; conns: SyncConnection[] }>();
      for (const c of registry.allConnections()) {
        const ref = parseDocumentName(c.document.name);
        if (!ref) continue;
        const key = `${c.context.userId}|${c.document.name}`;
        let g = groups.get(key);
        if (!g) {
          g = { userId: c.context.userId, ref, conns: [] };
          groups.set(key, g);
        }
        g.conns.push(c);
      }
      let checked = 0;
      let closed = 0;
      for (const g of groups.values()) {
        try {
          // 第一条绕过缓存刷新，其余按各自 msv 从新鲜缓存取
          let first = true;
          for (const c of g.conns) {
            const res = await cache.decide(g.userId, g.ref, { msv: c.context.msv, bypass: first });
            first = false;
            checked += 1;
            if (!res.ok) {
              closeDocumentConnections(
                [c],
                g.ref.noteId ?? "*",
                res.reason === "gone" ? CLOSE_GONE : CLOSE_AUTHZ_REVOKED,
              );
              closed += 1;
            } else if (res.readOnly && !c.readOnly) {
              c.close(CLOSE_DOWNGRADED);
              closed += 1;
            }
          }
        } catch (err) {
          logger.warn(
            {
              userId: g.userId,
              documentName: g.ref.name,
              err: err instanceof Error ? err.message : String(err),
            },
            "recheck skipped (authorization query failed)",
          );
        }
      }
      if (closed > 0) logger.info({ checked, closed }, "periodic authorization recheck closed connections");
      return { checked, closed };
    })().finally(() => {
      recheckInFlight = undefined;
    });
    return recheckInFlight;
  }

  function poll() {
    const c = client;
    if (!c) return;
    const nowUp = c.connected;
    if (nowUp && !up) {
      up = true;
      downSince = null;
      metrics.listenUp.set(1);
      if (everUp) {
        logger.info("LISTEN connection re-established; running full authorization recheck");
        void recheckAll();
      }
      everUp = true;
    } else if (!nowUp && up) {
      up = false;
      downSince = now();
      metrics.listenUp.set(0);
    }
  }

  return {
    start() {
      if (recheckTimer) return;
      recheckTimer = setInterval(() => void recheckAll(), recheckIntervalMs);
      recheckTimer.unref();
      if (!deps.directUrl) {
        logger.warn(
          "DATABASE_URL_DIRECT 未设置：authz_revoked / notes_changed LISTEN 关闭（只剩 60 s 周期重校验）",
        );
        return;
      }
      downSince = now();
      metrics.listenUp.set(0);
      client = createDirectClient({
        connectionString: deps.directUrl,
        logger: logger.child({ name: "sync:listen" }),
        reconnectBaseMs: deps.reconnectBaseMs ?? 1_000,
        reconnectMaxMs: deps.reconnectMaxMs ?? 30_000,
      });
      void client.listen(AUTHZ_REVOKED_CHANNEL, handleAuthzRevoked).catch((err) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "listen authz_revoked failed",
        );
      });
      void client.listen(NOTES_CHANGED_CHANNEL, handleNotesChanged).catch((err) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "listen notes_changed failed",
        );
      });
      pollTimer = setInterval(poll, pollIntervalMs);
      pollTimer.unref();
      poll();
    },
    async stop() {
      if (recheckTimer) clearInterval(recheckTimer);
      if (pollTimer) clearInterval(pollTimer);
      recheckTimer = undefined;
      pollTimer = undefined;
      const c = client;
      client = undefined;
      up = false;
      metrics.listenUp.set(0);
      await c?.close();
    },
    status(): ListenStatus {
      return { enabled: Boolean(deps.directUrl), up, downSince };
    },
    handleAuthzRevoked,
    handleNotesChanged,
    recheckAll,
  };
}
