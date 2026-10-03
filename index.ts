/**
 * SiliconFlow provider for pi.
 *
 * Registers `siliconflow` as a first-class pi-ai provider: a curated catalog
 * with real CNY-derived pricing, SiliconFlow's actual reasoning parameters
 * (`enable_thinking` / `reasoning_effort` / `thinking_budget`), `/login`
 * support, a semi-dynamic overlay of models newer than the catalog (family-
 * guessed thinking/vision/windows), and a readable message for the gateway's
 * opaque auth failures.
 *
 * A mixed completions/responses API map is prepared but dormant: SiliconFlow 404s on
 * `POST /v1/responses` (probed 2026-09-19; their Codex guide tells users to
 * bridge via CC Switch). `RESPONSES_ENABLED` gates both the adapter
 * registration and `guessApi`. Conversion / compat / family routing stay in
 * the tree — flip the flag when they ship the route.
 *
 * pi 0.87 actionable boundaries, unchanged on pi 1.0.0 (2026-10-03: `message_end`
 * still returns a replacement message, `turn_end` still carries
 * `outcome: completed|aborted|error`, `appendEntry` still exists — compared in the
 * two hosts' dists): `message_end` still rewrites the opaque
 * 401 into readable text (fast, test-covered), while `turn_end` appends a
 * persistent `custom_message` with the key-page link and `/login` hint.
 * The message rewrite is transient (error bubble only); the boundary entry
 * stays in history with `display: true` so the fix survives scrolling.
 */

// NOTE on this import: pi's extension loader aliases the bare
// "@earendil-works/pi-ai" specifier to pi-ai's compat entrypoint, a strict
// superset of the core one that re-exports `openAICompletionsApi` and
// `openAIResponsesApi`. Subpaths other than /compat, /oauth and /providers/all
// are NOT aliased, so importing a factory from
// "@earendil-works/pi-ai/api/openai-completions.lazy" would typecheck but fail
// to resolve at runtime inside pi. tsconfig.json mirrors the loader's alias so
// `npm run typecheck` sees what pi sees. This is the only pi-runtime-only
// import in the package; everything else lives in modules that plain Node can
// load, which is what makes them testable.
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clarifyErrorMessage, fixV31ThinkingPayload, normalizeOverflowError, shouldClarify } from "./errors.ts";
import { API_KEYS_URL, PROVIDER_ID, RESPONSES_ENABLED } from "./models.ts";
import { buildApiMap, buildSiliconFlowProvider, withOverflowRemediation } from "./provider.ts";

export default function (pi: ExtensionAPI) {
  // Two rewrites, both guarded to this provider and to error-stop assistants:
  //   1. overflow phrasing → `context_length_exceeded:` so auto-compaction runs
  //   2. body-less 401/402/403 → a readable auth/balance message
  // Overflow is applied first so an overflow that also happens to look opaque
  // still triggers compaction. errors.ts explains why the 401 wording cannot
  // trip pi's retry or context-overflow classifiers.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (message.provider !== PROVIDER_ID) return;

    const overflow = normalizeOverflowError(message.errorMessage ?? "");
    if (overflow) return { message: { ...message, errorMessage: overflow } };

    if (!shouldClarify(message)) return;
    const errorMessage = clarifyErrorMessage(message.errorMessage ?? "");
    if (!errorMessage) return;
    return { message: { ...message, errorMessage } };
  });

  // pi 0.87 actionable boundary (same on 1.0.0): keep the `message_end` rewrite (transient,
  // in the error bubble), and append a persistent helper entry so the fix
  // doesn't disappear on scroll. Guarded to error outcome + this provider +
  // opaque 401/402/403 only; deduped via customType so re-emits don't stack.
  // Error outcomes are hard exits — no `continue: true` here on purpose.
  pi.on("turn_end", (event) => {
    if (event.outcome !== "error") return;
    const msg = event.message as unknown as {
      role: string;
      stopReason?: string;
      provider?: string;
      errorMessage?: string;
    };
    if (!shouldClarify(msg)) return;
    if (event.entries.some((e) => (e as { customType?: string }).customType === "siliconflow-auth-help"))
      return;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "siliconflow-auth-help",
          // English, matching `clarifyErrorMessage` (the transient rewrite of the
          // same failure) and the login prompt. Every other user-facing string in
          // this plugin is English; this one used to be the exception, so a
          // non-Russian user got a mid-session message they could not read while
          // the bubble above it was readable.
          content:
            "SiliconFlow: the API key is invalid, revoked or expired — or the account " +
            `has no remaining balance (the gateway answers both identically). Check the key and the balance at ${API_KEYS_URL}, ` +
            `then run \`/login ${PROVIDER_ID}\` or update \`SILICONFLOW_API_KEY\`.`, 
          display: true,
        },
      ],
    };
  });

  // SiliconFlow docs: DeepSeek-V3.1 + function calling requires
  // `enable_thinking: false`. pi as an agent always sends tools, so without
  // this the V3.1 models would break tool calls when thinking is on.
  // Narrow: only V3.1 model ids with non-empty tools and thinking enabled.
  pi.on("before_provider_request", (event) => {
    const payload = event.payload as Record<string, any> | undefined;
    if (!payload || typeof payload !== "object") return;
    const fixed = fixV31ThinkingPayload(payload);
    if (fixed) return fixed;
  });

  pi.registerProvider(
    buildSiliconFlowProvider(
      // Every registered surface goes through withOverflowRemediation so the
      // gateway's body-less "400" overflow rejections become recognizable
      // errors (see errors.ts / provider.ts for why the body is lost otherwise).
      RESPONSES_ENABLED
        ? buildApiMap(
            withOverflowRemediation(openAICompletionsApi()),
            withOverflowRemediation(openAIResponsesApi()),
            true,
          )
        : { "openai-completions": withOverflowRemediation(openAICompletionsApi()) },
    ),
  );
}
