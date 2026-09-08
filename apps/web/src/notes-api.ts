// 网页端（含 iOS「添加到主屏幕」的 PWA）的便笺取数层。服务端见 apps/server/src/auth/web-session.ts。
//
// 通道说明：/v1 的其余客户端（桌面端）用 `Authorization: Bearer <不透明令牌>`；浏览器里拿不到那种令牌，
// 所以服务端为 /v1 另开了一条同源会话通道 requireBearerOrWebSession。配合它要做两件事：
//   ① credentials: "same-origin" —— 带上 Better Auth 的会话 cookie；
//   ② X-Bianfa-Web: 1 —— 自定义头，跨源请求要带它必须先过 CORS 预检，而预检只放行 APP_ORIGIN（CSRF 防线的一环）。
// 前端绝不自造 Bearer 令牌：那等于在浏览器里复刻一份桌面端凭据，一次 XSS 就全失守。
//
// 字段名一律与服务端 DTO 逐字对应（snake_case），不做驼峰改写，避免两边漂移时看不出来。
import type { Result } from "./api.js";
import { toFailure } from "./lib/errors.js";

/** 服务端一次最多回 500 条（apps/server/src/http/validate.ts 的 LIMITS.listMax） */
const PAGE_LIMIT = 500;
/** 排干发现分页的硬上限：500 × 200 = 10 万条。够用，同时保证服务端异常时不会转成死循环 */
const MAX_PAGES = 200;

interface V1ErrorBody {
  error?: unknown;
}

async function v1Fetch<T>(
  path: string,
  init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal } = {},
): Promise<Result<T>> {
  const headers: Record<string, string> = { accept: "application/json", "x-bianfa-web": "1" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(`/v1${path}`, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers,
      ...(init.signal ? { signal: init.signal } : {}),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const body = (await res.json().catch(() => ({}))) as V1ErrorBody & Record<string, unknown>;
    if (!res.ok) {
      const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
      return { ok: false, error: { status: res.status, code, message: "" } };
    }
    return { ok: true, data: body as T };
  } catch (err) {
    return { ok: false, error: toFailure(err) };
  }
}

// ─────────────────────────────────────────────────────────── DTO

export type NotePerm = "viewer" | "commenter" | "editor" | "manager";

/** GET /v1/workspaces 的一项（apps/server/src/services/workspaces.ts 的 workspaceDto） */
export interface WebWorkspace {
  id: string;
  kind: "personal" | "team" | string;
  org_id: string | null;
  team_id: string | null;
  owner_user_id: string | null;
  name: string;
  default_note_perm: NotePerm;
  effective_perm: NotePerm;
  created_at: string | null;
  archived_at: string | null;
}

/** 发现接口的一项（apps/server/src/services/notes.ts 的 noteMetaDto，只列网页端用得到的字段） */
export interface WebNote {
  id: string;
  workspace_id: string;
  title: string;
  excerpt: string;
  color: string;
  pinned: boolean;
  head_seq: number;
  version: number;
  encryption: string;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  purged_at: string | null;
  archived_at: string | null;
}

interface DiscoverPage {
  workspace_id: string;
  effective_perm: NotePerm;
  notes: WebNote[];
  next_version: number;
  has_more: boolean;
}

// ─────────────────────────────────────────────────────────── 端点

/** GET /v1/workspaces：个人工作区排在最前（服务端 ORDER BY kind='personal' DESC, created_at ASC） */
export async function fetchWorkspaces(signal?: AbortSignal): Promise<Result<WebWorkspace[]>> {
  const res = await v1Fetch<{ workspaces: WebWorkspace[] }>("/workspaces", { ...(signal ? { signal } : {}) });
  if (!res.ok) return res;
  return { ok: true, data: Array.isArray(res.data.workspaces) ? res.data.workspaces : [] };
}

export interface NoteList {
  perm: NotePerm;
  /** 已按「置顶优先、其次改动时间倒序」排好；回收站与已彻底删除的行不在里面 */
  notes: WebNote[];
  /** 服务端的发现游标；留给后续做增量刷新 */
  version: number;
  /** 分页在到达 MAX_PAGES 时被截断（正常规模到不了） */
  truncated: boolean;
}

/**
 * 排干 GET /v1/notes?workspace_id 的发现分页。
 *
 * 这个接口是**增量发现**语义：按 lsn 升序返回、包含已删除的行（靠 deleted_at 告诉客户端「这条没了」），
 * 所以要拿「当前可见的便笺」必须自己翻完所有页再过滤，不能只取第一页就当成全部 —— 桌面端曾经卡在
 * 65 张就是同一类错误。
 */
export async function fetchNotes(workspaceId: string, signal?: AbortSignal): Promise<Result<NoteList>> {
  const byId = new Map<string, WebNote>();
  let since = 0;
  let perm: NotePerm = "viewer";
  let truncated = true;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const q = `?workspace_id=${encodeURIComponent(workspaceId)}&since_version=${since}&limit=${PAGE_LIMIT}`;
    const res = await v1Fetch<DiscoverPage>(`/notes${q}`, { ...(signal ? { signal } : {}) });
    if (!res.ok) return res;
    perm = res.data.effective_perm;
    for (const n of res.data.notes ?? []) byId.set(n.id, n);
    // next_version 没往前走就停：再请求一次只会拿到同一页
    if (!res.data.has_more || res.data.next_version <= since) {
      truncated = false;
      break;
    }
    since = res.data.next_version;
  }
  const notes = [...byId.values()].filter((n) => !n.deleted_at && !n.purged_at).sort(compareNotes);
  return { ok: true, data: { perm, notes, version: since, truncated } };
}

/** 置顶在前；同组按改动时间倒序，没有时间的排在最后（用 created_at 兜底） */
function compareNotes(a: WebNote, b: WebNote): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return stamp(b) - stamp(a);
}

function stamp(n: WebNote): number {
  const raw = n.updated_at ?? n.created_at;
  if (!raw) return 0;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? 0 : t;
}
