/**
 * Wire-format tests.
 *
 * These drive pi's real `openai-completions` adapter — the same
 * `openAICompletionsApi()` the provider registers — and capture the request body
 * through `onPayload`. Nothing touches the network: `fetch` is replaced with a
 * stub that records the URL and refuses the call.
 *
 * This is the test that matters most, because every compat flag in `models.ts`
 * exists to change these bytes, and a wrong guess fails only at runtime against
 * a paid API.
 */

import assert from "node:assert/strict";
import test, { describe, afterEach } from "node:test";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { Context, Model, ThinkingLevel, Tool, TranscriptContext } from "@earendil-works/pi-ai";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID } from "../catalog.ts";
import { DEFAULT_BASE_URL, entryToModel, DEFAULT_CNY_PER_USD } from "../models.ts";

const api = openAICompletionsApi();
const responsesApi = openAIResponsesApi();

const weatherTool: Tool = {
  name: "get_weather",
  description: "Look up the weather for a city.",
  parameters: Type.Object({
    city: Type.String({ description: "City name" }),
  }),
};

function model(id: string): Model<"openai-completions"> {
  const entry = CATALOG_BY_ID.get(id);
  assert.ok(entry, `${id} missing from catalog`);
  const built = entryToModel(entry, DEFAULT_BASE_URL, DEFAULT_CNY_PER_USD);
  assert.equal(built.api, "openai-completions", id);
  return built as Model<"openai-completions">;
}

function context(overrides: Partial<Context> = {}): TranscriptContext {
  return normalizeContext({
    systemPrompt: "You are pi, a coding agent.",
    messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }],
    ...overrides,
  });
}

let requestedUrl: string | undefined;

afterEach(() => {
  requestedUrl = undefined;
});

/**
 * Run a stream to its (expected) failure and return the request body it would
 * have sent.
 *
 * The body is JSON round-tripped on purpose: pi's `buildParams` assigns several
 * fields the literal value `undefined` (`prompt_cache_key`, `prompt_cache_retention`),
 * so a `key in body` check would report them as present even though the
 * serialized request never carries them. Asserting on the round-tripped object
 * tests the actual wire bytes.
 */
async function capture(
  target: Model<"openai-completions">,
  options: { reasoning?: ThinkingLevel; maxTokens?: number; tools?: Tool[] } = {},
): Promise<Record<string, any>> {
  let payload: Record<string, any> | undefined;
  const blocked = new Error("network blocked by test");

  const stream = api.streamSimple(target, context({ tools: options.tools }), {
    apiKey: "sk-test",
    reasoning: options.reasoning,
    maxTokens: options.maxTokens ?? 2048,
    onPayload: (body) => {
      payload = body as Record<string, any>;
      return undefined;
    },
    fetch: ((url: any) => {
      requestedUrl = String(url);
      throw blocked;
    }) as unknown as typeof fetch,
  });

  for await (const event of stream) {
    if (event.type === "error" || event.type === "done") break;
  }

  assert.ok(payload, "adapter never built a request payload");
  return JSON.parse(JSON.stringify(payload));
}

describe("request shape common to every SiliconFlow model", () => {
  test("posts to the /v1 chat completions endpoint", async () => {
    await capture(model("zai-org/GLM-5.3"));
    assert.equal(requestedUrl, "https://api.siliconflow.cn/v1/chat/completions");
  });

  test("uses max_tokens, not max_completion_tokens", async () => {
    const body = await capture(model("zai-org/GLM-5.3"), { maxTokens: 4096 });
    assert.equal(body.max_tokens, 4096);
    assert.equal("max_completion_tokens" in body, false);
  });

  test("never sends fields absent from the SiliconFlow reference", async () => {
    const body = await capture(model("zai-org/GLM-5.3"), { tools: [weatherTool] });
    for (const field of ["store", "prompt_cache_retention", "prompt_cache_key", "priority"]) {
      assert.equal(field in body, false, `${field} should not be sent`);
    }
  });

  test("asks for streaming usage so token accounting works", async () => {
    const body = await capture(model("zai-org/GLM-5.3"));
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  test("uses the system role, not developer", async () => {
    const body = await capture(model("zai-org/GLM-5.3"));
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[0].content, "You are pi, a coding agent.");
    assert.equal(
      body.messages.some((m: any) => m.role === "developer"),
      false,
    );
  });

  test("sends plain function tools without the strict flag", async () => {
    const body = await capture(model("zai-org/GLM-5.3"), { tools: [weatherTool] });
    assert.equal(body.tools.length, 1);
    const fn = body.tools[0].function;
    assert.equal(fn.name, "get_weather");
    assert.deepEqual(fn.parameters.properties.city, { type: "string", description: "City name" });
    assert.equal("strict" in fn, false, "Structured Outputs are not supported");
  });
});

describe("enable_thinking: SiliconFlow's top-level reasoning switch", () => {
  test("is false when thinking is off", async () => {
    const body = await capture(model("deepseek-ai/DeepSeek-V4-Flash"));
    assert.equal(body.enable_thinking, false);
    assert.equal("reasoning_effort" in body, false);
  });

  test("is true alongside reasoning_effort on effort models", async () => {
    const body = await capture(model("deepseek-ai/DeepSeek-V4-Flash"), { reasoning: "high" });
    assert.equal(body.enable_thinking, true);
    assert.equal(body.reasoning_effort, "high");
  });

  test("maps pi's max level to Think Max on DeepSeek V4", async () => {
    const body = await capture(model("deepseek-ai/DeepSeek-V4-Flash"), { reasoning: "max" });
    assert.equal(body.reasoning_effort, "max");
  });

  test("maps pi's xhigh level onto the model's top effort", async () => {
    // DeepSeek V4 exposes Non-Think / Think High / Think Max only, so pi clamps
    // an unsupported level to a real one instead of inventing a value.
    const body = await capture(model("deepseek-ai/DeepSeek-V4-Flash"), { reasoning: "xhigh" });
    assert.ok(
      ["high", "max"].includes(body.reasoning_effort),
      `unexpected effort ${body.reasoning_effort}`,
    );
  });

  test("never leaks pi-internal level names to the gateway", async () => {
    // A raw "medium"/"xhigh"/"minimal" would be an invalid reasoning_effort.
    for (const id of CATALOG_BY_ID.keys()) {
      for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as ThinkingLevel[]) {
        const body = await capture(model(id), { reasoning: level });
        if (typeof body.reasoning_effort === "string") {
          assert.ok(
            ["low", "high", "max"].includes(body.reasoning_effort),
            `${id} sent reasoning_effort=${body.reasoning_effort} for pi level ${level}`,
          );
        }
      }
    }
  });

  test("sends low/high/max for GLM-5.x", async () => {
    for (const level of ["low", "high", "max"] as ThinkingLevel[]) {
      const body = await capture(model("zai-org/GLM-5.3"), { reasoning: level });
      assert.equal(body.enable_thinking, true);
      assert.equal(body.reasoning_effort, level);
    }
  });
});

describe("thinking_budget", () => {
  test("is sent to Qwen hybrid models instead of reasoning_effort", async () => {
    const body = await capture(model("Qwen/Qwen3.6-27B"), { reasoning: "medium", maxTokens: 16384 });
    assert.equal(body.enable_thinking, true);
    assert.equal("reasoning_effort" in body, false);
    assert.equal(typeof body.thinking_budget, "number");
    assert.ok(body.thinking_budget > 0);
  });

  test("leaves room for the answer inside max_tokens", async () => {
    const body = await capture(model("deepseek-ai/DeepSeek-V3.2"), {
      reasoning: "high",
      maxTokens: 4096,
    });
    assert.ok(body.thinking_budget < 4096, "budget must not consume the whole response");
  });

  test("is never combined with reasoning_effort", async () => {
    for (const id of CATALOG_BY_ID.keys()) {
      const body = await capture(model(id), { reasoning: "high", maxTokens: 16384 });
      assert.equal(
        body.thinking_budget !== undefined && body.reasoning_effort !== undefined,
        false,
        `${id} sent both thinking_budget and reasoning_effort`,
      );
    }
  });

  test("is omitted when thinking is off", async () => {
    const body = await capture(model("Qwen/Qwen3.6-27B"), { maxTokens: 16384 });
    assert.equal(body.enable_thinking, false);
    assert.equal("thinking_budget" in body, false);
  });
});

describe("non-reasoning models stay quiet", () => {
  test("send no thinking parameters at all", async () => {
    for (const id of ["meituan-longcat/LongCat-2.0", "stepfun-ai/Step-3.5-Flash", "inclusionAI/Ling-flash-2.0"]) {
      const body = await capture(model(id), { reasoning: "high" });
      assert.equal("enable_thinking" in body, false, id);
      assert.equal("reasoning_effort" in body, false, id);
      assert.equal("thinking_budget" in body, false, id);
      assert.equal("thinking" in body, false, `${id}: deepseek-style thinking object must not appear`);
    }
  });
});

describe("dormant openai-responses path (kept, not registered live)", () => {
  test("a model opted onto responses posts to /v1/responses, not chat/completions", async () => {
    const entry = CATALOG_BY_ID.get("deepseek-ai/DeepSeek-V4-Flash")!;
    const target = entryToModel(
      { ...entry, api: "openai-responses" },
      DEFAULT_BASE_URL,
      DEFAULT_CNY_PER_USD,
    );
    assert.equal(target.api, "openai-responses");

    let payload: Record<string, any> | undefined;
    const blocked = new Error("network blocked by test");
    const stream = responsesApi.streamSimple(target, context(), {
      apiKey: "sk-test",
      reasoning: "high",
      maxTokens: 2048,
      onPayload: (body) => {
        payload = body as Record<string, any>;
        return undefined;
      },
      fetch: ((url: any) => {
        requestedUrl = String(url);
        throw blocked;
      }) as unknown as typeof fetch,
    });
    for await (const event of stream) {
      if (event.type === "error" || event.type === "done") break;
    }
    assert.ok(payload, "adapter never built a request payload");
    assert.match(requestedUrl ?? "", /\/responses/);
    assert.doesNotMatch(requestedUrl ?? "", /chat\/completions/);
    assert.equal(payload.model, entry.id);
  });
});

describe("catalog-wide request audit", () => {
  test("every model produces a sendable body with no deepseek/zai thinking object", async () => {
    for (const id of CATALOG_BY_ID.keys()) {
      const body = await capture(model(id), { reasoning: "high", maxTokens: 8192, tools: [weatherTool] });
      assert.equal(body.model, id, "model id must be passed through verbatim");
      assert.equal("thinking" in body, false, `${id} must not use thinking:{type}`);
      assert.equal("chat_template_kwargs" in body, false, id);
      assert.equal("reasoning" in body, false, `${id} must not use reasoning:{effort}`, );
      assert.ok(Array.isArray(body.messages) && body.messages.length >= 2, id);
    }
  });
});
