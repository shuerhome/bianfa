// 打开一张已有内容的便笺时的显示问题。第二台设备上最显眼：那边的内容全是刚从服务端拉下来的。
//   1. 远端高亮：打开那一下，协同插件把整篇灌进编辑器（y-tiptap 的 _forceRerender，带 isChangeOrigin），
//      被当成「别人刚写的」整篇高亮 8 秒。而且 y-tiptap 对之后每一次远端更新也都是整篇 replace，
//      照 ReplaceStep 算范围的话，别处只打一个字这里也整篇闪。
//   2. 占位：正文中间的空行出现「写点什么…」。
// 用的是便笺窗口真正加载的扩展集（createNoteExtensions，协同模式），Y.Doc 先有正文再挂编辑器，与窗口一致。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { prosemirrorJsonToNoteDoc } from "@bianfa/shared";
import { Editor } from "@tiptap/core";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createNoteExtensions } from "../editor/extensions.js";

/** jsdom 环境下 import.meta.url 不是 file://：从工作目录往上找仓库里的 prose.css */
function proseCssPath(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, "packages/ui/src/styles/prose.css");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error("找不到 packages/ui/src/styles/prose.css");
  }
}

const para = (text?: string) =>
  text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };

let editors: Editor[] = [];
afterEach(() => {
  for (const e of editors) e.destroy();
  editors = [];
  document.body.innerHTML = "";
});

function openNote(paragraphs: (string | undefined)[]) {
  const doc = prosemirrorJsonToNoteDoc({ type: "doc", content: paragraphs.map(para) }, { noteId: "n1" });
  const host = document.createElement("div");
  host.className = "note-body bf-prose"; // 与 NoteBody.tsx 的外层一致
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    extensions: createNoteExtensions({
      doc,
      // 与 lib/doc-store.ts 一致：跟踪编辑器本地改动的来源，否则撤销什么都不做
      undoManager: new Y.UndoManager(doc.getXmlFragment("body"), {
        trackedOrigins: new Set<unknown>([ySyncPluginKey]),
        captureTimeout: 500,
      }),
      placeholder: "写点什么…",
      onPasteRejected: () => undefined,
    }),
  });
  editors.push(editor);
  return { doc, host, editor };
}

const highlighted = (host: HTMLElement) =>
  Array.from(host.querySelectorAll(".bf-remote"))
    .map((el) => el.textContent)
    .join("");

/** 另一台设备往第 index 段的 offset 处插入 text，再把增量同步过来 */
function remoteInsert(doc: Y.Doc, index: number, offset: number, text: string) {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  const p = peer.getXmlFragment("body").get(index) as Y.XmlElement;
  (p.get(0) as Y.XmlText).insert(offset, text);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
}

/**
 * 在整个 document 上查、再筛出这个编辑器里的。不能直接 host.querySelectorAll：jsdom 的选择器引擎对
 * 「元素范围查询 + 选择器最左边正好是这个元素自己（.bf-prose）+ 带 > 与 :only-child」会漏匹配
 * ——同一个选择器 document 上 1 个、host 上 0 个，断言「0 个」就会空过。
 */
const matchesIn = (host: HTMLElement, sel: string) =>
  Array.from(document.querySelectorAll(sel)).filter((el) => host.contains(el));

/** prose.css 里画占位文字那条规则的选择器（去掉 ::before），拿去对真实 DOM 做匹配 */
function placeholderSelector(): string {
  const css = readFileSync(proseCssPath(), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = css.split("}").find((block) => block.includes("attr(data-placeholder)"));
  if (!rule) throw new Error("prose.css 里找不到占位规则");
  return rule
    .slice(0, rule.indexOf("{"))
    .replace(/::before/g, "")
    .trim();
}

describe("打开已有内容的便笺", () => {
  it("打开那一下灌进来的正文不算「远端新写的」，不高亮", () => {
    const { host } = openNote(["第一行", undefined, "第三行"]);
    expect(host.textContent).toContain("第三行");
    expect(highlighted(host)).toBe("");
  });

  it("别的设备只打了一个字：只高亮那一个字，不是整篇", () => {
    const { doc, host } = openNote(["第一行", undefined, "第三行"]);
    remoteInsert(doc, 2, 3, "新");
    expect(host.textContent).toContain("第三行新");
    expect(highlighted(host)).toBe("新");
  });

  it("自己按撤销恢复的字不算远端，不高亮", () => {
    const { host, editor } = openNote(["第一行"]);
    editor.commands.insertContentAt(4, "改");
    editor.commands.undo();
    expect(host.textContent).not.toContain("改");
    expect(highlighted(host)).toBe("");
  });

  it("占位文字只在整篇为空时出现，正文中间的空行不显示「写点什么…」", () => {
    const sel = placeholderSelector();
    const filled = openNote(["第一行", undefined, "第三行"]);
    // 先确认这一行确实是个带占位属性的空段落，否则下面的「0 个」说明不了什么
    expect(filled.host.querySelectorAll("p.is-empty[data-placeholder]")).toHaveLength(1);
    expect(matchesIn(filled.host, sel)).toHaveLength(0);

    const empty = openNote([undefined]);
    const hits = matchesIn(empty.host, sel);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.getAttribute("data-placeholder")).toBe("写点什么…");
  });
});
