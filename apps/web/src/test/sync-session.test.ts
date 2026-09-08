// 网页端同步会话。这里钉的每一条都对应一种"静默失败"——出问题时界面上什么都看不出来，
// 只有 Hocuspocus 的内部状态知道：
//   ① token 必须是函数：凭据只有 60 s，而 provider 每次开 socket 都会重新取。
//      写成字符串的话第一次能连上，之后每次重连都以 expired 失败。
//   ② 共享 socket 上的 provider 必须 attach()，否则一条消息都不发，而且不报错。
//   ③ awareness 的四个键必须是**顶层**（服务端只认 userId/name/color/editing，别的键删掉），
//      而且必须设——它是这条连接唯一的心跳，不设的话服务端 60 s 就把 socket 掐了。
//   ④ "正在保存"要看 isSynced && hasUnsyncedChanges，只看 synced 事件永远是 true。
//   ⑤ 只读连接的 unsyncedChanges 永远不归零（服务端回 SyncStatus(false)），
//      所以只读时不能显示"保存中"，否则是一个永远转不完的圈。
import type { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documentName, openNoteSession, type SessionFactory, syncUrlFromLocation } from "../sync/session.js";
import { resetSyncTokenCacheForTest } from "../sync/token.js";

type Handlers = Record<string, (payload: unknown) => void>;

class FakeProvider {
  isSynced = false;
  // 真实 provider 在 startSync() 里先把 unsyncedChanges 置成 1，所以刚连上时它必然是 true
  unsyncedChanges = 1;
  attached = false;
  destroyed = false;
  readonly awareness: Record<string, unknown> = {};
  readonly events = new Map<string, Array<() => void>>();
  readonly config: Record<string, unknown>;

  constructor(config: Record<string, unknown>) {
    this.config = config;
  }
  get hasUnsyncedChanges(): boolean {
    return this.unsyncedChanges > 0;
  }
  attach(): void {
    this.attached = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  setAwarenessField(key: string, value: unknown): void {
    this.awareness[key] = value;
  }
  on(event: string, fn: () => void): void {
    const list = this.events.get(event) ?? [];
    list.push(fn);
    this.events.set(event, list);
  }
  emit(event: string): void {
    for (const fn of this.events.get(event) ?? []) fn();
  }
  /** 触发构造时传进来的回调 */
  fire(name: string, payload: unknown = {}): void {
    const h = this.config as Handlers;
    const fn = h[name];
    if (typeof fn === "function") fn(payload);
  }
  /** 服务端握手完成（收到 SyncStep2）：synced 变 true，但 unsyncedChanges 还是 1 */
  serverHandshake(scope: "read-write" | "readonly" = "read-write"): void {
    this.fire("onStatus", { status: "connected" });
    this.fire("onAuthenticated", { scope });
    this.isSynced = true;
    this.fire("onSynced", {});
  }
  /** 服务端单独回的 SyncStatus(applied=true)：这才是"存好了" */
  serverAck(): void {
    this.unsyncedChanges = 0;
    this.emit("unsyncedChanges");
  }
}

let created: FakeProvider[] = [];
let released = 0;

const fakeSocket = { destroyed: false } as unknown as HocuspocusProviderWebsocket;

const factory: SessionFactory = {
  socket: () => fakeSocket,
  provider: (config) => {
    const p = new FakeProvider(config as unknown as Record<string, unknown>);
    created.push(p);
    return p as unknown as HocuspocusProvider;
  },
  release: () => {
    released += 1;
  },
};

function open(overrides: Partial<Parameters<typeof openNoteSession>[0]> = {}) {
  return openNoteSession({
    workspaceId: "0199B0F2-1111-7000-8000-000000000001",
    noteId: "0199B0F2-2222-7000-8000-000000000002",
    user: { id: "u1", name: "林" },
    color: "amber",
    factory,
    url: "wss://api.test/ws/v1",
    ...overrides,
  });
}

beforeEach(() => {
  created = [];
  released = 0;
  resetSyncTokenCacheForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("房间名与地址推导", () => {
  it("房间名与桌面端逐字一致，且全小写", () => {
    expect(documentName("WS-A", "NOTE-B")).toBe("note:ws-a:note-b");
  });

  it("同步地址从页面地址推导（同源），https → wss", () => {
    expect(syncUrlFromLocation({ protocol: "https:", host: "api.bianfa.app" })).toBe(
      "wss://api.bianfa.app/ws/v1",
    );
    expect(syncUrlFromLocation({ protocol: "http:", host: "127.0.0.1:5173" })).toBe(
      "ws://127.0.0.1:5173/ws/v1",
    );
  });
});

describe("openNoteSession", () => {
  it("① token 传的是函数，不是字符串", () => {
    open();
    expect(typeof created[0]?.config.token).toBe("function");
  });

  it("② 共享 socket 上显式 attach()", () => {
    open();
    expect(created[0]?.attached).toBe(true);
  });

  it("③ awareness 的四个键设在顶层（套一层 user 会被服务端整个删掉）", () => {
    open();
    expect(created[0]?.awareness).toEqual({
      userId: "u1",
      name: "林",
      color: "amber",
      editing: false,
    });
    expect(created[0]?.awareness.user).toBeUndefined();
  });

  it("④ 握手完成还不算存好：synced 为真但仍在保存中", () => {
    const s = open();
    const p = created[0];
    if (!p) throw new Error("no provider");
    p.serverHandshake();
    expect(s.getState().synced).toBe(true);
    expect(s.getState().saving).toBe(true);
    p.serverAck();
    expect(s.getState().saving).toBe(false);
  });

  it("⑤ 只读连接不显示保存中（它的 unsyncedChanges 永远不归零）", () => {
    const s = open();
    const p = created[0];
    if (!p) throw new Error("no provider");
    p.serverHandshake("readonly");
    expect(s.getState().editable).toBe(false);
    expect(s.getState().saving).toBe(false);
  });

  it("scope 决定能不能编辑，而不是同步计数", () => {
    const s = open();
    created[0]?.serverHandshake("read-write");
    expect(s.getState().editable).toBe(true);
  });

  it("权限被收回 / 便笺被删：文档级关闭帧只有 reason，没有 code", () => {
    const revoked = open();
    created[0]?.fire("onClose", { event: { code: 1000, reason: "authz_revoked" } });
    expect(revoked.getState().failure).toBe("forbidden");
    expect(revoked.getState().editable).toBe(false);

    const gone = open();
    created[1]?.fire("onClose", { event: { code: 1000, reason: "gone" } });
    expect(gone.getState().failure).toBe("gone");
  });

  it("握手就被拒（1006 没有原因）报成「连不上」，不是静默", () => {
    const s = open();
    created[0]?.fire("onClose", { event: { code: 1006 } });
    expect(s.getState().failure).toBe("offline");
  });

  it("连接数超限（4429）单独成一类，不混进通用断线", () => {
    const s = open();
    created[0]?.fire("onClose", { event: { code: 4429, reason: "too_many_connections" } });
    expect(s.getState().failure).toBe("too_many_connections");
  });

  it("forbidden / gone 是终态，不重试", () => {
    const s = open();
    created[0]?.fire("onAuthenticationFailed", { reason: "forbidden" });
    expect(s.getState().failure).toBe("forbidden");
  });

  it("expired 连续三次才认输，前两次只是换凭据重试", () => {
    const s = open();
    const p = created[0];
    if (!p) throw new Error("no provider");
    p.fire("onAuthenticationFailed", { reason: "expired" });
    expect(s.getState().failure).toBeNull();
    p.fire("onAuthenticationFailed", { reason: "expired" });
    expect(s.getState().failure).toBeNull();
    p.fire("onAuthenticationFailed", { reason: "expired" });
    expect(s.getState().failure).toBe("stalled");
  });

  it("认证成功会把之前的失败计数清零", () => {
    const s = open();
    const p = created[0];
    if (!p) throw new Error("no provider");
    p.fire("onAuthenticationFailed", { reason: "expired" });
    p.fire("onAuthenticationFailed", { reason: "expired" });
    p.serverHandshake();
    p.fire("onAuthenticationFailed", { reason: "expired" });
    expect(s.getState().failure).toBeNull();
  });

  it("取不到凭据（会话过期）报成「要重新登录」，而不是一个转不完的圈", () => {
    const s = open();
    created[0]?.fire("onAuthenticationFailed", {
      reason: "Failed to get token during sendToken(): Error: sync_token_unauthorized",
    });
    expect(s.getState().failure).toBe("unauthorized");
  });

  it("⑤ 拆的顺序：provider 先于 doc，socket 最后释放", () => {
    const s = open();
    const doc = s.doc;
    s.destroy();
    expect(created[0]?.destroyed).toBe(true);
    expect(doc.isDestroyed).toBe(true);
    expect(released).toBe(1);
  });

  it("destroy 之后再来的事件不会再改状态（防止组件卸载后 setState）", () => {
    const s = open();
    s.destroy();
    created[0]?.fire("onClose", { event: { code: 1006 } });
    expect(s.getState().failure).toBeNull();
  });

  it("touch() 把 updatedAt 与 bodyEditedAt 写进 meta（否则便笺会在列表里往下沉）", () => {
    const s = open();
    s.touch();
    const meta = s.doc.getMap("meta");
    expect(typeof meta.get("updatedAt")).toBe("number");
    expect(typeof meta.get("bodyEditedAt")).toBe("number");
  });

  it("touch() 两秒内只写一次，不给每个按键都发一条 CRDT 更新", () => {
    const s = open();
    s.touch();
    const first = s.doc.getMap("meta").get("updatedAt");
    s.touch();
    expect(s.doc.getMap("meta").get("updatedAt")).toBe(first);
  });

  it("everSynced 是闩锁：同步过一次之后掉线，仍然算「正文已经拿到」", () => {
    const s = open();
    const p = created[0];
    if (!p) throw new Error("no provider");
    expect(s.getState().everSynced).toBe(false);
    p.serverHandshake();
    expect(s.getState().everSynced).toBe(true);
    p.isSynced = false;
    p.fire("onStatus", { status: "disconnected" });
    expect(s.getState().synced).toBe(false);
    expect(s.getState().everSynced).toBe(true);
  });

  it("scopeKnown 分得清「还没答复」和「答复是只读」", () => {
    const s = open();
    expect(s.getState().scopeKnown).toBe(false);
    expect(s.getState().editable).toBe(false);
    created[0]?.serverHandshake("readonly");
    expect(s.getState().scopeKnown).toBe(true);
    expect(s.getState().editable).toBe(false);
  });

  it("开在一条已经连着的 socket 上时，一上来就是 connected（不会一直显示连接中）", () => {
    const connectedSocket = { status: "connected" } as unknown as HocuspocusProviderWebsocket;
    const s = openNoteSession({
      workspaceId: "ws",
      noteId: "n",
      user: { id: "u1", name: "林" },
      color: "amber",
      url: "wss://api.test/ws/v1",
      factory: { ...factory, socket: () => connectedSocket },
    });
    expect(s.getState().connected).toBe(true);
    s.destroy();
  });

  it("Y.Doc 的 guid 就是 noteId、gc 打开（与 shared 的 openNoteDoc 一致）", () => {
    const s = open();
    expect(s.doc.guid).toBe("0199B0F2-2222-7000-8000-000000000002");
    expect(s.doc.gc).toBe(true);
  });
});
