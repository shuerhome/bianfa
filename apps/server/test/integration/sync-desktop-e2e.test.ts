// 端到端：**真实的**桌面端同步宿主（apps/desktop/src/sync/host.ts）→ **真实的** @hocuspocus/provider
// → **真实的** Hocuspocus 服务端 → **真实的** Postgres。断言直接查库：便笺正文必须出现在服务端的
// notes / note_updates 里，而不是「客户端认为自己 synced 了」。
//
// 这条用例存在的理由（线上事故的回归）：@hocuspocus/provider 4.6 的构造末尾是
//   `if (this.manageSocket) this.attach()`
// 而 manageSocket 只有在不传 websocketProvider（provider 自己建 socket）时才为 true。host.ts 里所有
// provider 共用一条 HocuspocusProviderWebsocket，走的是 manageSocket=false 那一支，必须自己调 attach()。
// 漏掉的后果不是报错：socket 连得上，provider 却从不注册到它上面，不发鉴权消息也不收数据 ——
// 服务端 connections / documents / auth_failures 全是 0，两头都不报错，一条便笺都同步不上去。
// 桩化 @hocuspocus/provider 的单测看不见这条语义（桩不 attach 也「能用」），只有连真库真服务端才看得见。
//
// 被替换的只有 Tauri 的 IPC 边界（Rust 侧）：见 desktop-sync-harness.ts 的说明。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserTx } from "../../src/db/client.js";
import { uuidv7 } from "../../src/db/ids.js";
import { loadNoteDoc } from "../../src/notes/doc-store.js";
import { inboxDocumentName, noteDocumentName } from "../../src/sync/auth.js";
import {
  type DesktopBridge,
  type DesktopSyncHost,
  installDesktopBridge,
  loadDesktopSyncHost,
} from "./desktop-sync-harness.js";
import { type Fixture, hasDb, openAdmin, seedUser, truncateAll } from "./helpers.js";
import {
  bodyText,
  connectClient,
  ensureProjectQueue,
  type Harness,
  readNote,
  startSync,
  tokenFor,
  typeText,
  updateRows,
  waitFor,
} from "./sync-harness.js";

const WAIT_MS = 15_000;
const TEST_MS = 60_000;

describe.skipIf(!hasDb)("桌面端同步宿主 ↔ 真实 sync 服务端", () => {
  let f: Fixture;
  let h: Harness;
  let owner: { userId: string; workspaceId: string };
  let bridge: DesktopBridge;
  let host: DesktopSyncHost;

  /** 服务端存的正文：从 notes.crdt_sv + note_updates 重建 Y.Doc（行不存在时返回空串） */
  async function serverBodyText(noteId: string): Promise<string> {
    if ((await readNote(f.admin, noteId)) === null) return "";
    const { doc } = await withUserTx(owner.userId, (tx) => loadNoteDoc(tx, noteId), h.db);
    const text = bodyText(doc);
    doc.destroy();
    return text;
  }

  beforeAll(async () => {
    f = openAdmin();
    await truncateAll(f.admin);
    await ensureProjectQueue();
    owner = await seedUser(f.adminDb, `desktop-e2e-${uuidv7().slice(-8)}`);
    h = await startSync();
    bridge = installDesktopBridge({
      syncWsUrl: `${h.url}/ws/v1`,
      apiBaseUrl: `http://127.0.0.1:${h.port}`,
      userId: owner.userId,
      personalWorkspaceId: owner.workspaceId,
      mintSyncToken: () => tokenFor(owner.userId),
    });
    const { SyncHost } = await loadDesktopSyncHost();
    host = new SyncHost();
    await host.start();
  }, TEST_MS);

  afterAll(async () => {
    host?.stop();
    bridge?.uninstall();
    await h.stop();
    // 集成测试共用一个库、文件串行执行：把 seed 出来的用户 / 便笺清掉再走，
    // 不给后面的文件（例如 migrate.test.ts 断言 "user" 表为空）留下残留。
    await truncateAll(f.admin);
    await f.admin.end();
  });

  it(
    "本地库里的便笺正文，经真实 provider 落进服务端的 notes / note_updates",
    async () => {
      const noteId = uuidv7();
      // 离线新建并写了一行：服务端还没有这一行便笺（服务端 onLoadDocument 才建行）
      bridge.createLocalNote(noteId, owner.workspaceId);
      bridge.typeLocally(noteId, "端到端：第一行 ✅");

      await waitFor(async () => (await readNote(f.admin, noteId)) !== null, WAIT_MS, "服务端建出 notes 行");
      await waitFor(
        async () => (await serverBodyText(noteId)).includes("端到端：第一行 ✅"),
        WAIT_MS,
        "第一行正文出现在服务端库里",
      );

      // 联机后继续敲：本地库 → db:changed → pullLocal → provider → 服务端（增量那一段通路）
      bridge.typeLocally(noteId, "端到端：第二行 ✅");
      await waitFor(
        async () => (await serverBodyText(noteId)).includes("端到端：第二行 ✅"),
        WAIT_MS,
        "第二行正文出现在服务端库里",
      );

      // 直接查表：行归属、update 的作者、以及重建出来的正文与本地库逐字相同
      const row = await readNote(f.admin, noteId);
      expect(row?.workspace_id).toBe(owner.workspaceId);
      expect(row?.created_by).toBe(owner.userId);
      expect(row?.head_seq).toBeGreaterThanOrEqual(1);
      expect(row?.crdt_bytes).toBeGreaterThan(0);

      const rows = await updateRows(f.admin, noteId);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.map((r) => r.author_id)).toEqual(rows.map(() => owner.userId));

      expect(await serverBodyText(noteId)).toBe(bridge.localBodyText(noteId));
      // 脚手架必须覆盖桌面端真正会调的每一条 Rust command，否则上面的绿灯没有意义
      expect(bridge.unknownCommands).toEqual([]);
      // errCode null 是「清掉错误」，同步成功时本来就会写；这里只要求没有 forbidden / gone 之类
      expect(bridge.syncErrors.filter((e) => e.errCode !== null)).toEqual([]);
    },
    TEST_MS,
  );

  it(
    "另一台设备写的内容，经同一条共享 socket 回到桌面端的本地库",
    async () => {
      const noteId = uuidv7();
      bridge.createLocalNote(noteId, owner.workspaceId);
      bridge.typeLocally(noteId, "本机写的一行");
      await waitFor(
        async () => (await serverBodyText(noteId)).includes("本机写的一行"),
        WAIT_MS,
        "本机这一行先上去",
      );

      const other = connectClient(
        `${h.url}/ws/v1`,
        noteDocumentName(owner.workspaceId, noteId),
        await tokenFor(owner.userId),
      );
      try {
        await waitFor(() => other.events.synced > 0, WAIT_MS, "第二个客户端 synced");
        typeText(other.doc, "另一台设备写的一行");
        await waitFor(
          () => bridge.localBodyText(noteId).includes("另一台设备写的一行"),
          WAIT_MS,
          "远端更新写回本地库",
        );
      } finally {
        other.destroy();
      }

      expect(bridge.appended.some((a) => a.noteId === noteId && a.origin === "remote")).toBe(true);
      expect(bridge.localBodyText(noteId)).toContain("本机写的一行");
      expect(bridge.unknownCommands).toEqual([]);
    },
    TEST_MS,
  );

  // 便笺房间和收件箱房间是两条独立的 provider：只漏掉收件箱那一处 attach 时，上面两条用例照样绿。
  // 这一条单独钉住信号房 —— 服务端 broadcastStateless 的 bump 必须真的走到 onStateless 并触发一次发现。
  it(
    "收件箱信号房：服务端的 bump 触发桌面端重新发现",
    async () => {
      await waitFor(
        () => h.sync.hocuspocus.documents.has(inboxDocumentName(owner.workspaceId)),
        WAIT_MS,
        "收件箱房间在服务端建立",
      );
      const discovered = () => bridge.apiCalls.filter((p) => p.startsWith("/v1/notes")).length;
      const before = discovered();
      h.sync.hocuspocus.documents
        .get(inboxDocumentName(owner.workspaceId))
        ?.broadcastStateless(JSON.stringify({ t: "bump", workspace_id: owner.workspaceId }));
      await waitFor(() => discovered() > before, WAIT_MS, "bump 触发了一次便笺发现");
    },
    TEST_MS,
  );
});
