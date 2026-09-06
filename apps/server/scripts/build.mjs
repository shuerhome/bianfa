// 三入口打包成 dist/{api,sync,worker}.js（backend.yml / Dockerfile 契约）。
// 依赖保持 external（镜像里带 node_modules），只把本包与 workspace 包内联，启动快、栈迹可读。
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/api.ts", "src/sync.ts", "src/worker.ts"],
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
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
