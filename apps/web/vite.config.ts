import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Web 面（specs/04 §1.5 / §7.2）：产物由 api 进程同源托管（apps/server/src/http/web-static.ts），
// 所以 base 固定为 "/"、不用外部 CDN / 字体；CSP 为 script-src 'self'，构建不得产生内联脚本。
// 开发期：`pnpm --filter @bianfa/web dev` 起 5173，把 /api /v1 /web-config.json 代理到本机 api（3000）；
// 此时 api 的 APP_ORIGIN 需包含 http://127.0.0.1:5173（Better Auth trustedOrigins 精确匹配）。
const API = process.env.BIANFA_API_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api": API,
      "/v1": API,
      "/web-config.json": API,
    },
  },
  build: {
    minify: "oxc",
    cssMinify: "lightningcss",
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            {
              name: "auth",
              test: /node_modules[\\/](better-auth|@better-auth|@better-fetch|nanostores|@nanostores)[\\/]/,
            },
            { name: "i18n", test: /node_modules[\\/](i18next|react-i18next)[\\/]/ },
          ],
        },
      },
    },
  },
});
