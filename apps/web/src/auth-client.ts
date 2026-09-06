// Better Auth 1.7.3 浏览器客户端（同源：cookie 走 __Secure-bianfa.* / bianfa.*）。
// 插件与服务端 apps/server/src/auth/better-auth.ts 一一对应：
//   organizationClient → /organization/accept-invitation | reject-invitation（Web 面接受邀请）
//   twoFactorClient    → /two-factor/verify-totp（登录返回 twoFactorRedirect 时的第二步）
//   oauthProviderClient → fetch 插件：非 GET 请求自动附带 oauth_query（页面 URL 里由 /oauth2/authorize 带来的签名参数），
//                         登录 / 同意后服务端据此继续授权流程并返回 { redirect: true, url }
//   oauthDeviceAuthorizationClient → /device（GET 认领）、/device/approve、/device/deny
import { oauthDeviceAuthorizationClient, oauthProviderClient } from "@better-auth/oauth-provider/client";
import { organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:3000",
  basePath: "/api/auth",
  plugins: [organizationClient(), twoFactorClient(), oauthProviderClient(), oauthDeviceAuthorizationClient()],
});

export type AuthClient = typeof authClient;
