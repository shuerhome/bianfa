import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    globals: false,
    restoreMocks: true,
    // 单条用例的上限。默认 5 秒对上面放宽后的 asyncUtilTimeout 来说太紧，
    // 一超时就变成"某条随机红"而不是一个能读的断言失败。
    testTimeout: 20_000,
  },
});
