// /oauth2/authorize 未登录时把原始授权参数签名后带到 /login?…（sig / exp / ba_iat / ba_param）。
// 客户端插件会把它原样作为 oauth_query 送回；这里只做「是否处于桌面端登录流程」的判断与展示用字段提取。
export interface OAuthContext {
  clientId: string;
  scopes: string[];
  redirectUri: string | null;
  /** 原始授权参数（去掉签名字段），用于邮箱验证后重新发起 authorize */
  authorizeQuery: string;
}

const SIGNED_KEYS = new Set(["sig", "exp", "ba_iat", "ba_param", "ba_pl"]);

export function readOAuthContext(search: string): OAuthContext | null {
  const params = new URLSearchParams(search);
  if (!params.has("sig") || !params.get("client_id")) return null;
  const authorize = new URLSearchParams();
  for (const [k, v] of params) if (!SIGNED_KEYS.has(k)) authorize.append(k, v);
  return {
    clientId: params.get("client_id") ?? "",
    scopes: (params.get("scope") ?? "")
      .split(" ")
      .map((s) => s.trim())
      .filter(Boolean),
    redirectUri: params.get("redirect_uri"),
    authorizeQuery: authorize.toString(),
  };
}

const STASH_KEY = "bianfa.pendingAuthorize";
const STASH_TTL_MS = 15 * 60 * 1000;

/** 注册流程会经过邮件验证（新标签页），把 authorize 参数暂存 15 分钟，验证成功页可以「继续登录桌面端」 */
export function stashAuthorize(ctx: OAuthContext): void {
  try {
    localStorage.setItem(STASH_KEY, JSON.stringify({ q: ctx.authorizeQuery, at: Date.now() }));
  } catch {
    /* 私密模式等：忽略 */
  }
}

export function takeStashedAuthorize(): string | null {
  try {
    const raw = localStorage.getItem(STASH_KEY);
    if (!raw) return null;
    localStorage.removeItem(STASH_KEY);
    const parsed = JSON.parse(raw) as { q?: unknown; at?: unknown };
    if (typeof parsed.q !== "string" || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > STASH_TTL_MS) return null;
    return parsed.q;
  } catch {
    return null;
  }
}

export function authorizeUrl(query: string): string {
  return `/api/auth/oauth2/authorize?${query}`;
}

/** 服务端 handleRedirect 对 fetch 请求返回 { redirect: true, url }；consent 的 OpenAPI 写作 redirect_uri，两者都认 */
export function redirectTarget(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { redirect?: unknown; url?: unknown; redirect_uri?: unknown };
  if (typeof d.url === "string" && d.redirect === true) return d.url;
  if (typeof d.redirect_uri === "string") return d.redirect_uri;
  return null;
}
