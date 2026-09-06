// 服务端 API 公共层：全部经 api_request（Rust 注入 Bearer；WebView 无网络）。
// 线格式 = 服务端 snake_case + ISO 时间 + server_time(ms)；只在 src/api/* 里转成 camelCase / Unix ms。
// 错误：{ error: <code>, ...extra, request_id?, server_time } → IpcError(code = 服务端 error 或 http_<status>)。
import { apiRequest } from "../ipc/commands.js";
import { IpcError } from "../ipc/errors.js";
import type { ApiResponse } from "../ipc/types.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiErrorDetails {
  status: number;
  body: Record<string, unknown> | null;
  requestId: string | null;
}

/** 便于 UI 判断的稳定错误码（服务端 src/http/errors.ts + auth/http.ts） */
export const API_ERROR = {
  unauthorized: "unauthorized",
  upgradeRequired: "upgrade_required",
  rateLimited: "rate_limited",
  deviceLimit: "device_limit_reached",
  quotaExceeded: "quota_exceeded",
  attachmentsDisabled: "attachments_disabled",
  exportRateLimited: "export_rate_limited",
  transferOwnershipFirst: "transfer_ownership_first",
  notFound: "not_found",
  /** POST /v1/me/security-code：当前密码不对 */
  invalidPassword: "invalid_password",
  /** 安全码不能和密码相同（两端都校验） */
  securityCodeEqualsPassword: "security_code_equals_password",
  /** 社交登录账号没有密码，不能改安全码 */
  noPassword: "no_password",
} as const;

function parseBody(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 非 2xx → IpcError；426 固定映射为 upgrade_required（sync host 据此暂停） */
export function toApiError(res: ApiResponse): IpcError {
  const body = parseBody(res.bodyText);
  const serverCode = typeof body?.error === "string" ? body.error : null;
  const code = res.status === 426 ? API_ERROR.upgradeRequired : (serverCode ?? `http_${res.status}`);
  const message =
    res.status === 426
      ? "需要升级客户端才能继续同步"
      : serverCode
        ? `服务端返回 ${res.status}：${serverCode}`
        : `服务端返回 ${res.status}`;
  const details: ApiErrorDetails = {
    status: res.status,
    body,
    requestId: typeof body?.request_id === "string" ? body.request_id : null,
  };
  return new IpcError(code, message, details);
}

export function isApiError(err: unknown, code?: string): err is IpcError & { details: ApiErrorDetails } {
  if (!(err instanceof IpcError)) return false;
  const d = err.details as Partial<ApiErrorDetails> | undefined;
  if (!d || typeof d.status !== "number") return false;
  return code === undefined || err.code === code;
}

/** 请求 + 解析；204 / 空 body 返回 undefined（调用方按需断言） */
export async function apiJson<T>(
  method: HttpMethod,
  path: string,
  opts: {
    body?: unknown;
    timeoutMs?: number;
    query?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<T> {
  const qs = opts.query
    ? Object.entries(opts.query)
        .filter((e): e is [string, string | number | boolean] => e[1] !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const full = qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
  const res = await apiRequest({
    method,
    path: full,
    ...(opts.body !== undefined ? { jsonBody: opts.body } : {}),
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  if (res.status < 200 || res.status >= 300) throw toApiError(res);
  if (res.status === 204 || res.bodyText.length === 0) return undefined as T;
  try {
    return JSON.parse(res.bodyText) as T;
  } catch {
    throw new IpcError("bad_json", "服务端返回了无法解析的内容", {
      status: res.status,
      body: null,
      requestId: null,
    });
  }
}

/** ISO-8601 → Unix ms；null / 非法 → null */
export function isoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** 与 isoToMs 同，但缺失时回退到 fallback（列表排序等不允许 null 的场合） */
export function isoToMsOr(iso: string | null | undefined, fallback: number): number {
  return isoToMs(iso) ?? fallback;
}
