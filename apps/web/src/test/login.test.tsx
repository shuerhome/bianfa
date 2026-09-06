import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Login } from "../pages/Login.js";

const mocks = vi.hoisted(() => ({
  session: null as unknown,
  signInEmail: vi.fn(),
  signInSocial: vi.fn(),
  $fetch: vi.fn(),
  leaveTo: vi.fn(),
}));

vi.mock("../auth-client.js", () => ({
  authClient: {
    useSession: () => ({ data: mocks.session, isPending: false, refetch: async () => {} }),
    signIn: { email: mocks.signInEmail, social: mocks.signInSocial },
    $fetch: mocks.$fetch,
  },
}));
vi.mock("../lib/external.js", () => ({ leaveTo: mocks.leaveTo }));

function mockConfig(providers: string[]) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) === "/web-config.json")
      return new Response(JSON.stringify({ providers, app_origin: "http://localhost", download_url: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    throw new Error(`unexpected fetch ${String(input)}`);
  });
}

beforeEach(() => {
  mocks.signInEmail.mockReset();
  mocks.signInSocial.mockReset();
  mocks.leaveTo.mockReset();
  mocks.session = null;
  window.history.replaceState(null, "", "/login");
});
afterEach(() => vi.restoreAllMocks());

describe("/login", () => {
  it("邮箱 / 密码本地校验，不发请求", async () => {
    mockConfig([]);
    render(<Login search="" />);
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toEqual(["请输入正确的邮箱地址。", "请输入密码。"]);
    expect(mocks.signInEmail).not.toHaveBeenCalled();
  });

  it("凭据错误 → 提示；成功 → 跳 next", async () => {
    mockConfig([]);
    mocks.signInEmail.mockResolvedValueOnce({
      data: null,
      error: { status: 401, code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
    });
    render(<Login search="?next=%2Fdevice%3Fuser_code%3DABCDEFGH" />);
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: " Lin@Example.com " } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "hunter22" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("邮箱或密码不正确。"));
    expect(mocks.signInEmail).toHaveBeenCalledWith({
      email: "lin@example.com",
      password: "hunter22",
      rememberMe: true,
    });

    mocks.signInEmail.mockResolvedValueOnce({
      data: { redirect: false, token: "t", user: { id: "u1" } },
      error: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(window.location.pathname).toBe("/device"));
    expect(window.location.search).toBe("?user_code=ABCDEFGH");
  });

  it("桌面端授权流程：服务端返回 { redirect: true, url } → 整页跳回 loopback", async () => {
    mockConfig([]);
    const search =
      "?client_id=bianfa-desktop&redirect_uri=http%3A%2F%2F127.0.0.1%3A4567%2Fcb&response_type=code&scope=openid+profile&state=s&exp=1&ba_iat=1&ba_param=client_id&sig=abc";
    window.history.replaceState(null, "", `/login${search}`);
    mocks.signInEmail.mockResolvedValueOnce({
      data: {
        redirect: true,
        url: "http://127.0.0.1:4567/cb?code=xyz&state=s&iss=http%3A%2F%2F127.0.0.1%3A3000",
      },
      error: null,
    });
    render(<Login search={search} />);
    expect(screen.getByText("登录后会自动回到桌面端，不用再做别的。")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "lin@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "hunter22" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() =>
      expect(mocks.leaveTo).toHaveBeenCalledWith(
        "http://127.0.0.1:4567/cb?code=xyz&state=s&iss=http%3A%2F%2F127.0.0.1%3A3000",
      ),
    );
  });

  it("未验证邮箱 → 重发验证邮件", async () => {
    mockConfig([]);
    mocks.signInEmail.mockResolvedValueOnce({
      data: null,
      error: { status: 403, code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
    });
    mocks.$fetch.mockResolvedValueOnce({ data: { status: true }, error: null });
    render(<Login search="" />);
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "lin@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "hunter22" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => screen.getByRole("button", { name: "重发验证邮件" }));
    fireEvent.click(screen.getByRole("button", { name: "重发验证邮件" }));
    await waitFor(() => expect(screen.getByText("验证邮件已重新发送，请查收。")).toBeTruthy());
    expect(mocks.$fetch).toHaveBeenCalledWith("/send-verification-email", {
      method: "POST",
      body: { email: "lin@example.com", callbackURL: "/account" },
    });
  });

  it("社交按钮只按 /web-config.json 出现，点击后整页跳 provider", async () => {
    mockConfig(["google"]);
    mocks.signInSocial.mockResolvedValueOnce({
      data: { url: "https://accounts.google.com/o/oauth2/x", redirect: false },
      error: null,
    });
    render(<Login search="" />);
    const btn = await screen.findByRole("button", { name: "使用 Google 登录" });
    expect(screen.queryByRole("button", { name: "使用 Apple 登录" })).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(mocks.leaveTo).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/x"));
    expect(mocks.signInSocial).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/account",
      errorCallbackURL: "/login?error=social",
      disableRedirect: true,
    });
  });

  it("已登录且不在授权流程 → 直接去 next", async () => {
    mockConfig([]);
    mocks.session = { user: { id: "u1", email: "lin@example.com", name: "Lin", emailVerified: true } };
    render(<Login search="?next=%2Faccount" />);
    await waitFor(() => expect(window.location.pathname).toBe("/account"));
  });
});
