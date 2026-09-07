// 隐藏同步宿主入口（sync.html，label `sync`）：无 UI；登录后由 Rust 创建、登出后销毁。
import { clientLog } from "../../ipc/commands.js";
import { SyncHost } from "../../sync/host.js";

const host = new SyncHost();
// 不要再 `void host.start()`：这个 promise 一旦拒绝，整个同步就静默死掉，
// 而隐藏窗口的 console 没人看得到 —— 排查时日志里会是一片空白。
clientLog("info", "sync", "同步宿主已加载");
host.start().then(
  () => clientLog("info", "sync", "同步宿主启动完成"),
  (e: unknown) =>
    clientLog(
      "error",
      "sync",
      `同步宿主启动失败：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    ),
);
window.addEventListener("error", (e) => clientLog("error", "sync", `未捕获错误：${e.message}`));
window.addEventListener("unhandledrejection", (e) =>
  clientLog("error", "sync", `未处理的 promise 拒绝：${String(e.reason)}`),
);

// 便于 Rust / 调试台触发对账
declare global {
  interface Window {
    __bianfaSyncHost?: SyncHost;
  }
}
window.__bianfaSyncHost = host;
window.addEventListener("beforeunload", () => host.stop());
