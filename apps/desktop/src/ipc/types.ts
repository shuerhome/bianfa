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
  /** GET /v1/me 的有效计划（free / pro / team）；尚未拉到时 null */
  plan: string | null;
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
  width: number | null;
  height: number | null;
  blurhash: string | null;
}

/** attachment_upload（Rust：presign → PUT R2 → commit） */
export interface AttachmentUploadResult {
  /** 本地 id（便笺正文里引用的那个） */
  attachmentId: string;
  /** 服务端 id；只有工作区级去重命中时与本地 id 不同 */
  remoteAttachmentId: string | null;
  status: "committed" | "local" | "unsupported" | "disabled";
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

/**
 * import_preview 里的一条便笺：= Python 导出器（@bianfa/shared plumExportNoteSchema）的 snake_case 形状，
 * Rust 额外附带 created_at_ms / updated_at_ms（ISO 已解析；null = 缺失或超出 1990–2100）。
 */
export type ImportPreviewNote = import("@bianfa/shared").PlumExportNote & {
  created_at_ms?: number | null;
  updated_at_ms?: number | null;
};

export interface ImportPreview {
  notes: ImportPreviewNote[];
  archivedTo: string;
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

/** `block` 关闭网络功能（更新 / 同步 / 登录），其余只是提示 */
export type NoticeAction = "notice" | "block";

/** Rust notices.rs 验签后下发的公告（camelCase；服务端只转发签名信封，不解析） */
export interface Notice {
  id: string;
  issuedAt: string | number | null;
  expiresAt: string | number | null;
  action: NoticeAction | string;
  /** 空 = 全平台 */
  platforms: string[];
  /** semver 范围；null / "*" = 全部版本 */
  affectedVersions: string | null;
  title: string;
  body: string;
  url: string | null;
}

// ── 待办聚合（todos_list / todos_counts：跨便笺的 checklist 行，Rust 从本地投影表读） ──
export interface TodoItem {
  noteId: string;
  noteTitle: string;
  noteColor: NoteColor;
  workspaceId: string | null;
  /** taskItem.attrs.id（nanoid(10)） */
  blockId: string;
  text: string;
  checked: boolean;
  /** 便笺内文档序，从 0 起 */
  ordinal: number;
  noteUpdatedAt: number;
  itemUpdatedAt: number;
}

export interface TodoCounts {
  open: number;
  done: number;
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
  /** failed 时的双语说明（如 device_limit_reached）；Rust 未给出时为 null */
  message?: string | null;
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
