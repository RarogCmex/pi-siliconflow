/**
 * Provider assembly.
 *
 * Split out from `index.ts` so it can be imported and tested under plain Node:
 * everything here resolves through pi-ai's core entrypoint. The one symbol that
 * does not — `openAICompletionsApi`, which pi's loader serves from the compat
 * entrypoint — is injected by `index.ts` instead of imported here.
 */

import {
  createProvider,
  envApiKeyAuth,
  type ApiKeyAuth,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { fetchSiliconFlowModels } from "./discovery.ts";
import { buildModels, cnyPerUsd, DEFAULT_BASE_URL, PROVIDER_ID } from "./models.ts";

export const API_KEYS_URL = "https://cloud.siliconflow.cn/account/ak";
export const API_KEY_AUTH_NAME = "SiliconFlow API key";
export const API_KEY_ENV_VAR = "SILICONFLOW_API_KEY";
export const BASE_URL_ENV_VAR = "SILICONFLOW_BASE_URL";

type EnvReader = (name: string) => string | undefined;

const processEnv: EnvReader = (name) =>
  typeof process !== "undefined" ? process.env?.[name] : undefined;

/**
 * Endpoint override for proxies or a mirror. Note that api.siliconflow.com
 * publishes its own USD price list, so the CNY-derived costs in `catalog.ts`
 * describe the default .cn endpoint only.
 */
export function resolveBaseUrl(env: EnvReader = processEnv): string {
  const trimmed = env(BASE_URL_ENV_VAR)?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : DEFAULT_BASE_URL;
}

/**
 * Standard stored-key-then-env resolution, plus two SiliconFlow-specific touches:
 * a link to the key page during `/login`, and whitespace trimming on both paths.
 *
 * Trimming matters more than it looks: a key pasted with a trailing newline is
 * rejected by the gateway with the same opaque 401 as a revoked key (see
 * `errors.ts`), which reads like an account problem rather than a stray
 * character.
 */
export function siliconFlowApiKeyAuth(): ApiKeyAuth {
  const base = envApiKeyAuth(API_KEY_AUTH_NAME, [API_KEY_ENV_VAR]);
  return {
    ...base,

    async login(interaction) {
      interaction.signal.throwIfAborted();
      interaction.notify({
        type: "info",
        message: "Create a key on the SiliconFlow API Keys page:",
        links: [{ url: API_KEYS_URL, label: "SiliconFlow API Keys" }],
      });
      const entered = await interaction.prompt({
        type: "secret",
        message: API_KEY_AUTH_NAME,
        placeholder: "sk-...",
      });
      interaction.signal.throwIfAborted();
      const key = entered.trim();
      if (!key) throw new Error("No API key entered.");
      if (!key.startsWith("sk-")) {
        // Accept it anyway — rejecting on shape would lock users out the moment
        // SiliconFlow changes its key format.
        interaction.notify({
          type: "info",
          message: "That does not look like a SiliconFlow key (expected sk-…). Saving it regardless.",
        });
      }
      return { type: "api_key", key };
    },

    async resolve(input) {
      const resolved = await base.resolve(input);
      const key = resolved?.auth.apiKey?.trim();
      if (!resolved || !key) return undefined;
      return { ...resolved, auth: { ...resolved.auth, apiKey: key } };
    },
  };
}

/**
 * Build the `siliconflow` provider.
 *
 * `models` is the curated baseline, always present and never network-dependent.
 * `fetchModels` layers live discovery on top: pi merges the overlay per id,
 * persists it through its own ModelsStore, and restores it offline, so a new
 * SiliconFlow release shows up without a catalog edit while a dead key or no
 * network degrades to the baseline.
 */
export function buildSiliconFlowProvider(
  api: ProviderStreams,
  baseUrl: string = resolveBaseUrl(),
): Provider {
  return createProvider({
    id: PROVIDER_ID,
    name: "SiliconFlow",
    baseUrl,
    auth: { apiKey: siliconFlowApiKeyAuth() },
    models: buildModels(baseUrl, cnyPerUsd(processEnv)),
    fetchModels: (context) => fetchSiliconFlowModels(baseUrl, context),
    api,
  });
}
