// /admin 管理台：入口网关（非管理员 / 管理面关闭）、用户列表与分页、冻结与改密的二次确认和错误翻译。
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Admin } from "../pages/Admin.js";
import { adminUrl, parseAdminRoute } from "../pages/admin/route.js";

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

/** 记录每一次请求，测试里既断言渲染也断言「到底问了服务端什么」 */
const calls: Array<{ url: string; method: string; body: unknown }> = [];

function mockApi(route: (url: string, method: string, body: unknown) => Reply) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    const reply = route(url, method, body);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
}

const ADMINS: Reply = { status: 200, body: { admins: [] } };

function user(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    email: `${id}@example.com`,
    name: id.toUpperCase(),
    created_at: "2026-01-02T03:04:05.000Z",
    frozen: false,
    frozen_at: null,
    frozen_reason: null,
    deleted: false,
    is_platform_admin: false,
    ...extra,
  };
}

const DETAIL = {
  user: user("u2"),
  frozen_by: null,
  organizations: [{ id: "o1", name: "设计组", slug: "design", role: "admin", status: "active" }],
  teams: [{ id: "t1", name: "字体小队", org_id: "o1" }],
  devices: [{ id: "d1", name: "MacBook", platform: "macos", revoked: false }],
  scale: { workspaces: 3, notes: 42, deleted_notes: 5, e2ee_notes: 2 },
};

beforeEach(() => {
  calls.length = 0;
  mocks.session = { user: { id: "u1", email: "root@example.com", name: "Root", emailVerified: true } };
  window.history.replaceState(null, "", "/admin");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("管理台路由（/admin + 查询串）", () => {
  it("解析视图状态", () => {
    expect(parseAdminRoute("")).toEqual({
      tab: "users",
      userId: null,
      content: false,
      workspaceId: null,
      noteId: null,
    });
    expect(parseAdminRoute("?tab=audit").tab).toBe("audit");
    expect(parseAdminRoute("?user=u2").userId).toBe("u2");
    expect(parseAdminRoute("?user=u2&view=content&ws=w1&note=n1")).toEqual({
      tab: "users",
      userId: "u2",
      content: true,
      workspaceId: "w1",
      noteId: "n1",
    });
    // 没进「查看内容」时 ws / note 不生效，避免拼出一个半截状态
    expect(parseAdminRoute("?user=u2&ws=w1").workspaceId).toBeNull();
  });

  it("拼回 URL", () => {
    expect(adminUrl({})).toBe("/admin");
    expect(adminUrl({ tab: "audit" })).toBe("/admin?tab=audit");
    expect(adminUrl({ userId: "u2" })).toBe("/admin?user=u2");
    expect(adminUrl({ userId: "u2", content: true, workspaceId: "w1", noteId: "n1" })).toBe(
      "/admin?user=u2&view=content&ws=w1&note=n1",
    );
  });
});

describe("/admin 入口网关", () => {
  it("非管理员：403 → 「你没有权限进入这里」，不再去要用户列表", async () => {
    mockApi(() => ({ status: 403, body: { error: "insufficient_role", required: "platform_admin" } }));
    render(<Admin search="" />);
    await waitFor(() => expect(screen.getByText("你没有权限进入这里")).toBeTruthy());
    expect(screen.getByText("这个页面只对平台总管理员开放。")).toBeTruthy();
    expect(calls.map((c) => c.url)).toEqual(["/v1/admin/admins"]);
    expect(screen.queryByText("平台管理台")).toBeTruthy(); // 标题还在，但正文是拒绝态
  });

  it("管理面被关掉：404 → 与无权限不同的文案", async () => {
    mockApi(() => ({ status: 404, body: { error: "not_found" } }));
    render(<Admin search="" />);
    await waitFor(() => expect(screen.getByText("管理面已关闭")).toBeTruthy());
    expect(screen.queryByText("你没有权限进入这里")).toBeNull();
    expect(screen.getByText("这个部署把平台管理台整面关掉了，相关接口一概不存在。")).toBeTruthy();
  });

  it("会话失效：401 → 提示重新登录", async () => {
    mockApi(() => ({ status: 401, body: { error: "unauthorized" } }));
    render(<Admin search="" />);
    await waitFor(() => expect(screen.getByText("登录已失效")).toBeTruthy());
    expect(screen.getByRole("button", { name: "去登录" })).toBeTruthy();
  });
});

describe("/admin 用户列表", () => {
  it("渲染邮箱 / 姓名 / 注册时间 / 冻结与总管理员标记，并常驻审计提示", async () => {
    mockApi((url) => {
      if (url === "/v1/admin/admins") return ADMINS;
      if (url.startsWith("/v1/admin/users?"))
        return {
          status: 200,
          body: {
            users: [
              user("u2"),
              user("u3", { frozen: true, frozen_reason: "滥用" }),
              user("u4", { is_platform_admin: true }),
            ],
            next_offset: null,
          },
        };
      throw new Error(`unexpected ${url}`);
    });
    render(<Admin search="" />);
    await waitFor(() => expect(screen.getByText("u2@example.com")).toBeTruthy());
    expect(screen.getByText("u3@example.com")).toBeTruthy();
    expect(screen.getByText("已冻结")).toBeTruthy();
    expect(screen.getByText("总管理员")).toBeTruthy();
    expect(
      screen.getByText("这里的每一次查看都会记进审计日志：谁、什么时候、看了谁的什么，事后都查得到。"),
    ).toBeTruthy();
  });

  it("搜索把 q 带给服务端；分页按 next_offset 走", async () => {
    mockApi((url) => {
      if (url === "/v1/admin/admins") return ADMINS;
      if (url.startsWith("/v1/admin/users?"))
        return {
          status: 200,
          body: { users: [user("u2")], next_offset: url.includes("offset=25") ? null : 25 },
        };
      throw new Error(`unexpected ${url}`);
    });
    render(<Admin search="" />);
    await waitFor(() => expect(screen.getByText("u2@example.com")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "lin" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    });
    await waitFor(() => expect(calls.some((c) => c.url.includes("q=lin"))).toBe(true));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    });
    await waitFor(() => expect(calls.some((c) => c.url.includes("offset=25"))).toBe(true));
    // 到底了：next_offset 为 null 时「下一页」不可再点
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it("只看已冻结 → frozen=1", async () => {
    mockApi((url) => {
      if (url === "/v1/admin/admins") return ADMINS;
      if (url.startsWith("/v1/admin/users?")) return { status: 200, body: { users: [], next_offset: null } };
      throw new Error(`unexpected ${url}`);
    });
    render(<Admin search="" />);
    await waitFor(() => expect(screen.getByText("没有匹配的用户。")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByLabelText("只看已冻结"));
    });
    await waitFor(() => expect(calls.some((c) => c.url.includes("frozen=1"))).toBe(true));
  });

  it("点邮箱进入详情：地址变成 /admin?user=…", async () => {
    mockApi((url) => {
      if (url === "/v1/admin/admins") return ADMINS;
      if (url.startsWith("/v1/admin/users?"))
        return { status: 200, body: { users: [user("u2")], next_offset: null } };
      throw new Error(`unexpected ${url}`);
    });
    render(<Admin search="" />);
    await waitFor(() => screen.getByText("u2@example.com"));
    fireEvent.click(screen.getByRole("button", { name: "u2@example.com" }));
    expect(window.location.pathname + window.location.search).toBe("/admin?user=u2");
  });
});

describe("/admin 用户详情与危险操作", () => {
  function detailApi(extra: (url: string, method: string, body: unknown) => Reply | null) {
    mockApi((url, method, body) => {
      if (url === "/v1/admin/admins") return ADMINS;
      if (url === "/v1/admin/users/u2" && method === "GET") return { status: 200, body: DETAIL };
      const r = extra(url, method, body);
      if (r) return r;
      throw new Error(`unexpected ${method} ${url}`);
    });
  }

  it("显示组织角色、团队、设备与内容规模", async () => {
    detailApi(() => null);
    render(<Admin search="?user=u2" />);
    await waitFor(() => expect(screen.getByText("设计组")).toBeTruthy());
    expect(screen.getByText("管理员 · 在用")).toBeTruthy();
    expect(screen.getByText("字体小队")).toBeTruthy();
    expect(screen.getByText("MacBook")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("冻结要二次确认：先说清后果，确认后才发请求", async () => {
    detailApi((url, method) =>
      url === "/v1/admin/users/u2/freeze" && method === "POST"
        ? { status: 200, body: { ok: true, revoked_devices: 2 } }
        : null,
    );
    render(<Admin search="?user=u2" />);
    await waitFor(() => screen.getByRole("button", { name: "冻结账号" }));
    fireEvent.click(screen.getByRole("button", { name: "冻结账号" }));

    expect(screen.getByText("确认冻结这个账号？")).toBeTruthy();
    expect(screen.getByText(/立刻断开该用户的全部同步连接/)).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/freeze"))).toBe(false);

    fireEvent.change(screen.getByLabelText("冻结原因（可选）"), { target: { value: "滥用" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认冻结" }));
    });
    await waitFor(() => expect(screen.getByText("已冻结。吊销了 2 台设备的登录。")).toBeTruthy());
    const freeze = calls.find((c) => c.url.endsWith("/freeze"));
    expect(freeze?.body).toEqual({ reason: "滥用" });
  });

  it("取消确认不会发请求", async () => {
    detailApi(() => null);
    render(<Admin search="?user=u2" />);
    await waitFor(() => screen.getByRole("button", { name: "冻结账号" }));
    fireEvent.click(screen.getByRole("button", { name: "冻结账号" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("确认冻结这个账号？")).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/freeze"))).toBe(false);
  });

  it("对另一个总管理员动手：403 翻译成人话，不露错误码", async () => {
    detailApi((url, method) =>
      url === "/v1/admin/users/u2/freeze" && method === "POST"
        ? { status: 403, body: { error: "target_is_platform_admin" } }
        : null,
    );
    render(<Admin search="?user=u2" />);
    await waitFor(() => screen.getByRole("button", { name: "冻结账号" }));
    fireEvent.click(screen.getByRole("button", { name: "冻结账号" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认冻结" }));
    });
    await waitFor(() =>
      expect(screen.getByText("对方也是平台总管理员，不能对他执行这个操作。")).toBeTruthy(),
    );
    expect(screen.queryByText(/target_is_platform_admin/)).toBeNull();
  });

  it("对自己动手：400 cannot_freeze_self 也是人话", async () => {
    detailApi((url, method) =>
      url === "/v1/admin/users/u2/freeze" && method === "POST"
        ? { status: 400, body: { error: "cannot_freeze_self" } }
        : null,
    );
    render(<Admin search="?user=u2" />);
    await waitFor(() => screen.getByRole("button", { name: "冻结账号" }));
    fireEvent.click(screen.getByRole("button", { name: "冻结账号" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认冻结" }));
    });
    await waitFor(() => expect(screen.getByText("不能冻结自己的账号。")).toBeTruthy());
  });

  it("已冻结的用户只给「解冻」，解冻同样要确认", async () => {
    mockApi((url, method) => {
      if (url === "/v1/admin/admins") return ADMINS;
      if (url === "/v1/admin/users/u2" && method === "GET")
        return {
          status: 200,
          body: {
            ...DETAIL,
            user: user("u2", { frozen: true, frozen_at: "2026-02-01T00:00:00.000Z", frozen_reason: "滥用" }),
            frozen_by: "u1",
          },
        };
      if (url === "/v1/admin/users/u2/unfreeze" && method === "POST")
        return { status: 200, body: { ok: true } };
      throw new Error(`unexpected ${method} ${url}`);
    });
    render(<Admin search="?user=u2" />);
    await waitFor(() => screen.getByRole("button", { name: "解冻账号" }));
    expect(screen.queryByRole("button", { name: "冻结账号" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "解冻账号" }));
    expect(screen.getByText("确认解冻这个账号？")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认解冻" }));
    });
    await waitFor(() => expect(screen.getByText("已解冻。")).toBeTruthy());
  });

  it("重置密码：说清后果、本地拦短密码、成功后报告吊销数", async () => {
    detailApi((url, method) =>
      url === "/v1/admin/users/u2/password" && method === "POST"
        ? { status: 200, body: { ok: true, revoked_devices: 3 } }
        : null,
    );
    render(<Admin search="?user=u2" />);
    await waitFor(() => screen.getByRole("button", { name: "重置密码" }));
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    expect(screen.getByText(/吊销该用户的全部设备令牌与会话/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "short" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    });
    expect(screen.getByText("密码至少 8 个字符。")).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/password"))).toBe(false);

    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "correct horse battery" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    });
    await waitFor(() => expect(screen.getByText("密码已重置。吊销了 3 台设备的登录。")).toBeTruthy());
    expect(calls.find((c) => c.url.endsWith("/password"))?.body).toEqual({
      new_password: "correct horse battery",
    });
  });
});
