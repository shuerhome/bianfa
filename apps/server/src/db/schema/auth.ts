// =============================================================================
// Better Auth 1.7.3 权威表（core + organization(teams) + oauth-provider + device-authorization + two-factor）
// -----------------------------------------------------------------------------
// 依据：第 1 章 C9；规格 02 §1.1；规格 04 §4.2。列清单以 @better-auth/drizzle-adapter 的 createSchema
// （= `npx @better-auth/cli generate`）对本项目 auth 配置的输出为准（apps/server/src/auth/better-auth.ts），
// 已逐列核对：
//   * 表名 / 插件自带列的物理名保持 CLI 输出（camelCase 带引号："emailVerified"、"oauthRefreshToken"."refreshId"）。
//   * additionalFields（C9 业务列）物理名用 snake_case（seats_paid / session_epoch / deleted_at …），drizzle 属性名
//     必须等于 additionalFields 的 key —— drizzle adapter 按属性名（不是物理列名）定位列。
//   * 时间列统一 timestamptz（与 0001 一致；adapter 不关心 tz）。
//   * Better Auth 运行时会校验本 schema：期望列缺失 / 多出「非空且无默认」的列都会让请求失败，所以自加列一律可空或带默认。
// 这些表不加 RLS（规格 02 §1.8）。drizzleAdapter 只接收 authSchema（本文件末尾的对象），不是整个 schema/index。
// =============================================================================
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("emailVerified").notNull().default(false),
    image: text("image"),
    createdAt: ts("createdAt").notNull().defaultNow(),
    updatedAt: ts("updatedAt").notNull().defaultNow(),
    // two-factor 插件
    twoFactorEnabled: boolean("twoFactorEnabled").default(false),
    // ---- additionalFields（规格 04 §1.3 / §7.9）----
    banned: boolean("banned").notNull().default(false),
    // 冻结（0009）：总管理员冻结账号。与 banned 分开——banned 已被 account-purge 当作
    // 「已匿名化的墓碑账号」标记在用，共用一列会让解冻误复活被清除的账号。
    frozenAt: ts("frozen_at"),
    frozenBy: text("frozen_by"),
    frozenReason: text("frozen_reason"),
    deletedAt: ts("deleted_at"),
    deletionDueAt: ts("deletion_due_at"),
    aiOptIn: boolean("ai_opt_in").notNull().default(false),
    // 安全码（0007）：只存哈希；明文只在 databaseHooks.user.create.before 里出现一次，从不落库。
    // securityCode 列只是为了让 adapter 的 schema diff 通过（additionalFields 里 input-only 的字段也要求有列）：
    // hook 把它置为 undefined → adapter 跳过；CHECK (IS NULL) 保证任何路径都写不进明文。
    securityCode: text("security_code"),
    securityCodeHash: text("security_code_hash"),
    securityCodeSetAt: ts("security_code_set_at"),
  },
  (t) => [check("user_security_code_never_stored", sql`${t.securityCode} IS NULL`)],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expiresAt").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("createdAt").notNull().defaultNow(),
    updatedAt: ts("updatedAt").notNull().defaultNow(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // organization 插件（teams 启用）
    activeOrganizationId: text("activeOrganizationId"),
    activeTeamId: text("activeTeamId"),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: ts("accessTokenExpiresAt"),
    refreshTokenExpiresAt: ts("refreshTokenExpiresAt"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("createdAt").notNull().defaultNow(),
    updatedAt: ts("updatedAt").notNull().defaultNow(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expiresAt").notNull(),
    createdAt: ts("createdAt").notNull().defaultNow(),
    updatedAt: ts("updatedAt").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const organization = pgTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: ts("createdAt").notNull().defaultNow(),
    metadata: text("metadata"),
    // ---- additionalFields（第 1 章 C9；规格 04 §4.2）----
    plan: text("plan").notNull().default("free"),
    seatsPaid: integer("seats_paid").notNull().default(1),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    allowPublicLinks: boolean("allow_public_links").notNull().default(false),
    enterpriseMode: boolean("enterprise_mode").notNull().default(false),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("organization_slug_idx").on(t.slug)],
);

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: ts("createdAt").notNull().defaultNow(),
    // ---- additionalFields（规格 04 §4.2：status / seat_billable / session_epoch / removed_at）----
    status: text("status").notNull().default("active"),
    seatBillable: boolean("seat_billable").notNull().default(true),
    sessionEpoch: integer("session_epoch").notNull().default(0),
    removedAt: ts("removed_at"),
  },
  (t) => [
    index("member_organizationId_idx").on(t.organizationId),
    index("member_userId_idx").on(t.userId),
    uniqueIndex("member_org_user_uq").on(t.organizationId, t.userId),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    teamId: text("teamId"),
    status: text("status").notNull().default("pending"),
    expiresAt: ts("expiresAt").notNull(),
    createdAt: ts("createdAt").notNull().defaultNow(),
    inviterId: text("inviterId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // ---- additionalFields：token 只存 sha256（base64url）；原始 token 只出现在邮件链接里 ----
    tokenHash: text("token_hash"),
  },
  (t) => [
    index("invitation_organizationId_idx").on(t.organizationId),
    index("invitation_email_idx").on(t.email),
    uniqueIndex("invitation_token_hash_uq").on(t.tokenHash),
  ],
);

export const team = pgTable(
  "team",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    memberCount: integer("memberCount").notNull().default(0),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdAt: ts("createdAt").notNull().defaultNow(),
    updatedAt: ts("updatedAt"),
    // additionalFields
    color: text("color"),
  },
  (t) => [index("team_organizationId_idx").on(t.organizationId)],
);

export const teamMember = pgTable(
  "teamMember",
  {
    id: text("id").primaryKey(),
    teamId: text("teamId")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    membershipKey: text("membershipKey").unique(),
    createdAt: ts("createdAt"),
  },
  (t) => [index("teamMember_teamId_idx").on(t.teamId), index("teamMember_userId_idx").on(t.userId)],
);

// ---------------------------------------------------------------- @better-auth/oauth-provider 1.7.3
export const oauthClient = pgTable(
  "oauthClient",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId").notNull().unique(),
    clientSecret: text("clientSecret"),
    clientDiscoveryId: text("clientDiscoveryId"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skipConsent"),
    enableEndSession: boolean("enableEndSession"),
    subjectType: text("subjectType"),
    scopes: text("scopes").array(),
    clientCredentialsScopes: text("clientCredentialsScopes").array().default([]),
    userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
    createdAt: ts("createdAt"),
    updatedAt: ts("updatedAt"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("softwareId"),
    softwareVersion: text("softwareVersion"),
    softwareStatement: text("softwareStatement"),
    redirectUris: text("redirectUris").array().notNull(),
    postLogoutRedirectUris: text("postLogoutRedirectUris").array(),
    backchannelLogoutUri: text("backchannelLogoutUri"),
    backchannelLogoutSessionRequired: boolean("backchannelLogoutSessionRequired"),
    tokenEndpointAuthMethod: text("tokenEndpointAuthMethod"),
    applicationType: text("applicationType"),
    jwks: text("jwks"),
    jwksUri: text("jwksUri"),
    grantTypes: text("grantTypes").array(),
    responseTypes: text("responseTypes").array(),
    requirePKCE: boolean("requirePKCE"),
    dpopBoundAccessTokens: boolean("dpopBoundAccessTokens").default(false),
    referenceId: text("referenceId"),
    metadata: jsonb("metadata"),
  },
  (t) => [index("oauthClient_userId_idx").on(t.userId)],
);

export const oauthResource = pgTable("oauthResource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("accessTokenTtl"),
  refreshTokenTtl: integer("refreshTokenTtl"),
  signingAlgorithm: text("signingAlgorithm"),
  signingKeyId: text("signingKeyId"),
  allowedScopes: text("allowedScopes").array(),
  customClaims: jsonb("customClaims"),
  dpopBoundAccessTokensRequired: boolean("dpopBoundAccessTokensRequired").default(false),
  disabled: boolean("disabled").default(false),
  createdAt: ts("createdAt"),
  updatedAt: ts("updatedAt"),
  policyVersion: integer("policyVersion").default(1),
  metadata: jsonb("metadata"),
});

export const oauthClientResource = pgTable(
  "oauthClientResource",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resourceId")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: ts("createdAt"),
  },
  (t) => [
    uniqueIndex("oauthClientResource_clientId_resourceId_uidx").on(t.clientId, t.resourceId),
    index("oauthClientResource_clientId_idx").on(t.clientId),
    index("oauthClientResource_resourceId_idx").on(t.resourceId),
  ],
);

export const oauthRefreshToken = pgTable(
  "oauthRefreshToken",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("sessionId").references(() => session.id, { onDelete: "set null" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("referenceId"),
    authorizationCodeId: text("authorizationCodeId"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requestedUserInfoClaims").array(),
    expiresAt: ts("expiresAt"),
    createdAt: ts("createdAt"),
    revoked: ts("revoked"),
    rotatedAt: ts("rotatedAt"),
    rotationReplayResponse: text("rotationReplayResponse"),
    rotationReplayExpiresAt: ts("rotationReplayExpiresAt"),
    authTime: ts("authTime"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauthRefreshToken_clientId_idx").on(t.clientId),
    index("oauthRefreshToken_sessionId_idx").on(t.sessionId),
    index("oauthRefreshToken_userId_idx").on(t.userId),
    index("oauthRefreshToken_authorizationCodeId_idx").on(t.authorizationCodeId),
  ],
);

export const oauthAccessToken = pgTable(
  "oauthAccessToken",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("sessionId").references(() => session.id, { onDelete: "set null" }),
    userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("referenceId"),
    authorizationCodeId: text("authorizationCodeId"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requestedUserInfoClaims").array(),
    refreshId: text("refreshId").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    expiresAt: ts("expiresAt"),
    createdAt: ts("createdAt"),
    revoked: ts("revoked"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauthAccessToken_clientId_idx").on(t.clientId),
    index("oauthAccessToken_sessionId_idx").on(t.sessionId),
    index("oauthAccessToken_userId_idx").on(t.userId),
    index("oauthAccessToken_authorizationCodeId_idx").on(t.authorizationCodeId),
    index("oauthAccessToken_refreshId_idx").on(t.refreshId),
  ],
);

export const oauthConsent = pgTable(
  "oauthConsent",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("referenceId"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requestedUserInfoClaims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: ts("createdAt"),
    updatedAt: ts("updatedAt"),
  },
  (t) => [index("oauthConsent_clientId_idx").on(t.clientId), index("oauthConsent_userId_idx").on(t.userId)],
);

export const oauthClientAssertion = pgTable("oauthClientAssertion", {
  id: text("id").primaryKey(),
  expiresAt: ts("expiresAt").notNull(),
});

// ---------------------------------------------------------------- device-authorization（oauthDeviceAuthorization grant）
export const deviceCode = pgTable(
  "deviceCode",
  {
    id: text("id").primaryKey(),
    deviceCode: text("deviceCode").notNull(),
    userCode: text("userCode").notNull(),
    userId: text("userId"),
    expiresAt: ts("expiresAt").notNull(),
    status: text("status").notNull(),
    lastPolledAt: ts("lastPolledAt"),
    pollingInterval: integer("pollingInterval"),
    clientId: text("clientId"),
    scope: text("scope"),
    resources: text("resources").array(),
    oauthClientId: text("oauthClientId"),
  },
  (t) => [
    uniqueIndex("deviceCode_deviceCode_uidx").on(t.deviceCode),
    uniqueIndex("deviceCode_userCode_uidx").on(t.userCode),
  ],
);

// ---------------------------------------------------------------- two-factor
export const twoFactor = pgTable(
  "twoFactor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backupCodes").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failedVerificationCount").default(0),
    lockedUntil: ts("lockedUntil"),
  },
  (t) => [index("twoFactor_secret_idx").on(t.secret), index("twoFactor_userId_idx").on(t.userId)],
);

// ---------------------------------------------------------------- 自建：refresh token ↔ device 绑定（规格 04 §2.2 第 4 步）
// oauth-provider 的 oauthRefreshToken 不支持 additionalFields，所以用旁表：每条 refresh token 行对应一台设备；
// 轮转时新行沿用旧行的 device_id；oauthRefreshToken 行被插件删除时级联删除。
export const oauthRefreshDevice = pgTable(
  "oauth_refresh_device",
  {
    refreshTokenId: text("refresh_token_id")
      .primaryKey()
      .references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("oauth_refresh_device_device_idx").on(t.deviceId),
    index("oauth_refresh_device_user_idx").on(t.userId),
  ],
);

/** 只含 Better Auth 认识的模型（key = 模型名）。传给 drizzleAdapter 的 schema 必须是这个，不能是 schema/index 全集 */
export const authSchema = {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  team,
  teamMember,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
  deviceCode,
  twoFactor,
} as const;
