// 桌面端 → 真实服务端的端到端脚手架：只把 **Tauri 的 IPC 边界**（Rust 侧）换成内存实现。
//
// 被替换掉的只有一样东西：`window.__TAURI_INTERNALS__.invoke` —— 也就是 Rust。SQLite 本地库、
// 取同步凭据的命令、HTTP 出口（api_request）都在这一层之下，因此一并成了内存实现。
// 这一层**之上**的东西全是真的，一个都没有 mock：
//   apps/desktop/src/ipc/commands.ts、ipc/events.ts、api/*、editor/projection.ts、
//   sync/token.ts、sync/host.ts（SyncHost 本体），以及 @hocuspocus/provider。
// 服务端也是真的：apps/server/src/sync/server.ts + Postgres。
//
// 为什么用运行时动态 import 载入 SyncHost（而不是普通 import）：
//   apps/server 的 tsconfig 是 rootDir=apps/server、lib 不含 DOM；静态 import 会把 apps/desktop
//   的源码拖进服务端的 tsc program，报一堆 TS6059 / 「找不到 window」。动态 import 让 tsc 不去
//   分析它，vitest 在运行时照样加载真实源码。代价是这里要手写 SyncHost 的结构类型（见下）。
import { fileURLToPath } from "node:url";
import { createNoteDoc, encodeStateV2, getBody, openNoteDoc } from "@bianfa/shared";
import * as Y from "yjs";

const DESKTOP_SRC = new URL("../../../desktop/src/", import.meta.url);
const HOST_MODULE = fileURLToPath(new URL("sync/host.ts", DESKTOP_SRC));

/** SyncHost 的结构类型（动态 import 拿不到真类型；只用到这两个方法） */
export interface DesktopSyncHost {
  start(): Promise<void>;
  stop(): void;
}

export interface DesktopHostModule {
  SyncHost: new () => DesktopSyncHost;
}

/** 载入真实的 apps/desktop/src/sync/host.ts */
export async function loadDesktopSyncHost(): Promise<DesktopHostModule> {
  return (await import(HOST_MODULE)) as DesktopHostModule;
}

const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const fromB64 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

/** 内存版本地库里的一行便笺：updates 的下标 + 1 就是 seq（与 Rust 侧 ydoc_updates.seq 同义） */
interface LocalNote {
  id: string;
  workspaceId: string | null;
  updates: string[];
  ackedSeq: number;
  isOpen: boolean;
}

export interface AppendedUpdate {
  noteId: string;
  origin: string;
  contentText: string;
}

export interface DesktopBridgeOptions {
  /** 同步地址，形如 ws://127.0.0.1:<port>/ws/v1 */
  syncWsUrl: string;
  apiBaseUrl: string;
  userId: string;
  personalWorkspaceId: string;
  /** 每次 auth_sync_token 现签一枚（真 JWT，服务端要验） */
  mintSyncToken(): Promise<string>;
}

export interface DesktopBridge {
  /** 本地库里新建一张便笺（只在本地存在，服务端还没有这一行） */
  createLocalNote(noteId: string, workspaceId: string): void;
  /** 模拟用户在便笺里敲一行字：写本地库并 emit db:changed(origin=local) */
  typeLocally(noteId: string, text: string): void;
  /** 本地库当前的正文（用于断言远端 → 本地这条通路） */
  localBodyText(noteId: string): string;
  /** Rust 侧收到的 note_append_update（远端来的更新走这里落本地库） */
  appended: AppendedUpdate[];
  /** 经 api_request 出去的 HTTP 路径（含 query），用于断言 inbox bump 真的触发了一次发现 */
  apiCalls: string[];
  /** 没有实现的 Rust command：应当始终为空，否则说明脚手架漏了桌面端真正会调的东西 */
  unknownCommands: string[];
  /** sync_state_set_error 的调用记录 */
  syncErrors: Array<{ noteId: string; errCode: string | null; message?: string }>;
  logs: string[];
  uninstall(): void;
}

interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  transformCallback(callback: (payload: unknown) => void, once?: boolean): number;
  unregisterCallback(id: number): void;
  convertFileSrc(path: string): string;
}

interface TauriEventInternals {
  unregisterListener(event: string, eventId: number): void;
}

type GlobalWithTauri = typeof globalThis & {
  window?: unknown;
  isTauri?: boolean | undefined;
  __TAURI_INTERNALS__?: TauriInternals | undefined;
  __TAURI_EVENT_PLUGIN_INTERNALS__?: TauriEventInternals | undefined;
};

/**
 * 装上假的 Rust 侧。桌面端代码跑在 WebView 里，靠 `window.__TAURI_INTERNALS__` 和 `window.setInterval`
 * 这些全局；node 里没有 window，这里把 globalThis 当 window 用（node 的定时器与 btoa/atob 语义一致）。
 */
export function installDesktopBridge(opts: DesktopBridgeOptions): DesktopBridge {
  const g = globalThis as GlobalWithTauri;
  const hadWindow = "window" in g;
  const notes = new Map<string, LocalNote>();
  const appended: AppendedUpdate[] = [];
  const unknownCommands: string[] = [];
  const syncErrors: DesktopBridge["syncErrors"] = [];
  const apiCalls: string[] = [];
  const logs: string[] = [];

  // Tauri 事件通道：listen 把回调经 transformCallback 换成一个 id 再 invoke('plugin:event|listen')
  const callbacks = new Map<number, (payload: unknown) => void>();
  const listeners = new Map<string, Map<number, (payload: unknown) => void>>();
  let nextCallbackId = 1;
  let nextEventId = 1;

  function emit(event: string, payload: unknown): void {
    for (const handler of Array.from(listeners.get(event)?.values() ?? [])) {
      handler({ event, id: nextEventId, payload });
    }
  }

  function requireNote(noteId: string): LocalNote {
    const note = notes.get(noteId);
    // Tauri 的 invoke 是用 Rust 的错误载荷 reject 的，桌面端 toIpcError 认的就是 { code, message }
    if (!note) throw { code: "not_found", message: `本地库没有便笺 ${noteId}` };
    return note;
  }

  function docOf(note: LocalNote): Y.Doc {
    return openNoteDoc(note.id, note.updates.map(fromB64), "local-db");
  }

  function noteRecord(note: LocalNote): Record<string, unknown> {
    const doc = docOf(note);
    const text = getBody(doc).toString();
    doc.destroy();
    return {
      id: note.id,
      title: "",
      excerpt: "",
      color: "amber",
      zMode: 0,
      pinned: false,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      isOpen: note.isOpen,
      synced: note.ackedSeq >= note.updates.length,
      workspaceId: note.workspaceId,
      bodyHtml: "",
      schemaVersion: 1,
      headSeq: note.updates.length,
      contentText: text,
    };
  }

  const okBody = (body: unknown) => ({ status: 200, headers: {}, bodyText: JSON.stringify(body) });

  /** 内存版服务端 HTTP：发现相关的三个 GET；本地这张便笺服务端还没有，所以 notes 为空 */
  function apiRequest(args: Record<string, unknown>): unknown {
    const url = new URL(`http://api.invalid${String(args.path)}`);
    apiCalls.push(url.pathname + url.search);
    if (url.pathname === "/v1/workspaces") {
      return okBody({
        workspaces: [
          {
            id: opts.personalWorkspaceId,
            kind: "personal",
            org_id: null,
            team_id: null,
            owner_user_id: opts.userId,
            name: "个人",
            default_note_perm: "manager",
            effective_perm: "manager",
            created_at: new Date(0).toISOString(),
            archived_at: null,
          },
        ],
      });
    }
    if (url.pathname === "/v1/notes") {
      return okBody({
        workspace_id: url.searchParams.get("workspace_id"),
        effective_perm: "manager",
        notes: [],
        next_version: Number(url.searchParams.get("since_version") ?? 0),
        has_more: false,
      });
    }
    if (url.pathname === "/v1/shared-with-me") return okBody({ items: [], next_cursor: null });
    return { status: 404, headers: {}, bodyText: JSON.stringify({ error: "not_found" }) };
  }

  async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    switch (cmd) {
      // ── Tauri 事件插件 ──
      case "plugin:event|listen": {
        const handler = callbacks.get(Number(args.handler));
        const event = String(args.event);
        const id = nextEventId++;
        if (handler) {
          const bucket = listeners.get(event) ?? new Map();
          bucket.set(id, handler);
          listeners.set(event, bucket);
        }
        return id;
      }
      case "plugin:event|unlisten":
        listeners.get(String(args.event))?.delete(Number(args.eventId));
        return undefined;
      case "plugin:event|emit":
      case "plugin:event|emit_to":
        return undefined;

      // ── 设置 / 登录态 / 凭据 ──
      case "settings_get":
        return {
          theme: "system",
          uiScale: 1,
          language: "zh-CN",
          autostart: false,
          channel: "stable",
          hotkeyNewNote: "",
          desktopPinReadonly: false,
          colorPatterns: false,
          reduceTransparency: false,
          apiBaseUrl: opts.apiBaseUrl,
          syncWsUrl: opts.syncWsUrl,
        };
      case "auth_status":
        return {
          loggedIn: true,
          user: { id: opts.userId, email: `${opts.userId}@test.invalid`, name: "端到端", image: null },
          deviceId: "device-e2e",
          personalWorkspaceId: opts.personalWorkspaceId,
          activeOrganizationId: null,
          plan: "pro",
        };
      case "auth_sync_token":
        return { token: await opts.mintSyncToken(), expiresAt: Date.now() + 60_000 };
      case "client_log":
        logs.push(`${String(args.level)} ${String(args.scope)} ${String(args.message)}`);
        return undefined;

      // ── 本地库 ──
      case "notes_list":
        return Array.from(notes.values()).map(noteRecord);
      case "notes_pending_sync":
        return Array.from(notes.values())
          .filter((n) => n.updates.length > n.ackedSeq)
          .map((n) => ({ noteId: n.id, headSeq: n.updates.length }));
      case "note_get":
        return noteRecord(requireNote(String(args.noteId)));
      case "note_load_doc": {
        const note = requireNote(String(args.noteId));
        return {
          snapshotB64: null,
          snapshotUptoSeq: 0,
          updatesB64: [...note.updates],
          headSeq: note.updates.length,
        };
      }
      case "note_updates_since": {
        const note = requireNote(String(args.noteId));
        const after = Number(args.afterSeq);
        return { updatesB64: note.updates.slice(after), headSeq: note.updates.length };
      }
      case "note_append_update": {
        const note = requireNote(String(args.noteId));
        note.updates.push(String(args.updateV2B64));
        const origin = String(args.origin);
        const projection = args.projection as { contentText?: string } | undefined;
        appended.push({ noteId: note.id, origin, contentText: projection?.contentText ?? "" });
        // Rust 落库后 emit db:changed，origin 原样透传
        emit("db:changed", {
          rev: note.updates.length,
          origin,
          tables: ["notes", "ydoc_updates"],
          ids: [note.id],
        });
        return { seq: note.updates.length };
      }
      case "note_create": {
        const noteId = String(args.noteId);
        notes.set(noteId, {
          id: noteId,
          workspaceId: (args.workspaceId as string | null | undefined) ?? null,
          updates: [String(args.updateV2B64)],
          ackedSeq: 0,
          isOpen: false,
        });
        return noteRecord(requireNote(noteId));
      }
      case "note_set_synced": {
        const note = notes.get(String(args.noteId));
        if (note) note.ackedSeq = Math.max(note.ackedSeq, Number(args.headSeq));
        return undefined;
      }
      case "note_version_save":
        return { id: "version-e2e" };
      case "sync_state_set_error":
        syncErrors.push({
          noteId: String(args.noteId),
          errCode: (args.errCode as string | null | undefined) ?? null,
          ...(typeof args.message === "string" ? { message: args.message } : {}),
        });
        return undefined;

      // ── 附件（本用例不涉及） ──
      case "attachments_pending_upload":
        return [];
      case "attachment_upload":
        return { status: "ok" };

      // ── 唯一 HTTP 出口 ──
      case "api_request":
        return apiRequest(args);

      default:
        unknownCommands.push(cmd);
        throw { code: "command_not_found", message: `脚手架未实现 Rust command：${cmd}` };
    }
  }

  const internals: TauriInternals = {
    invoke: (cmd, args) => invoke(cmd, args ?? {}),
    transformCallback(callback) {
      const id = nextCallbackId++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc: (path) => path,
  };

  if (!hadWindow) Object.defineProperty(g, "window", { value: g, configurable: true, writable: true });
  g.isTauri = true;
  g.__TAURI_INTERNALS__ = internals;
  g.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };

  return {
    createLocalNote(noteId, workspaceId) {
      const doc = createNoteDoc(noteId, { origin: "local" });
      const state = encodeStateV2(doc);
      doc.destroy();
      notes.set(noteId, { id: noteId, workspaceId, updates: [toB64(state)], ackedSeq: 0, isOpen: true });
    },
    typeLocally(noteId, text) {
      const note = requireNote(noteId);
      // 与 Rust 侧一样：编辑器产生的 updateV2 单独一行落进 ydoc_updates，seq 自增
      const doc = docOf(note);
      const captured: Uint8Array[] = [];
      doc.on("updateV2", (update: Uint8Array) => {
        captured.push(update);
      });
      doc.transact(() => {
        const body = doc.getXmlFragment("body");
        const paragraph = new Y.XmlElement("paragraph");
        const t = new Y.XmlText();
        t.insert(0, text);
        paragraph.insert(0, [t]);
        body.insert(body.length, [paragraph]);
      }, "local");
      doc.destroy();
      if (captured.length === 0) throw new Error(`typeLocally 没有产生 update：${noteId}`);
      for (const update of captured) note.updates.push(toB64(update));
      emit("db:changed", {
        rev: note.updates.length,
        origin: "local",
        tables: ["notes", "ydoc_updates"],
        ids: [note.id],
      });
    },
    localBodyText(noteId) {
      const doc = docOf(requireNote(noteId));
      const text = getBody(doc).toString();
      doc.destroy();
      return text;
    },
    appended,
    apiCalls,
    unknownCommands,
    syncErrors,
    logs,
    uninstall() {
      listeners.clear();
      callbacks.clear();
      g.isTauri = undefined;
      g.__TAURI_INTERNALS__ = undefined;
      g.__TAURI_EVENT_PLUGIN_INTERNALS__ = undefined;
      if (!hadWindow) delete (g as { window?: unknown }).window;
    },
  };
}
