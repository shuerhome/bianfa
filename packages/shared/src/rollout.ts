// 灰度分桶（规格 01 §9）：bucket = murmur3_32(install_id + "updater" + salt) % 100。
// 必须与 infra 的 update Worker 使用同一 MurmurHash3 x86_32 实现；测试向量见 rollout.test.ts。
// 输入按 UTF-8 字节哈希；这里手写 UTF-8 编码，不依赖 TextEncoder（避免 lib 差异）。

function utf8Bytes(str: string): Uint8Array {
  const out: number[] = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

/** MurmurHash3 x86_32；返回无符号 32 位整数 */
export function murmur3_32(input: string | Uint8Array, seed = 0): number {
  const bytes = typeof input === "string" ? utf8Bytes(input) : input;
  const len = bytes.length;
  const nblocks = len >>> 2;
  let h1 = seed >>> 0;

  for (let i = 0; i < nblocks; i += 1) {
    const o = i * 4;
    let k1 =
      ((bytes[o] ?? 0) |
        ((bytes[o + 1] ?? 0) << 8) |
        ((bytes[o + 2] ?? 0) << 16) |
        ((bytes[o + 3] ?? 0) << 24)) >>>
      0;
    k1 = Math.imul(k1, C1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, C2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }

  const tail = nblocks * 4;
  const rem = len & 3;
  if (rem > 0) {
    let k1 = 0;
    if (rem >= 3) k1 ^= (bytes[tail + 2] ?? 0) << 16;
    if (rem >= 2) k1 ^= (bytes[tail + 1] ?? 0) << 8;
    k1 ^= bytes[tail] ?? 0;
    k1 = Math.imul(k1, C1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, C2);
    h1 ^= k1;
  }

  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

export const ROLLOUT_KEY_INFIX = "updater";

/** 0–99；与 update Worker 的分桶完全一致。install_id 不得写入任何日志。 */
export function rolloutBucket(installId: string, salt: string): number {
  return murmur3_32(`${installId}${ROLLOUT_KEY_INFIX}${salt}`) % 100;
}

/** 客户端 flags.json 判定：bucket < percent 即命中（percent 取 0–100） */
export function isInRollout(installId: string, salt: string, percent: number): boolean {
  const p = Math.max(0, Math.min(100, Math.trunc(percent)));
  return rolloutBucket(installId, salt) < p;
}
