// sync host 发现（specs/03 §2.6 的团队 / 共享扩展）：mock Rust（note_* / api_request）与 @hocuspocus/provider。
//   1. 团队工作区、共享给我的便笺建本地行时带自己的 workspace_id；provider 订的是该工作区的房间，不是个人房间；
//      发现与 db:changed 同时要求建同一张时只建一个 provider。
//   2. 共享给我按 share_id 记水位：再次发现只拉第一页、不再逐条 note_get / note_create。
//   3. forbidden：只记一次 sync_state 错误，sync_state 变更触发的 refreshTargets 不会重订；服务端再列出后才重订。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthStatus, NoteRecord } from "../ipc/types.js";
import { documentName, inboxName, SyncHost } from "../sync/host.js";
import { emitTestEvent, mockCommand, resetCommands } from "./setup.js";

interface ProviderStub {
  name: string;
  destroyed: boolean;
  isSynced: boolean;
  hasUnsyncedChanges: boolean;
  onAuthenticationFailed?: ((p: { reason: string }) => void) | undefined;
  onStateless?: ((p: { payload: string }) => void) | undefined;
  /** 用例用它模拟「服务端回了 SyncStep2、握手完成」 */
  onSynced?: (() => void) | undefined;
  /** 用例用它模拟 provider 自己 emit 的事件（目前只有 unsyncedChanges） */
  emitTest(event: string): void;
  /** 共享 socket 时必须由我们显式 attach，见下面那条回归用例 */
  attached?: boolean;
}

const hoisted = vi.hoisted(() => ({ providers: [] as ProviderStub[] }));

vi.mock("@hocuspocus/provider", () => {
  class HocuspocusProviderWebsocket {
    status = "connected";
    destroy() {}
    connect() {}
    disconnect() {}
  }
  class HocuspocusProvider implements ProviderStub {
    isSynced = false;
    // 和真实实现对齐：attach 后 startSync() 里的 resetUnsyncedChanges() 会先把计数置成 1，
    // 本地那份改动要等服务端单独回一条 SyncStatus 才归零。
    hasUnsyncedChanges = true;
    destroyed = false;
    attached = false;
    name: string;
    onAuthenticationFailed: ProviderStub["onAuthenticationFailed"];
    onStateless: ProviderStub["onStateless"];
    onSynced: ProviderStub["onSynced"];
    private listeners = new Map<string, Set<() => void>>();
    constructor(cfg: {
      name: string;
      onAuthenticationFailed?: ProviderStub["onAuthenticationFailed"];
      onStateless?: ProviderStub["onStateless"];
      onSynced?: ProviderStub["onSynced"];
    }) {
      this.name = cfg.name;
      this.onAuthenticationFailed = cfg.onAuthenticationFailed;
      this.onStateless = cfg.onStateless;
      this.onSynced = cfg.onSynced;
      hoisted.providers.push(this);
    }
    attach() {
      this.attached = true;
    }
    detach() {
      this.attached = false;
    }
    on(event: string, fn: () => void) {
      const set = this.listeners.get(event) ?? new Set();
      set.add(fn);
      this.listeners.set(event, set);
    }
    emitTest(event: string) {
      for (const fn of this.listeners.get(event) ?? []) fn();
    }
    setAwarenessField() {}
    forceSync() {}
    sendStateless() {}
    destroy() {
      this.destroyed = true;
    }
  }
  return {
    HocuspocusProvider,
    HocuspocusProviderWebsocket,
    WebSocketStatus: { Connecting: "connecting", Connected: "connected", Disconnected: "disconnected" },
  };
});

const PERSONAL = "019a0000-0000-7000-8000-00000000aa01";
const TEAM = "019a0000-0000-7000-8000-00000000aa02";
/** 共享者自己的工作区：共享给我的便笺留在那里 */
const OTHER = "019a0000-0000-7000-8000-00000000aa03";
const P1 = "019a0000-0000-7000-8000-00000000c001";
const T1 = "019a0000-0000-7000-8000-00000000c002";
const S1 = "019a0000-0000-7000-8000-00000000c003";
const SHARE1 = "019a0000-0000-7000-8000-00000000d001";

const AUTH: AuthStatus = {
  loggedIn: true,
  user: { id: "u1", email: "me@x.io", name: "我", image: null },
  deviceId: "d1",
  personalWorkspaceId: PERSONAL,
  activeOrganizationId: null,
  plan: "team",
};

const ISO = "2026-01-01T00:00:00.000Z";
const remoteNote = (id: string, workspaceId: string, version: number) => ({
  id,
  workspace_id: workspaceId,
  created_by: "u1",
  title: "",
  excerpt: "",
  color: "amber",
  z_mode: 0,
  pinned: false,
  schema_version: 1,
  head_seq: 1,
  projected_seq: 1,
  crdt_bytes: 10,
  version,
  encryption: "none",
  created_at: ISO,
  updated_at: ISO,
  deleted_at: null,
  purge_after: null,
  purged_at: null,
  expires_at: null,
  archived_at: null,
  import_source: null,
  import_external_id: null,
});
const workspace = (id: string, kind: "personal" | "team", orgId: string | null) => ({
  id,
  kind,
  org_id: orgId,
  team_id: null,
  owner_user_id: kind === "personal" ? "u1" : null,
  name: kind,
  default_note_perm: "editor",
  effective_perm: "editor",
  created_at: ISO,
  archived_at: null,
});
const sharedItem = (shareId: string, noteId: string, workspaceId: string) => ({
  share_id: shareId,
  note_id: noteId,
  workspace_id: workspaceId,
  title: "对方的便笺",
  color: "teal",
  z_mode: 0,
  permission: "viewer",
  shared_by: { user_id: "u2", name: "小王" },
  shared_at: ISO,
  expires_at: null,
  updated_at: ISO,
  version: 3,
  pinned: false,
});

/** 内存版 Rust 本地库 */
const rows = new Map<string, NoteRecord>();
const created: Array<{ noteId: string; workspaceId: string | null }> = [];
const noteGetCalls: string[] = [];
const syncErrors: Array<{ noteId: string; errCode: string | null }> = [];
const apiCalls: Array<{ method: string; path: string }> = [];
/** 服务端侧可变状态：团队便笺的 lsn（改大 = 服务端有人编辑过，下次发现会再列出） */
const server = { teamVersion: 7 };

function installDb() {
  mockCommand("settings_get", () => ({}));
  mockCommand("auth_status", () => AUTH);
  mockCommand("auth_sync_token", () => ({ token: "t", expiresAt: Date.now() + 60_000 }));
  mockCommand("attachments_pending_upload", () => []);
  mockCommand("notes_list", () => Array.from(rows.values()));
  mockCommand("notes_pending_sync", () =>
    // 和 Rust 一样：head_seq(1) > acked_seq(0) → 一直在 pending 里（mock provider 从不 synced）
    Array.from(rows.values()).map((r) => ({ noteId: r.id, headSeq: r.headSeq })),
  );
  mockCommand("note_get", (a) => {
    const id = a.noteId as string;
    noteGetCalls.push(id);
    const r = rows.get(id);
    if (!r) throw { code: "not_found", message: `no such note ${id}` };
    return r;
  });
  mockCommand("note_create", (a) => {
    const id = a.noteId as string;
    const workspaceId = (a.workspaceId as string | undefined) ?? null;
    created.push({ noteId: id, workspaceId });
    const rec: NoteRecord = {
      id,
      title: "",
      excerpt: "",
      color: "amber",
      zMode: 0,
      pinned: false,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      isOpen: false,
      synced: false,
      workspaceId,
      bodyHtml: "",
      schemaVersion: 1,
      headSeq: 1,
      contentText: "",
    };
    rows.set(id, rec);
    // Rust note_create 提交后 emit 的事件（origin local，tables 含 note_window_state → host 会 refreshTargets）
    emitTestEvent("db:changed", {
      rev: created.length,
      origin: "local",
      tables: ["notes", "ydoc_updates", "note_window_state"],
      ids: [id],
    });
    return rec;
  });
  mockCommand("note_load_doc", () => ({ snapshotB64: null, snapshotUptoSeq: 0, updatesB64: [], headSeq: 1 }));
  mockCommand("note_updates_since", () => ({ updatesB64: [], headSeq: 1 }));
  mockCommand("note_set_synced", () => undefined);
  mockCommand("sync_state_set_error", (a) => {
    const noteId = a.noteId as string;
    syncErrors.push({ noteId, errCode: (a.errCode as string | null | undefined) ?? null });
    // Rust sync_state_set_error 的 emit：origin system，tables [sync_state]
    emitTestEvent("db:changed", { rev: 0, origin: "system", tables: ["sync_state"], ids: [noteId] });
    return undefined;
  });
}

/** 内存版服务端：GET /v1/workspaces、GET /v1/notes?workspace_id&since_version、GET /v1/shared-with-me */
function installApi() {
  mockCommand("api_request", (a) => {
    const method = a.method as string;
    const url = new URL(`http://x${a.path as string}`);
    apiCalls.push({ method, path: url.pathname + url.search });
    const ok = (body: unknown) => ({ status: 200, headers: {}, bodyText: JSON.stringify(body) });
    if (url.pathname === "/v1/workspaces") {
      return ok({ workspaces: [workspace(PERSONAL, "personal", null), workspace(TEAM, "team", "org1")] });
    }
    if (url.pathname === "/v1/notes") {
      const wsId = url.searchParams.get("workspace_id");
      const since = Number(url.searchParams.get("since_version") ?? 0);
      const all =
        wsId === PERSONAL
          ? [remoteNote(P1, PERSONAL, 5)]
          : wsId === TEAM
            ? [remoteNote(T1, TEAM, server.teamVersion)]
            : [];
      const notes = all.filter((n) => n.version > since);
      return ok({
        workspace_id: wsId,
        effective_perm: "editor",
        notes,
        next_version: Math.max(since, ...all.map((n) => n.version)),
        has_more: false,
      });
    }
    if (url.pathname === "/v1/shared-with-me") {
      return ok({ items: [sharedItem(SHARE1, S1, OTHER)], next_cursor: null });
    }
    return { status: 404, headers: {}, bodyText: JSON.stringify({ error: "not_found" }) };
  });
}

const flush = () => new Promise((r) => setTimeout(r, 25));
const providersNamed = (name: string) => hoisted.providers.filter((p) => p.name === name);
const inboxOf = (workspaceId: string) => {
  const inbox = hoisted.providers.find((p) => p.name === inboxName(workspaceId));
  if (!inbox?.onStateless) throw new Error("inbox provider 未建立");
  return inbox;
};
const sharedCalls = () => apiCalls.filter((c) => c.path.startsWith("/v1/shared-with-me")).length;

let host: SyncHost | null = null;

async function startHost(): Promise<SyncHost> {
  host = new SyncHost();
  await host.start();
  // 三张便笺都建了行、都有自己的 provider → 第一轮发现结束
  await vi.waitFor(() => {
    expect(created).toHaveLength(3);
    expect(providersNamed(documentName(PERSONAL, P1))).toHaveLength(1);
    expect(providersNamed(documentName(TEAM, T1))).toHaveLength(1);
    expect(providersNamed(documentName(OTHER, S1))).toHaveLength(1);
  });
  await flush();
  return host;
}

describe("SyncHost 发现：团队工作区 / 共享给我", () => {
  beforeEach(() => {
    resetCommands();
    rows.clear();
    created.length = 0;
    noteGetCalls.length = 0;
    syncErrors.length = 0;
    apiCalls.length = 0;
    hoisted.providers.length = 0;
    server.teamVersion = 7;
    installDb();
    installApi();
  });
  afterEach(() => {
    host?.stop();
    host = null;
  });

  it("本地行带各自的 workspace_id；provider 订各自工作区的房间，不订个人房间；同一张只建一个 provider", async () => {
    await startHost();

    expect(created.find((c) => c.noteId === P1)?.workspaceId).toBe(PERSONAL);
    expect(created.find((c) => c.noteId === T1)?.workspaceId).toBe(TEAM);
    expect(created.find((c) => c.noteId === S1)?.workspaceId).toBe(OTHER);

    const names = hoisted.providers.map((p) => p.name);
    expect(names).toContain(inboxName(PERSONAL));
    expect(names).not.toContain(documentName(PERSONAL, T1));
    expect(names).not.toContain(documentName(PERSONAL, S1));
    // 发现（ensureProvider）与 note_create 的 db:changed（refreshTargets / onDbChanged）同时到，也只建一个
    for (const room of [documentName(PERSONAL, P1), documentName(TEAM, T1), documentName(OTHER, S1)]) {
      expect(providersNamed(room)).toHaveLength(1);
    }
  });

  it("共享给我按 share_id 记水位：再次发现只拉第一页，不再逐条 note_get / note_create", async () => {
    await startHost();
    expect(sharedCalls()).toBe(1);
    const noteGetsBefore = noteGetCalls.filter((id) => id === S1).length;

    // 重连 / bump 个人工作区 → 再跑一轮 discover(personal)
    inboxOf(PERSONAL).onStateless?.({ payload: JSON.stringify({ t: "bump", workspace_id: PERSONAL }) });
    await vi.waitFor(() => expect(sharedCalls()).toBe(2));
    await flush();

    expect(noteGetCalls.filter((id) => id === S1)).toHaveLength(noteGetsBefore);
    expect(created).toHaveLength(3);
    expect(providersNamed(documentName(OTHER, S1))).toHaveLength(1);
  });

  it("forbidden：只记一次错、不因 sync_state 变更重订；服务端再列出这张便笺后才重订", async () => {
    await startHost();
    const first = providersNamed(documentName(TEAM, T1))[0];
    if (!first) throw new Error("T1 provider 未建立");

    first.onAuthenticationFailed?.({ reason: "forbidden" });
    await vi.waitFor(() => expect(syncErrors.filter((e) => e.noteId === T1)).toHaveLength(1));
    await flush();
    await flush();

    expect(first.destroyed).toBe(true);
    expect(syncErrors.filter((e) => e.noteId === T1)).toEqual([{ noteId: T1, errCode: "forbidden" }]);
    // pending_sync 里仍有 T1，但 sync_state 变更触发的 refreshTargets 没有重订
    expect(providersNamed(documentName(TEAM, T1))).toHaveLength(1);

    // 服务端再次列出（重新获得权限后有人编辑了它）→ 放出 denied，重订
    server.teamVersion = 8;
    inboxOf(PERSONAL).onStateless?.({ payload: JSON.stringify({ t: "bump", workspace_id: TEAM }) });
    await vi.waitFor(() => expect(providersNamed(documentName(TEAM, T1))).toHaveLength(2));
    expect(created).toHaveLength(3);
  });

  it("每个 provider 都必须 attach 到共享 socket 上（不 attach 就整个同步静默失效）", async () => {
    // HocuspocusProvider 的构造末尾是 `if (this.manageSocket) this.attach()`，而 manageSocket
    // 只有在**不传 websocketProvider**时才为 true。我们所有 provider 共用一条 socket，走的是
    // manageSocket=false 那一支，必须自己调 attach()。漏掉的后果不是报错，而是：socket 连得上、
    // 但 provider 从不注册到它上面 —— 不发鉴权消息、不收数据，服务端 connections/documents/
    // auth_failures 全是 0。线上就是这么静默地一条便笺都没同步上去的，所以这条用例钉住它。
    await startHost();
    expect(hoisted.providers.length).toBeGreaterThan(0);
    for (const p of hoisted.providers) {
      expect(p.attached, `${p.name} 没有 attach 到共享 socket`).toBe(true);
    }
  });
});

// 批量导入（把 Windows 便笺一次搬进来几百张）会让待同步队列远远超过通道上限。
// 上限本身没问题：一条 socket 上同时挂几百个文档，服务端 sync 侧的 MAX_DOCUMENTS_PER_SOCKET
// 同样是 64。问题在于「排在上限之外的那些」必须随着前面的同步完成被顶上来。
//
// 线上出过的事故就是这一条：导入 669 张、登录、然后服务端只收到 65 张，之后再也不动。
// 原因是重新选目标（refreshTargets）的每一个入口都要求「本地又发生了变更」——
// 而导入完的便笺没人会再去编辑，于是腾出来的位置永远没人来填。
describe("SyncHost 通道上限：待同步远多于上限时必须一批批排干", () => {
  /** 与 host.ts 的 MAX_PROVIDERS、服务端 sync 的 MAX_DOCUMENTS_PER_SOCKET 是同一个数 */
  const CAP = 64;
  const BULK = 100;
  const bulk = Array.from(
    { length: BULK },
    (_, i) => `019a0000-0000-7000-8000-0000000f${i.toString().padStart(4, "0")}`,
  );
  /** 本地库里已经 acked 的便笺（= 已经离开 notes_pending_sync 队列，等价于「传上去了」） */
  const acked = new Set<string>();

  const localRow = (id: string): NoteRecord => ({
    id,
    title: "",
    excerpt: "",
    color: "amber",
    zMode: 0,
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    isOpen: false,
    synced: acked.has(id),
    workspaceId: PERSONAL,
    bodyHtml: "",
    schemaVersion: 1,
    headSeq: 1,
    contentText: "",
  });

  /** 活着的便笺通道（收件箱不算） */
  const liveNoteProviders = () => hoisted.providers.filter((x) => !x.destroyed && x.name.startsWith("note:"));

  /**
   * 模拟服务端回 SyncStep2：握手完成。
   *
   * 注意这一刻 hasUnsyncedChanges **仍然是 true** —— 真实的 provider 在 startSync() 里就把
   * unsyncedChanges 置成了 1，本地那份改动要等下面 serverAckUpdates 那条消息才算数。
   * 这个顺序正是问题所在：只把「回写 acked_seq」挂在 onSynced 上，它永远不会执行。
   */
  function serverHandshake(): void {
    for (const x of liveNoteProviders()) {
      if (x.isSynced) continue;
      x.isSynced = true;
      x.onSynced?.();
    }
  }

  /** 模拟服务端回 SyncStatus(applied)：本地改动被确认，unsyncedChanges 归零并 emit */
  function serverAckUpdates(): void {
    for (const x of liveNoteProviders()) {
      if (!x.isSynced || !x.hasUnsyncedChanges) continue;
      x.hasUnsyncedChanges = false;
      x.emitTest("unsyncedChanges");
    }
  }

  beforeEach(() => {
    resetCommands();
    hoisted.providers.length = 0;
    acked.clear();
    vi.useFakeTimers();

    mockCommand("settings_get", () => ({}));
    mockCommand("auth_status", () => AUTH);
    mockCommand("auth_sync_token", () => ({ token: "t", expiresAt: Date.now() + 60_000 }));
    mockCommand("attachments_pending_upload", () => []);
    mockCommand("notes_list", () => bulk.map(localRow));
    // 和 Rust pending_sync 一样：head_seq > acked_seq 的才在队列里，note_set_synced 之后就出队
    mockCommand("notes_pending_sync", () =>
      bulk.filter((id) => !acked.has(id)).map((id) => ({ noteId: id, headSeq: 1 })),
    );
    mockCommand("note_get", (a) => localRow(a.noteId as string));
    mockCommand("note_load_doc", () => ({
      snapshotB64: null,
      snapshotUptoSeq: 0,
      updatesB64: [],
      headSeq: 1,
    }));
    mockCommand("note_updates_since", () => ({ updatesB64: [], headSeq: 1 }));
    mockCommand("note_set_synced", (a) => {
      const id = a.noteId as string;
      acked.add(id);
      // Rust note_set_synced 的 emit：origin system、tables [sync_state, notes]
      emitTestEvent("db:changed", { rev: 0, origin: "system", tables: ["sync_state", "notes"], ids: [id] });
      return undefined;
    });
    mockCommand("sync_state_set_error", () => undefined);
    // 发现这一侧不是这条用例的主题：只有个人工作区，服务端没有别人的便笺
    mockCommand("api_request", (a) => {
      const url = new URL(`http://x${a.path as string}`);
      const ok = (body: unknown) => ({ status: 200, headers: {}, bodyText: JSON.stringify(body) });
      if (url.pathname === "/v1/workspaces")
        return ok({ workspaces: [workspace(PERSONAL, "personal", null)] });
      if (url.pathname === "/v1/notes") {
        return ok({
          workspace_id: url.searchParams.get("workspace_id"),
          effective_perm: "editor",
          notes: [],
          next_version: 0,
          has_more: false,
        });
      }
      if (url.pathname === "/v1/shared-with-me") return ok({ items: [], next_cursor: null });
      return { status: 404, headers: {}, bodyText: JSON.stringify({ error: "not_found" }) };
    });
  });

  afterEach(() => {
    host?.stop();
    host = null;
    vi.useRealTimers();
  });

  it("先建满上限，前面的同步完成后必须自动补上剩下的（不能永远停在 64 张）", async () => {
    host = new SyncHost();
    await host.start();
    await vi.advanceTimersByTimeAsync(1);

    // 第一轮：上限就是上限，一张都不能超建
    expect(liveNoteProviders()).toHaveLength(CAP);
    expect(acked.size).toBe(0);

    // 之后不再有任何「本地变更」—— 导入完的便笺没人会去编辑它们。
    // 唯一还在跑的只有 10 秒一次的 tick，排干必须靠它。
    let peak = liveNoteProviders().length;
    for (let round = 0; round < 12 && acked.size < BULK; round += 1) {
      serverHandshake();
      serverAckUpdates();
      await vi.advanceTimersByTimeAsync(10_000);
      peak = Math.max(peak, liveNoteProviders().length);
    }

    expect(acked.size, `只传上去 ${acked.size}/${BULK} 张，剩下的再也没有被选中`).toBe(BULK);
    // 排干的过程里一次都没有突破上限（否则服务端会按 MAX_DOCUMENTS_PER_SOCKET 拒掉）
    expect(peak).toBeLessThanOrEqual(CAP);
  });
});
