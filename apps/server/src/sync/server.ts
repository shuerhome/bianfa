// 组装 Hocuspocus 4.6.0 Server（规格 03 §1）：onUpgrade 路径/Origin → onAuthenticate（JWT + 授权）→ 持久化钩子 →
// 限流/大小守卫 → awareness 裁剪 → Redis 扩展 → LISTEN/重校验 → /healthz /metrics → 优雅退出。
// Hocuspocus 4.6 已核实的 API：
// * onRequest / onUpgrade 处理完自己写响应后必须 reject 一个 falsy 值（`Promise.reject()`），Server 只在 error 为真时 rethrow。
// * onAuthenticate 抛出的对象以 `.reason` 回给 provider（onAuthenticationFailed({reason})）；返回值合并进 context。
// * beforeHandleMessage 抛出 {code, reason} → 只关闭该文档级连接（Connection.close 发 CLOSE 帧，socket 保留）。
// * Server.destroy()：关 http、closeConnections、flushPendingStores，等全部文档卸载后再跑 onDestroy。
import type { Duplex } from "node:stream";
import {
  type Connection,
  type Hocuspocus,
  MessageType,
  type onAuthenticatePayload,
  type onUpgradePayload,
  Server,
} from "@hocuspocus/server";
import type pg from "pg";
import type { Db } from "../db/client.js";
import type { Logger } from "../log.js";
import type { CompactionThresholds } from "../notes/doc-store.js";
import { AuthzCache, checkOrigin, isAllowedPath, parseDocumentName, SyncAuthError } from "./auth.js";
import { ConnectionRegistry, type SyncContext } from "./connections.js";
import { createHealth, type HealthReport } from "./health.js";
import {
  classifyMessage,
  createAwarenessBucket,
  MAX_DOCUMENTS_PER_SOCKET,
  MAX_MESSAGE_BYTES,
  MAX_SOCKETS_PER_USER,
  MAX_STATE_BYTES,
  messageTypeName,
  peekMessageType,
  peekSyncSubType,
  sanitizeAwarenessStates,
  type TokenBucket,
} from "./limits.js";
import { createMetrics, type SyncMetrics } from "./metrics.js";
import { type BossHandle, createBoss, createPersistence } from "./persistence.js";
import { createRedisExtension, createRedisPing, type RedisPing } from "./redis.js";
import { createRevocation } from "./revocation.js";
import { verifySyncToken } from "./token.js";

export interface SyncServerOptions {
  port?: number;
  address?: string;
  pool: pg.Pool;
  db: Db;
  tokenSecret: string;
  allowedOrigins?: ReadonlySet<string> | null;
  /** DATABASE_URL_DIRECT；缺省 = 不 LISTEN */
  directUrl?: string | undefined;
  redis?: { url: string; identifier: string; prefix?: string } | null;
  logger: Logger;
  metrics?: SyncMetrics;
  /** 入队用 pg-boss（缺省按 bossConnectionString 建）；测试可注入 */
  boss?: BossHandle;
  bossConnectionString?: string;
  authzCacheTtlMs?: number;
  recheckIntervalMs?: number;
  listenGraceMs?: number;
  listenReconnectBaseMs?: number;
  listenReconnectMaxMs?: number;
  compaction?: CompactionThresholds;
  debounce?: number;
  maxDebounce?: number;
  timeout?: number;
  storeRetryBaseMs?: number;
}

export interface SyncServer {
  server: Server<SyncContext>;
  hocuspocus: Hocuspocus<SyncContext>;
  metrics: SyncMetrics;
  registry: ConnectionRegistry;
  cache: AuthzCache;
  listen(): Promise<{ port: number }>;
  /** 停止接受新连接 → flush 所有文档的 onStoreDocument → 关闭连接与资源 */
  shutdown(opts?: { timeoutMs?: number }): Promise<void>;
  health(): Promise<HealthReport>;
  recheckNow(): Promise<{ checked: number; closed: number }>;
  /** 直接注入一条 NOTIFY 载荷（测试） */
  injectAuthzRevoked(raw: string): void;
  get stopping(): boolean;
}

/** beforeHandleMessage 用：Hocuspocus 读 code/reason 关闭该文档级连接 */
export class MessageRejected extends Error {
  constructor(
    readonly code: number,
    readonly reason: "too_large" | "rate",
  ) {
    super(`message rejected: ${reason}`);
    this.name = "MessageRejected";
  }
}

const STATUS_TEXT: Record<number, string> = {
  403: "Forbidden",
  404: "Not Found",
  503: "Service Unavailable",
};

function rejectUpgrade(socket: Duplex, status: number): void {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  } catch {
    /* ignore */
  }
  socket.destroy();
}

function pathnameOf(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

export function createSyncServer(opts: SyncServerOptions): SyncServer {
  const logger = opts.logger;
  const metrics = opts.metrics ?? createMetrics();
  const registry = new ConnectionRegistry();
  const cache = new AuthzCache(opts.db, opts.authzCacheTtlMs ?? 60_000);
  const allowedOrigins = opts.allowedOrigins ?? null;
  const boss =
    opts.boss ??
    createBoss({
      connectionString: opts.bossConnectionString ?? opts.pool.options.connectionString ?? "",
      logger: logger.child({ name: "sync:boss" }),
    });
  const persistence = createPersistence({
    pool: opts.pool,
    db: opts.db,
    logger: logger.child({ name: "sync:store" }),
    metrics,
    boss,
    compaction: opts.compaction,
    ...(opts.storeRetryBaseMs !== undefined ? { retryBaseMs: opts.storeRetryBaseMs } : {}),
  });
  let hocuspocusRef: Hocuspocus<SyncContext> | undefined;
  const revocation = createRevocation({
    directUrl: opts.directUrl,
    logger: logger.child({ name: "sync:authz" }),
    metrics,
    registry,
    cache,
    getHocuspocus: () => hocuspocusRef,
    ...(opts.recheckIntervalMs !== undefined ? { recheckIntervalMs: opts.recheckIntervalMs } : {}),
    ...(opts.listenReconnectBaseMs !== undefined ? { reconnectBaseMs: opts.listenReconnectBaseMs } : {}),
    ...(opts.listenReconnectMaxMs !== undefined ? { reconnectMaxMs: opts.listenReconnectMaxMs } : {}),
  });
  let redisPing: RedisPing | undefined;
  // 持久化钩子作为独立 extension 且优先级高于 extension-redis（1000）：redis 扩展的 onStoreDocument 用 Redlock
  //（retryCount 0）抢单写者锁，抢不到就 SkipFurtherHooks —— 被拒的副本不再重试、持锁副本又可能无新内容可写，
  // 会静默丢掉一次持久化。seq 唯一性与去重本来就靠 FOR UPDATE 行锁 + diffUpdateV2(crdt_sv)（03 §1.5），
  // 所以让本地存储先于 redis 锁执行；redis 锁退化为无害的附加互斥。
  const persistenceExtension = {
    priority: 1001,
    extensionName: "bianfa-persistence",
    onLoadDocument: (payload: Parameters<typeof persistence.onLoadDocument>[0]) =>
      persistence.onLoadDocument(payload),
    onStoreDocument: (payload: Parameters<typeof persistence.onStoreDocument>[0]) =>
      persistence.onStoreDocument(payload),
    afterUnloadDocument: (payload: { documentName: string }) => persistence.afterUnloadDocument(payload),
  };
  const extensions: Array<typeof persistenceExtension | ReturnType<typeof createRedisExtension>> = [
    persistenceExtension,
  ];
  if (opts.redis) {
    extensions.push(
      createRedisExtension({
        url: opts.redis.url,
        identifier: opts.redis.identifier,
        ...(opts.redis.prefix ? { prefix: opts.redis.prefix } : {}),
      }),
    );
    redisPing = createRedisPing(opts.redis.url);
  }
  let stopping = false;
  /** 文档级连接各自的 awareness 桶（连接销毁即随 GC 释放） */
  const awarenessBuckets = new WeakMap<object, TokenBucket>();
  const health = createHealth({
    pool: opts.pool,
    redisPing: redisPing ? () => (redisPing as RedisPing).ping() : undefined,
    listenStatus: () => revocation.status(),
    stopping: () => stopping,
    ...(opts.listenGraceMs !== undefined ? { listenGraceMs: opts.listenGraceMs } : {}),
  });

  function authFail(err: SyncAuthError, documentName: string): never {
    if (err.reason === "too_many_documents") metrics.rejected.labels("limit").inc();
    else metrics.authFailures.labels(err.reason).inc();
    logger.info({ reason: err.reason, detail: err.detail, documentName }, "authentication rejected");
    throw err;
  }

  const server = new Server<SyncContext>({
    port: opts.port ?? 4000,
    address: opts.address ?? "0.0.0.0",
    name: "bianfa-sync",
    quiet: true,
    stopOnSignals: false,
    timeout: opts.timeout ?? 60_000,
    debounce: opts.debounce ?? 2_000,
    maxDebounce: opts.maxDebounce ?? 10_000,
    unloadImmediately: false,
    yDocOptions: { gc: true, gcFilter: () => true },
    websocketOptions: { maxPayload: MAX_MESSAGE_BYTES },
    extensions,

    async onUpgrade({ request, socket }: onUpgradePayload) {
      const pathname = pathnameOf(request.url);
      let status: number | null = null;
      let reason: "path" | "origin" | null = null;
      if (stopping) status = 503;
      else if (!isAllowedPath(pathname)) {
        status = 404;
        reason = "path";
      } else if (!checkOrigin(request.headers.origin, allowedOrigins)) {
        status = 403;
        reason = "origin";
      }
      if (status === null) return;
      if (reason) {
        metrics.authFailures.labels(reason).inc();
        logger.info({ reason, pathname, status }, "upgrade rejected");
      }
      rejectUpgrade(socket as Duplex, status);
      return Promise.reject(); // 已处理：falsy reject 让 Hocuspocus 不再继续升级也不 rethrow
    },

    async onRequest({ request, response }) {
      const pathname = pathnameOf(request.url);
      if (pathname === "/healthz") {
        const report = await health.check();
        response.writeHead(report.ok ? 200 : 503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ ok: report.ok, service: "sync", checks: report.checks }));
        return Promise.reject();
      }
      if (pathname === "/metrics") {
        const body = await metrics.registry.metrics();
        response.writeHead(200, { "content-type": metrics.registry.contentType });
        response.end(body);
        return Promise.reject();
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return Promise.reject();
    },

    async onAuthenticate({
      token,
      documentName,
      socketId,
      connectionConfig,
    }: onAuthenticatePayload<SyncContext>) {
      const ref = parseDocumentName(documentName);
      if (!ref) authFail(new SyncAuthError("forbidden", "bad document name"), documentName);
      const verified = await verifySyncToken(opts.tokenSecret, token);
      if (!verified.ok) authFail(new SyncAuthError(verified.reason, "token"), documentName);
      const { sub: userId, did, sid, msv } = verified.claims;
      const decision = await cache.decide(userId, ref, { msv });
      if (!decision.ok) authFail(new SyncAuthError(decision.reason, decision.detail), documentName);
      if (!registry.reserveDocument(socketId, MAX_DOCUMENTS_PER_SOCKET)) {
        authFail(
          new SyncAuthError("too_many_documents", `> ${MAX_DOCUMENTS_PER_SOCKET} documents on one socket`),
          documentName,
        );
      }
      connectionConfig.readOnly = decision.readOnly;
      const context: SyncContext = {
        userId,
        deviceId: did,
        sessionId: sid,
        msv,
        kind: ref.kind,
        workspaceId: ref.workspaceId,
        noteId: ref.noteId,
        perm: decision.perm,
        readOnly: decision.readOnly,
        createIfMissing: decision.createIfMissing,
      };
      return context;
    },

    async connected({ connection, socketId }) {
      registry.addConnection(socketId, connection);
      const victims = registry.enforceUserSocketLimit(
        connection.context.userId,
        MAX_SOCKETS_PER_USER,
        socketId,
      );
      if (victims.length > 0) {
        metrics.rejected.labels("limit").inc(victims.length);
        logger.info(
          { userId: connection.context.userId, closed: victims.length },
          "per-user socket limit: closed oldest",
        );
      }
    },

    async onDisconnect({ socketId, documentName }) {
      registry.removeConnection(socketId, documentName);
    },

    async beforeHandleMessage({ update, connection, socketId, documentName }) {
      const type = peekMessageType(update);
      metrics.messages.labels("in", messageTypeName(type)).inc();
      if (update.byteLength > MAX_MESSAGE_BYTES) {
        metrics.rejected.labels("too_large").inc();
        throw new MessageRejected(1009, "too_large");
      }
      const kind = classifyMessage(update);
      if (kind !== "awareness") {
        const entry = registry.ensureSocket(socketId, connection.context.userId, connection.webSocket);
        const verdict = entry.limiter.takeMessage(kind);
        if (verdict !== "ok") {
          metrics.rejected.labels("rate").inc();
          if (verdict === "close") {
            logger.info(
              { socketId, userId: connection.context.userId },
              "rate limit exceeded for 10 s: closing socket",
            );
            connection.webSocket.close(4429, "rate");
          }
          throw new MessageRejected(4429, "rate");
        }
      }
      if (type === MessageType.Sync && !connection.readOnly) {
        const sub = peekSyncSubType(update);
        // 1 = SyncStep2, 2 = Update：携带 structs，会增大状态
        if (
          (sub === 1 || sub === 2) &&
          persistence.stateSize(documentName) + update.byteLength > MAX_STATE_BYTES
        ) {
          metrics.rejected.labels("too_large").inc();
          logger.info({ documentName }, "document state would exceed 4 MB: rejecting update");
          throw new MessageRejected(1009, "too_large");
        }
      }
    },

    async beforeHandleAwareness({ states, context, connection }) {
      if (!connection || !context) return;
      let bucket = awarenessBuckets.get(connection);
      if (!bucket) {
        bucket = createAwarenessBucket();
        awarenessBuckets.set(connection, bucket);
      }
      if (!bucket.tryTake()) {
        metrics.rejected.labels("rate").inc();
        states.clear(); // 丢弃：空 map 重新编码为无操作
        return;
      }
      sanitizeAwarenessStates(states, context.userId);
    },

    async onChange({ documentName, update }) {
      persistence.noteChange(documentName, update.byteLength);
    },
  });

  const hocuspocus = server.hocuspocus;
  hocuspocusRef = hocuspocus;
  metrics.setCollectors({
    connections: () => hocuspocus.getConnectionsCount(),
    documents: () => hocuspocus.getDocumentsCount(),
  });

  return {
    server,
    hocuspocus,
    metrics,
    registry,
    cache,
    get stopping() {
      return stopping;
    },
    async listen() {
      await server.listen();
      revocation.start();
      return { port: server.address.port };
    },
    async shutdown({ timeoutMs = 25_000 } = {}) {
      stopping = true;
      await revocation.stop();
      const destroyed = server.destroy();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref();
      });
      const result = await Promise.race([destroyed.then(() => "ok" as const), timedOut]);
      if (timer) clearTimeout(timer);
      if (result === "timeout") {
        logger.error({ documents: hocuspocus.getDocumentsCount() }, "shutdown: flushing documents timed out");
      }
      persistence.stop();
      await boss.stop();
      await redisPing?.quit();
    },
    health: () => health.check(),
    recheckNow: () => revocation.recheckAll(),
    injectAuthzRevoked: (raw) => revocation.handleAuthzRevoked(raw),
  };
}

export type { Connection };
