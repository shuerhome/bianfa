import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Web 面（specs/04 §1.5 / §7.2）：产物由 api 进程同源托管（apps/server/src/http/web-static.ts），
// 所以 base 固定为 "/"、不用外部 CDN / 字体；CSP 为 script-src 'self'，构建不得产生内联脚本。
// 开发期：`pnpm --filter @bianfa/web dev` 起 5173，把 /api /v1 /web-config.json 代理到本机 api（3000）；
// 此时 api 的 APP_ORIGIN 需包含 http://127.0.0.1:5173（Better Auth trustedOrigins 精确匹配）。
const API = process.env.BIANFA_API_URL ?? "http://127.0.0.1:3000";
// 同步 WebSocket 在生产里由 Caddy 把 /ws/* 转给 sync-ws（infra/docker/Caddyfile），api 进程自己不处理 /ws。
// 开发期 Vite 得自己转，而且必须 ws: true——不写的话握手会被 Vite 的 HMR 服务吞掉，
// 浏览器只看得到 onclose 1006、没有 reason，和"网络不通"完全无法区分。
const SYNC_WS = process.env.BIANFA_SYNC_WS_URL ?? "ws://127.0.0.1:4000";

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
      "/ws": { target: SYNC_WS, ws: true },
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
            // 编辑器（TipTap + Yjs + Hocuspocus）只有 /notes 打开某张便笺时才用得上。
            // 不单独切出去的话，/login 这种页面也要先下载一份 TipTap——App.tsx 是静态 import 全部页面的。
            // 末尾故意不写 [\\/]：prosemirror-* 是一批同前缀的包名，不是一个目录。
            {
              name: "editor",
              test: /node_modules[\\/](@tiptap|prosemirror-|yjs|lib0|y-protocols|@hocuspocus|nanoid)/,
            },
          ],
        },
      },
    },
  },
});
