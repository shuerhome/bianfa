/**
 * bianfa 更新清单 Worker —— `https://update.<REPLACE_ME:domain>/{{target}}/{{arch}}/{{current_version}}`
 *
 * 作用
 *   给 tauri-plugin-updater 2.11.0 提供 latest.json，并在边缘做两件 VPS 做不了的事：
 *   1. 灰度：按 `X-Bianfa-Install-Id` 的 murmur3 哈希取模 (0–99) 与 KV 里的 ROLLOUT_PERCENT 比较，
 *      未命中返回 204（Tauri 把 204 视为「无更新」，静默、不报错）。
 *   2. 一键回滚：KV 里 KILL_SWITCH=1 → 全部 204。这就是第 3 章 2.4.3「改一个 KV 值即回滚」。
 *      注意第 17 章 #30：Tauri updater 不做降级，KILL_SWITCH 只能保护还没升级的用户。
 *
 * 来源章节
 *   第 3 章 2.4.3（endpoint 模板 / latest.json 结构 / 灰度）、第 9 章 8.9（R2 目录 releases/{channel}/）、
 *   第 10 章 9.3.5（泄漏预案第 ① 步 = endpoint 改返回 204）、第 17 章 #28（灰度分桶哈希与 flags.json 共用）。
 *
 * 2026-09-05 核实（tauri-apps/plugins-workspace v2 分支 plugins/updater/src/updater.rs；本轮审查再次抽查）
 *   - URL 占位符：{{current_version}} {{target}} {{arch}} {{bundle_type}}；target ∈ linux|darwin|windows，
 *     arch ∈ i686|x86_64|armv7|aarch64|riscv64。
 *   - 平台 key 查找顺序：先 `{os}-{arch}-{installer}`（installer ∈ nsis|msi|app|deb|rpm|appimage），再 `{os}-{arch}`。
 *   - `StatusCode::NO_CONTENT` → `Ok(None)`；非 2xx → 记 error 并尝试下一个 endpoint；
 *     version 用 `Version::from_str(str.trim_start_matches('v'))`（允许 `v` 前缀）；比较为 `release.version > current_version`。
 *   - 默认只带 `Accept: application/json` 与 `User-Agent: <pkg>/<ver>`；自定义头由客户端
 *     `check({ headers })`（JS）或 `updater_builder().header()`（Rust）加。
 *   - KV：bulk get 一次最多 100 个键，返回 `Map<string, string|null>`，options 支持 cacheTtl（最小 30 s）。
 *
 * 客户端约定（写进桌面端 updater 调用处）
 *   headers: { "X-Bianfa-Install-Id": <install_id: 首启生成的随机 UUIDv4，第 17 章 #27>,
 *              "X-Bianfa-Channel": "stable" | "beta" }
 *   没有 Install-Id 的请求落到 bucket 99：只有 ROLLOUT_PERCENT=100 时才拿到更新（fail-safe）。
 *
 * KV 键（namespace 绑定名 ROLLOUT）
 *   KILL_SWITCH              "1" → 全部 204。其它值/不存在 → 正常。
 *   ROLLOUT_PERCENT          "0".."100"，全局默认。不存在 → 视为 100（见 ../../r2.md §3.3「发版顺序」：先写 KV 再传 latest.json）。
 *   ROLLOUT_PERCENT:<chan>   按渠道覆盖，如 ROLLOUT_PERCENT:beta = "100"。
 *   ROLLOUT_SALT             可选。改变它即重排分桶（默认空串，与 flags.json 共用同一个哈希输入）。
 *   KV 读用 cacheTtl=60（最小 30），所以改 KV 后最多 ~60 s 生效——这是回滚的真实时延，写进 RUNBOOK。
 *
 * 必须人工替换的值：见同目录 wrangler.toml 里的 <REPLACE_ME:...>；本文件无需改动。
 */

export interface Env {
	/** R2 桶 bianfa-releases（binding；latest.json 与安装包都在这里）。Worker 只调 get()，不写 */
	RELEASES: R2Bucket;
	/** KV：KILL_SWITCH / ROLLOUT_PERCENT / ROLLOUT_PERCENT:<channel> / ROLLOUT_SALT */
	ROLLOUT: KVNamespace;
	/** 默认渠道，wrangler.toml [vars]，例：stable */
	DEFAULT_CHANNEL: string;
	/** 允许的渠道，逗号分隔，例：stable,beta */
	ALLOWED_CHANNELS: string;
	/** latest.json 在桶内的前缀，例：releases → releases/stable/latest.json */
	MANIFEST_PREFIX: string;
	/** KV 边缘缓存秒数（≥30），例：60 */
	KV_CACHE_TTL: string;
}

/** Tauri updater.rs 里 updater_os() / updater_arch() 的全部取值 */
const TARGETS = new Set(["windows", "darwin", "linux"]);
const ARCHS = new Set(["x86_64", "aarch64", "i686", "armv7", "riscv64"]);

const INSTALL_ID_HEADER = "x-bianfa-install-id";
const CHANNEL_HEADER = "x-bianfa-channel";
/** 第 17 章 #28：分桶 = murmur3(install_id + flag_key) % 100；updater 的 flag_key 固定为 "updater" */
const FLAG_KEY = "updater";
/** 没带 Install-Id 的客户端固定落在最后一个桶 */
const FALLBACK_BUCKET = 99;
/** KV cacheTtl 的平台下限（kv/platform/limits：Minimum cacheTtl 30 seconds） */
const KV_CACHE_TTL_MIN = 30;

type Decision =
	| "serve"
	| "kill-switch"
	| "not-in-rollout"
	| "up-to-date"
	| "no-manifest"
	| "manifest-invalid"
	| "no-platform"
	| "control-plane-error";

interface ManifestPlatform {
	url: string;
	signature: string;
}

interface Manifest {
	version: string;
	notes?: string;
	pub_date?: string;
	platforms: Record<string, ManifestPlatform>;
}

// ---------------------------------------------------------------------------
// MurmurHash3 x86_32（与客户端 flags.json 分桶必须逐 bit 一致；测试向量见文件末尾注释，2026-09-05 在 Node 22 实测通过）
// ---------------------------------------------------------------------------
export function murmur3_32(input: string, seed = 0): number {
	const bytes = new TextEncoder().encode(input);
	const len = bytes.length;
	const nblocks = len >>> 2;
	const c1 = 0xcc9e2d51;
	const c2 = 0x1b873593;
	let h1 = seed >>> 0;

	for (let i = 0; i < nblocks; i++) {
		const j = i * 4;
		let k1 = (bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24)) >>> 0;
		k1 = Math.imul(k1, c1);
		k1 = ((k1 << 15) | (k1 >>> 17)) >>> 0;
		k1 = Math.imul(k1, c2);
		h1 = (h1 ^ k1) >>> 0;
		h1 = ((h1 << 13) | (h1 >>> 19)) >>> 0;
		h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
	}

	const tail = nblocks * 4;
	const rem = len & 3;
	if (rem > 0) {
		let k1 = 0;
		if (rem >= 3) k1 ^= bytes[tail + 2] << 16;
		if (rem >= 2) k1 ^= bytes[tail + 1] << 8;
		k1 ^= bytes[tail];
		k1 = Math.imul(k1 >>> 0, c1);
		k1 = ((k1 << 15) | (k1 >>> 17)) >>> 0;
		k1 = Math.imul(k1, c2);
		h1 = (h1 ^ k1) >>> 0;
	}

	h1 = (h1 ^ len) >>> 0;
	h1 ^= h1 >>> 16;
	h1 = Math.imul(h1, 0x85ebca6b) >>> 0;
	h1 ^= h1 >>> 13;
	h1 = Math.imul(h1, 0xc2b2ae35) >>> 0;
	h1 ^= h1 >>> 16;
	return h1 >>> 0;
}

/** 与第 17 章 #28 完全相同的分桶函数：murmur3(install_id + flag_key [+ salt]) % 100 */
export function rolloutBucket(installId: string, flagKey: string, salt: string): number {
	return murmur3_32(`${installId}${flagKey}${salt}`) % 100;
}

// ---------------------------------------------------------------------------
// 最小 SemVer 比较（与 Rust semver crate 的排序一致：先 major.minor.patch，再 prerelease；无 prerelease > 有）
// ---------------------------------------------------------------------------
interface SemVer {
	major: number;
	minor: number;
	patch: number;
	pre: string[];
}

const SEMVER_RE =
	/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(raw: string): SemVer | null {
	const m = SEMVER_RE.exec(raw.trim());
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
		pre: m[4] ? m[4].split(".") : [],
	};
}

function comparePre(a: string, b: string): number {
	const an = /^\d+$/.test(a);
	const bn = /^\d+$/.test(b);
	if (an && bn) return Math.sign(Number(a) - Number(b));
	if (an) return -1; // 数字标识符 < 字母标识符
	if (bn) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** 返回 <0 / 0 / >0 */
export function compareSemver(a: SemVer, b: SemVer): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	if (a.patch !== b.patch) return a.patch - b.patch;
	if (a.pre.length === 0 && b.pre.length === 0) return 0;
	if (a.pre.length === 0) return 1;
	if (b.pre.length === 0) return -1;
	const n = Math.min(a.pre.length, b.pre.length);
	for (let i = 0; i < n; i++) {
		const c = comparePre(a.pre[i], b.pre[i]);
		if (c !== 0) return c;
	}
	return a.pre.length - b.pre.length;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const BASE_HEADERS: Record<string, string> = {
	// 灰度决策是按 install 做的，任何一层缓存都会把 A 的决策发给 B
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
};

function noUpdate(decision: Decision, extra: Record<string, string> = {}): Response {
	return new Response(null, {
		status: 204,
		headers: { ...BASE_HEADERS, "x-bianfa-update": decision, ...extra },
	});
}

function problem(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8" },
	});
}

function pickChannel(req: Request, env: Env): string {
	const allowed = new Set(
		(env.ALLOWED_CHANNELS ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
	const requested = (req.headers.get(CHANNEL_HEADER) ?? "").trim().toLowerCase();
	return requested && allowed.has(requested) ? requested : env.DEFAULT_CHANNEL;
}

function readInstallId(req: Request): string | null {
	const v = (req.headers.get(INSTALL_ID_HEADER) ?? "").trim();
	// 只接受可打印 ASCII、≤ 64 字节；其它一律当作没带
	return v.length > 0 && v.length <= 64 && /^[\x21-\x7e]+$/.test(v) ? v : null;
}

function parsePercent(v: string | null | undefined): number | null {
	if (v == null) return null;
	const n = Number(v.trim());
	if (!Number.isInteger(n) || n < 0 || n > 100) return null;
	return n;
}

function isManifest(x: unknown): x is Manifest {
	if (typeof x !== "object" || x === null) return false;
	const m = x as Record<string, unknown>;
	if (typeof m.version !== "string") return false;
	if (typeof m.platforms !== "object" || m.platforms === null) return false;
	for (const p of Object.values(m.platforms as Record<string, unknown>)) {
		if (typeof p !== "object" || p === null) return false;
		const pp = p as Record<string, unknown>;
		if (typeof pp.url !== "string" || typeof pp.signature !== "string") return false;
	}
	return true;
}

/** Tauri 的查找顺序是 `{os}-{arch}-{installer}` → `{os}-{arch}`；这里只要任一存在就算有该平台 */
function hasPlatform(manifest: Manifest, target: string, arch: string): boolean {
	const prefix = `${target}-${arch}`;
	return Object.keys(manifest.platforms).some((k) => k === prefix || k.startsWith(`${prefix}-`));
}

/** `releases` / `/releases/` / `` 都规整成不带首尾斜杠的前缀；空前缀 → 直接 `{channel}/latest.json` */
function manifestKey(prefix: string, channel: string): string {
	const p = (prefix ?? "").replace(/^\/+|\/+$/g, "");
	return p ? `${p}/${channel}/latest.json` : `${channel}/latest.json`;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === "/healthz") {
			return new Response("ok", { headers: { ...BASE_HEADERS, "content-type": "text/plain" } });
		}

		if (req.method !== "GET" && req.method !== "HEAD") {
			return problem(405, "method not allowed");
		}

		// /{target}/{arch}/{current_version}
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length !== 3) return problem(404, "expected /{target}/{arch}/{current_version}");
		const [target, arch, rawVersion] = parts;
		if (!TARGETS.has(target)) return problem(404, `unknown target: ${target}`);
		if (!ARCHS.has(arch)) return problem(404, `unknown arch: ${arch}`);

		let currentVersionRaw: string;
		try {
			currentVersionRaw = decodeURIComponent(rawVersion);
		} catch {
			return problem(400, "current_version is not valid percent-encoding");
		}
		const current = parseSemver(currentVersionRaw);
		if (!current) return problem(400, `current_version is not semver: ${currentVersionRaw}`);

		const channel = pickChannel(req, env);
		const installId = readInstallId(req);
		const cacheTtl = Math.max(KV_CACHE_TTL_MIN, Number(env.KV_CACHE_TTL) || 60);

		// --- 控制面：一次 bulk get 读完所有开关（KV Free 100k 读/天，按请求数而不是键数省着用） ---
		let killSwitch: string | null;
		let percentGlobal: string | null;
		let percentChannel: string | null;
		let salt: string;
		try {
			const kv = await env.ROLLOUT.get(
				["KILL_SWITCH", "ROLLOUT_PERCENT", `ROLLOUT_PERCENT:${channel}`, "ROLLOUT_SALT"],
				{ cacheTtl },
			);
			killSwitch = kv.get("KILL_SWITCH") ?? null;
			percentGlobal = kv.get("ROLLOUT_PERCENT") ?? null;
			percentChannel = kv.get(`ROLLOUT_PERCENT:${channel}`) ?? null;
			salt = kv.get("ROLLOUT_SALT") ?? "";
		} catch (err) {
			// 读不到开关就不发更新（fail closed）：宁可晚几分钟，不可在 kill switch 状态未知时放行
			console.error(JSON.stringify({ evt: "kv_error", err: String(err) }));
			return noUpdate("control-plane-error");
		}

		if (killSwitch?.trim() === "1") {
			log({ decision: "kill-switch", channel, target, arch, current: currentVersionRaw });
			return noUpdate("kill-switch");
		}

		// --- 清单 ---
		const key = manifestKey(env.MANIFEST_PREFIX, channel);
		let manifest: Manifest;
		try {
			const obj = await env.RELEASES.get(key);
			if (!obj) {
				log({ decision: "no-manifest", channel, key });
				return noUpdate("no-manifest");
			}
			const parsed: unknown = await obj.json();
			if (!isManifest(parsed)) throw new Error("schema mismatch (need version + platforms[*].{url,signature})");
			manifest = parsed;
		} catch (err) {
			// 静默 204 而不是 5xx：坏清单不该在用户端弹错误；靠 CI 的 jq 校验 + 这里的 error 日志发现
			console.error(JSON.stringify({ evt: "manifest_invalid", key, err: String(err) }));
			return noUpdate("manifest-invalid");
		}

		const latest = parseSemver(manifest.version);
		if (!latest) {
			console.error(JSON.stringify({ evt: "manifest_invalid", key, err: `version not semver: ${manifest.version}` }));
			return noUpdate("manifest-invalid");
		}

		if (compareSemver(latest, current) <= 0) {
			log({ decision: "up-to-date", channel, target, arch, current: currentVersionRaw, latest: manifest.version });
			return noUpdate("up-to-date", { "x-bianfa-latest": manifest.version });
		}

		if (!hasPlatform(manifest, target, arch)) {
			// 例如 macOS universal 包只登记了 darwin-aarch64 而漏了 darwin-x86_64：这里 204，Tauri 端不会报 "platform not found"
			log({ decision: "no-platform", channel, target, arch, latest: manifest.version });
			return noUpdate("no-platform", { "x-bianfa-latest": manifest.version });
		}

		// --- 灰度 ---
		const percent = parsePercent(percentChannel) ?? parsePercent(percentGlobal) ?? 100;
		const bucket = installId ? rolloutBucket(installId, FLAG_KEY, salt) : FALLBACK_BUCKET;
		const inRollout = bucket < percent;

		log({
			decision: inRollout ? "serve" : "not-in-rollout",
			channel,
			target,
			arch,
			current: currentVersionRaw,
			latest: manifest.version,
			bucket,
			percent,
			hasInstallId: installId !== null,
		});

		if (!inRollout) {
			return noUpdate("not-in-rollout", {
				"x-bianfa-latest": manifest.version,
				"x-bianfa-rollout-bucket": String(bucket),
			});
		}

		// 原样转发清单（Static 形态，含全部 platforms）；不改写任何字段，签名与 url 保持 CI 写入的原文
		const body = req.method === "HEAD" ? null : JSON.stringify(manifest);
		return new Response(body, {
			status: 200,
			headers: {
				...BASE_HEADERS,
				"content-type": "application/json; charset=utf-8",
				"x-bianfa-update": "serve",
				"x-bianfa-latest": manifest.version,
				"x-bianfa-rollout-bucket": String(bucket),
			},
		});
	},
} satisfies ExportedHandler<Env>;

function log(fields: Record<string, unknown>): void {
	// 不记录 install_id 原文，只记桶号（第 17 章 #27：install_id 是匿名 ID，仍不要落到日志里）
	console.log(JSON.stringify({ evt: "update_check", ...fields }));
}

/*
 * murmur3_32 测试向量（seed 0；2026-09-05 用 Node 22 跑本文件的实现全部命中）：
 *   ""                                             → 0x00000000
 *   "hello"                                        → 0x248bfa47
 *   "The quick brown fox jumps over the lazy dog"  → 0x2e4ff723
 *   "abc"                                          → 0xb3dd93fa
 *   "abcde"                                        → 0xe89b9af6
 * 客户端 flags.json 分桶实现必须能通过同样几组向量，否则「同一批用户」的承诺不成立。
 */
