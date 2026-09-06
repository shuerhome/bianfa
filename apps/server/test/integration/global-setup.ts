// vitest globalSetup（integration project）：从空 schema 跑迁移一次，保证每次集成测试可重复。
// 迁移永远直连（规格 01 §2）：用 DATABASE_URL_DIRECT / DATABASE_DIRECT_URL，缺省退回 DATABASE_URL。
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.js";

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
  console.log(JSON.stringify({ level: "info", msg: "integration db migrated from empty schema", ...result }));
}
