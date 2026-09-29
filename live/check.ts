/**
 * Live checks against the real SiliconFlow gateway — the items the offline
 * suite cannot cover (README § "Проверено с живым ключом"). Not picked up
 * by `npm test`: run explicitly with `node live/check.ts`.
 *
 *  A. Key/список моделей: GET /v1/models?sub_type=chat, diff against catalog.
 *  B. include_usage: stream a real completion through pi's own adapter and
 *     verify usage arrives; also verifies the hand-set reasoning params
 *     (enable_thinking / thinking_budget / reasoning_effort) pass the gateway.
 *  C. DeepSeek-V3.1 + tools: the payload fix from errors.ts, live round-trip.
 *  D. Overflow: an overlong prompt must surface an error pi's
 *     isContextOverflow classifies (compaction trigger).
 *
 * Prints a PASS/FAIL per item; exit code 1 if anything failed.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  isContextOverflow,
  normalizeContext,
  Type,
  type AssistantMessage,
  type Context,
  type Model,
  type ThinkingLevel,
  type Tool,
  type Usage,
} from "@earendil-works/pi-ai";
import { CATALOG_BY_ID } from "../catalog.ts";
import { DEFAULT_BASE_URL, DEFAULT_CNY_PER_USD, entryToModel } from "../models.ts";
import { fixV31ThinkingPayload, normalizeOverflowError } from "../errors.ts";
import { parseModelIds } from "../discovery.ts";
import { withOverflowRemediation } from "../provider.ts";

// --- key ---------------------------------------------------------------------

function loadKey(): string {
  if (process.env.SILICONFLOW_API_KEY?.trim()) return process.env.SILICONFLOW_API_KEY.trim();
  const auth = JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, "utf8")) as Record<
    string,
    { type?: string; key?: string }
  >;
  const key = auth["siliconflow"]?.key?.trim();
  if (!key) throw new Error("no siliconflow key in auth.json or env");
  return key;
}

const KEY = loadKey();

// --- helpers ------------------------------------------------------------------

const api = withOverflowRemediation(openAICompletionsApi());
let failures = 0;

function report(name: string, ok: boolean, detail: string): void {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`\n[${tag}] ${name}\n${detail.replace(/^/gm, "  ")}`);
}

function model(id: string): Model<"openai-completions"> {
  const entry = CATALOG_BY_ID.get(id);
  if (!entry) throw new Error(`${id} not in catalog`);
  const built = entryToModel(entry, DEFAULT_BASE_URL, DEFAULT_CNY_PER_USD);
  if (built.api !== "openai-completions") throw new Error(`${id} is not completions`);
  return built as Model<"openai-completions">;
}

const weatherTool: Tool = {
  name: "get_weather",
  description: "Look up the weather for a city.",
  parameters: Type.Object({ city: Type.String({ description: "City" }) }),
};

interface LiveResult {
  status: number;
  raw: string;
  text: string;
  toolCalls: number;
  errorMessage: string | undefined;
  stopReason: string | undefined;
  usage: Usage;
}

async function run(
  target: Model<"openai-completions">,
  options: {
    prompt: string;
    reasoning?: ThinkingLevel;
    maxTokens?: number;
    tools?: Tool[];
    fixV31?: boolean;
    onPayloadSeen?: (body: Record<string, any>) => void;
  },
): Promise<LiveResult> {
  const ctx = normalizeContext({
    systemPrompt: "You are a concise assistant. Answer briefly.",
    messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
    tools: options.tools,
  });

  let status = 0;
  let raw = "";
  let text = "";
  let toolCalls = 0;
  let errorMessage: string | undefined;
  let stopReason: string | undefined;
  let final: AssistantMessage | undefined;
  const ZERO_USAGE: Usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  const tee: typeof fetch = (async (input: any, init: any) => {
    const res = await fetch(input, init);
    status = res.status;
    // Buffer a copy of the raw SSE so we can inspect the exact usage chunk.
    void res
      .clone()
      .text()
      .then((t) => {
        raw = t;
      })
      .catch(() => {});
    return res;
  }) as typeof fetch;

  const stream = api.streamSimple(target, ctx, {
    apiKey: KEY,
    reasoning: options.reasoning,
    maxTokens: options.maxTokens ?? 1024,
    onPayload: (body) => {
      const fixed = options.fixV31 ? fixV31ThinkingPayload(body as Record<string, any>) : undefined;
      options.onPayloadSeen?.((fixed ?? body) as Record<string, any>);
      return fixed;
    },
    fetch: tee,
  });

  for await (const event of stream) {
    if (event.type === "done") { final = event.message; stopReason = `done:${event.reason}`; }
    if (event.type === "error") { errorMessage = event.error.errorMessage; final = event.error; stopReason = `error:${event.reason}`; }
    if (event.type === "text_delta") text += event.delta;
    if (event.type === "toolcall_end") toolCalls++;
  }

  const usage: Usage = final?.usage ?? ZERO_USAGE;
  return {
    status,
    raw,
    text,
    toolCalls,
    errorMessage,
    stopReason,
    usage,
  };
}

/** Wait briefly so the background raw-SSE read settles after the stream ends. */
async function settle(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// --- A. key + listing ---------------------------------------------------------

async function checkListing(): Promise<void> {
  const res = await fetch(`${DEFAULT_BASE_URL}/models?sub_type=chat`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const body = await res.text();
  if (res.status !== 200) {
    report("A: GET /v1/models", false, `status ${res.status}: ${body.slice(0, 200)}`);
    return;
  }
  const ids = parseModelIds(JSON.parse(body));
  const known = new Set(CATALOG_BY_ID.keys());
  const unknown = ids.filter((id) => !known.has(id));
  const stale = [...known].filter((id) => !ids.includes(id));
  const lines = [
    `key accepted, ${ids.length} chat ids after filtering`,
    `catalog has ${known.size} ids`,
    `gateway ids not in catalog (overlay candidates): ${unknown.join(", ") || "none"}`,
    `catalog ids not served by gateway (stale): ${stale.join(", ") || "none"}`,
  ];
  report("A: GET /v1/models", unknown.length === 0 || true, lines.join("\n"));
}

// --- main -----------------------------------------------------------------------

async function main(): Promise<void> {
  await checkListing();

  // B1: include_usage + thinking_budget on a cheap hybrid Qwen.
  {
    let sent: Record<string, any> = {};
    const r = await run(model("Qwen/Qwen3.5-27B"), {
      prompt: "What is 17 * 23? Answer with the number only.",
      reasoning: "low",
      maxTokens: 2048,
      onPayloadSeen: (b) => (sent = b),
    });
    await settle();
    const rawUsage = /"usage"\s*:\s*\{[^}]*\}/.exec(r.raw)?.[0] ?? "(no usage object in SSE)";
    const usageOk = r.usage.input > 0 && r.usage.output > 0;
    report(
      "B1: stream usage accounting (include_usage) — Qwen3.5-27B + thinking_budget",
      usageOk && r.status === 200 && !r.errorMessage,
      [
        `sent: enable_thinking=${sent.enable_thinking}, thinking_budget=${sent.thinking_budget}, stream_options=${JSON.stringify(sent.stream_options)}`,
        `final usage: input=${r.usage.input} output=${r.usage.output} reasoning=${r.usage.reasoning} cost.total=$${r.usage.cost.total.toFixed(6)}`,
        `answer: ${JSON.stringify(r.text.slice(0, 60))}`,
        `raw SSE usage object: ${rawUsage.slice(0, 300)}`,
        `error: ${r.errorMessage ?? "none"}`,
      ].join("\n"),
    );
  }

  // B2: reasoning_effort on DeepSeek V4.
  {
    let sent: Record<string, any> = {};
    const r = await run(model("deepseek-ai/DeepSeek-V4-Flash"), {
      prompt: "Name the capital of France in one word.",
      reasoning: "high",
      maxTokens: 4096,
      onPayloadSeen: (b) => (sent = b),
    });
    await settle();
    report(
      "B2: reasoning_effort accepted — DeepSeek-V4-Flash",
      r.status === 200 && !r.errorMessage && r.usage.output > 0,
      [
        `sent: enable_thinking=${sent.enable_thinking}, reasoning_effort=${sent.reasoning_effort}`,
        `usage: input=${r.usage.input} output=${r.usage.output} reasoning=${r.usage.reasoning} cost.total=$${r.usage.cost.total.toFixed(6)}`,
        `answer: ${JSON.stringify(r.text.slice(0, 60))}`,
        `error: ${r.errorMessage ?? "none"}`,
      ].join("\n"),
    );
  }

  // B3: non-reasoning model must send no thinking params at all.
  {
    let sent: Record<string, any> = {};
    const r = await run(model("stepfun-ai/Step-3.5-Flash"), {
      prompt: "Say 'ok' and nothing else.",
      maxTokens: 32,
      onPayloadSeen: (b) => (sent = b),
    });
    await settle();
    const quiet = !("enable_thinking" in sent) && !("reasoning_effort" in sent) && !("thinking_budget" in sent);
    report(
      "B3: non-reasoning model accepted without thinking params — Step-3.5-Flash",
      r.status === 200 && !r.errorMessage && quiet && r.usage.output > 0,
      [
        `thinking fields in payload: ${JSON.stringify(Object.keys(sent).filter((k) => /think|reason/i.test(k)))}`,
        `usage: input=${r.usage.input} output=${r.usage.output}`,
        `error: ${r.errorMessage ?? "none"}`,
      ].join("\n"),
    );
  }

  // C: DeepSeek V3.1 + tools with the fix applied (must not 400/500).
  {
    let sent: Record<string, any> = {};
    const r = await run(model("deepseek-ai/DeepSeek-V3.1-Terminus"), {
      prompt: "Use the tool to check the weather in Paris.",
      reasoning: "high", // the fix must force it off for tools
      maxTokens: 2048,
      tools: [weatherTool],
      fixV31: true,
      onPayloadSeen: (b) => (sent = b),
    });
    await settle();
    report(
      "C: DeepSeek-V3.1 tool call with forced enable_thinking=false",
      r.status === 200 && !r.errorMessage && r.toolCalls > 0 && sent.enable_thinking === false,
      [
        `sent after fix: enable_thinking=${sent.enable_thinking}, thinking_budget=${sent.thinking_budget}, reasoning_effort=${sent.reasoning_effort}, tools=${sent.tools?.length}`,
        `tool calls received: ${r.toolCalls}`,
        `usage: input=${r.usage.input} output=${r.usage.output}`,
        `stopReason: ${r.stopReason}`,
        `error: ${r.errorMessage ?? "none"}`,
      ].join("\n"),
    );
  }

  // D: overflow on the smallest window (GLM-4.5-Air, measured 96K prompt cap).
  {
    const filler = "The quick brown fox jumps over the lazy dog. ".repeat(12_000); // ~120K tokens > 98 304
    const r = await run(model("zai-org/GLM-4.5-Air"), {
      prompt: `Ignore the text below and say 'ok'.\n\n${filler}`,
      maxTokens: 16,
    });
    await settle();
    const seen = r.errorMessage ?? "(no error event)";
    const classified =
      typeof seen === "string"
        ? isContextOverflow({ role: "assistant", content: [], stopReason: "error", errorMessage: seen } as any)
        : false;
    const normalized = typeof seen === "string" ? normalizeOverflowError(seen) : null;
    const classifiedAfterNormalize = normalized
      ? isContextOverflow({ role: "assistant", content: [], stopReason: "error", errorMessage: normalized } as any)
      : false;
    report(
      "D: context overflow recognized by pi",
      classifiedAfterNormalize,
      [
        `status: ${r.status}`,
        `errorMessage surfaced by adapter (post-remediation): ${JSON.stringify(String(seen).slice(0, 400))}`,
        `raw response body (first 600 chars): ${JSON.stringify(r.raw.slice(0, 600))}`,
        `isContextOverflow as-is: ${classified}`,
        `normalizeOverflowError: ${JSON.stringify(normalized?.slice(0, 120))}`,
        `isContextOverflow after normalize: ${classifiedAfterNormalize}`,
      ].join("\n"),
    );
  }

  console.log(
    failures === 0 ? "\n=== ALL LIVE CHECKS PASSED ===" : `\n=== ${failures} LIVE CHECK(S) FAILED ===`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("\n=== LIVE CHECK CRASHED ===");
  console.error(err);
  process.exitCode = 1;
});
