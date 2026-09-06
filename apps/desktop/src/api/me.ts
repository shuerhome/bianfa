// 账号 / 设备 / 组织 / 导出（服务端 src/auth/routes.ts + auth/services/{me,devices,orgs}.ts、routes/account.ts）。
// 登录态本身由 Rust 维护（auth_status）；这里是设置页「账号」用的读写接口。
import { apiJson, isoToMs, isoToMsOr } from "./http.js";

export type Plan = "free" | "pro" | "team";
export type OrgRole = "owner" | "admin" | "member";
export type MemberStatus = "active" | "suspended" | "removed";

export interface MeUser {
  id: string;
  name: string | null;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: number | null;
  aiOptIn: boolean;
  twoFactorEnabled: boolean;
}

export interface MeOrg {
  id: string;
  name: string;
  slug: string | null;
  plan: Plan;
  enterpriseMode: boolean;
  role: OrgRole;
  status: MemberStatus;
  joinedAt: number | null;
}

export interface Me {
  user: MeUser;
  plan: Plan;
  personalWorkspaceId: string | null;
  orgs: MeOrg[];
  activeDevices: number;
  currentDeviceId: string | null;
  deletionDueAt: number | null;
  /** 安全码最近一次设置时间（Unix ms）；null = 尚未设置（社交登录建的账号） */
  securityCodeSetAt: number | null;
  serverTime: number | null;
}

interface MeDto {
  user: {
    id: string;
    name: string | null;
    email: string;
    email_verified: boolean;
    image: string | null;
    created_at: string;
    ai_opt_in: boolean;
    two_factor_enabled: boolean;
  };
  plan: Plan;
  personal_workspace_id: string | null;
  orgs: Array<{
    id: string;
    name: string;
    slug: string | null;
    plan: Plan;
    enterprise_mode: boolean;
    role: OrgRole;
    status: MemberStatus;
    joined_at: string;
  }>;
  active_devices: number;
  current_device_id: string | null;
  deletion_due_at: string | null;
  security_code_set_at?: string | null;
  server_time?: number;
}

export function mapMe(m: MeDto): Me {
  return {
    user: {
      id: m.user.id,
      name: m.user.name ?? null,
      email: m.user.email,
      emailVerified: Boolean(m.user.email_verified),
      image: m.user.image ?? null,
      createdAt: isoToMs(m.user.created_at),
      aiOptIn: Boolean(m.user.ai_opt_in),
      twoFactorEnabled: Boolean(m.user.two_factor_enabled),
    },
    plan: m.plan ?? "free",
    personalWorkspaceId: m.personal_workspace_id ?? null,
    orgs: (m.orgs ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug ?? null,
      plan: o.plan ?? "free",
      enterpriseMode: Boolean(o.enterprise_mode),
      role: o.role,
      status: o.status ?? "active",
      joinedAt: isoToMs(o.joined_at),
    })),
    activeDevices: m.active_devices ?? 0,
    currentDeviceId: m.current_device_id ?? null,
    deletionDueAt: isoToMs(m.deletion_due_at),
    securityCodeSetAt: isoToMs(m.security_code_set_at),
    serverTime: typeof m.server_time === "number" ? m.server_time : null,
  };
}

/** GET /v1/me */
export async function fetchMe(): Promise<Me> {
  return mapMe(await apiJson<MeDto>("GET", "/v1/me"));
}

// ── 设备（specs/04 §2.4：远程登出只撤 token，本地数据不动） ──

export type DevicePlatform = "windows" | "macos" | "linux";

export interface Device {
  id: string;
  name: string;
  platform: DevicePlatform;
  appVersion: string;
  lastIp: string | null;
  lastSeenAt: number;
  createdAt: number;
  revokedAt: number | null;
  current: boolean;
}

interface DeviceDto {
  id: string;
  name: string;
  platform: DevicePlatform;
  app_version: string;
  last_ip: string | null;
  last_seen_at: string;
  created_at: string;
  revoked_at: string | null;
  current: boolean;
}

export function mapDevice(d: DeviceDto): Device {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    appVersion: d.app_version,
    lastIp: d.last_ip ?? null,
    lastSeenAt: isoToMsOr(d.last_seen_at, 0),
    createdAt: isoToMsOr(d.created_at, 0),
    revokedAt: isoToMs(d.revoked_at),
    current: Boolean(d.current),
  };
}

/** GET /v1/me/devices（含已撤销的；按 last_seen_at 倒序） */
export async function listDevices(): Promise<Device[]> {
  const r = await apiJson<{ devices: DeviceDto[] }>("GET", "/v1/me/devices");
  return (r.devices ?? []).map(mapDevice);
}

/** DELETE /v1/me/devices/:id → { revoked: true, device_id } */
export async function revokeDevice(deviceId: string): Promise<{ revoked: boolean; deviceId: string }> {
  const r = await apiJson<{ revoked: boolean; device_id: string }>(
    "DELETE",
    `/v1/me/devices/${encodeURIComponent(deviceId)}`,
  );
  return { revoked: Boolean(r.revoked), deviceId: r.device_id };
}

/** POST /v1/me/devices/revoke-all { keep_current? } → { revoked: string[], count } */
export async function revokeAllDevices(opts: { keepCurrent?: boolean } = {}): Promise<{
  revoked: string[];
  count: number;
}> {
  const r = await apiJson<{ revoked: string[]; count: number }>("POST", "/v1/me/devices/revoke-all", {
    body: { keep_current: opts.keepCurrent ?? false },
  });
  return { revoked: r.revoked ?? [], count: r.count ?? 0 };
}

// ── 安全码（只用于「忘记密码」时在 Web 端重置密码；服务端 auth/services/me.ts changeSecurityCode） ──

export const SECURITY_CODE_MIN = 4;
export const SECURITY_CODE_MAX = 32;

/**
 * POST /v1/me/security-code { password, new_security_code } → { security_code_set_at }。
 * 403 invalid_password（当前密码不对）/ 400 security_code_equals_password / 400 validation_failed / 409 no_password。
 */
export async function changeSecurityCode(input: {
  password: string;
  newSecurityCode: string;
}): Promise<{ securityCodeSetAt: number | null }> {
  const r = await apiJson<{ security_code_set_at: string }>("POST", "/v1/me/security-code", {
    body: { password: input.password, new_security_code: input.newSecurityCode.trim() },
  });
  return { securityCodeSetAt: isoToMs(r.security_code_set_at) };
}

// ── 账号删除（30 天宽限；服务端会撤销全部 token） ──

/** POST /v1/me/delete { confirm: "DELETE" } → 202 { deletion_due_at }；唯一 owner → 409 transfer_ownership_first */
export async function scheduleAccountDeletion(): Promise<{ deletionDueAt: number | null }> {
  const r = await apiJson<{ deletion_due_at: string }>("POST", "/v1/me/delete", {
    body: { confirm: "DELETE" },
  });
  return { deletionDueAt: isoToMs(r.deletion_due_at) };
}

/** POST /v1/me/delete/cancel（未在宽限期 → 409 not_scheduled） */
export async function cancelAccountDeletion(): Promise<void> {
  await apiJson<{ deletion_due_at: null }>("POST", "/v1/me/delete/cancel");
}

// ── 组织 ──

export interface Org {
  id: string;
  name: string;
  slug: string | null;
  logo: string | null;
  plan: Plan;
  enterpriseMode: boolean;
  createdAt: number | null;
  role: OrgRole;
  status: MemberStatus;
}

interface OrgDto {
  id: string;
  name: string;
  slug: string | null;
  logo: string | null;
  plan: Plan;
  enterprise_mode: boolean;
  created_at: string;
  role: OrgRole;
  status: MemberStatus;
}

/** GET /v1/orgs → { orgs } */
export async function listOrgs(): Promise<Org[]> {
  const r = await apiJson<{ orgs: OrgDto[] }>("GET", "/v1/orgs");
  return (r.orgs ?? []).map((o) => ({
    id: o.id,
    name: o.name,
    slug: o.slug ?? null,
    logo: o.logo ?? null,
    plan: o.plan ?? "free",
    enterpriseMode: Boolean(o.enterprise_mode),
    createdAt: isoToMs(o.created_at),
    role: o.role,
    status: o.status ?? "active",
  }));
}

// ── 云端导出（specs/04 §7.9：pg-boss export.build → R2 zip，预签名 24 h；24 h 内重复 → 429 export_rate_limited） ──

export type ExportJobStatus = "queued" | "running" | "ready" | "failed" | "expired";

export interface ExportJob {
  id: string;
  status: ExportJobStatus;
  byteSize: number | null;
  error: string | null;
  expiresAt: number | null;
  createdAt: number | null;
  finishedAt: number | null;
  downloadUrl: string | null;
}

/** POST /v1/me/export → 202 { job_id, status: "queued" } */
export async function requestCloudExport(): Promise<{ jobId: string; status: ExportJobStatus }> {
  const r = await apiJson<{ job_id: string; status: ExportJobStatus }>("POST", "/v1/me/export", {
    body: { scope: "user" },
  });
  return { jobId: r.job_id, status: r.status };
}

/** GET /v1/me/export/:job_id → { job } */
export async function fetchCloudExport(jobId: string): Promise<ExportJob> {
  const r = await apiJson<{
    job: {
      id: string;
      status: ExportJobStatus;
      byte_size: number | null;
      error: string | null;
      expires_at: string | null;
      created_at: string | null;
      finished_at: string | null;
      download_url: string | null;
    };
  }>("GET", `/v1/me/export/${encodeURIComponent(jobId)}`);
  const j = r.job;
  return {
    id: j.id,
    status: j.status,
    byteSize: j.byte_size ?? null,
    error: j.error ?? null,
    expiresAt: isoToMs(j.expires_at),
    createdAt: isoToMs(j.created_at),
    finishedAt: isoToMs(j.finished_at),
    downloadUrl: j.download_url ?? null,
  };
}
