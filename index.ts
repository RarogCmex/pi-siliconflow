/**
 * SiliconFlow provider for pi.
 *
 * Registers `siliconflow` as a first-class pi-ai provider: a curated catalog
 * with real CNY-derived pricing, SiliconFlow's actual reasoning parameters
 * (`enable_thinking` / `reasoning_effort` / `thinking_budget`), `/login`
 * support, live discovery of models newer than the catalog, and a readable
 * message for the gateway's opaque auth failures.
 */

// NOTE on this import: pi's extension loader aliases the bare
// "@earendil-works/pi-ai" specifier to pi-ai's compat entrypoint, a strict
// superset of the core one that re-exports `openAICompletionsApi`. Subpaths
// other than /compat, /oauth and /providers/all are NOT aliased, so importing
// the factory from "@earendil-works/pi-ai/api/openai-completions.lazy" would
// typecheck but fail to resolve at runtime inside pi. tsconfig.json mirrors the
// loader's alias so `npm run typecheck` sees what pi sees. This is the only
// pi-runtime-only import in the package; everything else lives in modules that
// plain Node can load, which is what makes them testable.
import { openAICompletionsApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clarifyErrorMessage, shouldClarify } from "./errors.ts";
import { buildSiliconFlowProvider } from "./provider.ts";

export default function (pi: ExtensionAPI) {
  // SiliconFlow's non-OpenAI error envelope leaves pi with nothing to print for
  // a rejected key. The rewrite happens before pi records the message, so the
  // clarified text is what the user sees. Guarded to this provider and to the
  // body-less auth statuses only; errors.ts explains why the wording cannot
  // trip pi's retry or context-overflow classifiers.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (!shouldClarify(message)) return;
    const errorMessage = clarifyErrorMessage(message.errorMessage ?? "");
    if (!errorMessage) return;
    return { message: { ...message, errorMessage } };
  });

  pi.registerProvider(buildSiliconFlowProvider(openAICompletionsApi()));
}
