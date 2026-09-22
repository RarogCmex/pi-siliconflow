/**
 * Error-message clarification.
 *
 * SiliconFlow reports authentication and billing failures in a non-OpenAI
 * envelope (`{"code":20012,"message":"Api key is invalid"}`, or a bare JSON
 * string like `"Invalid token"`). pi's OpenAI adapter cannot fold either shape
 * into `error.message`, so a dead key surfaces as the opaque
 * `401 status code (no body)` — which reads like a network or pi bug rather
 * than what it is.
 *
 * The gateway also answers the same way when the account balance is exhausted,
 * so the rewrite names both causes instead of guessing between them.
 *
 * Scope is deliberately narrow: only the body-less 401/402/403 case is touched.
 * Anything carrying a real body is left alone, and the replacement text avoids
 * every phrase pi's retry classifier and context-overflow detector match on, so
 * this cannot turn a permanent auth failure into a retry loop or trigger
 * compaction.
 */

import { PROVIDER_ID } from "./models.ts";

/** `<status> status code (no body)` — the adapter's fallback when it found no usable body. */
const OPAQUE_AUTH_FAILURE = /^(40[123]) status code \(no body\)$/;

const KEY_PAGE_URL = "https://cloud.siliconflow.cn/account/ak";

/**
 * Return a clearer message for an opaque SiliconFlow auth/billing failure, or
 * undefined when the message should be left exactly as pi produced it.
 */
export function clarifyErrorMessage(errorMessage: string): string | undefined {
  const match = OPAQUE_AUTH_FAILURE.exec(errorMessage.trim());
  if (!match) return undefined;
  const status = match[1];
  return (
    `${PROVIDER_ID}: HTTP ${status} with no response body. ` +
    "SiliconFlow rejects an invalid, revoked or expired API key — and an account " +
    "with no remaining balance — using the same status, so check both. " +
    `Verify the key and balance at ${KEY_PAGE_URL}, then re-run /login ${PROVIDER_ID} ` +
    `(or update SILICONFLOW_API_KEY). Original message: ${errorMessage}`
  );
}

/** True when an assistant message is a SiliconFlow failure worth clarifying. */
export function shouldClarify(message: {
  role: string;
  stopReason?: string;
  provider?: string;
  errorMessage?: string;
}): boolean {
  return (
    message.role === "assistant" &&
    message.stopReason === "error" &&
    message.provider === PROVIDER_ID &&
    typeof message.errorMessage === "string" &&
    OPAQUE_AUTH_FAILURE.test(message.errorMessage.trim())
  );
}

/**
 * Map SiliconFlow overflow phrasing onto pi's `context_length_exceeded` marker
 * so auto-compaction kicks in. Rate limits must never trigger compaction.
 * Returns the rewritten text, or null when the error is not an overflow.
 */
const CONTEXT_OVERFLOW_RE =
  /context_length_exceeded|maximum context length|prompt is too long|exceed(?:s|ed)?[^.\n]{0,80}(context|token)|input tokens exceed|Total tokens of image and text exceed|超出.*长度|超过.*长度|max_tokens参数非法/i;
const RATE_LIMIT_RE =
  /rate.?limit|too many requests|\b429\b|\bRPM\b|\bTPM\b|\bRPD\b|\bTPD\b|\bquota\b/i;

export function normalizeOverflowError(errorMessage: string): string | null {
  if (!errorMessage) return null;
  if (errorMessage.startsWith("context_length_exceeded")) return null;
  if (RATE_LIMIT_RE.test(errorMessage)) return null;
  if (!CONTEXT_OVERFLOW_RE.test(errorMessage)) return null;
  return `context_length_exceeded: ${errorMessage}`;
}

/**
 * SiliconFlow constraint: `DeepSeek-V3.1` with function calling must use
 * `enable_thinking: false` (docs: api-docs.siliconflow.cn reasoning guide).
 * pi as an agent always sends `tools`, so a V3.1 model with thinking enabled
 * would break tool calls.
 *
 * Applied via `before_provider_request`: when the payload targets a V3.1 model
 * and carries tools, force `enable_thinking` off and drop thinking-budget
 * fields. Returns a new payload when a change was made, otherwise undefined.
 * Pure and unit-testable — no network needed.
 */
const V31_MODEL_RE = /DeepSeek-V3\.1/i;

export function fixV31ThinkingPayload(
  payload: Record<string, any>,
): Record<string, any> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const model = payload.model;
  if (typeof model !== "string" || !V31_MODEL_RE.test(model)) return undefined;
  const tools = payload.tools;
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  if (!payload.enable_thinking) return undefined;

  const fixed: Record<string, any> = { ...payload, enable_thinking: false };
  // Thinking and answer share max_tokens; with thinking off these must not leak.
  delete fixed.thinking_budget;
  delete fixed.reasoning_effort;
  return fixed;
}
