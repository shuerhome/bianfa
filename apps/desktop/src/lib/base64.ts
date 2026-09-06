// IPC 二进制一律 base64 字符串；分块 btoa 避免大 update 触发调用栈上限。
const CHUNK = 0x8000;

export function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

export function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8ToB64(text: string): string {
  return toB64(new TextEncoder().encode(text));
}
