// src/api/*：线格式（服务端 snake_case / ISO / server_time）→ camelCase / Unix ms 的边界转换。
// 用例里的 JSON 取自 apps/server/test/integration/{api-notes,api-account,auth-flow}.test.ts 断言的形状。
import { beforeEach, describe, expect, it } from "vitest";
import { API_ERROR, apiJson, isApiError, toApiError } from "../api/http.js";
import {
  changeSecurityCode,
  fetchMe,
  listDevices,
  requestCloudExport,
  revokeAllDevices,
  revokeDevice,
  scheduleAccountDeletion,
} from "../api/me.js";
import { fetchAllWorkspaceNotes, fetchNotesSince, mapNote, type RemoteNoteDto } from "../api/notes.js";
import { fetchSharedWithMe } from "../api/shares.js";
import { fetchTeamWall, fetchWorkspaces } from "../api/workspaces.js";
import type { ApiResponse } from "../ipc/types.js";
import { buildCommitItem } from "../windows/settings/ImportWizard.js";
import { invokeMock, mockCommand, resetCommands } from "./setup.js";

const WS = "019a0000-0000-7000-8000-00000000aa01";
const TEAM_WS = "019a0000-0000-7000-8000-00000000aa02";

function noteDto(over: Partial<RemoteNoteDto> = {}): RemoteNoteDto {
  return {
    id: "019a0000-0000-7000-8000-00000000n001",
    workspace_id: WS,
    created_by: "u1",
    title: "标题",
    excerpt: "正文",
    color: "amber",
    z_mode: 0,
    pinned: false,
    schema_version: 1,
    head_seq: 3,
    projected_seq: 3,
    crdt_bytes: 120,
    version: 41,
    encryption: "none",
    created_at: "2026-01-02T03:04:05.000Z",
    updated_at: "2026-01-03T04:05:06.000Z",
    deleted_at: null,
    purge_after: null,
    purged_at: null,
    expires_at: null,
    archived_at: null,
    import_source: null,
    import_external_id: null,
    effective_perm: "manager",
    ...over,
  };
}

type Handler = (req: {
  method: string;
  path: string;
  jsonBody?: unknown;
}) => ApiResponse | Partial<ApiResponse>;
const calls: { method: string; path: string; jsonBody?: unknown }[] = [];

function mockApi(handler: Handler) {
  mockCommand("api_request", (args) => {
    const req = args as { method: string; path: string; jsonBody?: unknown };
    calls.push(req);
    const r = handler(req);
    return { status: 200, headers: {}, bodyText: "", ...r };
  });
}
const json = (body: unknown, status = 200): ApiResponse => ({
  status,
  headers: {},
  bodyText: JSON.stringify(body),
});

describe("api/http", () => {
  beforeEach(() => {
    resetCommands();
    calls.length = 0;
  });

  it("非 2xx → IpcError(code = 服务端 error)；426 → upgrade_required；无 body → http_<status>", () => {
    const e1 = toApiError(
      json({ error: "quota_exceeded", used: 1, limit: 2, request_id: "r1", server_time: 1 }, 409),
    );
    expect(e1.code).toBe(API_ERROR.quotaExceeded);
    expect(isApiError(e1, API_ERROR.quotaExceeded)).toBe(true);
    expect(isApiError(e1) && e1.details.requestId).toBe("r1");
    expect(
      toApiError({
        status: 426,
        headers: {},
        bodyText: '{"error":"upgrade_required","min_supported_version":"1.2"}',
      }).code,
    ).toBe(API_ERROR.upgradeRequired);
    expect(toApiError({ status: 502, headers: {}, bodyText: "<html>" }).code).toBe("http_502");
    expect(toApiError(json({ error: "device_limit_reached", limit: 2 }, 403)).code).toBe(
      API_ERROR.deviceLimit,
    );
  });

  it("apiJson：query 序列化、204 → undefined、JSON 解析", async () => {
    mockApi((req) => (req.method === "DELETE" ? { status: 204 } : json({ ok: true, server_time: 1 })));
    const r = await apiJson<{ ok: boolean }>("GET", "/v1/x", { query: { a: 1, b: undefined, c: "中" } });
    expect(r.ok).toBe(true);
    expect(calls[0]?.path).toBe("/v1/x?a=1&c=%E4%B8%AD");
    expect(await apiJson<undefined>("DELETE", "/v1/notes/n/shares/s")).toBeUndefined();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});

describe("api/notes：发现分页", () => {
  beforeEach(() => {
    resetCommands();
    calls.length = 0;
  });

  it("mapNote：snake_case + ISO → camelCase + ms；缺省字段", () => {
    const { effective_perm: _perm, ...withoutPerm } = noteDto({ deleted_at: "2026-02-01T00:00:00.000Z" });
    const n = mapNote(withoutPerm);
    expect(n.workspaceId).toBe(WS);
    expect(n.zMode).toBe(0);
    expect(n.headSeq).toBe(3);
    expect(n.version).toBe(41);
    expect(n.createdAt).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
    expect(n.updatedAt).toBe(Date.parse("2026-01-03T04:05:06.000Z"));
    expect(n.deletedAt).toBe(Date.parse("2026-02-01T00:00:00.000Z"));
    expect(n.purgedAt).toBeNull();
    expect(n.effectivePerm).toBeNull();
  });

  it("fetchNotesSince：since_version 水位 + next_version / has_more（api-notes.test 的分页形状）", async () => {
    mockApi((req) => {
      const url = new URL(`http://x${req.path}`);
      expect(url.pathname).toBe("/v1/notes");
      expect(url.searchParams.get("workspace_id")).toBe(WS);
      const since = Number(url.searchParams.get("since_version"));
      if (since === 0)
        return json({
          workspace_id: WS,
          effective_perm: "manager",
          notes: [noteDto({ id: "a", version: 10 }), noteDto({ id: "b", version: 12 })],
          next_version: 12,
          has_more: true,
          server_time: 1700000000000,
        });
      return json({
        workspace_id: WS,
        effective_perm: "manager",
        notes: [],
        next_version: since,
        has_more: false,
      });
    });
    const p1 = await fetchNotesSince(WS, 0, 2);
    expect(calls[0]?.path).toContain("limit=2");
    expect(p1.notes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(p1.nextVersion).toBe(12);
    expect(p1.hasMore).toBe(true);
    expect(p1.serverTime).toBe(1700000000000);
    const p2 = await fetchNotesSince(WS, p1.nextVersion);
    expect(p2.notes).toHaveLength(0);
    expect(p2.nextVersion).toBe(12);
    expect(p2.hasMore).toBe(false);
  });

  it("fetchAllWorkspaceNotes：走别名 /v1/workspaces/:id/notes 并按 has_more 翻页", async () => {
    let page = 0;
    mockApi((req) => {
      expect(req.path.startsWith(`/v1/workspaces/${TEAM_WS}/notes?`)).toBe(true);
      page += 1;
      return page === 1
        ? json({
            workspace_id: TEAM_WS,
            notes: [noteDto({ id: "x", version: 5 })],
            next_version: 5,
            has_more: true,
          })
        : json({
            workspace_id: TEAM_WS,
            notes: [noteDto({ id: "y", version: 9 })],
            next_version: 9,
            has_more: false,
          });
    });
    const r = await fetchAllWorkspaceNotes(TEAM_WS);
    expect(r.notes.map((n) => n.id)).toEqual(["x", "y"]);
    expect(r.version).toBe(9);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.path).toContain("since_version=5");
  });
});

describe("api/workspaces：团队墙", () => {
  beforeEach(() => {
    resetCommands();
    calls.length = 0;
  });

  it("fetchWorkspaces 映射 workspaceDto；fetchTeamWall 只取 org 内未归档 team 工作区并剔除回收站", async () => {
    mockApi((req) => {
      if (req.path === "/v1/workspaces")
        return json({
          workspaces: [
            {
              id: WS,
              kind: "personal",
              org_id: null,
              team_id: null,
              owner_user_id: "u1",
              name: "我的便笺",
              default_note_perm: "editor",
              effective_perm: "manager",
              created_at: "2026-01-01T00:00:00.000Z",
              archived_at: null,
            },
            {
              id: TEAM_WS,
              kind: "team",
              org_id: "org1",
              team_id: null,
              owner_user_id: null,
              name: "共享区",
              default_note_perm: "editor",
              effective_perm: "editor",
              created_at: "2026-01-01T00:00:00.000Z",
              archived_at: null,
            },
            {
              id: "019a0000-0000-7000-8000-00000000aa03",
              kind: "team",
              org_id: "org1",
              team_id: null,
              owner_user_id: null,
              name: "旧墙",
              default_note_perm: "editor",
              effective_perm: "editor",
              created_at: "2026-01-01T00:00:00.000Z",
              archived_at: "2026-02-01T00:00:00.000Z",
            },
            {
              id: "019a0000-0000-7000-8000-00000000aa04",
              kind: "team",
              org_id: "org2",
              team_id: null,
              owner_user_id: null,
              name: "别家",
              default_note_perm: "editor",
              effective_perm: "editor",
              created_at: "2026-01-01T00:00:00.000Z",
              archived_at: null,
            },
          ],
        });
      if (req.path.startsWith(`/v1/workspaces/${TEAM_WS}/notes`))
        return json({
          workspace_id: TEAM_WS,
          notes: [
            noteDto({ id: "old", version: 1, updated_at: "2026-01-01T00:00:00.000Z" }),
            noteDto({ id: "trashed", version: 2, deleted_at: "2026-01-05T00:00:00.000Z" }),
            noteDto({ id: "new", version: 3, updated_at: "2026-03-01T00:00:00.000Z" }),
          ],
          next_version: 3,
          has_more: false,
        });
      throw new Error(`unexpected ${req.path}`);
    });
    const list = await fetchWorkspaces();
    expect(list[0]).toMatchObject({ id: WS, kind: "personal", ownerUserId: "u1", effectivePerm: "manager" });
    expect(list[2]?.archivedAt).toBe(Date.parse("2026-02-01T00:00:00.000Z"));

    const wall = await fetchTeamWall("org1");
    expect(wall.workspaces.map((w) => w.id)).toEqual([TEAM_WS]);
    expect(wall.notes.map((n) => n.id)).toEqual(["new", "old"]);
    expect(wall.notes[0]?.workspaceName).toBe("共享区");
    // 没有任何 /v1/orgs/:id/notes 请求
    expect(calls.some((c) => c.path.includes("/orgs/"))).toBe(false);
  });
});

describe("api/me：账号 / 设备 / 删除 / 导出", () => {
  beforeEach(() => {
    resetCommands();
    calls.length = 0;
  });

  it("fetchMe（auth-flow.test 的 /v1/me 形状）", async () => {
    mockApi(() =>
      json({
        user: {
          id: "u1",
          name: "Alice",
          email: "alice@test.invalid",
          email_verified: true,
          image: null,
          created_at: "2026-01-01T00:00:00.000Z",
          ai_opt_in: false,
          two_factor_enabled: false,
        },
        plan: "free",
        personal_workspace_id: WS,
        orgs: [
          {
            id: "org1",
            name: "Acme 便笺",
            slug: "acme",
            plan: "team",
            enterprise_mode: false,
            role: "owner",
            status: "active",
            joined_at: "2026-01-02T00:00:00.000Z",
          },
        ],
        active_devices: 2,
        current_device_id: "dev-1",
        deletion_due_at: null,
        security_code_set_at: "2026-01-05T00:00:00.000Z",
        server_time: 1700000000000,
      }),
    );
    const me = await fetchMe();
    expect(me.user).toMatchObject({ id: "u1", name: "Alice", emailVerified: true, image: null });
    expect(me.personalWorkspaceId).toBe(WS);
    expect(me.orgs[0]).toMatchObject({ id: "org1", role: "owner", status: "active", enterpriseMode: false });
    expect(me.orgs[0]?.joinedAt).toBe(Date.parse("2026-01-02T00:00:00.000Z"));
    expect(me.activeDevices).toBe(2);
    expect(me.currentDeviceId).toBe("dev-1");
    expect(me.deletionDueAt).toBeNull();
    expect(me.securityCodeSetAt).toBe(Date.parse("2026-01-05T00:00:00.000Z"));
  });

  it("changeSecurityCode：POST /v1/me/security-code（新码 trim）→ security_code_set_at；403 invalid_password", async () => {
    mockApi((req) => {
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/v1/me/security-code");
      const body = req.jsonBody as { password: string; new_security_code: string };
      if (body.password !== "hunter22hunter") return json({ error: "invalid_password", server_time: 1 }, 403);
      expect(body.new_security_code).toBe("my new code");
      return json({ security_code_set_at: "2026-02-01T00:00:00.000Z", server_time: 1 });
    });
    const r = await changeSecurityCode({ password: "hunter22hunter", newSecurityCode: "  my new code  " });
    expect(r.securityCodeSetAt).toBe(Date.parse("2026-02-01T00:00:00.000Z"));
    await expect(
      changeSecurityCode({ password: "wrong", newSecurityCode: "my new code" }),
    ).rejects.toMatchObject({ code: API_ERROR.invalidPassword });
  });

  it("设备：列表映射、DELETE /v1/me/devices/:id、revoke-all 带 keep_current", async () => {
    mockApi((req) => {
      if (req.path === "/v1/me/devices")
        return json({
          devices: [
            {
              id: "d1",
              name: "Test Box",
              platform: "linux",
              app_version: "0.1.0",
              last_ip: "10.0.0.1",
              last_seen_at: "2026-01-03T00:00:00.000Z",
              created_at: "2026-01-01T00:00:00.000Z",
              revoked_at: null,
              current: true,
            },
            {
              id: "d2",
              name: "Laptop",
              platform: "macos",
              app_version: "0.1.0",
              last_ip: null,
              last_seen_at: "2026-01-02T00:00:00.000Z",
              created_at: "2026-01-01T00:00:00.000Z",
              revoked_at: "2026-01-04T00:00:00.000Z",
              current: false,
            },
          ],
        });
      if (req.method === "DELETE") return json({ revoked: true, device_id: "d2" });
      if (req.path === "/v1/me/devices/revoke-all") return json({ revoked: ["d2", "d3"], count: 2 });
      throw new Error(req.path);
    });
    const devices = await listDevices();
    expect(devices[0]).toMatchObject({ id: "d1", current: true, revokedAt: null, lastIp: "10.0.0.1" });
    expect(devices[1]?.revokedAt).toBe(Date.parse("2026-01-04T00:00:00.000Z"));
    expect(await revokeDevice("d2")).toEqual({ revoked: true, deviceId: "d2" });
    expect(calls[1]).toMatchObject({ method: "DELETE", path: "/v1/me/devices/d2" });
    expect(await revokeAllDevices({ keepCurrent: true })).toEqual({ revoked: ["d2", "d3"], count: 2 });
    expect(calls[2]?.jsonBody).toEqual({ keep_current: true });
  });

  it("删除账号：confirm=DELETE、202 deletion_due_at；409 transfer_ownership_first 可识别", async () => {
    mockApi(() => json({ deletion_due_at: "2026-03-01T00:00:00.000Z", server_time: 1 }, 202));
    const r = await scheduleAccountDeletion();
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/me/delete",
      jsonBody: { confirm: "DELETE" },
    });
    expect(r.deletionDueAt).toBe(Date.parse("2026-03-01T00:00:00.000Z"));
    resetCommands();
    mockApi(() => json({ error: "transfer_ownership_first", org_id: "org1" }, 409));
    await expect(scheduleAccountDeletion()).rejects.toMatchObject({ code: API_ERROR.transferOwnershipFirst });
  });

  it("云端导出：202 { job_id, status }；24h 内 429 export_rate_limited 附 job_id", async () => {
    mockApi(() => json({ job_id: "j1", status: "queued" }, 202));
    expect(await requestCloudExport()).toEqual({ jobId: "j1", status: "queued" });
    resetCommands();
    mockApi(() =>
      json({ error: "export_rate_limited", job_id: "j1", status: "ready", retry_after: 100 }, 429),
    );
    try {
      await requestCloudExport();
      throw new Error("should throw");
    } catch (e) {
      expect(isApiError(e, API_ERROR.exportRateLimited)).toBe(true);
      expect(isApiError(e) && e.details.body?.job_id).toBe("j1");
    }
  });
});

describe("api/shares", () => {
  beforeEach(() => resetCommands());

  it("shared-with-me：items + next_cursor", async () => {
    mockApi(() =>
      json({
        items: [
          {
            share_id: "s1",
            note_id: "n1",
            workspace_id: WS,
            title: "T",
            color: "teal",
            z_mode: 1,
            permission: "viewer",
            shared_by: { user_id: "u2", name: "Bob" },
            shared_at: "2026-01-01T00:00:00.000Z",
            expires_at: null,
            updated_at: "2026-01-02T00:00:00.000Z",
            version: 7,
            pinned: false,
          },
        ],
        next_cursor: null,
      }),
    );
    const r = await fetchSharedWithMe({ limit: 10 });
    expect(r.items[0]).toMatchObject({
      shareId: "s1",
      permission: "viewer",
      sharedBy: { userId: "u2", name: "Bob" },
    });
    expect(r.nextCursor).toBeNull();
  });
});

describe("import_preview 形状", () => {
  it("buildCommitItem 优先用 Rust 附带的 updated_at_ms，缺失时解析 ISO", () => {
    const base = {
      external_id: "{X}",
      source: "plum.sqlite" as const,
      title: "t",
      markdown: "t",
      text: "t",
      color: "citron" as const,
      original_theme: null,
      pinned: false,
      is_open: false,
      window: null,
      created_at: "2024-01-02T03:04:05Z",
      updated_at: "2024-02-03T04:05:06Z",
      attachments: [],
      has_ink: false,
      content_source: "Text" as const,
      import_degraded: false,
    };
    expect(buildCommitItem({ ...base, created_at_ms: 1, updated_at_ms: 42 }).sourceUpdatedAt).toBe(42);
    // Rust 给 null（无法解析 / 超出 1990–2100）→ 退回 ISO 解析；ISO 也超范围 → null
    expect(buildCommitItem({ ...base, created_at_ms: null, updated_at_ms: null }).sourceUpdatedAt).toBe(
      Date.parse("2024-02-03T04:05:06Z"),
    );
    expect(
      buildCommitItem({ ...base, updated_at: "1900-01-01T00:00:00Z", updated_at_ms: null }).sourceUpdatedAt,
    ).toBeNull();
    expect(buildCommitItem(base).sourceUpdatedAt).toBe(Date.parse("2024-02-03T04:05:06Z"));
  });
});
