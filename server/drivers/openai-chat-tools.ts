// Tool calling for the OpenAI-chat engines (OPENAI-TOOLS-109): the pieces of the round loop that hold no runtime state of
// their own — redaction, the per-turn tool catalog and its caps, provider refusal readers, the remembered text-only models and
// the per-turn MCP child teardown set. The loop itself lives in openai-chat.ts.
import { providerSafeInputSchema } from "../mcp-tool-schema.ts";
import { redactSecretsInText } from "../redact.ts";
import { combine, type ChildTeardown, type TeardownWait } from "./child-teardown.ts";
import type { ProviderStopResult } from "../contracts.ts";
import { object } from "./openai-chat-protocol.ts";
import type { ChatMcpSession } from "./chat-mcp-client.ts";

export const MAX_CHAT_ROUNDS = 64;
export const MAX_TURN_TOOL_CALLS = 200;
export const MAX_ANNOUNCEMENT_NUDGES = 3;
/** s4 caps. */
export const MAX_TURN_TOOLS = 128;
export const MAX_SERVER_TOOLS = 128;
export const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;
export const MAX_TOOLS_JSON_BYTES = 256 * 1024;
export const MAX_TOOL_DESCRIPTION_CHARS = 1_024;
/** s8 / s10 caps, each applied only after the known-secret scrub of the whole value. */
export const TOOL_RESULT_MAX_BYTES = 50 * 1024;
export const NATIVE_TOOL_RESULT_MAX_BYTES = 4 * 1024;

export const STEPS_ALREADY_RAN = "The steps so far already ran, so ask only for what's left.";
export const stoppedAfter = (count: string) => `Stopped after ${count} without a final answer. ${STEPS_ALREADY_RAN}`;
export const FENCE_AFTER_TOOLS = `Murage stopped this turn before its next step. ${STEPS_ALREADY_RAN}`;
export const TEXT_ONLY_NOTICE = "This model cannot use tools, so this bot is answering without them. Choose a model with tool support to let it use its tools.";
export const PERMISSION_DENIED = "Permission denied; the tool was not executed.";
export const TOOL_INTERRUPTED = "Tool interrupted; an operation already dispatched may have taken effect. Verify its state before retrying.";
export const SCREENSHOT_NOT_SHOWN = "Screenshot not shown: this engine reads text only";
export const TOOL_CALLS_TO_HELPER = "provider returned tool calls to a text-only helper";
export const NUDGE_ANNOUNCED_ACTION = "You said what you would do next but called no tool. Use your tools for only the remaining work, or reply with verified results if nothing is left to do. Never repeat an operation that succeeded, was denied, or may already have taken effect; inspect its state instead. Do not retry a destructive operation.";

// ── redaction (s8) ────────────────────────────────────────────────────────

/** Known secrets, longest first so a secret that contains another is removed whole. Empty and very short values are skipped:
 *  replacing every "a" would wreck the text and protect nothing. */
export function secretList(values: Iterable<string | undefined | null>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length < 4) continue;
    out.add(value);
    // its JSON-escaped form too: a secret with a quote or a backslash inside JSON text (a tool's text result, a model's arguments)
    // is written escaped, and the raw bytes would miss it (Astra code-r2)
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) out.add(escaped);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const MAX_SCRUB_DEPTH = 64;
const TOO_DEEP = "[omitted: nested too deep to check]";

const replaceKnown = (text: string, secrets: readonly string[]): string => {
  let out = text;
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  return out;
};
const scrubString = (text: string, secrets: readonly string[]): string => redactSecretsInText(replaceKnown(text, secrets));

/** s8: a deep copy of `value` with every known secret removed from each COMPLETE string, then the generic shape scrub. It runs
 *  on parsed values only, never on JSON text (escaping would change a secret's bytes), and never mutates its input. A subtree
 *  past the depth budget is dropped (fail closed), never handed back unchecked. */
export function scrubKnown<T>(value: T, secrets: readonly string[], depth = 0): T {
  if (typeof value === "string") return scrubString(value, secrets) as T;
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_SCRUB_DEPTH) return TOO_DEEP as T;
  if (Array.isArray(value)) return value.map((entry) => scrubKnown(entry, secrets, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[scrubString(key, secrets)] = scrubKnown(entry, secrets, depth + 1);
  return out as T;
}

/** s8, model-bound copies (the tool catalog, the assistant replay): a deep copy with every known secret removed from each
 *  string LEAF and nothing else changed. Keys stay as they are (a schema's property names are what the call is matched on), and
 *  no generic shape mask runs, so an account number or an example value the task needs reaches the model as written. */
export function scrubKnownLeaves<T>(value: T, secrets: readonly string[], depth = 0, keys = false): T {
  if (typeof value === "string") return replaceKnown(value, secrets) as T;
  if (value === null || typeof value !== "object" || !secrets.length) return value;
  if (depth > MAX_SCRUB_DEPTH) return TOO_DEEP as T;
  if (Array.isArray(value)) return value.map((entry) => scrubKnownLeaves(entry, secrets, depth + 1, keys)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[keys ? replaceKnown(key, secrets) : key] = scrubKnownLeaves(entry, secrets, depth + 1, keys);
  return out as T;
}

/** True when a known secret (raw or JSON-escaped) appears anywhere in `text`. */
export const namesSecret = (text: string, secrets: readonly string[]): boolean => secrets.some((secret) => text.includes(secret));

/** s8: the provider-facing copy of a call's JSON arguments. Parsed, scrubbed on its string leaves and serialized again (escaping
 *  inside JSON text would hide a secret from a text split); text that does not parse is scrubbed as text, raw and JSON-escaped.
 *  Arguments holding no known secret are returned byte for byte. The exact arguments that run are never this copy. */
export function providerArguments(text: string, secrets: readonly string[]): string {
  if (!secrets.length) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    // a replayed call's keys are the model's own words, never matched on: a secret used as a key is removed too (Astra code-r2)
    const scrubbed = scrubKnownLeaves(parsed, secrets, 0, true);
    const out = JSON.stringify(scrubbed);
    return out === JSON.stringify(parsed) ? text : out;
  } catch {
    let out = replaceKnown(text, secrets);
    for (const secret of secrets) {
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret && out.includes(escaped)) out = out.split(escaped).join("[redacted]");
    }
    return out;
  }
}

/** Cuts at a UTF-8 boundary, so a cap never leaves half a character. */
export function capUtf8(text: string, maxBytes: number, note = "\n[cut: the rest was too long]"): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + note;
}

/** Streamed text: complete secrets are replaced, and a suffix that could be the start of a secret is held back until the next
 *  chunk (or the flush) shows whether it is one, so a key split across deltas never reaches the screen. */
export class SecretStreamFilter {
  #held = "";
  private readonly secrets: readonly string[];
  // no parameter properties: the server runs under Node's type stripping, which refuses them
  constructor(secrets: readonly string[]) { this.secrets = secrets; }
  push(delta: string): string {
    let text = this.#held + delta;
    for (const secret of this.secrets) if (text.includes(secret)) text = text.split(secret).join("[redacted]");
    let hold = 0;
    for (const secret of this.secrets) {
      for (let size = Math.min(secret.length - 1, text.length); size > hold; size--) {
        if (text.endsWith(secret.slice(0, size))) { hold = size; break; }
      }
    }
    this.#held = hold ? text.slice(text.length - hold) : "";
    return hold ? text.slice(0, text.length - hold) : text;
  }
  flush(): string {
    const rest = this.#held;
    this.#held = "";
    return rest;
  }
}

// ── provider refusal readers (ported from upstream openai-chat.ts) ─────────

const errorEnvelope = (body: string): Record<string, unknown> | undefined => {
  try { return object(JSON.parse(body)); } catch { return undefined; }
};

/** The provider refused the `tools` parameter itself (not a tool call): the model is text-only. */
export function rejectsToolsParameter(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const envelope = errorEnvelope(body);
  const error = object(envelope?.error);
  if (error?.param === "tools" && (error.code === "unsupported_parameter" || error.type === "unsupported_parameter")) return true;
  const message = error?.message ?? envelope?.error;
  return typeof message === "string" && (
    /\bdoes not support (?:tools|tool calling|function calling)(?:[.!]?$|[.!]?\s)/i.test(message) ||
    /\b(?:tools|tool calling|function calling) (?:is|are) not supported\b/i.test(message) ||
    /^(?:unsupported|unknown|unrecognized) (?:parameter|field):?\s*['"]?tools['"]?[.!]?$/i.test(message.trim())
  );
}

/** DeepSeek-style servers need `reasoning_content` echoed on a tool-call message; others (Groq) reject it. */
export function rejectsReasoningReplay(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const envelope = errorEnvelope(body);
  const message = object(envelope?.error)?.message ?? envelope?.error;
  return typeof message === "string" && /\breasoning_content\b/.test(message) &&
    /\b(?:unsupported|not supported|unknown|unrecognized|unexpected|not permitted|not allowed)\b/i.test(message);
}

/** Groq refuses a completion with `tool_use_failed` when the call it generated was invalid; nothing ran. */
export function refusedToolCall(status: number, body: string): boolean {
  if (status !== 400) return false;
  return object(errorEnvelope(body)?.error)?.code === "tool_use_failed";
}

/** Small local models often announce an action and stop (upstream). */
export function announcesAction(text: string): boolean {
  const reply = text.trim();
  if (!reply || reply.length > 4_000 || reply.includes("?")) return false;
  if (reply.length > 400) {
    const tail = reply.split(/\n\s*\n/).at(-1)!.trim();
    return tail.length <= 400 && /^(?:let me|i['’]ll|i will|i(?:['’]m| am) going to)\s+(?:now\s+)?(?:execute|send|type|press|launch|open|check|inspect|read|fetch|run|create|write|verify)\b/i.test(tail);
  }
  return /(?:[:—–]|\.\.\.|…)$/.test(reply) ||
    /^(?:checking|let me(?! know\b)|i'll|i will|i'm going to|i am going to|opening|pulling|looking|searching|navigating|reading|fetching|loading|now (?:i'll|let me|opening|checking|pulling|reading))\b/i.test(reply) ||
    /^i(?:['’]m| am)\b[^.!?\n]*\band (?:i )?will\s+(?:launch|open|check|pull|look|search|navigate|read|fetch|load|run|inspect)\b/i.test(reply);
}

/** Loopback, private and tailnet addresses: where small local models live (announcement nudges are on only there). */
export function isLocalModelUrl(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return false; }
  return host === "localhost" || host === "::1" || host.endsWith(".local") || host.endsWith(".ts.net") || !host.includes(".") ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || /^f[cd][0-9a-f]{2}:/.test(host);
}

// ── remembered text-only models (s2) ──────────────────────────────────────

/** `(endpoint origin, model)` pairs whose provider refused `tools`, bounded LRU. In memory only: a restart probes again. */
export class TextOnlyModels {
  readonly #keys = new Map<string, true>();
  private readonly max: number;
  constructor(max = 256) { this.max = max; }
  static key(endpoint: string, model: string): string {
    let origin = endpoint;
    try { origin = new URL(endpoint).origin; } catch { /* the raw string identifies it */ }
    return `${origin}\u0000${model}`;
  }
  has(endpoint: string, model: string): boolean {
    const key = TextOnlyModels.key(endpoint, model);
    if (!this.#keys.has(key)) return false;
    this.#keys.delete(key);
    this.#keys.set(key, true);
    return true;
  }
  add(endpoint: string, model: string): void {
    const key = TextOnlyModels.key(endpoint, model);
    this.#keys.delete(key);
    this.#keys.set(key, true);
    while (this.#keys.size > this.max) this.#keys.delete(this.#keys.keys().next().value!);
  }
}

// ── the per-turn catalog (s1.3, s4) ───────────────────────────────────────

/** pi-mcp-extension.ts allocateToolName's rules, unchanged (that module is the Pi extension and loads Pi's own schema library, so
 *  it is not imported into the server): `${server}_${tool}` lowercased, 64 chars, a numeric suffix on a clash. */
const TOOL_NAME_MAX_LENGTH = 64;
export function allocateChatToolName(server: string, tool: string, used: Set<string>): string {
  const base = `${server}_${tool}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, TOOL_NAME_MAX_LENGTH) || "mcp_tool";
  let candidate = base;
  for (let suffixNumber = 2; used.has(candidate); suffixNumber += 1) {
    const suffix = `_${suffixNumber}`;
    candidate = `${base.slice(0, Math.max(1, TOOL_NAME_MAX_LENGTH - suffix.length))}${suffix}`;
  }
  return candidate;
}

export interface ChatToolRoute { session: ChatMcpSession; server: string; tool: string }
export interface ChatToolCatalog {
  definitions: Array<{ type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }>;
  routes: Map<string, ChatToolRoute>;
  /** Servers whose tools were left out whole, each with why (a half-mounted server is worse than an absent one). */
  dropped: Array<{ server: string; why: string }>;
}

/** The `tools` field for this turn, in mount order. A server over any cap is dropped whole, never truncated. Descriptions and
 *  schemas are model-bound, so every known secret is removed from their string leaves (s8) BEFORE the size caps are measured. */
export function chatToolCatalog(sessions: readonly ChatMcpSession[], secrets: readonly string[] = []): ChatToolCatalog {
  const catalog: ChatToolCatalog = { definitions: [], routes: new Map(), dropped: [] };
  const used = new Set<string>();
  let bytes = 2;
  for (const session of sessions) {
    if (session.tools.length > MAX_SERVER_TOOLS) { catalog.dropped.push({ server: session.server, why: `it offers more than ${MAX_SERVER_TOOLS} tools` }); continue; }
    if (catalog.definitions.length + session.tools.length > MAX_TURN_TOOLS) { catalog.dropped.push({ server: session.server, why: `this turn already has ${catalog.definitions.length} of ${MAX_TURN_TOOLS} tools` }); continue; }
    const taken = new Set(used);
    const defs: ChatToolCatalog["definitions"] = [];
    const routes: Array<[string, ChatToolRoute]> = [];
    let serverBytes = 0;
    let why = "";
    for (const tool of session.tools) {
      const parameters = scrubKnownLeaves(providerSafeInputSchema(tool.inputSchema), secrets);
      // a secret in a schema's keys or in the tool's name cannot be removed without changing what the call is matched on: the
      // server is left out, never sent (Astra code-r2)
      if (namesSecret(JSON.stringify(parameters), secrets) || namesSecret(tool.name, secrets)) { why = `its tool ${replaceKnown(tool.name, secrets).slice(0, 64)} names a value Murage keeps secret`; break; }
      if (Buffer.byteLength(JSON.stringify(parameters)) > MAX_TOOL_SCHEMA_BYTES) { why = `its tool ${tool.name.slice(0, 64)} has a schema over ${MAX_TOOL_SCHEMA_BYTES / 1024} KiB`; break; }
      const name = allocateChatToolName(session.server, tool.name, taken);
      taken.add(name);
      const description = typeof tool.description === "string" && tool.description ? replaceKnown(tool.description, secrets).slice(0, MAX_TOOL_DESCRIPTION_CHARS) : undefined;
      const def = { type: "function" as const, function: { name, ...(description ? { description } : {}), parameters } };
      serverBytes += Buffer.byteLength(JSON.stringify(def)) + 1;
      defs.push(def);
      routes.push([name, { session, server: session.server, tool: tool.name }]);
    }
    if (!why && bytes + serverBytes > MAX_TOOLS_JSON_BYTES) why = `its tool list would take this turn's tools past ${MAX_TOOLS_JSON_BYTES / 1024} KiB`;
    if (why) { catalog.dropped.push({ server: session.server, why }); continue; }
    bytes += serverBytes;
    for (const name of taken) used.add(name);
    catalog.definitions.push(...defs);
    for (const [name, route] of routes) catalog.routes.set(name, route);
  }
  return catalog;
}

// ── MCP child teardown per turn (s3 "Teardown ownership") ─────────────────

/** Every MCP child of every turn, tracked from spawn. TurnTeardowns keys ONE child per turn, so it is not reused for N. */
export class McpTurnTeardowns {
  readonly #byTurn = new Map<string, { threadId: string; children: Set<ChildTeardown> }>();

  track(threadId: string, turnId: string, teardown: ChildTeardown): void {
    if (teardown.closed) return;
    let entry = this.#byTurn.get(turnId);
    if (!entry) { entry = { threadId, children: new Set() }; this.#byTurn.set(turnId, entry); }
    entry.children.add(teardown);
    const owner = entry;
    teardown.onClosed(() => {
      owner.children.delete(teardown);
      if (!owner.children.size && this.#byTurn.get(turnId) === owner) this.#byTurn.delete(turnId);
    });
  }

  #children(threadId: string, turnId: string | undefined): ChildTeardown[] {
    const out: ChildTeardown[] = [];
    for (const [id, entry] of this.#byTurn) if (entry.threadId === threadId && (turnId === undefined || id === turnId)) out.push(...entry.children);
    return out;
  }

  pending(threadId: string, turnId?: string): boolean { return this.#children(threadId, turnId).length > 0; }

  /** Bounded: confirmed when every child closed within the budget; nothing tracked is confirmed. */
  wait(threadId: string, turnId: string | undefined, budget: TeardownWait): Promise<ProviderStopResult> {
    return combine(this.#children(threadId, turnId), budget);
  }

  waitAll(budget: TeardownWait): Promise<ProviderStopResult> {
    return combine([...this.#byTurn.values()].flatMap((entry) => [...entry.children]), budget);
  }

  /** Every child now tracked has closed, observed only through its confirmed tree stop; no timer. Captured at the call. */
  closed(threadId: string, turnId: string | undefined): Promise<void> {
    const children = this.#children(threadId, turnId);
    return Promise.all(children.map((teardown) => new Promise<void>((resolve) => teardown.onClosed(resolve)))).then(() => undefined);
  }
}
