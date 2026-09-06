// 非 Better Auth 核心的端点统一走 authClient.$fetch（带 cookie、带 oauth_query fetch 插件），
// 路径与参数名逐一核对过 node_modules 里 1.7.3 的源码（见各函数注释）。返回 { ok, data | error } 不抛。
import { authClient } from "./auth-client.js";
import { type ApiFailure, toFailure } from "./lib/errors.js";

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

async function wrap<T>(p: Promise<{ data: unknown; error: unknown }>): Promise<Result<T>> {
  try {
    const r = await p;
    if (r.error) return { ok: false, error: toFailure(r.error) };
    return { ok: true, data: r.data as T };
  } catch (err) {
    return { ok: false, error: toFailure(err) };
  }
}

export interface WebConfig {
  providers: Array<"google" | "apple">;
  app_origin: string;
  download_url: string | null;
}

const FALLBACK_CONFIG: WebConfig = {
  providers: [],
  app_origin: typeof window !== "undefined" ? window.location.origin : "",
  download_url: null,
};

/** GET /web-config.json（apps/server/src/http/web-config.ts）：社交登录按钮只在服务端配置了 provider 时出现 */
export async function fetchWebConfig(): Promise<WebConfig> {
  try {
    const res = await fetch("/web-config.json", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return FALLBACK_CONFIG;
    const body = (await res.json()) as Partial<WebConfig>;
    const providers = Array.isArray(body.providers)
      ? body.providers.filter((p): p is "google" | "apple" => p === "google" || p === "apple")
      : [];
    return {
      providers,
      app_origin: typeof body.app_origin === "string" ? body.app_origin : FALLBACK_CONFIG.app_origin,
      download_url: typeof body.download_url === "string" ? body.download_url : null,
    };
  } catch {
    return FALLBACK_CONFIG;
  }
}

export interface InvitePreview {
  org_name: string;
  inviter_name: string;
  role: string;
  expires_at: string;
}

/** GET /v1/invites/:token/preview（匿名，10/min/ip；apps/server/src/auth/routes.ts）；404 = 无效或已过期 */
export async function fetchInvitePreview(token: string): Promise<Result<InvitePreview>> {
  try {
    const res = await fetch(`/v1/invites/${encodeURIComponent(token)}/preview`, {
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    const body = (await res.json().catch(() => ({}))) as { invitation?: InvitePreview; error?: string };
    if (!res.ok || !body.invitation)
      return {
        ok: false,
        error: { status: res.status, code: body.error ?? `http_${res.status}`, message: "" },
      };
    return { ok: true, data: body.invitation };
  } catch (err) {
    return { ok: false, error: toFailure(err) };
  }
}

export interface AcceptedInvite {
  invitation: { id: string; status: string };
  member: { organization_id: string; user_id: string; role: string; team_id: string | null };
  organization: { id: string; name: string; slug: string };
}

/**
 * POST /api/auth/organization/accept-invitation { invitationId: <邮件 token> }（cookie）。
 * 服务端 desktop-plugin 的 before-hook 把 token 交给 acceptInvitationByToken（与 /v1/invites/accept 同一 service），
 * 错误 code：not_found / invitation_email_mismatch / email_not_verified / already_member / seat_limit。
 */
export function acceptInvite(token: string): Promise<Result<AcceptedInvite>> {
  return wrap(
    authClient.$fetch("/organization/accept-invitation", { method: "POST", body: { invitationId: token } }),
  );
}

/** POST /api/auth/organization/reject-invitation { invitationId: <邮件 token> } */
export function rejectInvite(token: string): Promise<Result<{ invitation: { id: string; status: string } }>> {
  return wrap(
    authClient.$fetch("/organization/reject-invitation", { method: "POST", body: { invitationId: token } }),
  );
}

export interface DeviceClaim {
  user_code: string;
  status: "pending" | "approved" | "denied";
  /** 只在当前会话认领成功（或本来就是本人认领）时返回 */
  client_id?: string;
  scope?: string;
}

/**
 * GET /api/auth/device?user_code=…：已登录时把该码认领到当前用户（deviceCode.userId），返回 client_id / scope；
 * 错误：400 { error: "invalid_request" | "expired_token" }。注意插件限流：/device 每 IP 30 分钟内最多 5 次。
 */
export function claimDeviceCode(userCode: string): Promise<Result<DeviceClaim>> {
  return wrap(authClient.$fetch("/device", { method: "GET", query: { user_code: userCode } }));
}

/** POST /api/auth/device/approve { userCode }；错误：401 / 400（无效、过期、已处理、未认领）/ 403（他人认领） */
export function approveDevice(userCode: string): Promise<Result<{ status?: string }>> {
  return wrap(authClient.$fetch("/device/approve", { method: "POST", body: { userCode } }));
}

/** POST /api/auth/device/deny { userCode } */
export function denyDevice(userCode: string): Promise<Result<{ status?: string }>> {
  return wrap(authClient.$fetch("/device/deny", { method: "POST", body: { userCode } }));
}

/**
 * POST /api/auth/oauth2/consent { accept, oauth_query }（oauth_query 由 fetch 插件从页面 URL 自动补上）。
 * 返回 { redirect: true, url }（拒绝 → url 带 error=access_denied）。
 */
export function submitConsent(accept: boolean): Promise<Result<unknown>> {
  return wrap(authClient.$fetch("/oauth2/consent", { method: "POST", body: { accept } }));
}

/**
 * GET /api/auth/verify-email?token=…（不带 callbackURL → 返回 JSON 而非 302）。
 * 成功 { status: true }（autoSignInAfterVerification 会顺手种 session cookie）；
 * 失败 401 { code: "TOKEN_EXPIRED" | "INVALID_TOKEN" | "USER_NOT_FOUND" | "INVALID_USER" }。
 */
export function verifyEmailToken(token: string): Promise<Result<{ status: boolean }>> {
  return wrap(authClient.$fetch("/verify-email", { method: "GET", query: { token } }));
}

/** POST /api/auth/send-verification-email { email }（恒 200；服务端自行拼 ${APP_ORIGIN}/verify-email?token= 链接） */
export function resendVerification(email: string): Promise<Result<{ status: boolean }>> {
  return wrap(
    authClient.$fetch("/send-verification-email", {
      method: "POST",
      body: { email, callbackURL: "/account" },
    }),
  );
}

/** POST /api/auth/two-factor/verify-totp { code, trustDevice }：登录返回 twoFactorRedirect 后的第二步 */
export function verifyTotp(code: string): Promise<Result<unknown>> {
  return wrap(
    authClient.$fetch("/two-factor/verify-totp", { method: "POST", body: { code, trustDevice: false } }),
  );
}
