// /notes（网页 / PWA 的便笺列表）：
//   ① 走的是同源会话通道 —— 每个 /v1 请求都必须带 X-Bianfa-Web: 1 与同源 cookie，绝不能出现 Bearer 令牌；
//   ② 发现接口是增量语义（按 lsn 升序、含已删除行），必须翻完所有页再过滤，只取第一页就是桌面端「卡在 65 张」那类错误；
//   ③ E2EE 便笺显示为「加密」而不是一张空白便笺。
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchNotes } from "../notes-api.js";
import { Notes } from "../pages/Notes.js";
import { useLocation } from "../router.js";

const mocks = vi.hoisted(() => ({
  session: { user: { id: "u1", email: "lin@example.com", name: "Lin", emailVerified: true } } as unknown,
}));

// 编辑器整块换掉：这个文件测的是列表与路由，真去挂 TipTap + WebSocket 只会让它变慢变脆。
// 编辑器本身的行为在 sync-session / editor-schema 两个文件里测。
vi.mock("../pages/NoteView.js", () => ({
  NoteView: ({ note, backTo }: { note: { id: string }; backTo: string }) => (
    <div data-testid="note-view" data-note={note.id} data-back={backTo} />
  ),
}));

vi.mock("../auth-client.js", () => ({
  authClient: {
    useSession: () => ({ data: mocks.session, isPending: false, refetch: async () => {} }),
  },
}));

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

const seen: Seen[] = [];

function mockApi(route: (url: string) => { status: number; body: unknown }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    seen.push({ url, init: init as RequestInit | undefined });
    const reply = route(url);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
}

const WORKSPACES = {
  workspaces: [
    { id: "w1", kind: "personal", name: "个人", effective_perm: "manager" },
    { id: "w2", kind: "team", name: "排版", effective_perm: "editor" },
  ],
};

function note(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: "w1",
    title: `便笺 ${id}`,
    excerpt: `这是 ${id} 的开头`,
    color: "amber",
    pinned: false,
    head_seq: 3,
    version: 1,
    encryption: "server",
    created_at: "2026-03-04T05:06:07.000Z",
    updated_at: "2026-03-04T05:06:07.000Z",
    deleted_at: null,
    purged_at: null,
    archived_at: null,
    ...extra,
  };
}

function headerOf(entry: Seen | undefined, name: string): string | undefined {
  const h = entry?.init?.headers as Record<string, string> | undefined;
  return h?.[name];
}

/**
 * 和 App.tsx 一样：从 useLocation() 读 search 再传给 Notes。
 * 直接 <Notes search="..." /> 的话 search 是写死的 prop，navigate 之后不会重新传下来——
 * 凡是要跨一次导航的用例都必须用这个外壳，否则测的是一个真实里不存在的组件。
 */
function NotesLive() {
  const loc = useLocation();
  return <Notes search={loc.search} />;
}

beforeEach(() => {
  seen.length = 0;
  window.history.replaceState(null, "", "/notes");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("便笺取数（notes-api）", () => {
  it("每个 /v1 请求带 X-Bianfa-Web 与同源 cookie，且不带 Authorization", async () => {
    mockApi(() => ({ status: 200, body: { workspaces: [] } }));
    await fetchNotes("w1");
    const first = seen[0];
    expect(first?.url).toContain("/v1/notes?workspace_id=w1");
    expect(headerOf(first, "x-bianfa-web")).toBe("1");
    expect(first?.init?.credentials).toBe("same-origin");
    expect(headerOf(first, "authorization")).toBeUndefined();
  });

  it("翻完所有发现分页，而不是只取第一页", async () => {
    mockApi((url) => {
      const since = Number(new URL(url, "http://x").searchParams.get("since_version"));
      if (since === 0)
        return {
          status: 200,
          body: {
            workspace_id: "w1",
            effective_perm: "manager",
            notes: [note("n1")],
            next_version: 10,
            has_more: true,
          },
        };
      return {
        status: 200,
        body: {
          workspace_id: "w1",
          effective_perm: "manager",
          notes: [note("n2")],
          next_version: 20,
          has_more: false,
        },
      };
    });
    const res = await fetchNotes("w1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.notes.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(res.data.truncated).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it("回收站与已彻底删除的行不出现在列表里；置顶排最前", async () => {
    mockApi(() => ({
      status: 200,
      body: {
        workspace_id: "w1",
        effective_perm: "manager",
        notes: [
          note("n1", { updated_at: "2026-03-01T00:00:00.000Z" }),
          note("n2", { deleted_at: "2026-03-05T00:00:00.000Z" }),
          note("n3", { purged_at: "2026-03-05T00:00:00.000Z" }),
          note("n4", { pinned: true, updated_at: "2020-01-01T00:00:00.000Z" }),
        ],
        next_version: 9,
        has_more: false,
      },
    }));
    const res = await fetchNotes("w1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // n4 虽然最旧但置顶；n2/n3 已删除
    expect(res.data.notes.map((n) => n.id)).toEqual(["n4", "n1"]);
  });

  it("has_more 为真但游标不前进时停下来，不转成死循环", async () => {
    mockApi(() => ({
      status: 200,
      body: {
        workspace_id: "w1",
        effective_perm: "manager",
        notes: [note("n1")],
        next_version: 0,
        has_more: true,
      },
    }));
    const res = await fetchNotes("w1");
    expect(res.ok).toBe(true);
    expect(seen).toHaveLength(1);
  });
});

describe("/notes 列表页", () => {
  function routeAll(url: string) {
    if (url === "/v1/workspaces") return { status: 200, body: WORKSPACES };
    if (url.startsWith("/v1/notes?workspace_id=w1"))
      return {
        status: 200,
        body: {
          workspace_id: "w1",
          effective_perm: "manager",
          notes: [
            note("n1", { title: "购物清单", excerpt: "牛奶 鸡蛋" }),
            note("n2", { title: "", excerpt: "", encryption: "e2ee" }),
            note("n3", { title: "会议记录", excerpt: "周三 10 点" }),
          ],
          next_version: 5,
          has_more: false,
        },
      };
    if (url.startsWith("/v1/notes?workspace_id=w2"))
      return {
        status: 200,
        body: {
          workspace_id: "w2",
          effective_perm: "editor",
          notes: [note("n9", { workspace_id: "w2", title: "字体评审" })],
          next_version: 2,
          has_more: false,
        },
      };
    throw new Error(`unexpected ${url}`);
  }

  it("列出便笺；E2EE 的显示为加密而不是空白", async () => {
    mockApi(routeAll);
    render(<Notes search="" />);
    await waitFor(() => expect(screen.getByText("购物清单")).toBeTruthy());
    expect(screen.getByText("会议记录")).toBeTruthy();
    expect(screen.getByText("无标题")).toBeTruthy();
    expect(screen.getByText("端到端加密，网页端暂不能查看")).toBeTruthy();
    expect(screen.getByText("共 3 张")).toBeTruthy();
  });

  it("搜索框按标题 / 摘要过滤，且不写进 URL", async () => {
    mockApi(routeAll);
    render(<Notes search="" />);
    await waitFor(() => expect(screen.getByText("购物清单")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("搜索标题或正文"), { target: { value: "鸡蛋" } });
    await waitFor(() => expect(screen.queryByText("会议记录")).toBeNull());
    expect(screen.getByText("购物清单")).toBeTruthy();
    expect(screen.getByText("1 / 3 张")).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("?ws= 指向看不见的工作区时退回第一个，而不是把整页顶成错误", async () => {
    mockApi(routeAll);
    render(<Notes search="?ws=deadbeef" />);
    await waitFor(() => expect(screen.getByText("购物清单")).toBeTruthy());
    expect(seen.some((s) => s.url.startsWith("/v1/notes?workspace_id=w1"))).toBe(true);
  });

  it("工作区为空时给一句可执行的说明，而不是空列表", async () => {
    mockApi((url) => {
      if (url === "/v1/workspaces") return { status: 200, body: { workspaces: [] } };
      throw new Error(`unexpected ${url}`);
    });
    render(<Notes search="" />);
    await waitFor(() => expect(screen.getByText("还没有可用的工作区")).toBeTruthy());
  });

  it("点卡片打开便笺：URL 记成 ?ws=&note=，渲染编辑器", async () => {
    mockApi(routeAll);
    render(<Notes search="" />);
    await waitFor(() => expect(screen.getByText("购物清单")).toBeTruthy());
    fireEvent.click(screen.getByText("购物清单"));
    await waitFor(() => expect(window.location.search).toBe("?ws=w1&note=n1"));
  });

  it("?note= 指向的便笺不在这个工作区（被删 / 换了账号）→ 说清楚，而不是一张空编辑器", async () => {
    mockApi(routeAll);
    render(<Notes search="?ws=w1&note=nope" />);
    await waitFor(() => expect(screen.getByText("找不到这张便笺")).toBeTruthy());
  });

  it("E2EE 的便笺不给打开：网页端拿不到密钥，开出来只会是一张空文档", async () => {
    mockApi(routeAll);
    render(<Notes search="?ws=w1&note=n2" />);
    await waitFor(() => expect(screen.getByText("端到端加密，网页端暂不能查看")).toBeTruthy());
  });

  it("新建：POST /v1/notes 带客户端生成的 UUIDv7，成功后跳到编辑器", async () => {
    // 假服务端要有状态：建行之后再拉列表，那张新便笺必须在里面。
    // 固定返回同一份列表的话，测的就不是真实行为了——真实服务端一定会带上它。
    let newId: string | null = null;
    mockApi((url) => {
      if (url === "/v1/notes") {
        const last = seen[seen.length - 1];
        newId = (JSON.parse(String(last?.init?.body)) as { id: string }).id;
        return { status: 201, body: { note: note(newId) } };
      }
      if (url.startsWith("/v1/notes?workspace_id=w1") && newId) {
        return {
          status: 200,
          body: {
            workspace_id: "w1",
            effective_perm: "manager",
            notes: [note("n1", { title: "购物清单" }), note(newId, { title: "" })],
            next_version: 6,
            has_more: false,
          },
        };
      }
      return routeAll(url);
    });
    render(<NotesLive />);
    await waitFor(() => expect(screen.getByText("购物清单")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /新建/ }));

    await waitFor(() => expect(seen.some((s) => s.url === "/v1/notes")).toBe(true));
    const post = seen.find((s) => s.url === "/v1/notes");
    expect(post?.init?.method).toBe("POST");
    const body = JSON.parse(String(post?.init?.body)) as { id: string; workspace_id: string };
    expect(body.workspace_id).toBe("w1");
    // 服务端的入参校验是 z.uuidv7()：版本位必须是 7，v4 会被 400 掉
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // 建行成功后跳到编辑器，URL 带上新便笺的 id
    await waitFor(() => expect(window.location.search).toBe(`?ws=w1&note=${body.id}`));
    // 而且真的要把编辑器渲染出来。列表是缓存的、里面没有这张新便笺——
    // 不重新取一次的话，用户点完"新建"看到的是"找不到这张便笺"。
    await waitFor(() => expect(screen.getByTestId("note-view")).toBeTruthy());
    expect(screen.getByTestId("note-view").getAttribute("data-note")).toBe(body.id);
  });

  it("新建失败（比如超配额）要说出来，不能默默什么都没发生", async () => {
    mockApi((url) => {
      if (url === "/v1/notes") return { status: 403, body: { error: "quota_exceeded" } };
      return routeAll(url);
    });
    render(<Notes search="" />);
    await waitFor(() => expect(screen.getByText("购物清单")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /新建/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(window.location.search).toBe("");
  });

  it("只读工作区不显示新建按钮（点了也只会被服务端 403）", async () => {
    mockApi((url) => {
      if (url === "/v1/workspaces")
        return {
          status: 200,
          body: { workspaces: [{ id: "w1", kind: "personal", name: "个人", effective_perm: "viewer" }] },
        };
      return routeAll(url);
    });
    render(<Notes search="" />);
    await waitFor(() => expect(screen.getByText("购物清单")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /新建/ })).toBeNull();
  });

  it("会话对 /v1 无效（401）时展示错误而不是空列表", async () => {
    mockApi(() => ({ status: 401, body: { error: "unauthorized" } }));
    render(<Notes search="" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "重试" })).toBeTruthy());
  });
});
