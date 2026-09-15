/**
 * Catalog -> pi `Model` conversion.
 *
 * Two things happen here that pi cannot infer for an unlisted provider:
 *
 *  1. Currency. SiliconFlow's .cn endpoint bills in CNY; pi's `ModelCost` is
 *     USD per million tokens. We convert at a documented rate, overridable via
 *     `SILICONFLOW_CNY_PER_USD` because FX drifts and nobody should have to
 *     patch source to keep cost reports honest.
 *
 *  2. Request shape. `api.siliconflow.cn` matches none of pi's auto-detection
 *     rules, so the auto-detected defaults would be wrong in four places that
 *     break or silently degrade requests. Every flag below is set deliberately.
 */

import type { Model, ModelCost, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { CATALOG, type CatalogEntry, type CnyPrice, type CnyTier } from "./catalog.ts";

export const PROVIDER_ID = "siliconflow";
export const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";

/**
 * CNY per 1 USD. Mid-market rate on 2026-09-15 (open.er-api.com).
 * pi's own built-in China providers use ~6.8, so this is in-family.
 */
export const DEFAULT_CNY_PER_USD = 6.7252;

/** Precision for converted USD rates: enough that a ¥0.01 cache tier stays non-zero. */
const USD_DECIMALS = 1e6;

export function cnyPerUsd(env: (name: string) => string | undefined = (n) => process.env[n]): number {
  const raw = env("SILICONFLOW_CNY_PER_USD");
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CNY_PER_USD;
}

export function cnyToUsd(cny: number, rate: number): number {
  return Math.round((cny / rate) * USD_DECIMALS) / USD_DECIMALS;
}

function toCost(cny: CnyPrice, tiers: readonly CnyTier[] | undefined, rate: number): ModelCost {
  const cost: ModelCost = {
    input: cnyToUsd(cny.input, rate),
    output: cnyToUsd(cny.output, rate),
    cacheRead: cnyToUsd(cny.cacheRead, rate),
    // SiliconFlow publishes no cache-write price; cached input is billed as cacheRead.
    cacheWrite: 0,
  };
  if (tiers?.length) {
    cost.tiers = [...tiers]
      .sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)
      .map((tier) => ({
        inputTokensAbove: tier.inputTokensAbove,
        input: cnyToUsd(tier.input, rate),
        output: cnyToUsd(tier.output, rate),
        cacheRead: cnyToUsd(tier.cacheRead, rate),
        cacheWrite: 0,
      }));
  }
  return cost;
}

/**
 * Compatibility flags for the SiliconFlow gateway.
 *
 * Each line exists because pi's URL-based auto-detection classifies
 * `api.siliconflow.cn` as a vanilla OpenAI endpoint, which it is not:
 *
 *  - maxTokensField    the API reference documents `max_tokens`, not
 *                      `max_completion_tokens` (the auto-detected default).
 *  - thinkingFormat    SiliconFlow toggles reasoning with a top-level
 *                      `enable_thinking` boolean, which is pi's "qwen" shape.
 *                      The auto-detected "openai" shape would never enable it,
 *                      and "deepseek" would send an undocumented `thinking` object.
 *  - supportsDeveloperRole  only `system` / `user` / `assistant` / `tool` appear in
 *                      the reference; the auto-detected `developer` role is not.
 *  - supportsStrictMode     every model spec page reports
 *                      "Structured Outputs: Not supported".
 *  - supportsStore / supportsLongCacheRetention / supportsOpenAIGrammarTools
 *                      `store`, `prompt_cache_retention` and grammar tools are
 *                      absent from the reference, so do not send them.
 *
 * Left at their (correct) auto-detected defaults: `supportsUsageInStreaming` and
 * `supportsFinishReason` — both are needed for token accounting and stop reasons.
 */
const BASE_COMPAT: OpenAICompletionsCompat = {
  maxTokensField: "max_tokens",
  thinkingFormat: "qwen",
  supportsDeveloperRole: false,
  supportsStrictMode: false,
  supportsStore: false,
  supportsLongCacheRetention: false,
  supportsOpenAIGrammarTools: false,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
};

type SiliconFlowModel = Model<"openai-completions">;

/**
 * Per-model reasoning wiring derived from the catalog's `ThinkingControl`.
 *
 * `supportsReasoningEffort` must be pinned explicitly: it auto-detects to `true`
 * for this provider, which would make pi send `reasoning_effort: "medium"` (pi's
 * own level name) to models that only understand `enable_thinking`.
 */
function thinkingCompat(entry: CatalogEntry): {
  reasoning: boolean;
  compat: OpenAICompletionsCompat;
  thinkingLevelMap?: SiliconFlowModel["thinkingLevelMap"];
} {
  switch (entry.thinking.kind) {
    case "none":
      return { reasoning: false, compat: { supportsReasoningEffort: false } };
    case "toggle":
      return {
        reasoning: true,
        compat: {
          supportsReasoningEffort: false,
          // `thinking_budget` caps the chain of thought so a long reasoning turn
          // cannot eat the whole `max_tokens` and emit no answer.
          thinkingTokenBudgetField: entry.thinking.budget ? "thinking_budget" : undefined,
        },
      };
    case "effort":
      return {
        reasoning: true,
        compat: { supportsReasoningEffort: true },
        thinkingLevelMap: entry.thinking.levels,
      };
    case "always":
      // Chain of thought is not switchable, so hide "off" from the level picker.
      return {
        reasoning: true,
        compat: { supportsReasoningEffort: false },
        thinkingLevelMap: { off: null },
      };
  }
}

export function entryToModel(
  entry: CatalogEntry,
  baseUrl: string,
  rate: number,
): SiliconFlowModel {
  const { reasoning, compat, thinkingLevelMap } = thinkingCompat(entry);
  const model: SiliconFlowModel = {
    id: entry.id,
    name: entry.name,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    reasoning,
    input: entry.input,
    cost: toCost(entry.cny, entry.cnyTiers, rate),
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    compat: { ...BASE_COMPAT, ...compat },
  };
  if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
  return model;
}

/**
 * Conservative shape for a model that live discovery returned but the catalog
 * does not know yet. Cost stays zero so pi reports $0.00 rather than a invented
 * number, and the context window is small enough that compaction fires early
 * instead of overflowing.
 */
export const UNKNOWN_MODEL_DEFAULTS = {
  contextWindow: 32_768,
  maxTokens: 4_096,
} as const;

export function unknownModelToModel(id: string, baseUrl: string): SiliconFlowModel {
  return {
    id,
    name: id.slice(id.indexOf("/") + 1),
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: UNKNOWN_MODEL_DEFAULTS.contextWindow,
    maxTokens: UNKNOWN_MODEL_DEFAULTS.maxTokens,
    compat: { ...BASE_COMPAT, supportsReasoningEffort: false },
  };
}

export function buildModels(baseUrl: string, rate: number = cnyPerUsd()): SiliconFlowModel[] {
  return CATALOG.map((entry) => entryToModel(entry, baseUrl, rate));
}
