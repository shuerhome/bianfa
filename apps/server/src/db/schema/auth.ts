// =============================================================================
// Better Auth 1.7 权威表（core + organization 插件）—— 占位手写版
// -----------------------------------------------------------------------------
// 依据：第 1 章 C9（组织/用户表以 Better Auth organization 插件的表为权威）；规格 02 §1.1。
// 表名单数（"user" / session / account / verification / organization / member / invitation / team / "teamMember"），
// 列名 camelCase 带引号（"createdAt"），id 一律 text —— 与 Better Auth 默认 schema 一致，restore-checks.sql 依赖 "user"。
// 字段清单按 @better-auth/core 1.7.3 dist/db/get-tables.mjs 与 plugins/organization/organization.mjs 抄录
// （teams 启用：session 多出 activeTeamId、invitation 多出 teamId），date 字段按 Better Auth 自己的 PG 映射用 timestamptz。
//
// ★ 这是鉴权阶段之前的占位：接入 Better Auth 时必须用 `npx @better-auth/cli generate` 生成一份并逐列核对
//   （additionalFields 的 fieldName 必须配成下面的 snake_case 列名，例如 seats_paid / session_epoch）。
//   若有出入以 CLI 输出为准，用 drizzle-kit generate 追加迁移，不要改历史迁移文件。
// 这些表不加 RLS（规格 02 §1.8）。
// =============================================================================
import { boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
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
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
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
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    metadata: text("metadata"),
    // ---- additionalFields（第 1 章 C9；docs/07 §6.1 的 organizations 表并入此处）----
    plan: text("plan").notNull().default("free"),
    seatsPaid: integer("seats_paid").notNull().default(0),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    allowPublicLinks: boolean("allow_public_links").notNull().default(false),
    enterpriseMode: boolean("enterprise_mode").notNull().default(false),
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
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    // ---- additionalFields（docs/07 §6.4 显式版本号踢会话；席位计费）----
    sessionEpoch: integer("session_epoch").notNull().default(0),
    seatBillable: boolean("seat_billable").notNull().default(true),
  },
  (t) => [index("member_organizationId_idx").on(t.organizationId), index("member_userId_idx").on(t.userId)],
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
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    inviterId: text("inviterId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("invitation_organizationId_idx").on(t.organizationId),
    index("invitation_email_idx").on(t.email),
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
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }),
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
    createdAt: timestamp("createdAt", { withTimezone: true }),
  },
  (t) => [index("teamMember_teamId_idx").on(t.teamId), index("teamMember_userId_idx").on(t.userId)],
);
