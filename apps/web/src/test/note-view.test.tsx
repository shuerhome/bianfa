// 编辑器页的三条死线。每一条都被一次对抗性评审确认过，而且三条的失败方式都是**静默**的：
//   ① 只读连接必须锁住编辑器。服务端对只读连接的更新是直接丢弃、不回错的，
//      不锁的话 viewer 打半天字一个都没存上，界面上还一直是"已同步"。
//   ② 第一次同步完成之前也必须锁住。那时本地是一份空文档，敲进去的字之后会和
//      服务端来的正文合并到一个说不清的位置。
//   ③ 会话必须在同一个 effect 里建和拆。StrictMode 下 React 会 render 两次、
//      跑 effect、清理、再跑一次——useMemo 建、useEffect 拆的写法会把组件正在用的那份
//      会话销毁掉，编辑器于是绑在一个 destroy 过的 Y.Doc 上。
import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { WebNote } from "../notes-api.js";
import { NoteView } from "../pages/NoteView.js";
import type { NoteSession, SyncState } from "../sync/session.js";

const opened: Array<{ session: FakeSession; destroyed: boolean }> = [];

class FakeSession implements NoteSession {
  doc = new Y.Doc();
  undoManager: NoteSession["undoManager"];
  destroyed = false;
  touched = 0;
  private listeners = new Set<() => void>();
  private state: SyncState = {
    synced: false,
    everSynced: false,
    scopeKnown: false,
    saving: false,
    editable: false,
    connected: false,
    failure: null,
  };
  constructor() {
    this.undoManager = new Y.UndoManager(this.doc.getXmlFragment("body"));
  }
  getState = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  touch = () => {
    this.touched += 1;
  };
  destroy = () => {
    this.destroyed = true;
  };
  set(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

vi.mock("../sync/session.js", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    openNoteSession: () => {
      const s = new FakeSession();
      opened.push({ session: s, destroyed: false });
      return s;
    },
  };
});

const NOTE: WebNote = {
  id: "n1",
  workspace_id: "w1",
  title: "购物清单",
  excerpt: "",
  color: "amber",
  pinned: false,
  head_seq: 1,
  version: 1,
  encryption: "server",
  created_at: null,
  updated_at: null,
  deleted_at: null,
  purged_at: null,
  archived_at: null,
};

function view() {
  return (
    <StrictMode>
      <NoteView note={NOTE} userId="u1" userName="林" backTo="/notes?ws=w1" />
    </StrictMode>
  );
}

/** 组件当前实际在用的那个会话（最后一个没被销毁的） */
function live(): FakeSession | undefined {
  return [...opened].reverse().find((o) => !o.session.destroyed)?.session;
}

beforeEach(() => {
  opened.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("NoteView 的会话生命周期（StrictMode）", () => {
  it("③ StrictMode 下组件手里那份会话没有被销毁", async () => {
    render(view());
    await waitFor(() => expect(live()).toBeDefined());
    const s = live();
    if (!s) throw new Error("组件没有一个活着的会话——StrictMode 把它用的那份销毁了");
    expect(s.destroyed).toBe(false);
  });

  it("③ 卸载时会话被销毁，一个都不剩", async () => {
    const r = render(view());
    await waitFor(() => expect(live()).toBeDefined());
    r.unmount();
    expect(opened.every((o) => o.session.destroyed)).toBe(true);
  });
});

describe("NoteView 的可编辑判定", () => {
  async function mounted() {
    render(view());
    await waitFor(() => expect(live()).toBeDefined());
    const s = live();
    if (!s) throw new Error("no session");
    await waitFor(() => expect(document.querySelector(".bf-prose")).toBeTruthy());
    return s;
  }

  function editable(): boolean {
    return document.querySelector(".bf-prose")?.getAttribute("contenteditable") === "true";
  }

  it("② 第一次同步完成之前不能编辑", async () => {
    await mounted();
    expect(editable()).toBe(false);
  });

  it("① 服务端说只读 → 不能编辑，而且要说明白", async () => {
    const s = await mounted();
    s.set({ synced: true, everSynced: true, scopeKnown: true, editable: false });
    await waitFor(() => expect(screen.getByText(/只有查看权限/)).toBeTruthy());
    expect(editable()).toBe(false);
  });

  it("同步完成且服务端说可写 → 才放开编辑", async () => {
    const s = await mounted();
    s.set({ synced: true, everSynced: true, scopeKnown: true, editable: true });
    await waitFor(() => expect(editable()).toBe(true));
  });

  it("同步过一次之后掉线，仍然可以继续编辑（Yjs 会在重连时合并）", async () => {
    const s = await mounted();
    s.set({ synced: true, everSynced: true, scopeKnown: true, editable: true });
    await waitFor(() => expect(editable()).toBe(true));
    s.set({ synced: false, connected: false });
    expect(editable()).toBe(true);
  });

  it("放开编辑这件事本身不算一次编辑（不能把 updatedAt 改掉）", async () => {
    const s = await mounted();
    const before = s.touched;
    s.set({ synced: true, everSynced: true, scopeKnown: true, editable: true });
    await waitFor(() => expect(editable()).toBe(true));
    expect(s.touched).toBe(before);
  });
});
