// 每个 Rust command 一个类型化函数（specs/07 §2 + 协调者修订）。参数是单个对象，Rust 侧 camelCase→snake_case 自动转换。
import { invoke, isTauri } from "@tauri-apps/api/core";
import { IpcError, toIpcError } from "./errors.js";
import type {
  ApiResponse,
  AppInfo,
  AttachmentInfo,
  AttachmentUploadResult,
  AuthStatus,
  ExportFile,
  ImportCommitItem,
  ImportCommitResult,
  ImportPreview,
  ImportSource,
  NoteColor,
  NoteDocBundle,
  NoteListItem,
  NoteProjection,
  NoteRecord,
  NoteUpdatesSince,
  NoteVersionMeta,
  Notice,
  SearchFilters,
  Settings,
  SyncErrCode,
  SyncErrorEntry,
  TodoCounts,
  TodoItem,
  UpdateCheckResult,
  UpdateOrigin,
  WindowState,
  ZMode,
} from "./types.js";

/** 单一出口：非 Tauri 环境（vite dev 纯浏览器 / 测试未 mock）直接抛 no_tauri，不静默 */
export async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) throw new IpcError("no_tauri", `不在 Tauri 环境中，无法调用 ${cmd}`);
  try {
    return await invoke<T>(cmd, args);
  } catch (raw) {
    throw toIpcError(raw);
  }
}

// ── 2.1 便笺与本地库 ──
export const notesList = (args: { includeTrashed?: boolean; workspaceId?: string | null } = {}) =>
  call<NoteListItem[]>("notes_list", args);

export const notesSearch = (args: {
  q: string;
  bigramQuery: string | null;
  includeTrashed?: boolean;
  limit?: number;
  filters?: SearchFilters;
}) => call<NoteListItem[]>("notes_search", args);

export const noteGet = (noteId: string) => call<NoteRecord>("note_get", { noteId });

export const noteCreate = (args: {
  noteId: string;
  updateV2B64: string;
  projection: NoteProjection;
  workspaceId?: string | null;
  importSource?: string;
  importExternalId?: string;
}) => call<NoteRecord>("note_create", args);

export const noteLoadDoc = (noteId: string) => call<NoteDocBundle>("note_load_doc", { noteId });

/** 协调者修订：某 seq 之后的 updates（note 窗 / sync host 增量同步） */
export const noteUpdatesSince = (noteId: string, afterSeq: number) =>
  call<NoteUpdatesSince>("note_updates_since", { noteId, afterSeq });

export const noteAppendUpdate = (args: {
  noteId: string;
  updateV2B64: string;
  origin: UpdateOrigin;
  projection?: NoteProjection;
}) => call<{ seq: number }>("note_append_update", args);

export const noteWriteSnapshot = (args: {
  noteId: string;
  stateV2B64: string;
  svB64: string;
  uptoSeq: number;
}) => call<void>("note_write_snapshot", args);

export const noteCompact = (noteId: string) => call<{ uptoSeq: number }>("note_compact", { noteId });

export const noteDiscardIfEmpty = (noteId: string) =>
  call<{ discarded: boolean; empty: boolean }>("note_discard_if_empty", { noteId });

export const noteSetSynced = (noteId: string, headSeq: number) =>
  call<void>("note_set_synced", { noteId, headSeq });

export const notesPendingSync = () => call<{ noteId: string; headSeq: number }[]>("notes_pending_sync");

export const trashEmpty = () => call<{ purged: number }>("trash_empty");

export const notesPurgeExpired = () => call<{ purged: number }>("notes_purge_expired");

// ── 待办聚合（跨便笺 checklist 行；workspaceId null = 本机全部便笺） ──
export const todosList = (args: { includeDone: boolean; workspaceId: string | null; limit?: number }) =>
  call<TodoItem[]>("todos_list", args);

export const todosCounts = () => call<TodoCounts>("todos_counts");

// ── 版本 / 同步状态（协调者修订） ──
export const noteVersionSave = (args: { noteId: string; stateV2B64: string; label: string }) =>
  call<{ id: string }>("note_version_save", args);

export const noteVersionsList = (noteId: string) => call<NoteVersionMeta[]>("note_versions_list", { noteId });

export const noteVersionGet = (id: string) => call<{ stateV2B64: string }>("note_version_get", { id });

export const syncStateSetError = (args: { noteId: string; errCode: SyncErrCode | null; message?: string }) =>
  call<void>("sync_state_set_error", args);

export const syncErrorsList = () => call<SyncErrorEntry[]>("sync_errors_list");

// ── 2.2 窗口 ──
export const noteWindowOpen = (noteId: string, focus = true) =>
  call<{ label: string }>("note_window_open", { noteId, focus });

export const noteWindowClose = (noteId: string) => call<void>("note_window_close", { noteId });

export const noteWindowSetZmode = (noteId: string, zMode: ZMode) =>
  call<void>("note_window_set_zmode", { noteId, zMode });

export const noteWindowSetCollapsed = (noteId: string, collapsed: boolean) =>
  call<void>("note_window_set_collapsed", { noteId, collapsed });

export const noteWindowSetColor = (noteId: string, color: NoteColor) =>
  call<void>("note_window_set_color", { noteId, color });

export const windowStateGet = (noteId: string) => call<WindowState | null>("window_state_get", { noteId });

export const windowStateSave = (args: {
  noteId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  monitorKey?: string;
  scale?: number;
}) => call<void>("window_state_save", args);

export const notesShowAll = () => call<void>("notes_show_all");
export const notesHideAll = () => call<void>("notes_hide_all");

export const mainWindowOpen = (section?: "notes" | "trash" | "team") =>
  call<void>("main_window_open", section ? { section } : {});

export const settingsWindowOpen = (section?: string) =>
  call<void>("settings_window_open", section ? { section } : {});

/** Rust 只分配 id + 开窗；窗口加载后由 JS note_create */
export const noteNew = (args: { atCursor?: boolean; color?: NoteColor } = {}) =>
  call<{ noteId: string }>("note_new", args);

export const windowStartDrag = () => call<void>("window_start_drag");

// ── 2.3 设置、应用、系统 ──
export interface DataLocation {
  current: string;
  default: string;
  isCustom: boolean;
  inCloudFolder: boolean;
}

export const dataLocationGet = () => call<DataLocation>("data_location_get");
export const dataLocationCheck = (target: string) =>
  call<{ ok: boolean; reason?: string }>("data_location_check", { target });
/** target 传 null = 搬回系统默认位置。返回后必须重启：数据库连接已经关掉了。 */
export const dataLocationMove = (target: string | null) =>
  call<{ ok: boolean; from: string; to: string; bytes: number; restartRequired: boolean }>(
    "data_location_move",
    { target },
  );

export const settingsGet = () => call<Settings>("settings_get");

/**
 * 往 Rust 的文件日志里写一行。
 * 同步宿主跑在隐藏 WebView 里，它的 console 没人看得到——不经这条通道，出问题时日志一片空白。
 * 刻意不抛：日志失败绝不能反过来把业务打断。
 */
export function clientLog(level: "info" | "warn" | "error", scope: string, message: string): void {
  void call("client_log", { level, scope, message }).catch(() => {});
}
export const settingsSet = (patch: Partial<Settings>) => call<Settings>("settings_set", { patch });
export const appInfo = () => call<AppInfo>("app_info");
export const autostartSet = (enabled: boolean) =>
  call<{ enabled: boolean; method: "registry" | "smappservice" | "launchagent" }>("autostart_set", {
    enabled,
  });
export const hotkeySet = (accelerator: string) =>
  call<{ ok: boolean; error?: string }>("hotkey_set", { accelerator });
export const openExternal = (url: string) => call<void>("open_external", { url });
export const openDataDir = () => call<void>("open_data_dir");
export const themeCurrent = () =>
  call<{ system: "light" | "dark"; effective: "light" | "dark" }>("theme_current");

// ── 2.4 账号与网络 ──
export const authStatus = () => call<AuthStatus>("auth_status");
export const authLoginStart = () => call<{ authUrl: string; state: string }>("auth_login_start");
export const authLoginDeviceStart = () =>
  call<{ userCode: string; verificationUrl: string; expiresIn: number }>("auth_login_device_start");
export const authLoginCancel = () => call<void>("auth_login_cancel");
export const authLogout = (wipeLocal = false) => call<void>("auth_logout", { wipeLocal });
/** expiresAt = 服务端 expires_at（Unix ms） */
export const authSyncToken = () => call<{ token: string; expiresAt: number }>("auth_sync_token");

/** 唯一 HTTP 出口；path 必须以 /v1/ 开头。headers 原样加到请求上（Rust 拒绝 Authorization 等代理自有头） */
export const apiRequest = (args: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  jsonBody?: unknown;
  timeoutMs?: number;
  headers?: Record<string, string>;
}) => {
  if (!args.path.startsWith("/v1/"))
    return Promise.reject(new IpcError("bad_path", "api_request path 必须以 /v1/ 开头"));
  return call<ApiResponse>("api_request", args);
};

// ── 2.5 附件、导入、导出、更新 ──
export const attachmentImport = (args: {
  noteId: string;
  sourcePath?: string;
  bytesB64?: string;
  mime?: string;
}) => call<AttachmentInfo>("attachment_import", args);
export const attachmentLocalUrl = (id: string) => call<{ url: string }>("attachment_local_url", { id });
/** 协调者修订：登录后由 Rust 走 presign → PUT → commit；未登录直接返回 status 'local' */
export const attachmentUpload = (id: string) => call<AttachmentUploadResult>("attachment_upload", { id });
/** upload_state = 'local' 的附件 id（sync host 登录 / 重连后补传） */
export const attachmentsPendingUpload = () => call<string[]>("attachments_pending_upload");

export const importScan = () => call<{ sources: ImportSource[] }>("import_scan");
export const importPreview = (path: string) => call<ImportPreview>("import_preview", { path });
export const importCommit = (path: string, items: ImportCommitItem[]) =>
  call<ImportCommitResult>("import_commit", { path, items });

export const exportWrite = (outDir: string, files: ExportFile[]) =>
  call<{ written: number }>("export_write", { outDir, files });
export const pickDirectory = (args: { title?: string } = {}) =>
  call<{ path: string | null }>("pick_directory", args);
export const pickFile = (args: { title?: string; filters?: { name: string; extensions: string[] }[] } = {}) =>
  call<{ path: string | null }>("pick_file", args);

export const updateCheck = (manual = false) => call<UpdateCheckResult>("update_check", { manual });
export const updateInstall = () => call<void>("update_install");
export const noticeGet = () => call<{ notice: Notice | null }>("notice_get");
export const noticeAck = (id: string) => call<void>("notice_ack", { id });
