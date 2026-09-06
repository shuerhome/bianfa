// Better Auth / 自建端点的错误统一成 { code, status, message }，再映射到 i18n 键（errors.<code>，缺省 errors.generic）。
import i18next from "i18next";

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
}

interface FetchErrorLike {
  status?: number;
  statusText?: string;
  code?: string;
  message?: string;
  error?: string;
  error_description?: string;
}

/** better-fetch 的 error 对象（{ status, code?, message? }）或 OAuth 风格 { error, error_description } */
export function toFailure(err: unknown): ApiFailure {
  if (!err || typeof err !== "object") return { status: 0, code: "network", message: "" };
  const e = err as FetchErrorLike;
  const status = typeof e.status === "number" ? e.status : 0;
  const code =
    (typeof e.code === "string" && e.code) ||
    (typeof e.error === "string" && e.error) ||
    (status === 429 ? "rate_limited" : status === 0 ? "network" : `http_${status}`);
  const message =
    (typeof e.message === "string" && e.message) ||
    (typeof e.error_description === "string" && e.error_description) ||
    "";
  return { status, code, message };
}

/** 把错误码翻译成用户可读文案：errors.<code> 存在就用，否则通用兜底（限流单独处理） */
export function describeFailure(f: ApiFailure): string {
  if (f.status === 429 || f.code === "rate_limited") return i18next.t("errors.rate_limited");
  if (f.code === "network") return i18next.t("errors.network");
  const key = `errors.${f.code}`;
  if (i18next.exists(key)) return i18next.t(key);
  return i18next.t("errors.generic");
}
