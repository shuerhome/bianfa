//! Local SQLite schema (02 §2, window-state shape per 05 §2.4 / 07 §1, plus the 03-sync
//! amendment: `sync_state` per note and `ydoc_versions`).
//!
//! Additions vs 02 §2 (documented in README): `notes.body_html` (07 NoteRecord.bodyHtml),
//! `notes.purged` (tombstone whose body was cleared), `note_attachments` (local refs used by
//! `note_discard_if_empty`).

pub const USER_VERSION: i64 = 1;

pub const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  content TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}',
  content_text TEXT NOT NULL DEFAULT '',
  content_bigram TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'graphite',
  z_mode INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  head_seq INTEGER NOT NULL DEFAULT 0,
  import_source TEXT,
  import_external_id TEXT,
  synced INTEGER NOT NULL DEFAULT 0,
  purged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_after INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS notes_list_idx ON notes (z_mode = 1, updated_at DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notes_import_uq ON notes (import_source, import_external_id) WHERE import_external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ydoc_updates (
  note_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  update_v2 BLOB NOT NULL,
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, seq)
) STRICT;

CREATE TABLE IF NOT EXISTS ydoc_snapshots (
  note_id TEXT NOT NULL,
  upto_seq INTEGER NOT NULL,
  state_v2 BLOB NOT NULL,
  sv BLOB NOT NULL,
  is_daily INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, upto_seq)
) STRICT;

CREATE TABLE IF NOT EXISTS ydoc_versions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  label TEXT NOT NULL,
  state_v2 BLOB NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ydoc_versions_note_idx ON ydoc_versions (note_id, label, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  content_bigram, content='notes', content_rowid='rowid', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, content_bigram) VALUES (new.rowid, new.content_bigram);
END;
CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content_bigram) VALUES ('delete', old.rowid, old.content_bigram);
END;
CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE OF content_bigram ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content_bigram) VALUES ('delete', old.rowid, old.content_bigram);
  INSERT INTO notes_fts(rowid, content_bigram) VALUES (new.rowid, new.content_bigram);
END;

CREATE TABLE IF NOT EXISTS note_window_state (
  note_id TEXT PRIMARY KEY,
  x INTEGER, y INTEGER, w INTEGER, h INTEGER,
  monitor_key TEXT,
  scale REAL,
  home_display_id TEXT,
  home_bounds TEXT,
  z_mode INTEGER NOT NULL DEFAULT 0,
  collapsed INTEGER NOT NULL DEFAULT 0,
  is_open INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  content_hash BLOB NOT NULL,
  byte_size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  blurhash TEXT,
  local_path TEXT NOT NULL,
  upload_state TEXT NOT NULL DEFAULT 'local',
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS attachments_hash_idx ON attachments (content_hash);

CREATE TABLE IF NOT EXISTS note_attachments (
  note_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  PRIMARY KEY (note_id, attachment_id)
) STRICT;

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload BLOB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
) STRICT;
CREATE INDEX IF NOT EXISTS outbox_ready_idx ON outbox (status, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS sync_state (
  note_id TEXT PRIMARY KEY,
  local_seq INTEGER NOT NULL,
  acked_seq INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER,
  err_code TEXT,
  last_error TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS forensic_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_text TEXT NOT NULL,
  remote_update BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_path TEXT NOT NULL,
  archived_to TEXT NOT NULL,
  note_count INTEGER NOT NULL,
  degraded_count INTEGER NOT NULL,
  ink_count INTEGER NOT NULL,
  imported_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT) STRICT;
"#;
