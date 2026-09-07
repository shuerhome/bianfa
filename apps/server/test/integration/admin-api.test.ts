// /v1/admin/*（迁移 0009）：闸门矩阵、只读查看内容、冻结/解冻、改密码的前置判断、审计。
//
// 服务端连接是 NOBYPASSRLS 的 bianfa_rls_test（见 admin-helpers.ts）：所以「管理员看到的范围 =
// 目标用户自己能看到的范围」是真的由 RLS 决定的，而不是测试自己写了一遍可见性逻辑。
// 需要真实 Better Auth 的部分（冻结后登录被拒、改密后旧/新密码）在 admin-account-flow.test.ts。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAudit } from "../../src/auth/services/audit-query.js";
import { closeDb } from "../../src/db/client.js";
import { createDirectClient, type DirectClient } from "../../src/db/direct.js";
import { uuidv7 } from "../../src/db/ids.js";
import {
  type AdminHarness,
  adminEndpoints,
  grantPlatformAdmin,
  openHarness,
  req,
  resetRateLimit,
  seedNote,
  seedWorkspace,
} from "./admin-helpers.js";
import { seedOrg, seedTeam, seedUserV7, waitFor } from "./api-helpers.js";
import { DIRECT_URL, type Fixture, hasDb, openAdmin, truncateAll } from "./helpers.js";

/** E2EE 便笺的 content_text 里塞一个记号：断言它一个字节都不会出现在响应里 */
const E2EE_MARKER = "这段明文永远不该出现在管理台";

interface AdminNote {
  id: string;
  workspace_id: string;
  workspace_name: string;
  excerpt: string;
  readable: boolean;
  unreadable_reason: string | null;
  deleted: boolean;
}

describe.skipIf(!hasDb)("/v1/admin/*（平台总管理员）", () => {
  let f: Fixture;
  let h: AdminHarness;
  /** PLATFORM_ADMIN_ENABLED=0 的第二套装配 */
  let off: AdminHarness;
  let direct: DirectClient;
  const revoked: Array<{ user_id: string; scope: string; id: string }> = [];

  let superAdmin: { userId: string; workspaceId: string };
  let admin2: { userId: string; workspaceId: string };
  let target: { userId: string; workspaceId: string };
  let other: { userId: string; workspaceId: string };
  let orgWs: string;
  let teamWs: string;
  let teamId: string;
  let orgId: string;
  const notes = {
    personal: "",
    org: "",
    team: "",
    e2ee: "",
    deleted: "",
    other: "",
  };

  beforeAll(async () => {
    resetRateLimit();
    f = openAdmin();
    await truncateAll(f.admin);
    await f.admin.query('TRUNCATE audit_log, "deviceCode" RESTART IDENTITY CASCADE');
    h = openHarness();
    off = openHarness({ enabled: false });

    superAdmin = await seedUserV7(f.adminDb, "super");
    admin2 = await seedUserV7(f.adminDb, "super2");
    target = await seedUserV7(f.adminDb, "target");
    other = await seedUserV7(f.adminDb, "other");
    await grantPlatformAdmin(f.admin, superAdmin.userId);
    await grantPlatformAdmin(f.admin, admin2.userId);

    // 组织：target 与 other 都是成员 → 组织级共享区两人都看得见
    const org = await seedOrg(f.adminDb, "acme", [
      { userId: target.userId, role: "member" },
      { userId: other.userId, role: "member" },
    ]);
    orgId = org.orgId;
    orgWs = org.workspaceId;
    // 团队工作区：只有团队成员看得见（RLS 里 team_id 那一支）
    teamId = await seedTeam(f.adminDb, orgId, "小队", [target.userId]);
    teamWs = await seedWorkspace(f.adminDb, {
      kind: "team",
      orgId,
      teamId,
      name: "小队的便笺",
    });

    notes.personal = await seedNote(f.adminDb, {
      workspaceId: target.workspaceId,
      createdBy: target.userId,
      text: "私人清单\n牛奶 鸡蛋",
    });
    notes.org = await seedNote(f.adminDb, {
      workspaceId: orgWs,
      createdBy: other.userId,
      text: "组织公告\n周五团建",
    });
    notes.team = await seedNote(f.adminDb, {
      workspaceId: teamWs,
      createdBy: target.userId,
      text: "小队周会\n下周一改期",
    });
    notes.e2ee = await seedNote(f.adminDb, {
      workspaceId: target.workspaceId,
      createdBy: target.userId,
      text: E2EE_MARKER,
      encryption: "e2ee",
    });
    notes.deleted = await seedNote(f.adminDb, {
      workspaceId: target.workspaceId,
      createdBy: target.userId,
      text: "回收站里的便笺\n正文",
      deleted: true,
    });
    // 第三个用户的私有便笺：target 看不见 → 管理员也必须看不见
    notes.other = await seedNote(f.adminDb, {
      workspaceId: other.workspaceId,
      createdBy: other.userId,
      text: "别人的私密便笺\n不该被看到",
    });

    direct = createDirectClient({ connectionString: DIRECT_URL as string, reconnectBaseMs: 50 });
    await direct.listen("authz_revoked", (payload) => revoked.push(JSON.parse(payload)));
    await direct.waitConnected();
  });

  afterAll(async () => {
    await direct?.close();
    await h?.close();
    await off?.close();
    await truncateAll(f.admin);
    await f.admin.end();
    await closeDb();
  });

  // ─────────────────────────────────────────── 闸门

  it("未带 Bearer：/v1/admin/* 每个端点都是 401", async () => {
    for (const e of adminEndpoints(target.userId, notes.personal)) {
      const r = await req(h.app, e.method, e.path, e.body === undefined ? {} : { body: e.body });
      expect(r.status, `${e.method} ${e.path}`).toBe(401);
      expect(r.body, `${e.method} ${e.path}`).toMatchObject({ error: "unauthorized" });
    }
  });

  it("普通已登录用户：每个端点 403 insufficient_role，且各留下一条 authz.denied 审计", async () => {
    const endpoints = adminEndpoints(target.userId, notes.personal);
    for (const e of endpoints) {
      const r = await req(h.app, e.method, e.path, {
        as: other.userId,
        ...(e.body === undefined ? {} : { body: e.body }),
      });
      expect(r.status, `${e.method} ${e.path}`).toBe(403);
      expect(r.body, `${e.method} ${e.path}`).toMatchObject({
        error: "insufficient_role",
        required: "platform_admin",
      });
    }
    const denied = await f.admin.query(
      `SELECT metadata->>'path' AS path, metadata->>'method' AS method, outcome, target_type
         FROM audit_log WHERE action = 'authz.denied' AND actor_id = $1`,
      [other.userId],
    );
    expect(denied.rows).toHaveLength(endpoints.length);
    for (const row of denied.rows as Array<Record<string, string>>) {
      expect(row.outcome).toBe("denied");
      expect(row.target_type).toBe("platform_admin");
    }
    const seen = (denied.rows as Array<{ method: string; path: string }>).map((r) => `${r.method} ${r.path}`);
    expect(seen.sort()).toEqual(endpoints.map((e) => `${e.method} ${e.path}`).sort());
    // 而且真的什么也没做：目标既没被冻结，密码也没被改
    const u = await f.admin.query('SELECT frozen_at, banned FROM "user" WHERE id = $1', [target.userId]);
    expect(u.rows[0]).toMatchObject({ frozen_at: null, banned: false });
    expect(h.passwordsSet).toHaveLength(0);
  });

  it("PLATFORM_ADMIN_ENABLED=0：管理员访问每个端点都是 404（这个部署里它确实不存在）", async () => {
    for (const e of adminEndpoints(target.userId, notes.personal)) {
      const r = await req(off.app, e.method, e.path, {
        as: superAdmin.userId,
        ...(e.body === undefined ? {} : { body: e.body }),
      });
      expect(r.status, `${e.method} ${e.path}`).toBe(404);
      expect(r.body, `${e.method} ${e.path}`).toMatchObject({ error: "not_found" });
    }
    // 同一套 app 的非管理端点照常工作 —— 闸门只关了 /v1/admin
    const me = await req(off.app, "GET", "/v1/me", { as: superAdmin.userId });
    expect(me.status).toBe(200);
  });

  // ─────────────────────────────────────────── 找人

  it("GET /v1/admin/users：按邮箱搜、标出总管理员；并留下 admin.user_listed 审计", async () => {
    const r = await req<{ users: Array<{ id: string; is_platform_admin: boolean; frozen: boolean }> }>(
      h.app,
      "GET",
      "/v1/admin/users?q=target",
      { as: superAdmin.userId },
    );
    expect(r.status).toBe(200);
    expect(r.body.users.map((u) => u.id)).toEqual([target.userId]);
    expect(r.body.users[0]).toMatchObject({ is_platform_admin: false, frozen: false });

    const admins = await req<{ users: Array<{ id: string; is_platform_admin: boolean }> }>(
      h.app,
      "GET",
      "/v1/admin/users?q=super",
      { as: superAdmin.userId },
    );
    expect(admins.body.users.every((u) => u.is_platform_admin)).toBe(true);

    const listed = await f.admin.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'admin.user_listed' AND actor_id = $1",
      [superAdmin.userId],
    );
    expect(listed.rows[0]?.n).toBe(2);
  });

  it("GET /v1/admin/admins：名单只读（授予/撤销没有端点，只能 SSH 跑 platform-admin.sh）", async () => {
    const r = await req<{ admins: Array<{ user_id: string; granted_by: string }> }>(
      h.app,
      "GET",
      "/v1/admin/admins",
      { as: superAdmin.userId },
    );
    expect(r.status).toBe(200);
    expect(r.body.admins.map((a) => a.user_id).sort()).toEqual([superAdmin.userId, admin2.userId].sort());
    expect(r.body.admins[0]?.granted_by).toBe("bootstrap");
    // 名单只有 GET：POST/DELETE 都不该存在
    for (const m of ["POST", "DELETE", "PUT"]) {
      const r2 = await req(h.app, m, "/v1/admin/admins", { as: superAdmin.userId, body: {} });
      expect(r2.status, m).toBe(404);
    }
  });

  it("GET /v1/admin/users/:id：组织 / 团队 / 设备 / 内容规模都以目标用户自己的视角数", async () => {
    const r = await req<{
      user: { id: string; frozen: boolean };
      organizations: Array<{ id: string; role: string }>;
      teams: Array<{ id: string }>;
      scale: { workspaces: number; notes: number; deleted_notes: number; e2ee_notes: number };
    }>(h.app, "GET", `/v1/admin/users/${target.userId}`, { as: superAdmin.userId });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ id: target.userId, frozen: false });
    expect(r.body.organizations.map((o) => o.id)).toEqual([orgId]);
    expect(r.body.teams.map((t) => t.id)).toEqual([teamId]);
    // 个人 + 组织共享区 + 团队工作区
    expect(r.body.scale.workspaces).toBe(3);
    // personal + org + team + e2ee（不含已删除）
    expect(r.body.scale.notes).toBe(4);
    expect(r.body.scale.deleted_notes).toBe(1);
    expect(r.body.scale.e2ee_notes).toBe(1);
  });

  it("不存在的用户 → 404", async () => {
    const r = await req(h.app, "GET", `/v1/admin/users/${uuidv7()}`, { as: superAdmin.userId });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: "not_found" });
  });

  // ─────────────────────────────────────────── 看内容（重新进入 RLS，而不是绕过 RLS）

  it("GET …/workspaces：个人 + 组织共享区 + 所在团队的团队工作区，各带便笺数", async () => {
    const r = await req<{
      workspaces: Array<{ id: string; kind: string; team_id: string | null; note_count: number }>;
    }>(h.app, "GET", `/v1/admin/users/${target.userId}/workspaces`, { as: superAdmin.userId });
    expect(r.status).toBe(200);
    const byId = new Map(r.body.workspaces.map((w) => [w.id, w]));
    expect([...byId.keys()].sort()).toEqual([target.workspaceId, orgWs, teamWs].sort());
    expect(byId.get(target.workspaceId)).toMatchObject({ kind: "personal", note_count: 3 });
    expect(byId.get(orgWs)).toMatchObject({ kind: "team", team_id: null, note_count: 1 });
    expect(byId.get(teamWs)).toMatchObject({ kind: "team", team_id: teamId, note_count: 1 });
    // other 的个人工作区不在其中
    expect(byId.has(other.workspaceId)).toBe(false);
  });

  it("GET …/notes：个人 + 团队工作区的便笺都能看到；第三个用户的私有便笺不出现", async () => {
    const r = await req<{ notes: AdminNote[] }>(h.app, "GET", `/v1/admin/users/${target.userId}/notes`, {
      as: superAdmin.userId,
    });
    expect(r.status).toBe(200);
    const ids = r.body.notes.map((n) => n.id);
    expect(ids.sort()).toEqual([notes.personal, notes.org, notes.team, notes.e2ee].sort());
    expect(ids).not.toContain(notes.other);
    expect(ids).not.toContain(notes.deleted);
    const team = r.body.notes.find((n) => n.id === notes.team);
    expect(team).toMatchObject({ workspace_id: teamWs, workspace_name: "小队的便笺", readable: true });
    expect(team?.excerpt).toContain("小队周会");
    expect(JSON.stringify(r.body)).not.toContain("别人的私密便笺");
  });

  it("GET …/notes：workspace_id / q / include_deleted 过滤", async () => {
    const byWs = await req<{ notes: AdminNote[] }>(
      h.app,
      "GET",
      `/v1/admin/users/${target.userId}/notes?workspace_id=${teamWs}`,
      { as: superAdmin.userId },
    );
    expect(byWs.body.notes.map((n) => n.id)).toEqual([notes.team]);

    const byQ = await req<{ notes: AdminNote[] }>(
      h.app,
      "GET",
      `/v1/admin/users/${target.userId}/notes?q=${encodeURIComponent("牛奶")}`,
      { as: superAdmin.userId },
    );
    expect(byQ.body.notes.map((n) => n.id)).toEqual([notes.personal]);

    const withDeleted = await req<{ notes: AdminNote[] }>(
      h.app,
      "GET",
      `/v1/admin/users/${target.userId}/notes?include_deleted=1`,
      { as: superAdmin.userId },
    );
    expect(withDeleted.body.notes.map((n) => n.id).sort()).toEqual(
      [notes.personal, notes.org, notes.team, notes.e2ee, notes.deleted].sort(),
    );
    expect(withDeleted.body.notes.find((n) => n.id === notes.deleted)?.deleted).toBe(true);
  });

  it("E2EE 便笺：列表与详情都是 readable:false / unreadable_reason:'e2ee'，正文为空", async () => {
    // 这条 e2ee 便笺的 content_text 被故意塞了记号：真实的保险箱便笺投影器直接跳过（project.ts），
    // 库里根本不会有正文；这里故意造一条「有正文的 e2ee 便笺」，是为了断言拿不到正文这件事由代码保证，
    // 而不是碰巧没数据。（列表里的 title 取自 title_cache —— content_text 的生成列 —— DTO 没有清它，
    // 所以下面只断言契约承诺的字段，不做整体 JSON 断言。）
    const list = await req<{ notes: AdminNote[] }>(h.app, "GET", `/v1/admin/users/${target.userId}/notes`, {
      as: superAdmin.userId,
    });
    const row = list.body.notes.find((n) => n.id === notes.e2ee);
    expect(row).toMatchObject({ readable: false, unreadable_reason: "e2ee", excerpt: "" });
    expect(row?.excerpt).not.toContain(E2EE_MARKER);

    const detail = await req<{
      note: { readable: boolean; unreadable_reason: string | null; content: unknown; content_text: string };
    }>(h.app, "GET", `/v1/admin/users/${target.userId}/notes/${notes.e2ee}`, { as: superAdmin.userId });
    expect(detail.status).toBe(200);
    expect(detail.body.note).toMatchObject({
      readable: false,
      unreadable_reason: "e2ee",
      content: null,
      content_text: "",
    });
    expect(JSON.stringify(detail.body.note)).not.toContain(E2EE_MARKER);

    // 对照：非 e2ee 的便笺该给的正文一个字不少
    const plain = await req<{ note: { content_text: string; readable: boolean } }>(
      h.app,
      "GET",
      `/v1/admin/users/${target.userId}/notes/${notes.personal}`,
      { as: superAdmin.userId },
    );
    expect(plain.body.note).toMatchObject({ readable: true });
    expect(plain.body.note.content_text).toContain("牛奶");
  });

  it("GET …/notes/:noteId：可读便笺给全文；目标用户看不到的便笺 → 404（重新进入 RLS，不是绕过 RLS）", async () => {
    const okRes = await req<{ note: { id: string; content_text: string; creator_email: string } }>(
      h.app,
      "GET",
      `/v1/admin/users/${target.userId}/notes/${notes.team}`,
      { as: superAdmin.userId },
    );
    expect(okRes.status).toBe(200);
    expect(okRes.body.note.id).toBe(notes.team);
    expect(okRes.body.note.content_text).toContain("下周一改期");

    // 同一条便笺，换成「以 other 的身份看」就看得到 —— 证明 404 是 RLS 判的，不是便笺不存在
    const denied = await req(h.app, "GET", `/v1/admin/users/${target.userId}/notes/${notes.other}`, {
      as: superAdmin.userId,
    });
    expect(denied.status).toBe(404);
    const asOwner = await req<{ note: { id: string } }>(
      h.app,
      "GET",
      `/v1/admin/users/${other.userId}/notes/${notes.other}`,
      { as: superAdmin.userId },
    );
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.note.id).toBe(notes.other);
  });

  // ─────────────────────────────────────────── 冻结 / 解冻

  it("不能冻结自己（400）、不能冻结另一个总管理员（403）", async () => {
    const self = await req(h.app, "POST", `/v1/admin/users/${superAdmin.userId}/freeze`, {
      as: superAdmin.userId,
      body: {},
    });
    expect(self.status).toBe(400);
    expect(self.body).toMatchObject({ error: "cannot_freeze_self" });

    const peer = await req(h.app, "POST", `/v1/admin/users/${admin2.userId}/freeze`, {
      as: superAdmin.userId,
      body: { reason: "试试" },
    });
    expect(peer.status).toBe(403);
    expect(peer.body).toMatchObject({ error: "target_is_platform_admin" });

    const rows = await f.admin.query('SELECT frozen_at, banned FROM "user" WHERE id = ANY($1::text[])', [
      [superAdmin.userId, admin2.userId],
    ]);
    for (const row of rows.rows as Array<{ frozen_at: unknown; banned: unknown }>) {
      expect(row).toMatchObject({ frozen_at: null, banned: false });
    }
  });

  it("冻结：frozen_at / banned 同时置上，设备令牌吊销，待兑换设备码作废，Web 会话被撤，发 authz_revoked(session)", async () => {
    // 一台在用的设备 + 两个待兑换的设备码（一个已批准、一个还在轮询）
    const deviceId = uuidv7();
    await f.admin.query(
      `INSERT INTO device (id, user_id, name, platform, app_version, last_seen_at)
       VALUES ($1, $2, 'Box', 'linux', '0.1.0', now())`,
      [deviceId, target.userId],
    );
    for (const status of ["approved", "pending"]) {
      await f.admin.query(
        `INSERT INTO "deviceCode" (id, "deviceCode", "userCode", "userId", "expiresAt", status)
         VALUES ($1, $2, $3, $4, now() + interval '30 minutes', $5)`,
        [uuidv7(), `dc-${status}-${target.userId}`, `uc-${status}`, target.userId, status],
      );
    }
    // 另一个用户的设备码不该被殃及
    await f.admin.query(
      `INSERT INTO "deviceCode" (id, "deviceCode", "userCode", "userId", "expiresAt", status)
       VALUES ($1, 'dc-other', 'uc-other', $2, now() + interval '30 minutes', 'approved')`,
      [uuidv7(), other.userId],
    );
    revoked.length = 0;

    const r = await req<{ ok: boolean; revoked_devices: number }>(
      h.app,
      "POST",
      `/v1/admin/users/${target.userId}/freeze`,
      { as: superAdmin.userId, body: { reason: "滥用" } },
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, revoked_devices: 1 });

    const u = await f.admin.query(
      'SELECT frozen_at, frozen_by, frozen_reason, banned FROM "user" WHERE id = $1',
      [target.userId],
    );
    expect(u.rows[0]?.frozen_at).not.toBeNull();
    expect(u.rows[0]).toMatchObject({ frozen_by: superAdmin.userId, frozen_reason: "滥用", banned: true });

    const dev = await f.admin.query("SELECT revoked_at FROM device WHERE id = $1", [deviceId]);
    expect(dev.rows[0]?.revoked_at).not.toBeNull();

    const codes = await f.admin.query('SELECT "userId", status FROM "deviceCode" ORDER BY "userCode"');
    const byUser = codes.rows as Array<{ userId: string; status: string }>;
    expect(byUser.filter((c) => c.userId === target.userId).map((c) => c.status)).toEqual([
      "denied",
      "denied",
    ]);
    expect(byUser.find((c) => c.userId === other.userId)?.status).toBe("approved");

    expect(h.webSessionsRevoked).toContain(target.userId);
    await waitFor(() => revoked.some((n) => n.user_id === target.userId));
    expect(revoked.find((n) => n.user_id === target.userId)).toMatchObject({ scope: "session", id: "*" });
  });

  it("GET /v1/admin/users?frozen=1 只列冻结的账号", async () => {
    const r = await req<{ users: Array<{ id: string; frozen: boolean; frozen_reason: string }> }>(
      h.app,
      "GET",
      "/v1/admin/users?frozen=1",
      { as: superAdmin.userId },
    );
    expect(r.body.users.map((u) => u.id)).toEqual([target.userId]);
    expect(r.body.users[0]).toMatchObject({ frozen: true, frozen_reason: "滥用" });
  });

  it("冻结期间照样能看内容（封的是登录，不是取证）", async () => {
    const r = await req<{ notes: AdminNote[] }>(h.app, "GET", `/v1/admin/users/${target.userId}/notes`, {
      as: superAdmin.userId,
    });
    expect(r.status).toBe(200);
    expect(r.body.notes.length).toBeGreaterThan(0);
  });

  it("解冻：frozen_* 清空、banned 复位；再解冻一次 → 409 not_frozen", async () => {
    const r = await req(h.app, "POST", `/v1/admin/users/${target.userId}/unfreeze`, {
      as: superAdmin.userId,
    });
    expect(r.status).toBe(200);
    const u = await f.admin.query(
      'SELECT frozen_at, frozen_by, frozen_reason, banned FROM "user" WHERE id = $1',
      [target.userId],
    );
    expect(u.rows[0]).toMatchObject({
      frozen_at: null,
      frozen_by: null,
      frozen_reason: null,
      banned: false,
    });

    const again = await req(h.app, "POST", `/v1/admin/users/${target.userId}/unfreeze`, {
      as: superAdmin.userId,
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "not_frozen" });
  });

  it("已注销（deleted_at 非空）的账号：解冻 409 user_deleted，且不会把 banned 清掉（banned 是 account-purge 的墓碑标记）", async () => {
    const ghost = await seedUserV7(f.adminDb, "ghost");
    await f.admin.query(
      'UPDATE "user" SET deleted_at = now(), banned = true, frozen_at = now() WHERE id = $1',
      [ghost.userId],
    );
    const r = await req(h.app, "POST", `/v1/admin/users/${ghost.userId}/unfreeze`, {
      as: superAdmin.userId,
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "user_deleted" });
    const u = await f.admin.query('SELECT banned, frozen_at FROM "user" WHERE id = $1', [ghost.userId]);
    expect(u.rows[0]?.banned).toBe(true);
    expect(u.rows[0]?.frozen_at).not.toBeNull();

    // 冻结一个已注销的账号同样 409（没有意义，也不该刷新墓碑）
    const freeze = await req(h.app, "POST", `/v1/admin/users/${ghost.userId}/freeze`, {
      as: superAdmin.userId,
      body: {},
    });
    expect(freeze.status).toBe(409);
    expect(freeze.body).toMatchObject({ error: "user_deleted" });
  });

  // ─────────────────────────────────────────── 改密码（前置判断；端到端见 admin-account-flow）

  it("不能改自己的密码（400）、不能改另一个总管理员的密码（403）", async () => {
    const self = await req(h.app, "POST", `/v1/admin/users/${superAdmin.userId}/password`, {
      as: superAdmin.userId,
      body: { new_password: "brand-new-password-1" },
    });
    expect(self.status).toBe(400);
    expect(self.body).toMatchObject({ error: "cannot_target_self" });

    const peer = await req(h.app, "POST", `/v1/admin/users/${admin2.userId}/password`, {
      as: superAdmin.userId,
      body: { new_password: "brand-new-password-1" },
    });
    expect(peer.status).toBe(403);
    expect(peer.body).toMatchObject({ error: "target_is_platform_admin" });
    expect(h.passwordsSet).toHaveLength(0);
  });

  it("改密码：写新密码 + 吊销全部设备令牌与 Web 会话；密码不进审计 metadata", async () => {
    const deviceId = uuidv7();
    await f.admin.query(
      `INSERT INTO device (id, user_id, name, platform, app_version, last_seen_at)
       VALUES ($1, $2, 'Box2', 'linux', '0.1.0', now())`,
      [deviceId, target.userId],
    );
    h.webSessionsRevoked.length = 0;
    const r = await req<{ ok: boolean; revoked_devices: number }>(
      h.app,
      "POST",
      `/v1/admin/users/${target.userId}/password`,
      { as: superAdmin.userId, body: { new_password: "brand-new-password-1" } },
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, revoked_devices: 1 });
    expect(h.passwordsSet).toEqual([{ userId: target.userId, password: "brand-new-password-1" }]);
    expect(h.webSessionsRevoked).toContain(target.userId);
    const dev = await f.admin.query("SELECT revoked_at FROM device WHERE id = $1", [deviceId]);
    expect(dev.rows[0]?.revoked_at).not.toBeNull();

    const entry = await f.admin.query(
      "SELECT metadata FROM audit_log WHERE action = 'admin.password_set' AND target_id = $1",
      [target.userId],
    );
    expect(entry.rows).toHaveLength(1);
    expect(JSON.stringify(entry.rows[0]?.metadata)).not.toContain("brand-new-password-1");
    expect(entry.rows[0]?.metadata).toMatchObject({ via: "platform_admin", revoked_devices: 1 });
  });

  it("new_password 校验：太短 → 400 validation_failed，且什么也没做", async () => {
    const r = await req(h.app, "POST", `/v1/admin/users/${target.userId}/password`, {
      as: superAdmin.userId,
      body: { new_password: "short" },
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: "validation_failed" });
    expect(h.passwordsSet).toHaveLength(1);
  });

  // ─────────────────────────────────────────── 审计

  it("查看内容 / 冻结 / 解冻 / 改密码都写了对应的 admin.* 条目，org_id 恒为 NULL", async () => {
    const r = await f.admin.query(
      `SELECT action, count(*)::int AS n, count(org_id)::int AS with_org
         FROM audit_log WHERE action LIKE 'admin.%' GROUP BY action ORDER BY action`,
    );
    const byAction = new Map(
      (r.rows as Array<{ action: string; n: number; with_org: number }>).map((row) => [row.action, row]),
    );
    for (const action of [
      "admin.user_listed",
      "admin.content_viewed",
      "admin.user_frozen",
      "admin.user_unfrozen",
      "admin.password_set",
    ]) {
      expect(byAction.get(action)?.n, action).toBeGreaterThan(0);
      expect(byAction.get(action)?.with_org, action).toBe(0);
    }
    // 看内容的审计先于读取单独落一笔，且记了看的是谁
    const viewed = await f.admin.query(
      `SELECT metadata->>'view' AS view, metadata->>'subject_user_id' AS subject
         FROM audit_log WHERE action = 'admin.content_viewed' AND actor_id = $1`,
      [superAdmin.userId],
    );
    const views = (viewed.rows as Array<{ view: string; subject: string }>).map((v) => v.view);
    expect(new Set(views)).toEqual(new Set(["detail", "workspaces", "notes", "note_body"]));
    expect((viewed.rows as Array<{ subject: string }>).every((v) => typeof v.subject === "string")).toBe(
      true,
    );
  });

  it("GET /v1/admin/audit 读得到这些 org_id 为 NULL 的条目；org 侧的 listAudit 结构上读不到", async () => {
    const r = await req<{ entries: Array<{ action: string; target_id: string; actor_email: string }> }>(
      h.app,
      "GET",
      "/v1/admin/audit?limit=200",
      { as: superAdmin.userId },
    );
    expect(r.status).toBe(200);
    const actions = new Set(r.body.entries.map((e) => e.action));
    for (const action of ["admin.user_frozen", "admin.user_unfrozen", "admin.password_set"]) {
      expect(actions.has(action), action).toBe(true);
    }
    expect(
      r.body.entries.every((e) => e.action.startsWith("admin.") || e.action === "auth.sign_in_denied"),
    ).toBe(true);

    // user_id 过滤
    const filtered = await req<{ entries: Array<{ target_id: string }> }>(
      h.app,
      "GET",
      `/v1/admin/audit?user_id=${target.userId}&limit=200`,
      { as: superAdmin.userId },
    );
    expect(filtered.body.entries.length).toBeGreaterThan(0);
    expect(filtered.body.entries.every((e) => e.target_id === target.userId)).toBe(true);

    // org 侧入口硬编码 WHERE org_id = 当前 org：管理员条目的 org_id 恒为 NULL，永远查不到
    const orgSide = await listAudit(
      h.deps,
      {
        userId: target.userId,
        email: "target@test.invalid",
        emailVerified: true,
        deviceId: null,
        ip: null,
        ua: null,
        requestId: null,
      },
      { orgId, role: "member", status: "active", sessionEpoch: 0 },
      { limit: 200 },
    );
    expect(orgSide.entries.some((e) => e.action.startsWith("admin."))).toBe(false);
  });

  it("审计条目本身不含便笺正文（看内容只记 view 与对象 id）", async () => {
    const r = await f.admin.query(
      "SELECT metadata::text AS m FROM audit_log WHERE action = 'admin.content_viewed'",
    );
    for (const row of r.rows as Array<{ m: string }>) {
      expect(row.m).not.toContain("牛奶");
      expect(row.m).not.toContain("下周一改期");
      expect(row.m).not.toContain(E2EE_MARKER);
    }
  });
});
