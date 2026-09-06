// claim 幂等 + 个人工作区、sync token 可被 verifySyncToken 校验、notice 204/200、telemetry、
// 通知偏好 / 免打扰、导出入队与查询、工作区 PATCH/归档/删除的 authz_revoked(scope=workspace)。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDirectClient, type DirectClient } from "../../src/db/direct.js";
import { uuidv7 } from "../../src/db/ids.js";
import { verifySyncToken } from "../../src/sync/token.js";
import { buildTestApp, call, seedOrg, seedUserV7, type TestApp, waitFor } from "./api-helpers.js";
import { DIRECT_URL, type Fixture, hasDb, openAdmin, truncateAll } from "./helpers.js";

describe.skipIf(!hasDb)("account-side routes", () => {
  let f: Fixture;
  let t: TestApp;
  let me: { userId: string; workspaceId: string };
  const dir = mkdtempSync(join(tmpdir(), "bianfa-api-"));
  const noticeFile = join(dir, "notice.json");

  beforeAll(async () => {
    f = openAdmin();
    await truncateAll(f.admin);
    t = buildTestApp({ noticeFile });
    me = await seedUserV7(t.db, "me");
  });

  afterAll(async () => {
    await t.close();
    await truncateAll(f.admin);
    await f.admin.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("POST /v1/claim 幂等；无个人工作区的用户自动建一个；别人的 local_user_id → 409", async () => {
    const local = crypto.randomUUID();
    const first = await call<{ personal_workspace_id: string; claimed_before: boolean }>(
      t,
      "POST",
      "/v1/claim",
      {
        as: me.userId,
        body: { local_user_id: local },
      },
    );
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      personal_workspace_id: me.workspaceId,
      claimed_before: false,
      server_time: expect.any(Number),
    });
    const second = await call<{ claimed_before: boolean }>(t, "POST", "/v1/claim", {
      as: me.userId,
      body: { local_user_id: local },
    });
    expect(second.body.claimed_before).toBe(true);

    const fresh = uuidv7();
    await f.admin.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [
      fresh,
      "fresh",
      `fresh-${fresh.slice(-6)}@test.invalid`,
    ]);
    const r = await call<{ personal_workspace_id: string }>(t, "POST", "/v1/claim", {
      as: fresh,
      body: { local_user_id: crypto.randomUUID() },
    });
    expect(r.status).toBe(200);
    const ws = await f.admin.query("SELECT kind, owner_user_id FROM workspaces WHERE id = $1", [
      r.body.personal_workspace_id,
    ]);
    expect(ws.rows[0]).toEqual({ kind: "personal", owner_user_id: fresh });
    const stolen = await call(t, "POST", "/v1/claim", { as: fresh, body: { local_user_id: local } });
    expect(stolen.status).toBe(409);
  });

  it("POST /v1/sync/token → 60 s HS256 JWT，可用 verifySyncToken 校验，claims 含 sub/did/sid/msv", async () => {
    const r = await call<{ token: string; expires_in: number; expires_at: number }>(
      t,
      "POST",
      "/v1/sync/token",
      {
        as: `${me.userId}.dev-1`,
        body: { max_schema_version: 2 },
      },
    );
    expect(r.status).toBe(200);
    expect(r.body.expires_in).toBe(60);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const v = await verifySyncToken(t.env.SYNC_TOKEN_SECRET, r.body.token);
    expect(v.ok).toBe(true);
    if (v.ok)
      expect(v.claims).toMatchObject({ sub: me.userId, did: "dev-1", sid: `sess-${me.userId}`, msv: 2 });
    // 空 body 也可以
    expect((await call(t, "POST", "/v1/sync/token", { as: me.userId })).status).toBe(200);
  });

  it("sync token 限流 30/min/device", async () => {
    let last = 200;
    for (let i = 0; i < 31; i++)
      last = (await call(t, "POST", "/v1/sync/token", { as: `${me.userId}.dev-rl` })).status;
    expect(last).toBe(429);
  });

  it("GET /v1/notice：无文件 204（匿名，cache 300s）；有信封 200；带 cookie 也可访问", async () => {
    const none = await call(t, "GET", "/v1/notice");
    expect(none.status).toBe(204);
    expect(none.headers.get("cache-control")).toBe("public, max-age=300");
    writeFileSync(noticeFile, JSON.stringify({ v: 1, payload: "eyJhY3Rpb24iOiJub3RpY2UifQ", sig: "c2ln" }));
    // loader 按 mtime 缓存 30 s：新建 app 读到新文件
    const t2 = buildTestApp({ noticeFile });
    try {
      const got = await call<{ v: number; payload: string }>(t2, "GET", "/v1/notice", {
        headers: { cookie: "a=b" },
      });
      expect(got.status).toBe(200);
      expect(got.body).toMatchObject({ v: 1, payload: "eyJhY3Rpb24iOiJub3RpY2UifQ" });
    } finally {
      await t2.close();
    }
  });

  it("POST /v1/telemetry：匿名 204；非法计数器 400", async () => {
    const ok = await call(t, "POST", "/v1/telemetry", {
      body: {
        install_id: crypto.randomUUID(),
        platform: "windows",
        counters: { app_start: 1, shrink_guard_tripped: 0 },
      },
    });
    expect(ok.status).toBe(204);
    const bad = await call(t, "POST", "/v1/telemetry", {
      body: { install_id: crypto.randomUUID(), counters: { note_text: 1 } },
    });
    expect(bad.status).toBe(400);
  });

  it("通知偏好与免打扰：PUT 幂等 upsert，GET 回读", async () => {
    const prefs = await call<{ preferences: unknown[] }>(t, "PUT", "/v1/notifications/preferences", {
      as: me.userId,
      body: {
        preferences: [
          { kind: "*", email: "off" },
          { kind: "note.shared", desktop: false },
        ],
      },
    });
    expect(prefs.status).toBe(200);
    expect(prefs.body.preferences).toHaveLength(2);
    await call(t, "PUT", "/v1/notifications/preferences", {
      as: me.userId,
      body: { preferences: [{ kind: "*", email: "instant" }] },
    });
    const quiet = await call<{ quiet_hours: { timezone: string; start_minute: number } }>(
      t,
      "PUT",
      "/v1/notifications/quiet-hours",
      {
        as: me.userId,
        body: { timezone: "Asia/Shanghai", start_minute: 1380, end_minute: 420 },
      },
    );
    expect(quiet.body.quiet_hours).toMatchObject({ timezone: "Asia/Shanghai", start_minute: 1380 });
    const got = await call<{
      preferences: { kind: string; email: string }[];
      quiet_hours: { timezone: string };
    }>(t, "GET", "/v1/notifications/preferences", { as: me.userId });
    expect(got.body.preferences.find((p) => p.kind === "*")?.email).toBe("instant");
    expect(got.body.quiet_hours.timezone).toBe("Asia/Shanghai");
    expect(
      (await call(t, "PUT", "/v1/notifications/quiet-hours", { as: me.userId, body: { start_minute: 1440 } }))
        .status,
    ).toBe(400);
  });

  it("导出：POST 入队 export.build（202）+ 24h 内重复 429；GET 状态只对本人可见", async () => {
    const r = await call<{ job_id: string; status: string }>(t, "POST", "/v1/me/export", { as: me.userId });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("queued");
    expect(t.queue.sent.at(-1)).toMatchObject({
      name: "export.build",
      data: { job_id: r.body.job_id, user_id: me.userId },
    });
    const again = await call(t, "POST", "/v1/me/export", { as: me.userId });
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ error: "export_rate_limited", job_id: r.body.job_id });
    const job = await call<{ job: { id: string; status: string; download_url: string | null } }>(
      t,
      "GET",
      `/v1/me/export/${r.body.job_id}`,
      {
        as: me.userId,
      },
    );
    expect(job.body.job).toMatchObject({ id: r.body.job_id, status: "queued", download_url: null });
    const other = await seedUserV7(t.db, "other");
    expect((await call(t, "GET", `/v1/me/export/${r.body.job_id}`, { as: other.userId })).status).toBe(404);
    const audit = await f.admin.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'export.requested' AND actor_id = $1",
      [me.userId],
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it("附件：R2 未配置 → 503 attachments_disabled", async () => {
    const r = await call(t, "POST", "/v1/attachments/presign", {
      as: me.userId,
      body: {
        attachment_id: uuidv7(),
        workspace_id: me.workspaceId,
        hash: "ab".repeat(32),
        size: 1024,
        mime: "image/png",
      },
    });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: "attachments_disabled" });
  });

  it("工作区：personal 只能改名；team PATCH default_note_perm 降级 / 归档 / 删除 → 成员收到 authz_revoked(scope=workspace)", async () => {
    const direct: DirectClient = createDirectClient({
      connectionString: DIRECT_URL as string,
      reconnectBaseMs: 50,
    });
    const revoked: { user_id: string; scope: string; id: string }[] = [];
    await direct.listen("authz_revoked", (p) => revoked.push(JSON.parse(p)));
    await direct.waitConnected();
    try {
      const rename = await call<{ workspace: { name: string } }>(
        t,
        "PATCH",
        `/v1/workspaces/${me.workspaceId}`,
        {
          as: me.userId,
          body: { name: "我的便笺" },
        },
      );
      expect(rename.status).toBe(200);
      expect(rename.body.workspace.name).toBe("我的便笺");
      expect(
        (
          await call(t, "PATCH", `/v1/workspaces/${me.workspaceId}`, {
            as: me.userId,
            body: { default_note_perm: "viewer" },
          })
        ).status,
      ).toBe(400);
      expect(
        (await call(t, "POST", `/v1/workspaces/${me.workspaceId}/archive`, { as: me.userId })).status,
      ).toBe(409);

      const mate = await seedUserV7(t.db, "mate");
      const org = await seedOrg(t.db, "org", [
        { userId: me.userId, role: "owner" },
        { userId: mate.userId, role: "member" },
      ]);
      const down = await call<{ workspace: { default_note_perm: string } }>(
        t,
        "PATCH",
        `/v1/workspaces/${org.workspaceId}`,
        {
          as: me.userId,
          body: { default_note_perm: "viewer" },
        },
      );
      expect(down.status).toBe(200);
      expect(down.body.workspace.default_note_perm).toBe("viewer");
      await waitFor(() =>
        revoked.some((r) => r.user_id === mate.userId && r.scope === "workspace" && r.id === org.workspaceId),
      );
      expect(
        (
          await call(t, "PATCH", `/v1/workspaces/${org.workspaceId}`, {
            as: mate.userId,
            body: { name: "x" },
          })
        ).status,
      ).toBe(403);

      const archived = await call<{ workspace: { archived_at: string } }>(
        t,
        "POST",
        `/v1/workspaces/${org.workspaceId}/archive`,
        { as: me.userId },
      );
      expect(archived.status).toBe(200);
      expect(archived.body.workspace.archived_at).toBeTruthy();
      expect(
        (
          await call(t, "POST", "/v1/notes", {
            as: me.userId,
            body: { id: uuidv7(), workspace_id: org.workspaceId },
          })
        ).status,
      ).toBe(409);

      const del = await call(t, "DELETE", `/v1/workspaces/${org.workspaceId}`, { as: me.userId });
      expect(del.status).toBe(204);
      const list = await call<{ workspaces: { id: string }[] }>(t, "GET", "/v1/workspaces", {
        as: mate.userId,
      });
      expect(list.body.workspaces.map((w) => w.id)).not.toContain(org.workspaceId);
      const events = await f.admin.query(
        "SELECT action FROM audit_log WHERE target_id = $1 AND action IN ('workspace.archived','workspace.deleted') ORDER BY id",
        [org.workspaceId],
      );
      expect(events.rows.map((r) => r.action)).toEqual(["workspace.archived", "workspace.deleted"]);
    } finally {
      await direct.close();
    }
  });
});
