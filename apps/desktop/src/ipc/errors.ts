// 所有 command 的错误统一为 IpcError { code, message, details? }（specs/07 开头）。

export class IpcError extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "IpcError";
    this.code = code;
    this.details = details;
  }
}

export function isIpcError(value: unknown): value is IpcError {
  return value instanceof IpcError;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * 把 invoke 抛出的任意值规整成 IpcError：
 * - { code, message, details? } → 原样；
 * - 字符串 → code "unknown"；
 * - Error → code = error.name（非 Tauri 环境时 invoke 会抛 TypeError → code "no_tauri"）。
 */
export function toIpcError(raw: unknown): IpcError {
  if (raw instanceof IpcError) return raw;
  if (isRecord(raw) && typeof raw.code === "string") {
    const message = typeof raw.message === "string" ? raw.message : raw.code;
    return new IpcError(raw.code, message, raw.details);
  }
  if (typeof raw === "string") {
    // Tauri 在 command 名不存在时抛 "Command xxx not found"
    if (/not found|not allowed/i.test(raw)) return new IpcError("command_not_found", raw);
    return new IpcError("unknown", raw);
  }
  if (raw instanceof Error) {
    const noTauri = /__TAURI_INTERNALS__|invoke is not a function|window.__TAURI/i.test(raw.message);
    return new IpcError(noTauri ? "no_tauri" : raw.name || "unknown", raw.message, raw);
  }
  return new IpcError("unknown", "未知错误", raw);
}

/** 展示用：优先 message，其次 code */
export function describeError(err: unknown): string {
  const e = toIpcError(err);
  return e.message || e.code;
}
