// SPDX-License-Identifier: AGPL-3.0-or-later
// Resolves the transport for the action checker: Flux by default, the bot's own engine on the owner's switch.
// Text-only in both cases; never the bot's agent session, never charged to the bot's spend.
import type { ProviderInstance } from "./contracts.ts";
import { fluxKey } from "./flux-config.ts";
import { FLUX_OPENAI_BASE } from "./flux-routing.ts";
import { fluxCallHeaders } from "./flux-memory-headers.ts";
import type { CheckerTransport } from "./browser-action-checker.ts";

/** Flux honours no-retain (verified live 2026-10-03: `x-flux-no-retain: applied` on flux-pinned-claude-haiku). Every Flux check call
 * requires that echo; a reply without it fails closed and the step is asked of the owner. If Flux were not live, the action check
 * would run on the bot's own engine (D3). browser-extension-check-availability.ts re-exports it. */
export const FLUX_NO_RETAIN_DEPLOYED = true;

/** Flux model ids for the checker must be PINNED ids: an unpinned name can fall back across vendors.
 * Ids verified against the live Flux catalogue 2026-10-02 (config: browserCheck.stage1Model / stage2Model).
 * Small and strong come from different families on purpose. Never DeepSeek (browsing data, provider policy). */
export const DEFAULT_CHECKER_MODELS = { stage1: "flux-pinned-claude-haiku", stage2: "flux-pinned-gpt-5-mini" } as const;
export function isPinnedFluxModel(id: string): boolean {
  return /^flux-pinned-[a-z0-9][a-z0-9._-]{1,80}$/.test(id) && !/deepseek/i.test(id);
}
export const NO_RETAIN_HEADER = "x-flux-no-retain";
const FLUX_RESPONSE_LIMIT = 65536;
export type CheckerConnectionEvent = { kind: "no_retain_missing"; model: string } | { kind: "call"; model: string; ok: boolean };

export interface CheckerConnection {
  source: "flux" | "bot";
  /** The owner asked for Flux but it is not live, so the bot's own engine runs the check. Settings say so in one line. */
  fallback?: boolean;
  transport: CheckerTransport;
  /** Calls made through this connection, for the owner-visible check count. */
  calls(): number;
  models: { stage1: string; stage2: string };
}
export interface CheckerConnectionInput {
  switch: "flux" | "bot";
  instances: ProviderInstance[];
  readKey?: () => string | null;
  botInstanceId?: string;
  models?: { stage1?: string; stage2?: string };
  /** Activity-log hook: every Flux call and every missing no-retain confirmation. */
  record?: (event: CheckerConnectionEvent) => void;
  /** Require Flux's "applied" echo of the no-retain header. Defaults to FLUX_NO_RETAIN_DEPLOYED: until Flux ships the header the
   * echo cannot exist, and the Flux path is reported unavailable anyway (browser-extension-check-availability.ts). The header is always sent. */
  requireNoRetainEcho?: boolean;
  /** Whether Flux's no-retain header is live. Defaults to FLUX_NO_RETAIN_DEPLOYED. When the Flux switch is on but Flux is not live
   * (or has no key), the check runs on the bot's own engine; with no usable engine either, there is no connection. */
  noRetainDeployed?: boolean;
}

/** An enabled engine instance that can answer a text-only check. */
export const usableCheckerInstance = (i: ProviderInstance) => i.enabled && (typeof i.reviewPermission === "function" || typeof i.extractMemory === "function");
/** The instance the bot-engine check would use, or undefined when none is usable. */
export function pickCheckerInstance(instances: ProviderInstance[], botInstanceId?: string): ProviderInstance | undefined {
  const pool = instances.filter(usableCheckerInstance);
  return botInstanceId ? pool.find((i) => i.instanceId === botInstanceId) : pool[0];
}

/** Flux's model refusals (flux-router src/model_access_message.py). Both dialects answer 403:
 * OpenAI `{"error":{"message","type":"auth_error","param":"model","code":"403"}}` (param is the reliable
 * signal, not type) and Anthropic `{"type":"error","error":{"type":"permission_error","message"}}`.
 * "is not on the Flux free plan" is the plan refusal; anything else of that shape is a key whose allowlist
 * leaves the model out. A 401 is a bad, expired or revoked key and stays a plain request failure. Flux's own
 * sentence is never shown to the owner (it sells a plan); the checker uses Murage's locale strings. */
function modelRefusal(text: string): "CHECKER_MODEL_NOT_ALLOWED" | "CHECKER_MODEL_NOT_PERMITTED" | undefined {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return undefined; }
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (!error || typeof error !== "object") return undefined;
  const { param, type, message } = error as { param?: unknown; type?: unknown; message?: unknown };
  if (param !== "model" && type !== "permission_error") return undefined;
  return typeof message === "string" && message.includes("is not on the Flux free plan") ? "CHECKER_MODEL_NOT_ALLOWED" : "CHECKER_MODEL_NOT_PERMITTED";
}

/** One text-only Flux request. Sends the no-retain header and refuses any reply that does not confirm it. */
async function fluxCall(input: { apiKey: string; req: Parameters<CheckerTransport>[0]; record?: CheckerConnectionInput["record"]; requireEcho: boolean }): Promise<string> {
  const { apiKey, req } = input;
  if (!isPinnedFluxModel(req.model)) throw new Error("CHECKER_UNPINNED_MODEL");
  const url = new URL(`${FLUX_OPENAI_BASE.replace(/\/+$/, "")}/chat/completions`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("CHECKER_UNAVAILABLE");
  const response = await fetch(url, {
    method: "POST", redirect: "error", signal: AbortSignal.any([req.signal, AbortSignal.timeout(60000)]),
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, [NO_RETAIN_HEADER]: "1", ...fluxCallHeaders("browser-checker") },
    body: JSON.stringify({ model: req.model, messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }], max_tokens: req.maxTokens, stream: false }),
  });
  if (!response.ok || !response.body) {
    const status = response.status;
    let text = "";
    try { text = response.body ? (await response.text()).slice(0, 16384) : ""; } catch { /* keep empty */ }
    const refusal = status === 403 ? modelRefusal(text) : undefined;
    if (refusal) throw Object.assign(new Error(refusal), { code: refusal, status });
    throw Object.assign(new Error("CHECKER_REQUEST_FAILED"), { status });
  }
  if (input.requireEcho && response.headers.get(NO_RETAIN_HEADER) !== "applied") {
    await response.body.cancel();
    input.record?.({ kind: "no_retain_missing", model: req.model });
    throw new Error("CHECKER_NO_RETAIN_NOT_APPLIED");
  }
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) { const c = await reader.read(); if (c.done) break; bytes += c.value.byteLength; if (bytes > FLUX_RESPONSE_LIMIT) { await reader.cancel(); throw new Error("CHECKER_RESPONSE_LIMIT"); } parts.push(c.value); }
  } finally { reader.releaseLock(); }
  let body: { choices?: Array<{ finish_reason?: string | null; message?: { content?: unknown; tool_calls?: unknown[] } }> };
  try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new Error("CHECKER_INVALID_RESPONSE"); }
  const choice = body.choices?.length === 1 ? body.choices[0] : undefined;
  if (!choice || typeof choice.message?.content !== "string" || choice.message.tool_calls?.length) throw new Error("CHECKER_INVALID_RESPONSE");
  return choice.message.content;
}

export function resolveCheckerConnection(input: CheckerConnectionInput): CheckerConnection | undefined {
  const models = { stage1: input.models?.stage1 || DEFAULT_CHECKER_MODELS.stage1, stage2: input.models?.stage2 || DEFAULT_CHECKER_MODELS.stage2 };
  // A configured id that is not pinned makes the Flux path unavailable; it never silently falls back to a default.
  if (input.switch === "flux" && !(isPinnedFluxModel(models.stage1) && isPinnedFluxModel(models.stage2))) return undefined;
  let count = 0;
  const botConnection = (fallback: boolean): CheckerConnection | undefined => {
    const chosen = pickCheckerInstance(input.instances, input.botInstanceId);
    if (!chosen) return undefined;
    const transport: CheckerTransport = async (req) => {
      count++;
      const instance = input.instances.find((i) => i.instanceId === chosen.instanceId && usableCheckerInstance(i));
      if (!instance) throw new Error("CHECKER_UNAVAILABLE");
      if (instance.reviewPermission) return instance.reviewPermission(`${req.system}\n\n${req.user}`, req.signal);
      const messages = [{ role: "system", content: req.system }, { role: "user", content: req.user }];
      return instance.extractMemory!(req.user, Math.min(req.maxTokens, 2000), req.signal, { policyRevision: "browser-check", messages });
    };
    return { source: "bot", ...(fallback ? { fallback: true } : {}), transport, calls: () => count, models };
  };
  if (input.switch === "bot") return botConnection(false);
  const fluxLive = input.noRetainDeployed ?? FLUX_NO_RETAIN_DEPLOYED;
  const readKey = input.readKey ?? fluxKey;
  if (!fluxLive || !readKey()) return botConnection(true);
  const transport: CheckerTransport = async (req) => {
    count++;
    // Read again at dispatch so a revoked or replaced key never survives in a closure.
    const apiKey = readKey();
    if (!apiKey) throw new Error("CHECKER_UNAVAILABLE");
    try {
      const out = await fluxCall({ apiKey, req, record: input.record, requireEcho: input.requireNoRetainEcho ?? fluxLive });
      input.record?.({ kind: "call", model: req.model, ok: true });
      return out;
    } catch (error) { input.record?.({ kind: "call", model: req.model, ok: false }); throw error; }
  };
  return { source: "flux", transport, calls: () => count, models };
}
