// 共享对话框：GET 列表；按邮箱 PUT 添加；DELETE 撤销；服务端错误码 → 友好文案。
import { ToastProvider } from "@bianfa/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import zh from "../i18n/zh-Hans.json";
import type { ApiResponse } from "../ipc/types.js";
import { ShareDialog } from "../windows/main/team/ShareDialog.js";
import { mockCommand, resetCommands } from "./setup.js";

interface Req {
  method: string;
  path: string;
  jsonBody?: unknown;
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

const NOTE = "019a0000-0000-7000-8000-00000000c001";
const shareDto = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  note_id: NOTE,
  grantee_kind: "user",
  grantee: { user_id: "u2", name: "小王", email: "wang@x.io" },
  permission: "viewer",
  created_by: "u1",
  created_at: "2026-01-01T00:00:00.000Z",
  expires_at: null,
  ...over,
});

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ShareDialog open noteId={NOTE} noteTitle="周三 产品评审" onClose={() => undefined} />
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

describe("ShareDialog", () => {
  beforeEach(() => {
    resetCommands();
    calls.length = 0;
  });
  // vitest globals=false：Testing Library 不会自动卸载上一个用例的 DOM
  afterEach(cleanup);

  it("列出已共享；按邮箱添加 → PUT；撤销 → DELETE", async () => {
    let shares = [shareDto()];
    mockApi((req) => {
      if (req.method === "GET" && req.path === `/v1/notes/${NOTE}/shares`) return json({ shares });
      if (req.method === "PUT" && req.path === `/v1/notes/${NOTE}/shares`) {
        const s = shareDto({
          id: "s2",
          grantee: { user_id: "u3", name: null, email: "li@x.io" },
          permission: "editor",
        });
        shares = [...shares, s];
        return json({ share: s, changed: true }, 201);
      }
      if (req.method === "DELETE" && req.path === `/v1/notes/${NOTE}/shares/s1`) {
        shares = shares.filter((s) => s.id !== "s1");
        return { status: 204 };
      }
      return undefined;
    });
    renderDialog();
    expect(await screen.findByText("小王")).toBeTruthy();
    expect(screen.getByText("共享便笺 · 周三 产品评审")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "li@x.io" } });
    fireEvent.change(screen.getByLabelText("权限"), { target: { value: "editor" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.jsonBody).toEqual({
      grantee_kind: "user",
      permission: "editor",
      email: "li@x.io",
    });
    expect(await screen.findByText("li@x.io")).toBeTruthy();
    expect((screen.getByLabelText("权限 · li@x.io") as HTMLSelectElement).value).toBe("editor");

    const row = screen.getByText("小王").closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "取消共享" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")?.path).toBe(`/v1/notes/${NOTE}/shares/s1`);
    await waitFor(() => expect(screen.queryByText("小王")).toBeNull());
  });

  it("空列表；user_not_found / insufficient_permission → 友好文案", async () => {
    let putStatus: { code: string; status: number } = { code: "user_not_found", status: 404 };
    mockApi((req) => {
      if (req.method === "GET") return json({ shares: [] });
      if (req.method === "PUT") return json({ error: putStatus.code, request_id: "r1" }, putStatus.status);
      return undefined;
    });
    renderDialog();
    expect(await screen.findByText("还没有共享给任何人。")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "nobody@x.io" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("没有找到这个邮箱对应的用户");

    putStatus = { code: "insufficient_permission", status: 403 };
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "wang@x.io" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("只有便笺的管理者才能共享"));
  });
});
