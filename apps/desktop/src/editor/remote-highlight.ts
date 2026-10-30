// 远端新增文本高亮 8 s（specs/03 §3）：别的设备写进来的字闪一下。
//
// 范围不能取 tr 里的 ReplaceStep：y-tiptap 不管是第一次把整篇灌进编辑器（_forceRerender），还是之后每一次
// 远端更新（_typeChanged），都是一个「0 到文末」的整篇 replace——照 step 算，别处只打一个字，这里也整篇高亮。
// 所以直接比新旧两份文档，findDiffStart / findDiffEnd 夹出真正变了的那一段。
//
// 带着远端标记、但不该高亮的两种：
//   * 旧文档是空的：刚打开便笺、正文刚从本地库灌进来。那不是「别人刚写的」，整篇闪 8 秒没有任何信息量
//     （第二台设备上每张都是刚从服务端拉下来的，打开哪张都整篇高亮）。代价是空便笺里别人敲的第一下不闪。
//   * 撤销 / 重做：走 Y.UndoManager，y-tiptap 同样标成 isChangeOrigin，可那是自己按的 Ctrl+Z。
import { isRemoteTransaction } from "@bianfa/shared";
import { Extension, isNodeEmpty } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

export const REMOTE_HIGHLIGHT_MS = 8000;
const key = new PluginKey<DecorationSet>("bf-remote-highlight");

function isUndoRedo(tr: Transaction): boolean {
  const meta = tr.getMeta(ySyncPluginKey) as { isUndoRedoOperation?: boolean } | undefined;
  return meta?.isUndoRedoOperation === true;
}

/** 新文档里相对旧文档变了的那一段（新文档坐标）；没变或纯删除 → null */
function changedRange(a: PMNode, b: PMNode): { from: number; to: number } | null {
  const start = a.content.findDiffStart(b.content);
  if (start === null) return null;
  const end = a.content.findDiffEnd(b.content);
  if (!end) return null;
  // 两头比到重复字符时会交叉（比如在「aa」中间再插一个 a），把交叉的部分补回去
  const overlap = start - Math.min(end.a, end.b);
  const to = overlap > 0 ? end.b + overlap : end.b;
  return to > start ? { from: start, to } : null;
}

export const RemoteHighlight = Extension.create({
  name: "remoteHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set, oldState, newState) {
            let next = set.map(tr.mapping, tr.doc);
            const expire = tr.getMeta(key) as { expire?: Decoration[] } | undefined;
            if (expire?.expire) next = next.remove(expire.expire);
            if (!tr.docChanged || !isRemoteTransaction(tr) || isUndoRedo(tr)) return next;
            if (isNodeEmpty(oldState.doc)) return next;
            const range = changedRange(oldState.doc, newState.doc);
            if (!range) return next;
            return next.add(newState.doc, [Decoration.inline(range.from, range.to, { class: "bf-remote" })]);
          },
        },
        view(view) {
          let timer: number | null = null;
          const schedule = () => {
            if (timer !== null) return;
            timer = window.setTimeout(() => {
              timer = null;
              const set = key.getState(view.state);
              if (!set) return;
              const all = set.find();
              if (all.length === 0) return;
              view.dispatch(view.state.tr.setMeta(key, { expire: all }).setMeta("addToHistory", false));
            }, REMOTE_HIGHLIGHT_MS);
          };
          return {
            update(v) {
              const set = key.getState(v.state);
              if (set && set.find().length > 0) schedule();
            },
            destroy() {
              if (timer !== null) window.clearTimeout(timer);
            },
          };
        },
        props: {
          decorations(state) {
            return key.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
