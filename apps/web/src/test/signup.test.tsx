import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Signup } from "../pages/Signup.js";

const mocks = vi.hoisted(() => ({
  signUpEmail: vi.fn(),
  leaveTo: vi.fn(),
}));

vi.mock("../auth-client.js", () => ({
  authClient: { signUp: { email: mocks.signUpEmail } },
}));
vi.mock("../lib/external.js", () => ({ leaveTo: mocks.leaveTo }));

const OAUTH_SEARCH =
  "?client_id=bianfa-desktop&redirect_uri=http%3A%2F%2F127.0.0.1%3A4567%2Fcb&response_type=code&scope=openid+profile&state=s&exp=1&ba_iat=1&ba_param=client_id&sig=abc";

function fill(values: Partial<Record<string, string>>) {
  const map: Record<string, string> = {
    名字: "Lin",
    邮箱: " Lin@Example.com ",
    密码: "hunter22hunter",
    再输一次密码: "hunter22hunter",
    安全码: "  我的小狗 Bobo  ",
    再输一次安全码: "我的小狗 Bobo",
    ...values,
  };
  for (const [label, value] of Object.entries(map))
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  mocks.signUpEmail.mockReset();
  mocks.leaveTo.mockReset();
  window.history.replaceState(null, "", "/signup");
});
afterEach(() => vi.restoreAllMocks());

describe("/signup", () => {
  it("安全码与密码相同 / 两次安全码不一致 / 两次密码不一致 → 本地报错，不发请求", async () => {
    render(<Signup search="" />);
    expect(screen.getByText("安全码只在忘记密码时使用，请记住它。", { exact: false })).toBeTruthy();
    fill({ 安全码: "hunter22hunter", 再输一次安全码: "hunter22hunter", 再输一次密码: "nope-nope-nope" });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toEqual(["两次输入的密码不一致。", "安全码不能和密码相同。"]);
    expect(mocks.signUpEmail).not.toHaveBeenCalled();

    fill({ 再输一次安全码: "different" });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    await waitFor(() =>
      expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual(["两次输入的安全码不一致。"]),
    );
    expect(mocks.signUpEmail).not.toHaveBeenCalled();

    fill({ 安全码: " ab ", 再输一次安全码: "ab" });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    await waitFor(() =>
      expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual(["安全码至少 4 个字符。"]),
    );
    expect(mocks.signUpEmail).not.toHaveBeenCalled();
  });

  it("注册成功（无授权流程）→ body 带 trim 后的 securityCode，直接进 next，没有「去邮箱验证」页", async () => {
    mocks.signUpEmail.mockResolvedValueOnce({ data: { token: "t", user: { id: "u1" } }, error: null });
    render(<Signup search="?next=%2Fdevice%3Fuser_code%3DABCDEFGH" />);
    fill({});
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    await waitFor(() => expect(window.location.pathname).toBe("/device"));
    expect(window.location.search).toBe("?user_code=ABCDEFGH");
    expect(mocks.signUpEmail).toHaveBeenCalledWith({
      name: "Lin",
      email: "lin@example.com",
      password: "hunter22hunter",
      securityCode: "我的小狗 Bobo",
    });
    expect(screen.queryByText("去邮箱验证一下")).toBeNull();
    expect(mocks.leaveTo).not.toHaveBeenCalled();
  });

  it("桌面端授权流程：服务端返回 { redirect: true, url } → 整页跳回 loopback", async () => {
    window.history.replaceState(null, "", `/signup${OAUTH_SEARCH}`);
    mocks.signUpEmail.mockResolvedValueOnce({
      data: { redirect: true, url: "http://127.0.0.1:4567/cb?code=xyz&state=s" },
      error: null,
    });
    render(<Signup search={OAUTH_SEARCH} />);
    expect(screen.getByText("注册完成后会自动回到桌面端。不需要验证邮箱。")).toBeTruthy();
    fill({});
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    await waitFor(() =>
      expect(mocks.leaveTo).toHaveBeenCalledWith("http://127.0.0.1:4567/cb?code=xyz&state=s"),
    );
  });

  it("桌面端授权流程但响应没带 redirect → 带着新会话重新 authorize", async () => {
    window.history.replaceState(null, "", `/signup${OAUTH_SEARCH}`);
    mocks.signUpEmail.mockResolvedValueOnce({ data: { token: "t", user: { id: "u1" } }, error: null });
    render(<Signup search={OAUTH_SEARCH} />);
    fill({});
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    await waitFor(() => expect(mocks.leaveTo).toHaveBeenCalledTimes(1));
    const url = String(mocks.leaveTo.mock.calls[0]?.[0]);
    expect(url.startsWith("/api/auth/oauth2/authorize?")).toBe(true);
    const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(q.get("client_id")).toBe("bianfa-desktop");
    expect(q.get("state")).toBe("s");
    expect(q.has("sig")).toBe(false);
  });

  it("服务端错误码（已注册 / 安全码规则）→ 文案", async () => {
    mocks.signUpEmail.mockResolvedValueOnce({
      data: null,
      error: { status: 422, code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", message: "exists" },
    });
    render(<Signup search="" />);
    fill({});
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("这个邮箱已经注册过了，直接登录即可。"),
    );
    mocks.signUpEmail.mockResolvedValueOnce({
      data: null,
      error: { status: 400, code: "SECURITY_CODE_EQUALS_PASSWORD", message: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("安全码不能和密码相同。"));
  });
});
