// dist/sync.js —— Hocuspocus 同步进程入口。骨架：监听 $PORT 并对 GET /healthz 回 200；房间逻辑在后续阶段实现。
import { Server } from "@hocuspocus/server";

const port = Number(process.env.PORT ?? 4000);
const server = new Server({
  port,
  address: "0.0.0.0",
  name: "bianfa-sync",
  async onRequest({ request, response }) {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "sync" }));
      return Promise.reject(); // 已处理，阻止 Hocuspocus 继续
    }
    return Promise.resolve();
  },
});
await server.listen();
console.log(JSON.stringify({ level: "info", msg: "sync listening", port }));
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    void server.destroy().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 25_000).unref();
  });
}
