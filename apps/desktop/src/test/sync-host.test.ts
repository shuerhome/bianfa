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
  onAuthenticationFailed?: ((p: { reason: string }) => void) | undefined;
  onStateless?: ((p: { payload: string }) => void) | undefined;
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
    hasUnsyncedChanges = false;
    destroyed = false;
    name: string;
    onAuthenticationFailed: ProviderStub["onAuthenticationFailed"];
    onStateless: ProviderStub["onStateless"];
    constructor(cfg: {
      name: string;
      onAuthenticationFailed?: ProviderStub["onAuthenticationFailed"];
      onStateless?: ProviderStub["onStateless"];
    }) {
      this.name = cfg.name;
      this.onAuthenticationFailed = cfg.onAuthenticationFailed;
      this.onStateless = cfg.onStateless;
      hoisted.providers.push(this);
    }
    on() {}
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
});
