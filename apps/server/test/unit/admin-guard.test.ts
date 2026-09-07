// /v1/admin/* 闸门的纯逻辑部分（迁移 0009）。端到端的 401/403/404 由 test/integration/admin-api.test.ts
// 用真实路由覆盖；这里钉的是两件只有把依赖打断才看得见的事：
//  * 判定查询本身出错时必须 fail-closed（当作「不是总管理员」，而不是异常冒泡成 500 或被当成通过）；
//  * 审计写失败不能把「拒绝」变成「放行」。
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type AdminVariables, isPlatformAdmin, requireSuperAdmin } from "../../src/auth/admin-guard.js";
import { ApiFailure } from "../../src/auth/http.js";
import type { AuthContext } from "../../src/auth/index.js";
import type { Db } from "../../src/db/client.js";

const AUTH: AuthContext = {
  userId: "u1",
  sessionId: "s1",
  deviceId: null,
  email: "u1@test.invalid",
  emailVerified: true,
  scopes: [],
};

interface FakeDbOptions {
  /** 名单查询的结果；抛错用来模拟库挂了 */
  rows: () => Promise<Array<{ userId: string }>>;
  /** 审计事务；抛错用来模拟 audit_log 写不进去 */
  onAudit?: () => Promise<void>;
}

/** 只实现 admin-guard 用到的两条链路：select().from().where().limit() 与 transaction() */
function fakeDb(opts: FakeDbOptions): { db: Db; audits: number } {
  const state = { audits: 0 };
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => opts.rows(),
  };
  const db = {
    select: () => chain,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      state.audits += 1;
      if (opts.onAudit) await opts.onAudit();
      return fn({ execute: async () => ({ rows: [] }) });
    },
  };
  return {
    db: db as unknown as Db,
    get audits() {
      return state.audits;
    },
  };
}

function appWith(db: Db, enabled = true): Hono {
  const app = new Hono<{ Variables: AdminVariables }>();
  app.onError((err, c) => {
    if (err instanceof ApiFailure) return c.json({ error: err.code, ...err.extra }, err.status);
    return c.json({ error: "internal_error" }, 500);
  });
  app.use("*", async (c, next) => {
    if (c.req.header("x-anon") !== "1") c.set("auth", AUTH);
    await next();
  });
  app.use("*", requireSuperAdmin({ db, enabled }));
  app.get("/admin/ping", (c) => c.json({ ok: true, flagged: c.get("platformAdmin") === true }));
  return app as unknown as Hono;
}

describe("isPlatformAdmin（迁移 0009）", () => {
  it("名单里有 → true；没有 → false", async () => {
    const hit = fakeDb({ rows: async () => [{ userId: "u1" }] });
    expect(await isPlatformAdmin(hit.db, "u1")).toBe(true);
    const miss = fakeDb({ rows: async () => [] });
    expect(await isPlatformAdmin(miss.db, "u1")).toBe(false);
  });

  it("查询抛错 → false（fail-closed：库挂了不能变成人人都是总管理员）", async () => {
    const broken = fakeDb({
      rows: async () => {
        throw new Error("connection terminated");
      },
    });
    expect(await isPlatformAdmin(broken.db, "u1")).toBe(false);
  });
});

describe("requireSuperAdmin（迁移 0009）", () => {
  it("名单里 → 放行，并在 context 上打标", async () => {
    const res = await appWith(fakeDb({ rows: async () => [{ userId: "u1" }] }).db).request(
      "http://x/admin/ping",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, flagged: true });
  });

  it("不在名单 → 403 insufficient_role + required，并写一条 authz.denied", async () => {
    const f = fakeDb({ rows: async () => [] });
    const res = await appWith(f.db).request("http://x/admin/ping");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "insufficient_role", required: "platform_admin" });
    expect(f.audits).toBe(1);
  });

  it("审计写失败也照样 403（留痕失败不能把拒绝变成放行）", async () => {
    const f = fakeDb({
      rows: async () => [],
      onAudit: async () => {
        throw new Error("audit_log unavailable");
      },
    });
    const res = await appWith(f.db).request("http://x/admin/ping");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "insufficient_role", required: "platform_admin" });
  });

  it("判定查询挂了 → 403 而不是 500（fail-closed 一路贯穿到中间件）", async () => {
    const f = fakeDb({
      rows: async () => {
        throw new Error("connection terminated");
      },
    });
    const res = await appWith(f.db).request("http://x/admin/ping");
    expect(res.status).toBe(403);
  });

  it("PLATFORM_ADMIN_ENABLED=0 → 404，且不查名单、不写审计（整面下线，不是权限问题）", async () => {
    let queried = false;
    const f = fakeDb({
      rows: async () => {
        queried = true;
        return [{ userId: "u1" }];
      },
    });
    const res = await appWith(f.db, false).request("http://x/admin/ping");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(queried).toBe(false);
    expect(f.audits).toBe(0);
  });

  it("没有 auth（理论上到不了这里）→ 401，不当成总管理员", async () => {
    const f = fakeDb({ rows: async () => [{ userId: "u1" }] });
    const res = await appWith(f.db).request("http://x/admin/ping", { headers: { "x-anon": "1" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});
