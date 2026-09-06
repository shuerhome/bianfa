import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgotPassword } from "../pages/ForgotPassword.js";

const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

function mockReset(status: number, body: unknown) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "/v1/auth/reset-with-code")
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected fetch ${url}`);
  });
}

function fill(values: Partial<Record<string, string>> = {}) {
  const map: Record<string, string> = {
    邮箱: " Lin@Example.com ",
    安全码: " 我的小狗 Bobo ",
    新密码: "brand-new-pass-1",
    再输一次新密码: "brand-new-pass-1",
    ...values,
  };
  for (const [label, value] of Object.entries(map))
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  calls.length = 0;
  window.history.replaceState(null, "", "/forgot-password");
});
afterEach(() => vi.restoreAllMocks());

describe("/forgot-password", () => {
  it("本地校验：安全码太短 / 两次密码不一致 → 不发请求", async () => {
    mockReset(200, { ok: true });
    render(<ForgotPassword search="" />);
    fill({ 安全码: "ab", 再输一次新密码: "other-pass-123" });
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toEqual(["安全码至少 4 个字符。", "两次输入的密码不一致。"]);
    expect(calls).toHaveLength(0);
  });

  it("安全码错 → 400 invalid_security_code → 提示；限流 429 → 提示", async () => {
    mockReset(400, { error: "invalid_security_code", server_time: 1 });
    render(<ForgotPassword search="" />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("邮箱或安全码不正确。"));
    expect(calls[0]?.url).toBe("/v1/auth/reset-with-code");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      email: "lin@example.com",
      security_code: "我的小狗 Bobo",
      new_password: "brand-new-pass-1",
    });
    expect(calls[0]?.init?.credentials).toBe("omit");

    vi.restoreAllMocks();
    mockReset(429, { error: "rate_limited", retry_after: 60 });
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("操作太频繁了，请稍等几分钟再试。"),
    );
  });

  it("成功 → 「密码已重置」+ 去登录按钮（保留桌面端授权参数）", async () => {
    mockReset(200, { ok: true, revoked_devices: 1, server_time: 1 });
    const search = "?client_id=bianfa-desktop&state=s&sig=abc";
    render(<ForgotPassword search={search} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    await waitFor(() => expect(screen.getByText("密码已重置。")).toBeTruthy());
    const link = screen.getByRole("link", { name: "去登录" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(`/login${search}`);
  });
});
