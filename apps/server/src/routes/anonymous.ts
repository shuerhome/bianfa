// 匿名端点：GET /v1/notice（规格 04 §6.5 / §7.8；60/min/ip；Cache-Control: public, max-age=300）
//          POST /v1/telemetry（12 个计数器，只计数不落库，204；60/min/ip）
// 这两个路径在 bearerOnly 的匿名白名单里（src/app.ts）。
import { Hono } from "hono";
import { z } from "zod";
import { errors, respondError } from "../http/errors.js";
import { clientIp } from "../http/middleware.js";
import { validate } from "../http/validate.js";
import type { RouteDeps, RouteEnv } from "./context.js";

/** 桌面端允许上报的计数器（规格 01 S6 / 04 §7.7：只有计数器，永不含便笺内容） */
export const TELEMETRY_COUNTERS = [
  "app_start",
  "note_created",
  "note_deleted",
  "sync_connected",
  "sync_reconnect",
  "sync_conflict",
  "shrink_guard_tripped",
  "import_completed",
  "import_degraded",
  "crash_reported",
  "update_applied",
  "search_used",
] as const;
export type TelemetryCounter = (typeof TELEMETRY_COUNTERS)[number];

const telemetrySchema = z
  .object({
    install_id: z.uuidv4(),
    app_version: z.string().max(32).optional(),
    platform: z.enum(["windows", "macos", "linux"]).optional(),
    counters: z
      .partialRecord(z.enum(TELEMETRY_COUNTERS), z.number().int().min(0).max(1_000_000))
      .refine((r) => Object.keys(r).length <= TELEMETRY_COUNTERS.length, { message: "too many counters" }),
  })
  .strict();

/** 进程内累加（供 /metrics 或日志抽样；不做持久化） */
export class TelemetryTotals {
  readonly totals = new Map<TelemetryCounter, number>();
  add(counters: Partial<Record<TelemetryCounter, number>>): void {
    for (const [k, v] of Object.entries(counters)) {
      const key = k as TelemetryCounter;
      this.totals.set(key, (this.totals.get(key) ?? 0) + (v ?? 0));
    }
  }
}

export function anonymousRoutes(deps: RouteDeps, totals = new TelemetryTotals()): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();

  app.get("/notice", async (c) => {
    const rl = await deps.rateLimiter.hit("notice", clientIp(c), 60, 60);
    if (!rl.ok) return respondError(c, errors.rateLimited(rl.retryAfter));
    const envelope = await deps.notice.load();
    c.header("Cache-Control", "public, max-age=300");
    c.header("X-Robots-Tag", "noindex");
    if (!envelope) return c.body(null, 204);
    return c.json(envelope);
  });

  app.post("/telemetry", validate("json", telemetrySchema), async (c) => {
    const rl = await deps.rateLimiter.hit("telemetry", clientIp(c), 60, 60);
    if (!rl.ok) return respondError(c, errors.rateLimited(rl.retryAfter));
    const body = c.req.valid("json");
    totals.add(body.counters);
    deps.log.debug(
      { counters: Object.keys(body.counters).length, platform: body.platform ?? null },
      "telemetry accepted",
    );
    return c.body(null, 204);
  });

  return app;
}
