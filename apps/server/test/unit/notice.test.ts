import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createNoticeLoader } from "../../src/services/notice.js";

const dir = mkdtempSync(join(tmpdir(), "bianfa-notice-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("notice loader（规格 04 §7.8）", () => {
  it("无 NOTICE_FILE / 文件不存在 / 空文件 / 形状不对 → null", async () => {
    expect(await createNoticeLoader(undefined).load()).toBeNull();
    expect(await createNoticeLoader(join(dir, "missing.json")).load()).toBeNull();
    const empty = join(dir, "empty.json");
    writeFileSync(empty, "");
    expect(await createNoticeLoader(empty, { ttlMs: 0 }).load()).toBeNull();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ v: 1, payload: "x y", sig: "z" }));
    expect(await createNoticeLoader(bad, { ttlMs: 0 }).load()).toBeNull();
  });

  it("合法信封原样返回；mtime 变化后重新读取", async () => {
    const file = join(dir, "notice.json");
    writeFileSync(file, JSON.stringify({ v: 1, payload: "eyJ0IjoxfQ", sig: "c2ln" }));
    let now = 0;
    const loader = createNoticeLoader(file, { ttlMs: 1000, now: () => now });
    expect(await loader.load()).toEqual({ v: 1, payload: "eyJ0IjoxfQ", sig: "c2ln" });
    writeFileSync(file, JSON.stringify({ v: 1, payload: "eyJ0IjoyfQ", sig: "c2ln" }));
    utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(await loader.load()).toEqual({ v: 1, payload: "eyJ0IjoxfQ", sig: "c2ln" }); // ttl 内用缓存
    now = 2000;
    expect(await loader.load()).toEqual({ v: 1, payload: "eyJ0IjoyfQ", sig: "c2ln" });
  });
});
