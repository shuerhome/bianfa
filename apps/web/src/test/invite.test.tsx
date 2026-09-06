import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Invite } from "../pages/Invite.js";

const mocks = vi.hoisted(() => ({
  session: null as unknown,
  $fetch: vi.fn(),
  signOut: vi.fn(async () => ({ data: { success: true }, error: null })),
}));

vi.mock("../auth-client.js", () => ({
  authClient: {
    useSession: () => ({ data: mocks.session, isPending: false, refetch: async () => {} }),
    $fetch: mocks.$fetch,
    signOut: mocks.signOut,
  },
}));

const PREVIEW = {
  invitation: {
    org_name: "设计组",
    inviter_name: "Lin",
    role: "admin",
    expires_at: "2026-09-08T00:00:00.000Z",
  },
};

function mockPreview(status: number, body: unknown) {
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("/v1/invites/") && url.endsWith("/preview")) {
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return spy;
}

beforeEach(() => {
  mocks.$fetch.mockReset();
  mocks.session = null;
  window.history.replaceState(null, "", "/invite/tok_abc");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("/invite/:token", () => {
  it("404 预览 → 无效 / 过期状态", async () => {
    mockPreview(404, { error: "not_found" });
    render(<Invite token="tok_abc" />);
    await waitFor(() => expect(screen.getByText("邀请无效或已过期")).toBeTruthy());
  });

  it("未登录：展示 org / 邀请人 / 角色 + 登录 / 注册按钮（带 next）", async () => {
    mockPreview(200, PREVIEW);
    render(<Invite token="tok_abc" />);
    await waitFor(() => expect(screen.getByText("设计组")).toBeTruthy());
    expect(screen.getByText("Lin")).toBeTruthy();
    expect(screen.getByText("管理员")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "登录后接受" }));
    expect(window.location.pathname).toBe("/login");
    expect(new URLSearchParams(window.location.search).get("next")).toBe("/invite/tok_abc");
  });

  it("已登录：接受 → POST organization/accept-invitation { invitationId: token } → 成功", async () => {
    mocks.session = { user: { id: "u1", email: "me@example.com", name: "Me", emailVerified: true } };
    mockPreview(200, PREVIEW);
    mocks.$fetch.mockResolvedValueOnce({
      data: {
        invitation: { id: "inv1", status: "accepted" },
        member: { organization_id: "o1", user_id: "u1", role: "admin", team_id: null },
        organization: { id: "o1", name: "设计组", slug: "design" },
      },
      error: null,
    });
    render(<Invite token="tok_abc" />);
    await waitFor(() => screen.getByRole("button", { name: "接受邀请" }));
    fireEvent.click(screen.getByRole("button", { name: "接受邀请" }));
    await waitFor(() => expect(screen.getByText("已加入「设计组」")).toBeTruthy());
    expect(mocks.$fetch).toHaveBeenCalledWith("/organization/accept-invitation", {
      method: "POST",
      body: { invitationId: "tok_abc" },
    });
  });

  it("邮箱不匹配 → 提示 + 换个账号", async () => {
    mocks.session = { user: { id: "u1", email: "other@example.com", name: "Me", emailVerified: true } };
    mockPreview(200, PREVIEW);
    mocks.$fetch.mockResolvedValueOnce({
      data: null,
      error: { status: 403, code: "invitation_email_mismatch", message: "invitation_email_mismatch" },
    });
    render(<Invite token="tok_abc" />);
    await waitFor(() => screen.getByRole("button", { name: "接受邀请" }));
    fireEvent.click(screen.getByRole("button", { name: "接受邀请" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("另一个邮箱"));
    fireEvent.click(screen.getByRole("button", { name: "换个账号" }));
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalled());
  });

  it("拒绝 → reject-invitation", async () => {
    mocks.session = { user: { id: "u1", email: "me@example.com", name: "Me", emailVerified: true } };
    mockPreview(200, PREVIEW);
    mocks.$fetch.mockResolvedValueOnce({
      data: { invitation: { id: "inv1", status: "rejected" } },
      error: null,
    });
    render(<Invite token="tok_abc" />);
    await waitFor(() => screen.getByRole("button", { name: "拒绝" }));
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(screen.getByText("已拒绝邀请")).toBeTruthy());
    expect(mocks.$fetch).toHaveBeenCalledWith("/organization/reject-invitation", {
      method: "POST",
      body: { invitationId: "tok_abc" },
    });
  });
});
