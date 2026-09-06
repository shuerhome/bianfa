// =============================================================================
// UUIDv7（RFC 9562）—— 服务端直建行时的 id 生成器。
// -----------------------------------------------------------------------------
// 规格 02 §0：主键 UUIDv7，客户端生成为主；PG 内置 uuidv7() 只在 PG ≥ 18 存在（本地 PG16 没有），
// 所以服务端代码永远自己生成，不依赖 DEFAULT。crypto.randomUUID() 是 v4，不能用。
// 布局：48 bit unix ms | 4 bit ver=7 | 12 bit 计数器（rand_a）| 2 bit var=10 | 62 bit 随机。
// 单调性：同一毫秒内计数器 +1；计数器溢出或时钟回拨时借用"下一毫秒"，保证同进程内严格递增。
// =============================================================================
import { randomBytes, randomInt } from "node:crypto";

let lastMs = 0;
let seq = 0;

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export function uuidv7(now: number = Date.now()): string {
  let ms = Math.max(0, Math.floor(now));
  if (ms > lastMs) {
    lastMs = ms;
    // 起始计数器留出高位余量（0 ~ 2047），同毫秒内最多还能再分配 ≥ 2048 个
    seq = randomInt(0, 0x800);
  } else {
    // 同一毫秒或时钟回拨：沿用上次时间戳并递增计数器
    ms = lastMs;
    seq += 1;
    if (seq > 0xfff) {
      ms = ++lastMs;
      seq = randomInt(0, 0x800);
    }
  }

  const b = randomBytes(16);
  // 48 bit 时间戳（大端）
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = (ms >>> 24) & 0xff;
  b[3] = (ms >>> 16) & 0xff;
  b[4] = (ms >>> 8) & 0xff;
  b[5] = ms & 0xff;
  // 版本 7 + 12 bit 计数器
  b[6] = 0x70 | ((seq >>> 8) & 0x0f);
  b[7] = seq & 0xff;
  // 变体 10xx
  b[8] = ((b[8] as number) & 0x3f) | 0x80;

  return format(b);
}

function format(b: Buffer): string {
  let s = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += "-";
    s += HEX[b[i] as number];
  }
  return s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** 取 UUIDv7 里的 unix 毫秒；非 v7 返回 null */
export function uuidv7Timestamp(id: string): number | null {
  if (!UUID_RE.test(id) || id[14] !== "7") return null;
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
