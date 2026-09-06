import { act, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import zh from "../i18n/zh-Hans.json";
import { effectiveState, shrinkGuardTripped } from "../sync/index.js";
import { SyncDot } from "../windows/note/SyncDot.js";

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: "zh-Hans",
    resources: { "zh-Hans": { translation: zh } },
    interpolation: { escapeValue: false },
  });
});

describe("SyncDot 四态", () => {
  it("synced 不画；offline 空心；error 可点击", () => {
    const { rerender } = render(<SyncDot state="synced" />);
    expect(screen.getByRole("status").className).toContain("note-sync--hidden");
    rerender(<SyncDot state="offline" />);
    expect(screen.getByRole("status").className).toContain("note-sync--offline");
    rerender(<SyncDot state="error" />);
    expect(screen.getByRole("button").className).toContain("note-sync--error");
  });

  it("syncing 300ms 后才点亮", () => {
    vi.useFakeTimers();
    render(<SyncDot state="syncing" />);
    expect(screen.getByRole("status").className).toContain("note-sync--hidden");
    act(() => {
      vi.advanceTimersByTime(320);
    });
    expect(screen.getByRole("status").className).toContain("note-sync--syncing");
    vi.useRealTimers();
  });
});

describe("状态折叠与收缩守卫", () => {
  it("便笺级 error 优先；全局 offline 覆盖便笺级", () => {
    const at = 0;
    expect(effectiveState({ state: "synced", at }, { state: "error", at })).toBe("error");
    expect(effectiveState({ state: "offline", at }, { state: "syncing", at })).toBe("offline");
    expect(effectiveState({ state: "synced", at }, { state: "syncing", at })).toBe("syncing");
    expect(effectiveState(null, null)).toBe("local");
  });
  it("before>200 且 after<70% → 触发", () => {
    expect(shrinkGuardTripped("x".repeat(300), "x".repeat(100))).toBe(true);
    expect(shrinkGuardTripped("x".repeat(300), "x".repeat(250))).toBe(false);
    expect(shrinkGuardTripped("x".repeat(100), "")).toBe(false);
  });
});
