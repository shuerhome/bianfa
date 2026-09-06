import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts", "src/**/*.test.ts"] } },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // 集成测试共用一个库：globalSetup 先 DROP SCHEMA public/drizzle 再跑迁移一次（可重复）；
          // 文件串行执行，避免并发 TRUNCATE / 建角色互相干扰。DATABASE_URL 缺失时各文件自行 skip。
          globalSetup: ["test/integration/global-setup.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
