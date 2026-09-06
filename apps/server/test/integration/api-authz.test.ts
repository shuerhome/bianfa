// 越权矩阵（规格 04 §5.3 / §5.5）：两个 org × 便笺端点 → 跨租户 404、同 org 权限不足 403、有权 200；
// /v1/* 只认 Bearer（cookie → 401）；/healthz 200；未知 /v1 路径无 Bearer 401。
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, call, seedNote, seedOrg, seedTeam, seedUserV7, type TestApp } from "./api-helpers.js";
import { type Fixture, hasDb, openAdmin, truncateAll } from "./helpers.js";

describe.skipIf(!hasDb)("authorization matrix", () => {
  let f: Fixture;
  let t: TestApp;
  let admin1: { userId: string; workspaceId: string };
  let member1: { userId: string; workspaceId: string };
  let member2: { userId: string; workspaceId: string };
  let outsider: { userId: string; workspaceId: string };
  let org1: { orgId: string; workspaceId: string };
  let org2: { orgId: string; workspaceId: string };
  let teamNote: string;
  let personalNote: string;
  let viewerWs: string;
  let viewerNote: string;

  beforeAll(async () => {
    f = openAdmin();
    await truncateAll(f.admin);
    t = buildTestApp();
    admin1 = await seedUserV7(t.db, "admin1");
    member1 = await seedUserV7(t.db, "member1");
    member2 = await seedUserV7(t.db, "member2");
    outsider = await seedUserV7(t.db, "outsider");
    org1 = await seedOrg(t.db, "org1", [
      { userId: admin1.userId, role: "admin" },
      { userId: member1.userId, role: "member" },
      { userId: member2.userId, role: "member", status: "removed" },
    ]);
    org2 = await seedOrg(t.db, "org2", [{ userId: outsider.userId, role: "owner" }]);
    teamNote = await seedNote(t.db, org1.workspaceId, admin1.userId, "团队便笺\n正文");
    personalNote = await seedNote(t.db, admin1.workspaceId, admin1.userId, "私人便笺\n正文");
    // 默认 viewer 的团队工作区：member 只读
    viewerWs = (
      await t.db.execute(
        sql`INSERT INTO workspaces (id, kind, org_id, name, default_note_perm)
            VALUES (${(await import("../../src/db/ids.js")).uuidv7()}::uuid, 'team', ${org1.orgId}, '只读区', 'viewer') RETURNING id`,
      )
    ).rows[0]?.id as string;
    viewerNote = await seedNote(t.db, viewerWs, admin1.userId, "只读便笺\n正文");
  });

  afterAll(async () => {
    await t.close();
    await truncateAll(f.admin);
    await f.admin.end();
  });

  it("/healthz 200 且带 server_time / X-Request-Id", async () => {
    const r = await call(t, "GET", "/healthz");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, service: "api" });
    expect(typeof r.body.server_time).toBe("number");
    expect(r.headers.get("x-request-id")).toBeTruthy();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("/v1/* 无 Bearer → 401（含 /v1/me 与未知路径）；只带 cookie → 401；错误 token → 401", async () => {
    const me = await call(t, "GET", "/v1/me");
    expect(me.status).toBe(401);
    expect(me.headers.get("www-authenticate")).toContain("invalid_token");
    const cookie = await call(t, "GET", "/v1/workspaces", {
      headers: { cookie: "better-auth.session_token=x" },
    });
    expect(cookie.status).toBe(401);
    expect(cookie.body).toMatchObject({ error: "unauthorized" });
    const bad = await call(t, "GET", "/v1/workspaces", { headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
    const unknown = await call(t, "GET", "/v1/does-not-exist", { as: admin1.userId });
    expect(unknown.status).toBe(404);
  });

  it("GET /v1/workspaces：personal + 可见 team；被移除成员看不到 org 工作区；外人只看到自己的", async () => {
    const a = await call<{ workspaces: { id: string; kind: string; effective_perm: string }[] }>(
      t,
      "GET",
      "/v1/workspaces",
      {
        as: admin1.userId,
      },
    );
    expect(a.status).toBe(200);
    expect(a.body.workspaces.map((w) => w.id).sort()).toEqual(
      [admin1.workspaceId, org1.workspaceId, viewerWs].sort(),
    );
    expect(a.body.workspaces.find((w) => w.id === org1.workspaceId)?.effective_perm).toBe("manager");
    const m = await call<{ workspaces: { id: string; effective_perm: string }[] }>(
      t,
      "GET",
      "/v1/workspaces",
      { as: member1.userId },
    );
    expect(m.body.workspaces.find((w) => w.id === viewerWs)?.effective_perm).toBe("viewer");
    const removed = await call<{ workspaces: { id: string }[] }>(t, "GET", "/v1/workspaces", {
      as: member2.userId,
    });
    expect(removed.body.workspaces.map((w) => w.id)).toEqual([member2.workspaceId]);
    const o = await call<{ workspaces: { id: string }[] }>(t, "GET", "/v1/workspaces", {
      as: outsider.userId,
    });
    expect(o.body.workspaces.map((w) => w.id).sort()).toEqual(
      [outsider.workspaceId, org2.workspaceId].sort(),
    );
  });

  it("团队便笺：外人 404、被移除成员 404、member 200（editor）、admin 200（manager）", async () => {
    expect((await call(t, "GET", `/v1/notes/${teamNote}`, { as: outsider.userId })).status).toBe(404);
    expect((await call(t, "GET", `/v1/notes/${teamNote}`, { as: member2.userId })).status).toBe(404);
    const m = await call<{ note: { effective_perm: string; shares?: unknown } }>(
      t,
      "GET",
      `/v1/notes/${teamNote}`,
      {
        as: member1.userId,
      },
    );
    expect(m.status).toBe(200);
    expect(m.body.note.effective_perm).toBe("editor");
    expect(m.body.note.shares).toBeUndefined();
    const a = await call<{ note: { effective_perm: string; shares: unknown[] } }>(
      t,
      "GET",
      `/v1/notes/${teamNote}`,
      {
        as: admin1.userId,
      },
    );
    expect(a.body.note.effective_perm).toBe("manager");
    expect(Array.isArray(a.body.note.shares)).toBe(true);
  });

  it("同 org 权限不足 → 403 insufficient_permission + required，并写 authz.denied 审计", async () => {
    const r = await call(t, "PATCH", `/v1/notes/${viewerNote}`, {
      as: member1.userId,
      body: { color: "rose" },
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: "insufficient_permission", required: "editor" });
    const shares = await call(t, "GET", `/v1/notes/${teamNote}/shares`, { as: member1.userId });
    expect(shares.status).toBe(403);
    expect(shares.body).toMatchObject({ required: "manager" });
    await new Promise((r) => setTimeout(r, 100));
    const audit = await f.admin.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'authz.denied' AND actor_id = $1 AND outcome = 'denied'",
      [member1.userId],
    );
    expect(audit.rows[0]?.n).toBeGreaterThanOrEqual(2);
  });

  it("个人便笺：他人（同 org 的 admin 也不行）404；所有者 200", async () => {
    const memberPersonal = await seedNote(t.db, member1.workspaceId, member1.userId, "member 私人");
    expect((await call(t, "GET", `/v1/notes/${memberPersonal}`, { as: admin1.userId })).status).toBe(404);
    expect((await call(t, "GET", `/v1/notes/${personalNote}`, { as: member1.userId })).status).toBe(404);
    expect((await call(t, "GET", `/v1/notes/${personalNote}`, { as: admin1.userId })).status).toBe(200);
    expect(
      (await call(t, "PATCH", `/v1/notes/${personalNote}`, { as: admin1.userId, body: { z_mode: 1 } }))
        .status,
    ).toBe(200);
  });

  it("org 级：非成员建工作区 404；member 403 insufficient_role；admin 201", async () => {
    const body = { name: "新区" };
    expect(
      (await call(t, "POST", `/v1/orgs/${org1.orgId}/workspaces`, { as: outsider.userId, body })).status,
    ).toBe(404);
    const m = await call(t, "POST", `/v1/orgs/${org1.orgId}/workspaces`, { as: member1.userId, body });
    expect(m.status).toBe(403);
    expect(m.body).toMatchObject({
      error: "insufficient_role",
      required: { resource: "workspace", action: "create" },
    });
    const a = await call<{ workspace: { id: string; kind: string; effective_perm: string } }>(
      t,
      "POST",
      `/v1/orgs/${org1.orgId}/workspaces`,
      { as: admin1.userId, body: { name: "新区", default_note_perm: "commenter" } },
    );
    expect(a.status).toBe(201);
    expect(a.body.workspace).toMatchObject({ kind: "team", effective_perm: "manager" });
  });

  it("team 限定工作区：非 team 成员的 member 看不到，team 成员可见；admin 始终可见", async () => {
    const teamId = await seedTeam(t.db, org1.orgId, "设计组", [member1.userId]);
    const ws = await call<{ workspace: { id: string } }>(t, "POST", `/v1/orgs/${org1.orgId}/workspaces`, {
      as: admin1.userId,
      body: { name: "设计区", team_id: teamId },
    });
    const wsId = ws.body.workspace.id;
    const note = await seedNote(t.db, wsId, admin1.userId, "设计便笺");
    expect((await call(t, "GET", `/v1/notes/${note}`, { as: member1.userId })).status).toBe(200);
    const other = await seedUserV7(t.db, "member3");
    await t.db.execute(
      sql`INSERT INTO member (id, "organizationId", "userId", role) VALUES (${(await import("../../src/db/ids.js")).uuidv7()}, ${org1.orgId}, ${other.userId}, 'member')`,
    );
    expect((await call(t, "GET", `/v1/notes/${note}`, { as: other.userId })).status).toBe(404);
    expect((await call(t, "GET", `/v1/workspaces/${wsId}/notes`, { as: other.userId })).status).toBe(404);
    expect((await call(t, "GET", `/v1/workspaces/${wsId}/notes`, { as: member1.userId })).status).toBe(200);
  });

  it("零信任校验：非 v7 UUID 与未知字段被拒 400 validation_error", async () => {
    const r = await call(t, "GET", `/v1/notes/${crypto.randomUUID()}`, { as: admin1.userId });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: "validation_error" });
    const extra = await call(t, "PATCH", `/v1/notes/${teamNote}`, {
      as: admin1.userId,
      body: { color: "rose", title: "x" },
    });
    expect(extra.status).toBe(400);
  });
});
