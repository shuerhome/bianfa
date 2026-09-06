// 进程内连接登记（socket → 文档级 Connection 集合，user → sockets）：供每用户/每 socket 上限、authz_revoked 定向关闭
// 与 60 s 全量重校验使用。Hocuspocus 的 ClientConnection 不对外暴露其 documentConnections，所以自己记。
import type { Connection, WebSocketLike } from "@hocuspocus/server";
import type { Perm } from "./auth.js";
import { SocketLimiter } from "./limits.js";

/** onAuthenticate 返回并挂在每个文档级连接上的上下文 */
export interface SyncContext {
  userId: string;
  deviceId: string | null;
  sessionId: string | null;
  msv: number;
  kind: "note" | "inbox";
  workspaceId: string;
  noteId: string | null;
  perm: Perm;
  readOnly: boolean;
  createIfMissing: boolean;
}

export type SyncConnection = Connection<SyncContext>;

export interface SocketEntry {
  socketId: string;
  userId: string;
  connectedAt: number;
  webSocket: WebSocketLike;
  connections: Set<SyncConnection>;
  limiter: SocketLimiter;
}

/** onAuthenticate 通过但 connected 尚未触发（文档还在加载）的名额预占；超时视为失效，防止加载失败时泄漏 */
export const RESERVATION_TTL_MS = 30_000;

export class ConnectionRegistry {
  readonly sockets = new Map<string, SocketEntry>();
  private readonly users = new Map<string, Set<string>>();
  private readonly pending = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * 每 socket ≤ max 个文档（03 §7）：Auth 通过即预占，connected 时转正。只数已建立连接会让一次打开 65 个文档的
   * 连击全部放行（前 64 个还在 onLoadDocument 里），所以预占也计入。
   */
  reserveDocument(socketId: string, max: number): boolean {
    const now = this.now();
    const list = (this.pending.get(socketId) ?? []).filter((t) => now - t < RESERVATION_TTL_MS);
    const established = this.sockets.get(socketId)?.connections.size ?? 0;
    if (established + list.length >= max) {
      this.pending.set(socketId, list);
      return false;
    }
    list.push(now);
    this.pending.set(socketId, list);
    return true;
  }

  private consumeReservation(socketId: string): void {
    const list = this.pending.get(socketId);
    if (!list) return;
    list.shift();
    if (list.length === 0) this.pending.delete(socketId);
  }

  /** 文档级连接建立（或首条消息）时登记；同一 socket 复用同一条目 */
  ensureSocket(socketId: string, userId: string, webSocket: WebSocketLike): SocketEntry {
    let entry = this.sockets.get(socketId);
    if (!entry) {
      entry = {
        socketId,
        userId,
        connectedAt: this.now(),
        webSocket,
        connections: new Set(),
        limiter: new SocketLimiter(this.now),
      };
      this.sockets.set(socketId, entry);
      let set = this.users.get(userId);
      if (!set) {
        set = new Set();
        this.users.set(userId, set);
      }
      set.add(socketId);
    }
    return entry;
  }

  addConnection(socketId: string, connection: SyncConnection): SocketEntry {
    const entry = this.ensureSocket(socketId, connection.context.userId, connection.webSocket);
    entry.connections.add(connection);
    this.consumeReservation(socketId);
    return entry;
  }

  /** onDisconnect 只给 socketId + documentName */
  removeConnection(socketId: string, documentName: string): void {
    const entry = this.sockets.get(socketId);
    if (!entry) return;
    for (const c of entry.connections) if (c.document.name === documentName) entry.connections.delete(c);
    if (entry.connections.size === 0) this.dropSocket(entry);
  }

  private dropSocket(entry: SocketEntry): void {
    this.sockets.delete(entry.socketId);
    this.pending.delete(entry.socketId);
    const set = this.users.get(entry.userId);
    if (set) {
      set.delete(entry.socketId);
      if (set.size === 0) this.users.delete(entry.userId);
    }
  }

  documentCount(socketId: string): number {
    return this.sockets.get(socketId)?.connections.size ?? 0;
  }

  socketsOf(userId: string): SocketEntry[] {
    const ids = this.users.get(userId);
    if (!ids) return [];
    const out: SocketEntry[] = [];
    for (const id of ids) {
      const e = this.sockets.get(id);
      if (e) out.push(e);
    }
    return out;
  }

  /** 该用户在某便笺上的全部文档级连接（跨 socket） */
  connectionsOf(userId: string, noteId: string): SyncConnection[] {
    const out: SyncConnection[] = [];
    for (const s of this.socketsOf(userId)) {
      for (const c of s.connections) if (c.context.noteId === noteId) out.push(c);
    }
    return out;
  }

  /** 所有文档级连接（全量重校验用） */
  *allConnections(): IterableIterator<SyncConnection> {
    for (const s of this.sockets.values()) yield* s.connections;
  }

  get socketCount(): number {
    return this.sockets.size;
  }

  /**
   * 每用户 ≤ max 条 socket，超出关闭最旧的（不含 keep）。返回被关闭的条目。
   */
  enforceUserSocketLimit(userId: string, max: number, keep: string): SocketEntry[] {
    const list = this.socketsOf(userId)
      .filter((s) => s.socketId !== keep)
      .sort((a, b) => a.connectedAt - b.connectedAt);
    const total = this.socketsOf(userId).length;
    const excess = total - max;
    if (excess <= 0) return [];
    const victims = list.slice(0, excess);
    for (const v of victims) {
      v.webSocket.close(4429, "too_many_connections");
      this.dropSocket(v);
    }
    return victims;
  }
}
