// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Text-only reflection turn over a chat-completions socket (openai-chat,
// openai-compat), P2-AMENDMENT-v5.1.md A.3 and A.5: the request never carries
// a tools field, asks for a json-schema response where the endpoint supports
// it, sets max_tokens, counts the body and cancels it at the cap, and reports
// the isolation facts a socket can state (no tools, no files, finish_reason).
import { reportMemoryUsage } from "../memory/extract.ts";
import { checkLocalServerUrl } from "../local-address-guard.ts";
import { fluxCallHeaders, isFluxUrl } from "../flux-memory-headers.ts";
import { providerDispatcher } from "../provider-dispatcher.ts";
import {
  RUN_BOUND_MS, assertSupportedSchema, httpIsolationReport, httpVerdict, isReportedOverLimit,
  type TextOnlyTurnInput, type TextOnlyTurnResult, type Verdict,
} from "../memory/pip-transport.ts";

export interface HttpTextOnlyOptions {
  /** Endpoint base; `/chat/completions` is appended. */
  baseUrl: string; apiKey: string;
  /** The driver's own body builder (provider ordering and the like); tools are stripped from its output. */
  buildBody: (model: string, messages: Array<{ role: "system" | "user"; content: string }>) => Record<string, unknown>;
  /** Send response_format json_schema (endpoints that support it). */
  jsonSchemaResponse?: boolean;
  /** Raw body cap; defaults to max(64 KB, 4 x maxOutputBytes) to leave room for the envelope. */
  maxBodyBytes?: number;
  fetchImpl?: typeof fetch;
}

const TOOL_FIELDS = ["tools", "tool_choice", "functions", "function_call", "stream_options"];
const cancelled = () => Object.assign(new Error("cancelled"), { name: "cancelled" });
const settled = (verdict: Verdict, extra: Partial<TextOnlyTurnResult> = {}): TextOnlyTurnResult =>
  ({ text: "", isolation: httpIsolationReport({ finishReason: null, exited: true }), verdict, ...extra });

/** The exact JSON body a text-only call sends; exported so tests can assert it. */
export function textOnlyBody(o: HttpTextOnlyOptions, turn: TextOnlyTurnInput, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...o.buildBody(model, [{ role: "system", content: turn.system }, { role: "user", content: turn.text }]),
    stream: false, max_tokens: turn.maxOutputTokens,
  };
  for (const field of TOOL_FIELDS) delete body[field];
  if (o.jsonSchemaResponse) body.response_format = { type: "json_schema", json_schema: { name: "pip_reflection", strict: true, schema: turn.outputSchema } };
  return body;
}

export async function httpTextOnlyTurn(turn: TextOnlyTurnInput, o: HttpTextOnlyOptions): Promise<TextOnlyTurnResult> {
  assertSupportedSchema(turn.outputSchema);
  if (turn.signal.aborted) throw cancelled();
  if (!o.apiKey) return settled({ state: "unsupported", reason: "auth" });
  const endpoint = `${o.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const deadlineAt = turn.transport?.deadlineAt ?? Date.now() + RUN_BOUND_MS;
  const bodyCap = o.maxBodyBytes ?? Math.max(65_536, turn.maxOutputBytes * 4);
  const signal = AbortSignal.any([turn.signal, AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))]);
  const request = JSON.stringify(textOnlyBody(o, turn, turn.model));
  let response: Response;
  try {
    const reach = await checkLocalServerUrl(endpoint);
    if (!reach.ok) return settled({ state: "refused", reason: "transient", detail: `address-${reach.code}`, counted: false });
    response = await (o.fetchImpl ?? fetch)(endpoint, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}`, ...(isFluxUrl(o.baseUrl) ? fluxCallHeaders("pip-reflection") : {}) },
      body: request, dispatcher: providerDispatcher(endpoint),
    } as RequestInit);
  } catch {
    if (turn.signal.aborted) throw cancelled();
    return settled({ state: "refused", reason: "transient", detail: "request-failed", counted: false });
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    return settled({ state: "refused", reason: "transient", detail: `http-${response.status}`, counted: false });
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > bodyCap) {
    await response.body.cancel().catch(() => {});
    return settled({ state: "refused", reason: "bad-output", detail: "over-byte-cap", counted: true });
  }
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let bytes = 0;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const receivedUsage = () => {
    let inputTokens: number | undefined, outputTokens: number | undefined, outputBytes = bytes;
    try {
      const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
      inputTokens = num(body.usage?.prompt_tokens); outputTokens = num(body.usage?.completion_tokens);
      if (typeof body.choices?.[0]?.message?.content === "string") outputBytes = Buffer.byteLength(body.choices[0].message.content);
    } catch { /* partial body: account for received bytes */ }
    return { inputTokens, outputTokens: outputTokens ?? Math.ceil(outputBytes / 3.5) };
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > bodyCap) { await reader.cancel().catch(() => {}); return settled({ state: "refused", reason: "bad-output", detail: "over-byte-cap", counted: true }); }
      parts.push(chunk.value);
    }
  } catch {
    if (turn.signal.aborted) throw cancelled();
    return settled({ state: "refused", reason: "transient", detail: "body-failed", counted: false });
  } finally {
    reader.releaseLock?.();
    const usage = receivedUsage();
    reportMemoryUsage({ prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens });
  }

  let json: { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; tool_calls?: unknown[] } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
  try { json = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { return settled({ state: "refused", reason: "bad-output", detail: "not-json", counted: true }); }
  const choice = json.choices?.length === 1 ? json.choices[0] : undefined;
  const content = typeof choice?.message?.content === "string" ? choice.message.content : null;
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  const usage = receivedUsage();
  const isolation = httpIsolationReport({ finishReason, exited: true });
  if (choice?.message?.tool_calls?.length) return { text: "", isolation, verdict: { state: "unsupported", reason: "tools", detail: "tool-call-in-response" }, usage };
  if (content === null) return { text: "", isolation, verdict: { state: "refused", reason: "bad-output", detail: "no-content", counted: true }, usage };
  const verdict = httpVerdict({ finishReason, content, outputSchema: turn.outputSchema, maxOutputBytes: turn.maxOutputBytes, exited: true });
  return {
    text: verdict.state === "validated" ? JSON.stringify(verdict.structured) : "", isolation, verdict, usage,
    ...(isReportedOverLimit(num(json.usage?.completion_tokens), turn.maxOutputTokens) ? { reportedOverLimit: true } : {}),
  };
}
