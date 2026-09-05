/**
 * bianfa 黑盒探测 Worker
 *
 * 作用
 *   每分钟（Cron）从 Cloudflare 边缘 GET `HEALTHZ_URL`（默认 https://api.<domain>/healthz，经 Tunnel → Caddy → api）。
 *   - 连续 FAIL_THRESHOLD（默认 2）次失败 → 推一条 Telegram「DOWN」，之后不再重复（直到恢复）。
 *   - 恢复（一次成功）且之前处于告警态 → 推一条「RECOVERED」，附故障时长。
 *   - 可选：调 Cloudflare API 数 Tunnel 的健康 connector（cloudflared 副本）数，< MIN_TUNNEL_CONNECTORS 告警一次，恢复再报一次。
 *
 * 为什么是 Worker 而不是 VPS 上的 cron：第 9 章 8.8「监控系统不能和被监控对象同机」；这条探测走的是用户的真实路径
 *   （边缘 → Tunnel → Caddy → api），Tunnel 掉了它一样能发现。
 *
 * KV 写入策略（KV Free 只有 1,000 次写/天（不同键），而 Cron 一天跑 1,440 次）
 *   只在「状态机」变化时写 `state` 键：稳态（一直健康）0 次写；一次故障 + 恢复 ≈ 3 次写。
 *   已在告警态且仍然失败的分钟 **不写**（否则一次 17 小时的长故障就把当天写额度耗光，之后连「恢复」都记不下来）。
 *
 * 已知限制（KV 最终一致，写进 RUNBOOK）
 *   Cron 在「利用率低的机器」上跑，位置不固定；KV 写在本地立即可见，其它位置最多 60 s 后可见。
 *   最坏情况：某一分钟读到上一分钟之前的旧状态 → 告警晚 1 分钟，或 DOWN 重复发一次。可接受；要严格一次就换 Durable Object。
 *
 * 来源章节：第 9 章 8.4（cloudflared ×2）、8.8（黑盒探测、7 条告警之「/healthz 连续失败」与「connector < 2」）。
 * 2026-09-05 核实：
 *   - Telegram Bot API：POST https://api.telegram.org/bot<token>/sendMessage，必填 chat_id + text（≤ 4096 字符）；
 *     link_preview_options 为当前字段（旧 disable_web_page_preview 已弃用）。[Bot API 具体版本号不在本文件断言]
 *   - Tunnel connector 列表：GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections，返回 ActiveClient[]，
 *     每项 { id, features, version, arch, run_at, conns: [{ colo_name, id, is_pending_reconnect, origin_ip, opened_at }] }
 *     （cloudflared 源码 cfapi/tunnel.go 的 ActiveClient / Connection 结构体）。Cloudflare 2026-07-09 changelog：
 *     2026-10-05 起 tunnel 对象里的 connections 字段下线，**必须**用这个专用端点——本文件用的正是它。
 *   - 所需 API token 权限：账号级「Cloudflare Tunnel Read」（fundamentals/api/reference/permissions：Grants access to view Cloudflare Tunnels）。
 *
 * 必须人工替换的值：全部在 wrangler.toml 与 `wrangler secret put`；本文件无需改动。
 */

export interface Env {
	STATE: KVNamespace;
	SERVICE_NAME: string;
	HEALTHZ_URL: string;
	FAIL_THRESHOLD: string;
	REQUEST_TIMEOUT_MS: string;
	EXPECT_STATUS: string;
	EXPECT_BODY_CONTAINS: string;
	/** secrets（wrangler secret put） */
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
	CF_API_TOKEN?: string;
	/** 可选：Tunnel connector 检查（[vars]） */
	CF_ACCOUNT_ID: string;
	CF_TUNNEL_ID: string;
	MIN_TUNNEL_CONNECTORS: string;
}

interface State {
	/** 连续失败次数（只在未告警阶段累加；进入告警态后冻结在阈值） */
	failures: number;
	/** 是否已发出 DOWN 告警且尚未恢复 */
	alerting: boolean;
	/** 首次失败时间（ISO） */
	down_since?: string;
	last_error?: string;
	/** Tunnel connector 告警态 */
	tunnel_alerting: boolean;
	updated_at: string;
}

const STATE_KEY = "state";

const DEFAULT_STATE: State = {
	failures: 0,
	alerting: false,
	tunnel_alerting: false,
	updated_at: new Date(0).toISOString(),
};

interface ProbeResult {
	ok: boolean;
	detail: string;
	ms: number;
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------
async function probe(env: Env): Promise<ProbeResult> {
	const timeoutMs = Math.max(1000, Number(env.REQUEST_TIMEOUT_MS) || 10000);
	const expectStatus = Number(env.EXPECT_STATUS) || 200;
	const mustContain = (env.EXPECT_BODY_CONTAINS ?? "").trim();
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	const started = Date.now();
	try {
		const res = await fetch(env.HEALTHZ_URL, {
			method: "GET",
			redirect: "manual", // 3xx 也算失败：/healthz 不该跳转
			signal: ctrl.signal,
			headers: {
				"user-agent": "bianfa-healthcheck/1 (cloudflare-worker)",
				"cache-control": "no-cache",
				accept: "application/json, text/plain;q=0.9, */*;q=0.1",
			},
		});
		const ms = Date.now() - started;
		const body = (await res.text()).slice(0, 2000);
		if (res.status !== expectStatus) {
			return { ok: false, detail: `HTTP ${res.status} (expected ${expectStatus}) in ${ms} ms`, ms };
		}
		if (mustContain && !body.includes(mustContain)) {
			return { ok: false, detail: `HTTP ${res.status} but body lacks "${mustContain}" in ${ms} ms`, ms };
		}
		return { ok: true, detail: `HTTP ${res.status} in ${ms} ms`, ms };
	} catch (err) {
		const ms = Date.now() - started;
		const aborted = err instanceof Error && err.name === "AbortError";
		return {
			ok: false,
			detail: aborted ? `timeout after ${timeoutMs} ms` : `fetch error: ${errorMessage(err)}`,
			ms,
		};
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Tunnel connector 数（可选）
// ---------------------------------------------------------------------------
interface CfConnection {
	id: string;
	colo_name: string;
	is_pending_reconnect: boolean;
	opened_at: string;
}
interface CfActiveClient {
	id: string;
	version: string;
	arch: string;
	run_at: string;
	conns: CfConnection[];
}
interface CfEnvelope<T> {
	success: boolean;
	result: T;
	errors: { code: number; message: string }[];
}

function tunnelCheckEnabled(env: Env): boolean {
	return Boolean(env.CF_ACCOUNT_ID?.trim() && env.CF_TUNNEL_ID?.trim() && env.CF_API_TOKEN?.trim());
}

/** 返回健康 connector（至少有一条非 pending 连接的 cloudflared 进程）数量；API 失败返回 null（不告警，只记日志） */
async function countHealthyConnectors(env: Env): Promise<number | null> {
	const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID.trim())}/cfd_tunnel/${encodeURIComponent(env.CF_TUNNEL_ID.trim())}/connections`;
	try {
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, accept: "application/json" },
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) {
			console.error(JSON.stringify({ evt: "tunnel_api_error", status: res.status }));
			return null;
		}
		const data = (await res.json()) as CfEnvelope<CfActiveClient[]>;
		if (!data.success || !Array.isArray(data.result)) {
			console.error(JSON.stringify({ evt: "tunnel_api_error", errors: data.errors }));
			return null;
		}
		return data.result.filter((c) => Array.isArray(c.conns) && c.conns.some((x) => !x.is_pending_reconnect)).length;
	} catch (err) {
		console.error(JSON.stringify({ evt: "tunnel_api_error", err: errorMessage(err) }));
		return null;
	}
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------
async function telegram(env: Env, text: string): Promise<boolean> {
	if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
		console.error(JSON.stringify({ evt: "telegram_not_configured" }));
		return false;
	}
	const body = JSON.stringify({
		chat_id: env.TELEGRAM_CHAT_ID,
		text: text.slice(0, 4096),
		link_preview_options: { is_disabled: true },
	});
	// 纯文本、不设 parse_mode：省掉 MarkdownV2 转义这一整类 bug
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
				signal: AbortSignal.timeout(10000),
			});
			if (res.ok) return true;
			// 不把响应体原文写日志：Telegram 的错误体可能回显请求 URL（含 bot token）
			console.error(JSON.stringify({ evt: "telegram_error", status: res.status, attempt }));
		} catch (err) {
			console.error(JSON.stringify({ evt: "telegram_error", err: errorMessage(err), attempt }));
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function run(env: Env, scheduledTime: number): Promise<void> {
	if (!env.HEALTHZ_URL || env.HEALTHZ_URL.includes("REPLACE_ME")) {
		console.error(JSON.stringify({ evt: "misconfigured", msg: "HEALTHZ_URL is empty or still contains REPLACE_ME" }));
		return;
	}
	const threshold = Math.max(1, Number(env.FAIL_THRESHOLD) || 2);
	const now = new Date(scheduledTime || Date.now());
	const nowIso = now.toISOString();

	const prev = (await env.STATE.get<State>(STATE_KEY, { type: "json" })) ?? DEFAULT_STATE;
	const next: State = { ...prev };
	let changed = false;

	// ---- /healthz ----
	const r = await probe(env);
	console.log(JSON.stringify({ evt: "probe", ok: r.ok, ms: r.ms, detail: r.detail, failures_before: prev.failures, alerting: prev.alerting }));

	if (r.ok) {
		if (prev.alerting) {
			const downFor = prev.down_since ? humanDuration(now.getTime() - Date.parse(prev.down_since)) : "unknown";
			const sent = await telegram(
				env,
				[
					`[RECOVERED] ${env.SERVICE_NAME}`,
					`${env.HEALTHZ_URL}`,
					`down for ${downFor} (since ${prev.down_since ?? "?"})`,
					`now: ${r.detail}`,
					`at ${nowIso}`,
				].join("\n"),
			);
			// 恢复通知发失败就保留告警态，下一分钟再试；避免「悄悄恢复」
			if (sent) {
				next.alerting = false;
				next.failures = 0;
				delete next.down_since;
				delete next.last_error;
				changed = true;
			}
		} else if (prev.failures !== 0) {
			// 抖动：失败 < 阈值就恢复了，不发通知，只清计数
			next.failures = 0;
			delete next.down_since;
			delete next.last_error;
			changed = true;
		}
	} else if (prev.alerting) {
		// 已告警且仍在故障：不写 KV（见文件头「KV 写入策略」），只留日志
	} else {
		next.failures = prev.failures + 1;
		next.last_error = r.detail;
		if (!prev.down_since) next.down_since = nowIso;
		changed = true;
		if (next.failures >= threshold) {
			const sent = await telegram(
				env,
				[
					`[DOWN] ${env.SERVICE_NAME}`,
					`${env.HEALTHZ_URL}`,
					`${next.failures} consecutive failures (threshold ${threshold})`,
					`last: ${r.detail}`,
					`since ${next.down_since}`,
					`runbook: infra/RUNBOOK.md §7.1 — Tunnel connectors -> Caddy -> api replicas (docker compose ps)`,
				].join("\n"),
			);
			// 告警发失败就不置 alerting，下一分钟会再发
			if (sent) next.alerting = true;
		}
	}

	// ---- Tunnel connectors（可选）----
	if (tunnelCheckEnabled(env)) {
		const min = Math.max(1, Number(env.MIN_TUNNEL_CONNECTORS) || 2);
		const n = await countHealthyConnectors(env);
		console.log(JSON.stringify({ evt: "tunnel_connectors", healthy: n, min, alerting: prev.tunnel_alerting }));
		if (n !== null) {
			if (n < min && !prev.tunnel_alerting) {
				const sent = await telegram(
					env,
					[
						`[DEGRADED] cloudflared connectors: ${n} healthy (want >= ${min})`,
						`tunnel ${env.CF_TUNNEL_ID}`,
						n === 0 ? `all connectors down: api/ws are unreachable through the Tunnel` : `redundancy lost: one replica down`,
						`runbook: infra/RUNBOOK.md §6.7`,
						`at ${nowIso}`,
					].join("\n"),
				);
				if (sent) {
					next.tunnel_alerting = true;
					changed = true;
				}
			} else if (n >= min && prev.tunnel_alerting) {
				const sent = await telegram(env, `[OK] cloudflared connectors back to ${n} (>= ${min}) at ${nowIso}`);
				if (sent) {
					next.tunnel_alerting = false;
					changed = true;
				}
			}
		}
	}

	if (changed) {
		next.updated_at = nowIso;
		await env.STATE.put(STATE_KEY, JSON.stringify(next));
	}
}

function humanDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "unknown";
	const s = Math.round(ms / 1000);
	if (s < 90) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 90) return `${m}m`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(run(env, controller.scheduledTime));
	},
	// 没有对外 HTTP 面（wrangler.toml 里 workers_dev=false、preview_urls=false 且无 routes）；这里只是防止误配后暴露状态
	async fetch(): Promise<Response> {
		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
