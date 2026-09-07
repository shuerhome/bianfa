// 待办页勾选 = 对该便笺正文的一次真实 CRDT 编辑（不是改投影表）：
//   body → PM JSON（bodyToPmNode）→ 翻转 attrs.id === blockId 的 taskItem.checked
//   → setBodyFromPmJson（最小 diff 回写）→ 与便笺窗同一条落库路径 note_append_update(origin 'local', projection)，
//   因此 sync host 会推到远端，Rust 也会随投影重写本地 checklist 行。
import { bodyToPmNode, type PMJson, setBodyFromPmJson, TASK_ITEM_ID_ATTR } from "@bianfa/shared";
import { withNoteDoc } from "./doc-store.js";

export interface FlipResult {
  /** 新 JSON（未找到时与入参同一对象） */
  json: PMJson;
  found: boolean;
  /** 翻转后的 checked */
  checked: boolean;
}

/** 递归找到第一个 attrs[TASK_ITEM_ID_ATTR] === blockId 的 taskItem，把 checked 设为 next（未给则取反）。纯函数，不改入参。 */
export function flipTaskItem(json: PMJson, blockId: string, next?: boolean): FlipResult {
  let found = false;
  let checked = false;
  const visit = (node: PMJson): PMJson => {
    if (found) return node;
    if (node.type === "taskItem" && node.attrs?.[TASK_ITEM_ID_ATTR] === blockId) {
      found = true;
      checked = next ?? node.attrs?.checked !== true;
      return { ...node, attrs: { ...node.attrs, checked } };
    }
    if (!node.content) return node;
    let changed = false;
    const content = node.content.map((child) => {
      const out = visit(child);
      if (out !== child) changed = true;
      return out;
    });
    return changed ? { ...node, content } : node;
  };
  const out = visit(json);
  return { json: out, found, checked };
}

/** 便笺里已经没有这个 taskItem（被删 / id 变了）——调用方应刷新列表 */
export class ChecklistItemMissingError extends Error {
  readonly code = "checklist_item_not_found";
  constructor(
    readonly noteId: string,
    readonly blockId: string,
  ) {
    super(`便笺 ${noteId} 中找不到待办 ${blockId}`);
    this.name = "ChecklistItemMissingError";
  }
}

/**
 * 把便笺 noteId 中 blockId 对应的待办勾成 checked，并落库（一条 update，origin 'local'）。
 * 便笺不在本机 → note_load_doc 抛 not_found；找不到该项 → ChecklistItemMissingError（此时不写任何 update）。
 */
export async function setChecklistItemChecked(
  noteId: string,
  blockId: string,
  checked: boolean,
): Promise<{ seq: number }> {
  const res = await withNoteDoc(
    noteId,
    (doc) => {
      const json = bodyToPmNode(doc).toJSON() as PMJson;
      const flipped = flipTaskItem(json, blockId, checked);
      if (!flipped.found) throw new ChecklistItemMissingError(noteId, blockId);
      setBodyFromPmJson(doc, flipped.json, "local");
    },
    "local",
  );
  return { seq: res.seq };
}

/** 取反（先读当前状态再写；UI 一般已知目标状态，用 setChecklistItemChecked 更稳） */
export async function toggleChecklistItem(noteId: string, blockId: string): Promise<{ checked: boolean }> {
  let next = false;
  await withNoteDoc(
    noteId,
    (doc) => {
      const json = bodyToPmNode(doc).toJSON() as PMJson;
      const flipped = flipTaskItem(json, blockId);
      if (!flipped.found) throw new ChecklistItemMissingError(noteId, blockId);
      next = flipped.checked;
      setBodyFromPmJson(doc, flipped.json, "local");
    },
    "local",
  );
  return { checked: next };
}
