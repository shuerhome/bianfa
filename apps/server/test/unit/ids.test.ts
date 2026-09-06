import { describe, expect, it } from "vitest";
import { isUuid, uuidv7, uuidv7Timestamp } from "../../src/db/ids.js";

const V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  it("格式：小写带连字符，版本 7，变体 10xx", () => {
    for (let i = 0; i < 100; i++) {
      const id = uuidv7();
      expect(id).toMatch(V7_RE);
      expect(isUuid(id)).toBe(true);
    }
    expect(isUuid("not-a-uuid")).toBe(false);
  });

  it("时间戳可回读且接近当前时间", () => {
    const before = Date.now();
    const ts = uuidv7Timestamp(uuidv7());
    expect(ts).not.toBeNull();
    expect(Math.abs((ts as number) - before)).toBeLessThan(2_000);
    expect(uuidv7Timestamp("0f0e0d0c-0b0a-4000-8000-000000000000")).toBeNull(); // v4
  });

  it("同进程严格单调递增（字典序 = 时间序）且唯一", () => {
    const ids = Array.from({ length: 5_000 }, () => uuidv7());
    for (let i = 1; i < ids.length; i++) {
      expect((ids[i] as string) > (ids[i - 1] as string)).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("时钟回拨时沿用上次时间戳，仍然单调", () => {
    const a = uuidv7();
    const b = uuidv7(Date.now() - 60_000);
    expect(b > a).toBe(true);
    expect(uuidv7Timestamp(b) as number).toBeGreaterThanOrEqual(uuidv7Timestamp(a) as number);
  });

  it("同一毫秒内计数器溢出后借用下一毫秒", () => {
    const fixed = Date.now() + 120_000; // 未来时间，确保不被此前的 lastMs 钳住
    const ids = Array.from({ length: 5_000 }, () => uuidv7(fixed));
    for (let i = 1; i < ids.length; i++) expect((ids[i] as string) > (ids[i - 1] as string)).toBe(true);
    expect(uuidv7Timestamp(ids[0] as string)).toBe(fixed);
    // 12 bit 计数器最多 4096 个/ms，5000 个必然跨到下一毫秒
    expect(uuidv7Timestamp(ids.at(-1) as string) as number).toBeGreaterThan(fixed);
  });
});
