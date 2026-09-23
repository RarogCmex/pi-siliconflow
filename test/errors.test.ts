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
import {
  clarifyErrorMessage,
  extractGatewayErrorMessage,
  fixV31ThinkingPayload,
  normalizeOverflowError,
  remediateOverflowResponse,
  shouldClarify,
} from "../errors.ts";
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

  // Both shapes below are byte-for-byte the gateway's real 400 bodies,
  // captured live on 2026-09-23 against the curated catalog models.
  test("recognises the gateway's real max_prompt_tokens rejection", () => {
    const message =
      "number of input tokens (300030) has exceeded max_prompt_tokens (98304) limit.";
    const rewritten = normalizeOverflowError(message);
    assert.match(rewritten ?? "", /^context_length_exceeded:/);
    assert.equal(isContextOverflow(assistant(rewritten!), 1_048_576), true);
    // Full chain shape: the SDK surfaces this as "400 <message>".
    assert.equal(isContextOverflow(assistant(`400 ${message}`), undefined), false);
    assert.equal(
      isContextOverflow(assistant(normalizeOverflowError(`400 ${message}`)!), 1_048_576),
      true,
    );
  });

  test("recognises the gateway's real max_seq_len rejection", () => {
    // Ling-flash-2.0; note "tokens" sits *before* "exceeded", so only the
    // explicit max_seq_len alternative catches it.
    const message =
      "number of input tokens (135022) has exceeded max_seq_len (131072) limit.";
    const rewritten = normalizeOverflowError(message);
    assert.match(rewritten ?? "", /^context_length_exceeded:/);
    assert.equal(isContextOverflow(assistant(rewritten!), 131_072), true);
  });

  test("still never fires on gateway rate limiting", () => {
    assert.equal(
      normalizeOverflowError(
        "Request was rejected due to rate limiting. Details: TPM limit reached.",
      ),
      null,
    );
  });
});

describe("extractGatewayErrorMessage", () => {
  test("reads the SiliconFlow code/message envelope", () => {
    assert.equal(
      extractGatewayErrorMessage(
        '{"code":20015,"message":"number of input tokens (300030) has exceeded max_prompt_tokens (98304) limit.","data":null}',
      ),
      "number of input tokens (300030) has exceeded max_prompt_tokens (98304) limit.",
    );
  });

  test("reads a bare JSON-string body", () => {
    assert.equal(extractGatewayErrorMessage('"Api key is invalid"'), "Api key is invalid");
  });

  test("returns nothing for shapes it cannot use", () => {
    assert.equal(extractGatewayErrorMessage(""), undefined);
    assert.equal(extractGatewayErrorMessage("   \n"), undefined);
    assert.equal(extractGatewayErrorMessage("not json at all"), undefined);
    assert.equal(extractGatewayErrorMessage('{"code":20012}'), undefined);
    assert.equal(extractGatewayErrorMessage('{"message":42}'), undefined);
    assert.equal(extractGatewayErrorMessage('{"message":""}'), undefined);
    assert.equal(extractGatewayErrorMessage('[1,2,3]'), undefined);
  });
});

describe("remediateOverflowResponse", () => {
  const OVERFLOW_BODY =
    '{"code":20015,"message":"number of input tokens (300030) has exceeded max_prompt_tokens (98304) limit.","data":null}';
  const OVERFLOW_MESSAGE =
    "number of input tokens (300030) has exceeded max_prompt_tokens (98304) limit.";

  function gatewayResponse(status: number, body: string, type = "application/json"): Response {
    return new Response(body, { status, headers: { "content-type": type } });
  }

  test("rewrites an overflow 400 into plain text the OpenAI SDK can surface", async () => {
    const out = await remediateOverflowResponse(gatewayResponse(400, OVERFLOW_BODY));
    assert.notEqual(out.status, 200);
    assert.equal(out.status, 400);
    assert.equal(await out.text(), OVERFLOW_MESSAGE);
    assert.match(out.headers.get("content-type") ?? "", /text\/plain/);
  });

  test("also rewrites a 413 and the max_seq_len phrasing", async () => {
    const body =
      '{"code":20015,"message":"number of input tokens (135022) has exceeded max_seq_len (131072) limit.","data":null}';
    const out = await remediateOverflowResponse(gatewayResponse(413, body));
    assert.equal(out.status, 413);
    assert.equal(
      await out.text(),
      "number of input tokens (135022) has exceeded max_seq_len (131072) limit.",
    );
  });

  test("passes a success response through byte-identically", async () => {
    const ok = gatewayResponse(200, '{"id":"x"}');
    const out = await remediateOverflowResponse(ok);
    assert.equal(out, ok, "must return the same object, not a copy");
    assert.equal(await out.text(), '{"id":"x"}');
  });

  test("leaves every other error shape untouched — 401 keeps the opaque path", async () => {
    for (const [status, body] of [
      [401, '"Api key is invalid"'],
      [401, '{"code":20012,"message":"Api key is invalid","data":null}'],
      [402, '"No enough balance"'],
      [429, '{"code":50602,"message":"Request was rejected due to rate limiting. Details: TPM limit reached.","data":null}'],
      [400, '{"code":12345,"message":"wrong parameter","data":null}'],
      [500, OVERFLOW_BODY], // overflow text at the wrong status is not ours to fix
    ] as const) {
      const res = gatewayResponse(status, body);
      const out = await remediateOverflowResponse(res);
      assert.equal(out, res, `${status} ${body} must pass through`);
    }
  });

  test("the plain-text body survives the SDK's message composition", async () => {
    // What the OpenAI SDK does with the remediated response: errJSON is null
    // (not JSON), so it uses the raw text → "400 <message>", which
    // normalizeOverflowError + pi's classifier both accept.
    const out = await remediateOverflowResponse(gatewayResponse(400, OVERFLOW_BODY));
    const sdkError = new Error(`400 ${await out.text()}`);
    const rewritten = normalizeOverflowError(sdkError.message)!;
    assert.match(rewritten, /^context_length_exceeded:/);
    assert.equal(isContextOverflow(assistant(rewritten), 1_048_576), true);
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
