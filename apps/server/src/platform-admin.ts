// dist/platform-admin.js —— 平台总管理员名单的唯一写入口（迁移 0009）。
//
// 为什么只能从这里改：platform_admin 表开了 RLS 且只有一条 SELECT 策略，api 进程用的 bianfa_app
// 是 NOBYPASSRLS，因此**即使 api 被完全攻陷也铸不出一个新的总管理员**。写入需要 BYPASSRLS，
// 而 worker 容器的 DATABASE_URL 正是 bianfa_worker —— 所以生产上这样跑（不需要新增任何环境变量或改 compose）：
//
//   cd /srv/bianfa/app/infra/docker
//   docker compose --env-file /srv/bianfa/.env.prod run --rm --no-deps -T worker \
//     node dist/platform-admin.js grant you@example.com
//
// 或者用 infra/vps/platform-admin.sh（自动带上当前部署的 tag）：
//   /srv/bianfa/app/infra/vps/platform-admin.sh grant you@example.com
//
// 用法：list | grant <email> [备注] | revoke <email>
import { sql } from "drizzle-orm";
import { loadBaseEnv } from "./config.js";
import { closeDb, createDb, createPool } from "./db/client.js";
import { createLogger } from "./log.js";

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const [cmd, email, ...rest] = process.argv.slice(2);
  const note = rest.join(" ").trim() || null;
  if (!cmd || !["list", "grant", "revoke"].includes(cmd)) {
    console.error("用法：node dist/platform-admin.js list | grant <email> [备注] | revoke <email>");
    process.exit(2);
  }
  const env = loadBaseEnv();
  const logger = createLogger({ name: "platform-admin" }, env.LOG_LEVEL);
  const pool = createPool(env.DATABASE_URL, { max: 2 });
  const db = createDb(pool);
  try {
    if (cmd === "list") {
      const r = (await db.execute(
        sql`SELECT pa.user_id, u.email, u.name, pa.granted_at, pa.granted_by, pa.note
              FROM platform_admin pa LEFT JOIN "user" u ON u.id = pa.user_id
             ORDER BY pa.granted_at`,
      )) as unknown as { rows: Row[] };
      if (r.rows.length === 0) console.log("（当前没有任何总管理员）");
      for (const row of r.rows) {
        console.log(
          `${String(row.email ?? row.user_id)}\t${String(row.granted_at)}\t${String(row.note ?? "")}`,
        );
      }
      return;
    }

    if (!email) {
      console.error("缺少邮箱");
      process.exit(2);
    }
    const found = (await db.execute(
      sql`SELECT id, email, deleted_at FROM "user" WHERE lower(email) = ${email.trim().toLowerCase()} LIMIT 1`,
    )) as unknown as { rows: Array<{ id: string; email: string; deleted_at: string | null }> };
    const u = found.rows[0];
    if (!u) {
      console.error(`找不到用户：${email}（请先在 Web 端注册这个邮箱，再来授予）`);
      process.exit(1);
    }
    if (cmd === "grant" && u.deleted_at) {
      console.error(`用户 ${u.email} 已注销，不能授予总管理员`);
      process.exit(1);
    }

    if (cmd === "grant") {
      await db.execute(
        sql`INSERT INTO platform_admin (user_id, granted_by, note) VALUES (${u.id}, 'bootstrap', ${note})
            ON CONFLICT (user_id) DO UPDATE SET note = COALESCE(EXCLUDED.note, platform_admin.note)`,
      );
      // 审计：actor_type='system'，因为这条命令来自 SSH 到机器上的人，不是某个已登录会话
      await db.execute(
        sql`INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, outcome, metadata)
            VALUES ('system', NULL, 'admin.granted', 'user', ${u.id}, 'success', ${JSON.stringify({ email: u.email, via: "cli" })}::jsonb)`,
      );
      logger.warn({ userId: u.id, email: u.email }, "platform admin granted");
      console.log(`已授予总管理员：${u.email}`);
      return;
    }

    const deleted = (await db.execute(
      sql`DELETE FROM platform_admin WHERE user_id = ${u.id} RETURNING user_id`,
    )) as unknown as { rows: Row[] };
    if (deleted.rows.length === 0) {
      console.log(`${u.email} 本来就不是总管理员`);
      return;
    }
    await db.execute(
      sql`INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, outcome, metadata)
          VALUES ('system', NULL, 'admin.revoked', 'user', ${u.id}, 'success', ${JSON.stringify({ email: u.email, via: "cli" })}::jsonb)`,
    );
    const left = (await db.execute(sql`SELECT count(*)::int AS n FROM platform_admin`)) as unknown as {
      rows: Array<{ n: number }>;
    };
    logger.warn({ userId: u.id, email: u.email }, "platform admin revoked");
    console.log(`已撤销总管理员：${u.email}（剩余 ${left.rows[0]?.n ?? 0} 人）`);
    if ((left.rows[0]?.n ?? 0) === 0) {
      console.log("注意：现在一个总管理员都没有了，管理台对所有人返回 403，只能再从这条命令重新授予。");
    }
  } finally {
    await pool.end();
    await closeDb();
  }
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      msg: "platform admin command failed",
      err: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
