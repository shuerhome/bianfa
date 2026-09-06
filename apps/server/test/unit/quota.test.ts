import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MAX_BYTES,
  checkStorageQuota,
  GB,
  MB,
  normalizePlan,
  STORAGE_LIMITS,
} from "../../src/services/quota.js";

describe("配额（规格 04 §4.5）", () => {
  it("套餐上限：Free 100 MB / Pro 2 GB / Team 10 GB", () => {
    expect(STORAGE_LIMITS.free).toBe(100 * MB);
    expect(STORAGE_LIMITS.pro).toBe(2 * GB);
    expect(STORAGE_LIMITS.team).toBe(10 * GB);
    expect(ATTACHMENT_MAX_BYTES).toBe(10 * MB);
  });

  it("used + incoming ≤ limit 才通过；刚好等于上限通过，超 1 字节拒绝", () => {
    expect(checkStorageQuota(90 * MB, 10 * MB, "free").ok).toBe(true);
    expect(checkStorageQuota(90 * MB, 10 * MB + 1, "free").ok).toBe(false);
    const r = checkStorageQuota(95 * MB, 10 * MB, "free");
    expect(r).toMatchObject({ ok: false, used: 95 * MB, limit: 100 * MB, incoming: 10 * MB });
    expect(r.remaining).toBe(-5 * MB);
  });

  it("单张 > 10 MB 无论套餐都拒绝", () => {
    expect(checkStorageQuota(0, 10 * MB + 1, "team").ok).toBe(false);
    expect(checkStorageQuota(0, 10 * MB, "team").ok).toBe(true);
  });

  it("未知套餐按 free", () => {
    expect(normalizePlan("enterprise")).toBe("free");
    expect(normalizePlan(null)).toBe("free");
    expect(normalizePlan("pro")).toBe("pro");
  });
});
