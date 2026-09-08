import { describe, expect, it } from "vitest";
import { matchRoute, safeNext } from "../router.js";

describe("matchRoute", () => {
  it("识别全部页面路径（含尾斜杠）", () => {
    expect(matchRoute("/")).toEqual({ name: "home" });
    expect(matchRoute("/login")).toEqual({ name: "login" });
    expect(matchRoute("/login/")).toEqual({ name: "login" });
    expect(matchRoute("/signup")).toEqual({ name: "signup" });
    expect(matchRoute("/forgot-password")).toEqual({ name: "forgot-password" });
    expect(matchRoute("/reset-password")).toEqual({ name: "reset-password" });
    expect(matchRoute("/verify-email")).toEqual({ name: "verify-email", kind: "verify" });
    expect(matchRoute("/change-email")).toEqual({ name: "verify-email", kind: "change" });
    expect(matchRoute("/consent")).toEqual({ name: "consent" });
    expect(matchRoute("/device")).toEqual({ name: "device" });
    expect(matchRoute("/account")).toEqual({ name: "account" });
    expect(matchRoute("/notes")).toEqual({ name: "notes" });
    expect(matchRoute("/notes/")).toEqual({ name: "notes" });
    expect(matchRoute("/admin")).toEqual({ name: "admin" });
    expect(matchRoute("/admin/")).toEqual({ name: "admin" });
    expect(matchRoute("/invite/abc_DEF-123")).toEqual({ name: "invite", token: "abc_DEF-123" });
  });
  it("其余一律 not-found", () => {
    expect(matchRoute("/invite")).toEqual({ name: "not-found" });
    expect(matchRoute("/invite/a/b")).toEqual({ name: "not-found" });
    expect(matchRoute("/invite/bad token")).toEqual({ name: "not-found" });
    expect(matchRoute("/api/auth/get-session")).toEqual({ name: "not-found" });
    expect(matchRoute("/v1/me")).toEqual({ name: "not-found" });
    // 管理台只有 /admin 一个路径，子视图走查询串（见 pages/admin/route.ts）
    expect(matchRoute("/admin/users/u1")).toEqual({ name: "not-found" });
    // 便笺列表同理：当前工作区走 ?ws=<id>，没有 /notes/:id 这样的子路径
    expect(matchRoute("/notes/n1")).toEqual({ name: "not-found" });
  });
});

describe("safeNext", () => {
  it("只接受站内绝对路径", () => {
    expect(safeNext("/device?user_code=ABCD1234")).toBe("/device?user_code=ABCD1234");
    expect(safeNext("/invite/tok")).toBe("/invite/tok");
    expect(safeNext(null)).toBeNull();
    expect(safeNext("")).toBeNull();
    expect(safeNext("https://evil.example/")).toBeNull();
    expect(safeNext("//evil.example/")).toBeNull();
    expect(safeNext("/\\evil.example")).toBeNull();
    expect(safeNext("/x\n")).toBeNull();
    expect(safeNext("account")).toBeNull();
  });
});
