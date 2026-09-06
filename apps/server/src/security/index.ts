// 安全工具汇总（B2 复用）：限流中间件、安全头、CORS、argon2、列加密、token 工具。
export {
  ARGON2_MAX_CONCURRENCY,
  ARGON2_PARAMS,
  hashPassword,
  probeArgon2,
  verifyPassword,
} from "./argon2.js";
export { type ColumnCrypto, createColumnCrypto, parseDataKeys } from "./column-crypto.js";
export {
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  CORS_METHODS,
  corsFor,
  parseOrigins,
} from "./cors.js";
export { SECURITY_HEADERS, securityHeaders } from "./headers.js";
export {
  clientIp,
  configureRateLimit,
  createMemoryRateLimitBackend,
  createRedisRateLimitBackend,
  getRateLimitBackend,
  RATE_LIMIT_REDIS_PREFIX,
  type RateLimitBackend,
  type RateLimitDecision,
  type RateLimitOptions,
  rateLimit,
} from "./rate-limit.js";
export { isUuidLike, randomToken, safeEqual, sha256Base64url, sha256Buffer } from "./tokens.js";
