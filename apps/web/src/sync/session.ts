// 浏览器里的一张便笺 = 一个 Y.Doc + 一个 HocuspocusProvider，直接接编辑器。
//
// 和桌面端的拓扑**不一样**，这是有意的：桌面端每张便笺跑两个 Y.Doc（笔记窗口里的编辑器一个、
// 隐藏的 sync WebView 里一个），中间靠本地 SQLite 的 append-only 日志对账。浏览器没有本地库，
// provider 本身就是持久化，所以这里把 provider 直接挂在编辑器那份 doc 上，
// 桌面端的 doc-store / appliedSeq / ackedSeq / 发现 / 淘汰那一整套都不需要。
//
// 五件必须照做的事（每一件的症状都很难从现象倒推）：
//   ① token 传函数而不是字符串。provider 每次开 socket 都会重新取，而凭据只有 60 s。
//   ② 共享 socket 上的 provider 必须显式 attach()，否则它一条消息都不会发，而且**不报错**。
//   ③ 至少设一次 awareness。服务端 60 s 没收到任何消息就掐连接（Hocuspocus 的 timeout），
//      而浏览器端唯一的自动流量是 y-protocols 每 15 s 的 awareness 续播——那个续播只在
//      本地 state 非空时才发。桌面端不用管是因为它有 inbox 房间的 25 s 心跳，网页端没有。
//   ④ 「存好了」的判据是 isSynced && !hasUnsyncedChanges，不能只看 synced 事件：
//      startSync() 一开始就把 unsyncedChanges 置成 1，synced 触发时它基本必然还是 1。
//   ⑤ 拆的顺序是 editor → provider → doc → socket。provider.destroy() 会往 socket 发一条
//      Close 帧，先关 socket 那条帧就发进了虚空。
import { BODY_FIELD, getBody, getMetaMap, type NoteColor, Origins, SCHEMA_VERSION } from "@bianfa/shared";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { getSyncToken, invalidateSyncToken } from "./token.js";

/** 房间名与桌面端逐字一致：note:<workspaceId>:<noteId>，全小写（服务端 parseDocumentName 只认这个形状） */
export function documentName(workspaceId: string, noteId: string): string {
  return `note:${workspaceId}:${noteId}`.toLowerCase();
}

/**
 * 同步地址由页面地址推导。网页端与 api 同源托管，Caddy 把 /ws/* 转给 sync-ws
 * （infra/docker/Caddyfile），所以这里不需要、也不该有第二个可以配错的地址。
 */
export function syncUrlFromLocation(loc: { protocol: string; host: string }): string {
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${loc.host}/ws/v1`;
}

/** 便笺连不上时用户该看到的那件事，而不是一句"同步失败" */
export type SyncFailure =
  /** 没有这张便笺的权限，或权限被收回 */
  | "forbidden"
  /** 便笺已被删除 */
  | "gone"
  /** 会话失效，要重新登录 */
  | "unauthorized"
  /** 同一账号开的连接太多（浏览器标签页与桌面端共用 10 个的额度） */
  | "too_many_connections"
  /** 反复取不到凭据 / 反复被拒，已经停止重试 */
  | "stalled"
  /** 连不上同步服务（握手就被拒或网络不通；浏览器只给 1006，看不到原因） */
  | "offline";

export interface SyncState {
  /** 握手完成过一次（此后即使掉线，本地编辑仍然有效，重连后会补上） */
  synced: boolean;
  /**
   * 服务端至少完整回过一次正文。**在此之前不能让用户打字**：
   * 那时本地是一份空文档，敲进去的字随后会和服务端来的正文合并到一个说不清的位置。
   * 是闩锁不是瞬时值——同步过一次之后掉线，仍然可以继续编辑，重连时 Yjs 会合并。
   */
  everSynced: boolean;
  /**
   * 服务端已经回答过"这条连接能不能写"（onAuthenticated 的 scope）。
   * 没有这个标志就分不清"还没答复"和"答复是只读"，而这两种情况下能不能打字是相反的。
   */
  scopeKnown: boolean;
  /** 有本地改动还没被服务端确认 */
  saving: boolean;
  /** 服务端给的是读写连接还是只读（viewer，或便笺的 schema 比本端新） */
  editable: boolean;
  connected: boolean;
  failure: SyncFailure | null;
}

export interface NoteSessionUser {
  id: string;
  name: string;
}

export interface NoteSession {
  doc: Y.Doc;
  undoManager: Y.UndoManager;
  getState(): SyncState;
  subscribe(listener: () => void): () => void;
  /** 本地正文改动后调用：把 updatedAt / bodyEditedAt 记进 meta */
  touch(): void;
  destroy(): void;
}

// ─────────────────────────────────────────────────────────── socket（每个标签页一个）

/**
 * 一个标签页一个 socket，不是一张便笺一个：服务端对同一账号的 socket 上限是 10，
 * 而且超了是踢掉**最旧**的那个——桌面端也在同一个额度里，所以浪费不起。
 */
let socket: HocuspocusProviderWebsocket | null = null;
let socketRefs = 0;

function acquireSocket(url: string): HocuspocusProviderWebsocket {
  if (!socket) {
    socket = new HocuspocusProviderWebsocket({
      url,
      // full jitter 退避，与桌面端同参数
      delay: 1000,
      factor: 2,
      maxDelay: 60_000,
      minDelay: 0,
      jitter: true,
      maxAttempts: 0,
      messageReconnectTimeout: 60_000,
    });
  }
  socketRefs += 1;
  return socket;
}

function releaseSocket(): void {
  socketRefs = Math.max(0, socketRefs - 1);
  if (socketRefs === 0 && socket) {
    socket.destroy();
    socket = null;
  }
}

/** 测试用：把模块级 socket 归零 */
export function resetSocketForTest(): void {
  socket = null;
  socketRefs = 0;
}

// ─────────────────────────────────────────────────────────── 会话

export interface OpenNoteOptions {
  workspaceId: string;
  noteId: string;
  user: NoteSessionUser;
  color: NoteColor | string;
  /** 注入点：测试用假 provider；生产走真实的 Hocuspocus */
  factory?: SessionFactory;
  url?: string;
}

export interface SessionFactory {
  socket(url: string): HocuspocusProviderWebsocket;
  provider(config: ConstructorParameters<typeof HocuspocusProvider>[0]): HocuspocusProvider;
  release(): void;
}

const realFactory: SessionFactory = {
  socket: acquireSocket,
  provider: (config) => new HocuspocusProvider(config),
  release: releaseSocket,
};

/** 连续多少次拿不到凭据 / 被拒之后停止重试（再试下去只是刷限流） */
const MAX_AUTH_STRIKES = 3;

export function openNoteSession(opts: OpenNoteOptions): NoteSession {
  const factory = opts.factory ?? realFactory;
  const url = opts.url ?? syncUrlFromLocation(window.location);
  const doc = new Y.Doc({ guid: opts.noteId, gc: true });
  const undoManager = new Y.UndoManager(getBody(doc), {
    // ySyncPluginKey 是编辑器写入时用的 origin；不跟踪它 Ctrl+Z 就什么都不做
    trackedOrigins: new Set<unknown>([ySyncPluginKey, Origins.local]),
    captureTimeout: 500,
  });

  const wsSocket = factory.socket(url);
  // 第二张便笺开在一条已经连着的 socket 上时，"status" 事件不会再来一次，
  // 只靠回调的话这个会话会一直停在「连接中」。所以初始值直接读 socket 当前的状态。
  let connected = (wsSocket as { status?: string }).status === "connected";

  const listeners = new Set<() => void>();
  let state: SyncState = {
    synced: false,
    everSynced: false,
    scopeKnown: false,
    saving: false,
    editable: false,
    connected,
    failure: null,
  };
  let strikes = 0;
  let destroyed = false;

  function emit(patch: Partial<SyncState>): void {
    const next = { ...state, ...patch };
    if (
      next.synced === state.synced &&
      next.everSynced === state.everSynced &&
      next.scopeKnown === state.scopeKnown &&
      next.saving === state.saving &&
      next.editable === state.editable &&
      next.connected === state.connected &&
      next.failure === state.failure
    )
      return;
    state = next;
    for (const l of listeners) l();
  }

  const provider = factory.provider({
    websocketProvider: wsSocket,
    name: documentName(opts.workspaceId, opts.noteId),
    document: doc,
    // ① 函数，不是字符串
    token: () => getSyncToken(),
    onAuthenticated: ({ scope }: { scope: string }) => {
      strikes = 0;
      // 只读的原因有两种：权限只到 viewer，或者这张便笺的 schema 比本端新
      // （服务端 msv < note.schemaVersion → readOnly）。两种都不该让用户白打字。
      emit({ editable: scope !== "readonly", scopeKnown: true, failure: null });
    },
    onAuthenticationFailed: ({ reason }: { reason: string }) => onAuthFailed(reason),
    onSynced: () => recompute(),
    // status 是 socket 的属性、不在 provider 上，只能从这个回调里拿
    onStatus: ({ status }: { status: string }) => {
      connected = status === "connected";
      recompute();
    },
    onClose: ({ event }: { event: { code?: number; reason?: string } }) => onClose(event),
    onAwarenessUpdate: () => undefined,
  } as ConstructorParameters<typeof HocuspocusProvider>[0]);

  // ② 共享 socket 上必须显式 attach
  provider.attach();

  // ③ awareness 既是"谁在看"，也是这条连接唯一的心跳。
  //    四个键必须是**顶层**：服务端只认 userId / name / color / editing，别的键会被删掉
  //    （sync/limits.ts 的 sanitizeAwarenessStates），套一层 { user: {...} } 等于什么都没发。
  provider.setAwarenessField("userId", opts.user.id);
  provider.setAwarenessField("name", opts.user.name);
  provider.setAwarenessField("color", String(opts.color));
  provider.setAwarenessField("editing", false);

  // provider 的 "synced" 只代表握手完成；"是否已上传"要看 unsyncedChanges
  provider.on("unsyncedChanges", () => recompute());

  function recompute(): void {
    if (destroyed) return;
    const synced = Boolean(provider.isSynced);
    emit({
      synced,
      everSynced: state.everSynced || synced,
      // ④ 只读连接的 unsyncedChanges 永远不归零（服务端回的是 SyncStatus(false)），
      //    所以"正在保存"这件事只对可写连接成立，否则会挂着一个永远转不完的圈。
      saving: synced && state.editable && Boolean(provider.hasUnsyncedChanges),
      connected,
    });
  }

  function onAuthFailed(reason: string): void {
    if (destroyed) return;
    if (reason === "forbidden" || reason === "gone") {
      emit({ failure: reason, editable: false });
      return;
    }
    if (reason === "too_many_documents") {
      emit({ failure: "too_many_connections" });
      return;
    }
    // expired / bad_token，以及 provider 自己把"取凭据失败"包成的那串字符串
    // （HocuspocusProvider 会把 token 回调抛的异常变成 authenticationFailed，reason 不在服务端词表里）
    invalidateSyncToken();
    strikes += 1;
    if (reason.includes("sync_token_unauthorized") || reason.includes("401")) {
      emit({ failure: "unauthorized", editable: false });
      return;
    }
    if (strikes >= MAX_AUTH_STRIKES) emit({ failure: "stalled", editable: false });
  }

  function onClose(event: { code?: number; reason?: string }): void {
    if (destroyed) return;
    // 文档级的关闭帧丢了 code（provider 一律写成 1000），原因只在 reason 里
    switch (event.reason) {
      case "authz_revoked":
      case "downgraded":
        emit({ failure: "forbidden", editable: false, synced: false });
        return;
      case "gone":
        emit({ failure: "gone", editable: false, synced: false });
        return;
      default:
        break;
    }
    if (event.code === 4429) {
      emit({ failure: "too_many_connections" });
      return;
    }
    // 1006 = 握手就被拒（路径 / Origin / 服务不可用）或网络不通，浏览器看不到原因
    if (event.code === 1006) {
      connected = false;
      emit({ failure: "offline", connected: false });
      return;
    }
    connected = false;
    emit({ connected: false });
  }

  // meta.updatedAt 是**客户端**盖的，服务端只是照抄（jobs/project.ts）。不盖的话
  // 每次网页端编辑投影出来的 updated_at 都是旧的，便笺会在列表里往下沉。
  let lastStamp = 0;
  function touch(): void {
    if (destroyed) return;
    const now = Date.now();
    if (now - lastStamp < 2000) return;
    lastStamp = now;
    doc.transact(() => {
      const meta = getMetaMap(doc);
      meta.set("updatedAt", now);
      // bodyEditedAt 决定"编辑与删除撞车时谁赢"（jobs/project.ts 的 resolveDeletedAt）。
      // 它不在 noteMetaPatchSchema 里，所以只能这样直接写。
      meta.set("bodyEditedAt", now);
    }, Origins.local);
  }

  return {
    doc,
    undoManager,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    touch,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      // ⑤ provider 先于 doc、doc 先于 socket
      provider.destroy();
      undoManager.destroy();
      doc.destroy();
      factory.release();
    },
  };
}

export { BODY_FIELD, SCHEMA_VERSION };
