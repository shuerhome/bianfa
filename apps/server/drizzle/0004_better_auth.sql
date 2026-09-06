-- =============================================================================
-- 0004 · Better Auth 1.7.3 全量表（规格 04 §1 / §4.2）：core 补列、organization 插件补列、
--        @better-auth/oauth-provider、device-authorization、two-factor 的表，以及自建 oauth_refresh_device。
-- -----------------------------------------------------------------------------
-- * 列清单 = drizzle adapter createSchema（等价 `npx @better-auth/cli generate`）对 src/auth/better-auth.ts 配置的输出；
--   插件自带列物理名 camelCase 带引号（与 0001 一致），additionalFields 物理名 snake_case。
-- * 全部 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS：在 0001–0003 之上幂等，可重复执行。
-- * 新表显式 GRANT 给 bianfa_app / bianfa_worker（0000 的默认权限已覆盖，这里是保险）。
-- =============================================================================

-- ---------------------------------------------------------------- "user"：two-factor + additionalFields
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "twoFactorEnabled" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS banned boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS deletion_due_at timestamptz;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS ai_opt_in boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_deletion_due_idx ON "user" (deletion_due_at) WHERE deleted_at IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------- organization / member / invitation / team
ALTER TABLE organization ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
--> statement-breakpoint
ALTER TABLE organization ALTER COLUMN seats_paid SET DEFAULT 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS member_org_user_uq ON member ("organizationId", "userId");
--> statement-breakpoint
ALTER TABLE invitation ADD COLUMN IF NOT EXISTS token_hash text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS invitation_token_hash_uq ON invitation (token_hash);
--> statement-breakpoint
-- 同 org + email 只允许一条 pending（规格 04 §4.2）；重复邀请 = UPDATE 换 token
CREATE UNIQUE INDEX IF NOT EXISTS invitation_pending_email_uq ON invitation ("organizationId", lower(email)) WHERE status = 'pending';
--> statement-breakpoint
ALTER TABLE team ADD COLUMN IF NOT EXISTS color text;
--> statement-breakpoint

-- ---------------------------------------------------------------- @better-auth/oauth-provider 1.7.3
CREATE TABLE IF NOT EXISTS "oauthClient" (
  "id" text PRIMARY KEY,
  "clientId" text NOT NULL UNIQUE,
  "clientSecret" text,
  "clientDiscoveryId" text,
  "disabled" boolean DEFAULT false,
  "skipConsent" boolean,
  "enableEndSession" boolean,
  "subjectType" text,
  "scopes" text[],
  "clientCredentialsScopes" text[] DEFAULT '{}',
  "userId" text REFERENCES "user"(id) ON DELETE CASCADE,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" text[],
  "tos" text,
  "policy" text,
  "softwareId" text,
  "softwareVersion" text,
  "softwareStatement" text,
  "redirectUris" text[] NOT NULL,
  "postLogoutRedirectUris" text[],
  "backchannelLogoutUri" text,
  "backchannelLogoutSessionRequired" boolean,
  "tokenEndpointAuthMethod" text,
  "applicationType" text,
  "jwks" text,
  "jwksUri" text,
  "grantTypes" text[],
  "responseTypes" text[],
  "requirePKCE" boolean,
  "dpopBoundAccessTokens" boolean DEFAULT false,
  "referenceId" text,
  "metadata" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthClient_userId_idx" ON "oauthClient" ("userId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauthResource" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "accessTokenTtl" integer,
  "refreshTokenTtl" integer,
  "signingAlgorithm" text,
  "signingKeyId" text,
  "allowedScopes" text[],
  "customClaims" jsonb,
  "dpopBoundAccessTokensRequired" boolean DEFAULT false,
  "disabled" boolean DEFAULT false,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "policyVersion" integer DEFAULT 1,
  "metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauthClientResource" (
  "id" text PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
  "resourceId" text NOT NULL REFERENCES "oauthResource"("identifier") ON DELETE CASCADE,
  "metadata" jsonb,
  "createdAt" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauthClientResource_clientId_resourceId_uidx" ON "oauthClientResource" ("clientId", "resourceId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthClientResource_clientId_idx" ON "oauthClientResource" ("clientId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthClientResource_resourceId_idx" ON "oauthClientResource" ("resourceId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauthRefreshToken" (
  "id" text PRIMARY KEY,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
  "sessionId" text REFERENCES session(id) ON DELETE SET NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" text[],
  "requestedUserInfoClaims" text[],
  "expiresAt" timestamptz,
  "createdAt" timestamptz,
  "revoked" timestamptz,
  "rotatedAt" timestamptz,
  "rotationReplayResponse" text,
  "rotationReplayExpiresAt" timestamptz,
  "authTime" timestamptz,
  "confirmation" jsonb,
  "scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken" ("clientId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken" ("sessionId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_userId_idx" ON "oauthRefreshToken" ("userId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_authorizationCodeId_idx" ON "oauthRefreshToken" ("authorizationCodeId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
  "id" text PRIMARY KEY,
  "token" text UNIQUE,
  "clientId" text NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
  "sessionId" text REFERENCES session(id) ON DELETE SET NULL,
  "userId" text REFERENCES "user"(id) ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" text[],
  "requestedUserInfoClaims" text[],
  "refreshId" text REFERENCES "oauthRefreshToken"(id) ON DELETE CASCADE,
  "expiresAt" timestamptz,
  "createdAt" timestamptz,
  "revoked" timestamptz,
  "confirmation" jsonb,
  "scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthAccessToken_sessionId_idx" ON "oauthAccessToken" ("sessionId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthAccessToken_authorizationCodeId_idx" ON "oauthAccessToken" ("authorizationCodeId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthAccessToken_refreshId_idx" ON "oauthAccessToken" ("refreshId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauthConsent" (
  "id" text PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
  "userId" text REFERENCES "user"(id) ON DELETE CASCADE,
  "referenceId" text,
  "resources" text[],
  "requestedUserInfoClaims" text[],
  "scopes" text[] NOT NULL,
  "createdAt" timestamptz,
  "updatedAt" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauthConsent_userId_idx" ON "oauthConsent" ("userId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauthClientAssertion" (
  "id" text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL
);
--> statement-breakpoint

-- ---------------------------------------------------------------- device-authorization（oauthDeviceAuthorization grant 多出 resources / oauthClientId）
CREATE TABLE IF NOT EXISTS "deviceCode" (
  "id" text PRIMARY KEY,
  "deviceCode" text NOT NULL,
  "userCode" text NOT NULL,
  "userId" text,
  "expiresAt" timestamptz NOT NULL,
  "status" text NOT NULL,
  "lastPolledAt" timestamptz,
  "pollingInterval" integer,
  "clientId" text,
  "scope" text,
  "resources" text[],
  "oauthClientId" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deviceCode_deviceCode_uidx" ON "deviceCode" ("deviceCode");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deviceCode_userCode_uidx" ON "deviceCode" ("userCode");
--> statement-breakpoint

-- ---------------------------------------------------------------- two-factor
CREATE TABLE IF NOT EXISTS "twoFactor" (
  "id" text PRIMARY KEY,
  "secret" text NOT NULL,
  "backupCodes" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "verified" boolean DEFAULT true,
  "failedVerificationCount" integer DEFAULT 0,
  "lockedUntil" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "twoFactor_secret_idx" ON "twoFactor" ("secret");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "twoFactor_userId_idx" ON "twoFactor" ("userId");
--> statement-breakpoint

-- ---------------------------------------------------------------- 自建：refresh token ↔ device（规格 04 §2.2 第 4 步）
CREATE TABLE IF NOT EXISTS oauth_refresh_device (
  refresh_token_id text PRIMARY KEY REFERENCES "oauthRefreshToken"(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauth_refresh_device_device_idx ON oauth_refresh_device (device_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauth_refresh_device_user_idx ON oauth_refresh_device (user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS device_user_active_idx ON device (user_id) WHERE revoked_at IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------- 授权（幂等）
GRANT SELECT, INSERT, UPDATE, DELETE ON "oauthClient", "oauthResource", "oauthClientResource", "oauthRefreshToken", "oauthAccessToken", "oauthConsent", "oauthClientAssertion", "deviceCode", "twoFactor", oauth_refresh_device TO bianfa_app, bianfa_worker;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bianfa_app, bianfa_worker;
