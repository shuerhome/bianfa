// /web-config.json 的内容（匿名）：Web 面启动时拉取的少量运行期配置——哪些社交登录 provider 已配置、APP_ORIGIN、
// 桌面端下载链接（DESKTOP_DOWNLOAD_URL，可选，https）。全部由环境变量推导，不含任何秘密。路由本身挂在 web-static.ts。
import { appleConfigured } from "../auth/apple-secret.js";

export type SocialProvider = "google" | "apple";

export interface WebConfig {
  providers: SocialProvider[];
  app_origin: string;
  download_url: string | null;
}

export const WEB_CONFIG_PATH = "/web-config.json";

/** 与 apps/server/src/auth/better-auth.ts 的 socialProviders 判定完全一致 */
export function computeWebConfig(raw: NodeJS.ProcessEnv, appOrigins: readonly string[]): WebConfig {
  const providers: SocialProvider[] = [];
  if (raw.GOOGLE_CLIENT_ID && raw.GOOGLE_CLIENT_SECRET) providers.push("google");
  if (
    appleConfigured({
      clientId: raw.APPLE_CLIENT_ID ?? "",
      clientSecret: raw.APPLE_CLIENT_SECRET,
      teamId: raw.APPLE_TEAM_ID,
      keyId: raw.APPLE_KEY_ID,
      p8Key: raw.APPLE_P8_KEY,
    })
  )
    providers.push("apple");
  const download = raw.DESKTOP_DOWNLOAD_URL?.trim();
  return {
    providers,
    app_origin: appOrigins[0] ?? "",
    download_url: download && /^https:\/\//.test(download) ? download : null,
  };
}
