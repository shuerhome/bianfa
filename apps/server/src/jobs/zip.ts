// 最小 ZIP 写入器（导出用）：STORE / DEFLATE（zlib.deflateRawSync），UTF-8 文件名标志位，无 ZIP64（单文件 < 4 GB 足够）。
// 不引第三方依赖：导出 ZIP 只有 JSON / Markdown / CSV 文本，几十 MB 以内在内存里一次写完即可。
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  mtime?: Date;
  /** 强制不压缩（默认：压缩后更小才用 DEFLATE） */
  store?: boolean;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

export function createZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    const name = e.name.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!name || name.includes("../") || seen.has(name))
      throw new Error(`zip: invalid or duplicate entry name ${e.name}`);
    seen.add(name);
    const nameBuf = Buffer.from(name, "utf8");
    const raw = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : e.data;
    const crc = crc32(raw) >>> 0;
    let method = 0;
    let payload = raw;
    if (!e.store && raw.length > 0) {
      const deflated = deflateRawSync(raw, { level: 6 });
      if (deflated.length < raw.length) {
        method = 8;
        payload = deflated;
      }
    }
    const { time, date } = dosDateTime(e.mtime ?? new Date());
    const flags = 0x0800; // UTF-8 名称

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** 读回目录（测试用）：返回 [{ name, size }] */
export function listZip(buf: Buffer): { name: string; size: number; method: number }[] {
  const eocdPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdPos < 0) throw new Error("zip: no EOCD");
  const count = buf.readUInt16LE(eocdPos + 10);
  let pos = buf.readUInt32LE(eocdPos + 16);
  const out: { name: string; size: number; method: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error("zip: bad central header");
    const method = buf.readUInt16LE(pos + 10);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    out.push({ name: buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8"), size, method });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
