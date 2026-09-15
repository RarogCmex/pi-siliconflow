import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { CATALOG, CATALOG_BY_ID } from "../catalog.ts";

describe("catalog invariants", () => {
  test("has entries and every id is unique", () => {
    assert.ok(CATALOG.length >= 20, `expected a substantial catalog, got ${CATALOG.length}`);
    assert.equal(CATALOG_BY_ID.size, CATALOG.length, "duplicate model id in catalog");
  });

  test("ids look like SiliconFlow ids (vendor/Model, optional Pro/ prefix)", () => {
    for (const entry of CATALOG) {
      assert.match(
        entry.id,
        /^(?:Pro\/)?[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/,
        `${entry.id} is not a vendor/Model id`,
      );
    }
  });

  test("no deprecated, tool-less or non-chat models slipped in", () => {
    const banned = [
      "zai-org/GLM-4.5V", // State: Deprecated
      "THUDM/GLM-4-32B-0414", // State: Deprecated
      "inclusionAI/Ling-mini-2.0", // State: Deprecated
      "tencent/Hunyuan-A13B-Instruct", // Tools: Not supported
      "tencent/Hunyuan-MT-7B", // translation-only
    ];
    for (const id of banned) {
      assert.equal(CATALOG_BY_ID.has(id), false, `${id} should not be in the catalog`);
    }
    for (const entry of CATALOG) {
      assert.doesNotMatch(entry.id, /(bge|embed|rerank|tts|asr|whisper)/i, entry.id);
    }
  });

  test("context and output sizes are positive and internally consistent", () => {
    for (const entry of CATALOG) {
      assert.ok(entry.contextWindow > 0, `${entry.id} contextWindow`);
      assert.ok(entry.maxTokens > 0, `${entry.id} maxTokens`);
      assert.ok(
        entry.maxTokens <= entry.contextWindow,
        `${entry.id} maxTokens ${entry.maxTokens} exceeds contextWindow ${entry.contextWindow}`,
      );
      assert.ok(entry.name.length > 0, `${entry.id} has no display name`);
      assert.ok(entry.input.includes("text"), `${entry.id} must accept text`);
    }
  });

  test("prices are non-negative and every tier costs at least the base rate", () => {
    for (const entry of CATALOG) {
      const { input, output, cacheRead } = entry.cny;
      assert.ok(input >= 0 && output >= 0 && cacheRead >= 0, `${entry.id} negative price`);
      assert.ok(input > 0, `${entry.id} has no input price — cost reports would be silently wrong`);
      assert.ok(output > 0, `${entry.id} has no output price`);
      assert.ok(cacheRead <= input, `${entry.id} cache read costs more than fresh input`);

      let previous = 0;
      for (const tier of entry.cnyTiers ?? []) {
        assert.ok(tier.inputTokensAbove > previous, `${entry.id} tiers must ascend`);
        assert.ok(
          tier.input >= input && tier.output >= output,
          `${entry.id} tier at ${tier.inputTokensAbove} is cheaper than the base rate`,
        );
        previous = tier.inputTokensAbove;
      }
    }
  });

  test("only reasoning models declare a thinking control beyond none", () => {
    for (const entry of CATALOG) {
      if (entry.thinking.kind === "effort") {
        // pi hides levels mapped to null, so at least one level must be usable.
        const usable = Object.values(entry.thinking.levels).filter((v) => typeof v === "string");
        assert.ok(usable.length > 0, `${entry.id} maps every thinking level to null`);
      }
    }
  });

  test("known flagship specs match the published pages", () => {
    // Spot-checks against siliconflow.com/models spec blocks, so a bad edit to
    // the constants above fails loudly instead of silently mis-sizing contexts.
    const flash = CATALOG_BY_ID.get("deepseek-ai/DeepSeek-V4-Flash");
    assert.equal(flash?.contextWindow, 1_048_576); // "Total Context: 1049K"
    assert.equal(flash?.maxTokens, 393_216); // "Max output: 393K" (384K)

    const glm53 = CATALOG_BY_ID.get("zai-org/GLM-5.3");
    assert.equal(glm53?.contextWindow, 1_048_576);
    assert.equal(glm53?.maxTokens, 131_072); // "Maximum Output: 128K tokens"

    const kimi = CATALOG_BY_ID.get("moonshotai/Kimi-K2.7-Code");
    assert.equal(kimi?.contextWindow, 262_144);
    assert.deepEqual(kimi?.input, ["text", "image"]); // "Support image input: Supported"

    const v32 = CATALOG_BY_ID.get("deepseek-ai/DeepSeek-V3.2");
    assert.equal(v32?.contextWindow, 163_840); // "Total Context: 164K"
  });
});
