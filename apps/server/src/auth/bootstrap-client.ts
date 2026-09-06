// =============================================================================
// 唯一的 OAuth client `bianfa-desktop`（规格 04 §1.4）：public client（token_endpoint_auth_method=none，PKCE 强制）、
// application_type=native、redirect http://127.0.0.1/cb（IP 字面量：loopback 端口弹性只对 IP 生效，写 localhost 会静默失效）、
// scopes openid profile email offline_access、grant authorization_code + refresh_token + device_code、skip_consent。
// -----------------------------------------------------------------------------
// oauth-provider 的 admin create-client 端点不接受自定义 client_id（总是随机生成），所以直接 upsert 表行，
// 列形状与插件 oauthToSchema() 一致。幂等：按 clientId ON CONFLICT DO UPDATE（可重复跑，也可用来修正配置漂移）。
// =============================================================================

import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { uuidv7 } from "../db/ids.js";
import { oauthClient } from "../db/schema/index.js";
import { DESKTOP_CLIENT_ID } from "./oauth-tokens.js";

export const DESKTOP_CLIENT_NAME = "bianfa desktop";
export const DESKTOP_REDIRECT_URIS = ["http://127.0.0.1/cb"];
export const DESKTOP_SCOPES = ["openid", "profile", "email", "offline_access"];
export const DESKTOP_GRANT_TYPES = ["authorization_code", "refresh_token", DEVICE_CODE_GRANT_TYPE];

export interface BootstrapResult {
  created: boolean;
  clientId: string;
}

export async function bootstrapDesktopClient(db: Db): Promise<BootstrapResult> {
  const existing = await db
    .select({ id: oauthClient.id })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, DESKTOP_CLIENT_ID))
    .limit(1);
  const now = new Date();
  const values = {
    clientId: DESKTOP_CLIENT_ID,
    clientSecret: null,
    disabled: false,
    skipConsent: true,
    enableEndSession: false,
    subjectType: "public",
    scopes: DESKTOP_SCOPES,
    clientCredentialsScopes: [],
    userId: null,
    name: DESKTOP_CLIENT_NAME,
    redirectUris: DESKTOP_REDIRECT_URIS,
    tokenEndpointAuthMethod: "none",
    applicationType: "native",
    grantTypes: DESKTOP_GRANT_TYPES,
    responseTypes: ["code"],
    requirePKCE: true,
    dpopBoundAccessTokens: false,
    updatedAt: now,
  };
  if (existing[0]) {
    await db.update(oauthClient).set(values).where(eq(oauthClient.clientId, DESKTOP_CLIENT_ID));
    return { created: false, clientId: DESKTOP_CLIENT_ID };
  }
  await db.insert(oauthClient).values({ id: uuidv7(), createdAt: now, ...values });
  return { created: true, clientId: DESKTOP_CLIENT_ID };
}
