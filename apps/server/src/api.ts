// dist/api.js —— HTTP API 进程入口（Hono）。骨架：/healthz；业务路由在后续阶段挂载。
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();
app.get("/healthz", (c) => c.json({ ok: true, service: "api" }));

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(JSON.stringify({ level: "info", msg: "api listening", port }));
});
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
