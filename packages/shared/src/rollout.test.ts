import { describe, expect, it } from "vitest";
import { isInRollout, murmur3_32, rolloutBucket } from "./rollout.js";

describe("murmur3 x86_32", () => {
  it("matches the reference vectors from the update worker", () => {
    expect(murmur3_32("hello")).toBe(0x248bfa47);
    expect(murmur3_32("abc")).toBe(0xb3dd93fa);
    expect(murmur3_32("")).toBe(0);
    // widely published vectors
    expect(murmur3_32("hello, world")).toBe(0x149bbb7f);
    expect(murmur3_32("The quick brown fox jumps over the lazy dog")).toBe(0x2e4ff723);
    expect(murmur3_32("", 1)).toBe(0x514e28b7);
    expect(murmur3_32("", 0xffffffff)).toBe(0x81f16f39);
    expect(murmur3_32("a")).toBe(0x3c2569b2);
    // SMHasher verification vectors (seed 0x9747b28c)
    expect(murmur3_32("aaaa", 0x9747b28c)).toBe(0x5a97808a);
    expect(murmur3_32("aaa", 0x9747b28c)).toBe(0x283e0130);
    expect(murmur3_32("aa", 0x9747b28c)).toBe(0x5d211726);
    expect(murmur3_32("a", 0x9747b28c)).toBe(0x7fa09ea6);
    expect(murmur3_32("abcd", 0x9747b28c)).toBe(0xf0478627);
    expect(murmur3_32("Hello, world!", 0x9747b28c)).toBe(0x24884cba);
    expect(murmur3_32(Uint8Array.from([0, 0, 0, 0]))).toBe(0x2362f9de);
    expect(murmur3_32(Uint8Array.from([0x21, 0x43, 0x65, 0x87]))).toBe(0xf55b516b);
    expect(murmur3_32(Uint8Array.from([0x21, 0x43, 0x65]))).toBe(0x7e4a8634);
    expect(murmur3_32(Uint8Array.from([0x21, 0x43]))).toBe(0xa0f7b07a);
    expect(murmur3_32(Uint8Array.from([0x21]))).toBe(0x72661cf4);
  });

  it("hashes UTF-8 bytes, not UTF-16 code units", () => {
    expect(murmur3_32("便笺")).toBe(murmur3_32(Uint8Array.from([0xe4, 0xbe, 0xbf, 0xe7, 0xac, 0xba])));
    expect(murmur3_32("🎉")).toBe(murmur3_32(Uint8Array.from([0xf0, 0x9f, 0x8e, 0x89])));
  });

  it("buckets deterministically into 0..99", () => {
    const id = "b7e3f0d2-9c7a-4b6e-8d6b-2f8f1c0a9e11";
    const bucket = rolloutBucket(id, "salt-1");
    expect(bucket).toBe(murmur3_32(`${id}updatersalt-1`) % 100);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    expect(rolloutBucket(id, "salt-1")).toBe(bucket);
    expect(isInRollout(id, "salt-1", 100)).toBe(true);
    expect(isInRollout(id, "salt-1", 0)).toBe(false);
    expect(isInRollout(id, "salt-1", bucket)).toBe(false);
    expect(isInRollout(id, "salt-1", bucket + 1)).toBe(true);
  });
});
