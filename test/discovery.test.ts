import assert from "node:assert/strict";
import test, { describe, beforeEach, afterEach } from "node:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID } from "../catalog.ts";
import {
  buildOverlay,
  fetchSiliconFlowModels,
  mergeGatewayCatalog,
  parseModelIds,
  SKIP_MODEL_IDS,
} from "../discovery.ts";
import { DEFAULT_BASE_URL, PROVIDER_ID, UNKNOWN_MODEL_DEFAULTS } from "../models.ts";

function makeContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
    ...overrides,
  } as RefreshModelsContext;
}

/** `GET /v1/models` body shape from api-docs.siliconflow.cn/docs/api/models-get. */
const payload = (...ids: string[]) => ({
  object: "list",
  data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "" })),
});

describe("parseModelIds", () => {
  test("reads ids from a well-formed payload", () => {
    assert.deepEqual(parseModelIds(payload("deepseek-ai/DeepSeek-V4-Flash", "zai-org/GLM-5.3")), [
      "deepseek-ai/DeepSeek-V4-Flash",
      "zai-org/GLM-5.3",
    ]);
  });

  test("keeps Pro/ production-tier ids", () => {
    assert.deepEqual(parseModelIds(payload("Pro/zai-org/GLM-5.1")), ["Pro/zai-org/GLM-5.1"]);
  });

  test("drops non-chat modalities that still answer sub_type=chat", () => {
    const ids = parseModelIds(
      payload(
        "deepseek-ai/DeepSeek-V3.2",
        "BAAI/bge-m3",
        "BAAI/bge-reranker-v2-m3",
        "Pro/BAAI/bge-m3",
        "Qwen/Qwen3-Embedding-8B",
        "Qwen/Qwen3-Reranker-8B",
        "Qwen/Qwen-Image",
        "Wan-AI/Wan2.2-T2V-A14B",
        "FunAudioLLM/SenseVoiceSmall",
        "FunAudioLLM/CosyVoice2-0.5B",
        "PaddlePaddle/PaddleOCR-VL-1.5",
        "tencent/Hunyuan-MT-7B",
        "tencent/Hunyuan-A13B-Instruct",
      ),
    );
    assert.deepEqual(ids, ["deepseek-ai/DeepSeek-V3.2"]);
  });

  test("passes unfamiliar chat models through for the overlay to pick up", () => {
    // The filter targets modalities, not unknown vendors: a new chat model must
    // reach buildOverlay() so it can be surfaced with family-guessed defaults.
    const ids = parseModelIds(
      payload("nex-agi/Nex-N2-Pro", "MiniMaxAI/MiniMax-M2.5"),
    );
    assert.deepEqual(ids, ["nex-agi/Nex-N2-Pro", "MiniMaxAI/MiniMax-M2.5"]);
  });

  test("dedupes", () => {
    assert.deepEqual(
      parseModelIds(payload("zai-org/GLM-5.3", "zai-org/GLM-5.3", " zai-org/GLM-5.3 ")),
      ["zai-org/GLM-5.3"],
    );
  });

  test("trims surrounding whitespace", () => {
    assert.deepEqual(parseModelIds(payload("  zai-org/GLM-5.3\n")), ["zai-org/GLM-5.3"]);
  });

  test("survives malformed payloads instead of throwing", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "nope",
      {},
      { data: null },
      { data: "not-an-array" },
      { data: [] },
      { data: [null, 7, "x", {}, { id: null }, { id: 42 }, { id: "" }, { id: "   " }] },
      { data: [{ id: "zai-org/GLM-5.3" }, null, { object: "model" }] },
    ]) {
      assert.doesNotThrow(() => parseModelIds(bad));
    }
    assert.deepEqual(parseModelIds(null), []);
    assert.deepEqual(parseModelIds({ data: [null, { id: "" }] }), []);
    assert.deepEqual(parseModelIds({ data: [{ id: "zai-org/GLM-5.3" }, null] }), ["zai-org/GLM-5.3"]);
  });

  test("rejects SiliconFlow's plain-string error bodies", () => {
    // An invalid key returns a bare JSON string, not an object.
    assert.deepEqual(parseModelIds("Api key is invalid"), []);
    assert.deepEqual(parseModelIds("Invalid token"), []);
  });
});

describe("buildOverlay", () => {
  test("is additive: catalog models stay in the baseline", () => {
    const known = [...CATALOG_BY_ID.keys()];
    assert.deepEqual(buildOverlay(known, DEFAULT_BASE_URL), []);
  });

  test("turns uncatalogued ids into family-guessed models with zero cost", () => {
    const overlay = buildOverlay(["Qwen/Qwen3.8-27B", "tencent/Hy4-preview"], DEFAULT_BASE_URL);
    assert.equal(overlay.length, 2);
    for (const model of overlay) {
      assert.equal(model.provider, PROVIDER_ID);
      assert.equal(model.baseUrl, DEFAULT_BASE_URL);
      assert.equal(model.api, "openai-completions");
      assert.equal(model.cost.input, 0);
    }
    const qwen = overlay.find((m) => m.id === "Qwen/Qwen3.8-27B")!;
    assert.equal(qwen.reasoning, true, "Qwen 3.8 inherits sibling thinking");
    assert.equal(qwen.contextWindow, 262_144);
    const unknown = overlay.find((m) => m.id === "tencent/Hy4-preview")!;
    assert.equal(unknown.reasoning, false);
    assert.equal(unknown.contextWindow, UNKNOWN_MODEL_DEFAULTS.contextWindow);
  });

  test("skips deprecated and tool-less ids even when they reach the overlay", () => {
    assert.ok(SKIP_MODEL_IDS.has("tencent/Hunyuan-A13B-Instruct"));
    assert.deepEqual(
      buildOverlay(["tencent/Hunyuan-A13B-Instruct", "zai-org/GLM-4.5V"], DEFAULT_BASE_URL).map((m) => m.id),
      [],
    );
  });

  test("accepts an injected known-set", () => {
    assert.equal(buildOverlay(["a/b"], DEFAULT_BASE_URL, new Set(["a/b"])).length, 0);
    assert.equal(buildOverlay(["a/b"], DEFAULT_BASE_URL, new Set()).length, 1);
  });
});

describe("mergeGatewayCatalog", () => {
  test("is unknowns-only: known catalog ids stay in the baseline", () => {
    const merged = mergeGatewayCatalog(
      [{ id: "zai-org/GLM-5.3" }, { id: "Qwen/Qwen3.8-27B" }, { id: "Qwen/Qwen3-Reranker-8B" }],
      DEFAULT_BASE_URL,
    );
    assert.deepEqual(
      merged.map((m) => m.id),
      ["Qwen/Qwen3.8-27B"],
      "catalogued GLM-5.3 and reranker dropped",
    );
    assert.equal(merged[0].reasoning, true);
  });

  test("empty listing yields an empty overlay, not a wiped catalog", () => {
    assert.deepEqual(mergeGatewayCatalog([], DEFAULT_BASE_URL), []);
  });
});

describe("fetchSiliconFlowModels", () => {
  const realFetch = globalThis.fetch;
  const realEnv = process.env.SILICONFLOW_API_KEY;
  let calls: { url: string; auth?: string }[];

  beforeEach(() => {
    calls = [];
    delete process.env.SILICONFLOW_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realEnv === undefined) delete process.env.SILICONFLOW_API_KEY;
    else process.env.SILICONFLOW_API_KEY = realEnv;
  });

  function stubFetch(body: unknown, ok = true, status = 200) {
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), auth: init?.headers?.Authorization });
      return {
        ok,
        status,
        json: async () => body,
      };
    }) as typeof fetch;
  }

  test("returns nothing when pi forbids network access", async () => {
    stubFetch(payload("Qwen/Qwen3.8-27B"));
    const result = await fetchSiliconFlowModels(
      DEFAULT_BASE_URL,
      makeContext({ allowNetwork: false, credential: { type: "api_key", key: "sk-test" } }),
    );
    assert.deepEqual(result, []);
    assert.equal(calls.length, 0, "must not hit the network when allowNetwork is false");
  });

  test("returns nothing when already aborted", async () => {
    stubFetch(payload("Qwen/Qwen3.8-27B"));
    const controller = new AbortController();
    controller.abort();
    const result = await fetchSiliconFlowModels(
      DEFAULT_BASE_URL,
      makeContext({ signal: controller.signal, credential: { type: "api_key", key: "sk-test" } }),
    );
    assert.deepEqual(result, []);
    assert.equal(calls.length, 0);
  });

  test("returns nothing without a key, and does not call the gateway", async () => {
    stubFetch(payload("Qwen/Qwen3.8-27B"));
    const result = await fetchSiliconFlowModels(DEFAULT_BASE_URL, makeContext());
    assert.deepEqual(result, []);
    assert.equal(calls.length, 0);
  });

  test("uses the stored credential and queries the chat subtype", async () => {
    stubFetch(payload("Qwen/Qwen3.8-27B", "zai-org/GLM-5.3"));
    const result = await fetchSiliconFlowModels(
      DEFAULT_BASE_URL,
      makeContext({ credential: { type: "api_key", key: "sk-stored" } }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/models?sub_type=chat`);
    assert.equal(calls[0].auth, "Bearer sk-stored");
    // GLM-5.3 is catalogued, so only the new model lands in the overlay.
    assert.deepEqual(result.map((m) => m.id), ["Qwen/Qwen3.8-27B"]);
  });

  test("falls back to SILICONFLOW_API_KEY when nothing is stored", async () => {
    process.env.SILICONFLOW_API_KEY = "  sk-from-env  ";
    stubFetch(payload("nex-agi/Nex-N2-Pro"));
    const result = await fetchSiliconFlowModels(DEFAULT_BASE_URL, makeContext());
    assert.equal(calls[0].auth, "Bearer sk-from-env", "env key must be trimmed");
    assert.deepEqual(result.map((m) => m.id), ["nex-agi/Nex-N2-Pro"]);
  });

  test("prefers the stored credential over the environment", async () => {
    process.env.SILICONFLOW_API_KEY = "sk-from-env";
    stubFetch(payload("nex-agi/Nex-N2-Pro"));
    await fetchSiliconFlowModels(
      DEFAULT_BASE_URL,
      makeContext({ credential: { type: "api_key", key: "sk-stored" } }),
    );
    assert.equal(calls[0].auth, "Bearer sk-stored");
  });

  test("an expired or unauthorised key degrades to the static catalog", async () => {
    stubFetch("Api key is invalid", false, 401);
    const result = await fetchSiliconFlowModels(
      DEFAULT_BASE_URL,
      makeContext({ credential: { type: "api_key", key: "sk-dead" } }),
    );
    assert.deepEqual(result, []);
  });

  test("network and parse failures never throw", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    const result = await fetchSiliconFlowModels(
      DEFAULT_BASE_URL,
      makeContext({ credential: { type: "api_key", key: "sk-test" } }),
    );
    assert.deepEqual(result, []);
  });

  test("strips a trailing slash from a custom base url", async () => {
    stubFetch(payload("nex-agi/Nex-N2-Pro"));
    await fetchSiliconFlowModels(
      "https://proxy.example.com/siliconflow/v1/",
      makeContext({ credential: { type: "api_key", key: "sk-test" } }),
    );
    assert.equal(calls[0].url, "https://proxy.example.com/siliconflow/v1/models?sub_type=chat");
  });

  test("an empty listing produces an empty overlay, not a broken provider", async () => {
    stubFetch(payload());
    const result = await fetchSiliconFlowModels(
      DEFAULT_BASE_URL,
      makeContext({ credential: { type: "api_key", key: "sk-test" } }),
    );
    assert.deepEqual(result, []);
  });
});
