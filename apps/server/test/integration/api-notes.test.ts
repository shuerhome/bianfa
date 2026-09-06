// 便笺发现水位单调（规格 03 §2.6 / 08 X5）、建行幂等、软删/恢复/硬删/移动、notes_changed NOTIFY。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDirectClient, type DirectClient } from "../../src/db/direct.js";
import { uuidv7 } from "../../src/db/ids.js";
import { buildTestApp, call, seedOrg, seedUserV7, type TestApp, waitFor } from "./api-helpers.js";
import { DIRECT_URL, type Fixture, hasDb, openAdmin, truncateAll } from "./helpers.js";

interface NoteDto {
  id: string;
  workspace_id: string;
  version: number;
  deleted_at: string | null;
  purged_at: string | null;
  color: string;
  z_mode: number;
  effective_perm?: string;
}
interface Page {
  notes: NoteDto[];
  next_version: number;
  has_more: boolean;
}

describe.skipIf(!hasDb)("notes discovery & lifecycle", () => {
  let f: Fixture;
  let t: TestApp;
  let direct: DirectClient;
  const changed: { workspace_id: string; note_id: string; version: number }[] = [];
  let me: { userId: string; workspaceId: string };
  let other: { userId: string; workspaceId: string };
  let org: { orgId: string; workspaceId: string };

  beforeAll(async () => {
    f = openAdmin();
    await truncateAll(f.admin);
    t = buildTestApp();
    me = await seedUserV7(t.db, "me");
    other = await seedUserV7(t.db, "other");
    org = await seedOrg(t.db, "org", [
      { userId: me.userId, role: "owner" },
      { userId: other.userId, role: "member" },
    ]);
    direct = createDirectClient({ connectionString: DIRECT_URL as string, reconnectBaseMs: 50 });
    await direct.listen("notes_changed", (payload) => changed.push(JSON.parse(payload)));
    await direct.waitConnected();
  });

  afterAll(async () => {
    await direct.close();
    await t.close();
    await truncateAll(f.admin);
    await f.admin.end();
  });

  it("POST /v1/notes 幂等；他人工作区 404；发现水位随每次变更严格递增", async () => {
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    const versions: number[] = [];
    for (const id of ids) {
      const r = await call<{ note: NoteDto }>(t, "POST", "/v1/notes", {
        as: me.userId,
        body: { id, workspace_id: me.workspaceId, client_id: crypto.randomUUID(), color: "amber" },
      });
      expect(r.status).toBe(201);
      expect(r.body.note).toMatchObject({
        id,
        workspace_id: me.workspaceId,
        color: "amber",
        effective_perm: "manager",
      });
      versions.push(r.body.note.version);
    }
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(3);
    // 重复建行：200 + 同一行
    const again = await call<{ note: NoteDto }>(t, "POST", "/v1/notes", {
      as: me.userId,
      body: { id: ids[0], workspace_id: me.workspaceId },
    });
    expect(again.status).toBe(200);
    expect(again.body.note.version).toBe(versions[0]);
    // 同 id 建到别的工作区 → 409
    const clash = await call(t, "POST", "/v1/notes", {
      as: me.userId,
      body: { id: ids[0], workspace_id: org.workspaceId },
    });
    expect(clash.status).toBe(409);
    // 他人工作区 404；只读成员 403
    expect(
      (
        await call(t, "POST", "/v1/notes", {
          as: other.userId,
          body: { id: uuidv7(), workspace_id: me.workspaceId },
        })
      ).status,
    ).toBe(404);
    await waitFor(() => changed.filter((c) => c.workspace_id === me.workspaceId).length >= 3);

    // 发现：since_version=0 分页
    const p1 = await call<Page>(
      t,
      "GET",
      `/v1/notes?workspace_id=${me.workspaceId}&since_version=0&limit=2`,
      { as: me.userId },
    );
    expect(p1.status).toBe(200);
    expect(p1.body.notes).toHaveLength(2);
    expect(p1.body.has_more).toBe(true);
    expect(p1.body.next_version).toBe(p1.body.notes[1]?.version);
    const p2 = await call<Page>(
      t,
      "GET",
      `/v1/notes?workspace_id=${me.workspaceId}&since_version=${p1.body.next_version}&limit=2`,
      {
        as: me.userId,
      },
    );
    expect(p2.body.notes).toHaveLength(1);
    expect(p2.body.has_more).toBe(false);
    expect(p2.body.notes[0]?.version).toBeGreaterThan(p1.body.next_version);
    // 别名路由同 handler
    const alias = await call<Page>(
      t,
      "GET",
      `/v1/workspaces/${me.workspaceId}/notes?since_version=0&limit=500`,
      { as: me.userId },
    );
    expect(alias.body.notes.map((n) => n.id)).toEqual([...p1.body.notes, ...p2.body.notes].map((n) => n.id));
    // 无变更时水位不动
    const idle = await call<Page>(
      t,
      "GET",
      `/v1/notes?workspace_id=${me.workspaceId}&since_version=${p2.body.next_version}`,
      {
        as: me.userId,
      },
    );
    expect(idle.body.notes).toHaveLength(0);
    expect(idle.body.next_version).toBe(p2.body.next_version);
    // limit > 500 拒绝
    expect(
      (await call(t, "GET", `/v1/notes?workspace_id=${me.workspaceId}&limit=501`, { as: me.userId })).status,
    ).toBe(400);

    // PATCH 推进水位并 NOTIFY
    const before = changed.length;
    const patched = await call<{ note: NoteDto }>(t, "PATCH", `/v1/notes/${ids[2]}`, {
      as: me.userId,
      body: { z_mode: 1, color: "teal" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.note.version).toBeGreaterThan(p2.body.next_version);
    await waitFor(() => changed.length > before);
    expect(changed.at(-1)).toMatchObject({
      workspace_id: me.workspaceId,
      note_id: ids[2],
      version: patched.body.note.version,
    });

    // 软删 → 发现列表里带 deleted_at（墓碑）；非 manager 看不到；恢复
    const del = await call(t, "DELETE", `/v1/notes/${ids[1]}`, { as: me.userId });
    expect(del.status).toBe(204);
    const afterDel = await call<Page>(
      t,
      "GET",
      `/v1/notes?workspace_id=${me.workspaceId}&since_version=${patched.body.note.version}`,
      {
        as: me.userId,
      },
    );
    expect(afterDel.body.notes.map((n) => n.id)).toEqual([ids[1]]);
    expect(afterDel.body.notes[0]?.deleted_at).toBeTruthy();
    const restored = await call<{ note: NoteDto }>(t, "POST", `/v1/notes/${ids[1]}/restore`, {
      as: me.userId,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.note.deleted_at).toBeNull();

    // 硬删：正文清空、墓碑保留、再读 410
    const purge = await call(t, "DELETE", `/v1/notes/${ids[0]}?purge=true`, { as: me.userId });
    expect(purge.status).toBe(204);
    const gone = await call(t, "GET", `/v1/notes/${ids[0]}`, { as: me.userId });
    expect(gone.status).toBe(200); // GET 允许读墓碑元数据（allowPurged）
    expect((gone.body as { note: NoteDto }).note.purged_at).toBeTruthy();
    expect((await call(t, "POST", `/v1/notes/${ids[0]}/restore`, { as: me.userId })).status).toBe(410);
    const row = await f.admin.query("SELECT content_text, purged_at FROM notes WHERE id = $1", [ids[0]]);
    expect(row.rows[0]).toMatchObject({ content_text: "" });
  });

  it("移动：manager + 目标可写；受众收到 authz_revoked(scope=note)；两个工作区各收 notes_changed", async () => {
    const revoked: { user_id: string; scope: string; id: string }[] = [];
    const unlisten = await direct.listen("authz_revoked", (p) => revoked.push(JSON.parse(p)));
    const id = uuidv7();
    await call(t, "POST", "/v1/notes", { as: me.userId, body: { id, workspace_id: org.workspaceId } });
    // member（editor）不能移动（需要 manager）
    const denied = await call(t, "POST", `/v1/notes/${id}/move`, {
      as: other.userId,
      body: { workspace_id: other.workspaceId },
    });
    expect(denied.status).toBe(403);
    const moved = await call<{ note: NoteDto; moved: boolean }>(t, "POST", `/v1/notes/${id}/move`, {
      as: me.userId,
      body: { workspace_id: me.workspaceId },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.note.workspace_id).toBe(me.workspaceId);
    await waitFor(() => revoked.some((r) => r.user_id === other.userId && r.scope === "note" && r.id === id));
    expect(revoked.some((r) => r.user_id === me.userId)).toBe(false);
    await waitFor(() => changed.filter((c) => c.note_id === id).length >= 3);
    await unlisten();
    // 移走后 other 看不到
    expect((await call(t, "GET", `/v1/notes/${id}`, { as: other.userId })).status).toBe(404);
  });

  it("views：GET /notes/:id 记 note.viewed（30 min 去重），/views 列出看过的人", async () => {
    const id = uuidv7();
    await call(t, "POST", "/v1/notes", { as: me.userId, body: { id, workspace_id: org.workspaceId } });
    await call(t, "GET", `/v1/notes/${id}`, { as: other.userId });
    await call(t, "GET", `/v1/notes/${id}`, { as: other.userId });
    const views = await call<{ views: { user_id: string; count: number }[] }>(
      t,
      "GET",
      `/v1/notes/${id}/views`,
      { as: me.userId },
    );
    expect(views.status).toBe(200);
    const v = views.body.views.find((x) => x.user_id === other.userId);
    expect(v?.count).toBe(1);
  });
});
