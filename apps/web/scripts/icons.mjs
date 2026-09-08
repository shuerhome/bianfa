// 生成 PWA 图标（PNG）。
//
// 为什么要一个脚本而不是直接放几张图：图标就是 index.html 里那个 favicon 的同一套形状
// （--c-accent 的圆角方块 + 四个白点），色值来自 @bianfa/tokens。手工导出的位图一旦和
// token 漂移，就再也没人知道哪个才是对的。这里直接按 token 画，改色只要改一处。
//
// 产物 checked in（public/*.png），构建时不跑：CI 与部署都不该依赖一次图像生成。
// 改了 token 或形状时手动跑一次：pnpm --filter @bianfa/web icons

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

/** --c-accent（packages/tokens/src/tokens.json 的浅色档） */
const ACCENT = [0x4c, 0x5f, 0xd5];
const WHITE = [0xff, 0xff, 0xff];

/** 32×32 的坐标系，与 index.html 里的 favicon 逐字一致 */
const VIEW = 32;
const DOTS = [
  [11, 10],
  [21, 10],
  [11, 22],
  [21, 22],
];
const DOT_R = 2.6;
const CORNER_R = 7;

/** 4×4 超采样：不做的话小尺寸下圆点是锯齿 */
const SS = 4;

function coverage(px, py, size, test) {
  let hit = 0;
  for (let sy = 0; sy < SS; sy += 1) {
    for (let sx = 0; sx < SS; sx += 1) {
      const x = ((px + (sx + 0.5) / SS) / size) * VIEW;
      const y = ((py + (sy + 0.5) / SS) / size) * VIEW;
      if (test(x, y)) hit += 1;
    }
  }
  return hit / (SS * SS);
}

/** 圆角矩形（0..VIEW），r 为 0 时就是整块铺满 */
function insideRounded(x, y, r) {
  if (r <= 0) return true;
  const cx = Math.min(Math.max(x, r), VIEW - r);
  const cy = Math.min(Math.max(y, r), VIEW - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function insideDots(x, y) {
  for (const [dx, dy] of DOTS) {
    if ((x - dx) ** 2 + (y - dy) ** 2 <= DOT_R * DOT_R) return true;
  }
  return false;
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

/**
 * @param size 边长（像素）
 * @param corner 圆角半径（VIEW 坐标系）；0 = 整块铺满。
 *   apple-touch-icon 必须是 0：iOS 自己会切圆角，图里再带一层透明角，
 *   桌面上会露出黑边。maskable 的 manifest 图标同理要铺满。
 */
function render(size, corner) {
  // RGBA
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const bg = coverage(x, y, size, (px, py) => insideRounded(px, py, corner));
      const dot = coverage(x, y, size, insideDots);
      const o = 1 + x * 4;
      for (let c = 0; c < 3; c += 1) row[o + c] = mix(ACCENT[c], WHITE[c], dot);
      row[o + 3] = Math.round(bg * 255);
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, corner) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(render(size, corner), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const files = [
  // manifest 的 any + maskable：铺满，安全区内只有中间那四个点
  ["icon-192.png", 192, 0],
  ["icon-512.png", 512, 0],
  // iOS 主屏图标：必须铺满、必须不透明
  ["apple-touch-icon.png", 180, 0],
  // 浏览器标签页（SVG favicon 兜底）
  ["icon-32.png", 32, CORNER_R],
];
for (const [name, size, corner] of files) {
  writeFileSync(resolve(out, name), png(size, corner));
  console.log(`${name} ${size}×${size}`);
}
