/**
 * The safety property that matters here is negative: the rewritten message must
 * not be reclassified by pi. A wording slip could turn a permanent 401 into an
 * endless retry loop, or trigger context compaction on an auth failure. Both
 * assertions below run against pi's real classifiers, not a copy of them.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { getOverflowPatterns, isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { clarifyErrorMessage, fixV31ThinkingPayload, normalizeOverflowError, shouldClarify } from "../errors.ts";
import { PROVIDER_ID } from "../models.ts";

const ORIGINAL = "401 status code (no body)";

function assistant(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: PROVIDER_ID,
    model: "deepseek-ai/DeepSeek-V4-Flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

describe("clarifyErrorMessage", () => {
  test("explains a body-less auth failure and keeps the original", () => {
    const out = clarifyErrorMessage(ORIGINAL);
    assert.ok(out, "expected a rewrite");
    assert.match(out!, /401/);
    assert.match(out!, /invalid, revoked or expired/i);
    assert.match(out!, /no remaining balance/i);
    assert.match(out!, /\/login siliconflow/);
    assert.match(out!, /SILICONFLOW_API_KEY/);
    assert.ok(out!.includes(ORIGINAL), "original text must survive for debugging");
  });

  test("covers 402 and 403 too", () => {
    for (const status of ["401", "402", "403"]) {
      assert.ok(clarifyErrorMessage(`${status} status code (no body)`), status);
    }
  });

  test("tolerates surrounding whitespace", () => {
    assert.ok(clarifyErrorMessage(`  ${ORIGINAL}\n`));
  });

  test("leaves every other message untouched", () => {
    for (const message of [
      "",
      "400 status code (no body)", // bad request, not auth — the body matters here
      "404 status code (no body)",
      "429 status code (no body)", // rate limit: pi must retry, not explain
      "500 status code (no body)",
      "401 {\"code\":20012,\"message\":\"Api key is invalid\"}", // body already surfaced
      "Api key is invalid",
      "fetch failed",
      "The model is offline",
    ]) {
      assert.equal(clarifyErrorMessage(message), undefined, JSON.stringify(message));
    }
  });

  test("the rewrite is not retryable — a dead key must fail fast", () => {
    const out = clarifyErrorMessage(ORIGINAL)!;
    assert.equal(isRetryableAssistantError(assistant(out)), false);
    // Sanity check the classifier is actually live in this test run.
    assert.equal(isRetryableAssistantError(assistant("429 Too Many Requests")), true);
  });

  test("the original 401 was not retryable either, so behaviour is unchanged", () => {
    assert.equal(isRetryableAssistantError(assistant(ORIGINAL)), false);
  });

  test("the rewrite is not mistaken for a context overflow", () => {
    const out = clarifyErrorMessage(ORIGINAL)!;
    assert.equal(isContextOverflow(assistant(out), 1_048_576), false);
    for (const pattern of getOverflowPatterns()) {
      assert.equal(pattern.test(out), false, `rewrite matches overflow pattern ${pattern}`);
    }
  });
});

describe("shouldClarify", () => {
  test("matches only failed SiliconFlow assistant messages", () => {
    assert.equal(shouldClarify(assistant(ORIGINAL)), true);
    assert.equal(shouldClarify({ ...assistant(ORIGINAL), provider: "openai" }), false);
    assert.equal(shouldClarify({ ...assistant(ORIGINAL), stopReason: "stop" }), false);
    assert.equal(shouldClarify({ ...assistant(ORIGINAL), role: "user" }), false);
    assert.equal(shouldClarify({ ...assistant("429 status code (no body)") }), false);
    assert.equal(shouldClarify({ ...assistant(ORIGINAL), errorMessage: undefined }), false);
  });

  test("agrees with clarifyErrorMessage", () => {
    for (const message of [ORIGINAL, "402 status code (no body)", "429 status code (no body)", "boom"]) {
      const assistantMessage = assistant(message);
      assert.equal(
        shouldClarify(assistantMessage),
        clarifyErrorMessage(message) !== undefined,
        message,
      );
    }
  });
});

describe("normalizeOverflowError", () => {
  test("maps overflow phrasing onto pi's compaction marker", () => {
    assert.match(
      normalizeOverflowError("This model's maximum context length is 163840 tokens") ?? "",
      /^context_length_exceeded:/,
    );
    assert.match(normalizeOverflowError("prompt is too long") ?? "", /^context_length_exceeded:/);
    assert.match(normalizeOverflowError("Input tokens exceed the limit") ?? "", /^context_length_exceeded:/);
  });

  test("does not fire on rate limits or auth failures", () => {
    assert.equal(normalizeOverflowError("429 Too Many Requests"), null);
    assert.equal(normalizeOverflowError("Rate limit reached for TPM"), null);
    assert.equal(normalizeOverflowError(ORIGINAL), null);
  });

  test("is idempotent and ignores unrelated errors", () => {
    assert.equal(normalizeOverflowError("context_length_exceeded: already tagged"), null);
    assert.equal(normalizeOverflowError(""), null);
    assert.equal(normalizeOverflowError("500 internal server error"), null);
  });

  test("the rewritten overflow is recognised by pi's classifier", () => {
    const rewritten = normalizeOverflowError("This model's maximum context length is 163840 tokens")!;
    assert.equal(isContextOverflow(assistant(rewritten), 163_840), true);
  });
});

describe("fixV31ThinkingPayload", () => {
  const tools = [{ type: "function", function: { name: "get_weather" } }];

  test("forces enable_thinking off for V3.1 with tools", () => {
    const payload = {
      model: "deepseek-ai/DeepSeek-V3.1-Terminus",
      messages: [],
      tools,
      enable_thinking: true,
      thinking_budget: 4096,
    };
    const fixed = fixV31ThinkingPayload(payload);
    assert.ok(fixed, "expected a fix");
    assert.equal(fixed!.enable_thinking, false);
    assert.equal("thinking_budget" in fixed!, false);
    // original untouched
    assert.equal(payload.enable_thinking, true);
  });

  test("covers Pro/ prefix and case variations", () => {
    const payload = {
      model: "Pro/deepseek-ai/DeepSeek-V3.1-Terminus",
      tools,
      enable_thinking: true,
      reasoning_effort: "high",
    };
    const fixed = fixV31ThinkingPayload(payload)!;
    assert.equal(fixed.enable_thinking, false);
    assert.equal("reasoning_effort" in fixed, false);
  });

  test("leaves non-V3.1, tool-less, or already-off payloads alone", () => {
    assert.equal(
      fixV31ThinkingPayload({ model: "deepseek-ai/DeepSeek-V3.2", tools, enable_thinking: true }),
      undefined,
    );
    assert.equal(
      fixV31ThinkingPayload({ model: "deepseek-ai/DeepSeek-V3.1-Terminus", tools: [], enable_thinking: true }),
      undefined,
    );
    assert.equal(
      fixV31ThinkingPayload({ model: "deepseek-ai/DeepSeek-V3.1-Terminus", tools, enable_thinking: false }),
      undefined,
    );
    assert.equal(
      fixV31ThinkingPayload({ model: "zai-org/GLM-5.3", tools, enable_thinking: true }),
      undefined,
    );
  });
});
