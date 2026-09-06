// /v1 响应约定（规格 04 §6）：JSON、snake_case、统一带 server_time（ms）；错误 { error, ...extra }。
// 校验：zod 4 `.strict()` + @hono/zod-validator，失败 400 validation_failed。
import type { Hook } from "@hono/zod-validator";
import type { Context, Env } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

export type JsonBody = Record<string, unknown>;

export function ok(c: Context, data: JsonBody = {}, status: ContentfulStatusCode = 200): Response {
  return c.json({ ...data, server_time: Date.now() }, status);
}

export function fail(
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra: JsonBody = {},
): Response {
  return c.json({ error, ...extra, server_time: Date.now() }, status);
}

/** service 层抛出的业务错误 → 路由层统一映射成 fail() */
export class ApiFailure extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    readonly extra: JsonBody = {},
  ) {
    super(code);
    this.name = "ApiFailure";
  }
}

export interface RequestMeta {
  ip: string | null;
  ua: string | null;
  requestId: string | null;
}

/** 客户端 IP / UA / 请求 id（规格 01 §4：对端永远是 Caddy，取 CF-Connecting-IP，其次 X-Forwarded-For 首项） */
export function requestMeta(c: Context): RequestMeta {
  const cf = c.req.header("cf-connecting-ip");
  const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const real = c.req.header("x-real-ip");
  const ip = (cf ?? xff ?? real ?? "").trim() || null;
  const ua = c.req.header("user-agent")?.slice(0, 512) ?? null;
  const requestId = c.req.header("x-request-id")?.slice(0, 128) ?? null;
  return { ip, ua, requestId };
}

export const validationHook: Hook<unknown, Env, string> = (result, c) => {
  if (result.success) return;
  const issues = result.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
  return c.json({ error: "validation_failed", issues, server_time: Date.now() }, 400);
};

export const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "必须是 UUID");

/** Better Auth 的 text id：uuid（我们的 generateId）；宽松到任意 1–64 位安全字符，避免历史数据不匹配 */
export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const emailSchema = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());

export const nameSchema = z.string().trim().min(1).max(80);
