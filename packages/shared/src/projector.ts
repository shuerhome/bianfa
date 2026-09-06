// projector（规格 02 §3）：Y.Doc → 只读投影。唯一实现，服务端 pg-boss worker 与桌面端 WebView 共用；
// Rust 永不解析 PM JSON。
//   body → content(PM JSON)、contentText（块间 \n，taskItem 前缀 `[ ] `/`[x] `，image 为空串）、
//          checklistItems、attachmentIds；meta → NoteMeta。
import type { JSONContent } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { generateUniqueIds } from "@tiptap/extension-unique-id";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { createNoteDoc, getBody, type NoteDocInit, type NoteMeta, Origins, readMeta } from "./doc.js";
import { EXCERPT_MAX_CHARS, TITLE_MAX_CHARS } from "./dto.js";
import { createEditorExtensions, getSchemaV1, TASK_ITEM_ID_ATTR } from "./editor/schema.js";

export type PMJson = JSONContent;

export interface ChecklistItem {
  /** taskItem.attrs.id（UniqueID nanoid(10)） */
  blockId: string;
  /** 该项自身文本（不含嵌套子列表） */
  text: string;
  checked: boolean;
  /** 文档序，从 0 起 */
  ordinal: number;
}

export interface NoteProjection {
  content: PMJson;
  contentText: string;
  checklistItems: ChecklistItem[];
  /** 文档序去重 */
  attachmentIds: string[];
  meta: NoteMeta;
}

export const EMPTY_PM_DOC: PMJson = { type: "doc", content: [] };

/** 首行前 120 个字符（按码点计，与 PG `left(split_part(content_text, E'\n', 1), 120)` 一致） */
export function titleFromText(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  return Array.from(firstLine).slice(0, TITLE_MAX_CHARS).join("");
}

/** 首行之后的正文，压成单行，取前 120 个字符 */
export function excerptFromText(text: string): string {
  const rest = text.split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
  return Array.from(rest).slice(0, EXCERPT_MAX_CHARS).join("");
}

interface BodyProjection {
  contentText: string;
  checklistItems: ChecklistItem[];
  attachmentIds: string[];
}

function inlineText(node: PMNode): string {
  let out = "";
  node.forEach((child) => {
    if (child.isText) out += child.text ?? "";
    else if (child.type.name === "hardBreak") out += "\n";
    else if (child.isInline) out += child.textContent;
  });
  return out;
}

/** 递归收集一个块节点的文本行；副作用：填充 checklist / attachments */
function blockLines(node: PMNode, acc: BodyProjection, seenIds: Set<string>): string[] {
  const name = node.type.name;
  if (name === "image") {
    const id = node.attrs.attachmentId;
    if (typeof id === "string" && id.length > 0 && !acc.attachmentIds.includes(id)) acc.attachmentIds.push(id);
    return [""];
  }
  if (node.isTextblock) return [inlineText(node)];
  if (node.isLeaf) return [""];

  if (name === "taskItem") {
    const checked = node.attrs.checked === true;
    const prefix = checked ? "[x] " : "[ ] ";
    const ownLines: string[] = [];
    const nestedLines: string[] = [];
    node.forEach((child) => {
      const lines = blockLines(child, acc, seenIds);
      if (child.isTextblock || child.type.name === "image") ownLines.push(...lines);
      else nestedLines.push(...lines);
    });
    const ownText = ownLines.join("\n");
    const id = node.attrs[TASK_ITEM_ID_ATTR];
    if (typeof id === "string" && id.length > 0 && !seenIds.has(id)) {
      seenIds.add(id);
      acc.checklistItems.push({ blockId: id, text: ownText, checked, ordinal: acc.checklistItems.length });
    }
    return [`${prefix}${ownText}`, ...nestedLines];
  }

  const lines: string[] = [];
  node.forEach((child) => {
    lines.push(...blockLines(child, acc, seenIds));
  });
  return lines;
}

/** 从 PM 根节点投影正文（不含 meta） */
export function projectBodyNode(root: PMNode): BodyProjection {
  const acc: BodyProjection = { contentText: "", checklistItems: [], attachmentIds: [] };
  const seenIds = new Set<string>();
  const lines: string[] = [];
  root.forEach((block) => {
    lines.push(...blockLines(block, acc, seenIds));
  });
  acc.contentText = lines.join("\n");
  return acc;
}

/** PM JSON → 正文投影（导入预览、测试用；正式路径走 projectNoteDoc） */
export function projectPmJson(json: PMJson): BodyProjection {
  return projectBodyNode(PMNode.fromJSON(getSchemaV1(), json));
}

/** 正文 Y.XmlFragment → PM 根节点（schema v1）。注意：y-prosemirror 遇到 schema 不认识的节点会把它从 fragment 里删掉，
 * 所以调用方应传入自己拥有、用后即弃的 Y.Doc（projector 永不回写真源，规格 01 C15）。 */
export function bodyToPmNode(doc: Y.Doc): PMNode {
  return yXmlFragmentToProseMirrorRootNode(getBody(doc), getSchemaV1());
}

export function projectNoteDoc(doc: Y.Doc): NoteProjection {
  const root = bodyToPmNode(doc);
  const json = root.toJSON() as PMJson;
  const body = projectBodyNode(root);
  return {
    content: { ...json, content: json.content ?? [] },
    contentText: body.contentText,
    checklistItems: body.checklistItems,
    attachmentIds: body.attachmentIds,
    meta: readMeta(doc),
  };
}

const headlessExtensions = createEditorExtensions({ collaboration: false });

/** 给 PM JSON 里缺 id 的 taskItem 补 nanoid(10)（与 UniqueID 扩展同一配置） */
export function ensureTaskItemIds(json: PMJson): PMJson {
  return generateUniqueIds(json, headlessExtensions);
}

/**
 * 把 PM JSON 写进 doc 的 body（一次事务；已有内容按最小 diff 更新，可用于重复导入时替换正文）。
 * JSON 先按 schema v1 校验，非法内容抛错。
 */
export function setBodyFromPmJson(doc: Y.Doc, json: PMJson, origin: unknown = Origins.import): void {
  const withIds = ensureTaskItemIds(json);
  const schema = getSchemaV1();
  PMNode.fromJSON(schema, withIds).check();
  doc.transact(() => {
    prosemirrorJSONToYXmlFragment(schema, withIds, getBody(doc));
  }, origin);
}

export interface NoteDocFromJsonInit extends Omit<NoteDocInit, "origin"> {
  /** 新 Y.Doc 的 guid（= note id，客户端生成的 UUIDv7） */
  noteId: string;
}

/** 导入用：PM JSON + meta → 新 Y.Doc（taskItem id 自动补齐；整个初始化在同一个 origin 下） */
export function prosemirrorJsonToNoteDoc(
  json: PMJson,
  init: NoteDocFromJsonInit,
  origin: unknown = Origins.import,
): Y.Doc {
  const { noteId, ...rest } = init;
  const doc = createNoteDoc(noteId, { ...rest, origin });
  setBodyFromPmJson(doc, json, origin);
  return doc;
}
