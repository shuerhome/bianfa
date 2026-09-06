CREATE TYPE "public"."grantee_kind" AS ENUM('user', 'link');--> statement-breakpoint
CREATE TYPE "public"."note_perm" AS ENUM('viewer', 'commenter', 'editor', 'manager');--> statement-breakpoint
CREATE TYPE "public"."workspace_kind" AS ENUM('personal', 'team');--> statement-breakpoint
CREATE TABLE "attachment_refs" (
	"note_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"last_referenced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_refs_note_id_attachment_id_pk" PRIMARY KEY("note_id","attachment_id")
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"content_hash" "bytea" NOT NULL,
	"byte_size" bigint NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"blurhash" text,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"encrypted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "attachments_hash_len_check" CHECK (octet_length("attachments"."content_hash") = 32),
	CONSTRAINT "attachments_byte_size_check" CHECK ("attachments"."byte_size" > 0 AND "attachments"."byte_size" <= 10485760),
	CONSTRAINT "attachments_mime_check" CHECK ("attachments"."mime" IN ('image/png','image/jpeg','image/gif','image/webp')),
	CONSTRAINT "attachments_status_check" CHECK ("attachments"."status" IN ('pending','committed'))
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"teamId" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"inviterId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"userId" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"session_epoch" integer DEFAULT 0 NOT NULL,
	"seat_billable" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"seats_paid" integer DEFAULT 0 NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"allow_public_links" boolean DEFAULT false NOT NULL,
	"enterprise_mode" boolean DEFAULT false NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	"activeOrganizationId" text,
	"activeTeamId" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"memberCount" integer DEFAULT 0 NOT NULL,
	"organizationId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "teamMember" (
	"id" text PRIMARY KEY NOT NULL,
	"teamId" text NOT NULL,
	"userId" text NOT NULL,
	"membershipKey" text,
	"createdAt" timestamp with time zone,
	CONSTRAINT "teamMember_membershipKey_unique" UNIQUE("membershipKey")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text NOT NULL,
	"last_ip" "inet",
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_platform_check" CHECK ("device"."platform" IN ('windows', 'macos', 'linux'))
);
--> statement-breakpoint
CREATE TABLE "checklist_items" (
	"note_id" uuid NOT NULL,
	"block_id" text NOT NULL,
	"text" text NOT NULL,
	"checked" boolean NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "checklist_items_note_id_block_id_pk" PRIMARY KEY("note_id","block_id")
);
--> statement-breakpoint
CREATE TABLE "note_snapshots" (
	"note_id" uuid NOT NULL,
	"upto_seq" bigint NOT NULL,
	"state_v2" "bytea" NOT NULL,
	"sv" "bytea" NOT NULL,
	"is_milestone" boolean DEFAULT false NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_snapshots_note_id_upto_seq_pk" PRIMARY KEY("note_id","upto_seq")
);
--> statement-breakpoint
CREATE TABLE "note_updates" (
	"note_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"update_v2" "bytea" NOT NULL,
	"author_id" text,
	"device_id" uuid,
	"lsn" bigint DEFAULT nextval('global_lsn') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_updates_note_id_seq_pk" PRIMARY KEY("note_id","seq")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"content" jsonb DEFAULT '{"type":"doc","content":[]}'::jsonb NOT NULL,
	"content_text" text DEFAULT '' NOT NULL,
	"title_cache" text GENERATED ALWAYS AS (left(split_part(content_text, E'\n', 1), 120)) STORED,
	"color" text DEFAULT 'graphite' NOT NULL,
	"z_mode" smallint DEFAULT 0 NOT NULL,
	"pinned" boolean GENERATED ALWAYS AS (z_mode = 1) STORED,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"head_seq" bigint DEFAULT 0 NOT NULL,
	"crdt_bytes" integer DEFAULT 0 NOT NULL,
	"lsn" bigint DEFAULT nextval('global_lsn') NOT NULL,
	"import_source" text,
	"import_external_id" text,
	"encryption" text DEFAULT 'server' NOT NULL,
	"vault_id" uuid,
	"wrapped_dek" "bytea",
	"key_epoch" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"purged_at" timestamp with time zone,
	CONSTRAINT "notes_color_check" CHECK ("notes"."color" IN ('graphite','rose','coral','amber','citron','fern','teal','azure','violet','fuchsia')),
	CONSTRAINT "notes_z_mode_check" CHECK ("notes"."z_mode" BETWEEN 0 AND 2),
	CONSTRAINT "notes_import_source_check" CHECK ("notes"."import_source" IN ('plum.sqlite','snt','json')),
	CONSTRAINT "notes_encryption_check" CHECK ("notes"."encryption" IN ('server','e2ee')),
	CONSTRAINT "notes_purge_shape" CHECK ("notes"."purge_after" IS NULL OR "notes"."deleted_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "note_pins" (
	"user_id" text NOT NULL,
	"note_id" uuid NOT NULL,
	"always_on_top" boolean DEFAULT false NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_pins_user_id_note_id_pk" PRIMARY KEY("user_id","note_id")
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"note_id" uuid NOT NULL,
	"grantee_kind" "grantee_kind" NOT NULL,
	"grantee_user_id" text,
	"token_hash" "bytea",
	"perm" "note_perm" DEFAULT 'viewer' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "shares_grantee_shape" CHECK (("shares"."grantee_kind" = 'user' AND "shares"."grantee_user_id" IS NOT NULL AND "shares"."token_hash" IS NULL) OR ("shares"."grantee_kind" = 'link' AND "shares"."grantee_user_id" IS NULL AND "shares"."token_hash" IS NOT NULL AND octet_length("shares"."token_hash") = 32))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "workspace_kind" NOT NULL,
	"org_id" text,
	"team_id" text,
	"owner_user_id" text,
	"name" text NOT NULL,
	"default_note_perm" "note_perm" DEFAULT 'editor' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "ws_shape" CHECK (("workspaces"."kind" = 'personal' AND "workspaces"."owner_user_id" IS NOT NULL AND "workspaces"."org_id" IS NULL AND "workspaces"."team_id" IS NULL) OR ("workspaces"."kind" = 'team' AND "workspaces"."org_id" IS NOT NULL AND "workspaces"."owner_user_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "attachment_refs" ADD CONSTRAINT "attachment_refs_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_refs" ADD CONSTRAINT "attachment_refs_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviterId_user_id_fk" FOREIGN KEY ("inviterId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teamMember" ADD CONSTRAINT "teamMember_teamId_team_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teamMember" ADD CONSTRAINT "teamMember_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_snapshots" ADD CONSTRAINT "note_snapshots_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_updates" ADD CONSTRAINT "note_updates_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_updates" ADD CONSTRAINT "note_updates_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_updates" ADD CONSTRAINT "note_updates_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_pins" ADD CONSTRAINT "note_pins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_pins" ADD CONSTRAINT "note_pins_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_grantee_user_id_user_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_refs_att_idx" ON "attachment_refs" USING btree ("attachment_id","last_referenced_at");--> statement-breakpoint
CREATE INDEX "attachments_hash_idx" ON "attachments" USING btree ("workspace_id","content_hash") WHERE "attachments"."status" = 'committed' AND NOT "attachments"."encrypted";--> statement-breakpoint
CREATE INDEX "attachments_pending_idx" ON "attachments" USING btree ("created_at") WHERE "attachments"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "organization_slug_idx" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "team_organizationId_idx" ON "team" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "teamMember_teamId_idx" ON "teamMember" USING btree ("teamId");--> statement-breakpoint
CREATE INDEX "teamMember_userId_idx" ON "teamMember" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "note_snapshots_head_uq" ON "note_snapshots" USING btree ("note_id") WHERE NOT "note_snapshots"."is_milestone";--> statement-breakpoint
CREATE INDEX "note_snapshots_milestone_idx" ON "note_snapshots" USING btree ("created_at") WHERE "note_snapshots"."is_milestone";--> statement-breakpoint
CREATE INDEX "note_updates_lsn_idx" ON "note_updates" USING btree ("lsn");--> statement-breakpoint
CREATE INDEX "notes_trash_idx" ON "notes" USING btree ("workspace_id","deleted_at" DESC NULLS LAST) WHERE "notes"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notes_feed_idx" ON "notes" USING btree ("workspace_id","lsn");--> statement-breakpoint
CREATE INDEX "notes_purge_idx" ON "notes" USING btree ("purge_after") WHERE "notes"."purge_after" IS NOT NULL AND "notes"."purged_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notes_import_uq" ON "notes" USING btree ("workspace_id","import_source","import_external_id") WHERE "notes"."import_external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notes_content_bigm_idx" ON "notes" USING gin ("content_text" gin_bigm_ops) WHERE "notes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "note_pins_note_idx" ON "note_pins" USING btree ("note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shares_user_uq" ON "shares" USING btree ("note_id","grantee_user_id") WHERE "shares"."grantee_kind" = 'user' AND "shares"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "shares_token_uq" ON "shares" USING btree ("token_hash") WHERE "shares"."grantee_kind" = 'link';--> statement-breakpoint
CREATE INDEX "shares_inbox_idx" ON "shares" USING btree ("grantee_user_id","created_at" DESC NULLS LAST) WHERE "shares"."grantee_kind" = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_personal_uq" ON "workspaces" USING btree ("owner_user_id") WHERE "workspaces"."kind" = 'personal';--> statement-breakpoint
CREATE INDEX "workspaces_org_idx" ON "workspaces" USING btree ("org_id","team_id");