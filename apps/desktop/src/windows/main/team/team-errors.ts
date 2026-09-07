// 团队 / 共享操作的错误 → 文案：服务端稳定错误码映射到 team.err_* / share.err_*，其余回退到 describeError。
import type { TFunction } from "i18next";
import { API_ERROR, isApiError } from "../../../api/http.js";
import { ORG_ERROR } from "../../../api/orgs.js";
import { SHARE_ERROR } from "../../../api/shares.js";
import { describeError, isIpcError } from "../../../ipc/errors.js";

const TEAM_CODES = new Set<string>([
  ...Object.values(ORG_ERROR),
  API_ERROR.notFound,
  API_ERROR.unauthorized,
  "insufficient_permission",
]);

const SHARE_CODES = new Set<string>(Object.values(SHARE_ERROR));

/** Rust api_request 层的失败（连不上 / 未登录）→ 统一的离线文案 */
function transportKey(err: unknown): "err_offline" | "err_unauthorized" | null {
  if (!isIpcError(err) || isApiError(err)) return null;
  if (err.code === "network" || err.code === "unsupported") return "err_offline";
  if (err.code === "auth" || err.code === "unauthorized") return "err_unauthorized";
  return null;
}

/** 团队页：`team.err_<code>`，没有对应文案时返回服务端 message / code */
export function describeTeamError(err: unknown, t: TFunction): string {
  const transport = transportKey(err);
  if (transport) return t(`team.${transport}`);
  if (isApiError(err) && TEAM_CODES.has(err.code)) return t(`team.err_${err.code}`);
  return describeError(err);
}

/** 共享对话框：`share.err_<code>` */
export function describeShareError(err: unknown, t: TFunction): string {
  const transport = transportKey(err);
  if (transport) return t(`share.${transport}`);
  if (isApiError(err) && SHARE_CODES.has(err.code)) return t(`share.err_${err.code}`);
  return describeError(err);
}
