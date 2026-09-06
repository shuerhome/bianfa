// =============================================================================
// 直连（绕过 PgBouncer）的单条 pg.Client —— 只做 LISTEN（规格 01 S3 / §5）
// -----------------------------------------------------------------------------
// DSN 来自 DATABASE_URL_DIRECT（CI 别名 DATABASE_DIRECT_URL 由 config.ts 折叠）。sync-ws 进程独有；
// 掉线后指数退避自动重连并重新 LISTEN 所有频道。NOTIFY 不持久 —— 重连窗口内的通知会丢，
// 调用方仍需 60 s 周期重校验兜底（规格 01 §5）。
// 本阶段只实现连接与 listen(channel, handler)；authz_revoked 的业务处理在同步阶段接入。
// =============================================================================
import pg from "pg";
import { loadBaseEnv } from "../config.js";
import { createLogger, type Logger } from "../log.js";

export type NotificationHandler = (payload: string, channel: string) => void;

export interface DirectClientOptions {
  /** 缺省读 DATABASE_URL_DIRECT */
  connectionString?: string;
  logger?: Logger;
  /** 重连退避起点 / 上限（毫秒） */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export interface DirectClient {
  /** 当前是否处于已连接状态 */
  readonly connected: boolean;
  /** 订阅频道；返回取消订阅函数。频道在重连后自动重新 LISTEN。 */
  listen(channel: string, handler: NotificationHandler): Promise<() => Promise<void>>;
  /** 等待连接可用（首连或重连），超时抛错 */
  waitConnected(timeoutMs?: number): Promise<void>;
  /** 关闭并停止重连 */
  close(): Promise<void>;
}

export function createDirectClient(opts: DirectClientOptions = {}): DirectClient {
  const connectionString = opts.connectionString ?? requireDirectUrl();
  const logger = opts.logger ?? createLogger({ name: "db:direct" });
  const baseMs = opts.reconnectBaseMs ?? 500;
  const maxMs = opts.reconnectMaxMs ?? 30_000;

  const channels = new Map<string, Set<NotificationHandler>>();
  const waiters = new Set<{ resolve: () => void; reject: (e: Error) => void }>();
  let client: pg.Client | undefined;
  let connected = false;
  let closed = false;
  let attempt = 0;
  let timer: NodeJS.Timeout | undefined;
  let connecting: Promise<void> | undefined;

  function dispatch(msg: pg.Notification): void {
    const handlers = channels.get(msg.channel);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(msg.payload ?? "", msg.channel);
      } catch (err) {
        logger.error({ err: (err as Error).message, channel: msg.channel }, "notification handler threw");
      }
    }
  }

  function onDisconnect(c: pg.Client, reason: string): void {
    if (client !== c) return; // 旧连接的尾随事件
    client = undefined;
    connected = false;
    if (closed) return;
    logger.warn({ reason, attempt }, "direct connection lost; scheduling reconnect");
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (closed || timer) return;
    const delay = Math.min(maxMs, baseMs * 2 ** attempt) * (0.5 + Math.random() * 0.5);
    attempt += 1;
    timer = setTimeout(() => {
      timer = undefined;
      void connect();
    }, delay);
    timer.unref();
  }

  async function connect(): Promise<void> {
    if (closed || client || connecting) return;
    const c = new pg.Client({ connectionString, keepAlive: true });
    connecting = (async () => {
      try {
        await c.connect();
        c.on("notification", dispatch);
        c.on("error", (err) => {
          logger.warn({ err: err.message }, "direct client error");
          onDisconnect(c, "error");
        });
        c.on("end", () => onDisconnect(c, "end"));
        for (const channel of channels.keys()) {
          await c.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
        }
        client = c;
        connected = true;
        attempt = 0;
        for (const w of waiters) w.resolve();
        waiters.clear();
        logger.info({ channels: [...channels.keys()] }, "direct connection established");
      } catch (err) {
        logger.warn({ err: (err as Error).message, attempt }, "direct connect failed");
        void c.end().catch(() => {});
        scheduleReconnect();
      } finally {
        connecting = undefined;
      }
    })();
    await connecting;
  }

  void connect();

  return {
    get connected() {
      return connected;
    },

    async listen(channel, handler) {
      if (closed) throw new Error("direct client closed");
      let set = channels.get(channel);
      const isNew = !set;
      if (!set) {
        set = new Set();
        channels.set(channel, set);
      }
      set.add(handler);
      if (isNew && client) await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      return async () => {
        const s = channels.get(channel);
        if (!s) return;
        s.delete(handler);
        if (s.size === 0) {
          channels.delete(channel);
          if (client) await client.query(`UNLISTEN ${pg.escapeIdentifier(channel)}`).catch(() => {});
        }
      };
    },

    waitConnected(timeoutMs = 10_000) {
      if (connected) return Promise.resolve();
      if (closed) return Promise.reject(new Error("direct client closed"));
      return new Promise<void>((resolve, reject) => {
        const w = {
          resolve: () => {
            clearTimeout(t);
            resolve();
          },
          reject: (e: Error) => {
            clearTimeout(t);
            reject(e);
          },
        };
        const t = setTimeout(() => {
          waiters.delete(w);
          reject(new Error(`direct client not connected within ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.add(w);
      });
    },

    async close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const w of waiters) w.reject(new Error("direct client closed"));
      waiters.clear();
      const c = client;
      client = undefined;
      connected = false;
      await c?.end().catch(() => {});
    },
  };
}

function requireDirectUrl(): string {
  const env = loadBaseEnv();
  if (!env.DATABASE_URL_DIRECT) {
    throw new Error("DATABASE_URL_DIRECT（或别名 DATABASE_DIRECT_URL）未设置：LISTEN 必须走直连，不能用 DATABASE_URL");
  }
  return env.DATABASE_URL_DIRECT;
}
