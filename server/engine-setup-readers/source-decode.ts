// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F5n (Q-K5, design docs/designs/1023-mcp-k5 r3): adapters for MCP servers set up in Claude Desktop, Cursor and Gemini CLI.
// Owners: this file is R-K5 (producer; consumers pack slice R and U-K5). Pure: bytes in, a plan out. Nothing here opens a
// file, reads the environment or resolves a reference. Every item is either copied exactly (section 3.3, promise 3) or
// refused by name with a reason category and the offending field NAMES (never values).
import { createHash } from "node:crypto";

import { disabledReasonFor, looksSecret, planServer, shownName, MAX_IMPORT_SERVERS, MAX_JSON_DEPTH, type PlannedServer } from "../claude-code-import.ts";

export type SourceKind = "claude-desktop" | "cursor" | "gemini";
export const SOURCE_KINDS: readonly SourceKind[] = ["claude-desktop", "cursor", "gemini"];
export const SOURCE_LABEL: Record<SourceKind, string> = { "claude-desktop": "Claude Desktop", cursor: "Cursor", gemini: "Gemini CLI" };

/** Refusal categories (section 6 `.refused.*`). */
export type RefusalReason =
  | "murage-itself" | "tool-filter" | "oauth" | "key-file" | "needs-folder" | "unconfirmed-transport"
  | "key-in-command-line" | "key-in-address" | "cant-copy-setting" | "cant-copy";
const REASON_ORDER: readonly RefusalReason[] = ["murage-itself", "tool-filter", "oauth", "key-file", "needs-folder", "unconfirmed-transport", "key-in-command-line", "key-in-address", "cant-copy-setting", "cant-copy"];

/** A refused item: field names pass the display rule, else null ("an unnamed setting"). */
export interface RefusedItem { name: string; reason: RefusalReason; fields: Array<string | null> }
/** Opus r3 M1: what shape a slot expects, never its value: the auth word in front and the source variable's name. */
export interface SlotHint { prefix?: "Bearer" | "Basic" | "Token"; from?: string }
export interface SourceServer { name: string; plan: PlannedServer; slotHints: Record<string, SlotHint>; trustDropped: boolean }
export interface DecodedSource { servers: SourceServer[]; refused: RefusedItem[] }
export type DecodeResult = DecodedSource | { error: "couldNotRead" };

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
/** Section 3.1 display rule: a key is named only when it is name-shaped and not secret-shaped. */
export function displayField(key: string): string | null {
  return FIELD_NAME.test(key) && !looksSecret(key) ? key : null;
}

// ------------------------------------------------------------------ parsing (3.1 Values)

/** Strip `//` and `/* *\/` comments outside JSON strings (Gemini only). Throws on an unterminated comment or string. */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      if (i >= text.length) throw new Error("unterminated string");
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("unterminated comment");
      out += " ";
      i = end + 2;
    } else { out += c; i++; }
  }
  return out;
}

function depthWithin(value: unknown, depth: number): boolean {
  if (depth > MAX_JSON_DEPTH + 1) return false;
  return value === null || typeof value !== "object" || Object.values(value).every((child) => depthWithin(child, depth + 1));
}

/** The file's `mcpServers` object only (every other key is never decoded). undefined = absent; throws on any parse failure. */
export function sourceMcpServers(kind: SourceKind, bytes: Uint8Array): Record<string, unknown> | undefined {
  let view = bytes;
  if (view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) view = view.subarray(3);
  let text = new TextDecoder("utf-8", { fatal: true }).decode(view);
  if (kind === "gemini") text = stripJsonComments(text);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  if (!Object.hasOwn(parsed, "mcpServers")) return undefined;
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers) || !depthWithin(servers, 1)) throw new Error("bad mcpServers");
  return servers as Record<string, unknown>;
}

// ------------------------------------------------------------------ closed key lists (3.1)

const ACCEPTED: Record<SourceKind, ReadonlySet<string>> = {
  "claude-desktop": new Set(["command", "args", "env"]),
  cursor: new Set(["command", "args", "env", "url", "headers", "type"]),
  gemini: new Set(["command", "args", "env", "headers"]),
};
const IGNORED: Record<SourceKind, ReadonlySet<string>> = {
  "claude-desktop": new Set(), cursor: new Set(), gemini: new Set(["timeout", "description", "trust"]),
};
const NAMED: Record<SourceKind, Readonly<Record<string, RefusalReason>>> = {
  "claude-desktop": {},
  cursor: { envFile: "key-file", auth: "oauth" },
  gemini: {
    includeTools: "tool-filter", excludeTools: "tool-filter", oauth: "oauth", authProviderType: "oauth", targetAudience: "oauth",
    targetServiceAccount: "oauth", cwd: "needs-folder",
    // X10 open: how the pinned Gemini CLI connects to a remote entry is unproven (section 3.2).
    url: "unconfirmed-transport", httpUrl: "unconfirmed-transport",
  },
};
/** X10 (Gemini remote transport) evidence. OPEN NO-OWNER: until it lands, Gemini `url`/`httpUrl` are refused by name. */
export const X10_GEMINI_REMOTE_PROVEN = false;

// ------------------------------------------------------------------ references (3.1 interpolation)

const ENV_ALLOW = new Set(["LANG", "LC_ALL", "LC_CTYPE", "TZ", "PATH", "DEBUG", "NODE_ENV", "LOG_LEVEL", "NO_COLOR", "FORCE_COLOR", "PYTHONUNBUFFERED", "CI"]);
const VAR = "[A-Za-z_][A-Za-z0-9_]*";
/** Whole-value single reference, with its variable name. Gemini also expands `%NAME%` on Windows (Fable r3 M1): treated the same, fail closed. */
const WHOLE_REF: Record<SourceKind, RegExp> = {
  "claude-desktop": /^(?!)$/,
  cursor: new RegExp(`^\\$\\{env:(${VAR})\\}$`),
  gemini: new RegExp(`^(?:\\$(${VAR})|\\$\\{(${VAR})\\}|%(${VAR})%)$`),
};
const ANY_REF: Record<SourceKind, RegExp> = {
  "claude-desktop": /^(?!)$/,
  // Cursor: `${env:X}` and every other placeholder (`${userHome}`, `${workspaceFolder}`, ...).
  cursor: /\$\{/,
  gemini: new RegExp(`\\$${VAR}|\\$\\{${VAR}\\}|%${VAR}%`),
};
function refName(kind: SourceKind, value: string): string | undefined {
  const match = WHOLE_REF[kind].exec(value);
  return match ? match.slice(1).find((part) => part !== undefined) : undefined;
}
function slotHint(kind: SourceKind, value: unknown): SlotHint {
  if (typeof value !== "string") return {};
  const hint: SlotHint = {};
  let rest = value;
  const prefix = /^(Bearer|Basic|Token) +(.*)$/.exec(value);
  if (prefix) { hint.prefix = prefix[1] as SlotHint["prefix"]; rest = prefix[2]!; }
  const from = refName(kind, rest);
  if (from !== undefined) { const shown = displayField(from); if (shown) hint.from = shown; }
  return hint;
}

// ------------------------------------------------------------------ one item

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => !!value && typeof value === "object" && !Array.isArray(value);
const allStrings = (value: Plain) => Object.values(value).every((entry) => typeof entry === "string");
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === a.length && a.every((key) => b.includes(key));
const MURAGE_ENV = /^(MURAGE_|ELECTRON_RUN_AS_NODE$)/i;
/** Fable r3 H1: the `mcp-server.js` rule applies only when the command is the Murage executable, so a third-party server whose entry file
 *  shares that common name is never called Murage. */
function isMurageExecutable(command: string): boolean {
  const base = command.split(/[\\/]/).pop() ?? "";
  return /^murage(\.exe)?$/i.test(base);
}

class Refusal {
  readonly found: Array<{ reason: RefusalReason; field: string }> = [];
  add(reason: RefusalReason, field: string) { this.found.push({ reason, field }); }
  get any() { return this.found.length > 0; }
  item(name: string): RefusedItem {
    const reason = REASON_ORDER.find((candidate) => this.found.some((entry) => entry.reason === candidate))!;
    const fields = [...new Set(this.found.map((entry) => entry.field))].map(displayField);
    return { name: shownName(name), reason, fields };
  }
}

/** Decode one entry: closed key list → normalise (3.2) → planServer with the source label → exactness and invariant E (3.3). */
export function decodeServer(kind: SourceKind, name: string, raw: unknown, taken: readonly string[]): SourceServer | RefusedItem {
  const refusal = new Refusal();
  if (!isPlain(raw)) return { name: shownName(name), reason: "cant-copy", fields: [] };
  for (const key of Object.keys(raw)) {
    if (ACCEPTED[kind].has(key) || IGNORED[kind].has(key)) continue;
    refusal.add(NAMED[kind][key] ?? "cant-copy-setting", key);
  }
  // Murage's own packaged entry (docs/mcp-server.md): a copy would launch the app binary.
  const env = raw.env;
  if (isPlain(env) && Object.keys(env).some((key) => MURAGE_ENV.test(key))) refusal.add("murage-itself", "env");
  if (typeof raw.command === "string" && isMurageExecutable(raw.command.trim()) && Array.isArray(raw.args)
    && raw.args.some((arg) => typeof arg === "string" && arg.endsWith("mcp-server.js"))) refusal.add("murage-itself", "args");
  // Invariant E, types.
  if (raw.command !== undefined && typeof raw.command !== "string") refusal.add("cant-copy-setting", "command");
  if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === "string"))) refusal.add("cant-copy-setting", "args");
  for (const key of ["env", "headers"] as const) if (raw[key] !== undefined && !(isPlain(raw[key]) && allStrings(raw[key] as Plain))) refusal.add("cant-copy-setting", key);
  for (const key of ["command", "url"] as const) if (typeof raw[key] === "string" && (raw[key] as string).trim() !== raw[key]) refusal.add("cant-copy-setting", key);
  // Transport (3.2).
  const shapes = (["command", "url", "httpUrl"] as const).filter((key) => raw[key] !== undefined);
  if (shapes.length > 1) for (const key of shapes) refusal.add("cant-copy-setting", key);
  const remote = kind === "cursor" && raw.url !== undefined;
  let transport: "local" | "http" | "sse" = "local";
  if (kind === "cursor") {
    const type = raw.type;
    if (type !== undefined && typeof type !== "string") refusal.add("cant-copy-setting", "type");
    else if (remote) {
      if (type === undefined || type === "http" || type === "streamable-http") transport = "http";
      else if (type === "sse") transport = "sse";
      else refusal.add("cant-copy-setting", "type");
    } else if (type !== undefined && type !== "stdio") refusal.add("cant-copy-setting", "type");
  }
  if (!remote && raw.command === undefined && !refusal.any) refusal.add("cant-copy", "command");
  // References where a value is kept literally: command, args, url (and the allow-listed env keys below).
  const literal = (value: unknown, field: string) => { if (typeof value === "string" && ANY_REF[kind].test(value)) refusal.add("cant-copy-setting", field); };
  literal(raw.command, "command");
  literal(raw.url, "url");
  if (Array.isArray(raw.args)) for (const arg of raw.args) literal(arg, "args");
  // Local entries carry no headers, remote entries no env: planServer would drop them (r3 own pass).
  if (!remote && raw.command !== undefined && isPlain(raw.headers) && Object.keys(raw.headers).length) refusal.add("cant-copy-setting", "headers");
  if (remote && isPlain(raw.env) && Object.keys(raw.env).length) refusal.add("cant-copy-setting", "env");
  if (remote && Array.isArray(raw.args) && raw.args.length) refusal.add("cant-copy-setting", "args");
  if (refusal.any) return refusal.item(name);

  // Normalise. An allow-listed env key whose value is one whole reference becomes its slot (passed as a non-string so planServer makes a slot).
  const inputEnv = (raw.env ?? {}) as Record<string, string>;
  const inputHeaders = (raw.headers ?? {}) as Record<string, string>;
  const normalised: Plain = remote
    ? { url: raw.url, type: transport, headers: inputHeaders }
    : { command: raw.command, args: raw.args ?? [], env: Object.fromEntries(Object.entries(inputEnv).map(([key, value]) => {
      if (!ENV_ALLOW.has(key)) return [key, value];
      if (refName(kind, value) !== undefined) return [key, null];
      if (ANY_REF[kind].test(value)) refusal.add("cant-copy-setting", key);
      return [key, value];
    })) };
  if (refusal.any) return refusal.item(name);
  const plan = planServer(name, normalised, taken, disabledReasonFor(SOURCE_LABEL[kind]));
  if (!plan) return { name: shownName(name), reason: "cant-copy", fields: [] };
  const entry = plan.entry;
  if (remote) {
    if (entry.url !== raw.url) refusal.add("key-in-address", "url");
    if (entry.transport !== transport) refusal.add("cant-copy-setting", "type");
    const pendingHeaders = (entry.pendingHeaders ?? []) as string[];
    if (!sameSet(pendingHeaders, Object.keys(inputHeaders))) for (const key of Object.keys(inputHeaders)) if (!pendingHeaders.includes(key)) refusal.add("cant-copy-setting", key);
    if (Object.keys(inputHeaders).length > 16) refusal.add("cant-copy-setting", "headers");
  } else {
    const args = (raw.args ?? []) as string[];
    const planned = (entry.args ?? []) as string[];
    if (entry.command !== raw.command) refusal.add("cant-copy-setting", "command");
    if (planned.length !== args.length || planned.some((arg, index) => arg !== args[index])) {
      // planServer clears every arg when there are too many or one is too long, and when one looks secret (Opus r3 Low: two reasons).
      refusal.add(args.length > 64 || args.some((arg) => arg.length > 4096) ? "cant-copy-setting" : "key-in-command-line", "args");
    }
    const kept = (entry.env ?? {}) as Record<string, string>;
    const pendingEnv = (entry.pendingEnv ?? []) as string[];
    const stored = [...Object.keys(kept), ...pendingEnv];
    for (const key of Object.keys(inputEnv)) if (!stored.includes(key)) refusal.add("cant-copy-setting", key);
    if (!refusal.any && (new Set(stored).size !== stored.length || stored.length !== Object.keys(inputEnv).length)) refusal.add("cant-copy-setting", "env");
    for (const [key, value] of Object.entries(kept)) if (inputEnv[key] !== value) refusal.add("cant-copy-setting", key);
  }
  if (refusal.any) return refusal.item(name);
  const slotHints: Record<string, SlotHint> = {};
  const slotSource = remote ? inputHeaders : inputEnv;
  for (const key of [...((entry.pendingEnv ?? []) as string[]), ...((entry.pendingHeaders ?? []) as string[])]) {
    const hint = slotHint(kind, slotSource[key]);
    if (hint.prefix || hint.from) slotHints[key] = hint;
  }
  return { name, plan, slotHints, trustDropped: kind === "gemini" && raw.trust === true };
}

/** Decode one source file. A parse failure is the whole source ("Couldn't read {app}"), never a partial result.
 *  `existingNames` are the slugs already in Murage. Pack R's Check/Update must leave out the item's OWN earlier copies (its import
 *  record's slug), or every copied item would read as taken ("cant-copy") and be held as changed (review #6). */
export function decodeSource(kind: SourceKind, bytes: Uint8Array, existingNames: readonly string[]): DecodeResult {
  let servers: Record<string, unknown> | undefined;
  try { servers = sourceMcpServers(kind, bytes); } catch { return { error: "couldNotRead" }; }
  const result: DecodedSource = { servers: [], refused: [] };
  if (!servers) return result;
  const taken = [...existingNames];
  const names = Object.keys(servers).sort();
  for (const name of names.slice(0, MAX_IMPORT_SERVERS)) {
    const decoded = decodeServer(kind, name, servers[name], taken);
    if ("plan" in decoded) { result.servers.push(decoded); taken.push(decoded.plan.slug); } else result.refused.push(decoded);
  }
  for (const name of names.slice(MAX_IMPORT_SERVERS)) result.refused.push({ name: shownName(name), reason: "cant-copy", fields: [] });
  return result;
}

/** The source revision (section 3.3): the sanitized execution shapes and refusals only; never the label, other file keys or ignored keys. */
export function sourceRevision(decoded: DecodedSource): string {
  const shapes = decoded.servers.map(({ plan }) => {
    const { disabledReason: _label, ...entry } = plan.entry;
    return [plan.slug, entry];
  });
  return createHash("sha256").update(JSON.stringify([shapes, decoded.refused])).digest("hex");
}
