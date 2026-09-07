// 六入口打包成 dist/{api,sync,worker,migrate,auth-bootstrap,platform-admin}.js（backend.yml / Dockerfile / infra/vps/deploy.sh 契约）。
// 依赖保持 external（镜像里带 node_modules），只把本包与 workspace 包内联，启动快、栈迹可读。
// 另：把 apps/web/dist（Web 面 Vite 产物）复制到 public/web，api 进程同源托管（src/http/web-static.ts）；没有就跳过。

import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));

rmSync(resolve(root, "dist"), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: [
    "src/api.ts",
    "src/sync.ts",
    "src/worker.ts",
    "src/migrate.ts",
    "src/auth-bootstrap.ts",
    "src/platform-admin.ts",
  ],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  packages: "external",
  // workspace 包不是 node_modules 里的发布包，内联进产物，镜像里不需要它的 dist
  alias: {},
  logLevel: "info",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

// Web 面产物 → public/web（apps/web 未构建时静默跳过：api 照常启动，只是没有登录页）
const webDist = resolve(root, "../web/dist");
const publicWeb = resolve(root, "public/web");
rmSync(publicWeb, { recursive: true, force: true });
if (existsSync(resolve(webDist, "index.html"))) {
  cpSync(webDist, publicWeb, { recursive: true });
  console.log(`web: copied ${webDist} -> ${publicWeb}`);
} else {
  console.log(`web: ${webDist} not built, skipping (api serves no web pages)`);
}
