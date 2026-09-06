// =============================================================================
// 滑动窗口限流（规格 04 §1.7）：Redis ZSET（多副本共享计数）；无 Redis 时进程内存兜底（仅测试 / 单副本）。
// -----------------------------------------------------------------------------
// * 中间件工厂 rateLimit({ key, limit, windowSeconds })：key 返回 null 表示本次不计（例如匿名路由缺 IP）。
// * 超限 → 429 { error: 'rate_limited', retry_after } + Retry-After 头；每次响应带 X-RateLimit-Limit / Remaining。
// * Redis key 前缀固定 `bianfa:auth:rl:`（多个进程共用同一 Redis，绝不 FLUSH）。
// * 后端由 configureRateLimit() 设定一次（createAuth 里做），B2 直接调用 rateLimit() 即可。
// =============================================================================
import type { Context, MiddlewareHandler } from "hono";
import type { Redis } from "ioredis";

export interface RateLimitDecision {
  allowed: boolean;
  /** 窗口内剩余次数（拒绝时为 0） */
  remaining: number;
  /** 拒绝时建议等待秒数（≥ 1）；允许时为 0 */
  retryAfterSeconds: number;
}

export interface RateLimitBackend {
  consume(key: string, limit: number, windowSeconds: number, now?: number): Promise<RateLimitDecision>;
  close?(): Promise<void>;
}

export interface RateLimitOptions {
  /** 计数维度；返回 null 则跳过 */
  key: (c: Context) => string | null | Promise<string | null>;
  limit: number;
  windowSeconds: number;
  /** 覆盖全局后端（测试用） */
  backend?: RateLimitBackend;
  /** 出现在 key 里的路由名，避免不同路由同 key 互相干扰 */
  name?: string;
}

// ---------------------------------------------------------------- 内存后端（滑动日志）
export function createMemoryRateLimitBackend(): RateLimitBackend {
  const log = new Map<string, number[]>();
  let lastSweep = 0;
  return {
    async consume(key, limit, windowSeconds, now = Date.now()) {
      const windowMs = windowSeconds * 1000;
      const floor = now - windowMs;
      if (now - lastSweep > 60_000) {
        lastSweep = now;
        for (const [k, arr] of log) {
          const kept = arr.filter((t) => t > floor);
          if (kept.length === 0) log.delete(k);
          else log.set(k, kept);
        }
      }
      const hits = (log.get(key) ?? []).filter((t) => t > floor);
      if (hits.length >= limit) {
        log.set(key, hits);
        const oldest = hits[0] as number;
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
        };
      }
      hits.push(now);
      log.set(key, hits);
      return { allowed: true, remaining: limit - hits.length, retryAfterSeconds: 0 };
    },
  };
}

// ---------------------------------------------------------------- Redis 后端（ZSET 滑动窗口，Lua 原子）
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then retry = tonumber(oldest[2]) + window - now end
  return {0, 0, retry}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, limit - count - 1, 0}
`;

export const RATE_LIMIT_REDIS_PREFIX = "bianfa:auth:rl:";

export function createRedisRateLimitBackend(
  redis: Redis,
  prefix = RATE_LIMIT_REDIS_PREFIX,
): RateLimitBackend {
  let sha: string | undefined;
  let seq = 0;
  async function run(
    key: string,
    limit: number,
    windowSeconds: number,
    now: number,
  ): Promise<[number, number, number]> {
    const args = [String(now), String(windowSeconds * 1000), String(limit), `${now}-${process.pid}-${seq++}`];
    try {
      sha ??= (await redis.script("LOAD", SLIDING_WINDOW_LUA)) as string;
      return (await redis.evalsha(sha, 1, prefix + key, ...args)) as [number, number, number];
    } catch (err) {
      if (err instanceof Error && /NOSCRIPT/.test(err.message)) {
        sha = undefined;
        return (await redis.eval(SLIDING_WINDOW_LUA, 1, prefix + key, ...args)) as [number, number, number];
      }
      throw err;
    }
  }
  return {
    async consume(key, limit, windowSeconds, now = Date.now()) {
      const [allowed, remaining, retryMs] = await run(key, limit, windowSeconds, now);
      return {
        allowed: allowed === 1,
        remaining: Math.max(0, remaining),
        retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(retryMs / 1000)),
      };
    },
  };
}

// ---------------------------------------------------------------- 全局后端 + 中间件
let defaultBackend: RateLimitBackend = createMemoryRateLimitBackend();

/** 由 createAuth 调用一次；无 Redis 时保持内存后端 */
export function configureRateLimit(backend: RateLimitBackend): void {
  defaultBackend = backend;
}

export function getRateLimitBackend(): RateLimitBackend {
  return defaultBackend;
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const name = opts.name ?? "";
  return async (c, next) => {
    const raw = await opts.key(c);
    if (raw === null || raw === undefined || raw === "") {
      await next();
      return;
    }
    const backend = opts.backend ?? defaultBackend;
    let decision: RateLimitDecision;
    try {
      decision = await backend.consume(`${name}:${raw}`, opts.limit, opts.windowSeconds);
    } catch {
      // 限流后端故障（Redis 掉线）→ fail-open：宁可放行也不把整个 API 拖死（规格 R17 同一取舍）
      await next();
      return;
    }
    c.header("X-RateLimit-Limit", String(opts.limit));
    c.header("X-RateLimit-Remaining", String(decision.remaining));
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSeconds));
      return c.json(
        { error: "rate_limited", retry_after: decision.retryAfterSeconds, server_time: Date.now() },
        429,
      );
    }
    await next();
  };
}

/** 客户端 IP：进程对端永远是 Caddy，按规格 01 §4 取 CF-Connecting-IP，其次 X-Forwarded-For 首项、X-Real-IP */
export function clientIp(c: Context): string | null {
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header("x-real-ip");
  return real ? real.trim() : null;
}
