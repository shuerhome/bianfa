// 独立便笺窗口。三件事必须钉住，每一件错了都是"点了没反应"这种最难查的表现：
//   ① 被弹窗拦截器挡掉时 window.open 返回 null —— 必须说出来，不能静默；
//   ② 同一张便笺复用同一个 window name —— 否则点两次会开出两个窗口，两条同步连接；
//   ③ 手机上不给这个入口 —— iOS 没有多窗口，点了只会跳走一个标签页，比没有还糟。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteWindowName, openNoteWindow, supportsNoteWindows } from "../lib/note-window.js";

function stubMatchMedia(pointerFine: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: query.includes("pointer: fine") ? pointerFine : false }),
  });
}

beforeEach(() => {
  stubMatchMedia(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("supportsNoteWindows", () => {
  it("有精确指针（鼠标/触控板）才给入口", () => {
    stubMatchMedia(true);
    expect(supportsNoteWindows()).toBe(true);
  });

  it("③ 触摸设备不给：iOS 没有多窗口，点了只会跳走一个标签页", () => {
    stubMatchMedia(false);
    expect(supportsNoteWindows()).toBe(false);
  });

  it("环境里根本没有 matchMedia 时退回 false，而不是抛异常", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: undefined });
    expect(supportsNoteWindows()).toBe(false);
  });
});

describe("openNoteWindow", () => {
  it("② 窗口名按便笺 id 取，同一张便笺永远是同一个窗口", () => {
    expect(noteWindowName("n1")).toBe("bianfa-note-n1");
    expect(noteWindowName("n1")).toBe(noteWindowName("n1"));
    expect(noteWindowName("n1")).not.toBe(noteWindowName("n2"));
  });

  it("新开一个窗口：window.open 收到窗口名和 popup 特性", () => {
    const fake = { closed: false, focus: vi.fn() } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(fake);
    const r = openNoteWindow("/note?ws=w1&note=n1", "n1");
    expect(r.result).toBe("opened");
    expect(open).toHaveBeenCalledTimes(1);
    const [url, name, features] = open.mock.calls[0] ?? [];
    expect(url).toBe("/note?ws=w1&note=n1");
    expect(name).toBe("bianfa-note-n1");
    expect(String(features)).toContain("popup");
  });

  it("② 已经开着的那张：聚焦，不再开一个（否则会多一条同步连接）", () => {
    const existing = { closed: false, focus: vi.fn() } as unknown as Window;
    const open = vi.spyOn(window, "open");
    const r = openNoteWindow("/note?ws=w1&note=n1", "n1", existing);
    expect(r.result).toBe("focused");
    expect(existing.focus).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("用户自己关掉之后再点：重新开，不当成已存在", () => {
    const closed = { closed: true, focus: vi.fn() } as unknown as Window;
    const fresh = { closed: false, focus: vi.fn() } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(fresh);
    const r = openNoteWindow("/note?ws=w1&note=n1", "n1", closed);
    expect(r.result).toBe("opened");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("① 被拦截器挡掉（window.open 返回 null）要报出来", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const r = openNoteWindow("/note?ws=w1&note=n1", "n1");
    expect(r.result).toBe("blocked");
    expect(r.win).toBeNull();
  });
});
