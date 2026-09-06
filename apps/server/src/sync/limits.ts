// 性能与限制（规格 03 §7）：消息 / 状态大小、每 socket 文档数、每用户 socket 数、令牌桶、awareness 字段裁剪。
// Hocuspocus 4.6 没有"丢弃单条 sync 消息"的原语：beforeHandleMessage 抛错 = 关闭该文档级连接（带 code/reason）；
// awareness 可以在 beforeHandleAwareness 里清空 states 实现真正的丢弃。
import * as decoding from "lib0/decoding";

export const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MiB
export const MAX_STATE_BYTES = 4 * 1024 * 1024; // 4 MB
export const MAX_DOCUMENTS_PER_SOCKET = 64;
export const MAX_SOCKETS_PER_USER = 10;
/** 数据消息（Sync Update / SyncStep2 / Stateless）：30 msg/s、桶 60（03 §7） */
export const MESSAGE_RATE_PER_SECOND = 30;
export const MESSAGE_BURST = 60;
/**
 * 握手 / 保活消息（SyncStep1、QueryAwareness、Ping/Pong、SyncStatus）单独计桶：一条 socket 上同时打开 ≤ 64 个文档时
 * 每个文档各发一条 SyncStep1，不能被数据桶误杀；桶容量按 64 文档 × 2 留余量，持续速率仍受限。
 */
export const HANDSHAKE_RATE_PER_SECOND = 10;
export const HANDSHAKE_BURST = 160;
/** awareness 按文档级连接各自计桶（03 §1.8「每连接 ≤ 2 次/s」），超出丢弃而非关闭 */
export const AWARENESS_RATE_PER_SECOND = 2;
/** 桶容量略大于速率：吸收连接建立时的初始 awareness 连击，持续速率仍 ≤ 2/s */
export const AWARENESS_BURST = 4;
/** 连续超限超过此时长关闭整条 socket */
export const RATE_CLOSE_AFTER_MS = 10_000;
/** 两次拒绝间隔超过此值即视为超限结束（令牌桶持续补发，不能用"有一条被接受"判定恢复） */
export const RATE_STREAK_GAP_MS = 1_000;

/** 经典令牌桶：每秒补 rate 个，上限 capacity */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly rate: number,
    readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  tryTake(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
      this.last = t;
    }
  }
}

/** Hocuspocus 线格式：varString(documentName) + varUint(MessageType)；解析失败返回 -1 */
export function peekMessageType(data: Uint8Array): number {
  try {
    const decoder = decoding.createDecoder(data);
    decoding.readVarString(decoder);
    return decoding.readVarUint(decoder);
  } catch {
    return -1;
  }
}

/** y-protocols/sync 子类型：Sync 消息里紧跟的 varUint（0 SyncStep1 / 1 SyncStep2 / 2 Update） */
export function peekSyncSubType(data: Uint8Array): number {
  try {
    const decoder = decoding.createDecoder(data);
    decoding.readVarString(decoder);
    decoding.readVarUint(decoder);
    return decoding.readVarUint(decoder);
  } catch {
    return -1;
  }
}

export const MESSAGE_TYPE_NAMES: Record<number, string> = {
  0: "sync",
  1: "awareness",
  2: "auth",
  3: "query_awareness",
  4: "sync_reply",
  5: "stateless",
  6: "broadcast_stateless",
  7: "close",
  8: "sync_status",
  9: "ping",
  10: "pong",
};

export function messageTypeName(type: number): string {
  return MESSAGE_TYPE_NAMES[type] ?? "unknown";
}

export type MessageKind = "data" | "handshake" | "awareness";

/** Hocuspocus 线格式 → 限流分类：awareness 走文档级连接自己的桶；其余按是否携带文档数据分桶 */
export function classifyMessage(data: Uint8Array): MessageKind {
  const type = peekMessageType(data);
  if (type === 1) return "awareness";
  if (type === 0) {
    // 0 SyncStep1 / 1 SyncStep2 = 每个文档连接建立时各一条的握手（打开 64 个文档就是 64 条）；2 Update = 编辑数据。
    // SyncStep2 仍受单条 1 MiB 与 4 MB 状态守卫约束。
    const sub = peekSyncSubType(data);
    return sub === 2 ? "data" : "handshake";
  }
  // 3 QueryAwareness、7 Close、8 SyncStatus、9 Ping、10 Pong：握手 / 保活；5 Stateless、6 BroadcastStateless、未知：数据
  return type === 3 || type === 7 || type === 8 || type === 9 || type === 10 ? "handshake" : "data";
}

/** 每条 socket 的限流状态 */
export class SocketLimiter {
  readonly messages: TokenBucket;
  readonly handshakes: TokenBucket;
  /** 当前超限连击的起点；无连击为 null */
  overLimitSince: number | null = null;
  private lastRejectAt = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.messages = new TokenBucket(MESSAGE_RATE_PER_SECOND, MESSAGE_BURST, now);
    this.handshakes = new TokenBucket(HANDSHAKE_RATE_PER_SECOND, HANDSHAKE_BURST, now);
  }

  /**
   * 返回 'ok' | 'reject'（拒绝该消息）| 'close'（连续超限 ≥ 10 s，关整条 socket）。
   * "连续"= 相邻两次拒绝间隔 < RATE_STREAK_GAP_MS；桶每秒补发，因此不能以"有消息被接受"作为恢复判据。
   */
  takeMessage(kind: "data" | "handshake" = "data"): "ok" | "reject" | "close" {
    const bucket = kind === "handshake" ? this.handshakes : this.messages;
    if (bucket.tryTake()) return "ok";
    const t = this.now();
    if (this.overLimitSince === null || t - this.lastRejectAt > RATE_STREAK_GAP_MS) this.overLimitSince = t;
    this.lastRejectAt = t;
    return t - this.overLimitSince >= RATE_CLOSE_AFTER_MS ? "close" : "reject";
  }
}

/** 文档级连接的 awareness 桶 */
export function createAwarenessBucket(now: () => number = Date.now): TokenBucket {
  return new TokenBucket(AWARENESS_RATE_PER_SECOND, AWARENESS_BURST, now);
}

const AWARENESS_KEYS = new Set(["userId", "name", "color", "editing"]);
const MAX_NAME_LEN = 64;
const MAX_COLOR_LEN = 32;

/**
 * awareness 字段裁剪（03 §1.8 裁定 `{userId, name, color, editing}`）：丢弃其它键，钉死 userId 为认证用户，
 * 限制字符串长度。原地修改 states（Hocuspocus 会按修改后的 map 重新编码）。
 */
export function sanitizeAwarenessStates(states: Map<number, Record<string, unknown>>, userId: string): void {
  for (const [clientId, state] of states) {
    if (state === null || typeof state !== "object") {
      states.delete(clientId);
      continue;
    }
    for (const key of Object.keys(state)) if (!AWARENESS_KEYS.has(key)) delete state[key];
    state.userId = userId;
    if ("name" in state) {
      state.name = typeof state.name === "string" ? state.name.slice(0, MAX_NAME_LEN) : "";
    }
    if ("color" in state) {
      state.color = typeof state.color === "string" ? state.color.slice(0, MAX_COLOR_LEN) : "";
    }
    if ("editing" in state) state.editing = state.editing === true;
  }
}
