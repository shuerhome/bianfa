import { describe, expect, it } from "vitest";
import { escapeLikePattern, toBigramQuery, toBigramShingles } from "./bigram.js";

describe("bigram shingling", () => {
  it("splits CJK runs into bigrams and keeps ASCII words", () => {
    expect(toBigramShingles("买牛奶")).toBe("买牛 牛奶");
    expect(toBigramShingles("取快递 丰巢 8-2211，取件码 4471")).toBe("取快 快递 丰巢 8 2211 取件 件码 4471");
    expect(toBigramShingles("Hostinger KVM 4 到期 11/20")).toBe("Hostinger KVM 4 到期 11 20");
    expect(toBigramShingles("iPhone15发布会")).toBe("iPhone15 发布 布会");
    expect(toBigramShingles("买 milk")).toBe("买 milk");
    expect(toBigramShingles("")).toBe("");
    expect(toBigramShingles("   \n\t ")).toBe("");
    expect(toBigramShingles("こんにちは 한국어")).toBe("こん んに にち ちは 한국 국어");
    expect(toBigramShingles("周三 14:00 产品评审\n确认 OKLCH 色板 v2.3")).toBe(
      "周三 14 00 产品 品评 评审 确认 OKLCH 色板 v2 3",
    );
  });

  it("emoji and punctuation act as separators", () => {
    expect(toBigramShingles("待办🎉完成")).toBe("待办 完成");
    expect(toBigramShingles("你好，世界！")).toBe("你好 世界");
  });
});

describe("bigram query", () => {
  it("returns null for single-character or empty queries (LIKE path)", () => {
    expect(toBigramQuery("买")).toBeNull();
    expect(toBigramQuery(" a ")).toBeNull();
    expect(toBigramQuery("🎉")).toBeNull();
    expect(toBigramQuery("")).toBeNull();
    expect(toBigramQuery("  ")).toBeNull();
  });

  it("builds adjacent bigram phrases and prefix terms", () => {
    expect(toBigramQuery("牛奶")).toBe('"牛奶"');
    expect(toBigramQuery("买牛奶")).toBe('"买牛 牛奶"');
    expect(toBigramQuery("买 牛奶")).toBe('"买"* AND "牛奶"');
    expect(toBigramQuery("milk 牛奶")).toBe('"milk"* AND "牛奶"');
    expect(toBigramQuery("ab")).toBe('"ab"*');
    expect(toBigramQuery('say "hi"')).toBe('"say"* AND "hi"*');
    expect(toBigramQuery("，，")).toBeNull();
  });

  it("escapes LIKE patterns", () => {
    expect(escapeLikePattern("100%_a\\b")).toBe("100\\%\\_a\\\\b");
  });
});
