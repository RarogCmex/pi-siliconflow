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
