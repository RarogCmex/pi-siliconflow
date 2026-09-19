/**
 * Live model discovery — the dynamic half of a semi-dynamic catalog.
 *
 * SiliconFlow's catalog moves fast (DeepSeek-V4-Flash landed 2026-04-24,
 * GLM-5.3 on 2026-08-14), so a frozen list goes stale between releases. This
 * module implements `createProvider`'s `fetchModels` hook: pi calls it on
 * refresh, persists the result through its own ModelsStore, and merges it over
 * the curated baseline — overlay entries win per id, unknown ids are appended.
 *
 * The overlay is deliberately **additive** and **unknowns-only**. Known catalog
 * ids keep their curated prices/caps (a live listing does not freeze last
 * week's CNY rates into the ModelsStore). Pruning the baseline down to what
 * `GET /v1/models` returned would turn a partial or failed listing into a
 * provider with no models, which is worse than showing one the key cannot use.
 *
 * Unknown ids are not mute 32K stubs: `unknownModelToModel` family-guesses
 * thinking, vision and window from the model name, the same way paratera
 * guesses a route. Unrecognised families stay conservative.
 */

import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID } from "./catalog.ts";
import { unknownModelToModel, type SiliconFlowModel } from "./models.ts";

/** Payload of `GET /v1/models` (see api-docs.siliconflow.cn/docs/api/models-get). */
interface ModelsResponse {
  object?: string;
  data?: { id?: unknown }[];
}

export interface GatewayModelEntry {
  id?: unknown;
  name?: unknown;
}

/**
 * Non-chat models that still answer `sub_type=chat` on some deployments, plus the
 * other modalities we never want in a coding agent's model picker.
 */
const EXCLUDED =
  /(embed|rerank|bge|vector|whisper|sense-?voice|cosyvoice|tts|asr|speech|audio|image|video|wan2|flux|kolors|z-image|stable-diffusion|sdxl|ocr|vl-1\.5|hunyuan-mt|hunyuan-a13b)/i;

/**
 * Exact ids that must never auto-register even if they slip past EXCLUDED:
 * deprecated, tool-less, or translation-only.
 */
export const SKIP_MODEL_IDS = new Set<string>([
  "zai-org/GLM-4.5V",
  "THUDM/GLM-4-32B-0414",
  "inclusionAI/Ling-mini-2.0",
  "tencent/Hunyuan-A13B-Instruct",
  "tencent/Hunyuan-MT-7B",
]);

/** Pull model ids out of a `/v1/models` body. Pure so it can be tested without network. */
export function parseModelIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as ModelsResponse).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || !id.trim()) continue;
    const trimmed = id.trim();
    if (EXCLUDED.test(trimmed)) continue;
    if (SKIP_MODEL_IDS.has(trimmed)) continue;
    ids.push(trimmed);
  }
  return [...new Set(ids)];
}

/**
 * Overlay for discovered ids: catalog models stay in the baseline with full
 * metadata and pricing, so only ids the catalog does not know become overlay
 * entries (family-guessed thinking/vision/windows, zero cost).
 */
export function buildOverlay(
  ids: readonly string[],
  baseUrl: string,
  known: ReadonlySet<string> = new Set(CATALOG_BY_ID.keys()),
): SiliconFlowModel[] {
  return ids.filter((id) => !known.has(id) && !SKIP_MODEL_IDS.has(id)).map((id) => unknownModelToModel(id, baseUrl));
}

/**
 * Merge a live `GET /v1/models` listing over the static table. Same as
 * `buildOverlay` today — known ids are *not* re-emitted so a plugin update
 * to curated prices/caps wins without waiting for the next refresh. Empty
 * input yields an empty overlay (createProvider keeps the baseline).
 */
export function mergeGatewayCatalog(
  raw: readonly GatewayModelEntry[],
  baseUrl: string,
): SiliconFlowModel[] {
  const ids = parseModelIds({ data: raw });
  return buildOverlay(ids, baseUrl);
}

/** Resolve the bearer token pi's auth layer did not hand us (env-only setups). */
function resolveKey(context: RefreshModelsContext): string | undefined {
  const stored = context.credential;
  if (stored?.type === "api_key" && typeof stored.key === "string" && stored.key.trim()) {
    return stored.key.trim();
  }
  const fromEnv =
    typeof process !== "undefined" ? process.env?.SILICONFLOW_API_KEY : undefined;
  return fromEnv?.trim() ? fromEnv.trim() : undefined;
}

/**
 * `fetchModels` implementation. Never throws: returning `[]` leaves the curated
 * baseline (and any previously persisted overlay) untouched, so an offline start
 * or a dead key degrades to "static catalog" instead of "broken provider".
 *
 * Note: createProvider persists whatever we return. Returning `[]` on failure
 * therefore *does* wipe a previously persisted overlay of discovered ids on
 * the next successful `publish`. That is the same trade-off as "don't persist
 * a failed listing as the new catalog"; the baseline is always there.
 */
export async function fetchSiliconFlowModels(
  baseUrl: string,
  context: RefreshModelsContext,
  timeoutMs = 8_000,
): Promise<SiliconFlowModel[]> {
  if (!context.allowNetwork || context.signal.aborted) return [];
  const key = resolveKey(context);
  if (!key) return [];

  // Honour pi's refresh signal, but also cap the wait so a hung gateway cannot
  // stall a session start that pi is awaiting.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  context.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models?sub_type=chat`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const ids = parseModelIds(await response.json());
    return buildOverlay(ids, baseUrl);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", onAbort);
  }
}
