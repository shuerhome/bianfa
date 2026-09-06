// /healthz（规格 03 §1.9）：200 当且仅当 DB `SELECT 1` ≤ 2 s ∧ Redis PING OK（若配置）∧ (LISTEN 在线 ∨ 断开 < 60 s)；
// 收到 SIGTERM 后一律 503（让 Caddy/compose 停止把新连接打过来）。
import type pg from "pg";

export interface ListenStatus {
  /** 未配置 DATABASE_URL_DIRECT → false（功能关闭，不影响健康判定） */
  enabled: boolean;
  up: boolean;
  /** 断开起点（ms）；在线为 null */
  downSince: number | null;
}

export interface HealthDeps {
  pool: pg.Pool;
  redisPing?: (() => Promise<void>) | undefined;
  listenStatus: () => ListenStatus;
  stopping: () => boolean;
  /** LISTEN 断开容忍时长（缺省 60 s） */
  listenGraceMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export interface HealthReport {
  ok: boolean;
  checks: { db: boolean; redis: boolean | null; listen: boolean; stopping: boolean };
  listen: ListenStatus;
}

export function createHealth(deps: HealthDeps): { check(): Promise<HealthReport> } {
  const timeoutMs = deps.timeoutMs ?? 2_000;
  const graceMs = deps.listenGraceMs ?? 60_000;
  const now = deps.now ?? Date.now;

  return {
    async check() {
      const [db, redis] = await Promise.all([
        withTimeout(deps.pool.query("SELECT 1"), timeoutMs).then(
          () => true,
          () => false,
        ),
        deps.redisPing
          ? withTimeout(deps.redisPing(), timeoutMs).then(
              () => true,
              () => false,
            )
          : Promise.resolve<boolean | null>(null),
      ]);
      const listen = deps.listenStatus();
      const listenOk =
        !listen.enabled || listen.up || (listen.downSince !== null && now() - listen.downSince < graceMs);
      const stopping = deps.stopping();
      const ok = db && redis !== false && listenOk && !stopping;
      return { ok, checks: { db, redis, listen: listenOk, stopping }, listen };
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
