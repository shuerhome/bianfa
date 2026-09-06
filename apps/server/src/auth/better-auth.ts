// =============================================================================
// Better Auth 1.7.3 实例（规格 04 §1.3 / §1.4 / §1.5；规格 08 X8/X12）。每个选项名都对照 node_modules 里的 .d.mts 核对过。
// -----------------------------------------------------------------------------
// * drizzle adapter：provider 'pg'，schema = authSchema（只含 Better Auth 模型）；adapter 会在启动时校验 schema。
// * id 一律 uuidv7()（advanced.database.generateId）。
// * 密码 argon2id（@node-rs/argon2）；加载失败时回退 Better Auth 默认 scrypt（createAuth 里 probe）。
// * cookie：cookiePrefix 'bianfa'；https baseURL 时 Better Auth 自己加 __Secure- 前缀（它总是把 __Secure- 拼在
//   cookiePrefix 前面，所以不能把 __Host- 写进 prefix，否则得到 __Secure-__Host-bianfa.*）；Path=/、HttpOnly、SameSite=Lax、无 Domain。
// * secondaryStorage（Redis）存在时 session.storeSessionInDatabase 必须 true（oauth-provider 硬要求；Redis 是 ephemeral）。
// * oauth-provider：不透明 access token（disableJwtPlugin: true → 不装 jwt 插件，撤销即时生效；public client 无 id_token）、
//   storeTokens.hash = sha256 base64url（verify-bearer / desktop-plugin 用同一函数直查表）。
// * 设备码走 oauthDeviceAuthorization（RFC 8628 grant，最终在 /oauth2/token 换 token，与 PKCE 路径同一组 token）。
// =============================================================================
import { DEVICE_CODE_GRANT_TYPE, oauthDeviceAuthorization, oauthProvider } from "@better-auth/oauth-provider";
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { twoFactor } from "better-auth/plugins/two-factor";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import { type Db, withUserTx } from "../db/client.js";
import { uuidv7 } from "../db/ids.js";
import { authSchema } from "../db/schema/auth.js";
import type { MailProvider } from "../mail/index.js";
import { randomToken, sha256Base64url } from "../security/tokens.js";
import { appleConfigured, createAppleSecretProvider } from "./apple-secret.js";
import { auditStandalone } from "./db-helpers.js";
import { bianfaDesktopPlugin } from "./desktop-plugin.js";
import type { AuthEnv } from "./env.js";
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_TTL_SECONDS,
  DESKTOP_CLIENT_ID,
  REFRESH_REUSE_INTERVAL_SECONDS,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_SECONDS,
} from "./oauth-tokens.js";
import type { AuthSecondaryStorage } from "./redis.js";

export interface BuildAuthDeps {
  env: AuthEnv;
  db: Db;
  mail: MailProvider;
  log: Logger;
  secondaryStorage?: AuthSecondaryStorage | undefined;
  /** argon2 可用时传入；否则用 Better Auth 默认 scrypt */
  password?:
    | {
        hash: (password: string) => Promise<string>;
        verify: (data: { hash: string; password: string }) => Promise<boolean>;
      }
    | undefined;
}

export const PERSONAL_WORKSPACE_NAME = "我的便笺";
export const SESSION_EXPIRES_IN = 7 * 24 * 3600;
export const SESSION_UPDATE_AGE = 24 * 3600;
export const EMAIL_VERIFICATION_TTL = 15 * 60;
export const RESET_PASSWORD_TTL = 30 * 60;
export const INVITATION_EXPIRES_IN = 48 * 3600;

/** 幂等建个人 workspace（databaseHooks.user.create.after；B2 的 /v1/claim 也会兜底） */
export async function ensurePersonalWorkspace(db: Db, userId: string): Promise<void> {
  await withUserTx(
    userId,
    (tx) =>
      tx.execute(sql`
        INSERT INTO workspaces (id, kind, owner_user_id, name)
        VALUES (${uuidv7()}::uuid, 'personal', ${userId}, ${PERSONAL_WORKSPACE_NAME})
        ON CONFLICT (owner_user_id) WHERE kind = 'personal' DO NOTHING`),
    db,
  );
}

/**
 * oauth-provider 的端点类型在 exactOptionalPropertyTypes 下与 BetterAuthPlugin 的 OpenAPI 元数据类型不兼容
 * （`items?: undefined` vs `items?: {type}`），纯类型层面的差异；运行时对象原样使用。
 */
function asPlugin(plugin: unknown): BetterAuthPlugin {
  return plugin as BetterAuthPlugin;
}

function pinoLevelFor(level: string): "info" | "warn" | "error" | "debug" {
  return level === "warn" || level === "error" || level === "debug" ? level : "info";
}

export function buildAuth(deps: BuildAuthDeps) {
  const { env, db, mail, log } = deps;
  const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  const appleCfg = {
    clientId: env.APPLE_CLIENT_ID ?? "",
    clientSecret: env.APPLE_CLIENT_SECRET,
    teamId: env.APPLE_TEAM_ID,
    keyId: env.APPLE_KEY_ID,
    p8Key: env.APPLE_P8_KEY,
  };
  if (appleConfigured(appleCfg)) {
    const secret = createAppleSecretProvider(appleCfg);
    const audience = [appleCfg.clientId, ...(env.APPLE_APP_BUNDLE_ID ? [env.APPLE_APP_BUNDLE_ID] : [])];
    socialProviders.apple = async () => ({
      clientId: appleCfg.clientId,
      clientSecret: await secret(),
      ...(env.APPLE_APP_BUNDLE_ID ? { appBundleIdentifier: env.APPLE_APP_BUNDLE_ID } : {}),
      audience,
    });
  }

  const rateLimitEnabled = env.isProduction || env.AUTH_RATE_LIMIT === "1";
  const trustedProxies = env.AUTH_TRUSTED_PROXIES?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return betterAuth({
    appName: "bianfa",
    baseURL: env.baseURL,
    basePath: "/api/auth",
    secret: env.secret,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    trustedOrigins: [...env.appOrigins],
    telemetry: { enabled: false },
    logger: {
      level: env.LOG_LEVEL === "debug" || env.LOG_LEVEL === "trace" ? "debug" : "warn",
      log: (level, message, ...args) => {
        log[pinoLevelFor(level)]({ args: args.length ? args : undefined }, `better-auth: ${message}`);
      },
    },
    advanced: {
      trustedProxyHeaders: true,
      useSecureCookies: env.secureCookies,
      cookiePrefix: "bianfa",
      database: { generateId: () => uuidv7() },
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"],
        ...(trustedProxies?.length ? { trustedProxies } : {}),
      },
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN,
      updateAge: SESSION_UPDATE_AGE,
      storeSessionInDatabase: true,
    },
    ...(deps.secondaryStorage ? { secondaryStorage: deps.secondaryStorage } : {}),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: RESET_PASSWORD_TTL,
      ...(deps.password ? { password: deps.password } : {}),
      sendResetPassword: async ({ user, url, token }) => {
        await mail.send(user.email, "reset_password", {
          name: user.name,
          url: `${env.appOrigin}/reset-password?token=${encodeURIComponent(token)}`,
          api_url: url,
          token,
        });
      },
      onPasswordReset: async ({ user }, request) => {
        await auditStandalone(db, {
          action: "auth.password_changed",
          actorId: user.id,
          actorIp: request?.headers.get("cf-connecting-ip") ?? null,
          targetType: "user",
          targetId: user.id,
          metadata: { via: "reset" },
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: EMAIL_VERIFICATION_TTL,
      sendVerificationEmail: async ({ user, url, token }) => {
        await mail.send(user.email, "verify_email", {
          name: user.name,
          url: `${env.appOrigin}/verify-email?token=${encodeURIComponent(token)}`,
          api_url: url,
          token,
        });
      },
    },
    socialProviders,
    user: {
      additionalFields: {
        banned: { type: "boolean", required: false, defaultValue: false, input: false },
        deletedAt: { type: "date", required: false, input: false },
        deletionDueAt: { type: "date", required: false, input: false },
        aiOptIn: { type: "boolean", required: false, defaultValue: false },
      },
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url, token }) => {
          await mail.send(user.email, "email_changed", {
            name: user.name,
            new_email: newEmail,
            url: `${env.appOrigin}/change-email?token=${encodeURIComponent(token)}`,
            api_url: url,
            token,
          });
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await ensurePersonalWorkspace(db, user.id);
          },
        },
      },
    },
    rateLimit: {
      enabled: rateLimitEnabled,
      window: 60,
      max: 100,
      storage: deps.secondaryStorage ? "secondary-storage" : "memory",
      customRules: {
        "/sign-up/email": { window: 3600, max: 3 },
        "/sign-in/email": { window: 900, max: 5 },
        "/request-password-reset": { window: 3600, max: 3 },
        "/forget-password": { window: 3600, max: 3 },
      },
    },
    // 平台级删除走 /v1/me/delete（软删 + 30 天）；org 管理写操作统一走 /v1（席位闸门 / 审计），插件端点只保留 Web 面需要的
    disabledPaths: [
      "/delete-user",
      "/delete-user/callback",
      "/oauth2/register",
      "/organization/create",
      "/organization/update",
      "/organization/delete",
      "/organization/invite-member",
      "/organization/cancel-invitation",
      "/organization/remove-member",
      "/organization/update-member-role",
      "/organization/leave",
      "/organization/create-team",
      "/organization/update-team",
      "/organization/remove-team",
      "/organization/add-team-member",
      "/organization/remove-team-member",
    ],
    plugins: [
      organization({
        creatorRole: "owner",
        organizationLimit: 10,
        membershipLimit: 100,
        invitationExpiresIn: INVITATION_EXPIRES_IN,
        invitationLimit: 100,
        requireEmailVerificationOnInvitation: true,
        dynamicAccessControl: { enabled: false },
        teams: { enabled: true, maximumTeams: 20, defaultTeam: { enabled: false } },
        sendInvitationEmail: async (data) => {
          await mail.send(data.email, "invite", {
            org_name: data.organization.name,
            inviter_name: data.inviter.user.name,
            role: data.role,
            url: `${env.appOrigin}/invite/id/${data.id}`,
          });
        },
        schema: {
          organization: {
            additionalFields: {
              plan: { type: "string", required: false, defaultValue: "free", input: false },
              seatsPaid: { type: "number", required: false, defaultValue: 1, input: false },
              stripeCustomerId: { type: "string", required: false, input: false },
              stripeSubscriptionId: { type: "string", required: false, input: false },
              allowPublicLinks: { type: "boolean", required: false, defaultValue: false, input: false },
              enterpriseMode: { type: "boolean", required: false, defaultValue: false, input: false },
              deletedAt: { type: "date", required: false, input: false },
            },
          },
          member: {
            additionalFields: {
              status: { type: "string", required: false, defaultValue: "active", input: false },
              seatBillable: { type: "boolean", required: false, defaultValue: true, input: false },
              sessionEpoch: { type: "number", required: false, defaultValue: 0, input: false },
              removedAt: { type: "date", required: false, input: false },
            },
          },
          invitation: {
            additionalFields: {
              tokenHash: { type: "string", required: false, input: false, returned: false },
            },
          },
          team: {
            additionalFields: {
              color: { type: "string", required: false },
            },
          },
        },
      }),
      asPlugin(
        oauthProvider({
          loginPage: `${env.appOrigin}/login`,
          consentPage: `${env.appOrigin}/consent`,
          disableJwtPlugin: true,
          allowDynamicClientRegistration: false,
          allowUnauthenticatedClientRegistration: false,
          enforcePerClientResources: false,
          scopes: ["openid", "profile", "email", "offline_access"],
          grantTypes: ["authorization_code", "refresh_token", DEVICE_CODE_GRANT_TYPE],
          accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
          refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
          refreshTokenReuseInterval: REFRESH_REUSE_INTERVAL_SECONDS,
          codeExpiresIn: 600,
          storeTokens: { hash: async (token) => sha256Base64url(token) },
          generateOpaqueAccessToken: () => randomToken(32),
          generateRefreshToken: () => randomToken(32),
          prefix: { opaqueAccessToken: ACCESS_TOKEN_PREFIX, refreshToken: REFRESH_TOKEN_PREFIX },
          rateLimit: { token: { window: 60, max: 60 } },
        }),
      ),
      asPlugin(
        oauthDeviceAuthorization({
          expiresIn: "30m",
          interval: "5s",
          userCodeLength: 8,
          deviceCodeLength: 40,
          verificationUri: `${env.appOrigin}/device`,
          validateClient: (clientId) => clientId === DESKTOP_CLIENT_ID,
          onDeviceAuthRequest: async (clientId, scope) => {
            await auditStandalone(db, {
              action: "auth.device_requested",
              actorType: "system",
              targetType: "oauth_client",
              targetId: clientId,
              metadata: { scope: scope ?? null },
            });
          },
        }),
      ),
      twoFactor({
        issuer: "bianfa",
        backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "encrypted" },
      }),
      bianfaDesktopPlugin({ db, env, mail, log }),
    ],
  });
}

export type BianfaAuth = ReturnType<typeof buildAuth>;
