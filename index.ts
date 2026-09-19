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
 * Mixed API is prepared (paratera-style) but dormant: SiliconFlow 404s on
 * `POST /v1/responses` (probed 2026-09-19; their Codex guide tells users to
 * bridge via CC Switch). `RESPONSES_ENABLED` gates both the adapter
 * registration and `guessApi`. Conversion / compat / family routing stay in
 * the tree — flip the flag when they ship the route.
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
import { clarifyErrorMessage, normalizeOverflowError, shouldClarify } from "./errors.ts";
import { PROVIDER_ID, RESPONSES_ENABLED } from "./models.ts";
import { buildApiMap, buildSiliconFlowProvider } from "./provider.ts";

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

  pi.registerProvider(
    buildSiliconFlowProvider(
      RESPONSES_ENABLED
        ? buildApiMap(openAICompletionsApi(), openAIResponsesApi(), true)
        : { "openai-completions": openAICompletionsApi() },
    ),
  );
}
