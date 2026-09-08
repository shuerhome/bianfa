// 统一错误（规格 04 §5.3）：AppError → { error: <code>, ...extra }；401 附 WWW-Authenticate；403 由装配层记 authz.denied 审计。
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiFailure } from "../auth/http.js";

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 426 | 429 | 500 | 503;

export class AppError extends Error {
  readonly status: ErrorStatus;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  /** 403 时的审计上下文（写 authz.denied） */
  readonly denied?: { orgId?: string | null; targetType?: string; targetId?: string; required?: unknown };

  constructor(
    status: ErrorStatus,
    code: string,
    extra: Record<string, unknown> = {},
    opts: { denied?: AppError["denied"]; cause?: unknown } = {},
  ) {
    super(code, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.extra = extra;
    if (opts.denied) this.denied = opts.denied;
  }
}

export const errors = {
  unauthorized: () => new AppError(401, "unauthorized"),
  accountDisabled: () => new AppError(401, "account_disabled"),
  notFound: (what = "not_found") => new AppError(404, what),
  insufficientPermission: (required: string, denied?: AppError["denied"]) =>
    new AppError(403, "insufficient_permission", { required }, { denied: { ...denied, required } }),
  insufficientRole: (required: { resource: string; action: string }, denied?: AppError["denied"]) =>
    new AppError(403, "insufficient_role", { required }, { denied: { ...denied, required } }),
  noActiveOrganization: () => new AppError(400, "no_active_organization"),
  validation: (issues: unknown) => new AppError(400, "validation_error", { issues }),
  conflict: (code: string, extra: Record<string, unknown> = {}) => new AppError(409, code, extra),
  gone: (code = "gone") => new AppError(410, code),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, "rate_limited", { retry_after: retryAfterSeconds }),
  serviceUnavailable: (code: string) => new AppError(503, code),
} as const;

export interface ErrorBody {
  error: string;
  [k: string]: unknown;
}

/** 把任意异常映射为 (status, body)；非 AppError 一律 500 internal_error（不泄漏细节） */
export function mapError(err: unknown): {
  status: ContentfulStatusCode;
  body: ErrorBody;
  headers: Record<string, string>;
} {
  if (err instanceof AppError) {
    const headers: Record<string, string> = {};
    if (err.status === 401) headers["WWW-Authenticate"] = 'Bearer error="invalid_token"';
    if (err.status === 429 && typeof err.extra.retry_after === "number")
      headers["Retry-After"] = String(err.extra.retry_after);
    return { status: err.status, body: { error: err.code, ...err.extra }, headers };
  }
  // auth 层（B1）的业务错误。它原本只在 auth/routes.ts 自己的 onError 里映射，
  // 但同源会话中间件现在也挂在 B2 的 /v1 管线上（app.ts 的 authed），不认它就会把
  // bad_origin / account_frozen 变成 500。
  if (err instanceof ApiFailure) {
    const headers: Record<string, string> = {};
    if (err.status === 401) headers["WWW-Authenticate"] = 'Bearer error="invalid_token"';
    return { status: err.status, body: { error: err.code, ...err.extra }, headers };
  }
  if (err instanceof HTTPException) {
    const status = err.status as ContentfulStatusCode;
    const code =
      status === 401
        ? "unauthorized"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "not_found"
            : status === 413
              ? "payload_too_large"
              : status >= 500
                ? "internal_error"
                : "bad_request";
    return {
      status,
      body: { error: code },
      headers: status === 401 ? { "WWW-Authenticate": 'Bearer error="invalid_token"' } : {},
    };
  }
  const anyErr = err as { type?: string; status?: number } | undefined;
  // Hono bodyLimit 抛的是 HTTPException(413)；JSON 解析失败是 SyntaxError
  if (err instanceof SyntaxError) return { status: 400, body: { error: "invalid_json" }, headers: {} };
  if (anyErr?.type === "entity.too.large")
    return { status: 413, body: { error: "payload_too_large" }, headers: {} };
  return { status: 500, body: { error: "internal_error" }, headers: {} };
}

/** 在 handler 内直接返回错误响应（不抛）——供限流等中间件使用 */
export function respondError(c: Context, err: AppError): Response {
  const { status, body, headers } = mapError(err);
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.json({ ...body, server_time: Date.now() }, status);
}
