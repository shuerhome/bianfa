// 总管理员及其团队不受套餐限制（存储配额 / 单文件上限 / 同步设备数 / 团队席位）。
//
// 判定是自动的：个人工作区看 owner，团队工作区看「组织里有没有活跃的总管理员成员」。
// 自托管的所有者不该被自己搭给外部用户的收费墙挡住，而这件事应该跟着「谁是总管理员」自动成立，
// 不要变成一份需要人工维护的名单。
//
// 这个文件钉住的：
//   ① 谓词本身，尤其是 status='active' 那一条 —— 一个已被移除的管理员不该让整个组织永久免限；
//   ② 存储配额与单文件上限，走真实的 POST /v1/attachments/presign（真路由、真库、假对象存储）。
//
// 没在这里覆盖的两条，以及为什么：
//   * 团队席位（assertSeatAvailable）：它对本次改动的唯一新输入就是 orgHasPlatformAdmin，
//     而那个谓词在 ① 里已经钉死；「普通用户仍然会撞席位墙」由 auth-flow.test.ts 那条真实登录
//     的 409 seat_limit 用例保证（那个用户不是管理员，所以行为不变）。
//   * 同步设备数（desktop-plugin）：同理，新输入只有 isPlatformAdminUser。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/db/ids.js";
import {
  isPlatformAdminUser,
  isUnlimitedWorkspace,
  MB,
  orgHasPlatformAdmin,
} from "../../src/services/quota.js";
import type { ObjectStorage } from "../../src/services/storage.js";
import { grantPlatformAdmin } from "./admin-helpers.js";
import { buildTestApp, call, seedOrg, seedUserV7, type TestApp } from "./api-helpers.js";
import { type Fixture, openAdmin } from "./helpers.js";

function fakeStorage(): ObjectStorage {
  return {
    kind: "local",
    presignPut: async (key) => `https://fake.local/put/${encodeURIComponent(key)}`,
    presignGet: async (key) => `https://fake.local/get/${encodeURIComponent(key)}`,
    head: async () => null,
    readHead: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => [],
  };
}

/**
 * 直接在库里堆出「已用存储」——presign 只看 committed 且未删除的行。
 * 按 10 MB 一行插：贴近真实数据，也不依赖 byte_size 那条 CHECK 的具体上限。
 */
async function fillStorage(f: Fixture, workspaceId: string, userId: string, bytes: number) {
  for (let left = bytes; left > 0; left -= 10 * MB) {
    await f.admin.query(
      `INSERT INTO attachments (id, workspace_id, created_by, content_hash, byte_size, mime, storage_key, status, committed_at)
       VALUES ($1::uuid, $2::uuid, $3, decode($4, 'hex'), $5, 'image/png', $6, 'committed', now())`,
      [uuidv7(), workspaceId, userId, "ab".repeat(32), Math.min(left, 10 * MB), `fill/${uuidv7()}`],
    );
  }
}

const presign = (t: TestApp, as: string, workspaceId: string, size: number) =>
  call(t, "POST", "/v1/attachments/presign", {
    as,
    body: {
      attachment_id: uuidv7(),
      workspace_id: workspaceId,
      hash: uuidv7().replace(/-/g, "").padEnd(64, "0"),
      size,
      mime: "image/png",
    },
  });

describe("总管理员及其团队不受套餐限制", () => {
  let f: Fixture;
  let t: TestApp;
  let plain: Awaited<ReturnType<typeof seedUserV7>>;
  let admin: Awaited<ReturnType<typeof seedUserV7>>;
  let orgWithAdmin: Awaited<ReturnType<typeof seedOrg>>;
  let orgAdminRemoved: Awaited<ReturnType<typeof seedOrg>>;

  beforeAll(async () => {
    f = openAdmin();
    t = buildTestApp({ storage: fakeStorage() });
    plain = await seedUserV7(t.db, "unlim-plain");
    admin = await seedUserV7(t.db, "unlim-admin");
    await grantPlatformAdmin(f.admin, admin.userId);
    orgWithAdmin = await seedOrg(t.db, "有管理员的组织", [
      { userId: plain.userId, role: "owner" },
      { userId: admin.userId, role: "member" },
    ]);
    // 管理员曾经在里面，但已经不是活跃成员了
    orgAdminRemoved = await seedOrg(t.db, "管理员已退出的组织", [
      { userId: plain.userId, role: "owner" },
      { userId: admin.userId, role: "member", status: "removed" },
    ]);
  });
  afterAll(async () => {
    await t.close();
    await f.admin.end();
  });

  it("谓词：总管理员本人 true，普通用户 false", async () => {
    await t.db.transaction(async (tx) => {
      expect(await isPlatformAdminUser(tx, admin.userId)).toBe(true);
      expect(await isPlatformAdminUser(tx, plain.userId)).toBe(false);
    });
  });

  it("谓词：组织里有活跃的总管理员才算数；已移除的成员不算", async () => {
    await t.db.transaction(async (tx) => {
      expect(await orgHasPlatformAdmin(tx, orgWithAdmin.orgId)).toBe(true);
      // 这一条是最容易写错的：漏掉 status='active'，一个早就被踢出去的管理员
      // 会让这个组织永久免限
      expect(await orgHasPlatformAdmin(tx, orgAdminRemoved.orgId)).toBe(false);
    });
  });

  it("谓词：个人工作区看 owner，团队工作区看组织", async () => {
    await t.db.transaction(async (tx) => {
      const personal = (o: string) => ({ kind: "personal" as const, org_id: null, owner_user_id: o });
      expect(await isUnlimitedWorkspace(tx, personal(admin.userId))).toBe(true);
      expect(await isUnlimitedWorkspace(tx, personal(plain.userId))).toBe(false);
      const team = (orgId: string) => ({ kind: "team" as const, org_id: orgId, owner_user_id: null });
      expect(await isUnlimitedWorkspace(tx, team(orgWithAdmin.orgId))).toBe(true);
      expect(await isUnlimitedWorkspace(tx, team(orgAdminRemoved.orgId))).toBe(false);
    });
  });

  it("单文件上限：普通用户 20 MB 被拒，管理员通过", async () => {
    const denied = await presign(t, plain.userId, plain.workspaceId, 20 * MB);
    expect(denied.status, JSON.stringify(denied.body)).toBe(409);
    expect((denied.body as { error?: string }).error).toBe("quota_exceeded");

    const ok = await presign(t, admin.userId, admin.workspaceId, 20 * MB);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body as { upload_url?: string }).upload_url).toBeTruthy();
  });

  it("存储配额：普通用户撞 Free 的 100 MB，管理员不受影响", async () => {
    await fillStorage(f, plain.workspaceId, plain.userId, 100 * MB);
    await fillStorage(f, admin.workspaceId, admin.userId, 100 * MB);

    const denied = await presign(t, plain.userId, plain.workspaceId, 1 * MB);
    expect(denied.status, JSON.stringify(denied.body)).toBe(409);
    expect((denied.body as { error?: string }).error).toBe("quota_exceeded");

    const ok = await presign(t, admin.userId, admin.workspaceId, 1 * MB);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});
