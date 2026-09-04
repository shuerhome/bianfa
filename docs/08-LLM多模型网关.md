# 第 08 章 · LLM多模型网关

> 模型核实、抽象层、BYOK、成本与安全

---

## 第 7 章：LLM 多模型接入网关

> **本章的核实边界（必读）**
> 下文所有价格、model id、SDK 版本，均在 2026-09-04 通过以下可达来源逐条核实：Anthropic 官方定价页（platform.claude.com）、LiteLLM `model_prices_and_context_window.json`（社区维护、字段带 `source` 回链官方定价页，是本次环境下唯一可达的跨厂商价格库）、npm registry、crates.io sparse index、GitHub raw。
> **本次未能直连核实的**：`platform.openai.com`、`ai.google.dev`、`api-docs.deepseek.com`、`openrouter.ai` 均被网络出口策略拦截。这些厂商的数字来自 LiteLLM 价格库（其 `source` 字段指向官方页），**上线前必须再对一次官方页**。凡是我完全找不到证据的初稿断言，本章直接删除或降级为"待核实"，不保留看起来确定的错误数字。

---

### 7.1 模型核实：四个点名模型三个坐实，一个说法需要拆开

| 用户说法 | 核实结论 | 应写进代码的 model id |
|---|---|---|
| opus 5 | ✅ 真实。$5/$25，1M 上下文，128K 最大输出 | `claude-opus-5`（**不带日期后缀**，写成 `claude-opus-5-20260401` 会 404） |
| gpt 5.6 | ✅ 存在，但是**家族名不是模型名**，必须选档 | `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna`；`gpt-5.6` 是 sol 的别名（两者价格、能力字段完全一致，仅 sol 多 `supports_computer_use`） |
| gemini 3.8 flash | ✅ 存在 | `gemini-3.8-flash` |
| deepseek v4 pro | ✅ 存在 | `deepseek-v4-pro`（Databricks 侧带 `-0813` 后缀，说明存在日期快照） |

**推翻初稿两条断言：**

1. 初稿称"`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 退役"。**未找到任何证据。** 相反，两者在价格库中仍然在册，且**不是 V4 的别名**——它们是独立的旧模型：$0.28/$0.42，131K 上下文，`deepseek-chat` 最大输出仅 8,192、`deepseek-reasoner` 65,536。真正的坑不是"退役"，而是**照抄旧教程会静默拿到一个 131K/8K 的便宜旧模型，还以为自己在用 V4**。registry 里必须写死 `deepseek-v4-pro`，并在 CI 里断言 `max_output >= 393216`。
2. 初稿称"`gemini-3.8-flash` 2026-09-02 GA"。**未找到 GA 日期证据。** 可核实的是：`gemini-3.6-flash`、`gemini-3.7-flash`、`gemini-3.8-flash` **三代价格与上下文完全相同**（$0.75/$3.75，1,048,576 in / 65,536 out）。这反而是好消息——降级到 3.7 是零成本回退，`fallback_chain` 里必须放 `gemini-3.7-flash`。

---

### 7.2 2026-09 核实后价目表（USD / 每百万 token）

初稿的 GPT-5.6 与 DeepSeek 缓存价**都是错的**，且错在会直接影响定价模型的方向上。

| 模型 | 输入 | 输出 | 缓存写 | 缓存读 | **Batch / Flex** | 上下文(in/out) | 视觉 |
|---|---|---|---|---|---|---|---|
| `claude-opus-5` | 5.00 | 25.00 | 6.25(5m)/10.00(1h) | **0.50** | **2.50 / 12.50** | 1M / 128K | ✅ |
| `claude-sonnet-5` | 2.00 | 10.00 | 2.50 / 4.00 | 0.20 | 1.00 / 5.00 | 1M / 128K | ✅ |
| `claude-haiku-4-5` | 1.00 | 5.00 | 1.25 / 2.00 | 0.10 | 0.50 / 2.50 | 200K | ✅ |
| `gpt-5.6-sol` | **4.00**（初稿写 5.00） | **20.00**（初稿写 30.00） | 5.00 | **0.40** | 2.00 / 10.00 | 922K / 128K | ✅ |
| `gpt-5.6-terra` | 2.00 | 12.00 | 2.50 | 0.20 | 1.00 / 6.00 | 922K / 128K | ✅ |
| `gpt-5.6-luna` | 0.20 | 1.20 | 0.25 | 0.02 | 0.10 / 0.60 | 922K / 128K | ✅ |
| `gemini-3.8-flash` | 0.75 | 3.75 | — | **0.075** | 0.375 / 1.875 | 1M / **64K** | ✅ 含音视频 |
| `deepseek-v4-pro` | 1.32 | 3.96 | 0 | **0.044**（初稿写 0.022） | — | 1M / 393,216 | ❌ **无** |
| `deepseek-v4-flash` | 0.44 | 1.32 | 0 | 0.014 | — | 1M / 393,216 | ❌ **无** |
| **`azure_ai/deepseek-v4-flash`** | **0.19** | **0.51** | — | 0.028 | — | 1M / 384K | ❌ |
| `azure_ai/deepseek-v4-pro` | 1.74 | **3.48** | — | 0.145 | — | 1M / 384K | ❌ |

**五个必须写进代码注释的计费事实：**

- **GPT-5.6 长上下文惩罚是真的，但基数要改**：单次输入 > 272K token，整个请求按 **2× 输入 / 1.5× 输出**计费。Sol 从 $4/$20 跳到 **$8/$30**（不是初稿的 $10/$45）。
- **Claude 全 1M 上下文无附加费**——官方定价页原文："A 900k-token request is billed at the same per-token rate as a 9k-token request."。这是"把所有便笺塞进去"类功能在 Claude 上安全、在 GPT 上危险的根本原因，是选型的硬依据。
- **Tokenizer 差异会毁掉跨厂商成本对比**：官方明确 "Claude 4.7 and later models use a newer tokenizer... produces approximately 30% more tokens for the same text"。初稿的成本表拿同一组 token 数去乘不同单价，**系统性低估 Opus 5 约 30%**。所有跨厂商成本必须按 **$/任务** 而不是 $/MTok 比较，本章下文一律给 Opus 5 乘 1.3 的 token 系数。
- **Batch 是被初稿完全漏掉的 50% 折扣**：Anthropic Batch API 输入输出双 50%（Opus 5 → $2.50/$12.50）；OpenAI 有 batch 与 flex 两档，均为 50%；Gemini batch 同样 50%。**自动打标签、周报预生成这类非实时任务走 batch，比初稿设计的"DeepSeek 谷时调度"简单一个数量级且折扣是合同条款而非时段博弈。**
- **DeepSeek 无视觉能力**（`supports_vision: false`）。初稿把 OCR 和便笺图片理解统一挂在"fast 档"上，如果 fast 档路由到 DeepSeek 会直接失败。**能力路由必须按 `capabilities` 交集而不是按 `tier` 做。**

**关于"Gemini 促销价 2027-01-01 翻倍"**：**未找到任何证据，本章删除该断言。** 反向证据倒是有一条可核实的：Claude Sonnet 5 的 $2/$10 曾公告为"introductory pricing through 2026-08-31"，原定 2026-09-01 涨到 $3/$15，**该涨价已被官方取消，介绍价转为标准价**。结论不变但理由要换——不是"某个具体日期会涨"，而是**任何模型价格都可能在任一方向变动，所以 `models.json` 的 pricing 必须是数据、credit 系数必须由它推导，而不是硬编码**（见 7.4）。

**长尾池：初稿七个里四个数字错误，逐条修正**

| 初稿写法 | 核实结果 |
|---|---|
| `grok-4.6` $2/$6, 500K, 缓存 $0.50 | ❌ 无此 id。真实：`grok-4.20`（$1.25/$2.50，1M，缓存读 $0.20，有视觉）、`grok-4-1-fast`（同价，2M） |
| Mistral Large 3 约 $2/$6 | ❌ 实为 **$0.50/$1.50**，262K，有视觉，缓存读 $0.05。价格只有初稿的 1/4，性价比被严重低估 |
| Qwen3.8-Max $2/$6 | ✅ 正确。缓存读 $0.25，991,808 上下文，131K 输出，有视觉 |
| Qwen3.7 Flash $0.03/$0.13 | ❌ 无此条目，删除 |
| Kimi K3 $3/$15 | ✅ 正确。1M 上下文，缓存读 $0.30，有视觉 |
| GLM-5.2 $1.25/$4.40 | ❌ 无此条目，删除 |
| MiniMax M3 $0.30/$1.20 | ✅ 正确。1M 上下文，128K 输出，有视觉，缓存读 $0.06 |

---

### 7.3 抽象层：三条被反驳后修正的结论

#### 反驳一：不要手写 OpenAI 兼容 adapter（推翻初稿）

初稿一边说"选 Vercel AI SDK 做内核"，一边贴了 130 行手写 SSE 帧解析 + 工具调用分片累积 + 重试的 adapter。这是**自相矛盾且是全章 bug 密度最高的代码**：SSE 分帧、`tool_calls[].index` 累积、`prompt_cache_hit_tokens` vs `cached_tokens` 的厂商差异、`[DONE]` 处理——每一条都是已经被库解决过的问题。

核实结论：**`@ai-sdk/openai-compatible@3.0.43` 存在且正是干这个的。** 手写版必须删除。

保留的自研部分只剩三样 AI SDK 不提供、且与钱和体验直接相关的东西：

```ts
// packages/llm-core/gateway.ts   —— 自研的只有这三件事
import { streamText } from 'ai';                          // ai@7.0.92
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'; // 3.0.43
import { createAnthropic } from '@ai-sdk/anthropic';       // 4.0.49

export async function* run(entry: ModelEntry, req: NormalizedRequest, signal: AbortSignal) {
  let started = false;                       // ① 首字节标志：吐字后禁止一切 fallback/重试
  const t0 = performance.now();
  const acc: TokenUsage = { input:0, output:0, reasoning:0, cacheWrite:0, cacheRead:0 };

  try {
    const res = streamText({
      model: resolve(entry), abortSignal: signal,
      maxRetries: 2,                          // 库内建：仅在首字节前生效
      messages: req.messages, system: req.system, tools: req.tools,
      providerOptions: providerOverrides(entry, req),   // ② 各家专有参数直通（见下）
    });
    for await (const part of res.fullStream) {
      if (part.type === 'text-delta' || part.type === 'reasoning-delta') started = true;
      yield part;
    }
    Object.assign(acc, normalizeUsage(entry, await res.usage));
  } finally {
    // ③ 铁律：取消 / 报错也必须落账。上游已生成的 output token 已经计费了。
    await ledger.write({ ...acc, started, ttft_ms: ..., status: signal.aborted ? 'canceled' : ... });
  }
}
```

`providerOverrides` 是抽象层的**逃生舱**，也是它唯一值得存在的理由——所有省钱开关都在这里，且都是各家专有、AI SDK 归一不掉的：

```ts
function providerOverrides(e: ModelEntry, r: NormalizedRequest) {
  switch (e.provider) {
    case 'anthropic': return { anthropic: {
      thinking: { type: 'adaptive', display: r.showReasoning ? 'summarized' : 'omitted' },
      // effort 走 output_config，不是顶层参数
      cacheControl: true,          // 断点在 system 尾部，见 7.7 prompt 排列
    }};
    case 'openai':   return { openai: { serviceTier: r.async ? 'flex' : 'auto',
                                        reasoningEffort: e.params.default_effort } };
    case 'google':   return { google: { thinkingConfig: { ... } } };
    default:         return {};
  }
}
```

#### 反驳二：Anthropic 那条链要不要退回官方 SDK（部分推翻初稿）

反方立场：AI SDK 的抽象恰好在"钱最多的地方"泄漏——`cache_control` 断点位置、`output_config.effort`、`thinking.display`、`stop_reason: "refusal"`、server-side fallback beta。这些是 Anthropic 专有语义，靠 `providerOptions` 透传等于绕过抽象层，那还不如直连。

**裁决：反方在 Anthropic 这一条上成立，其余不成立。** 修正后的结论：

> **`@anthropic-ai/sdk`（当前 0.123.0，注意仍是 0.x，minor 版本可能带破坏性变更，必须锁定精确版本）直连 Anthropic；其余全部走 AI SDK v7。** 理由：Anthropic 是唯一一家我们要用到 5 个以上专有参数的厂商，且缓存杠杆最大（Opus 5 缓存读 $0.50 = 0.1×）。为一家例外，不为四家例外。

其余三家不推翻：AI SDK 的 `usage` 归一、`AbortSignal`、工具调用累积都是净收益，且 `@ai-sdk/openai-compatible` 让"新增一家 OpenAI 兼容厂商 = `provider_endpoints` 加一行"这个目标真正成立。

#### 方案对比（修正后）

| 方案 | 运维成本 | 结论 |
|---|---|---|
| 全自研 4 套 adapter | 高：持续追 4 家 API 漂移 | ❌ 1-3 人养不起 |
| **AI SDK v7 内核 + Anthropic 官方 SDK 直连** | 低 | ✅ **选它** |
| LiteLLM proxy | 中高：额外 Python 进程 + Postgres + Redis | ❌ 我们已经有 Node/TS 栈，为一个路由层多养一套语言栈不划算。**注：初稿的"约 $200-300/月基础设施"是编的，删除——真实成本是一台已有 VPS 上多跑两个容器，钱不是理由，认知负担才是** |
| OpenRouter 全量 | 极低 | ⚠️ 只做长尾 |

不全走 OpenRouter 的理由，删掉两条不成立的、保留三条硬的：

1. **Anthropic prompt caching 断点控制必须直连。** 跨便笺问答从第二轮起省 90%，一条抵所有便利性。
2. **Gemini AI Studio 免费额度是免费层的成本底座**，走中间商拿不到。
3. **隐私与合规叙事**：便笺正文多经一跳第三方，团队版没法解释。
4. ~~"OpenRouter BYOK 收 5% 提成，每月前 100 万次请求免费或 $25,000 额度封顶"~~ ——**本次无法核实，删除具体数字**。可核实的只有：价格库里 `openrouter/anthropic/claude-opus-5` 记为 $5/$25，与直连挂牌价一致。**签约前必须自行确认 BYOK 费率与充值手续费。**
5. ~~"DeepSeek 谷时半价需要自己账号"~~ ——见 7.4 反驳三，这条前提本身被推翻。

---

### 7.4 反驳三：DeepSeek 谷时调度器，砍掉（推翻初稿核心结论）

初稿花了大量篇幅设计"批处理任务排到 DeepSeek 谷时跑"，并把"UTC 周一至周五 01:00–04:00 与 06:00–10:00 为高峰"当作事实。

**核实结果：找不到 V4 系列存在峰谷定价的任何证据**（价格库中 `deepseek-v4-pro/flash` 条目无任何 discount/off-peak 字段，而同库对 OpenAI 的 flex/batch/priority 分档建模得非常细）。这条断言**降级为待核实**。

但真正致命的是反方论据——即使谷时折扣存在：

| 方案 | 输入 | 输出 | 行内改写单次成本 | 需要的工程 |
|---|---|---|---|---|
| `deepseek-v4-flash` 直连（标准价） | 0.44 | 1.32 | $0.000616 | 账号 + 充值 |
| 同上，假设谷时半价 | 0.22 | 0.66 | $0.000308 | **+ 时区换算 + cron + 延迟队列 + 补偿重试** |
| **`azure_ai/deepseek-v4-flash`** | **0.19** | **0.51** | **$0.000248** | Azure 账号，**零调度代码** |

**同一个模型，Azure 托管版比 DeepSeek 官方标准价便宜 57%/61%，比假想中的谷时半价还便宜，而且数据不在中国境内——初稿视为硬性合规障碍的那一条同时消失了。**

裁决：**谷时调度器不进 MVP，可能永远不进。** 非实时任务走各家 Batch/Flex 档（合同折扣、无时段博弈）。DeepSeek 保留在 registry 里，但默认走哪个 endpoint 是一行配置。

**MVP 默认 fast 档：`gemini-3.8-flash`**，理由不是最便宜（它不是），而是**一个 Google 账号同时覆盖文本 + 视觉 OCR + 音频转写 + embedding**，对 1-3 人团队，供应商数量就是维护成本。预设切换触发器：**当 fast 档 COGS 超过 $1.50/付费用户/月时，把纯文本 fast 操作切到 `azure_ai/deepseek-v4-flash`**——这是 `models.json` 一行改动，零代码。

---

### 7.5 模型注册表：按能力路由，不按档位路由

`models.json` 是唯一真相源，迁移脚本同步进 DB；DB 只允许改 `enabled` / `sort_order` / `pricing`（改价、下架不发版）。相对初稿新增五个字段，每个都是上面某条核实的直接后果：

```jsonc
{
  "registry_id": "anthropic/claude-opus-5",
  "provider": "anthropic",
  "model_id": "claude-opus-5",
  "tier": "frontier",
  "capabilities": { "vision": true, "audio_in": false, "tools": true,
    "reasoning": true, "json_schema": true, "prompt_cache": true,
    "batch": true, "assistant_prefill": false,
    "mid_conversation_system": true },        // ← 新增：Sonnet 5 为 false，见 7.9
  "context_window": 1000000, "max_output": 128000,
  "pricing_usd_per_mtok": { "input": 5.0, "output": 25.0,
    "cache_write_5m": 6.25, "cache_write_1h": 10.0, "cache_read": 0.5,
    "batch_input": 2.5, "batch_output": 12.5 },            // ← 新增
  "long_context": { "threshold": null },                    // ← 新增：Claude 无惩罚；
                                                            //    gpt-5.6-* 为 {threshold:272000, in:2.0, out:1.5}
  "tokenizer_factor": 1.30,                                 // ← 新增：相对基准 tokenizer，成本预估用
  "min_cacheable_prefix": 512,                              // ← Opus5=512 / Sonnet5=1024 / Haiku4.5=4096
  "jurisdiction": "US", "retention_days": 30, "zdr": true,  // ← 新增
  "fallback_chain": ["anthropic/claude-sonnet-5", "google/gemini-3.8-flash"],
  "enabled": true, "byok_only": false, "plans": ["pro","team"], "sort_order": 10
}
```

**`credit_multiplier` 从初稿的硬编码字段改为运行时推导**——价格会变，手填的系数一定会漂：

```ts
// 1 credit ≡ $0.0005 上游成本。credit 是成本的整数化，不是"操作次数"。
const CREDIT_NANO_USD = 500_000n;
const credits = (costNanoUsd: bigint) =>
  Number((costNanoUsd + CREDIT_NANO_USD - 1n) / CREDIT_NANO_USD);   // 向上取整
```

```sql
create table model_catalog (
  registry_id   text primary key,
  provider      text not null references provider_endpoints(provider),
  model_id      text not null,
  tier          text not null,
  capabilities  jsonb not null,
  context_window int not null, max_output int not null,
  pricing       jsonb not null,
  long_context  jsonb,
  tokenizer_factor numeric(4,2) not null default 1.00,
  min_cacheable_prefix int not null default 1024,
  jurisdiction  text, retention_days int, zdr boolean not null default false,
  fallback_chain text[] not null default '{}',
  enabled boolean not null default true, byok_only boolean not null default false,
  plans text[] not null default '{free,pro,team}', sort_order int not null default 100,
  updated_at timestamptz not null default now()
);
```

**路由必须按能力交集，不按 tier**（DeepSeek 无视觉是硬约束）：

```ts
function pick(feature: Feature, plan: Plan, needs: Capability[]): ModelEntry {
  return catalog
    .filter(m => m.enabled && m.plans.includes(plan)
              && needs.every(c => m.capabilities[c])
              && m.tier === FEATURE_TIER[feature])
    .sort((a,b) => estCost(a,feature) - estCost(b,feature))[0]
    ?? catalog.find(m => m.registry_id === FEATURE_FALLBACK[feature])!;
}
```

UI 层默认只显示 4 个（每档一个 + "更多"）。功能默认档：行内改写 `fast`、跨便笺问答 `balanced`、周报/纪要 `frontier`。

---

### 7.6 Anthropic 侧的六个坑（全部经官方文档核实）

初稿列了四个，四个都对。补两个更危险的——**它们只在 fallback 发生时才暴露，本地永远测不出来**：

1. `thinking: {type:"enabled", budget_tokens: N}` 在 Opus 5 上 **400**。用 `{type:"adaptive"}` + `output_config: {effort: "low"|"medium"|"high"|"xhigh"|"max"}`。
2. **assistant prefill 已移除**（Fable 5/5.1、Opus 5/4.8/4.7/4.6、Sonnet 5/4.6 全部 400）。用 `output_config.format` 结构化输出。
3. **`stop_reason: "refusal"` 是 HTTP 200**，且 `stop_details` **仅在 refusal 时非 null**，其他 stop_reason 一律为 null——读之前必须判空。
4. Opus 5 默认 `thinking.display: "omitted"`（从 Opus 4.6 的 `"summarized"` 静默改的）。流式表现为长时间无响应后一次性出字。要展示思考过程必须显式 `display: "summarized"`。
5. **【新】`fallback_chain` 上 `claude-sonnet-5` 会静默废掉两样东西**：
   - **mid-conversation system message**（`{"role":"system"}` 放进 `messages`）**Opus 5 支持，Sonnet 5 不支持**。7.10 把它当作 injection-safe 的 operator channel——fallback 后这条防线消失，而且不报错。
   - **最小可缓存前缀 Opus 5 = 512、Sonnet 5 = 1024、Haiku 4.5 = 4096**。一个精心调到 600 token 刚好在 Opus 5 命中缓存的 system 前缀，fallback 到 Sonnet 5 后**静默不缓存**（无报错，只有 `cache_creation_input_tokens: 0`）。
   → 对策：`capabilities.mid_conversation_system === false` 时降级为末尾 text block；system 前缀长度按**链上所有模型的 max(min_cacheable_prefix)** 对齐（本例 4096）。
6. **服务端 fallback 可以直接白嫖**：`betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"`，按 refusal 类别路由，省掉自己维护模型列表。这是处理 refusal 的正确方式，不是自己换模型（自己换 = 欺骗用户）。

**SDK 默认值（核实自官方 TS SDK 文档，会影响你的重试设计）**：默认重试 **2 次**（408/409/429/≥500/连接错误）；默认超时 **10 分钟**，非流式且 `max_tokens` 大时按 `(3600 × maxTokens)/128000` 秒动态放大至最多 60 分钟；**超时也会被重试**，所以最坏墙钟 = `timeout × 3`。每个响应带 `_request_id`（来自 `request-id` 头）——**这个必须进 ledger**，是找 Anthropic 支持时唯一的凭据。

---

### 7.7 BYOK vs 平台 Key、密钥存储（修正两处不实断言）

三条并行路径（保留初稿结论，理由重写）：

- **Path A · 云代理 + 平台 Key（默认）**：免费层 100 credits/月，只开 `fast` 档。
- **Path B · 云代理 + 用户 Key（服务端加密）**：不计 credit，我们仍做审计、限流、RAG、fallback。
- **Path C · 本地直连隐私模式**：key 存 OS keychain，**Rust 侧 `reqwest` 0.13.4 直接发请求**。

**为什么必须由 Rust 发请求**——初稿的理由（`anthropic-dangerous-direct-browser-access` 头）**在当前官方文档中查无此项，删除**。换成可核实的、更强的理由，官方 TS SDK 文档原文：

> "Web browsers: disabled by default to avoid exposing your secret API credentials... Enable browser support by explicitly setting `dangerouslyAllowBrowser` to `true`."
> 并附警告：浏览器环境下"any user with access to the browser can potentially inspect, extract, and misuse these credentials"。

Tauri 的 webview 就是浏览器上下文。厂商自己把这条路默认关掉并命名为 `dangerously*`，答案已经写在参数名里。走 Rust 侧则 key 从不进入 JS 上下文，XSS 偷不到。

**本地 Key 存储：推翻初稿选型。**

| 初稿说法 | 核实结果 |
|---|---|
| "用 `tauri-plugin-keyring`" | ⚠️ **该 crate 只有 0.1.0 一个版本，且不在 Tauri 官方 plugins-workspace 列表里**。给一个要存 API key 的桌面应用押注单版本第三方插件，风险远大于收益 |
| "不要用 Stronghold——官方已标记弃用，v3 移除" | ❌ **未找到任何弃用证据**。`tauri-plugin-stronghold` 是官方 plugins-workspace 成员，当前 **2.3.2**，近期仍在发版，README 无弃用声明 |

**修正结论：两个 Tauri 插件都不用，Rust 侧直接依赖 `keyring = "4.2"`**（crates.io 76 个发布版本，成熟）。既然 Path C 的 HTTP 请求本来就在 Rust 侧发，key 也就没有任何理由穿到 JS 层——中间那个插件（连同它的 JS 绑定和 capability 配置）纯属多余的攻击面。落到 Windows Credential Manager / macOS Keychain / Linux Secret Service。

**服务端（Path B）**：envelope encryption。每条 key 独立 DEK（AES-256-GCM），DEK 由 KEK 包裹。Hostinger VPS 无云 KMS，v1 用 systemd `LoadCredentialEncrypted=` 注入 KEK，落库存 `key_ciphertext, dek_wrapped, nonce, key_last4, key_sha256_prefix`。**明文 key 只存在于单次请求的内存生命周期内，绝不写日志、绝不进 APM。**

**成本核算（按 7.2 修正价 + Opus 5 × 1.30 tokenizer 系数重算）**

| 操作 | 占比 | in/out | `azure ds-flash` | `gemini-3.8-flash` | `claude-opus-5`(×1.3) |
|---|---|---|---|---|---|
| 行内改写 | 70% | 500/300 | $0.000248 | $0.0015 | $0.0130 |
| 跨便笺问答 | 20% | 12K/800 | $0.00269 | $0.0120 | $0.104（缓存命中 90% 后 **$0.041**） |
| 周报/纪要 | 10% | 60K/2K | $0.0124 | $0.0525 | $0.455（**Batch 档 $0.228**） |

日均 8 次的活跃用户（240 次/月）：`azure ds-flash` ≈ **$0.47/月**；`gemini-3.8-flash` ≈ **$2.09/月**。

**初稿的 "$0.55/月" 和 "Pro ¥29 给 3000 credits ≈ $1.5 成本" 在 credit 定义为"操作次数"时是崩的**：若 fast 档是 gemini，3000 次轻量操作 = $4.50 成本 > ¥29 售价。这正是把 credit 挂钩成本而非次数的原因：

- **1 credit ≡ $0.0005 上游成本（向上取整）。**
- 免费层 **100 credits/月**（≈ $0.05 成本；azure ds-flash 下约 200 次改写，gemini 下约 33 次）。
- Pro ¥29（≈$4.05）给 **3000 credits = $1.50 成本硬上限**。扣支付通道约 3%，满额消耗时毛利 ≈ **62%**，实际大多数用户跑不满。
- **一次 Opus 5 周报 = $0.455 = 910 credits**，占 Pro 月额度近 1/3。这个数字本身就是"frontier 不进免费层"的论证，比初稿的 $0.35 更有说服力。

---

### 7.8 产品形态与 RAG（修正三处低估）

功能优先级维持初稿排序（浮动菜单 → 斜杠命令 → 提取待办 → ghost text → 周报 → 打标签 → 跨便笺问答），三处修正：

- **待办提取必须用 structured output**（`output_config.format` / `json_schema` + `strict:true`），不要吐 Markdown 再正则解析。
- **语音转写**：初稿的 `gpt-4o-transcribe` **已带 deprecation_date 2027-02-26**，不要作为新代码的默认。可核实的替代：`gpt-transcribe` 按 **$0.000075/秒 = $0.0045/分钟 = $0.27/小时**；`gemini-3.5-transcribe` 按 token 计（音频输入 $2/MTok、输出 $12/MTok）。**初稿的 WER 4.1% vs 5.3% 无来源，删除。**
- **OCR**：`gemini-3.8-flash` 的 `supported_modalities` 含 `image` 与 `audio`，一个模型同时吃下 OCR 和 ASR——这是选它做 MVP fast 档的第二个理由。但**中文手写准确率必须上线前实测**，无现成数据。

**RAG 分三阶段，MVP 不上向量库**（结论维持，参数修正）：

- **Phase 1（MVP）**：SQLite **FTS5 内置 `trigram` tokenizer**（SQLite ≥ 3.34 自带，对 CJK 可用）+ 标签/时间过滤 → 召回 top 30–50 张（约 1 万 token）→ 送模型。**不需要初稿说的第三方 `simple` tokenizer 或 jieba 扩展**，零额外基础设施。gemini-3.8-flash 下单次问答约 $0.0075。
- **Phase 2（单用户 > 2000 张便笺）**：加 `sqlite-vec` 与 FTS5 做 hybrid（RRF 融合）。**风险披露：`sqlite-vec` 当前稳定版 0.1.9，最新为 0.1.10-alpha.4，仍是 pre-1.0**，schema 与 API 可能不兼容变更，必须锁版本并留导出路径。
- **Phase 3（团队共享空间）**：服务端 `pgvector` + `gemini-embedding-001`（$0.15/MTok，5000 张便笺全量建索引 ≈ $0.23）。**两个初稿漏掉的硬约束**：`gemini-embedding-001` 的 `max_input_tokens` 仅 **2048**（长便笺必须切块），且已标注 **deprecation_date 2028-05-14**。可选替代 `gemini-embedding-2`：$0.20/MTok、**8192 token 上下文**、且支持图片/音频/视频输入——对含图便笺是更合适的选择。

**本地 embedding 的打包体积——初稿严重低估**：`bge-m3` 基于 XLM-RoBERTa-large，约 **5.68 亿参数**（仅 embedding 矩阵就是 250,002 × 1024 ≈ 2.56 亿）。int8 量化后权重量级约 **550 MB**，不是初稿说的 200MB。**结论：本地 embedding 模型绝对不能打进安装包**，只能"首次使用语义搜索时按需下载"，或改用参数量小一个数量级的多语言模型。这条直接影响 Phase 2 的产品设计（需要一个下载进度 UI 和失败降级回 FTS5 的路径）。

选型结论不变：**本地 `sqlite-vec` + 按需下载的 ONNX embedding（`fastembed` 6.0.2 / `ort` 2.0.0-rc.13，注意 ort 仍是 RC）；服务端 `pgvector` + `gemini-embedding-2`。** 本地不用 pgvector（桌面应用不能跑 Postgres 守护进程）；服务端不用 sqlite-vec（多写入并发下 SQLite 会锁）。

---

### 7.9 工程细节

**流式链路：SSE，请求由 Rust 发起，`Channel<T>` 推给 webview**（结论维持）。三个理由：隐私模式必须走 Rust；便笺窗口失焦/关闭时请求不中断、结果照样落库；`Channel` 比 `emit` 快（`emit` 走 JSON 广播）。

nginx / Cloudflare 前必须三件套，缺一个流就会被攒成一坨，且**本地开发环境完全复现不出来**：

```nginx
proxy_buffering off;
proxy_cache off;
add_header X-Accel-Buffering no;
```
外加**每 15 秒发一个 SSE 注释心跳 `:\n\n`**，防止中间层按空闲超时掐连接。

```rust
#[tauri::command]
async fn llm_stream(app: AppHandle, req_id: String, payload: LlmRequest,
                    on_event: Channel<LlmEvent>) -> Result<(), String> {
    let token = CancellationToken::new();                 // tokio-util 0.7.19
    app.state::<InFlight>().insert(req_id.clone(), token.clone());
    let r = run_stream(payload, on_event, token).await;
    app.state::<InFlight>().remove(&req_id);              // 必须在 finally 语义里
    r.map_err(|e| e.to_string())
}
#[tauri::command]
fn llm_cancel(app: AppHandle, req_id: String) {
    if let Some(t) = app.state::<InFlight>().take(&req_id) { t.cancel(); }
}
```
版本锁定：`tauri = "2.11"`、`reqwest = "0.13"`（注意不是 0.12）、`tokio-util = "0.7"`、`keyring = "4.2"`。

**上下文长度管理**：按功能设 input budget（行内改写 8K / 跨便笺问答 60K / 周报 120K）。**超预算时截断"便笺条数"而不是"单张便笺的内容"**——截断单张会丢结构，产出质量断崖下跌。截断后 UI 必须明示"已基于最近 47 张便笺回答"。精确 token 用 `POST /v1/messages/count_tokens`；客户端预估用 `中文 ≈ 1.5 字符/token`，**再乘 `tokenizer_factor`**（Claude 4.7+ 约 1.3）。

**并发限流**：三层令牌桶（per-user / per-org / per-provider-key），Redis Lua 实现。per-provider-key 那层是为了不触发上游 429——上游封了是全站故障，比单用户被限严重得多。

**usage ledger**（相对初稿新增 4 列）：

```sql
create table ai_usage (
  id bigserial primary key,
  request_id      uuid not null unique,
  upstream_request_id text,          -- ← 新增：Anthropic 的 _request_id，报障唯一凭据
  user_id uuid not null, org_id uuid,
  feature         text not null,     -- 'rewrite'|'todo'|'ask'|'weekly'|'ocr'|'asr'
  registry_id     text not null,     -- 请求时选的模型
  upstream_model  text not null,     -- 实际命中的（fallback 后可能不同）
  key_source      text not null,     -- 'platform'|'byok_server'|'byok_local'
  service_tier    text not null default 'standard',  -- ← 新增 'batch'|'flex'|'priority'
  long_context_hit boolean not null default false,   -- ← 新增：是否触发 >272K 惩罚
  input_tokens int not null default 0, output_tokens int not null default 0,
  reasoning_tokens int not null default 0,
  cache_write_tokens int not null default 0, cache_read_tokens int not null default 0,
  cost_nano_usd   bigint not null default 0,   -- 纳美元整数，禁用浮点
  billed_credits  int not null default 0,
  ttft_ms int, latency_ms int,
  status text not null,              -- 'ok'|'canceled'|'error'|'refused'
  error_code text, refusal_category text,      -- ← 新增：stop_details.category
  fallback_from text,
  created_at timestamptz not null default now()
);
create index on ai_usage (user_id, created_at desc);
create index on ai_usage (org_id, created_at desc);
```

用 `bigint` 纳美元而非 `float`：Luna 缓存读 $0.02/M = 2×10⁻⁸ USD/token，浮点累加百万次的误差会吃掉利润。**表里绝不存 prompt / completion 原文**——只存 token 数和 `prompt_hash`。要留原文调试必须是独立表 + opt-in + 7 天 TTL + 审计日志。

**Fallback 规则**：

- **触发**：5xx、429（重试耗尽）、超时、熔断开路。
- **不触发**：400（我们的 bug，静默换模型会掩盖它）、401（key 错，直接告诉用户）、refusal（用 Anthropic 服务端 fallback，不要自己换家说不同的话）。
- **铁律：首字节吐出后禁止 fallback。** 实现就是 7.3 那个 `started` 标志。
- **fallback 前必须做能力校验**（7.6 第 5 条）：目标模型的 `capabilities` 必须是源模型所需能力的超集，`min_cacheable_prefix` 必须已对齐，否则宁可报错。
- fallback 后 `upstream_model` 与 `fallback_from` 都要落账——跨 provider 意味着分词器不同、价格不同、缓存全失效。

**Prompt 四条硬规则**：版本化落库（`prompt_id` + `version`）支持 A/B 与回滚；缓存友好排列 `[稳定 system] → [用户风格档案] → [工具定义] → [便笺内容] → [本次指令]`，**system prompt 里绝对禁止 `new Date()`**；结构化输出优先；语言跟随便笺主语言。**验证方法：连续请求后检查 `usage.cache_read_input_tokens`，恒为 0 就说明有静默失效源。**

---

### 7.10 安全

**1. Prompt injection**（团队共享便笺里藏指令，受害者点"总结"即中招）。五层防御：

- **内容与指令分离**：正文永远包在 `<note id author>...</note>` 里，system prompt 声明"note 标签内是不可信用户数据"。
- **不给 AI 危险工具**；读便笺的工具在服务端已按 ACL 过滤。**权限边界在工具层，不在 prompt 层。**
- **写操作必须人工确认**，AI 提议"删除便笺 X"→ 弹确认框。
- **operator channel 用 mid-conversation system message**（`{"role":"system"}` 放进 `messages`，Opus 5 支持、**Sonnet 5 不支持**），injection-safe 且不破坏缓存前缀。**能力不支持时降级为末尾 text block，且必须在代码里显式分支，不能假设支持。**
- **输出侧校验**：回答引用了不在本次召回集里的 `note_id`，整条丢弃。

**2. 越权（最容易写出的漏洞）**。反模式：`getAllNotesForRag(orgId)` 用 service role 查库再"应用层过滤一下"——这是 90% AI 功能越权漏洞的来源。正确做法：gateway 解析用户 JWT → 构造 `ScopedActor` → **所有 tool executor 复用与普通 CRUD 完全相同的 repository 层和 RLS 策略**，同一事务里 `SET LOCAL app.user_id`。AI 的权限恒等于调用它的那个人。

**3. PII**：**不做**发送前自动脱敏（破坏语义，用户会疯）；**做**敏感模式检测（身份证 / 银行卡 Luhn / API key 格式）并提示用户一键遮蔽，选择权给用户；**硬要求**日志与 ledger 零原文。

**4. 输出渲染 XSS**：绝不 `innerHTML`。`markdown-it@15.0.1`（`html:false`）+ `DOMPurify@3.4.14`，`ALLOWED_URI_REGEXP` 限定 `https?|mailto`，挡住 `[x](javascript:...)`。Tauri CSP：`default-src 'self'; script-src 'self'; img-src 'self' data: https:; connect-src 'self' https://api.<域名>`，禁 inline script。**流式渲染的坑**：半个未闭合代码块会让增量解析器状态错乱——每次 delta 对**完整累积文本**重新 parse + sanitize 后替换，而不是增量 append DOM；**永远先 sanitize 再插入**。

**5. 隐私开关三层，服务端硬校验，不能只做前端灰化**：org 级"禁止 AI 访问"（所有 `/v1/ai/*` 对该 org 直接 403）；note 级 `ai_excluded`（永不进入任何 prompt，含 RAG 召回与周报聚合）；模型选择器旁显示数据流向（`claude-opus-5 · 数据发送至 Anthropic（美国）· 留存 30 天`、`deepseek-v4-pro · 中国境内` / `azure_ai/deepseek-v4-pro · 美国`）。首次启用 AI 显式同意，consent 落库（条款版本 + 时间戳 + IP）。

**6. ZDR 与数据驻留（核实修正）**：初稿称"Claude Fable 5.1 强制 30 天留存、不支持 ZDR"——**核实成立**（ZDR 组织调用返回 `400 invalid_request_error`，除非 Anthropic 明确授权）。但对我们更相关的是它**不在我们的默认模型池里**。真正要写进 registry 的是另一条可核实事实：**Claude 4.6 及以后支持 `inference_geo: "us"` 强制美国境内推理，代价是所有 token 价格 1.1×**（OpenAI 侧同样有 `regional_processing_uplift_multiplier_us/eu = 1.1`）。这是团队版合规叙事里唯一一个"花钱就能买到"的开关，应作为 org 级设置暴露，并把 1.1× 写进 credit 计算。

---

> 所有价格与 model id 核实于 2026-09-04，来源见章首"核实边界"。这个领域三个月过时一轮：`models.json` 的 pricing 字段必须设季度复核提醒，并在启动时用 Anthropic `GET /v1/models`（返回 `max_input_tokens` / `max_tokens` / `capabilities`——**注意没有 `context_window` 字段**）做运行时校验，发现漂移直接告警而不是静默继续。