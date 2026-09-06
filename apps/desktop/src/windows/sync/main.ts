// 隐藏同步宿主入口（sync.html，label `sync`）：无 UI；登录后由 Rust 创建、登出后销毁。
import { SyncHost } from "../../sync/host.js";

const host = new SyncHost();
void host.start();

// 便于 Rust / 调试台触发对账
declare global {
  interface Window {
    __bianfaSyncHost?: SyncHost;
  }
}
window.__bianfaSyncHost = host;
window.addEventListener("beforeunload", () => host.stop());
