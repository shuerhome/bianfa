// api / worker 的 pino 实例：规格 04 §7.7 的 redact 列表（日志只记 user_id，永不记 body / token / email）。
import { type Logger, pino } from "pino";

export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.password",
  "*.token",
  "*.refresh_token",
  "*.access_token",
  "*.code",
  "*.code_verifier",
  "*.user_code",
  "*.email",
  "*.body",
  "*.content",
  "*.content_text",
] as const;

export function createApiLogger(name: string, level: string = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    level,
    base: { pid: process.pid, name },
    redact: { paths: [...REDACT_PATHS], censor: "[redacted]" },
  });
}
