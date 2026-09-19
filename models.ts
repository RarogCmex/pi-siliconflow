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
 *
 * Mixed API is prepared (paratera-style `openai-responses` +
 * `openai-completions`) but the Responses adapter is **not** registered in the
 * live provider until `RESPONSES_ENABLED` is flipped. The public SiliconFlow
 * gateway 404s on `POST /v1/responses` (probed 2026-09-19; SiliconFlow's own
 * Codex guide says to bridge via CC Switch). Catalog/overlay stay on
 * completions. Live-discovered ids are classified by family (`guessApi` /
 * `guessThinking`) so a new Qwen3.8 lands as a hybrid reasoner instead of a
 * mute 32K text model.
 */

import type {
  Model,
  ModelCost,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
} from "@earendil-works/pi-ai";
import {
  CATALOG,
  DEEPSEEK_V4_EFFORT,
  GLM5_EFFORT,
  type CatalogEntry,
  type CnyPrice,
  type CnyTier,
  type GatewayApi,
  type ThinkingControl,
} from "./catalog.ts";

export type { GatewayApi } from "./catalog.ts";

export const PROVIDER_ID = "siliconflow";
export const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";

/**
 * Flip when SiliconFlow ships `POST /v1/responses` (they told Codex users to
 * use CC Switch as a converter, so this is currently off). While false:
 *   - the live provider does not register `openAIResponsesApi()` — a stray
 *     `api: "openai-responses"` fails closed instead of 404ing through the SDK;
 *   - `guessApi` / `buildModels` force completions.
 * Conversion, compat, family routing and tests stay in the tree so turning it
 * on is this constant plus registering the adapter.
 */
export const RESPONSES_ENABLED = false;

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
 * Compatibility flags for the SiliconFlow chat-completions gateway.
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
const CHAT_COMPAT: OpenAICompletionsCompat = {
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

/**
 * Compat for a model on `openai-responses`. Unused on the public SiliconFlow
 * gateway (POST /v1/responses → 404, 2026-09-19) but applied the moment a
 * catalog entry or overlay sets `api: "openai-responses"` — e.g. a mirror
 * that actually speaks Responses. Mirrors the chat flags: no developer role,
 * no structured outputs, no long-cache retention, no grammar tools.
 */
const RESPONSES_COMPAT: OpenAIResponsesCompat = {
  supportsDeveloperRole: false,
  supportsStrictMode: false,
  supportsLongCacheRetention: false,
  supportsOpenAIGrammarTools: false,
};

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export type SiliconFlowModel = Model<GatewayApi>;

/**
 * Per-model reasoning wiring derived from the catalog's `ThinkingControl`.
 *
 * Completions-only: `supportsReasoningEffort` must be pinned explicitly — it
 * auto-detects to `true` for this provider, which would make pi send
 * `reasoning_effort: "medium"` (pi's own level name) to models that only
 * understand `enable_thinking`. Responses uses `reasoning.effort` natively,
 * so the effort map is enough there.
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

function thinkingLevelMap(thinking: ThinkingControl): SiliconFlowModel["thinkingLevelMap"] | undefined {
  switch (thinking.kind) {
    case "effort":
      return thinking.levels;
    case "always":
      return { off: null };
    default:
      return undefined;
  }
}

export function entryToModel(
  entry: CatalogEntry,
  baseUrl: string,
  rate: number,
): SiliconFlowModel {
  const api: GatewayApi = entry.api ?? "openai-completions";
  const cost = toCost(entry.cny, entry.cnyTiers, rate);
  if (api === "openai-responses") {
    const reasoning = entry.thinking.kind !== "none";
    const model: Model<"openai-responses"> = {
      id: entry.id,
      name: entry.name,
      api,
      provider: PROVIDER_ID,
      baseUrl,
      reasoning,
      input: entry.input,
      cost,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      compat: { ...RESPONSES_COMPAT },
    };
    const map = thinkingLevelMap(entry.thinking);
    if (map) model.thinkingLevelMap = map;
    return model;
  }

  const { reasoning, compat, thinkingLevelMap: map } = thinkingCompat(entry);
  const model: Model<"openai-completions"> = {
    id: entry.id,
    name: entry.name,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    reasoning,
    input: entry.input,
    cost,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    compat: { ...CHAT_COMPAT, ...compat },
  };
  if (map) model.thinkingLevelMap = map;
  return model;
}

/**
 * Conservative shape for a model whose family we do not recognise. Cost stays
 * zero so pi reports $0.00 rather than an invented number, and the context
 * window is small enough that compaction fires early instead of overflowing.
 * Recognised families (DeepSeek V3/V4, GLM-4.5/5, Qwen 3.5+, Kimi K2) get
 * sibling defaults instead — see `guessWindows` / `guessThinking`.
 */
export const UNKNOWN_MODEL_DEFAULTS = {
  contextWindow: 32_768,
  maxTokens: 4_096,
} as const;

/** Bare model name, stripping an optional `Pro/` prefix and the vendor segment. */
export function modelName(id: string): string {
  const bare = id.replace(/^Pro\//, "");
  const slash = bare.lastIndexOf("/");
  return slash >= 0 ? bare.slice(slash + 1) : bare;
}

/** Families that speak `/responses` on other gateways (paratera). Kept so
 *  `guessApi` can route them the day `RESPONSES_ENABLED` flips; unused in the
 *  live catalog while the public SiliconFlow endpoint 404s. */
export function guessResponsesFamily(id: string): boolean {
  const name = modelName(id);
  if (/^DeepSeek-V4/i.test(name)) return true;
  if (/^GLM-5\./i.test(name)) return true;
  if (/^Qwen(?:3\.[5-9]|[4-9])/i.test(name)) return true;
  if (/^Kimi-K(?:2\.[6-9]|3)/i.test(name)) return true;
  return false;
}

/** Request surface for an unlisted id. Completions until `RESPONSES_ENABLED`. */
export function guessApi(id: string): GatewayApi {
  if (RESPONSES_ENABLED && guessResponsesFamily(id)) return "openai-responses";
  return "openai-completions";
}

/** Family-guessed thinking control for an unlisted/unprobed id. */
export function guessThinking(id: string): ThinkingControl {
  const name = modelName(id);
  if (/^DeepSeek-V4/i.test(name)) return { kind: "effort", levels: DEEPSEEK_V4_EFFORT };
  if (/^DeepSeek-V3/i.test(name)) return { kind: "toggle", budget: true };
  if (/^GLM-5/i.test(name)) return { kind: "effort", levels: GLM5_EFFORT };
  if (/^GLM-4\.5/i.test(name)) return { kind: "toggle" };
  if (/^Qwen(?:3\.[5-9]|[4-9])/i.test(name)) return { kind: "toggle", budget: true };
  if (/^Kimi-K2/i.test(name)) return { kind: "always" };
  return { kind: "none" };
}

export function guessInput(id: string): ("text" | "image")[] {
  const name = modelName(id);
  if (/^Qwen(?:3\.[5-9]|[4-9])/i.test(name)) return ["text", "image"];
  if (/^Kimi-K2/i.test(name)) return ["text", "image"];
  if (/(Vision|-VL\b|4\.5V|4\.6V|5V)/i.test(name)) return ["text", "image"];
  return ["text"];
}

export function guessWindows(id: string): { contextWindow: number; maxTokens: number } {
  const name = modelName(id);
  if (/^DeepSeek-V4/i.test(name)) return { contextWindow: 1_048_576, maxTokens: 393_216 };
  if (/^DeepSeek-V3/i.test(name)) return { contextWindow: 163_840, maxTokens: 163_840 };
  if (/^GLM-5/i.test(name)) return { contextWindow: 1_048_576, maxTokens: 131_072 };
  if (/^GLM-4\.5/i.test(name)) return { contextWindow: 131_072, maxTokens: 131_072 };
  if (/^Qwen(?:3\.[5-9]|[4-9])/i.test(name)) return { contextWindow: 262_144, maxTokens: 262_144 };
  if (/^Kimi-K2/i.test(name)) return { contextWindow: 262_144, maxTokens: 262_144 };
  return { contextWindow: UNKNOWN_MODEL_DEFAULTS.contextWindow, maxTokens: UNKNOWN_MODEL_DEFAULTS.maxTokens };
}

/**
 * Semi-dynamic registration for a gateway id this build has never seen.
 * Known families inherit sibling thinking/vision/window defaults; unknown
 * families stay conservative (32K, no thinking, zero cost). Always completions
 * on the public SiliconFlow endpoint — see `guessApi`.
 */
export function unknownModelToModel(id: string, baseUrl: string): SiliconFlowModel {
  const thinking = guessThinking(id);
  const entry: CatalogEntry = {
    id,
    name: modelName(id),
    api: guessApi(id),
    ...guessWindows(id),
    input: guessInput(id),
    thinking,
    cny: { input: 0, output: 0, cacheRead: 0 },
  };
  const model = entryToModel(entry, baseUrl, DEFAULT_CNY_PER_USD);
  // Family-guessed unknowns must not invent a price: entryToModel would convert
  // the placeholder zeros, which is fine, but pin the object so tests can
  // identity-compare against ZERO_COST.
  model.cost = { ...ZERO_COST };
  return model;
}

export function buildModels(baseUrl: string, rate: number = cnyPerUsd()): SiliconFlowModel[] {
  return CATALOG.map((entry) =>
    entryToModel(
      RESPONSES_ENABLED ? entry : { ...entry, api: "openai-completions" },
      baseUrl,
      rate,
    ),
  );
}
