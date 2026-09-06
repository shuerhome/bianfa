-- 0005 · 领域表补齐（B2）：notes.projected_seq / expires_at / archived_at，workspaces.deleted_at，
--        claimed_local_ids、export_jobs、notifications(+preferences/quiet_hours)、comments。
-- 依据：规格 04 §4.2（claimed_local_ids / export_jobs / notifications DDL 取 docs/07 §6.4，FK 改指向 "user"/organization，
--       ID 类型按规格 02 §0 一律 text）、规格 03 §4（projected_seq 裁定）、04 §4.6（expires_at → archived_at）、
--       04 §6.4（comments：客户端 UUIDv7 + ON CONFLICT DO NOTHING）。全部 IF NOT EXISTS，可重复执行。
-- 新表不开 RLS（访问全部经应用层 authorizeNote / user_id 过滤），显式 GRANT 给 bianfa_app / bianfa_worker。
ALTER TABLE notes ADD COLUMN IF NOT EXISTS projected_seq bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE notes ADD COLUMN IF NOT EXISTS expires_at timestamptz;
--> statement-breakpoint
ALTER TABLE notes ADD COLUMN IF NOT EXISTS archived_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notes_expires_idx ON notes (expires_at) WHERE expires_at IS NOT NULL AND archived_at IS NULL;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS claimed_local_ids (
  local_user_id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS claimed_local_ids_user_idx ON claimed_local_ids (user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS export_jobs (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  org_id text REFERENCES organization(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'user',
  status text NOT NULL DEFAULT 'queued',
  storage_key text,
  byte_size bigint,
  error text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT export_jobs_scope_check CHECK (scope IN ('user','org')),
  CONSTRAINT export_jobs_status_check CHECK (status IN ('queued','building','ready','failed','expired'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS export_jobs_user_idx ON export_jobs (user_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  org_id text REFERENCES organization(id) ON DELETE CASCADE,
  kind text NOT NULL,
  actor_id text REFERENCES "user"(id) ON DELETE SET NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  group_key text,
  read_at timestamptz,
  seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications (user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notif_unread ON notifications (user_id) WHERE read_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notif_group ON notifications (user_id, group_key, created_at DESC) WHERE group_key IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  org_id text REFERENCES organization(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT '*',
  in_app boolean NOT NULL DEFAULT true,
  desktop boolean NOT NULL DEFAULT true,
  email text NOT NULL DEFAULT 'digest',
  CONSTRAINT notification_preferences_email_check CHECK (email IN ('off','instant','digest')),
  CONSTRAINT notification_preferences_uq UNIQUE NULLS NOT DISTINCT (user_id, org_id, kind)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_quiet_hours (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'UTC',
  start_minute smallint NOT NULL DEFAULT 1320,
  end_minute smallint NOT NULL DEFAULT 480,
  days_mask smallint NOT NULL DEFAULT 127,
  dnd_until timestamptz,
  suppress_desktop boolean NOT NULL DEFAULT true,
  suppress_email boolean NOT NULL DEFAULT false,
  CONSTRAINT notification_quiet_hours_minutes_check CHECK (start_minute BETWEEN 0 AND 1439 AND end_minute BETWEEN 0 AND 1439),
  CONSTRAINT notification_quiet_hours_days_check CHECK (days_mask BETWEEN 0 AND 127)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS comments (
  id uuid PRIMARY KEY,
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comments_body_len_check CHECK (char_length(body) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS comments_note_idx ON comments (note_id, created_at);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON claimed_local_ids, export_jobs, notifications, notification_preferences, notification_quiet_hours, comments TO bianfa_app, bianfa_worker;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE notifications_id_seq TO bianfa_app, bianfa_worker;
