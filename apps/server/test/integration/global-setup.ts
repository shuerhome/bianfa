// vitest globalSetup（integration project）：从空 schema 跑迁移一次，保证每次集成测试可重复。
// 迁移永远直连（规格 01 §2）：用 DATABASE_URL_DIRECT / DATABASE_DIRECT_URL，缺省退回 DATABASE_URL。
//
// 迁移之后紧接着建测试角色（bianfa_rls_test / bianfa_worker_test）。这两个角色原本只由
// rls.test.ts 和 admin-privilege.test.ts 自己在 beforeAll 里建，而管理台那几个文件
// （admin-api / admin-session / admin-account-flow）的 openHarness 是**直接以
// bianfa_rls_test 身份连库**的、从不创建它——于是能不能跑通，取决于「rls.test.ts 有没有
// 恰好排在它们前面」。开发机上角色早就存在，永远看不出问题；CI 的全新库里就是一屏
//   FATAL: password authentication failed for user "bianfa_rls_test"
//   DETAIL: Role "bianfa_rls_test" does not exist.
// 放在这里而不是让每个文件各自调用，是因为这样顺序依赖从结构上就不存在了。
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.js";
import { ensureTestRoles } from "./helpers.js";

const DIRECT_URL =
  process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL;

export async function setup(): Promise<void> {
  if (!DIRECT_URL) {
    console.log(JSON.stringify({ level: "warn", msg: "DATABASE_URL 未设置：集成测试整体 skip" }));
    return;
  }
  const client = new pg.Client({ connectionString: DIRECT_URL });
  await client.connect();
  try {
    // drizzle.__drizzle_migrations 也要清掉，否则 migrate() 会认为已应用
    await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
  const result = await runMigrations(DIRECT_URL);
  // bianfa_app / bianfa_worker 由迁移 0000 建，所以测试角色必须排在迁移之后（它要 GRANT 这两个）
  const rolePool = new pg.Pool({ connectionString: DIRECT_URL, max: 1 });
  try {
    await ensureTestRoles(rolePool);
  } finally {
    await rolePool.end();
  }
  console.log(JSON.stringify({ level: "info", msg: "integration db migrated from empty schema", ...result }));
}
