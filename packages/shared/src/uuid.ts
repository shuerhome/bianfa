// UUIDv7（客户端生成便笺 id，规格 02 §6.1）：48 位 ms 时间戳 + 版本 7 + 74 位随机。
//
// 桌面端与网页端共用这一份。服务端另有一份（apps/server/src/db/ids.ts）——那边要 node:crypto
// 和同毫秒内的单调计数器，这边跑在浏览器里，两者的取舍不同，所以没有合并。
// 但格式必须一致：服务端的入参校验是 z.uuidv7()，crypto.randomUUID() 生成的 v4 会被 400 掉。
//
// 本包是无头包（apps/server 与 sync-ws 也 import 它），tsconfig 的 lib 只有 ES2023，没有 DOM。
// getRandomValues 在浏览器和 Node ≥ 19 上都是同一个标准全局，这里只声明用到的那一个方法，
// 不为它把整个 DOM 拉进来。
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const isUuid = (s: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
