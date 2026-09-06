// Prometheus 指标（规格 03 §1.9，指标名按裁定 C-5：bianfa_ws_connections）。/metrics 由 onRequest 拦截同端口暴露。
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

export type AuthFailureReason = "expired" | "forbidden" | "gone" | "bad_token" | "origin" | "path";
export type RejectReason = "too_large" | "rate" | "limit";

export interface SyncMetrics {
  registry: Registry;
  /** 活动 socket 数（gauge，collect 时从 Hocuspocus 取） */
  connections: Gauge;
  /** 已加载文档数 */
  documents: Gauge;
  messages: Counter<"direction" | "type">;
  authFailures: Counter<"reason">;
  storeSeconds: Histogram;
  storeFailures: Counter;
  rejected: Counter<"reason">;
  authzRevoked: Counter<"scope">;
  listenUp: Gauge;
  /** 供 gauge collect 回调读取当前值 */
  setCollectors(fn: { connections: () => number; documents: () => number }): void;
}

export function createMetrics(): SyncMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  let collectors = { connections: () => 0, documents: () => 0 };

  const connections = new Gauge({
    name: "bianfa_ws_connections",
    help: "Active WebSocket connections (sockets)",
    registers: [registry],
    collect() {
      this.set(collectors.connections());
    },
  });
  const documents = new Gauge({
    name: "bianfa_ws_documents",
    help: "Loaded Hocuspocus documents",
    registers: [registry],
    collect() {
      this.set(collectors.documents());
    },
  });
  const messages = new Counter({
    name: "bianfa_ws_messages_total",
    help: "WebSocket messages by direction and type",
    labelNames: ["direction", "type"] as const,
    registers: [registry],
  });
  const authFailures = new Counter({
    name: "bianfa_ws_auth_failures_total",
    help: "Rejected authentications by reason",
    labelNames: ["reason"] as const,
    registers: [registry],
  });
  const storeSeconds = new Histogram({
    name: "bianfa_ws_store_seconds",
    help: "onStoreDocument duration in seconds",
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const storeFailures = new Counter({
    name: "bianfa_ws_store_failures_total",
    help: "onStoreDocument failures",
    registers: [registry],
  });
  const rejected = new Counter({
    name: "bianfa_ws_rejected_total",
    help: "Rejected messages / connections by reason",
    labelNames: ["reason"] as const,
    registers: [registry],
  });
  const authzRevoked = new Counter({
    name: "bianfa_ws_authz_revoked_total",
    help: "authz_revoked notifications handled by scope",
    labelNames: ["scope"] as const,
    registers: [registry],
  });
  const listenUp = new Gauge({
    name: "bianfa_ws_listen_up",
    help: "1 when the direct LISTEN connection is up",
    registers: [registry],
  });
  listenUp.set(0);

  // 让各标签在首次抓取时就存在（告警规则不必处理缺失序列）
  for (const reason of ["expired", "forbidden", "gone", "bad_token", "origin", "path"])
    authFailures.labels(reason).inc(0);
  for (const reason of ["too_large", "rate", "limit"]) rejected.labels(reason).inc(0);

  return {
    registry,
    connections,
    documents,
    messages,
    authFailures,
    storeSeconds,
    storeFailures,
    rejected,
    authzRevoked,
    listenUp,
    setCollectors(fn) {
      collectors = fn;
    },
  };
}
