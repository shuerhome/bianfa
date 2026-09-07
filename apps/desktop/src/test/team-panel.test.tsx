// 团队页（TeamPanel）：mock api_request 层 —— 无组织 → 新建组织；成员改角色（PATCH 带 X-Organization-Id）；邀请显示可复制链接。
import { ToastProvider } from "@bianfa/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import zh from "../i18n/zh-Hans.json";
import type { ApiResponse, AuthStatus } from "../ipc/types.js";
import { TeamPanel } from "../windows/main/team/TeamPanel.js";
import { mockCommand, resetCommands } from "./setup.js";

interface Req {
  method: string;
  path: string;
  jsonBody?: unknown;
  headers?: Record<string, string>;
}
const calls: Req[] = [];
type Handler = (req: Req) => Partial<ApiResponse> | undefined;

function mockApi(handler: Handler) {
  mockCommand("api_request", (args) => {
    const req = args as unknown as Req;
    calls.push(req);
    const r = handler(req) ?? { status: 404, bodyText: JSON.stringify({ error: "not_found" }) };
    return { status: 200, headers: {}, bodyText: "", ...r };
  });
}
const json = (body: unknown, status = 200): Partial<ApiResponse> => ({
  status,
  bodyText: JSON.stringify(body),
});

const WS = "019a0000-0000-7000-8000-00000000aa01";
const AUTH: AuthStatus = {
  loggedIn: true,
  user: { id: "u1", email: "me@x.io", name: "我", image: null },
  deviceId: "d1",
  personalWorkspaceId: WS,
  activeOrganizationId: null,
  plan: "team",
};
const ORG = {
  id: "org1",
  name: "产品组",
  slug: "product",
  logo: null,
  plan: "team",
  enterprise_mode: false,
  created_at: "2026-01-01T00:00:00.000Z",
  role: "owner",
  status: "active",
};

function renderPanel(auth: AuthStatus = AUTH) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <TeamPanel auth={auth} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: "zh-Hans",
    resources: { "zh-Hans": { translation: zh } },
    interpolation: { escapeValue: false },
  });
  // jsdom 没实现 <dialog>.showModal / close
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
});

describe("TeamPanel", () => {
  beforeEach(() => {
    resetCommands();
    calls.length = 0;
  });
  // vitest globals=false：Testing Library 不会自动卸载上一个用例的 DOM
  afterEach(cleanup);

  it("未登录 → 提示先登录", () => {
    mockApi(() => undefined);
    renderPanel({ ...AUTH, loggedIn: false, user: null });
    expect(screen.getByText("登录后查看团队便笺墙。")).toBeTruthy();
  });

  it("没有组织 → 空状态；新建组织 → POST /v1/orgs，之后切到该组织", async () => {
    let orgs: unknown[] = [];
    mockApi((req) => {
      if (req.method === "GET" && req.path === "/v1/orgs") return json({ orgs });
      if (req.method === "POST" && req.path === "/v1/orgs") {
        orgs = [ORG];
        return json(
          {
            org: {
              id: ORG.id,
              name: ORG.name,
              slug: ORG.slug,
              plan: "free",
              seats_paid: 1,
              created_at: ORG.created_at,
              role: "owner",
            },
            default_workspace_id: "019a0000-0000-7000-8000-00000000aa02",
          },
          201,
        );
      }
      if (req.path === "/v1/workspaces") return json({ workspaces: [] });
      return undefined;
    });
    renderPanel();
    expect(await screen.findByText("你还没有加入任何团队。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "新建组织" }));
    fireEvent.change(await screen.findByLabelText("组织名称"), { target: { value: "产品组" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/orgs")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.path === "/v1/orgs")?.jsonBody).toEqual({
      name: "产品组",
    });

    expect(await screen.findByRole("tab", { name: "成员" })).toBeTruthy();
    expect((screen.getByLabelText("当前组织") as HTMLSelectElement).value).toBe("org1");
    expect(screen.getByText("所有者")).toBeTruthy();
  });

  it("成员：改角色 → PATCH /v1/orgs/:id/members/:uid，带 X-Organization-Id", async () => {
    const members = [
      {
        user_id: "u1",
        name: "我",
        email: "me@x.io",
        image: null,
        role: "owner",
        status: "active",
        seat_billable: true,
        joined_at: "2026-01-01T00:00:00.000Z",
      },
      {
        user_id: "u2",
        name: "小王",
        email: "wang@x.io",
        image: null,
        role: "member",
        status: "active",
        seat_billable: true,
        joined_at: "2026-01-02T00:00:00.000Z",
      },
    ];
    mockApi((req) => {
      if (req.method === "GET" && req.path === "/v1/orgs") return json({ orgs: [ORG] });
      if (req.method === "GET" && req.path === "/v1/orgs/org1/members") return json({ members });
      if (req.method === "PATCH" && req.path === "/v1/orgs/org1/members/u2") {
        members[1] = { ...(members[1] as (typeof members)[number]), role: "admin" };
        return json({ user_id: "u2", role: "admin" });
      }
      if (req.path === "/v1/workspaces") return json({ workspaces: [] });
      return undefined;
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("tab", { name: "成员" }));

    const select = (await screen.findByLabelText("修改角色 · 小王")) as HTMLSelectElement;
    // 自己（所有者）没有角色下拉
    expect(screen.queryByLabelText("修改角色 · 我")).toBeNull();
    fireEvent.change(select, { target: { value: "admin" } });

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/v1/orgs/org1/members/u2");
    expect(patch?.jsonBody).toEqual({ role: "admin" });
    expect(patch?.headers).toEqual({ "X-Organization-Id": "org1" });
    // 成员列表也带了组织头
    expect(calls.find((c) => c.path === "/v1/orgs/org1/members")?.headers?.["X-Organization-Id"]).toBe(
      "org1",
    );
    await waitFor(() =>
      expect((screen.getByLabelText("修改角色 · 小王") as HTMLSelectElement).value).toBe("admin"),
    );
  });

  it("邀请：POST 后显示可复制的 invite_url 与提示；待接受列表", async () => {
    let invitations: unknown[] = [];
    mockApi((req) => {
      if (req.method === "GET" && req.path === "/v1/orgs") return json({ orgs: [ORG] });
      if (req.method === "GET" && req.path === "/v1/orgs/org1/invites") return json({ invitations });
      if (req.method === "POST" && req.path === "/v1/orgs/org1/invites") {
        const invitation = {
          id: "inv1",
          email: "wang@x.io",
          role: "member",
          team_id: null,
          status: "pending",
          expires_at: "2026-09-09T00:00:00.000Z",
          created_at: "2026-09-07T00:00:00.000Z",
          inviter_id: "u1",
        };
        invitations = [invitation];
        return json({ invitation, invite_url: "https://bianfa.app/invite/tok_abc" }, 201);
      }
      if (req.path === "/v1/workspaces") return json({ workspaces: [] });
      return undefined;
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("tab", { name: "邀请" }));
    expect(await screen.findByText("没有待接受的邀请。")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "wang@x.io" } });
    fireEvent.click(screen.getByRole("button", { name: "生成邀请链接" }));

    const url = (await screen.findByLabelText("邀请链接", { selector: "input" })) as HTMLInputElement;
    expect(url.value).toBe("https://bianfa.app/invite/tok_abc");
    expect(url.readOnly).toBe(true);
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
    expect(screen.getByText("把链接发给对方，对方在浏览器里打开即可加入。链接 48 小时内有效。")).toBeTruthy();

    const post = calls.find((c) => c.method === "POST" && c.path === "/v1/orgs/org1/invites");
    expect(post?.jsonBody).toEqual({ email: "wang@x.io", role: "member" });
    expect(post?.headers?.["X-Organization-Id"]).toBe("org1");
    // 列表刷新后出现这条待接受邀请
    expect(await screen.findByRole("button", { name: "撤回" })).toBeTruthy();
  });
});
