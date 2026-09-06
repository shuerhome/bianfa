// 限流（规格 04 §1.7）：固定窗口计数。REDIS_URL 存在 → Redis INCR+EXPIRE（键前缀 bianfa:api:rl:，多副本共享）；
// 否则进程内 Map（单副本 / 测试）。Redis 出错时 fail-open（限流丢失只导致更宽松，规格 04 R17）。
import type { Redis } from "ioredis";

export interface RateLimiter {
  /** 返回 { ok, remaining, retryAfter }；不抛错 */
  hit(bucket: string, key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  close(): Promise<void>;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfter: number;
}

export const RL_PREFIX = "bianfa:api:rl:";

export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const counters = new Map<string, { count: number; resetAt: number }>();
  let sweeps = 0;
  return {
    async hit(bucket, key, limit, windowSeconds) {
      const t = now();
      if (++sweeps % 1000 === 0) for (const [k, v] of counters) if (v.resetAt <= t) counters.delete(k);
      const id = `${bucket}:${key}`;
      let entry = counters.get(id);
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + windowSeconds * 1000 };
        counters.set(id, entry);
      }
      entry.count += 1;
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
      return { ok: entry.count <= limit, remaining: Math.max(0, limit - entry.count), retryAfter };
    },
    async close() {
      counters.clear();
    },
  };
}

export function createRedisRateLimiter(
  redis: Redis,
  fallback: RateLimiter = createMemoryRateLimiter(),
): RateLimiter {
  return {
    async hit(bucket, key, limit, windowSeconds) {
      const window = Math.floor(Date.now() / 1000 / windowSeconds);
      const id = `${RL_PREFIX}${bucket}:${key}:${window}`;
      try {
        const results = await redis
          .multi()
          .incr(id)
          .expire(id, windowSeconds + 1)
          .exec();
        const count = Number(results?.[0]?.[1] ?? 0);
        const retryAfter = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
        return {
          ok: count <= limit,
          remaining: Math.max(0, limit - count),
          retryAfter: Math.max(1, retryAfter),
        };
      } catch {
        return fallback.hit(bucket, key, limit, windowSeconds);
      }
    },
    async close() {
      await fallback.close();
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    },
  };
}

/** 按 REDIS_URL 选实现；连接失败退化为内存（不阻断启动） */
export async function createRateLimiter(redisUrl: string | undefined): Promise<RateLimiter> {
  if (!redisUrl) return createMemoryRateLimiter();
  try {
    const { Redis } = await import("ioredis");
    const redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
    });
    redis.on("error", () => {
      /* 限流 fail-open；错误由 hit() 的 catch 处理 */
    });
    await redis.connect().catch(() => {});
    return createRedisRateLimiter(redis);
  } catch {
    return createMemoryRateLimiter();
  }
}
