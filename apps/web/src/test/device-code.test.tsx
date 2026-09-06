import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatUserCode, normalizeUserCode } from "../lib/validation.js";
import { Device } from "../pages/Device.js";

const mocks = vi.hoisted(() => ({
  session: { user: { id: "u1", email: "lin@example.com", name: "Lin", emailVerified: true } } as unknown,
  pending: false,
  $fetch: vi.fn(),
}));

vi.mock("../auth-client.js", () => ({
  authClient: {
    useSession: () => ({ data: mocks.session, isPending: mocks.pending, refetch: async () => {} }),
    $fetch: mocks.$fetch,
  },
}));

const CLAIM = {
  user_code: "ABCDEFGH",
  status: "pending",
  client_id: "bianfa-desktop",
  scope: "openid profile email offline_access",
};

beforeEach(() => {
  mocks.$fetch.mockReset();
  window.history.replaceState(null, "", "/device");
});

describe("设备码工具", () => {
  it("归一化：去分隔符、大写；展示 XXXX-XXXX", () => {
    expect(normalizeUserCode(" ab-cd ef_gh ")).toBe("ABCDEFGH");
    expect(formatUserCode("abcdefgh")).toBe("ABCD-EFGH");
    expect(formatUserCode("abc")).toBe("ABC");
    expect(formatUserCode("abcdefghXYZ")).toBe("ABCD-EFGH");
  });
});

describe("/device", () => {
  it("从 ?user_code= 预填并格式化", () => {
    render(<Device search="?user_code=abcd-efgh" />);
    expect((screen.getByLabelText("代码") as HTMLInputElement).value).toBe("ABCD-EFGH");
  });

  it("长度不对时本地报错，不请求服务端", () => {
    render(<Device search="" />);
    fireEvent.change(screen.getByLabelText("代码"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(screen.getByRole("alert").textContent).toContain("8 位");
    expect(mocks.$fetch).not.toHaveBeenCalled();
  });

  it("认领 → 展示客户端与权限 → 允许 → 「可以回到桌面端了」", async () => {
    mocks.$fetch.mockImplementation(async (path: string) => {
      if (path === "/device") return { data: CLAIM, error: null };
      if (path === "/device/approve") return { data: { status: "approved" }, error: null };
      throw new Error(`unexpected ${path}`);
    });
    render(<Device search="?user_code=ABCD-EFGH" />);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(screen.getByText("bianfa 桌面端", { exact: false })).toBeTruthy());
    expect(mocks.$fetch).toHaveBeenCalledWith("/device", { method: "GET", query: { user_code: "ABCDEFGH" } });
    expect(screen.getByText("在你不在时保持登录（同步便笺）")).toBeTruthy();
    expect(screen.getByText("lin@example.com")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "允许" }));
    });
    await waitFor(() => expect(screen.getByText("可以回到桌面端了")).toBeTruthy());
    expect(mocks.$fetch).toHaveBeenCalledWith("/device/approve", {
      method: "POST",
      body: { userCode: "ABCDEFGH" },
    });
  });

  it("拒绝 → 已拒绝", async () => {
    mocks.$fetch.mockImplementation(async (path: string) => {
      if (path === "/device") return { data: CLAIM, error: null };
      if (path === "/device/deny") return { data: { status: "denied" }, error: null };
      throw new Error(`unexpected ${path}`);
    });
    render(<Device search="?user_code=ABCDEFGH" />);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => screen.getByRole("button", { name: "拒绝" }));
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(screen.getByText("已拒绝")).toBeTruthy());
    expect(mocks.$fetch).toHaveBeenCalledWith("/device/deny", {
      method: "POST",
      body: { userCode: "ABCDEFGH" },
    });
  });

  it("过期码 → 过期页；未知码 → 字段错误", async () => {
    mocks.$fetch.mockResolvedValueOnce({ data: null, error: { status: 400, error: "expired_token" } });
    const { unmount } = render(<Device search="?user_code=ABCDEFGH" />);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(screen.getByText("这个代码已经过期")).toBeTruthy());
    unmount();

    mocks.$fetch.mockResolvedValueOnce({ data: null, error: { status: 400, error: "invalid_request" } });
    render(<Device search="?user_code=ZZZZZZZZ" />);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("没有这个代码"));
  });

  it("被其他账号认领（无 client_id）→ 提示换码", async () => {
    mocks.$fetch.mockResolvedValueOnce({ data: { user_code: "ABCDEFGH", status: "pending" }, error: null });
    render(<Device search="?user_code=ABCDEFGH" />);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(screen.getByText("这个代码已被其他账号使用")).toBeTruthy());
  });

  it("未登录 → 跳 /login?next=/device?user_code=…", async () => {
    mocks.session = null;
    try {
      render(<Device search="?user_code=ABCDEFGH" />);
      await waitFor(() => expect(window.location.pathname).toBe("/login"));
      expect(new URLSearchParams(window.location.search).get("next")).toBe("/device?user_code=ABCDEFGH");
    } finally {
      mocks.session = { user: { id: "u1", email: "lin@example.com", name: "Lin", emailVerified: true } };
    }
  });
});
