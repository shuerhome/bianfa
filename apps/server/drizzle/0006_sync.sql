-- 0006 · 同步进程（sync-ws）所需列与表（规格 03 §1.5 / §6；由 B3 手写，全部幂等）
-- * notes.crdt_sv：最近一次 onStoreDocument 时的 Yjs state vector（V2），用于 diffUpdateV2 只追加增量；NULL = 从未持久化。
-- * note_versions：projector 按「作者变化 ∨ 距上一版 > 10 min」写的版本快照（03 §6）；sync-ws 只读不写。
--   RLS 跟随 notes（同 note_updates），bianfa_worker BYPASSRLS。
ALTER TABLE notes ADD COLUMN IF NOT EXISTS crdt_sv bytea;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS note_versions (
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  crdt_state_v2 bytea NOT NULL,
  content_text text NOT NULL DEFAULT '',
  author_id text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  label text,
  PRIMARY KEY (note_id, seq)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS note_versions_note_created_idx ON note_versions (note_id, created_at DESC);
--> statement-breakpoint
ALTER TABLE note_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE note_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS note_versions_access ON note_versions;
--> statement-breakpoint
CREATE POLICY note_versions_access ON note_versions FOR ALL TO bianfa_app
  USING (EXISTS (SELECT 1 FROM notes n WHERE n.id = note_versions.note_id))
  WITH CHECK (EXISTS (SELECT 1 FROM notes n WHERE n.id = note_versions.note_id));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON note_versions TO bianfa_app, bianfa_worker;
