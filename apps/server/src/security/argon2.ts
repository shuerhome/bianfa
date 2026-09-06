// 密码哈希（规格 04 §1.1）：@node-rs/argon2 2.2.0，Argon2id m=19456 t=2 p=1；进程内信号量限制并发 hash ≤ 4。
// 预编译二进制来自 optionalDependencies（--ignore-scripts 下可用，createAuth 启动时会 probe 一次）。
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

export const ARGON2_PARAMS = {
  /** 2 = Argon2id（@node-rs/argon2 的 Algorithm 枚举：0 Argon2d / 1 Argon2i / 2 Argon2id） */
  algorithm: 2 as const,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export const ARGON2_MAX_CONCURRENCY = 4;

let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < ARGON2_MAX_CONCURRENCY) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}

/** 当前正在进行的 hash/verify 数（测试用） */
export function argon2InFlight(): number {
  return active;
}

export async function hashPassword(password: string): Promise<string> {
  await acquire();
  try {
    return await argonHash(password, ARGON2_PARAMS);
  } finally {
    release();
  }
}

export async function verifyPassword(data: { hash: string; password: string }): Promise<boolean> {
  if (!data.hash.startsWith("$argon2")) return false;
  await acquire();
  try {
    return await argonVerify(data.hash, data.password);
  } finally {
    release();
  }
}

/** 启动自检：二进制能加载且能 hash/verify；失败抛错（createAuth 据此决定是否回退 scrypt） */
export async function probeArgon2(): Promise<boolean> {
  const h = await argonHash("probe", ARGON2_PARAMS);
  return argonVerify(h, "probe");
}
