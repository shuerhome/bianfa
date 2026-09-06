import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const entry = (name: string) => fileURLToPath(new URL(`./${name}.html`, import.meta.url));

// specs/05 §1.2：四个 HTML 入口（note / index=main / settings / sync 隐藏同步宿主）；
// build.target chrome140/safari17.4；minify oxc；cssMinify lightningcss；sourcemap 关；分 react/editor/query 三组。
export default defineConfig({
  plugins: [
    // React Compiler：plugin-react 6 内置 babel-plugin-react-compiler 1.0.0 的 preset；只处理本项目源码
    react({ compiler: true }),
    tailwindcss(),
  ],
  // Tauri 下相对路径最稳（tauri://localhost 与 http://tauri.localhost 都能用）
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Tauri 开发期由 CLI 注入 TAURI_DEV_HOST；这里只监听本机
    host: process.env.TAURI_DEV_HOST ?? "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: ["chrome140", "safari17.4"],
    minify: "oxc",
    cssMinify: "lightningcss",
    sourcemap: false,
    rollupOptions: {
      input: {
        index: entry("index"),
        note: entry("note"),
        settings: entry("settings"),
        sync: entry("sync"),
      },
      output: {
        advancedChunks: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            {
              name: "editor",
              test: /node_modules[\\/](@tiptap|prosemirror-|yjs|lib0|y-protocols|@hocuspocus|dompurify|marked|nanoid)/,
            },
            { name: "query", test: /node_modules[\\/](@tanstack|zustand)[\\/]/ },
          ],
        },
      },
    },
  },
});
