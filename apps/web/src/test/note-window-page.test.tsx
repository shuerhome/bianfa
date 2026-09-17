// /note 这个独立窗口页面：它不经过列表，必须自己取单张便笺的元信息。
// 取不到就得说清楚是哪一种（没这张便笺 / 网络问题 / 加密打不开），不能白屏。
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteWindow } from "../pages/NoteWindow.js";

vi.mock("../auth-client.js", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "u1", email: "lin@example.com", name: "林", emailVerified: true } },
      isPending: false,
      refetch: async () => {},
    }),
  },
}));

// 编辑器整块换掉：这里测的是取数与分支，不是 TipTap
vi.mock("../pages/NoteView.js", () => ({
  NoteView: ({ note, backTo }: { note: { id: string }; backTo: string | null }) => (
    <div data-testid="note-view" data-note={note.id} data-back={String(backTo)} />
  ),
}));

const seen: string[] = [];

function mockApi(reply: (url: string) => { status: number; body: unknown }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    seen.push(url);
    const r = reply(url);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });
}

const NOTE = {
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

beforeEach(() => {
  seen.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("/note 独立窗口", () => {
  it("自己去取这张便笺（列表缓存在另一个窗口里，拿不到）", async () => {
    mockApi(() => ({ status: 200, body: { note: NOTE } }));
    render(<NoteWindow search="?ws=w1&note=n1" />);
    await waitFor(() => expect(screen.getByTestId("note-view")).toBeTruthy());
    expect(seen).toContain("/v1/notes/n1");
  });

  it("没有返回按钮：独立窗口里没有「回到列表」这回事，关窗口用浏览器自己的按钮", async () => {
    mockApi(() => ({ status: 200, body: { note: NOTE } }));
    render(<NoteWindow search="?ws=w1&note=n1" />);
    await waitFor(() => expect(screen.getByTestId("note-view")).toBeTruthy());
    expect(screen.getByTestId("note-view").getAttribute("data-back")).toBe("null");
  });

  it("便笺不存在（404）说「找不到」，不是白屏", async () => {
    mockApi(() => ({ status: 404, body: { error: "not_found" } }));
    render(<NoteWindow search="?ws=w1&note=nope" />);
    await waitFor(() => expect(screen.getByText("找不到这张便笺")).toBeTruthy());
  });

  it("E2EE 的便笺明确不给打开", async () => {
    mockApi(() => ({ status: 200, body: { note: { ...NOTE, encryption: "e2ee" } } }));
    render(<NoteWindow search="?ws=w1&note=n1" />);
    await waitFor(() => expect(screen.getByText("端到端加密，网页端暂不能查看")).toBeTruthy());
  });

  it("地址里没有 note 参数时不发请求，直接报错", async () => {
    mockApi(() => ({ status: 200, body: {} }));
    render(<NoteWindow search="?ws=w1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "重试" })).toBeTruthy());
    expect(seen.some((u) => u.startsWith("/v1/notes/"))).toBe(false);
  });
});
