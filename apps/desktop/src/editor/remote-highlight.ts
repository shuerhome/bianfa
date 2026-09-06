// 远端新增文本高亮 8 s（specs/03 §3）：isRemoteTransaction(tr) 的 ReplaceStep 插入区间加 Decoration.inline。
import { isRemoteTransaction } from "@bianfa/shared";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const REMOTE_HIGHLIGHT_MS = 8000;
const key = new PluginKey<DecorationSet>("bf-remote-highlight");

export const RemoteHighlight = Extension.create({
  name: "remoteHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set, _old, newState) {
            let next = set.map(tr.mapping, tr.doc);
            const expire = tr.getMeta(key) as { expire?: Decoration[] } | undefined;
            if (expire?.expire) next = next.remove(expire.expire);
            if (!isRemoteTransaction(tr)) return next;
            const ranges: [number, number][] = [];
            tr.steps.forEach((step, i) => {
              if (!(step instanceof ReplaceStep) || step.slice.size === 0) return;
              const from = step.from;
              const to = step.from + step.slice.size;
              const map = tr.mapping.slice(i + 1);
              ranges.push([map.map(from, -1), map.map(to, 1)]);
            });
            const decos = ranges
              .filter(([a, b]) => b > a && b <= newState.doc.content.size)
              .map(([a, b]) => Decoration.inline(a, b, { class: "bf-remote" }));
            return decos.length > 0 ? next.add(newState.doc, decos) : next;
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
