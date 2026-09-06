// specs/07 IPC 契约（含协调者修订：sync host 新增 command）。二进制一律 base64 字符串（*B64）。
import type { ChecklistItem, NoteColor, PMJson, ZMode } from "@bianfa/shared";

export type { ChecklistItem, NoteColor, PMJson, ZMode };

/** JS 侧用 @bianfa/shared projectNoteDoc + static-renderer 算出，随 update 一起交给 Rust 写投影列 */
export interface NoteProjection {
  content: PMJson;
  contentText: string;
  contentBigram: string;
  bodyHtml: string;
  color: NoteColor;
  zMode: ZMode;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  schemaVersion: number;
  attachmentIds: string[];
  checklist: ChecklistItem[];
}

export interface NoteListItem {
  id: string;
  title: string;
  excerpt: string;
  color: NoteColor;
  zMode: ZMode;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  isOpen: boolean;
  synced: boolean;
  workspaceId: string | null;
}

export interface NoteRecord extends NoteListItem {
  bodyHtml: string;
  schemaVersion: number;
  headSeq: number;
  contentText: string;
}

export interface NoteDocBundle {
  snapshotB64: string | null;
  snapshotUptoSeq: number;
  updatesB64: string[];
  headSeq: number;
}

export interface NoteUpdatesSince {
  updatesB64: string[];
  headSeq: number;
}

export type UpdateOrigin = "local" | "remote" | "import" | "ai";

export interface WindowState {
  noteId: string;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  monitorKey: string | null;
  scale: number | null;
  homeDisplayId: string | null;
  homeBounds: string | null;
  zMode: ZMode;
  collapsed: boolean;
  isOpen: boolean;
  updatedAt: number;
}

export type ThemeSetting = "system" | "light" | "dark";
export type UiScale = 90 | 100 | 115 | 130;
export type LanguageSetting = "zh-Hans" | "en" | "system";

export interface Settings {
  theme: ThemeSetting;
  uiScale: UiScale;
  language: LanguageSetting;
  autostart: boolean;
  channel: "stable" | "beta";
  hotkeyNewNote: string;
  desktopPinReadonly: boolean;
  colorPatterns: boolean;
  reduceTransparency: boolean;
  apiBaseUrl: string;
  syncWsUrl: string;
}

export type Os = "windows" | "macos" | "linux";

export interface AppInfo {
  version: string;
  os: Os;
  arch: string;
  dataDir: string;
  installId: string;
  channel: string;
  webview: string;
  isAutostartLaunch: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

export interface AuthStatus {
  loggedIn: boolean;
  user: AuthUser | null;
  deviceId: string;
  personalWorkspaceId: string | null;
  activeOrganizationId: string | null;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export interface SearchFilters {
  pinned?: boolean;
  trashed?: boolean;
  color?: NoteColor;
}

export interface AttachmentInfo {
  id: string;
  hash: string;
  mime: string;
  byteSize: number;
  width: number;
  height: number;
  blurhash: string;
}

export interface ImportSource {
  kind: "plum" | "snt";
  path: string;
  count: number;
  stickyNotesRunning: boolean;
}

export interface ImportWindow {
  x: number;
  y: number;
  w: number;
  h: number;
  displayId: string;
}

export interface ImportCommitItem {
  externalId: string;
  noteId: string;
  updateV2B64: string;
  projection: NoteProjection;
  isOpen: boolean;
  window: ImportWindow | null;
  sourceUpdatedAt: number | null;
  degraded: boolean;
}

export interface ImportCommitResult {
  imported: number;
  updated: number;
  skipped: number;
}

export interface ExportFile {
  relPath: string;
  contentB64: string;
}

export interface UpdateCheckResult {
  available: boolean;
  version?: string;
  notes?: string;
}

export type NoticeSeverity = "info" | "warn" | "block";

export interface Notice {
  id: string;
  min_version_affected: string;
  max_version_affected: string;
  title: string;
  body: string;
  download_url: string;
  severity: NoticeSeverity;
  issued_at: string;
}

export type SyncErrCode = "forbidden" | "too_large" | "quota" | "gone";

export interface SyncErrorEntry {
  noteId: string;
  errCode: SyncErrCode;
  message: string | null;
  at: number;
}

export interface NoteVersionMeta {
  id: string;
  label: string;
  createdAt: number;
  byteSize: number;
}

// ── 事件 payload ──
export type DbChangeOrigin = UpdateOrigin | "system";
export interface DbChangedPayload {
  rev: number;
  origin: DbChangeOrigin;
  tables: string[];
  ids: string[];
}
export interface ThemeChangedPayload {
  effective: "light" | "dark";
}
export type LoginPhase = "waiting" | "timeout-soon" | "device-fallback" | "failed" | "done";
export interface LoginProgressPayload {
  phase: LoginPhase;
  message?: string;
}
export interface UpdateAvailablePayload {
  version: string;
  notes?: string;
}
export interface NoteFocusRequestPayload {
  noteId: string;
}
export type SyncState = "offline" | "syncing" | "synced" | "error" | "local";
export interface SyncStatusPayload {
  noteId?: string;
  state: SyncState;
  at: number;
  detail?: string;
}
