// /admin 看内容与审计：团队工作区的归属要看得见，E2EE 便笺必须显式说明「服务端只有密文」，
// 审计页要能看到「查看内容」这条记录本身。
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Admin } from "../pages/Admin.js";

const mocks = vi.hoisted(() => ({
  session: { user: { id: "u1", email: "root@example.com", name: "Root", emailVerified: true } } as unknown,
}));

vi.mock("../auth-client.js", () => ({
  authClient: {
    useSession: () => ({ data: mocks.session, isPending: false, refetch: async () => {} }),
  },
}));

interface Reply {
  status: number;
  body: unknown;
}

const calls: string[] = [];

function mockApi(route: (url: string) => Reply) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    calls.push(url);
    const reply = route(url);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
}

const ADMINS: Reply = { status: 200, body: { admins: [] } };

const WORKSPACES = {
  workspaces: [
    {
      id: "w1",
      kind: "personal",
      name: "我的便笺",
      org_id: null,
      org_name: null,
      team_id: null,
      team_name: null,
      note_count: 12,
    },
    {
      id: "w2",
      kind: "team",
      name: "排版",
      org_id: "o1",
      org_name: "设计组",
      team_id: "t1",
      team_name: "字体小队",
      note_count: 4,
    },
  ],
};

function note(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: "w2",
    workspace_name: "排版",
    created_by: "u2",
    title: `便笺 ${id}`,
    excerpt: `这是 ${id} 的开头`,
    color: "amber",
    readable: true,
    unreadable_reason: null,
    updated_at: "2026-03-04T05:06:07.000Z",
    deleted: false,
    ...extra,
  };
}

beforeEach(() => {
  calls.length = 0;
  window.history.replaceState(null, "", "/admin");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("/admin 看内容", () => {
  it("工作区列表标出团队工作区属于哪个组织 / 团队", async () => {
    mockApi((url) => {
      if (url === "/v1/admin/admins") return ADMINS;
      if (url === "/v1/admin/users/u2/workspaces") return { status: 200, body: WORKSPACES };
      throw new Error(`unexpected ${url}`);
    });
    render(<Admin search="?user=u2&view=content" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "我的便笺" })).toBeTruthy());
    expect(screen.getByText("个人工作区 · 12 条便笺")).toBeTruthy();
    expect(screen.getByText("团队工作区 · 设计组 / 字体小队 · 4 条便笺")).toBeTruthy();
    expect(
      screen.getByText("这里列出的是该用户自己能看到的工作区，包含他所在团队的团队工作区。"),
    ).toBeTruthy();
  });

  it("点工作区进入便笺列表；E2EE 便笺显示为不可读，而不是一张空白便笺", async () => {
    mockApi((url) => {
      if (url === "/v1/admin/admins") return ADMINS;
      if (url === "/v1/admin/users/u2/workspaces") return { status: 200, body: WORKSPACES };
      if (url.startsWith("/v1/admin/users/u2/notes?"))
        return {
          status: 200,
          body: {
            notes: [
              note("n1"),
              note("n2", { title: null, excerpt: "", readable: false, unreadable_reason: "e2ee" }),
              note("n3", { deleted: true }),
            ],
            next_offset: null,
          },
        };
      throw new Error(`unexpected ${url}`);
    });
    render(<Admin search="?user=u2&view=content&ws=w2" />);
    await waitFor(() => expect(screen.getByText("这是 n1 的开头")).toBeTruthy());
    expect(screen.getByText("服务端只有密文，管理员无法查看。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "（无标题）" })).toBeTruthy();
    expect(screen.getByText(/在回收站/)).toBeTruthy();
    expect(calls.some((u) => u.includes("workspace_id=w2"))).toBe(true);
  });

  it("便笺列表：搜索与「包含回收站」都传给服务端", async () => {
    mockApi((url) => {
      if (url === "/v1/admin/admins") return ADMINS;
      if (url.startsWith("/v1/admin/users/u2/notes?"))
        return { status: 200, body: { notes: [note("n1")], next_offset: null } };
      throw new Error(`unexpected ${url}`);
    });
    render(<Admin search="?user=u2&view=content&ws=w2" />);
    await waitFor(() => screen.getByText("这是 n1 的开头"));
    fireEvent.change(screen.getByLabelText("搜索便笺"), { target: { value: "字体" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "搜索便笺" }));
    });
    await waitFor(() => expect(calls.some((u) => u.includes("q=%E5%AD%97%E4%BD%93"))).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByLabelText("包含回收站"));
    });
    await waitFor(() => expect(calls.some((u) => u.includes("include_deleted=1"))).toBe(true));
  });

  it("打开一条普通便笺：显示正文与作者", async () => {
    mockApi((url) => {
      if (url === "/v1/admin/admins") return ADMINS;
      if (url === "/v1/admin/users/u2/notes/n1")
        return {
          status: 200,
          body: {
            note: {
              id: "n1",
              workspace_id: "w2",
              workspace_name: "排版",
              created_by: "u2",
              creator_email: "u2@example.com",
              color: "amber",
              created_at: "2026-03-01T00:00:00.000Z",
              updated_at: "2026-03-04T05:06:07.000Z",
              deleted: false,
              readable: true,
              unreadable_reason: null,
              content: { type: "doc" },
              content_text: "买牛奶\n交房租",
            },
          },
        };
      throw new Error(`unexpected ${url}`);
    });
    render(<Admin search="?user=u2&view=content&ws=w2&note=n1" />);
    await waitFor(() => expect(screen.getByText(/买牛奶/)).toBeTruthy());
    expect(screen.getByText("u2@example.com")).toBeTruthy();
  });

  it("打开一条 E2EE 便笺：明说服务端只有密文，管理员看不到", async () => {
    mockApi((url) => {
      if (url === "/v1/admin/admins") return ADMINS;
      if (url === "/v1/admin/users/u2/notes/n2")
        return {
          status: 200,
          body: {
            note: {
              id: "n2",
              workspace_id: "w2",
              workspace_name: "排版",
              created_by: "u2",
              creator_email: "u2@example.com",
              color: "slate",
              created_at: "2026-03-01T00:00:00.000Z",
              updated_at: "2026-03-04T05:06:07.000Z",
              deleted: false,
              readable: false,
              unreadable_reason: "e2ee",
              content: null,
              content_text: "",
            },
          },
        };
      throw new Error(`unexpected ${url}`);
    });
    render(<Admin search="?user=u2&view=content&ws=w2&note=n2" />);
    await waitFor(() => expect(screen.getByText("无法查看正文")).toBeTruthy());
    expect(screen.getByText("这条便笺是端到端加密的，服务端只存了密文。")).toBeTruthy();
    expect(screen.getAllByText("端到端加密").length).toBeGreaterThan(0);
  });

  it("便笺不存在：404 给「找不到这条记录」，不会落到邀请那条 not_found 文案", async () => {
    mockApi((url) => {
      if (url === "/v1/admin/admins") return ADMINS;
      return { status: 404, body: { error: "not_found" } };
    });
    render(<Admin search="?user=u2&view=content&ws=w2&note=nx" />);
    await waitFor(() => expect(screen.getByText("找不到这条记录，可能已经被删掉了。")).toBeTruthy());
  });
});

describe("/admin 审计", () => {
  it("列出谁、什么时候、对谁做了什么；「查看内容」本身也在里面", async () => {
    mockApi((url) => {
      if (url === "/v1/admin/admins") return ADMINS;
      if (url.startsWith("/v1/admin/audit"))
        return {
          status: 200,
          body: {
            entries: [
              {
                id: "12",
                at: "2026-03-04T05:06:07.000Z",
                actor_id: "u1",
                actor_email: "root@example.com",
                actor_ip: "203.0.113.5",
                action: "admin.content_viewed",
                target_type: "user",
                target_id: "u2",
                outcome: "success",
                metadata: { view: "notes", subject_user_id: "u2" },
              },
              {
                id: "11",
                at: "2026-03-04T05:00:00.000Z",
                actor_id: "u9",
                actor_email: "nobody@example.com",
                actor_ip: null,
                action: "authz.denied",
                target_type: "platform_admin",
                target_id: "u9",
                outcome: "denied",
                metadata: { required: "platform_admin" },
              },
            ],
            next_offset: null,
          },
        };
      throw new Error(`unexpected ${url}`);
    });
    render(<Admin search="?tab=audit" />);
    await waitFor(() => expect(screen.getByText("查看内容")).toBeTruthy());
    expect(screen.getByText("root@example.com")).toBeTruthy();
    expect(screen.getByText("203.0.113.5")).toBeTruthy();
    expect(screen.getByText("越权访问被拒绝")).toBeTruthy();
    expect(screen.getByText("被拒绝")).toBeTruthy();
  });

  it("没有记录时给空态", async () => {
    mockApi((url) => {
      if (url === "/v1/admin/admins") return ADMINS;
      return { status: 200, body: { entries: [], next_offset: null } };
    });
    render(<Admin search="?tab=audit" />);
    await waitFor(() => expect(screen.getByText("还没有记录。")).toBeTruthy());
  });
});
