// Redis（规格 03 §1.6）：extension-redis 4.6.0 只接受 host/port/options（ioredis 5 选项对象）或 createClient/redis 实例；
// 这里把 REDIS_URL 解析成 host/port/options，让扩展用它自己依赖的 ioredis 建 pub/sub；/healthz 的 PING 用本包的 ioredis 6。
// 前缀 bianfa:sync:hp（键 `<prefix>:<documentName>` 等），identifier = hostname[-pid]。
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import { Redis as IORedis } from "ioredis";

export interface ParsedRedisUrl {
  host: string;
  port: number;
  options: {
    username?: string;
    password?: string;
    db?: number;
    tls?: Record<string, never>;
  };
}

export function parseRedisUrl(url: string): ParsedRedisUrl {
  const u = new URL(url);
  if (u.protocol !== "redis:" && u.protocol !== "rediss:")
    throw new Error(`不支持的 Redis URL 协议：${u.protocol}`);
  const options: ParsedRedisUrl["options"] = {};
  if (u.username) options.username = decodeURIComponent(u.username);
  if (u.password) options.password = decodeURIComponent(u.password);
  const dbPath = u.pathname.replace(/^\//, "");
  if (dbPath) {
    const db = Number(dbPath);
    if (!Number.isInteger(db) || db < 0) throw new Error(`Redis URL 的 db 无效：${dbPath}`);
    options.db = db;
  }
  if (u.protocol === "rediss:") options.tls = {};
  return { host: u.hostname, port: u.port ? Number(u.port) : 6379, options };
}

export interface RedisExtensionOptions {
  url: string;
  identifier: string;
  prefix?: string;
}

export const REDIS_PREFIX = "bianfa:sync:hp";

export function createRedisExtension(opts: RedisExtensionOptions): RedisExtension {
  const parsed = parseRedisUrl(opts.url);
  return new RedisExtension({
    host: parsed.host,
    port: parsed.port,
    options: parsed.options,
    prefix: opts.prefix ?? REDIS_PREFIX,
    identifier: opts.identifier,
  });
}

export interface RedisPing {
  ping(): Promise<void>;
  quit(): Promise<void>;
}

/** /healthz 用的轻量客户端：不排队离线命令，失败立刻暴露 */
export function createRedisPing(url: string): RedisPing {
  const client = new IORedis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    retryStrategy: (times: number) => Math.min(1_000 * times, 5_000),
  });
  client.on("error", () => {
    /* 由 ping() 的 reject 体现；避免未处理的 error 事件 */
  });
  return {
    async ping() {
      if (client.status === "wait") await client.connect();
      const reply = await client.ping();
      if (reply !== "PONG") throw new Error(`redis ping: ${reply}`);
    },
    async quit() {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}
