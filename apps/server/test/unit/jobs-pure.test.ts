import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createMemoryRateLimiter } from "../../src/http/ratelimit.js";
import { resolveDeletedAt } from "../../src/jobs/project.js";
import { createZip, listZip } from "../../src/jobs/zip.js";
import { attachmentStorageKey, exportStorageKey, sniffImageMime } from "../../src/services/storage.js";

describe("projector「编辑胜」判定（规格 03 §3 / 08 X1）", () => {
  it("meta.deletedAt 且 bodyEditedAt 更新 → 清除；否则保留删除", () => {
    expect(resolveDeletedAt(1000, 2000, null)).toBeNull();
    expect(resolveDeletedAt(2000, 1000, null)).toBe(2000);
    expect(resolveDeletedAt(2000, null, null)).toBe(2000);
  });
  it("服务端 REST 软删（无 CRDT 墓碑）：只有删除之后的编辑才复活", () => {
    expect(resolveDeletedAt(null, 5000, 4000)).toBeNull();
    expect(resolveDeletedAt(null, 3000, 4000)).toBe(4000);
    expect(resolveDeletedAt(null, null, 4000)).toBe(4000);
    expect(resolveDeletedAt(null, null, null)).toBeNull();
  });
});

describe("zip 写入器", () => {
  it("STORE / DEFLATE 往返，目录可读回", () => {
    const big = "便笺 ".repeat(2000);
    const zip = createZip([
      { name: "notes.json", data: '{"a":1}', store: true },
      { name: "notes/n1.md", data: big },
      { name: "empty.txt", data: "" },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const list = listZip(zip);
    expect(list.map((e) => e.name)).toEqual(["notes.json", "notes/n1.md", "empty.txt"]);
    expect(list[0]).toMatchObject({ method: 0, size: 7 });
    expect(list[1]?.method).toBe(8);
    expect(list[1]?.size).toBe(Buffer.byteLength(big));
    // 解压第二个条目验证内容
    const nameLen = zip.readUInt16LE(26);
    const firstDataStart = 30 + nameLen;
    const firstSize = zip.readUInt32LE(18);
    const second = firstDataStart + firstSize;
    const csize = zip.readUInt32LE(second + 18);
    const nlen = zip.readUInt16LE(second + 26);
    const payload = zip.subarray(second + 30 + nlen, second + 30 + nlen + csize);
    expect(inflateRawSync(payload).toString("utf8")).toBe(big);
  });
  it("拒绝重复 / 越界文件名", () => {
    expect(() =>
      createZip([
        { name: "a", data: "1" },
        { name: "a", data: "2" },
      ]),
    ).toThrow();
    expect(() => createZip([{ name: "../x", data: "1" }])).toThrow();
  });
});

describe("对象存储辅助", () => {
  it("storage_key 布局与导出 key", () => {
    const h = "ab".repeat(32);
    expect(attachmentStorageKey("ws1", h.toUpperCase())).toBe(`ws/ws1/blake3/ab/ab/${h}`);
    expect(exportStorageKey("u1", "j1")).toBe("exports/u1/j1.zip");
  });
  it("magic bytes", () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe(
      "image/png",
    );
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from("GIF89a......"))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("<html>"))).toBeNull();
  });
});

describe("内存限流", () => {
  it("固定窗口计数，超限后 retryAfter ≥ 1", async () => {
    let t = 0;
    const rl = createMemoryRateLimiter(() => t);
    for (let i = 0; i < 3; i++) expect((await rl.hit("b", "k", 3, 60)).ok).toBe(true);
    const over = await rl.hit("b", "k", 3, 60);
    expect(over.ok).toBe(false);
    expect(over.retryAfter).toBeGreaterThanOrEqual(1);
    t = 61_000;
    expect((await rl.hit("b", "k", 3, 60)).ok).toBe(true);
    expect((await rl.hit("b", "other", 3, 60)).remaining).toBe(2);
  });
});
