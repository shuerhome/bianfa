// sync-ws 集成测试公共工具：进程内起 Hocuspocus（临时端口）、@hocuspocus/provider + ws 客户端、造数、pg-boss 队列。
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { SignJWT } from "jose";
import type pg from "pg";
import { PgBoss } from "pg-boss";
import WebSocket from "ws";
import * as Y from "yjs";
import { createDb, createPool, type Db } from "../../src/db/client.js";
import { uuidv7 } from "../../src/db/ids.js";
import { member, notes, organization, shares, workspaces } from "../../src/db/schema/index.js";
import { createLogger } from "../../src/log.js";
import { PROJECT_QUEUE } from "../../src/sync/persistence.js";
import { createSyncServer, type SyncServer, type SyncServerOptions } from "../../src/sync/server.js";
import { SYNC_TOKEN_ISSUER, signSyncToken } from "../../src/sync/token.js";
import { DIRECT_URL, POOLED_URL } from "./helpers.js";

export const TEST_SECRET = "bianfa-sync-integration-test-secret-0123456789abcdef";

export interface Harness {
  sync: SyncServer;
  url: string;
  port: number;
  pool: pg.Pool;
  db: Db;
  stop(): Promise<void>;
}

let instanceSeq = 0;

/** 进程内启动一个 sync 实例（临时端口、短 debounce） */
export async function startSync(overrides: Partial<SyncServerOptions> = {}): Promise<Harness> {
  const pool = createPool(POOLED_URL as string, { max: 6 });
  const db = createDb(pool);
  instanceSeq += 1;
  const sync = createSyncServer({
    port: 0,
    address: "127.0.0.1",
    pool,
    db,
    tokenSecret: TEST_SECRET,
    directUrl: DIRECT_URL,
    logger: createLogger({ name: "sync-test", instance: instanceSeq }, process.env.SYNC_TEST_LOG ?? "silent"),
    debounce: 50,
    maxDebounce: 200,
    ...overrides,
  });
  const { port } = await sync.listen();
  return {
    sync,
    url: `ws://127.0.0.1:${port}`,
    port,
    pool,
    db,
    async stop() {
      await sync.shutdown({ timeoutMs: 10_000 });
      await pool.end();
    },
  };
}

export interface ClientEvents {
  authFailed: string[];
  authenticated: string[];
  stateless: string[];
  closes: string[];
  synced: number;
}

export interface Client {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  socket: HocuspocusProviderWebsocket;
  events: ClientEvents;
  destroy(): void;
}

export function openSocket(url: string, extra: { maxAttempts?: number } = {}): HocuspocusProviderWebsocket {
  return new HocuspocusProviderWebsocket({
    url,
    WebSocketPolyfill: WebSocket,
    delay: 50,
    minDelay: 50,
    maxDelay: 200,
    messageReconnectTimeout: 20_000,
    ...(extra.maxAttempts !== undefined ? { maxAttempts: extra.maxAttempts } : {}),
  });
}

/** 一个 provider（可共享 socket）；token 可为字符串或异步回调 */
export function connectClient(
  url: string,
  name: string,
  token: string | (() => Promise<string>),
  opts: { doc?: Y.Doc; socket?: HocuspocusProviderWebsocket } = {},
): Client {
  const socket = opts.socket ?? openSocket(url);
  const doc = opts.doc ?? new Y.Doc({ gc: true });
  const events: ClientEvents = { authFailed: [], authenticated: [], stateless: [], closes: [], synced: 0 };
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name,
    document: doc,
    token,
    onAuthenticationFailed: ({ reason }: { reason: string }) => {
      events.authFailed.push(reason);
    },
    onAuthenticated: ({ scope }: { scope: string }) => {
      events.authenticated.push(scope);
    },
    onStateless: ({ payload }: { payload: string }) => {
      events.stateless.push(payload);
    },
    onSynced: ({ state }: { state: boolean }) => {
      if (state) events.synced += 1;
    },
    onClose: ({ event }: { event: { code: number; reason: string } }) => {
      events.closes.push(`${event.code}:${event.reason}`);
    },
  });
  provider.attach();
  return {
    doc,
    provider,
    socket,
    events,
    destroy() {
      provider.destroy();
      if (!opts.socket) socket.destroy();
    },
  };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${label} (${timeoutMs}ms)`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function tokenFor(
  userId: string,
  opts: { did?: string | null; sid?: string | null; msv?: number; now?: number; secret?: string } = {},
): Promise<string> {
  const { token } = await signSyncToken(
    opts.secret ?? TEST_SECRET,
    { sub: userId, did: opts.did ?? null, sid: opts.sid ?? null, msv: opts.msv ?? 1 },
    opts.now,
  );
  return token;
}

/** aud 错误的 token（其余 claims 合法） */
export async function badAudienceToken(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ did: null, sid: null, msv: 1 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SYNC_TOKEN_ISSUER)
    .setAudience("bianfa-other")
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(new TextEncoder().encode(TEST_SECRET));
}

export async function seedNote(
  db: Db,
  input: {
    noteId?: string;
    workspaceId: string;
    userId: string;
    purgedAt?: Date | null;
    purgeAfter?: Date | null;
  },
): Promise<string> {
  const noteId = input.noteId ?? uuidv7();
  await db.insert(notes).values({
    id: noteId,
    workspaceId: input.workspaceId,
    createdBy: input.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
    purgedAt: input.purgedAt ?? null,
    purgeAfter: input.purgeAfter ?? null,
    deletedAt: input.purgeAfter ? new Date() : null,
  });
  return noteId;
}

export async function seedTeamWorkspace(
  db: Db,
  input: { ownerUserId: string; memberUserIds: string[]; defaultNotePerm?: "viewer" | "editor" },
): Promise<{ orgId: string; workspaceId: string }> {
  const orgId = uuidv7();
  await db.insert(organization).values({ id: orgId, name: `org-${orgId.slice(-6)}`, slug: `org-${orgId}` });
  await db
    .insert(member)
    .values({ id: uuidv7(), organizationId: orgId, userId: input.ownerUserId, role: "owner" });
  for (const uid of input.memberUserIds) {
    await db.insert(member).values({ id: uuidv7(), organizationId: orgId, userId: uid, role: "member" });
  }
  const workspaceId = uuidv7();
  await db.insert(workspaces).values({
    id: workspaceId,
    kind: "team",
    orgId,
    name: "team ws",
    defaultNotePerm: input.defaultNotePerm ?? "editor",
  });
  return { orgId, workspaceId };
}

export async function shareNote(
  db: Db,
  input: {
    noteId: string;
    granteeUserId: string;
    perm: "viewer" | "commenter" | "editor" | "manager";
    createdBy: string;
  },
): Promise<string> {
  const id = uuidv7();
  await db.insert(shares).values({
    id,
    noteId: input.noteId,
    granteeKind: "user",
    granteeUserId: input.granteeUserId,
    perm: input.perm,
    createdBy: input.createdBy,
  });
  return id;
}

/** 安装 pg-boss schema（超级用户直连）并确保 note.project 队列存在 */
export async function ensureProjectQueue(): Promise<void> {
  const boss = new PgBoss({
    connectionString: DIRECT_URL as string,
    supervise: false,
    schedule: false,
    max: 2,
  });
  await boss.start();
  try {
    await boss.createQueue(PROJECT_QUEUE);
  } catch {
    /* already exists */
  }
  await boss.stop({ graceful: false, close: true, timeout: 1_000 });
}

export async function projectJobs(
  admin: pg.Pool,
  noteId: string,
): Promise<Array<{ note_id: string; seq: number; state: string }>> {
  const r = await admin.query<{ note_id: string; seq: number; state: string }>(
    `SELECT (data->>'note_id') AS note_id, (data->>'seq')::int AS seq, state::text AS state
       FROM pgboss.job WHERE name = $1 AND data->>'note_id' = $2 ORDER BY created_on`,
    [PROJECT_QUEUE, noteId],
  );
  return r.rows;
}

export interface NoteRow {
  head_seq: number;
  crdt_sv: Buffer | null;
  crdt_bytes: number;
  created_by: string;
  workspace_id: string;
}

export async function readNote(admin: pg.Pool, noteId: string): Promise<NoteRow | null> {
  const r = await admin.query<NoteRow>(
    "SELECT head_seq::int AS head_seq, crdt_sv, crdt_bytes, created_by, workspace_id::text AS workspace_id FROM notes WHERE id = $1",
    [noteId],
  );
  return r.rows[0] ?? null;
}

export async function updateRows(
  admin: pg.Pool,
  noteId: string,
): Promise<Array<{ seq: number; author_id: string | null }>> {
  const r = await admin.query<{ seq: number; author_id: string | null }>(
    "SELECT seq::int AS seq, author_id FROM note_updates WHERE note_id = $1 ORDER BY seq",
    [noteId],
  );
  return r.rows;
}

/** 在 body 里追加一段文字（模拟编辑器） */
export function typeText(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const body = doc.getXmlFragment("body");
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, text);
    p.insert(0, [t]);
    body.insert(body.length, [p]);
  }, "local");
}

export function bodyText(doc: Y.Doc): string {
  return doc.getXmlFragment("body").toString();
}

export async function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.text() };
}
