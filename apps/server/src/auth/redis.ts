// Better Auth secondaryStorage（限流计数 + session 缓存）落在 ioredis；key 统一前缀 bianfa:auth:ba:（多进程共用 Redis，绝不 FLUSH）。
// Redis 是 ephemeral（allkeys-lru）：session 真源在 DB（session.storeSessionInDatabase = true），这里只是缓存。
import type { Redis } from "ioredis";

export interface AuthSecondaryStorage {
  get: (key: string) => Promise<string | null>;
  getAndDelete: (key: string) => Promise<string | null>;
  increment: (key: string, ttl: number) => Promise<number>;
  set: (key: string, value: string, ttl?: number | undefined) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

export const BA_REDIS_PREFIX = "bianfa:auth:ba:";

const INCR_WITH_TTL = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return v
`;

export function createRedisSecondaryStorage(redis: Redis, prefix = BA_REDIS_PREFIX): AuthSecondaryStorage {
  const k = (key: string) => prefix + key;
  return {
    get: (key) => redis.get(k(key)),
    async getAndDelete(key) {
      const results = await redis.multi().get(k(key)).del(k(key)).exec();
      const first = results?.[0];
      return (first?.[1] as string | null | undefined) ?? null;
    },
    async increment(key, ttl) {
      const v = await redis.eval(INCR_WITH_TTL, 1, k(key), String(Math.max(1, Math.ceil(ttl))));
      return Number(v);
    },
    async set(key, value, ttl) {
      if (ttl && ttl > 0) await redis.set(k(key), value, "EX", Math.ceil(ttl));
      else await redis.set(k(key), value);
    },
    async delete(key) {
      await redis.del(k(key));
    },
  };
}
