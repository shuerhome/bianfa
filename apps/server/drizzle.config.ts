// drizzle-kit 配置：只用 `generate`（迁移 SQL 进 git，由 src/db/migrate.ts 直连执行），不用 push / pull，
// 所以不配置 dbCredentials。drizzle 表达不了的对象（扩展、角色、序列、RLS、INCLUDE 索引、uuidv7 默认值）
// 用 `drizzle-kit generate --custom --name=<name>` 生成空文件后手写，见 drizzle/0000_*.sql 与 drizzle/0002_*.sql。
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
