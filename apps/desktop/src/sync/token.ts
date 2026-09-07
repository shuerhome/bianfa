// 短时 JWT（60 s）：每次（重）连接前经 auth_sync_token 取；缓存到 expiresAt - 10 s；token 永不进 URL/日志。
import { authSyncToken, clientLog } from "../ipc/commands.js";

const SKEW_MS = 10_000;
let cached: { token: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

export async function getSyncToken(): Promise<string> {
  if (cached && cached.expiresAt - SKEW_MS > Date.now()) return cached.token;
  if (inflight) return inflight;
  inflight = authSyncToken()
    .then((res) => {
      // expiresAt 可能是秒或毫秒；<1e12 视为秒
      const expiresAt = res.expiresAt < 1e12 ? res.expiresAt * 1000 : res.expiresAt;
      cached = { token: res.token, expiresAt };
      inflight = null;
      // 只记「拿到了、什么时候过期」，token 本身永不进日志
      clientLog("info", "sync", `已取得同步凭据（${Math.round((expiresAt - Date.now()) / 1000)} 秒后过期）`);
      return res.token;
    })
    .catch((err: unknown) => {
      inflight = null;
      // 取不到凭据 = 连不上，且 Hocuspocus 不会把这个错误显示到任何地方
      clientLog("error", "sync", `取同步凭据失败：${err instanceof Error ? err.message : String(err)}`);
      throw err;
    });
  return inflight;
}

export function invalidateSyncToken(): void {
  cached = null;
}
