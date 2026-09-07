// 待办页：分组 / 勾选走 doc 路径（note_append_update 带翻转后的投影）/ 范围切换走服务端 / 角标随 db:changed 刷新。
import { encodeStateV2, type PMJson, prosemirrorJsonToNoteDoc } from "@bianfa/shared";
import { ToastProvider } from "@bianfa/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import i18next from "i18next";
import type { ReactNode } from "react";
import { initReactI18next } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RemoteTodoDto } from "../../../api/todos.js";
import zh from "../../../i18n/zh-Hans.json";
import type { AuthStatus, NoteProjection, TodoItem } from "../../../ipc/types.js";
import { toB64 } from "../../../lib/base64.js";
import { flipTaskItem } from "../../../lib/checklist.js";
import { emitTestEvent, invokeMock, mockCommand, resetCommands } from "../../../test/setup.js";
import { useDbInvalidation } from "../hooks.js";
import { TodosBadge } from "./TodosBadge.js";
import { TodosPanel } from "./TodosPanel.js";
import { filterBySegment, groupTodos } from "./todos-data.js";

const NOTE_A = "01920000-0000-7000-8000-00000000000a";
const NOTE_B = "01920000-0000-7000-8000-00000000000b";
const TEAM_WS = "019a0000-0000-7000-8000-00000000aa02";

const p = (text: string): PMJson => ({ type: "paragraph", content: [{ type: "text", text }] });
const noteADoc: PMJson = {
  type: "doc",
  content: [
    p("购物清单"),
    {
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: false, id: "aaaaaaaaaa" }, content: [p("鸡蛋")] },
        {
          type: "taskItem",
          attrs: { checked: false, id: "bbbbbbbbbb" },
          content: [
            p("牛奶"),
            {
              type: "taskList",
              content: [
                { type: "taskItem", attrs: { checked: true, id: "cccccccccc" }, content: [p("低脂")] },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function item(over: Partial<TodoItem>): TodoItem {
  return {
    noteId: NOTE_A,
    noteTitle: "购物清单",
    noteColor: "citron",
    workspaceId: null,
    blockId: "aaaaaaaaaa",
    text: "鸡蛋",
    checked: false,
    ordinal: 0,
    noteUpdatedAt: 2_000,
    itemUpdatedAt: 2_000,
    ...over,
  };
}

const LOCAL_ITEMS: TodoItem[] = [
  item({}),
  item({ blockId: "bbbbbbbbbb", text: "牛奶", ordinal: 1 }),
  item({
    noteId: NOTE_B,
    noteTitle: "会议",
    noteColor: "rose",
    blockId: "dddddddddd",
    text: "发纪要",
    ordinal: 0,
  }),
];

/** 内存版 Rust：note_load_doc 返回 noteADoc 的整状态；note_append_update 记录投影 */
function fakeNoteDb() {
  const appended: { noteId: string; origin: string; projection: NoteProjection }[] = [];
  mockCommand("note_load_doc", (args) => {
    if (args.noteId !== NOTE_A) throw { code: "not_found", message: "no such note" };
    const doc = prosemirrorJsonToNoteDoc(noteADoc, { noteId: NOTE_A });
    const state = toB64(encodeStateV2(doc));
    doc.destroy();
    return { snapshotB64: null, snapshotUptoSeq: 0, updatesB64: [state], headSeq: 1 };
  });
  mockCommand("note_append_update", (args) => {
    appended.push(args as unknown as (typeof appended)[number]);
    return { seq: appended.length + 1 };
  });
  return appended;
}

type ApiReq = { method: string; path: string };
function mockApi(handler: (req: ApiReq) => unknown) {
  const calls: ApiReq[] = [];
  mockCommand("api_request", (args) => {
    const req = args as ApiReq;
    calls.push(req);
    return { status: 200, headers: {}, bodyText: JSON.stringify(handler(req)) };
  });
  return calls;
}

const LOGGED_IN: AuthStatus = {
  loggedIn: true,
  user: { id: "u1", email: "a@b.c", name: "我", image: null },
  deviceId: "d1",
  personalWorkspaceId: "019a0000-0000-7000-8000-00000000aa01",
  activeOrganizationId: "org1",
  plan: "team",
};

function Wrap({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: "zh-Hans",
    resources: { "zh-Hans": { translation: zh } },
    interpolation: { escapeValue: false },
  });
});

beforeEach(() => resetCommands());
// vitest globals=false → Testing Library 不会自动 cleanup
afterEach(() => {
  cleanup();
  resetCommands();
});

describe("纯函数：分段过滤 / 分组 / 翻转", () => {
  it("groupTodos 按便笺分组（首次出现顺序），组内按 ordinal", () => {
    const shuffled = [LOCAL_ITEMS[1], LOCAL_ITEMS[2], LOCAL_ITEMS[0]] as TodoItem[];
    const groups = groupTodos(shuffled);
    expect(groups.map((g) => g.noteId)).toEqual([NOTE_A, NOTE_B]);
    expect(groups[0]?.items.map((i) => i.blockId)).toEqual(["aaaaaaaaaa", "bbbbbbbbbb"]);
    expect(groups[0]?.color).toBe("citron");
    expect(groups[1]?.title).toBe("会议");
  });

  it("filterBySegment：open 只留未勾选，done 只留已勾选，all 全部", () => {
    const items = [item({}), item({ blockId: "x", checked: true })];
    expect(filterBySegment(items, "open").map((i) => i.blockId)).toEqual(["aaaaaaaaaa"]);
    expect(filterBySegment(items, "done").map((i) => i.blockId)).toEqual(["x"]);
    expect(filterBySegment(items, "all").length).toBe(2);
  });

  it("flipTaskItem 递归找到嵌套项，不改入参；找不到返回 found=false", () => {
    const r = flipTaskItem(noteADoc, "cccccccccc");
    expect(r.found).toBe(true);
    expect(r.checked).toBe(false);
    const nested = r.json.content?.[1]?.content?.[1]?.content?.[1]?.content?.[0];
    expect(nested?.attrs?.checked).toBe(false);
    // 原对象未变
    expect(noteADoc.content?.[1]?.content?.[1]?.content?.[1]?.content?.[0]?.attrs?.checked).toBe(true);
    expect(flipTaskItem(noteADoc, "nope").found).toBe(false);
    expect(flipTaskItem(noteADoc, "aaaaaaaaaa", true).json.content?.[1]?.content?.[0]?.attrs?.checked).toBe(
      true,
    );
  });
});

describe("TodosPanel（本机范围）", () => {
  it("按便笺分组渲染：标题头 + 每项一个复选框", async () => {
    mockCommand("todos_list", () => LOCAL_ITEMS);
    render(<TodosPanel auth={null} />, { wrapper: Wrap });
    const headA = await screen.findByRole("button", { name: /购物清单/ });
    expect(screen.getByRole("button", { name: /会议/ })).toBeTruthy();
    const groupA = headA.closest("section") as HTMLElement;
    const boxes = within(groupA).getAllByRole("checkbox");
    expect(boxes.length).toBe(2);
    expect(within(groupA).getByLabelText("鸡蛋")).toBeTruthy();
    expect(within(groupA).getByLabelText("牛奶")).toBeTruthy();
    expect(headA.textContent).toContain("2 项未完成");
    expect(invokeMock).toHaveBeenCalledWith(
      "todos_list",
      expect.objectContaining({ includeDone: false, workspaceId: null }),
    );
  });

  it("勾选 = 走 doc 路径：note_append_update(origin local) 的投影里该项 checked=true；乐观显示", async () => {
    mockCommand("todos_list", () => LOCAL_ITEMS);
    const appended = fakeNoteDb();
    render(<TodosPanel auth={null} />, { wrapper: Wrap });
    const box = (await screen.findByLabelText("鸡蛋")) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    // 乐观：立刻显示已勾
    expect((screen.getByLabelText("鸡蛋") as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(appended.length).toBe(1));
    const call = appended[0];
    expect(call?.noteId).toBe(NOTE_A);
    expect(call?.origin).toBe("local");
    expect(call?.projection.checklist).toEqual([
      { blockId: "aaaaaaaaaa", text: "鸡蛋", checked: true, ordinal: 0 },
      { blockId: "bbbbbbbbbb", text: "牛奶", checked: false, ordinal: 1 },
      { blockId: "cccccccccc", text: "低脂", checked: true, ordinal: 2 },
    ]);
    expect(call?.projection.contentText).toBe("购物清单\n[x] 鸡蛋\n[ ] 牛奶\n[x] 低脂");
  });

  it("勾选失败回滚并提示", async () => {
    mockCommand("todos_list", () => LOCAL_ITEMS);
    mockCommand("note_load_doc", () => {
      throw { code: "db", message: "boom" };
    });
    render(<TodosPanel auth={null} />, { wrapper: Wrap });
    const box = (await screen.findByLabelText("鸡蛋")) as HTMLInputElement;
    fireEvent.click(box);
    expect((screen.getByLabelText("鸡蛋") as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect((screen.getByLabelText("鸡蛋") as HTMLInputElement).checked).toBe(false));
    expect(await screen.findByText("没能更新这条待办。")).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalledWith("note_append_update", expect.anything());
  });

  it("键盘：Enter 打开所在便笺；点标题头也打开", async () => {
    mockCommand("todos_list", () => LOCAL_ITEMS);
    mockCommand("note_window_open", () => ({ label: "note-a" }));
    render(<TodosPanel auth={null} />, { wrapper: Wrap });
    const box = await screen.findByLabelText("发纪要");
    box.focus();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("note_window_open", { noteId: NOTE_B, focus: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: /购物清单/ }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("note_window_open", { noteId: NOTE_A, focus: true }),
    );
  });

  it("分段切换：已完成 → includeDone=true 且只显示已勾选；空态文案", async () => {
    mockCommand("todos_list", (args) =>
      args.includeDone
        ? [...LOCAL_ITEMS, item({ blockId: "eeeeeeeeee", text: "已买", checked: true, ordinal: 5 })]
        : LOCAL_ITEMS,
    );
    render(<TodosPanel auth={null} />, { wrapper: Wrap });
    await screen.findByLabelText("鸡蛋");
    fireEvent.click(screen.getByRole("tab", { name: "已完成" }));
    expect(await screen.findByLabelText("已买")).toBeTruthy();
    expect(screen.queryByLabelText("鸡蛋")).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("todos_list", expect.objectContaining({ includeDone: true }));
  });

  it("没有待办时提示在便笺里插入", async () => {
    mockCommand("todos_list", () => []);
    render(<TodosPanel auth={null} />, { wrapper: Wrap });
    expect(await screen.findByText("还没有待办")).toBeTruthy();
    expect(screen.getByText(/在便笺里按 .*L 插入一个/)).toBeTruthy();
  });
});

describe("TodosPanel（团队工作区范围）", () => {
  const remoteRow = (over: Partial<RemoteTodoDto> = {}): RemoteTodoDto => ({
    note_id: NOTE_A,
    note_title: "共享清单",
    note_color: "amber",
    workspace_id: TEAM_WS,
    created_by: "u2",
    block_id: "aaaaaaaaaa",
    text: "订会议室",
    checked: false,
    ordinal: 0,
    note_updated_at: "2026-01-03T04:05:06.000Z",
    ...over,
  });

  function mockTeamApi() {
    return mockApi((req) => {
      if (req.path === "/v1/workspaces")
        return {
          workspaces: [
            {
              id: "019a0000-0000-7000-8000-00000000aa01",
              kind: "personal",
              org_id: null,
              team_id: null,
              owner_user_id: "u1",
              name: "个人",
              default_note_perm: "manager",
              effective_perm: "manager",
              created_at: "2026-01-01T00:00:00.000Z",
              archived_at: null,
            },
            {
              id: TEAM_WS,
              kind: "team",
              org_id: "org1",
              team_id: null,
              owner_user_id: null,
              name: "共享区",
              default_note_perm: "editor",
              effective_perm: "editor",
              created_at: "2026-01-01T00:00:00.000Z",
              archived_at: null,
            },
          ],
        };
      if (req.path.startsWith("/v1/todos/summary"))
        return {
          open: 3,
          done: 1,
          by_member: [
            { user_id: "u1", name: "我", open: 1, done: 0 },
            { user_id: "u2", name: "小王", open: 2, done: 1 },
          ],
        };
      if (req.path.startsWith("/v1/todos")) {
        const mine = req.path.includes("created_by=u2");
        return {
          items: mine
            ? [remoteRow()]
            : [
                remoteRow(),
                remoteRow({
                  note_id: NOTE_B,
                  note_title: "远端便笺",
                  block_id: "ffffffffff",
                  text: "只在云端",
                }),
              ],
          next_cursor: null,
          has_more: false,
        };
      }
      throw new Error(`unexpected ${req.path}`);
    });
  }

  it("切换到团队工作区走服务端 /v1/todos，成员筛选来自 /v1/todos/summary", async () => {
    mockCommand("todos_list", () => LOCAL_ITEMS);
    mockCommand("notes_list", () => [{ id: NOTE_A }]);
    const calls = mockTeamApi();
    render(<TodosPanel auth={LOGGED_IN} />, { wrapper: Wrap });
    await screen.findByLabelText("鸡蛋");
    const scope = (await screen.findByLabelText("范围")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "共享区" });
    fireEvent.change(scope, { target: { value: TEAM_WS } });

    expect(await screen.findByLabelText("订会议室")).toBeTruthy();
    const todosCall = calls.find((c) => c.path.startsWith("/v1/todos?"));
    expect(todosCall?.method).toBe("GET");
    expect(todosCall?.path).toContain(`workspace_id=${TEAM_WS}`);
    expect(todosCall?.path).not.toContain("include_done");
    expect(calls.some((c) => c.path.startsWith(`/v1/todos/summary?workspace_id=${TEAM_WS}`))).toBe(true);

    const member = (await screen.findByLabelText("成员")) as HTMLSelectElement;
    expect(await within(member).findByRole("option", { name: "小王 (2)" })).toBeTruthy();
    fireEvent.change(member, { target: { value: "u2" } });
    await waitFor(() => expect(calls.some((c) => c.path.includes("created_by=u2"))).toBe(true));
    await waitFor(() => expect(screen.queryByLabelText("只在云端")).toBeNull());
  });

  it("不在本机的团队便笺不能勾选；在本机的可以", async () => {
    mockCommand("todos_list", () => []);
    mockCommand("notes_list", () => [{ id: NOTE_A }]);
    const appended = fakeNoteDb();
    mockTeamApi();
    render(<TodosPanel auth={LOGGED_IN} />, { wrapper: Wrap });
    const scope = (await screen.findByLabelText("范围")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "共享区" });
    fireEvent.change(scope, { target: { value: TEAM_WS } });
    const cloudOnly = (await screen.findByLabelText("只在云端")) as HTMLInputElement;
    await waitFor(() => expect(cloudOnly.disabled).toBe(true));
    const localOne = screen.getByLabelText("订会议室") as HTMLInputElement;
    expect(localOne.disabled).toBe(false);
    fireEvent.click(localOne);
    await waitFor(() => expect(appended.length).toBe(1));
    expect(appended[0]?.projection.checklist[0]).toEqual({
      blockId: "aaaaaaaaaa",
      text: "鸡蛋",
      checked: true,
      ordinal: 0,
    });
  });
});

describe("TodosBadge", () => {
  function Harness() {
    useDbInvalidation();
    return <TodosBadge />;
  }

  it("显示未完成数，db:changed 后刷新；为 0 不渲染", async () => {
    let counts = { open: 3, done: 1 };
    mockCommand("todos_counts", () => counts);
    const { container } = render(<Harness />, { wrapper: Wrap });
    await waitFor(() => expect(container.querySelector(".todos-badge")?.textContent).toContain("3"));
    counts = { open: 1, done: 3 };
    act(() => emitTestEvent("db:changed", { rev: 2, origin: "local", tables: ["notes"], ids: [NOTE_A] }));
    await waitFor(() => expect(container.querySelector(".todos-badge")?.textContent).toContain("1"));
    counts = { open: 0, done: 4 };
    act(() => emitTestEvent("db:changed", { rev: 3, origin: "local", tables: ["notes"], ids: [NOTE_A] }));
    await waitFor(() => expect(container.querySelector(".todos-badge")).toBeNull());
  });
});
