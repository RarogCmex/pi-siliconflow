import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { CATALOG, CATALOG_BY_ID } from "../catalog.ts";
import {
  buildModels,
  cnyPerUsd,
  cnyToUsd,
  DEFAULT_BASE_URL,
  DEFAULT_CNY_PER_USD,
  entryToModel,
  PROVIDER_ID,
  UNKNOWN_MODEL_DEFAULTS,
  unknownModelToModel,
} from "../models.ts";

const BASE = DEFAULT_BASE_URL;

/** Assert the conversion matches the true ratio within its rounding precision. */
function assertCloseToRatio(cny: number) {
  const exact = cny / DEFAULT_CNY_PER_USD;
  const got = cnyToUsd(cny, DEFAULT_CNY_PER_USD);
  assert.ok(
    Math.abs(got - exact) < 5e-7,
    `¥${cny} -> ${got}, expected within 5e-7 of ${exact}`,
  );
}

describe("currency conversion", () => {
  test("converts CNY per million tokens to USD", () => {
    assert.equal(cnyToUsd(DEFAULT_CNY_PER_USD, DEFAULT_CNY_PER_USD), 1);
    assert.equal(cnyToUsd(0, DEFAULT_CNY_PER_USD), 0);
    // ¥3 in / ¥9 out for DeepSeek-V4-Flash at the documented rate.
    assertCloseToRatio(3);
    assertCloseToRatio(9);
    assert.equal(cnyToUsd(3, DEFAULT_CNY_PER_USD), 0.446083);
    assert.equal(cnyToUsd(9, DEFAULT_CNY_PER_USD), 1.33825);
  });

  test("rounds to at most six decimals", () => {
    for (const cny of [0.1, 0.4, 1.3, 3, 6.5, 8, 12, 27, 28]) {
      const usd = cnyToUsd(cny, DEFAULT_CNY_PER_USD);
      assert.equal(usd, Math.round(usd * 1e6) / 1e6, `¥${cny} not rounded to 6dp`);
    }
  });

  test("keeps cheap cache tiers non-zero", () => {
    // LongCat-2.0 cache read is ¥0.10 — rounding to 4dp would still survive,
    // but a coarser precision would silently report free caching.
    assert.ok(cnyToUsd(0.1, DEFAULT_CNY_PER_USD) > 0);
  });

  test("rate falls back to the documented default", () => {
    assert.equal(cnyPerUsd(() => undefined), DEFAULT_CNY_PER_USD);
    assert.equal(cnyPerUsd(() => ""), DEFAULT_CNY_PER_USD);
    assert.equal(cnyPerUsd(() => "not-a-number"), DEFAULT_CNY_PER_USD);
    assert.equal(cnyPerUsd(() => "0"), DEFAULT_CNY_PER_USD);
    assert.equal(cnyPerUsd(() => "-7"), DEFAULT_CNY_PER_USD);
  });

  test("rate is overridable without editing source", () => {
    assert.equal(cnyPerUsd(() => "7.5"), 7.5);
    assert.equal(cnyToUsd(7.5, cnyPerUsd(() => "7.5")), 1);
  });
});

describe("model construction", () => {
  test("every catalog entry becomes a well-formed openai-completions model", () => {
    const models = buildModels(BASE);
    assert.equal(models.length, CATALOG.length);
    for (const model of models) {
      assert.equal(model.api, "openai-completions");
      assert.equal(model.provider, PROVIDER_ID);
      assert.equal(model.baseUrl, BASE);
      assert.equal(typeof model.reasoning, "boolean");
      assert.ok(model.contextWindow > 0);
      assert.ok(model.maxTokens > 0);
      assert.ok(model.compat, "compat must be explicit — pi cannot auto-detect SiliconFlow");
    }
  });

  test("compat overrides the four auto-detected defaults that would break requests", () => {
    for (const model of buildModels(BASE)) {
      const c = model.compat!;
      // Documented request body uses max_tokens, not max_completion_tokens.
      assert.equal(c.maxTokensField, "max_tokens", model.id);
      // Top-level enable_thinking boolean — pi's "qwen" shape.
      assert.equal(c.thinkingFormat, "qwen", model.id);
      // Only system/user/assistant/tool roles are documented.
      assert.equal(c.supportsDeveloperRole, false, model.id);
      // Every spec page: "Structured Outputs: Not supported".
      assert.equal(c.supportsStrictMode, false, model.id);
      // Undocumented fields we must not send.
      assert.equal(c.supportsStore, false, model.id);
      assert.equal(c.supportsLongCacheRetention, false, model.id);
      assert.equal(c.supportsOpenAIGrammarTools, false, model.id);
      // Needed for token accounting and stop reasons.
      assert.notEqual(c.supportsUsageInStreaming, false, model.id);
      assert.notEqual(c.supportsFinishReason, false, model.id);
    }
  });

  test("reasoning_effort is only sent to models that document it", () => {
    // pi auto-detects supportsReasoningEffort=true for unknown providers, which
    // would leak pi's own level names ("medium") to enable_thinking-only models.
    for (const entry of CATALOG) {
      const model = entryToModel(entry, BASE, DEFAULT_CNY_PER_USD);
      const expectsEffort = entry.thinking.kind === "effort";
      assert.equal(
        model.compat!.supportsReasoningEffort,
        expectsEffort,
        `${entry.id} (${entry.thinking.kind})`,
      );
      assert.equal(model.reasoning, entry.thinking.kind !== "none", entry.id);
    }
  });

  test("effort models map pi levels to provider values", () => {
    const flash = entryToModel(CATALOG_BY_ID.get("deepseek-ai/DeepSeek-V4-Flash")!, BASE, DEFAULT_CNY_PER_USD);
    // Non-Think / Think High / Think Max — and nothing else.
    assert.deepEqual(flash.thinkingLevelMap, {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });

    const glm = entryToModel(CATALOG_BY_ID.get("zai-org/GLM-5.3")!, BASE, DEFAULT_CNY_PER_USD);
    // Always-on reasoning: "off" must be unavailable.
    assert.equal(glm.thinkingLevelMap?.off, null);
    assert.equal(glm.thinkingLevelMap?.low, "low");
    assert.equal(glm.thinkingLevelMap?.high, "high");
    assert.equal(glm.thinkingLevelMap?.max, "max");
  });

  test("always-on models hide the off switch", () => {
    const kimi = entryToModel(CATALOG_BY_ID.get("moonshotai/Kimi-K2.7-Code")!, BASE, DEFAULT_CNY_PER_USD);
    assert.equal(kimi.reasoning, true);
    assert.deepEqual(kimi.thinkingLevelMap, { off: null });
  });

  test("thinking_budget is only wired for models documented to accept it", () => {
    const budgeted = CATALOG.filter((e) => e.thinking.kind === "toggle" && e.thinking.budget);
    assert.ok(budgeted.length > 0, "expected some models to use thinking_budget");
    for (const entry of budgeted) {
      const model = entryToModel(entry, BASE, DEFAULT_CNY_PER_USD);
      assert.equal(model.compat!.thinkingTokenBudgetField, "thinking_budget", entry.id);
    }
    for (const entry of CATALOG) {
      const budgeted2 = entry.thinking.kind === "toggle" && entry.thinking.budget;
      if (budgeted2) continue;
      const model = entryToModel(entry, BASE, DEFAULT_CNY_PER_USD);
      // Never combine thinking_budget with reasoning_effort.
      assert.equal(model.compat!.thinkingTokenBudgetField, undefined, entry.id);
    }
  });

  test("Pro/ variants keep their own pricing and specs", () => {
    const pro = CATALOG_BY_ID.get("Pro/moonshotai/Kimi-K2.6")!;
    const std = CATALOG_BY_ID.get("moonshotai/Kimi-K2.7-Code")!;
    assert.notEqual(pro.id, std.id);
    assert.equal(pro.name, "Kimi K2.6 (Pro)");
  });
});

describe("cost", () => {
  test("flat prices convert and cacheWrite stays zero", () => {
    const model = entryToModel(CATALOG_BY_ID.get("zai-org/GLM-5.3")!, BASE, DEFAULT_CNY_PER_USD);
    assert.equal(model.cost.input, cnyToUsd(8, DEFAULT_CNY_PER_USD));
    assert.equal(model.cost.output, cnyToUsd(28, DEFAULT_CNY_PER_USD));
    assert.equal(model.cost.cacheRead, cnyToUsd(2, DEFAULT_CNY_PER_USD));
    assert.equal(model.cost.cacheWrite, 0);
    assert.equal(model.cost.tiers, undefined);
  });

  test("tiered prices convert with ascending thresholds", () => {
    const model = entryToModel(CATALOG_BY_ID.get("Pro/zai-org/GLM-5.1")!, BASE, DEFAULT_CNY_PER_USD);
    assert.equal(model.cost.input, cnyToUsd(6, DEFAULT_CNY_PER_USD));
    assert.equal(model.cost.tiers?.length, 1);
    const tier = model.cost.tiers![0];
    assert.equal(tier.inputTokensAbove, 32_000);
    assert.equal(tier.input, cnyToUsd(8, DEFAULT_CNY_PER_USD));
    assert.equal(tier.output, cnyToUsd(28, DEFAULT_CNY_PER_USD));
    assert.equal(tier.cacheWrite, 0);
  });

  test("no model is priced at zero — that would hide real spend", () => {
    for (const model of buildModels(BASE)) {
      assert.ok(model.cost.input > 0, `${model.id} input cost is zero`);
      assert.ok(model.cost.output > 0, `${model.id} output cost is zero`);
    }
  });
});

describe("unknown models", () => {
  test("discovered-but-uncatalogued models get safe defaults and zero cost", () => {
    const model = unknownModelToModel("Qwen/Qwen3.8-27B", BASE);
    assert.equal(model.id, "Qwen/Qwen3.8-27B");
    assert.equal(model.name, "Qwen3.8-27B", "display name drops the vendor prefix");
    assert.equal(model.provider, PROVIDER_ID);
    assert.equal(model.reasoning, false, "do not guess thinking parameters");
    assert.deepEqual(model.input, ["text"]);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(model.contextWindow, UNKNOWN_MODEL_DEFAULTS.contextWindow);
    assert.equal(model.maxTokens, UNKNOWN_MODEL_DEFAULTS.maxTokens);
    assert.equal(model.compat!.maxTokensField, "max_tokens");
    assert.equal(model.compat!.thinkingFormat, "qwen");
  });

  test("a small default window makes compaction fire early rather than overflow", () => {
    assert.ok(UNKNOWN_MODEL_DEFAULTS.contextWindow <= 65_536);
  });
});
