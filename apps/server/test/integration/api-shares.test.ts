// 共享（规格 04 §4.6）：创建 → 受让人可读 + 通知；降级/撤销 → authz_revoked(scope=note) NOTIFY（经直连 LISTEN 收到）；
// 收件箱；钉放；评论幂等。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDirectClient, type DirectClient } from "../../src/db/direct.js";
import { uuidv7 } from "../../src/db/ids.js";
import { buildTestApp, call, seedNote, seedUserV7, type TestApp, waitFor } from "./api-helpers.js";
import { DIRECT_URL, type Fixture, hasDb, openAdmin, truncateAll } from "./helpers.js";

describe.skipIf(!hasDb)("shares / pins / comments", () => {
  let f: Fixture;
  let t: TestApp;
  let direct: DirectClient;
  const revoked: { user_id: string; scope: string; id: string }[] = [];
  let owner: { userId: string; workspaceId: string };
  let guest: { userId: string; workspaceId: string };
  let noteId: string;

  beforeAll(async () => {
    f = openAdmin();
    await truncateAll(f.admin);
    t = buildTestApp();
    owner = await seedUserV7(t.db, "owner");
    guest = await seedUserV7(t.db, "guest");
    noteId = await seedNote(t.db, owner.workspaceId, owner.userId, "共享的便笺\n内容");
    direct = createDirectClient({ connectionString: DIRECT_URL as string, reconnectBaseMs: 50 });
    await direct.listen("authz_revoked", (p) => revoked.push(JSON.parse(p)));
    await direct.waitConnected();
  });

  afterAll(async () => {
    await direct.close();
    await t.close();
    await truncateAll(f.admin);
    await f.admin.end();
  });

  it("PUT shares：按 email 找人 → 201；受让人可读、不可写；收件箱与通知有记录；重复 PUT 幂等更新", async () => {
    expect((await call(t, "GET", `/v1/notes/${noteId}`, { as: guest.userId })).status).toBe(404);
    const email = (await f.admin.query('SELECT email FROM "user" WHERE id = $1', [guest.userId])).rows[0]
      ?.email as string;
    const created = await call<{ share: { id: string; permission: string; grantee: { user_id: string } } }>(
      t,
      "PUT",
      `/v1/notes/${noteId}/shares`,
      { as: owner.userId, body: { grantee_kind: "user", email: email.toUpperCase(), permission: "viewer" } },
    );
    expect(created.status).toBe(201);
    expect(created.body.share).toMatchObject({ permission: "viewer", grantee: { user_id: guest.userId } });
    const shareId = created.body.share.id;

    const read = await call<{ note: { effective_perm: string } }>(t, "GET", `/v1/notes/${noteId}`, {
      as: guest.userId,
    });
    expect(read.status).toBe(200);
    expect(read.body.note.effective_perm).toBe("viewer");
    expect(
      (await call(t, "PATCH", `/v1/notes/${noteId}`, { as: guest.userId, body: { color: "rose" } })).status,
    ).toBe(403);

    const inbox = await call<{ items: { note_id: string; permission: string }[] }>(
      t,
      "GET",
      "/v1/shared-with-me",
      { as: guest.userId },
    );
    expect(inbox.body.items).toEqual([expect.objectContaining({ note_id: noteId, permission: "viewer" })]);
    const notifs = await call<{
      notifications: { kind: string; subject: { id: string } }[];
      unread_count: number;
    }>(t, "GET", "/v1/notifications", { as: guest.userId });
    expect(notifs.body.unread_count).toBe(1);
    expect(notifs.body.notifications[0]).toMatchObject({ kind: "note.shared", subject: { id: noteId } });

    // 升级为 editor：不触发 revoke；PUT 幂等（200）
    const upgraded = await call<{ share: { id: string; permission: string } }>(
      t,
      "PUT",
      `/v1/notes/${noteId}/shares`,
      {
        as: owner.userId,
        body: { grantee_kind: "user", grantee_id: guest.userId, permission: "editor" },
      },
    );
    expect(upgraded.status).toBe(200);
    expect(upgraded.body.share.id).toBe(shareId);
    expect(
      (await call(t, "PATCH", `/v1/notes/${noteId}`, { as: guest.userId, body: { color: "rose" } })).status,
    ).toBe(200);
    expect(revoked).toHaveLength(0);

    // 降级 → NOTIFY authz_revoked(guest, note, noteId)
    await call(t, "PUT", `/v1/notes/${noteId}/shares`, {
      as: owner.userId,
      body: { grantee_kind: "user", grantee_id: guest.userId, permission: "commenter" },
    });
    await waitFor(() =>
      revoked.some((r) => r.user_id === guest.userId && r.scope === "note" && r.id === noteId),
    );

    // 撤销 → 再次 NOTIFY，受让人 404
    revoked.length = 0;
    const del = await call(t, "DELETE", `/v1/notes/${noteId}/shares/${shareId}`, { as: owner.userId });
    expect(del.status).toBe(204);
    await waitFor(() =>
      revoked.some((r) => r.user_id === guest.userId && r.scope === "note" && r.id === noteId),
    );
    expect((await call(t, "GET", `/v1/notes/${noteId}`, { as: guest.userId })).status).toBe(404);
    expect(
      (await call(t, "DELETE", `/v1/notes/${noteId}/shares/${shareId}`, { as: owner.userId })).status,
    ).toBe(404);
    const list = await call<{ shares: unknown[] }>(t, "GET", `/v1/notes/${noteId}/shares`, {
      as: owner.userId,
    });
    expect(list.body.shares).toHaveLength(0);
  });

  it("共享校验：不能共享给自己、未知用户 404、e2ee 便笺 409 vault_not_shareable", async () => {
    expect(
      (
        await call(t, "PUT", `/v1/notes/${noteId}/shares`, {
          as: owner.userId,
          body: { grantee_kind: "user", grantee_id: owner.userId, permission: "viewer" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(t, "PUT", `/v1/notes/${noteId}/shares`, {
          as: owner.userId,
          body: { grantee_kind: "user", email: "nobody@test.invalid", permission: "viewer" },
        })
      ).status,
    ).toBe(404);
    const vault = await seedNote(t.db, owner.workspaceId, owner.userId, "保险箱");
    await f.admin.query("UPDATE notes SET encryption = 'e2ee' WHERE id = $1", [vault]);
    const r = await call(t, "PUT", `/v1/notes/${vault}/shares`, {
      as: owner.userId,
      body: { grantee_kind: "user", grantee_id: guest.userId, permission: "viewer" },
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "vault_not_shareable" });
  });

  it("pins：viewer 即可钉；upsert always_on_top；DELETE 幂等；不可见便笺 404", async () => {
    await call(t, "PUT", `/v1/notes/${noteId}/shares`, {
      as: owner.userId,
      body: { grantee_kind: "user", grantee_id: guest.userId, permission: "viewer" },
    });
    const pin = await call<{ pin: { always_on_top: boolean } }>(t, "PUT", `/v1/notes/${noteId}/pin`, {
      as: guest.userId,
      body: { always_on_top: true },
    });
    expect(pin.status).toBe(200);
    expect(pin.body.pin.always_on_top).toBe(true);
    const again = await call<{ pin: { always_on_top: boolean } }>(t, "PUT", `/v1/notes/${noteId}/pin`, {
      as: guest.userId,
      body: {},
    });
    expect(again.body.pin.always_on_top).toBe(false);
    const rows = await f.admin.query("SELECT count(*)::int AS n FROM note_pins WHERE note_id = $1", [noteId]);
    expect(rows.rows[0]?.n).toBe(1);
    const detail = await call<{ note: { pin: { always_on_top: boolean } | null } }>(
      t,
      "GET",
      `/v1/notes/${noteId}`,
      { as: guest.userId },
    );
    expect(detail.body.note.pin).toEqual({ always_on_top: false, pinned_at: expect.any(String) });
    expect((await call(t, "DELETE", `/v1/notes/${noteId}/pin`, { as: guest.userId })).status).toBe(204);
    expect((await call(t, "DELETE", `/v1/notes/${noteId}/pin`, { as: guest.userId })).status).toBe(204);
    const stranger = await seedUserV7(t.db, "stranger");
    expect((await call(t, "PUT", `/v1/notes/${noteId}/pin`, { as: stranger.userId, body: {} })).status).toBe(
      404,
    );
  });

  it("comments：客户端 UUIDv7 幂等（201 → 200）；viewer 403；≤ 4000 字；作者收到 comment.created 通知", async () => {
    // guest 目前是 viewer → 403
    const id = uuidv7();
    expect(
      (await call(t, "POST", `/v1/notes/${noteId}/comments`, { as: guest.userId, body: { id, body: "hi" } }))
        .status,
    ).toBe(403);
    await call(t, "PUT", `/v1/notes/${noteId}/shares`, {
      as: owner.userId,
      body: { grantee_kind: "user", grantee_id: guest.userId, permission: "commenter" },
    });
    const first = await call<{ comment: { id: string; body: string } }>(
      t,
      "POST",
      `/v1/notes/${noteId}/comments`,
      {
        as: guest.userId,
        body: { id, body: "第一条评论" },
      },
    );
    expect(first.status).toBe(201);
    const dup = await call<{ comment: { id: string; body: string } }>(
      t,
      "POST",
      `/v1/notes/${noteId}/comments`,
      {
        as: guest.userId,
        body: { id, body: "重发（内容不同也不覆盖）" },
      },
    );
    expect(dup.status).toBe(200);
    expect(dup.body.comment.body).toBe("第一条评论");
    expect(
      (
        await call(t, "POST", `/v1/notes/${noteId}/comments`, {
          as: guest.userId,
          body: { id: uuidv7(), body: "x".repeat(4001) },
        })
      ).status,
    ).toBe(400);
    const list = await call<{ comments: { id: string; author: { user_id: string } }[] }>(
      t,
      "GET",
      `/v1/notes/${noteId}/comments`,
      { as: owner.userId },
    );
    expect(list.body.comments).toEqual([
      expect.objectContaining({ id, author: expect.objectContaining({ user_id: guest.userId }) }),
    ]);
    const n = await call<{ notifications: { kind: string }[] }>(t, "GET", "/v1/notifications?unread=true", {
      as: owner.userId,
    });
    expect(n.body.notifications.some((x) => x.kind === "comment.created")).toBe(true);
    // 已读
    const read = await call<{ updated: number }>(t, "POST", "/v1/notifications/read", {
      as: owner.userId,
      body: { all: true },
    });
    expect(read.body.updated).toBeGreaterThanOrEqual(1);
    const after = await call<{ unread_count: number }>(t, "GET", "/v1/notifications", { as: owner.userId });
    expect(after.body.unread_count).toBe(0);
  });
});
