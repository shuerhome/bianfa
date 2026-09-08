// 同步凭据（60 s 的 HS256 JWT）。与桌面端 apps/desktop/src/sync/token.ts 同一套语义，取数换成 /v1。
//
// 必须是缓存 + 单飞：Hocuspocus 在**每次**打开 socket 时都会重新取一次 token
// （HocuspocusProvider.onOpen → sendToken → getToken），而 socket 会一直自动重连。
// 一张写死的字符串 token 只能撑第一次连接，60 秒后每次重连都会以 expired 失败。
//
// token 永远不进 URL、不进日志：它是能读写这个用户全部便笺的凭据。
import { SCHEMA_VERSION } from "@bianfa/shared";
import { v1Fetch } from "../notes-api.js";

/** 提前 10 s 换新的，避开时钟偏差与网络往返 */
const SKEW_MS = 10_000;

interface TokenReply {
  token: string;
  expires_in: number;
  expires_at: number;
}

let cached: { token: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

export async function getSyncToken(): Promise<string> {
  if (cached && cached.expiresAt - SKEW_MS > Date.now()) return cached.token;
  if (inflight) return inflight;
  inflight = (async () => {
    // max_schema_version 显式传：不传的话服务端按 1 处理，将来遇到 v2 的便笺会被静默降成只读
    // （sync/auth.ts 的 readOnly = … || msv < note.schemaVersion），既不报错也存不进去。
    const res = await v1Fetch<TokenReply>("/sync/token", {
      method: "POST",
      body: { max_schema_version: SCHEMA_VERSION },
    });
    if (!res.ok) throw new SyncTokenError(res.error.code, res.error.status);
    // expires_at 可能是秒或毫秒；< 1e12 视为秒
    const raw = res.data.expires_at;
    cached = { token: res.data.token, expiresAt: raw < 1e12 ? raw * 1000 : raw };
    return res.data.token;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function invalidateSyncToken(): void {
  cached = null;
}

/** 只带错误码，不带 token */
export class SyncTokenError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`sync_token_${code}`);
    this.name = "SyncTokenError";
  }
}

/** 测试用：清掉进程内缓存 */
export function resetSyncTokenCacheForTest(): void {
  cached = null;
  inflight = null;
}
