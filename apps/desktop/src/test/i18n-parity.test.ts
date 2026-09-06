import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../i18n/en.json";
import zh from "../i18n/zh-Hans.json";
import { resolveLanguage } from "../lib/i18n.js";

function flatten(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") keys.push(...flatten(v as Record<string, unknown>, key));
    else keys.push(key);
  }
  return keys.sort();
}

/** 源码里出现的 t("a.b") 键（不含动态模板键） */
function usedKeys(): Set<string> {
  const root = resolve(import.meta.dirname, "..");
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "test" && entry.name !== "i18n") walk(p);
      } else if (/\.tsx?$/.test(entry.name)) {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) if (m[1]) out.add(m[1]);
      }
    }
  };
  walk(root);
  return out;
}

describe("i18n", () => {
  it("zh-Hans 与 en 键集合完全一致", () => {
    expect(flatten(zh)).toEqual(flatten(en));
  });

  it("源码用到的静态键都在语言包里", () => {
    const keys = new Set(flatten(zh));
    const missing = [...usedKeys()].filter((k) => !keys.has(k) && !keys.has(`${k}_one`));
    expect(missing).toEqual([]);
  });

  it("语言解析：system 按 navigator.languages，中文优先", () => {
    expect(resolveLanguage("en")).toBe("en");
    expect(resolveLanguage("system", ["zh-CN", "en-US"])).toBe("zh-Hans");
    expect(resolveLanguage("system", ["en-GB"])).toBe("en");
    expect(resolveLanguage("system", ["fr"])).toBe("zh-Hans");
  });
});
