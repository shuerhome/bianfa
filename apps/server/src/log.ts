// 结构化 JSON 日志（pino）。级别来自 LOG_LEVEL（默认 info），与 compose x-node-env / Alloy 采集约定一致。
import { type Logger, pino } from "pino";

export type { Logger };

export function createLogger(bindings: Record<string, unknown> = {}, level?: string): Logger {
  return pino({ level: level ?? process.env.LOG_LEVEL ?? "info", base: { pid: process.pid, ...bindings } });
}
