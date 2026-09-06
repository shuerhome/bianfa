// 迁移契约：幂等、restore-checks.sql 依赖的对象、扩展 / 角色 / 序列 / RLS 状态、PG16 vs PG18 的 uuidv7 默认值、生成列。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client.js";
import { uuidv7 } from "../../src/db/ids.js";
import { MIGRATIONS_DIR, runMigrations } from "../../src/db/migrate.js";
import { notes } from "../../src/db/schema/index.js";
import { DIRECT_URL, type Fixture, hasDb, openAdmin, seedUser, truncateAll } from "./helpers.js";

const RESTORE_CHECKS_SQL = fileURLToPath(new URL("../../../../infra/vps/restore-checks.sql", import.meta.url));
const RLS_TABLES = [
  "notes",
  "note_updates",
  "note_snapshots",
  "attachments",
  "attachment_refs",
  "checklist_items",
  "workspaces",
  "shares",
  "note_pins",
];

describe.skipIf(!hasDb)("migrations", () => {
  let f: Fixture;
  beforeAll(() => {
    f = openAdmin();
  });
  afterAll(async () => {
    await truncateAll(f.admin);
    await f.admin.end();
    await closeDb();
  });

  it("globalSetup 已从空库跑通；再次运行是空操作（幂等），已应用数 = journal 条目数", async () => {
    const journal = JSON.parse(readFileSync(`${MIGRATIONS_DIR}/meta/_journal.json`, "utf8")) as {
      entries: unknown[];
    };
    const again = await runMigrations(DIRECT_URL as string);
    expect(again.applied).toBe(0);
    expect(again.total).toBe(journal.entries.length);
  });

  it('restore-checks 契约："user" 表、notes.deleted_at、note_updates.created_at(timestamptz) 存在', async () => {
    const cols = await f.admin.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'notes' AND column_name = 'deleted_at')
            OR (table_name = 'note_updates' AND column_name = 'created_at'))`,
    );
    expect(cols.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table_name: "notes", column_name: "deleted_at", data_type: "timestamp with time zone" }),
        expect.objectContaining({
          table_name: "note_updates",
          column_name: "created_at",
          data_type: "timestamp with time zone",
        }),
      ]),
    );
    const u = await f.admin.query('SELECT count(*)::int AS n FROM "user"');
    expect(u.rows[0]?.n).toBe(0);
  });

  it("infra/vps/restore-checks.sql 原样可执行，且恰好输出 users|notes|writes_24h|last_write_age_hours 一行", async () => {
    const sql = readFileSync(RESTORE_CHECKS_SQL, "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("\\") && !line.trim().startsWith("--"))
      .join("\n");
    const r = await f.admin.query<Record<string, string>>(sql);
    expect(r.rows).toHaveLength(1);
    expect(Object.values(r.rows[0] as Record<string, string>)[0]).toMatch(/^\d+\|\d+\|\d+\|-?\d+(\.\d+)?$/);
  });

  it("扩展 vector / pg_bigm / pg_stat_statements / pgcrypto 已装；序列 global_lsn 存在", async () => {
    const ext = await f.admin.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_bigm','pg_stat_statements','pgcrypto') ORDER BY 1",
    );
    expect(ext.rows.map((r) => r.extname)).toEqual(["pg_bigm", "pg_stat_statements", "pgcrypto", "vector"]);
    const seq = await f.admin.query("SELECT to_regclass('public.global_lsn') IS NOT NULL AS ok");
    expect(seq.rows[0]?.ok).toBe(true);
  });

  it("角色：bianfa_app NOBYPASSRLS，bianfa_worker BYPASSRLS；两者对 public 表有 DML、无 owner", async () => {
    const roles = await f.admin.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('bianfa_app','bianfa_worker') ORDER BY 1",
    );
    expect(roles.rows).toEqual([
      { rolname: "bianfa_app", rolbypassrls: false, rolsuper: false },
      { rolname: "bianfa_worker", rolbypassrls: true, rolsuper: false },
    ]);
    const priv = await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables t
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND NOT (has_table_privilege('bianfa_app', quote_ident(t.table_name), 'SELECT,INSERT,UPDATE,DELETE')
               AND has_table_privilege('bianfa_worker', quote_ident(t.table_name), 'SELECT,INSERT,UPDATE,DELETE'))`,
    );
    expect(priv.rows[0]?.n).toBe(0);
    const owners = await f.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner IN ('bianfa_app','bianfa_worker')",
    );
    expect(owners.rows[0]?.n).toBe(0);
    const seqPriv = await f.admin.query(
      "SELECT has_sequence_privilege('bianfa_app','global_lsn','USAGE') AND has_sequence_privilege('bianfa_worker','global_lsn','USAGE') AS ok",
    );
    expect(seqPriv.rows[0]?.ok).toBe(true);
  });

  it(`RLS 已 ENABLE + FORCE 且每表恰好一条 TO bianfa_app 的策略：${RLS_TABLES.join(", ")}`, async () => {
    const r = await f.admin.query<{ relname: string; rls: boolean; force: boolean; policies: number }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid
                 AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'bianfa_app')]::oid[]) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [RLS_TABLES],
    );
    expect(r.rows).toHaveLength(RLS_TABLES.length);
    for (const row of r.rows) expect(row, row.relname).toEqual({ relname: row.relname, rls: true, force: true, policies: 1 });
    // Better Auth 表不加 RLS
    const auth = await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('user','session','organization','member') AND relrowsecurity`,
    );
    expect(auth.rows[0]?.n).toBe(0);
  });

  it("uuidv7() 默认值只在 PG ≥ 18 存在（本地 PG16 没有该函数）", async () => {
    const v = await f.admin.query<{ v: number }>("SELECT current_setting('server_version_num')::int AS v");
    const def = await f.admin.query<{ column_default: string | null }>(
      "SELECT column_default FROM information_schema.columns WHERE table_name = 'workspaces' AND column_name = 'id'",
    );
    if ((v.rows[0]?.v as number) >= 180000) expect(def.rows[0]?.column_default).toBe("uuidv7()");
    else expect(def.rows[0]?.column_default).toBeNull();
  });

  it("生成列 title_cache / pinned 与 lsn 默认值（global_lsn）", async () => {
    await truncateAll(f.admin);
    const { userId, workspaceId } = await seedUser(f.adminDb, "u_migrate");
    const now = new Date();
    const [a, b] = await f.adminDb
      .insert(notes)
      .values([
        { id: uuidv7(), workspaceId, createdBy: userId, contentText: "第一行标题\n第二行正文", zMode: 1, createdAt: now, updatedAt: now },
        { id: uuidv7(), workspaceId, createdBy: userId, contentText: "", zMode: 2, createdAt: now, updatedAt: now },
      ])
      .returning({ titleCache: notes.titleCache, pinned: notes.pinned, lsn: notes.lsn });
    expect(a).toEqual({ titleCache: "第一行标题", pinned: true, lsn: expect.any(Number) });
    expect(b).toEqual({ titleCache: "", pinned: false, lsn: (a?.lsn as number) + 1 });
  });
});
