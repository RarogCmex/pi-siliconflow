/**
 * Curated SiliconFlow catalog for the China endpoint (https://api.siliconflow.cn/v1).
 *
 * Data provenance — every field below was read from a public SiliconFlow page on
 * 2026-09-15, not guessed:
 *
 *   ids + `cny` prices  https://siliconflow.cn/pricing
 *                       ("实时价格同步", CNY per 1M tokens, live-scraped row by row)
 *   contextWindow,
 *   maxTokens, `input`  https://www.siliconflow.com/models/<slug>
 *                       per-model "Specification" block (Context length / Max Tokens /
 *                       Support image input). Specs are model-intrinsic, so the
 *                       international site is a valid source for the .cn endpoint.
 *
 * Models are omitted on purpose:
 *   - `State: Deprecated` on the spec page (GLM-4.5V, GLM-4-32B-0414, Ling-mini-2.0)
 *   - `Tools: Not supported` (tencent/Hunyuan-A13B-Instruct) — unusable for an agent
 *   - non-chat modalities (embeddings, rerankers, image, audio, video, OCR)
 *   - listed for sale on .cn but with no public spec page (Qwen/Qwen3.8-27B,
 *     tencent/Hy4-preview). Live discovery still surfaces them with safe defaults.
 *
 * Prices are kept in CNY because that is what the .cn endpoint bills in; `models.ts`
 * converts to the USD-per-million that pi's `ModelCost` expects.
 */

import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

/** CNY per 1M tokens. `cacheRead` is SiliconFlow's 缓存价格 column; 0 when "-" (no cache tier). */
export interface CnyPrice {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * A priced input-size band. SiliconFlow bills the whole request at the band its
 * input token count falls into, which is exactly pi's `ModelCost.tiers` semantic
 * ("the highest matching input threshold applies to the full request").
 */
export interface CnyTier extends CnyPrice {
  inputTokensAbove: number;
}

/**
 * How a model exposes reasoning on SiliconFlow.
 *
 * The chat-completions reference documents three knobs — `enable_thinking` (bool),
 * `thinking_budget` (int) and `reasoning_effort` (string) — but individual models
 * accept only some of them, so each entry pins down exactly what to send.
 */
export type ThinkingControl =
  /** Not a reasoning model: send no thinking parameters at all. */
  | { kind: "none" }
  /** Hybrid model toggled with `enable_thinking`, optionally capped by `thinking_budget`. */
  | { kind: "toggle"; budget?: boolean }
  /** `enable_thinking` plus `reasoning_effort`, with pi's levels mapped to provider values. */
  | { kind: "effort"; levels: ThinkingLevelMap }
  /** Always-on chain of thought: thinking can be surfaced but never disabled. */
  | { kind: "always" };

export interface CatalogEntry {
  /** Exact SiliconFlow model id, including any `Pro/` production-tier prefix. */
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
  thinking: ThinkingControl;
  cny: CnyPrice;
  cnyTiers?: CnyTier[];
  /** Free-text pricing caveat surfaced in the README; pi's Model has no notes field. */
  priceNote?: string;
}

/** Context/output sizes as published, expanded from the "1049K / 393K" display form. */
const CTX_1M = 1_048_576;
const OUT_384K = 393_216;
const CTX_256K = 262_144;
const CTX_160K = 163_840;
const CTX_200K = 204_800;
const OUT_128K = 131_072;
const CTX_128K = 131_072;
const OUT_64K = 65_536;

/** GLM-5.x is "always-on reasoning" with `low` / `high` / `max` effort. */
const GLM5_EFFORT = {
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
} satisfies ThinkingLevelMap;

/** DeepSeek V4 ships exactly three modes: Non-Think, Think High, Think Max. */
const DEEPSEEK_V4_EFFORT = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
} satisfies ThinkingLevelMap;

export const CATALOG: readonly CatalogEntry[] = [
  // ── DeepSeek ────────────────────────────────────────────────────────
  {
    id: "deepseek-ai/DeepSeek-V4-Flash",
    name: "DeepSeek V4 Flash",
    contextWindow: CTX_1M,
    maxTokens: OUT_384K,
    input: ["text"],
    thinking: { kind: "effort", levels: DEEPSEEK_V4_EFFORT },
    // Off-peak 02:00–08:00 CST is half price (¥1.50 / ¥4.50 / ¥0.15). We bill the
    // standard 22-hour rate so pi never under-reports cost.
    cny: { input: 3, output: 9, cacheRead: 0.3 },
    priceNote: "half price 02:00–08:00 CST",
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Pro",
    name: "DeepSeek V4 Pro",
    contextWindow: CTX_1M,
    maxTokens: OUT_384K,
    input: ["text"],
    thinking: { kind: "effort", levels: DEEPSEEK_V4_EFFORT },
    cny: { input: 12, output: 24, cacheRead: 1 },
  },
  {
    id: "deepseek-ai/DeepSeek-V3.2",
    name: "DeepSeek V3.2",
    contextWindow: CTX_160K,
    maxTokens: CTX_160K,
    input: ["text"],
    // The reasoning guide uses exactly this model for enable_thinking + thinking_budget.
    thinking: { kind: "toggle", budget: true },
    cny: { input: 4, output: 6, cacheRead: 0.4 },
  },
  {
    id: "Pro/deepseek-ai/DeepSeek-V3.2",
    name: "DeepSeek V3.2 (Pro)",
    contextWindow: CTX_160K,
    maxTokens: CTX_160K,
    input: ["text"],
    thinking: { kind: "toggle", budget: true },
    cny: { input: 4, output: 6, cacheRead: 0.4 },
  },
  {
    id: "deepseek-ai/DeepSeek-V3.1-Terminus",
    name: "DeepSeek V3.1 Terminus",
    contextWindow: CTX_160K,
    maxTokens: CTX_160K,
    input: ["text"],
    thinking: { kind: "toggle", budget: true },
    cny: { input: 4, output: 12, cacheRead: 0.4 },
  },
  {
    id: "Pro/deepseek-ai/DeepSeek-V3.1-Terminus",
    name: "DeepSeek V3.1 Terminus (Pro)",
    contextWindow: CTX_160K,
    maxTokens: CTX_160K,
    input: ["text"],
    thinking: { kind: "toggle", budget: true },
    cny: { input: 4, output: 12, cacheRead: 0.4 },
  },

  // ── Z.ai / Zhipu GLM ────────────────────────────────────────────────
  {
    id: "zai-org/GLM-5.3",
    name: "GLM 5.3",
    contextWindow: CTX_1M,
    maxTokens: OUT_128K,
    input: ["text"],
    thinking: { kind: "effort", levels: GLM5_EFFORT },
    cny: { input: 8, output: 28, cacheRead: 2 },
  },
  {
    id: "zai-org/GLM-5.2",
    name: "GLM 5.2",
    contextWindow: CTX_1M,
    maxTokens: OUT_128K,
    input: ["text"],
    thinking: { kind: "effort", levels: GLM5_EFFORT },
    cny: { input: 8, output: 28, cacheRead: 2 },
  },
  {
    id: "Pro/zai-org/GLM-5.1",
    name: "GLM 5.1 (Pro)",
    contextWindow: CTX_200K,
    maxTokens: OUT_128K,
    input: ["text"],
    thinking: { kind: "effort", levels: GLM5_EFFORT },
    // Pricing page bands this model at 32k input tokens.
    cny: { input: 6, output: 24, cacheRead: 1.3 },
    cnyTiers: [{ inputTokensAbove: 32_000, input: 8, output: 28, cacheRead: 2 }],
  },
  {
    id: "zai-org/GLM-4.5-Air",
    name: "GLM 4.5 Air",
    contextWindow: CTX_128K,
    maxTokens: CTX_128K,
    input: ["text"],
    // "hybrid reasoning model providing both thinking and non-thinking mode"
    thinking: { kind: "toggle" },
    cny: { input: 1, output: 6, cacheRead: 0 },
  },

  // ── Moonshot Kimi ───────────────────────────────────────────────────
  {
    id: "moonshotai/Kimi-K2.7-Code",
    name: "Kimi K2.7 Code",
    contextWindow: CTX_256K,
    maxTokens: CTX_256K,
    input: ["text", "image"],
    // Interleaved chain of thought, always on for the K2.x agentic line.
    thinking: { kind: "always" },
    cny: { input: 6.5, output: 27, cacheRead: 1.3 },
  },
  {
    id: "Pro/moonshotai/Kimi-K2.6",
    name: "Kimi K2.6 (Pro)",
    contextWindow: CTX_256K,
    maxTokens: CTX_256K,
    input: ["text", "image"],
    thinking: { kind: "always" },
    cny: { input: 6.5, output: 27, cacheRead: 1.1 },
  },

  // ── Qwen ────────────────────────────────────────────────────────────
  {
    id: "Qwen/Qwen3.6-27B",
    name: "Qwen3.6 27B",
    contextWindow: CTX_256K,
    maxTokens: CTX_256K,
    input: ["text", "image"],
    thinking: { kind: "toggle", budget: true },
    cny: { input: 3, output: 18, cacheRead: 0 },
  },
  {
    id: "Qwen/Qwen3.6-35B-A3B",
    name: "Qwen3.6 35B A3B",
    contextWindow: CTX_256K,
    maxTokens: CTX_256K,
    input: ["text", "image"],
    thinking: { kind: "toggle", budget: true },
    cny: { input: 1.8, output: 10.8, cacheRead: 0 },
  },
  {
    id: "Qwen/Qwen3.5-122B-A10B",
    name: "Qwen3.5 122B A10B",
    contextWindow: CTX_256K,
    maxTokens: CTX_256K,
    input: ["text", "image"],
    thinking: { kind: "toggle", budget: true },
    cny: { input: 0.8, output: 6.4, cacheRead: 0 },
    cnyTiers: [{ inputTokensAbove: 128_000, input: 2, output: 16, cacheRead: 0 }],
  },
  {
    id: "Qwen/Qwen3.5-35B-A3B",
    name: "Qwen3.5 35B A3B",
    contextWindow: CTX_256K,
    maxTokens: CTX_256K,
    input: ["text", "image"],
    thinking: { kind: "toggle", budget: true },
    cny: { input: 0.4, output: 3.2, cacheRead: 0 },
    cnyTiers: [{ inputTokensAbove: 128_000, input: 1.6, output: 12.8, cacheRead: 0 }],
  },
  {
    id: "Qwen/Qwen3.5-27B",
    name: "Qwen3.5 27B",
    contextWindow: CTX_256K,
    maxTokens: CTX_256K,
    input: ["text", "image"],
    thinking: { kind: "toggle", budget: true },
    cny: { input: 0.6, output: 4.8, cacheRead: 0 },
    cnyTiers: [{ inputTokensAbove: 128_000, input: 1.8, output: 14.4, cacheRead: 0 }],
  },

  // ── Others ──────────────────────────────────────────────────────────
  {
    id: "meituan-longcat/LongCat-2.0",
    name: "LongCat 2.0",
    contextWindow: CTX_1M,
    maxTokens: OUT_128K,
    input: ["text"],
    thinking: { kind: "none" },
    cny: { input: 5, output: 20, cacheRead: 0.1 },
  },
  {
    id: "stepfun-ai/Step-3.5-Flash",
    name: "Step 3.5 Flash",
    contextWindow: CTX_256K,
    maxTokens: OUT_64K,
    input: ["text"],
    thinking: { kind: "none" },
    cny: { input: 0.7, output: 2.1, cacheRead: 0 },
  },
  {
    id: "inclusionAI/Ling-flash-2.0",
    name: "Ling Flash 2.0",
    contextWindow: CTX_128K,
    maxTokens: CTX_128K,
    input: ["text"],
    thinking: { kind: "none" },
    cny: { input: 1, output: 4, cacheRead: 0 },
  },
  {
    id: "ByteDance-Seed/Seed-OSS-36B-Instruct",
    name: "Seed OSS 36B Instruct",
    contextWindow: CTX_256K,
    maxTokens: CTX_256K,
    input: ["text"],
    thinking: { kind: "none" },
    cny: { input: 1.5, output: 4, cacheRead: 0 },
  },
];

export const CATALOG_BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(
  CATALOG.map((entry) => [entry.id, entry]),
);
