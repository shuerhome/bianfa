// S4 CRDT 端到端（规格 03 §8 第 1 行 / 01 S4）：两个独立 Doc 各离线随机编辑 200 次后交换 update，
// encodeStateAsUpdateV2 byte-identical 且 getXmlFragment('body').toString() 相等。
// 语料含中文、emoji（ZWJ 序列 + 变体选择符 + 肤色修饰 + 旗帜）、粗/斜/列表标记（Y.XmlText / Y.XmlElement）。
// 同时锁定 §2.2 三行约定：XmlFragment('body') / Map('meta') / Map('ext')。
//
// 两个实测出来的前提（写进 ADR）：
// 1. 编辑位置必须落在码点边界。以任意 UTF-16 偏移插入/删除会劈开代理对，孤代理经 UTF-8 编码变成 U+FFFD，
//    本地副本与经线路传输的副本从此不一致 —— 这正是 01 S4「OffsetKind 地雷」；真实编辑器（ProseMirror）不会产生这种位置。
// 2. 交换必须像 provider 一样进行到不动点：Yjs 在整合带格式的远端 update 后会本地清理冗余 ContentFormat（产生新的删除），
//    这些后续删除也要送到对方。一次性互换后通常还需要 1 轮。
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { isEmptyUpdateV2 } from "../../src/notes/doc-store.js";

const CORPUS = [
  "便笺",
  "中文测试",
  "你好，世界",
  "👨‍👩‍👧‍👦", // ZWJ family
  "🏳️‍🌈", // ZWJ + VS16
  "❤️", // VS16
  "👍🏽", // skin tone modifier
  "🇨🇳", // regional indicators
  "a",
  "Z",
  " ",
  "\n",
  "ｱｲｳ",
  "𝔘𝔫𝔦", // astral plane letters
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function bodyOf(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment("body");
}

/** UTF-16 偏移中的码点边界（含 0 与末尾） */
function codePointBoundaries(text: Y.XmlText): number[] {
  const plain = text
    .toDelta()
    .map((d: { insert?: unknown }) => (typeof d.insert === "string" ? d.insert : ""))
    .join("");
  const out = [0];
  for (const ch of plain) out.push((out[out.length - 1] as number) + ch.length);
  return out;
}

function pickPos(text: Y.XmlText, rand: () => number, allowEnd: boolean): number {
  const b = codePointBoundaries(text);
  const i = Math.floor(rand() * (allowEnd ? b.length : Math.max(1, b.length - 1)));
  return b[Math.min(i, b.length - 1)] as number;
}

function pickLen(text: Y.XmlText, pos: number, rand: () => number, maxCodePoints: number): number {
  const after = codePointBoundaries(text).filter((x) => x > pos);
  const n = Math.min(after.length, 1 + Math.floor(rand() * maxCodePoints));
  return n === 0 ? 0 : (after[n - 1] as number) - pos;
}

function randomEdit(doc: Y.Doc, rand: () => number, origin: string): void {
  const body = bodyOf(doc);
  doc.transact(() => {
    const roll = rand();
    if (body.length === 0 || roll < 0.15) {
      const el = new Y.XmlElement(rand() < 0.5 ? "paragraph" : "listItem");
      const text = new Y.XmlText();
      text.insert(0, CORPUS[Math.floor(rand() * CORPUS.length)] as string);
      el.insert(0, [text]);
      body.insert(Math.floor(rand() * (body.length + 1)), [el]);
      return;
    }
    const el = body.get(Math.floor(rand() * body.length)) as Y.XmlElement;
    const text = el.firstChild as Y.XmlText | null;
    if (!text) return;
    if (roll < 0.6) {
      const word = CORPUS[Math.floor(rand() * CORPUS.length)] as string;
      const attrs = rand() < 0.3 ? { bold: true } : rand() < 0.5 ? { italic: true } : undefined;
      text.insert(pickPos(text, rand, true), word, attrs);
    } else if (roll < 0.8 && text.length > 0) {
      const pos = pickPos(text, rand, false);
      const len = pickLen(text, pos, rand, 3);
      if (len > 0) text.delete(pos, len);
    } else if (text.length > 0) {
      const pos = pickPos(text, rand, false);
      const len = pickLen(text, pos, rand, 4);
      if (len > 0) text.format(pos, len, rand() < 0.5 ? { bold: true } : { italic: true });
    }
    doc.getMap("meta").set("bodyEditedAt", Math.floor(rand() * 1e12));
  }, origin);
}

/** 像 provider 一样把本地 update 送给对方，直到双方都不再产生新 update；返回轮数 */
function exchangeUntilQuiescent(a: Y.Doc, b: Y.Doc, fromA: Uint8Array[], fromB: Uint8Array[]): number {
  let rounds = 0;
  while (fromA.length > 0 || fromB.length > 0) {
    const ua = fromA.splice(0, fromA.length);
    const ub = fromB.splice(0, fromB.length);
    if (ua.length > 0) Y.applyUpdateV2(b, Y.mergeUpdatesV2(ua), "remote");
    if (ub.length > 0) Y.applyUpdateV2(a, Y.mergeUpdatesV2(ub), "remote");
    rounds += 1;
    if (rounds > 20) throw new Error("no fixpoint");
  }
  return rounds;
}

const bytesEqual = (x: Uint8Array, y: Uint8Array) => Buffer.from(x).equals(Buffer.from(y));

describe("S4: two replicas converge byte-identically after 200 offline edits each", () => {
  it.each([
    { gc: true, seedA: 42, seedB: 4242 },
    { gc: true, seedA: 7, seedB: 99 },
    { gc: false, seedA: 42, seedB: 4242 },
  ])("gc=$gc seeds=$seedA/$seedB", ({ gc, seedA, seedB }) => {
    const a = new Y.Doc({ gc });
    const b = new Y.Doc({ gc });
    // 共同起点
    const seed = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, "起点 👨‍👩‍👧‍👦 段落");
    seed.insert(0, [t]);
    bodyOf(a).insert(0, [seed]);
    Y.applyUpdateV2(b, Y.encodeStateAsUpdateV2(a));

    const ra = rng(seedA);
    const rb = rng(seedB);
    const fromA: Uint8Array[] = [];
    const fromB: Uint8Array[] = [];
    a.on("updateV2", (u: Uint8Array, origin: unknown) => {
      if (origin !== "remote") fromA.push(u);
    });
    b.on("updateV2", (u: Uint8Array, origin: unknown) => {
      if (origin !== "remote") fromB.push(u);
    });
    for (let i = 0; i < 200; i++) {
      randomEdit(a, ra, "local");
      randomEdit(b, rb, "local");
    }
    expect(fromA.length).toBeGreaterThan(100);
    expect(fromB.length).toBeGreaterThan(100);
    expect(bodyOf(a).toString()).not.toBe(bodyOf(b).toString());

    const rounds = exchangeUntilQuiescent(a, b, fromA, fromB);
    expect(rounds).toBeLessThanOrEqual(3);

    const stateA = Y.encodeStateAsUpdateV2(a);
    const stateB = Y.encodeStateAsUpdateV2(b);
    expect(bytesEqual(stateA, stateB)).toBe(true);
    expect(bodyOf(a).toString()).toBe(bodyOf(b).toString());
    expect(bodyOf(a).toString().length).toBeGreaterThan(0);
    expect(a.getMap("meta").toJSON()).toEqual(b.getMap("meta").toJSON());
    expect(bytesEqual(Y.encodeStateVector(a), Y.encodeStateVector(b))).toBe(true);
    expect(Y.equalSnapshots(Y.snapshot(a), Y.snapshot(b))).toBe(true);

    // 幂等：重复应用不改变状态；第三副本从零回放得到同样的字节
    Y.applyUpdateV2(a, stateB, "remote");
    expect(bytesEqual(Y.encodeStateAsUpdateV2(a), stateB)).toBe(true);
    const c = new Y.Doc({ gc });
    Y.applyUpdateV2(c, stateA);
    expect(bytesEqual(Y.encodeStateAsUpdateV2(c), stateA)).toBe(true);
    expect(bodyOf(c).toString()).toBe(bodyOf(a).toString());
    a.destroy();
    b.destroy();
    c.destroy();
  });

  it("documents the surrogate-pair hazard: splitting a pair corrupts the text with U+FFFD", () => {
    const a = new Y.Doc({ gc: true });
    const el = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, "🇨🇳");
    el.insert(0, [t]);
    bodyOf(a).insert(0, [el]);
    // 在代理对中间插入（UTF-16 偏移 1）：Yjs 的 ContentString.splice 会把两半都换成 U+FFFD —— 字丢了，且不可逆
    t.insert(1, "x");
    const local = bodyOf(a).toString();
    expect(local).toContain("�");
    expect(local).not.toContain("🇨");
    const b = new Y.Doc({ gc: true });
    Y.applyUpdateV2(b, Y.encodeStateAsUpdateV2(a));
    expect(bodyOf(b).toString()).toBe(local);
    a.destroy();
    b.destroy();
  });

  it("diffUpdateV2 against a state vector yields only what the other side lacks; deletions travel in the delete set", () => {
    const a = new Y.Doc({ gc: true });
    const el = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, "hello 世界");
    el.insert(0, [t]);
    bodyOf(a).insert(0, [el]);
    const sv1 = Y.encodeStateVectorFromUpdateV2(Y.encodeStateAsUpdateV2(a));
    // 无变化 → diff 为空
    expect(isEmptyUpdateV2(Y.diffUpdateV2(Y.encodeStateAsUpdateV2(a), sv1))).toBe(true);
    expect(isEmptyUpdateV2(Y.encodeStateAsUpdateV2(new Y.Doc()))).toBe(true);
    // 纯删除 → 没有新 struct，但 delete set 非空，绝不能当作"无变化"
    t.delete(0, 5);
    const diff = Y.diffUpdateV2(Y.encodeStateAsUpdateV2(a), sv1);
    expect(isEmptyUpdateV2(diff)).toBe(false);
    const { structs, ds } = Y.decodeUpdateV2(diff);
    expect(structs.length).toBe(0);
    expect(ds.clients.size).toBeGreaterThan(0);
    // 快照相等性能识别"无变化"，并把删除视为变化
    const snap1 = Y.snapshot(a);
    expect(Y.equalSnapshots(snap1, Y.snapshot(a))).toBe(true);
    t.delete(0, 1);
    expect(Y.equalSnapshots(snap1, Y.snapshot(a))).toBe(false);
    a.destroy();
  });
});
