// 平台总管理员的地基（迁移 0009）。这个文件钉的是三件「错了就全盘皆输」的事：
//  ① 名单谁能改：api 进程（bianfa_app）不能，而且**即使那条 REVOKE 被下一次运维打回来**（0002 与
//     pg-roles.sh 都会对 public 下所有表 blanket GRANT）也依然不能 —— 真正的边界是「只有 SELECT 策略」的 RLS。
//  ② 「看内容」的事务确实是只读的：即使代码里不小心写了 UPDATE，PostgreSQL 也会当场报错。
//  ③ 事务结束后 app.user_id 不残留：连接池复用不会把身份泄漏给下一次查询。
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, createPool, type Db } from "../../src/db/client.js";
import { grantPlatformAdmin, openHarness, req, resetRateLimit, seedNote } from "./admin-helpers.js";
import {
  DIRECT_URL,
  ensureTestRoles,
  type Fixture,
  hasDb,
  openAdmin,
  RLS_PASSWORD,
  RLS_ROLE,
  seedUser,
  truncateAll,
  WORKER_PASSWORD,
  WORKER_ROLE,
  withCredentials,
} from "./helpers.js";

/** node-postgres 直接抛 DatabaseError（带 code）；drizzle 会包一层，原错误在 cause 里 */
async function expectPgError(p: Promise<unknown>): Promise<pg.DatabaseError> {
  let thrown: unknown;
  try {
    await p;
  } catch (err) {
    thrown = err;
  }
  expect(thrown, "expected the query to be rejected").toBeDefined();
  const cause = (thrown as { cause?: unknown }).cause;
  const err = (cause instanceof Error ? cause : thrown) as pg.DatabaseError;
  return err;
}

interface Recorder {
  statements: string[];
  restore(): void;
}

/**
 * 记录连接上实际发出的每一条 SQL。drizzle 的 transaction() 会先 pool.connect() 拿一条连接，
 * 所以在 connect 上包一层就能看到真实调用路径发了什么 —— 用来证明 adminReadAsUser
 * 不是「测试里另写一遍的形状」，而是它自己真的开了只读事务。
 */
function recordStatements(pool: pg.Pool): Recorder {
  const statements: string[] = [];
  const patched = new WeakSet<pg.PoolClient>();
  const patch = (client: pg.PoolClient | undefined): void => {
    if (!client || patched.has(client)) return;
    patched.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const first = args[0];
      statements.push(typeof first === "string" ? first : String((first as { text?: string })?.text ?? ""));
      return query(...args);
    };
  };
  const original = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  const wrapped = (...args: unknown[]): unknown => {
    const cb = args[0];
    // pool.query()（不开事务的那些查询）走的是**回调**形态；只处理 Promise 形态会让它永远等不到回调。
    if (typeof cb === "function") {
      return original((err: unknown, client: pg.PoolClient | undefined, done: unknown) => {
        patch(client);
        (cb as (...a: unknown[]) => void)(err, client, done);
      });
    }
    return (original() as Promise<pg.PoolClient>).then((client) => {
      patch(client);
      return client;
    });
  };
  (pool as unknown as { connect: unknown }).connect = wrapped;
  return {
    statements,
    restore: () => {
      (pool as unknown as { connect: unknown }).connect = original;
    },
  };
}

describe.skipIf(!hasDb)("平台总管理员：提权边界与只读事务", () => {
  let f: Fixture;
  /** api 进程的身份：成员于 bianfa_app，NOSUPERUSER NOBYPASSRLS */
  let appPool: pg.Pool;
  let appDb: Db;
  /** worker 的身份：BYPASSRLS（platform-admin.sh 就是以它跑的） */
  let workerPool: pg.Pool;
  let admin: { userId: string; workspaceId: string };
  let target: { userId: string; workspaceId: string };
  let targetNote: string;

  beforeAll(async () => {
    resetRateLimit();
    f = openAdmin();
    await ensureTestRoles(f.admin);
    await truncateAll(f.admin);
    await f.admin.query("TRUNCATE audit_log RESTART IDENTITY CASCADE");
    admin = await seedUser(f.adminDb, "pa_admin");
    target = await seedUser(f.adminDb, "pa_target");
    targetNote = await seedNote(f.adminDb, {
      workspaceId: target.workspaceId,
      createdBy: target.userId,
      text: "目标用户的便笺\n正文",
    });
    await grantPlatformAdmin(f.admin, admin.userId);
    appPool = createPool(withCredentials(DIRECT_URL as string, RLS_ROLE, RLS_PASSWORD), { max: 2 });
    appDb = createDb(appPool);
    workerPool = createPool(withCredentials(DIRECT_URL as string, WORKER_ROLE, WORKER_PASSWORD), { max: 1 });
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    await truncateAll(f.admin);
    await f.admin.end();
    await closeDb();
  });

  // ─────────────────────────────────────────── ① 名单谁能改

  it("bianfa_app 身份：INSERT / UPDATE / DELETE platform_admin 一律 permission denied（42501）", async () => {
    const cases: Array<[string, string]> = [
      ["INSERT", "INSERT INTO platform_admin (user_id) VALUES ($1)"],
      ["UPDATE", "UPDATE platform_admin SET note = 'pwned' WHERE user_id = $1"],
      ["DELETE", "DELETE FROM platform_admin WHERE user_id = $1"],
    ];
    for (const [label, text] of cases) {
      const err = await expectPgError(appPool.query(text, [target.userId]));
      expect(err.code, label).toBe("42501");
      expect(err.message, label).toMatch(/permission denied/);
    }
  });

  it("即使 REVOKE 被运维打回来（重新 blanket GRANT），RLS 仍挡住 INSERT；UPDATE / DELETE 看不到行、影响 0 行", async () => {
    await f.admin.query("GRANT INSERT, UPDATE, DELETE ON platform_admin TO bianfa_app");
    try {
      // 这一条是整个设计的地基：写权限给了，策略没给 → 仍然铸不出一个新的总管理员
      const err = await expectPgError(
        appPool.query("INSERT INTO platform_admin (user_id) VALUES ($1)", [target.userId]),
      );
      expect(err.code).toBe("42501");
      expect(err.message).toMatch(/row-level security/);

      // UPDATE / DELETE 没有对应策略：不报错，但一行也看不到 —— 迁移注释里点名的坑，别把「没报错」当成边界失效
      const updated = await appPool.query("UPDATE platform_admin SET note = 'pwned' WHERE user_id = $1", [
        admin.userId,
      ]);
      expect(updated.rowCount).toBe(0);
      const deleted = await appPool.query("DELETE FROM platform_admin WHERE user_id = $1", [admin.userId]);
      expect(deleted.rowCount).toBe(0);

      const after = await f.admin.query("SELECT note FROM platform_admin WHERE user_id = $1", [admin.userId]);
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]?.note).toBe("test");
      const forged = await f.admin.query("SELECT count(*)::int AS n FROM platform_admin WHERE user_id = $1", [
        target.userId,
      ]);
      expect(forged.rows[0]?.n).toBe(0);
    } finally {
      await f.admin.query("REVOKE INSERT, UPDATE, DELETE ON platform_admin FROM bianfa_app");
    }
  });

  it("bianfa_app 读得到名单（中间件要判定），但只读得到", async () => {
    const r = await appPool.query("SELECT user_id FROM platform_admin ORDER BY granted_at");
    expect(r.rows.map((row) => (row as { user_id: string }).user_id)).toEqual([admin.userId]);
  });

  it("只有 BYPASSRLS 的 bianfa_worker 写得进名单（授予/撤销只能从 SSH 跑 platform-admin.sh）", async () => {
    await workerPool.query("INSERT INTO platform_admin (user_id, granted_by) VALUES ($1, 'bootstrap')", [
      target.userId,
    ]);
    const r = await f.admin.query("SELECT count(*)::int AS n FROM platform_admin WHERE user_id = $1", [
      target.userId,
    ]);
    expect(r.rows[0]?.n).toBe(1);
    await workerPool.query("DELETE FROM platform_admin WHERE user_id = $1", [target.userId]);
    const gone = await f.admin.query("SELECT count(*)::int AS n FROM platform_admin WHERE user_id = $1", [
      target.userId,
    ]);
    expect(gone.rows[0]?.n).toBe(0);
  });

  // ─────────────────────────────────────────── ② 只读事务

  it("「看内容」的事务形状（SET LOCAL transaction_read_only + 切 app.user_id）里，写操作一律 25006", async () => {
    const writes: Array<[string, () => Promise<unknown>]> = [
      [
        "UPDATE",
        () =>
          appDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL transaction_read_only = on`);
            await tx.execute(sql`SELECT set_config('app.user_id', ${target.userId}, true)`);
            return tx.execute(sql`UPDATE notes SET color = 'rose' WHERE id = ${targetNote}::uuid`);
          }),
      ],
      [
        "DELETE",
        () =>
          appDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL transaction_read_only = on`);
            await tx.execute(sql`SELECT set_config('app.user_id', ${target.userId}, true)`);
            return tx.execute(sql`DELETE FROM notes WHERE id = ${targetNote}::uuid`);
          }),
      ],
      [
        "INSERT",
        () =>
          appDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL transaction_read_only = on`);
            await tx.execute(sql`SELECT set_config('app.user_id', ${target.userId}, true)`);
            return tx.execute(
              sql`INSERT INTO audit_log (actor_type, action, outcome) VALUES ('system', 'test.write', 'success')`,
            );
          }),
      ],
    ];
    for (const [label, run] of writes) {
      const err = await expectPgError(run());
      expect(err.code, label).toBe("25006");
      expect(err.message, label).toMatch(/read-only transaction/);
    }
    // 数据确实一点没动
    const note = await f.admin.query("SELECT color, deleted_at FROM notes WHERE id = $1", [targetNote]);
    expect(note.rows[0]).toMatchObject({ color: "graphite", deleted_at: null });
  });

  it("真实的 adminReadAsUser 路径：先 BEGIN，再 SET LOCAL transaction_read_only = on，再切 app.user_id", async () => {
    const h = openHarness({ max: 1 });
    const rec = recordStatements(h.pool);
    try {
      const res = await req(h.app, "GET", `/v1/admin/users/${target.userId}/workspaces`, {
        as: admin.userId,
      });
      expect(res.status).toBe(200);
      const i = rec.statements.findIndex((s) => /transaction_read_only/.test(s));
      expect(i, `实际发出的语句：${JSON.stringify(rec.statements)}`).toBeGreaterThan(0);
      expect(rec.statements[i - 1]).toMatch(/^begin/i);
      expect(rec.statements[i]).toMatch(/SET LOCAL transaction_read_only = on/);
      expect(rec.statements[i + 1]).toMatch(/set_config\('app\.user_id'/);
    } finally {
      rec.restore();
      await h.close();
    }
  });

  // ─────────────────────────────────────────── ③ 身份不残留

  it("事务结束后 app.user_id 不残留：同一条连接的下一次裸查询又是 0 行（连接池复用不泄漏身份）", async () => {
    const h = openHarness({ max: 1 });
    try {
      const res = await req<{ notes: Array<{ id: string }> }>(
        h.app,
        "GET",
        `/v1/admin/users/${target.userId}/notes`,
        { as: admin.userId },
      );
      expect(res.status).toBe(200);
      expect(res.body.notes.map((n) => n.id)).toEqual([targetNote]);

      // max=1：上面那次请求用的就是这条连接
      const guc = await h.pool.query("SELECT current_setting('app.user_id', true) AS v");
      expect(guc.rows[0]?.v).toBe("");
      const leaked = await h.pool.query("SELECT id FROM notes");
      expect(leaked.rows).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
});
