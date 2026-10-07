// SPDX-License-Identifier: AGPL-3.0-or-later
/** Transport data only. Authority is established by the broker, never by an envelope. */
export const PROTOCOL_VERSION = 1 as const;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const BROWSER_EXTENSION_OPERATIONS = ["bind", "cdp", "attach", "detach", "navigate", "snapshot", "read", "click", "fill", "type", "press", "scroll", "hover", "drag", "select", "wait", "screenshot", "back", "forward", "reload", "share", "unshare", "pause", "resume", "stop", "status", "tab_new", "tab_close", "tab_list", "tab_switch", "retire"] as const;
export type BrowserExtensionOperation = typeof BROWSER_EXTENSION_OPERATIONS[number];
export type ExtensionJson = null | boolean | number | string | ExtensionJson[] | { [key: string]: ExtensionJson };
export type ExtensionObject = { [key: string]: ExtensionJson };
type BindingEnvelope = { version: 1; bindingId: string; generation: number };
export type BrowserExtensionHello = { version: 1; type: "hello"; profileId: string; browser: "chrome" | "edge" | "brave" | "chromium"; extensionVersion: string; capabilities: string[] };
export type BrowserExtensionCommand = BindingEnvelope & { type: "command"; id: string; operation: BrowserExtensionOperation; params: ExtensionObject };
export type BrowserExtensionResponse = BindingEnvelope & { type: "response"; id: string } & ({ result: ExtensionJson; error?: never } | { error: { code: string; message: string }; result?: never });
export type BrowserExtensionEvent = BindingEnvelope & { type: "event"; event: "status" | "cdp" | "navigation" | "takeover" | "stopped" | "paused" | "resumed" | "unshared" | "disconnected" | "notice"; data: ExtensionObject };
export type BrowserExtensionMessage = BrowserExtensionHello | BrowserExtensionCommand | BrowserExtensionResponse | BrowserExtensionEvent;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
function refuse(): never { throw new Error("Invalid browser extension message"); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function keys(value: Record<string, unknown>, expected: string[]) { if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) refuse(); }
function id(value: unknown) { if (typeof value !== "string" || !idPattern.test(value)) refuse(); }
function json(value: unknown, depth = 0, budget = { count: 0 }): void {
  // The byte cap (1 MiB) is the real bound; this only stops a pathological shape. A large page's
  // accessibility tree legitimately holds tens of thousands of values.
  if (++budget.count > 200000 || depth > 64) refuse();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) refuse(); return; }
  if (typeof value === "string") { if (value.length > MAX_MESSAGE_BYTES) refuse(); return; }
  if (Array.isArray(value)) { for (const item of value) json(item, depth + 1, budget); return; }
  if (!record(value)) refuse();
  for (const [key, item] of Object.entries(value)) { if (["__proto__", "constructor", "prototype"].includes(key) || key.length > 256) refuse(); json(item, depth + 1, budget); }
}
export function parseBrowserExtensionMessage(input: unknown): BrowserExtensionMessage {
  if (typeof input === "string") { if (new TextEncoder().encode(input).length > MAX_MESSAGE_BYTES) refuse(); try { input = JSON.parse(input); } catch { refuse(); } }
  json(input);
  if (!record(input) || input.version !== PROTOCOL_VERSION) refuse();
  if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_MESSAGE_BYTES) refuse();
  if (input.type === "hello") {
    keys(input, ["version", "type", "profileId", "browser", "extensionVersion", "capabilities"]); id(input.profileId);
    if (!["chrome", "edge", "brave", "chromium"].includes(String(input.browser)) || typeof input.extensionVersion !== "string" || !/^[0-9]+(?:\.[0-9]+){0,3}$/.test(input.extensionVersion) || input.extensionVersion.length > 32 || !Array.isArray(input.capabilities) || input.capabilities.length > 32) refuse();
    input.capabilities.forEach(id); if (new Set(input.capabilities).size !== input.capabilities.length) refuse();
  } else {
    id(input.bindingId); if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 1) refuse();
    if (input.type === "command") {
      keys(input, ["version", "type", "id", "bindingId", "generation", "operation", "params"]); id(input.id);
      if (!BROWSER_EXTENSION_OPERATIONS.includes(input.operation as BrowserExtensionOperation) || !record(input.params)) refuse();
    } else if (input.type === "response") {
      const error = Object.hasOwn(input, "error"); keys(input, ["version", "type", "id", "bindingId", "generation", error ? "error" : "result"]); id(input.id);
      if (error) { if (!record(input.error)) refuse(); keys(input.error, ["code", "message"]); id(input.error.code); if (typeof input.error.message !== "string" || input.error.message.length > 2048) refuse(); }
    } else if (input.type === "event") {
      keys(input, ["version", "type", "bindingId", "generation", "event", "data"]);
      if (!["status", "cdp", "navigation", "takeover", "stopped", "paused", "resumed", "unshared", "disconnected", "notice"].includes(String(input.event)) || !record(input.data)) refuse();
    } else refuse();
  }
  return structuredClone(input) as BrowserExtensionMessage;
}
export function encodeBrowserExtensionMessage(message: BrowserExtensionMessage): string { return JSON.stringify(parseBrowserExtensionMessage(message)); }

/** Native connection replay ordering; the authenticated channel supplies identity. */
export function orderedBrowserRequestId(nonce: string, sequence: number): string {
  if (!/^[a-f0-9]{32}$/.test(nonce) || !Number.isSafeInteger(sequence) || sequence < 1) throw Error("invalid_request_sequence");
  return `${nonce}_${sequence}`;
}
export function parseOrderedBrowserRequestId(id: string): { nonce: string; sequence: number } | undefined {
  const match = /^([a-f0-9]{32})_([1-9][0-9]{0,15})$/.exec(id);
  if (!match) return;
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence)) return;
  return { nonce: match[1], sequence };
}

/** How long the extension waits for one CDP command before it gives up on that command.
 * Navigation, screenshots and awaited scripts are legitimately slow; everything else is not. */
export function browserCommandDeadlineMs(method: string, params: Record<string, unknown> | undefined): number {
  if (method === "Page.navigate" || method === "Page.reload" || method === "Page.navigateToHistoryEntry") return 60_000;
  if (method === "Page.captureScreenshot") return 30_000;
  if ((method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") && params?.awaitPromise === true) return 60_000;
  return 15_000;
}
/** Bytes a result takes on the native wire: Chrome's JSON writer escapes < and > as \u003C and \u003E. */
export function nativeWireBytes(value: unknown): number {
  const text = JSON.stringify(value) ?? "null";
  return new TextEncoder().encode(text).length + 5 * (text.match(/[<>\u2028\u2029]/g)?.length ?? 0);
}
/** Largest result the extension returns: one frame minus the envelope and the identity fields. */
export const MAX_RESULT_BYTES = MAX_MESSAGE_BYTES - 32 * 1024;

/** How long a card waits for a person to decide. Execution deadlines (browserCommandDeadlineMs) are separate. */
export const HUMAN_DECISION_MS = 120_000;

/** A tool call can wait for site access and then action approval, plus one bounded execution window. */
export const BROWSER_EXTENSION_CALL_TIMEOUT_MS = HUMAN_DECISION_MS * 2 + 60_000;

/** Lifecycle handshake (T44). The extension declares lifecycle_v1 today; the planned names are declared only when their code ships. */
export const BROWSER_EXTENSION_LIFECYCLE_CAPABILITY = "lifecycle_v1" as const;
export const BROWSER_EXTENSION_PLANNED_CAPABILITIES = ["levels_v1", "presence_v1", "handoff_v1", "upload_token_v1"] as const;
/** The oldest app protocol this extension binds to; an older app is refused with "update_murage". */
export const BROWSER_MIN_APP_PROTOCOL = 1;
/** The protocol this app speaks. It is sent in every bind so an extension that needs a newer app can refuse plainly. */
export const BROWSER_APP_PROTOCOL = 1;
