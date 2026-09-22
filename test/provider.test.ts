import assert from "node:assert/strict";
import test, { describe, afterEach } from "node:test";
import type { AuthContext, ProviderAuthInteraction, ProviderStreams } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { CATALOG } from "../catalog.ts";
import { PROVIDER_ID, DEFAULT_BASE_URL } from "../models.ts";
import { RESPONSES_ENABLED } from "../models.ts";
import {
  API_KEY_AUTH_NAME,
  API_KEYS_URL,
  API_KEY_ENV_VAR,
  BASE_URL_ENV_VAR,
  buildApiMap,
  buildSiliconFlowProvider,
  resolveBaseUrl,
  siliconFlowApiKeyAuth,
  type SiliconFlowApis,
} from "../provider.ts";

const unused: ProviderStreams = {
  stream: () => {
    throw new Error("not used");
  },
  streamSimple: () => {
    throw new Error("not used");
  },
};

const stubApis: SiliconFlowApis = {
  "openai-responses": unused,
  "openai-completions": unused,
};

function authContext(env: Record<string, string>): AuthContext {
  return {
    env: async (name: string) => env[name],
    fileExists: async () => false,
  };
}

function interaction(entered: string): ProviderAuthInteraction & {
  notifications: { message: string; links?: readonly { url: string; label?: string }[] }[];
} {
  const notifications: { message: string; links?: readonly { url: string; label?: string }[] }[] = [];
  return {
    signal: new AbortController().signal,
    notifications,
    notify: (event) => {
      if (event.type === "info") notifications.push({ message: event.message, links: event.links });
    },
    prompt: async () => entered,
  };
}

describe("resolveBaseUrl", () => {
  const realEnv = process.env[BASE_URL_ENV_VAR];
  afterEach(() => {
    if (realEnv === undefined) delete process.env[BASE_URL_ENV_VAR];
    else process.env[BASE_URL_ENV_VAR] = realEnv;
  });

  test("defaults to the China endpoint", () => {
    assert.equal(resolveBaseUrl(() => undefined), DEFAULT_BASE_URL);
    assert.equal(DEFAULT_BASE_URL, "https://api.siliconflow.cn/v1");
  });

  test("honours an override, trimmed and without a trailing slash", () => {
    assert.equal(
      resolveBaseUrl(() => "  https://proxy.example.com/sf/v1///  "),
      "https://proxy.example.com/sf/v1",
    );
  });

  test("ignores a blank override", () => {
    assert.equal(resolveBaseUrl(() => "   "), DEFAULT_BASE_URL);
  });

  test("reads the documented environment variable", () => {
    process.env[BASE_URL_ENV_VAR] = "https://mirror.example.com/v1";
    assert.equal(resolveBaseUrl(), "https://mirror.example.com/v1");
    delete process.env[BASE_URL_ENV_VAR];
    assert.equal(resolveBaseUrl(), DEFAULT_BASE_URL);
  });
});

describe("api key auth", () => {
  const auth = siliconFlowApiKeyAuth();

  test("is named for the /login list", () => {
    assert.equal(auth.name, API_KEY_AUTH_NAME);
  });

  test("login points at the key page before prompting", async () => {
    const ui = interaction("sk-abc123");
    const credential = await auth.login!(ui);
    assert.deepEqual(credential, { type: "api_key", key: "sk-abc123" });
    assert.equal(ui.notifications.length, 1);
    assert.deepEqual(ui.notifications[0].links, [{ url: API_KEYS_URL, label: "SiliconFlow API Keys" }]);
  });

  test("login trims whitespace from a pasted key", async () => {
    const credential = await auth.login!(interaction("  sk-abc123\n"));
    assert.equal(credential.key, "sk-abc123");
  });

  test("login refuses an empty key", async () => {
    await assert.rejects(() => auth.login!(interaction("   \n")), /No API key entered/);
  });

  test("login warns about an unexpected shape but still saves it", async () => {
    const ui = interaction("some-other-format");
    const credential = await auth.login!(ui);
    assert.equal(credential.key, "some-other-format");
    assert.equal(ui.notifications.length, 2, "key page link plus the shape warning");
    assert.match(ui.notifications[1].message, /does not look like a SiliconFlow key/);
  });

  test("resolve prefers the stored credential", async () => {
    const result = await auth.resolve({
      ctx: authContext({ [API_KEY_ENV_VAR]: "sk-from-env" }),
      credential: { type: "api_key", key: "sk-stored" },
      signal: new AbortController().signal,
    });
    assert.equal(result?.auth.apiKey, "sk-stored");
    assert.match(result?.source ?? "", /stored/i);
  });

  test("resolve falls back to the environment variable and names it", async () => {
    const result = await auth.resolve({
      ctx: authContext({ [API_KEY_ENV_VAR]: "sk-from-env" }),
      signal: new AbortController().signal,
    });
    assert.equal(result?.auth.apiKey, "sk-from-env");
    assert.equal(result?.source, API_KEY_ENV_VAR);
  });

  test("resolve trims an env key", async () => {
    const result = await auth.resolve({
      ctx: authContext({ [API_KEY_ENV_VAR]: "  sk-from-env\n" }),
      signal: new AbortController().signal,
    });
    assert.equal(result?.auth.apiKey, "sk-from-env");
  });

  test("resolve reports unconfigured when neither source has a key", async () => {
    assert.equal(
      await auth.resolve({ ctx: authContext({}), signal: new AbortController().signal }),
      undefined,
    );
    // A stored credential that is blank must not shadow the env var into "".
    assert.equal(
      await auth.resolve({
        ctx: authContext({}),
        credential: { type: "api_key", key: "   " },
        signal: new AbortController().signal,
      }),
      undefined,
    );
  });

  test("resolve honours cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() =>
      auth.resolve({
        ctx: authContext({ [API_KEY_ENV_VAR]: "sk-from-env" }),
        signal: controller.signal,
      }),
    );
  });
});

describe("buildSiliconFlowProvider", () => {
  test("registers under the expected identity", () => {
    const provider = buildSiliconFlowProvider(stubApis);
    assert.equal(provider.id, PROVIDER_ID);
    assert.equal(provider.name, "SiliconFlow");
    assert.equal(provider.baseUrl, DEFAULT_BASE_URL);
  });

  test("exposes api-key auth with an interactive login so /login works", () => {
    const provider = buildSiliconFlowProvider(stubApis);
    assert.ok(provider.auth.apiKey, "api-key auth must be present");
    assert.equal(provider.auth.oauth, undefined);
    assert.equal(typeof provider.auth.apiKey!.login, "function");
    assert.equal(typeof provider.auth.apiKey!.resolve, "function");
  });

  test("serves the whole curated catalog synchronously, with no network", () => {
    const provider = buildSiliconFlowProvider(stubApis);
    const models = provider.getModels();
    assert.equal(models.length, CATALOG.length);
    for (const model of models) {
      assert.equal(model.provider, PROVIDER_ID);
      // Public SiliconFlow 404s on /v1/responses (probed 2026-09-19).
      assert.equal(model.api, "openai-completions");
      assert.equal(model.baseUrl, DEFAULT_BASE_URL);
    }
  });

  test("opts into dynamic refresh so new releases appear", () => {
    assert.equal(typeof buildSiliconFlowProvider(stubApis).refreshModels, "function");
  });

  test("propagates a custom base url to every model", () => {
    const provider = buildSiliconFlowProvider(stubApis, "https://proxy.example.com/sf/v1");
    assert.equal(provider.baseUrl, "https://proxy.example.com/sf/v1");
    for (const model of provider.getModels()) {
      assert.equal(model.baseUrl, "https://proxy.example.com/sf/v1");
    }
  });

  test("RESPONSES_ENABLED is off until SiliconFlow ships /v1/responses", () => {
    assert.equal(RESPONSES_ENABLED, false);
  });

  test("buildApiMap omits the responses adapter while the flag is off", () => {
    const off = buildApiMap(unused, unused);
    assert.equal("openai-completions" in off, true);
    assert.equal("openai-responses" in off, false);
    const on = buildApiMap(unused, unused, true);
    assert.equal(on["openai-responses"], unused);
  });

  test("dispatches on model.api across both registered surfaces", () => {
    let completions = 0;
    let responses = 0;
    const counting = (which: "completions" | "responses"): ProviderStreams => ({
      stream: () => {
        if (which === "completions") completions++;
        else responses++;
        throw new Error(which);
      },
      streamSimple: unused.streamSimple,
    });
    const provider = buildSiliconFlowProvider({
      "openai-completions": counting("completions"),
      "openai-responses": counting("responses"),
    });
    const chat = provider.getModels()[0];
    assert.equal(chat.api, "openai-completions");
    assert.throws(() => provider.stream(chat, normalizeContext({ messages: [] })), /completions/);
    assert.equal(completions, 1);
    assert.equal(responses, 0);

    const responsesModel = { ...chat, api: "openai-responses" as const };
    assert.throws(() => provider.stream(responsesModel, normalizeContext({ messages: [] })), /responses/);
    assert.equal(responses, 1);
    assert.equal(completions, 1);
  });
});
