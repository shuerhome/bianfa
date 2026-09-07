// 团队 / 共享便笺的打开与新建：本地行不存在时按 sync host 的发现套路先建行（只带 meta，正文等 provider 同步），再开窗。
//   新建团队便笺：先 POST /v1/notes 在目标工作区落服务端行，再 note_create（workspaceId）+ note_window_open。
//   note_new 只能开个人便笺（Rust 只分配 id 开窗，note.html 不带 workspace），所以这里走 note_create 路径。
import { createNoteDoc, encodeStateV2 } from "@bianfa/shared";
import { createRemoteNote } from "../../../api/notes.js";
import { buildProjection } from "../../../editor/projection.js";
import { noteCreate, noteGet, noteWindowOpen } from "../../../ipc/commands.js";
import { isIpcError } from "../../../ipc/errors.js";
import type { NoteColor, ZMode } from "../../../ipc/types.js";
import { toB64 } from "../../../lib/base64.js";
import { uuidv7 } from "../../../lib/uuid.js";

export interface RemoteNoteRef {
  id: string;
  workspaceId: string;
  color: NoteColor;
  zMode: ZMode;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** 本地没有这张便笺 → 建行（与 sync/host.ts 发现一致）；已有 → 什么都不做 */
export async function ensureLocalNote(ref: RemoteNoteRef): Promise<"existing" | "created"> {
  const local = await noteGet(ref.id).catch((err) => {
    if (isIpcError(err) && err.code === "not_found") return null;
    throw err;
  });
  if (local !== null) return "existing";
  const doc = createNoteDoc(ref.id, {
    meta: {
      color: ref.color,
      zMode: ref.zMode,
      createdAt: ref.createdAt,
      updatedAt: ref.updatedAt,
      deletedAt: ref.deletedAt,
    },
    origin: "remote",
  });
  try {
    await noteCreate({
      noteId: ref.id,
      updateV2B64: toB64(encodeStateV2(doc)),
      projection: buildProjection(doc),
      workspaceId: ref.workspaceId,
    });
  } finally {
    doc.destroy();
  }
  return "created";
}

/** 打开远端便笺：确保本地行存在 → note_window_open */
export async function openRemoteNote(ref: RemoteNoteRef): Promise<void> {
  await ensureLocalNote(ref);
  await noteWindowOpen(ref.id, true);
}

/** 在团队工作区新建便笺：服务端行 → 本地行 → 开窗；返回 noteId */
export async function createTeamNote(workspaceId: string, color?: NoteColor): Promise<string> {
  const id = uuidv7();
  const remote = await createRemoteNote({ id, workspaceId, ...(color ? { color } : {}) });
  await ensureLocalNote({
    id,
    workspaceId,
    color: remote.color,
    zMode: remote.zMode,
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
    deletedAt: null,
  });
  await noteWindowOpen(id, true);
  return id;
}
