// presign 去重：同 workspace 同 hash 已 committed → 以客户端 id 建别名行（同 storage_key），
// 使便笺正文引用的本地 id 在别的设备上也能 GET /attachments/:id/url（桌面端契约对齐时发现的缺口）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/db/ids.js";
import type { ObjectStorage } from "../../src/services/storage.js";
import { buildTestApp, call, seedNote, seedUserV7, type TestApp } from "./api-helpers.js";
import { type Fixture, openAdmin } from "./helpers.js";

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

function fakeStorage(): ObjectStorage & { objects: Map<string, number> } {
  const objects = new Map<string, number>();
  return {
    kind: "local",
    objects,
    presignPut: async (key) => `https://fake.local/put/${encodeURIComponent(key)}`,
    presignGet: async (key) => `https://fake.local/get/${encodeURIComponent(key)}`,
    head: async (key) => (objects.has(key) ? { size: objects.get(key) as number } : null),
    readHead: async (key) => (objects.has(key) ? PNG_HEAD : null),
    put: async (key, body) => {
      objects.set(key, body.length);
    },
    delete: async (key) => {
      objects.delete(key);
    },
    list: async () => [],
  };
}

describe("attachments presign 别名", () => {
  let f: Fixture;
  let t: TestApp;
  const storage = fakeStorage();
  let me: Awaited<ReturnType<typeof seedUserV7>>;

  beforeAll(async () => {
    f = openAdmin();
    t = buildTestApp({ storage });
    me = await seedUserV7(t.db, "alias-owner");
  });
  afterAll(async () => {
    await t.close();
    await f.admin.end();
  });

  it("第二次 presign 同 hash 返回 exists=true 且客户端 id 可解析 url", async () => {
    const hash = "cd".repeat(32);
    const firstId = uuidv7();
    const p1 = await call<{ exists: boolean; attachment_id: string; upload_url?: string }>(
      t,
      "POST",
      "/v1/attachments/presign",
      {
        as: me.userId,
        body: { attachment_id: firstId, workspace_id: me.workspaceId, hash, size: 1024, mime: "image/png" },
      },
    );
    expect(p1.status).toBe(200);
    expect(p1.body.exists).toBe(false);
    expect(p1.body.attachment_id).toBe(firstId);
    // 模拟上传后 commit
    const key = decodeURIComponent((p1.body.upload_url as string).split("/put/")[1] as string);
    storage.objects.set(key, 1024);
    const c1 = await call(t, "POST", "/v1/attachments/commit", {
      as: me.userId,
      body: { attachment_id: firstId },
    });
    expect(c1.status).toBe(200);

    const secondId = uuidv7();
    const p2 = await call<{ exists: boolean; attachment_id: string }>(t, "POST", "/v1/attachments/presign", {
      as: me.userId,
      body: { attachment_id: secondId, workspace_id: me.workspaceId, hash, size: 1024, mime: "image/png" },
    });
    expect(p2.status).toBe(200);
    expect(p2.body).toMatchObject({ exists: true, attachment_id: secondId });

    const rows = await f.admin.query(
      "SELECT id, status, storage_key FROM attachments WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[firstId, secondId]],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.storage_key).toBe(rows.rows[1]?.storage_key);
    expect(rows.rows.every((r) => r.status === "committed")).toBe(true);

    // 两个 id 都能签 url（需要一张引用它的便笺）
    const noteId = await seedNote(t.db, me.workspaceId, me.userId);
    await f.admin.query("INSERT INTO attachment_refs (note_id, attachment_id) VALUES ($1, $2), ($1, $3)", [
      noteId,
      firstId,
      secondId,
    ]);
    for (const id of [firstId, secondId]) {
      const u = await call<{ url: string }>(t, "GET", `/v1/attachments/${id}/url?note_id=${noteId}`, {
        as: me.userId,
      });
      expect(u.status, id).toBe(200);
      expect(u.body.url).toContain("fake.local/get/");
    }
  });
});
