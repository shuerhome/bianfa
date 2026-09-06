// 同步宿主（协调者修订 / specs/03 §2.3）：唯一持有 WebSocket 的隐藏 WebView（label `sync`）。
//   每个活动便笺：hostDoc + HocuspocusProvider，全部挂同一个 HocuspocusProviderWebsocket。
//   本地通路：db:changed(local/import/ai) → note_updates_since → 应用（origin 'local-db'，debounce 1 s / maxWait 2 s，
//             推送前写 meta.bodyEditedAt）→ provider 发送。
//   远端通路：hostDoc updateV2（origin ≠ local-db）→ note_append_update(origin 'remote', projection) → db:changed。
//   收缩守卫：应用远端事务前后比较 body.toString()；命中 → note_version_save + 便笺级 error 状态。
//   房间：note:<ws>:<id>；信号房 inbox:<ws>（stateless bump / authz.revoked）。
import {
  applyUpdateV2,
  encodeStateV2,
  getBody,
  getMetaMap,
  openNoteDoc,
  readMeta,
} from "@bianfa/shared";
import { HocuspocusProvider, HocuspocusProviderWebsocket, WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";
import { fetchNotesSince } from "../api/notes.js";
import { buildProjection } from "../editor/projection.js";
import {
  authStatus,
  noteAppendUpdate,
  noteCreate,
  noteGet,
  noteLoadDoc,
  noteSetSynced,
  notesList,
  notesPendingSync,
  noteUpdatesSince,
  noteVersionSave,
  settingsGet,
  syncStateSetError,
} from "../ipc/commands.js";
import { isIpcError } from "../ipc/errors.js";
import { onAuthChanged, onDbChanged } from "../ipc/events.js";
import type { AuthStatus, DbChangedPayload, SyncErrCode } from "../ipc/types.js";
import { fromB64, toB64 } from "../lib/base64.js";
import { debounce } from "../lib/time.js";
import { useSyncStatusStore } from "./status-store.js";
import { getSyncToken, invalidateSyncToken } from "./token.js";
import { createNoteDoc } from "@bianfa/shared";

const LOCAL_DB = "local-db";
const HOST_META = "host-meta";
const IDLE_DESTROY_MS = 60_000;
const MAX_PROVIDERS = 64;
const PING_MS = 25_000;
const OFFLINE_POLL_MS = 30_000;
const AWARENESS_MIN_INTERVAL_MS = 500;
export const DEFAULT_SYNC_WS_URL = "wss://ws.bianfa.app/ws/v1";

export const documentName = (workspaceId: string, noteId: string) =>
  `note:${workspaceId.toLowerCase()}:${noteId.toLowerCase()}`;
export const inboxName = (workspaceId: string) => `inbox:${workspaceId.toLowerCase()}`;

/** 收缩守卫判据（specs/03 §3） */
export const shrinkGuardTripped = (before: string, after: string): boolean =>
  before.length > 200 && after.length < 0.7 * before.length;

interface NoteEntry {
  noteId: string;
  doc: Y.Doc;
  provider: HocuspocusProvider;
  appliedSeq: number;
  lastActivity: number;
  hasWindow: boolean;
  pending: boolean;
  pullLocal: ReturnType<typeof debounce<[]>>;
  beforeBody: string | null;
  beforeState: Uint8Array | null;
  lastAwarenessAt: number;
  chain: Promise<void>;
}

export class SyncHost {
  private socket: HocuspocusProviderWebsocket | null = null;
  private inbox: HocuspocusProvider | null = null;
  private entries = new Map<string, NoteEntry>();
  private auth: AuthStatus | null = null;
  private wsUrl = DEFAULT_SYNC_WS_URL;
  private authFailures = 0;
  private paused = false;
  private timers: number[] = [];
  private unlisten: Array<() => void> = [];
  private discoveryVersion = 0;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const settings = await settingsGet().catch(() => null);
    if (settings?.syncWsUrl) this.wsUrl = settings.syncWsUrl;
    if (!/\/ws\//.test(this.wsUrl)) this.wsUrl = DEFAULT_SYNC_WS_URL;
    this.unlisten.push(await onAuthChanged((a) => void this.onAuth(a)));
    this.unlisten.push(await onDbChanged((p) => this.onDbChanged(p)));
    await this.onAuth(await authStatus().catch(() => null));
  }

  stop(): void {
    for (const u of this.unlisten) u();
    this.unlisten = [];
    for (const t of this.timers) window.clearInterval(t);
    this.timers = [];
    for (const id of Array.from(this.entries.keys())) this.dropProvider(id);
    this.inbox?.destroy();
    this.inbox = null;
    this.socket?.destroy();
    this.socket = null;
    this.started = false;
  }

  private status = useSyncStatusStore.getState();

  private async onAuth(auth: AuthStatus | null): Promise<void> {
    this.auth = auth;
    if (!auth?.loggedIn || !auth.personalWorkspaceId) {
      this.status.setGlobal("local");
      for (const id of Array.from(this.entries.keys())) this.dropProvider(id);
      this.inbox?.destroy();
      this.inbox = null;
      this.socket?.destroy();
      this.socket = null;
      return;
    }
    invalidateSyncToken();
    this.authFailures = 0;
    this.paused = false;
    this.ensureSocket();
    this.ensureInbox(auth.personalWorkspaceId);
    await this.refreshTargets();
    void this.discover(auth.personalWorkspaceId);
    if (this.timers.length === 0) {
      this.timers.push(window.setInterval(() => this.tick(), 10_000));
      this.timers.push(window.setInterval(() => this.ping(), PING_MS));
      this.timers.push(window.setInterval(() => this.pollWhenOffline(), OFFLINE_POLL_MS));
    }
  }

  private ensureSocket(): HocuspocusProviderWebsocket {
    if (this.socket) return this.socket;
    this.socket = new HocuspocusProviderWebsocket({
      url: this.wsUrl,
      // full jitter：random() * min(60 s, 1 s × 2^min(attempt, 6))
      delay: 1000,
      factor: 2,
      maxDelay: 60_000,
      minDelay: 0,
      jitter: true,
      maxAttempts: 0,
      messageReconnectTimeout: 60_000,
      onStatus: ({ status }) => this.onSocketStatus(status),
    });
    return this.socket;
  }

  private onSocketStatus(status: WebSocketStatus): void {
    if (status === WebSocketStatus.Connected) {
      this.status.setGlobal(this.paused ? "error" : "syncing");
      for (const e of this.entries.values()) this.recomputeNoteState(e);
      if (this.auth?.personalWorkspaceId) void this.discover(this.auth.personalWorkspaceId);
    } else if (status === WebSocketStatus.Disconnected) {
      this.status.setGlobal("offline", this.paused ? "needs-auth" : undefined);
    }
  }

  private ensureInbox(workspaceId: string): void {
    if (this.inbox) return;
    this.inbox = new HocuspocusProvider({
      websocketProvider: this.ensureSocket(),
      name: inboxName(workspaceId),
      document: new Y.Doc(),
      token: () => getSyncToken(),
      onStateless: ({ payload }) => this.onStateless(payload),
      onAuthenticationFailed: ({ reason }) => this.onAuthFailed(reason, null),
    });
  }

  private onStateless(payload: string): void {
    let msg: { t?: string; workspace_id?: string; note_id?: string; version?: number };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (msg.t === "bump" && msg.workspace_id) void this.discover(msg.workspace_id);
    else if (msg.t === "authz.revoked" && msg.note_id) void this.onRevoked(msg.note_id);
  }

  /** 便笺发现（specs/03 §2.6）：union，绝不本地删除 */
  private discovering = false;
  private async discover(workspaceId: string): Promise<void> {
    if (this.discovering || this.paused || !this.auth?.loggedIn) return;
    this.discovering = true;
    try {
      let since = this.discoveryVersion;
      for (let page = 0; page < 20; page += 1) {
        const res = await fetchNotesSince(workspaceId, since);
        for (const n of res.notes) {
          const local = await noteGet(n.id).catch((err) => (isIpcError(err) && err.code === "not_found" ? null : err));
          if (local === null) {
            const doc = createNoteDoc(n.id, {
              meta: { color: n.color, zMode: n.zMode, createdAt: n.createdAt, updatedAt: n.updatedAt, deletedAt: n.deletedAt },
              origin: "remote",
            });
            await noteCreate({
              noteId: n.id,
              updateV2B64: toB64(encodeStateV2(doc)),
              projection: buildProjection(doc),
              workspaceId,
            }).catch(() => undefined);
            doc.destroy();
          }
          await this.ensureProvider(n.id, { pending: true });
        }
        since = res.nextVersion ?? since;
        if (res.notes.length < 500) break;
      }
      this.discoveryVersion = since;
    } catch (err) {
      if (isIpcError(err) && err.code === "upgrade_required") this.pause("upgrade-required");
    } finally {
      this.discovering = false;
    }
  }

  private pause(reason: string): void {
    this.paused = true;
    this.status.setGlobal("error", reason);
  }

  private async onRevoked(noteId: string): Promise<void> {
    this.dropProvider(noteId);
    const rec = await noteGet(noteId).catch(() => null);
    const owned = rec?.workspaceId === null || rec?.workspaceId === this.auth?.personalWorkspaceId;
    await syncStateSetError({ noteId, errCode: "forbidden", message: owned ? "revoked" : "lost-access" }).catch(
      () => undefined,
    );
    this.status.setNote(noteId, "error", owned ? "forbidden" : `lost-access:${rec?.title ?? ""}`);
  }

  private onAuthFailed(reason: string, noteId: string | null): void {
    if (reason === "forbidden" && noteId) {
      void this.onRevoked(noteId);
      return;
    }
    if (reason === "gone" && noteId) {
      this.dropProvider(noteId);
      void syncStateSetError({ noteId, errCode: "gone" });
      this.status.setNote(noteId, "error", "gone");
      return;
    }
    // expired / bad_token：刷新 token 重连；连续 3 次 → 暂停并要求重新登录
    invalidateSyncToken();
    this.authFailures += 1;
    if (this.authFailures >= 3) {
      this.pause("needs-auth");
      this.socket?.disconnect();
      return;
    }
    window.setTimeout(() => this.socket?.connect(), 500 * this.authFailures);
  }

  /** 目标集合：有打开窗口的 + 待上传的 */
  private async refreshTargets(): Promise<void> {
    if (!this.auth?.loggedIn || this.paused) return;
    const [list, pending] = await Promise.all([
      notesList({ includeTrashed: true }).catch(() => []),
      notesPendingSync().catch(() => []),
    ]);
    const open = new Set(list.filter((n) => n.isOpen).map((n) => n.id));
    const pend = new Set(pending.map((p) => p.noteId));
    for (const id of new Set([...open, ...pend])) {
      await this.ensureProvider(id, { hasWindow: open.has(id), pending: pend.has(id) });
    }
    for (const e of this.entries.values()) {
      e.hasWindow = open.has(e.noteId);
      if (!pend.has(e.noteId) && e.provider.isSynced && !e.provider.hasUnsyncedChanges) e.pending = false;
    }
  }

  private async ensureProvider(noteId: string, flags: { hasWindow?: boolean; pending?: boolean }): Promise<void> {
    const existing = this.entries.get(noteId);
    if (existing) {
      if (flags.hasWindow !== undefined) existing.hasWindow = flags.hasWindow;
      if (flags.pending) existing.pending = true;
      existing.lastActivity = Date.now();
      return;
    }
    if (this.entries.size >= MAX_PROVIDERS) this.evictIdle();
    if (this.entries.size >= MAX_PROVIDERS) return;
    const workspaceId = this.auth?.personalWorkspaceId;
    if (!workspaceId) return;
    const bundle = await noteLoadDoc(noteId).catch(() => null);
    if (!bundle) return;
    const updates: Uint8Array[] = [];
    if (bundle.snapshotB64) updates.push(fromB64(bundle.snapshotB64));
    for (const u of bundle.updatesB64) updates.push(fromB64(u));
    const doc = openNoteDoc(noteId, updates, LOCAL_DB);

    const entry: NoteEntry = {
      noteId,
      doc,
      provider: null as unknown as HocuspocusProvider,
      appliedSeq: bundle.headSeq,
      lastActivity: Date.now(),
      hasWindow: flags.hasWindow ?? false,
      pending: flags.pending ?? false,
      pullLocal: debounce(() => void this.pullLocal(noteId), 1000, 2000),
      beforeBody: null,
      beforeState: null,
      lastAwarenessAt: 0,
      chain: Promise.resolve(),
    };

    doc.on("beforeTransaction", (tr: Y.Transaction) => {
      if (tr.origin === LOCAL_DB || tr.origin === HOST_META) return;
      entry.beforeBody = getBody(doc).toString();
      entry.beforeState = entry.beforeBody.length > 200 ? encodeStateV2(doc) : null;
    });
    doc.on("afterTransaction", (tr: Y.Transaction) => {
      if (tr.origin === LOCAL_DB || tr.origin === HOST_META) return;
      const before = entry.beforeBody;
      entry.beforeBody = null;
      if (before === null) return;
      const after = getBody(doc).toString();
      if (shrinkGuardTripped(before, after) && entry.beforeState) {
        const state = entry.beforeState;
        entry.beforeState = null;
        void noteVersionSave({ noteId, stateV2B64: toB64(state), label: "shrink_guard" })
          .then(({ id }) => this.status.setNote(noteId, "error", `shrink_guard:${id}`))
          .catch(() => this.status.setNote(noteId, "error", "shrink_guard"));
      }
      // 编辑胜（specs/03 §3）：合并后 bodyEditedAt > deletedAt → 撤销删除
      const meta = readMeta(doc);
      const bodyEditedAt = getMetaMap(doc).get("bodyEditedAt");
      if (meta.deletedAt !== null && typeof bodyEditedAt === "number" && bodyEditedAt > meta.deletedAt) {
        doc.transact(() => {
          getMetaMap(doc).set("deletedAt", null);
        }, HOST_META);
        this.status.setNote(noteId, "syncing", "restored-by-edit");
      }
    });
    doc.on("updateV2", (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL_DB) return;
      const ipcOrigin = origin === HOST_META ? "local" : "remote";
      entry.chain = entry.chain.then(async () => {
        const res = await noteAppendUpdate({
          noteId,
          updateV2B64: toB64(update),
          origin: ipcOrigin,
          projection: buildProjection(doc),
        }).catch(() => null);
        if (res) entry.appliedSeq = Math.max(entry.appliedSeq, res.seq);
      });
    });

    entry.provider = new HocuspocusProvider({
      websocketProvider: this.ensureSocket(),
      name: documentName(workspaceId, noteId),
      document: doc,
      token: () => getSyncToken(),
      onAuthenticationFailed: ({ reason }) => this.onAuthFailed(reason, noteId),
      onSynced: () => this.onNoteSynced(entry),
      onStatus: () => this.recomputeNoteState(entry),
      onAwarenessUpdate: () => undefined,
    });
    entry.provider.on("unsyncedChanges", () => this.recomputeNoteState(entry));
    this.setAwareness(entry, false);
    this.entries.set(noteId, entry);
    this.recomputeNoteState(entry);
  }

  private setAwareness(entry: NoteEntry, editing: boolean): void {
    const now = Date.now();
    if (now - entry.lastAwarenessAt < AWARENESS_MIN_INTERVAL_MS) return;
    entry.lastAwarenessAt = now;
    const user = this.auth?.user;
    if (!user) return;
    entry.provider.setAwarenessField("user", {
      userId: user.id,
      name: user.name ?? user.email,
      color: readMeta(entry.doc).color,
      editing,
    });
  }

  private onNoteSynced(entry: NoteEntry): void {
    if (entry.provider.isSynced && !entry.provider.hasUnsyncedChanges) {
      entry.pending = false;
      void noteSetSynced(entry.noteId, entry.appliedSeq).catch(() => undefined);
      void syncStateSetError({ noteId: entry.noteId, errCode: null }).catch(() => undefined);
    }
    this.recomputeNoteState(entry);
  }

  private recomputeNoteState(entry: NoteEntry): void {
    const current = useSyncStatusStore.getState().notes[entry.noteId];
    if (current?.state === "error" && current.detail?.startsWith("shrink_guard")) return;
    if (!this.socket || this.socket.status !== WebSocketStatus.Connected) {
      this.status.setNote(entry.noteId, "offline");
      return;
    }
    const busy = !entry.provider.isSynced || entry.provider.hasUnsyncedChanges || entry.pending;
    this.status.setNote(entry.noteId, busy ? "syncing" : "synced");
    const anyBusy = Array.from(this.entries.values()).some(
      (e) => !e.provider.isSynced || e.provider.hasUnsyncedChanges || e.pending,
    );
    this.status.setGlobal(anyBusy ? "syncing" : "synced");
  }

  private onDbChanged(p: DbChangedPayload): void {
    if (!this.auth?.loggedIn) return;
    if (p.tables.includes("note_window_state") || p.tables.includes("sync_state")) void this.refreshTargets();
    if (p.origin === "remote" || p.origin === "system") return;
    for (const id of p.ids) {
      const entry = this.entries.get(id);
      if (entry) {
        entry.lastActivity = Date.now();
        entry.pending = true;
        entry.pullLocal();
        this.setAwareness(entry, true);
      } else if (p.tables.includes("notes") || p.tables.includes("ydoc_updates")) {
        void this.ensureProvider(id, { pending: true }).then(() => this.entries.get(id)?.pullLocal());
      }
    }
  }

  /** 本地 → 网络：把 seq > appliedSeq 的 updates 应用到 hostDoc（provider 自动发送） */
  private async pullLocal(noteId: string): Promise<void> {
    const entry = this.entries.get(noteId);
    if (!entry) return;
    await (entry.chain = entry.chain.then(async () => {
      const res = await noteUpdatesSince(noteId, entry.appliedSeq).catch(() => null);
      if (!res) return;
      if (res.updatesB64.length > 0) {
        entry.doc.transact(() => {
          for (const u of res.updatesB64) applyUpdateV2(entry.doc, fromB64(u), LOCAL_DB);
        }, LOCAL_DB);
        entry.doc.transact(() => {
          getMetaMap(entry.doc).set("bodyEditedAt", Date.now());
        }, HOST_META);
      }
      entry.appliedSeq = Math.max(entry.appliedSeq, res.headSeq);
      this.recomputeNoteState(entry);
    }));
  }

  private dropProvider(noteId: string): void {
    const entry = this.entries.get(noteId);
    if (!entry) return;
    entry.pullLocal.cancel();
    entry.provider.destroy();
    entry.doc.destroy();
    this.entries.delete(noteId);
    useSyncStatusStore.getState().clearNote(noteId);
  }

  private evictIdle(): void {
    const idle = Array.from(this.entries.values())
      .filter((e) => !e.hasWindow && !e.pending)
      .sort((a, b) => a.lastActivity - b.lastActivity);
    const victim = idle[0];
    if (victim) this.dropProvider(victim.noteId);
  }

  private tick(): void {
    const now = Date.now();
    for (const e of Array.from(this.entries.values())) {
      const idle = !e.hasWindow && !e.pending && e.provider.isSynced && !e.provider.hasUnsyncedChanges;
      if (idle && now - e.lastActivity > IDLE_DESTROY_MS) this.dropProvider(e.noteId);
    }
  }

  private ping(): void {
    if (this.socket?.status === WebSocketStatus.Connected) this.inbox?.sendStateless(JSON.stringify({ t: "ping" }));
  }

  private pollWhenOffline(): void {
    if (this.socket && this.socket.status !== WebSocketStatus.Connected && !this.paused) {
      void this.socket.connect();
    }
  }

  /** 设置页「立即同步」：强制所有 provider 对账 */
  forceSync(): void {
    for (const e of this.entries.values()) e.provider.forceSync();
  }

  /** 供 UI 显示 */
  get pendingCount(): number {
    return Array.from(this.entries.values()).filter((e) => e.pending || e.provider.hasUnsyncedChanges).length;
  }

  markError(noteId: string, code: SyncErrCode): void {
    this.status.setNote(noteId, "error", code);
  }
}
