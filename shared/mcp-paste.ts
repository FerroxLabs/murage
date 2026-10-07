// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The paste parser for the MCP servers tab (spec MCP-LINK 3.10). One input takes
// a link, a command line or a JSON config snippet, and this module turns it
// into drafts the panel can show as cards.
//
// It is pure. It runs nothing, expands nothing and makes no network request:
// commands are tokenized, never handed to a shell, and `$VAR`, `${VAR}` and
// `$(...)` stay text. The renderer uses it for the live preview and the server
// parses again as the authority, so it must give the same answer in both places
// and import only the shared token rule (mcp-secret-url.mjs), which is pure too.
import { displayUrl, urlHasSecret } from "./mcp-secret-url.mjs";

export const MAX_PASTE_BYTES = 64 * 1024;
export const MAX_PASTE_SERVERS = 20;

export type PasteFieldWhere =
  | { type: "env"; name: string }
  | { type: "header"; name: string; prefix?: string };

/** One value the owner may need to fill in or check. Every environment value of
 * a stdio draft and every header of a remote draft is a field, secret or not.
 * A literal value in the paste is carried so nobody retypes it. */
export interface PasteField {
  id: string;
  label: string;
  secret: boolean;
  /** The pasted value was a placeholder such as <token> or YOUR_KEY_HERE. */
  placeholder: boolean;
  value?: string;
  where: PasteFieldWhere;
}

export interface PasteStdioDraft {
  kind: "stdio";
  name: string;
  command: string;
  args: string[];
  fields: PasteField[];
}

export interface PasteRemoteDraft {
  kind: "remote";
  name: string;
  /** As pasted. It may hold a secret: show `maskedUrl`, never this. */
  url: string;
  maskedUrl: string;
  urlHasSecret: boolean;
  transport?: "http" | "sse";
  fields: PasteField[];
  /** Set when the paste was a bridge command (mcp-remote, mcp-proxy) that Murage replaced with a link. */
  convertedFrom?: "mcp-remote" | "mcp-proxy";
}

export type PasteDraft = PasteStdioDraft | PasteRemoteDraft;

export type PasteFailureReason =
  | "empty"
  | "too-large"
  | "too-many"
  | "toml"
  | "yaml"
  | "invalid-json"
  | "invalid-entry"
  | "multi-command"
  | "shell-syntax"
  | "unterminated-quote"
  | "unrecognized";

/** What a note is about, so the panel can show it in the owner's language:
 * its catalogue key is `mcp.paste.note.<key>`, filled with `entry` and `field`. */
export type PasteNoteKey = "ignoredKey" | "ignoredEnv" | "skippedNothing" | "skippedBoth" | "skippedLink" | "skippedArgs";
export interface PasteNote {
  key: PasteNoteKey;
  /** The entry's name as pasted. */
  entry: string;
  /** For ignoredKey: the key that was ignored. */
  field?: string;
}

/** `notes` is the English text of `noteKeys`, one for one (formatPasteNote).
 * A refusal's catalogue key is `mcp.paste.fail.<reason>`. */
export type PasteResult =
  | { ok: true; source: "link" | "json" | "command"; drafts: PasteDraft[]; notes: string[]; noteKeys: PasteNote[] }
  | { ok: false; reason: PasteFailureReason; message: string };

export interface PasteOptions {
  /** True when a name is already in use or reserved. Used to pick "-2", "-3". */
  isNameTaken?: (name: string) => boolean;
}

/** Every sentence this module can show. One place so the copy can be linted. */
export const PASTE_MESSAGES: Record<PasteFailureReason, string> = {
  empty: "Paste a link, a command, or a config snippet.",
  "too-large": "That is more than 64 KiB. Paste just the part for the server you want.",
  "too-many": "That snippet has more than 20 servers. Paste fewer at a time.",
  toml: "Codex config.toml files are not supported yet. Paste the server's link or its command instead.",
  yaml: "YAML config is not supported. Paste the server's link, its command, or a JSON snippet instead.",
  "invalid-json": "That looks like JSON but could not be read. Check for a missing bracket or quote.",
  "invalid-entry": "None of the servers in that snippet has a command or a link.",
  "multi-command": "Paste one command at a time.",
  "shell-syntax": "Paste a single command without pipes, redirects, or substitutions. Murage runs it directly, not through a shell.",
  "unterminated-quote": "That command has a quote that is never closed.",
  unrecognized: "Murage could not tell what that is. Paste a link, a command, or a config snippet.",
};

/** The English of every note, with {entry} and {field} to fill. The catalogue
 * holds the same text under `mcp.paste.note.<key>` (a test keeps them equal). */
export const PASTE_NOTE_TEMPLATES: Record<PasteNoteKey, string> = {
  ignoredKey: 'Ignored "{field}" in {entry}.',
  ignoredEnv: "Ignored the environment values of {entry}: a link has none.",
  skippedNothing: 'Skipped "{entry}": it has no command or link.',
  skippedBoth: 'Skipped "{entry}": it has both a command and a link. Paste only the one you meant.',
  skippedLink: 'Skipped "{entry}": its link is not an http or https address.',
  skippedArgs: 'Skipped "{entry}": its arguments are not a list of text.',
};

/** Fill a note template. `template` defaults to the English one; the panel
 * passes the translated one. */
export function formatPasteNote(note: PasteNote, template: string = PASTE_NOTE_TEMPLATES[note.key]): string {
  return template.replace(/\{(entry|field)\}/g, (_match, name: "entry" | "field") => (name === "entry" ? note.entry : note.field ?? ""));
}

function fail(reason: PasteFailureReason): PasteResult {
  return { ok: false, reason, message: PASTE_MESSAGES[reason] };
}

function succeed(source: "link" | "json" | "command", drafts: PasteDraft[], noteKeys: PasteNote[]): PasteResult {
  return { ok: true, source, drafts, notes: noteKeys.map((note) => formatPasteNote(note)), noteKeys };
}

// ── small helpers ───────────────────────────────────────────────────────

/** Assign without ever touching the prototype, whatever the key is. */
function put<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SECRET_NAME = /key|token|secret|password|passwd|private|signing|auth|credential|bearer|cookie|session|(^|[_-])(pat|pass|pwd|dsn)($|[_-])/i;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

const VENDOR_PREFIX = /^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|sk-|sk_live_|pk_live_|rk_live_|xox[abprs]-|AKIA[0-9A-Z]{8}|ASIA[0-9A-Z]{8}|AIza[0-9A-Za-z_-]{10}|glpat-|npm_[A-Za-z0-9]{10}|eyJ[A-Za-z0-9_-]{8,}\.)/;
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A value that reads as a credential whatever its name is: a vendor key
 * prefix, a URL with a password, a JWT, or a long high-entropy string. */
export function looksSecretValue(value: string): boolean {
  const text = value.trim();
  if (!text || /\s/.test(text)) return false;
  if (VENDOR_PREFIX.test(text) || URL_WITH_PASSWORD.test(text)) return true;
  if (text.length < 32 || text.length > 512 || !/^[A-Za-z0-9_+/=.~-]+$/.test(text)) return false;
  const hasLetter = /[A-Za-z]/.test(text);
  const hasDigit = /[0-9]/.test(text);
  return hasLetter && hasDigit && shannonEntropy(text) >= 3.6;
}

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^<[^<>]*>$/,
  /^your[_-]/i,
  /_here$/i,
  /^\$\{[^}]*\}$/,
  /^\$[A-Za-z_][A-Za-z0-9_]*$/,
  /^x{3,}$/i,
  /^\*+$/,
  /^(\.{3}|…)$/,
];

export function isPlaceholder(value: string): boolean {
  const text = value.trim();
  return text === "" || PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text));
}

function placeholderLabel(value: string, inputs: ReadonlyMap<string, string>): string | null {
  const text = value.trim();
  const input = /^\$\{input:([^}]+)\}$/.exec(text);
  if (input) return inputs.get(input[1]!) ?? input[1]!;
  const env = /^\$\{env:([^}]+)\}$/.exec(text) ?? /^\$\{([^}:]+)\}$/.exec(text) ?? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
  return env ? env[1]! : null;
}

function describeUrl(raw: string): { ok: true; hostname: string; maskedUrl: string; urlHasSecret: boolean } | { ok: false } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false };
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return { ok: false };
  return { ok: true, hostname: url.hostname, maskedUrl: displayUrl(raw), urlHasSecret: urlHasSecret(raw) };
}

// ── names ───────────────────────────────────────────────────────────────

const HOST_PREFIXES = new Set(["www", "mcp", "api", "cloud", "app"]);
const TWO_PART_TLDS = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "co.nz", "co.jp", "com.br", "co.in", "co.za"]);
/** A registrable label that is not what people call the service. */
const HOST_LABEL_ALIASES: Readonly<Record<string, string>> = { githubcopilot: "github" };
/** Path segments that say nothing about which server it is. */
const GENERIC_PATH_SEGMENTS = new Set(["mcp", "sse", "api", "v1", "v2", "v3", "messages", "message", "stream", "http", "rpc", "server", "s"]);

const isAddressHost = (text: string) => text.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(text);

/** `cloud.comfy.org` gives `comfy`: drop the public suffix, then leading
 * service labels (www, mcp, api, cloud, app), then take the last label left.
 * An address (127.0.0.1, ::1) says nothing about the service: `local`. */
export function deriveNameFromHost(host: string): string {
  const text = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  if (!text) return "server";
  if (isAddressHost(text)) return "local";
  let labels = text.split(".");
  if (labels.length === 1) return labels[0] ?? "server";
  const lastTwo = labels.slice(-2).join(".");
  labels = labels.slice(0, TWO_PART_TLDS.has(lastTwo) ? -2 : -1);
  while (labels.length > 1 && HOST_PREFIXES.has(labels[0]!)) labels.shift();
  const label = labels[labels.length - 1] ?? "server";
  return HOST_LABEL_ALIASES[label] ?? label;
}

/** A link's name: from its host, or, when the host is only an address, from
 * the first path segment that names something (`http://10.0.0.2/notes/mcp`
 * gives `notes`), else `local`. */
export function deriveNameFromUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "server";
  }
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (!isAddressHost(host)) return deriveNameFromHost(host);
  const named = url.pathname.split("/").map((segment) => {
    try { return decodeURIComponent(segment).toLowerCase(); } catch { return ""; }
  }).find((segment) => /^[a-z][a-z0-9_-]{1,31}$/.test(segment) && !GENERIC_PATH_SEGMENTS.has(segment));
  return named ?? "local";
}

/** Fit a name to the registry rule: a lowercase letter, then letters, digits,
 * underscore or hyphen, at most 32. */
export function sanitizeServerName(raw: string): string {
  let name = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!name) return "server";
  if (!/^[a-z]/.test(name)) name = `mcp-${name}`;
  return name.slice(0, 32).replace(/[-_]+$/, "") || "server";
}

function uniqueName(base: string, used: Set<string>, options: PasteOptions): string {
  const clean = sanitizeServerName(base);
  const taken = (name: string) => used.has(name) || (options.isNameTaken?.(name) ?? false);
  let name = clean;
  for (let n = 2; taken(name); n += 1) {
    const suffix = `-${n}`;
    name = `${clean.slice(0, 32 - suffix.length)}${suffix}`;
  }
  used.add(name);
  return name;
}

const PACKAGE_DECORATIONS = /^(?:mcp-server-|server-|mcp-)|(?:-mcp-server|-mcp|-server)$/g;

/** `@scope/pkg@1.2` gives `pkg`; `ghcr.io/acme/image:tag` gives `image`. The
 * usual decorations go (`server-github`, `mcp-server-time`, `context7-mcp`),
 * and a package that is only `mcp` takes its scope's name (`@playwright/mcp`). */
function nameFromPackage(spec: string): string {
  const withoutVersion = spec.replace(/^(@?[^@]+)@.*$/, "$1");
  const parts = withoutVersion.split("/");
  const last = (parts.pop() ?? withoutVersion).replace(/:[^:]*$/, "");
  const generic = (name: string) => name === "" || name === "mcp" || name === "server" || name === "mcp-server";
  const bare = last.replace(PACKAGE_DECORATIONS, "");
  if (!generic(bare) && bare !== last) return bare;
  const scope = parts.length > 0 && parts[0]!.startsWith("@") ? parts[0]!.slice(1) : "";
  if (generic(bare) && scope) return scope;
  return last;
}

const INTERPRETERS = new Set(["node", "nodejs", "deno", "bun", "python", "python3", "tsx", "ts-node"]);
const GENERIC_SCRIPT_NAMES = new Set(["index", "main", "server", "cli", "app", "start", "run", "mcp"]);

/** `node ./notes.mjs` gives `notes`; `node /opt/my server/index.js` gives the
 * folder, `my server`, because `index` names nothing. */
function nameFromScript(args: readonly string[]): string | null {
  const script = args.find((arg) => !arg.startsWith("-") && /\.(m?[jt]s|c[jt]s|py)$/i.test(arg));
  if (!script) return null;
  const parts = script.split(/[\\/]/).filter((part) => part && part !== "." && part !== "..");
  const base = (parts.pop() ?? "").replace(/\.[^.]+$/, "");
  if (base && !GENERIC_SCRIPT_NAMES.has(base.toLowerCase())) return base;
  return parts.pop() ?? null;
}

// ── fields ──────────────────────────────────────────────────────────────

const AUTH_PREFIX = /^(Bearer|Basic|Token)\s+/i;

interface FieldContext {
  inputs: ReadonlyMap<string, string>;
  /** Environment of the entry, for ${NAME} in a bridge header. */
  env?: Record<string, string>;
  usedEnv?: Set<string>;
}

function makeField(where: PasteFieldWhere, rawValue: string | undefined, context: FieldContext): PasteField {
  let value = rawValue ?? "";
  if (context.env) {
    const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim()) ?? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim().replace(/^(Bearer|Basic|Token)\s+/i, ""));
    if (reference && Object.hasOwn(context.env, reference[1]!)) {
      const replacement = context.env[reference[1]!]!;
      context.usedEnv?.add(reference[1]!);
      value = value.trim() === reference[0] ? replacement : value.replace(reference[0], replacement);
    }
  }
  let whereOut: PasteFieldWhere = where;
  if (where.type === "header" && where.name.toLowerCase() === "authorization") {
    const prefix = AUTH_PREFIX.exec(value);
    if (prefix) {
      whereOut = { type: "header", name: where.name, prefix: `${prefix[1]} ` };
      value = value.slice(prefix[0].length);
    }
  }
  const placeholder = isPlaceholder(value);
  const secret = placeholder || isSecretName(where.name) || looksSecretValue(value);
  const fromPlaceholder = placeholder ? placeholderLabel(value, context.inputs) : null;
  const field: PasteField = {
    id: `${where.type}:${where.name}`,
    label: fromPlaceholder ?? where.name,
    secret,
    placeholder,
    where: whereOut,
  };
  if (!placeholder) field.value = value;
  return field;
}

// ── command lines ───────────────────────────────────────────────────────

export type TokenizeResult =
  | { ok: true; tokens: string[] }
  | { ok: false; reason: "multi-command" | "shell-syntax" | "unterminated-quote" };

const SHELL_META = new Set([";", "|", "&", "<", ">", "(", ")", "`"]);
const ANGLE_PLACEHOLDER = /^<[^<>\s|&;()`"']+>/;

/** Split a command line the way a POSIX shell would, without running anything.
 * Quotes and backslashes are honoured; operators, redirects, backticks and
 * `$(...)` are refused; `$VAR` and `${VAR}` stay as written. */
export function tokenizeCommand(input: string): TokenizeResult {
  const text = input.replace(/\\\r?\n/g, " ").trimEnd();
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;
  const push = () => {
    if (inToken) tokens.push(current);
    current = "";
    inToken = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "`" || (char === "$" && text[i + 1] === "(")) return { ok: false, reason: "shell-syntax" };
      else if (char === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1]!)) {
        current += text[i + 1];
        i += 1;
      } else current += char;
      continue;
    }
    if (char === "\n" || char === "\r") return { ok: false, reason: "multi-command" };
    if (char === " " || char === "\t") {
      push();
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inToken = true;
      continue;
    }
    if (char === "\\") {
      if (i + 1 < text.length) {
        current += text[i + 1];
        inToken = true;
        i += 1;
      }
      continue;
    }
    if (char === "$" && text[i + 1] === "(") return { ok: false, reason: "shell-syntax" };
    if (char === "<") {
      // <your-key> is a placeholder people leave unquoted; a redirect is not.
      const placeholder = ANGLE_PLACEHOLDER.exec(text.slice(i));
      if (placeholder) {
        current += placeholder[0];
        inToken = true;
        i += placeholder[0].length - 1;
        continue;
      }
    }
    if (SHELL_META.has(char)) return { ok: false, reason: "shell-syntax" };
    current += char;
    inToken = true;
  }
  if (quote) return { ok: false, reason: "unterminated-quote" };
  push();
  return { ok: true, tokens };
}

interface ParsedEntry {
  draft: PasteDraft;
  notes: PasteNote[];
}

type Transport = "http" | "sse";

function transportFromAlias(value: unknown): Transport | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "http" || value === "streamable-http" || value === "streamableHttp") return "http";
  if (value === "sse") return "sse";
  return undefined;
}

/** Split `Name: value`, tolerating no space after the colon. */
function splitHeader(text: string): [string, string] | null {
  const at = text.indexOf(":");
  if (at <= 0) return null;
  return [text.slice(0, at).trim(), text.slice(at + 1).trim()];
}

interface Bridge {
  url: string;
  transport?: Transport;
  headers: Array<[string, string]>;
  from: "mcp-remote" | "mcp-proxy";
}

const LAUNCHERS_WITH_PACKAGE_OPTIONS = new Set(["-p", "--package"]);

/** `npx -y mcp-remote <url> ...` and `uvx mcp-proxy <url> ...`, or null. */
function parseBridge(tokens: readonly string[]): Bridge | null {
  const command = (tokens[0] ?? "").split(/[\\/]/).pop()?.replace(/\.(cmd|exe)$/i, "") ?? "";
  let i = 1;
  if (command === "pnpm" || command === "yarn") {
    if (tokens[1] !== "dlx") return null;
    i = 2;
  } else if (!["npx", "bunx", "pnpx", "uvx"].includes(command)) {
    return null;
  }
  let pkg: string | undefined;
  for (; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (LAUNCHERS_WITH_PACKAGE_OPTIONS.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    pkg = token;
    i += 1;
    break;
  }
  if (!pkg) return null;
  const base = pkg.replace(/@[^@/]*$/, "");
  const rest = tokens.slice(i);
  if (base === "mcp-remote") return parseMcpRemote(rest);
  if (base === "mcp-proxy") return parseMcpProxy(rest);
  return null;
}

const MCP_REMOTE_VALUED = new Set(["--transport", "--host", "--resource", "--static-oauth-client-info", "--static-oauth-client-metadata", "--auth-timeout", "--ignore-tool"]);

function parseMcpRemote(args: readonly string[]): Bridge | null {
  let url: string | undefined;
  let transport: Transport | undefined;
  const headers: Array<[string, string]> = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (flag === "--header") {
      const value = inline ?? args[(i += 1)];
      const pair = value === undefined ? null : splitHeader(value);
      if (pair) headers.push(pair);
    } else if (flag === "--transport") {
      const value = inline ?? args[(i += 1)];
      if (value === "sse-only") transport = "sse";
      else if (value === "http-only") transport = "http";
    } else if (MCP_REMOTE_VALUED.has(flag)) {
      if (inline === undefined) i += 1;
    } else if (!arg.startsWith("-") && url === undefined) {
      url = arg;
    }
  }
  if (!url || !describeUrl(url).ok) return null;
  return { url, ...(transport ? { transport } : {}), headers, from: "mcp-remote" };
}

function parseMcpProxy(args: readonly string[]): Bridge | null {
  let url: string | undefined;
  let transport: Transport = "sse";
  const headers: Array<[string, string]> = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-H" || arg === "--headers") {
      const name = args[i + 1];
      const value = args[i + 2];
      i += 2;
      if (name !== undefined && value !== undefined) headers.push([name, value]);
    } else if (arg === "--transport") {
      transport = args[(i += 1)] === "streamablehttp" ? "http" : "sse";
    } else if (!arg.startsWith("-") && url === undefined) {
      url = arg;
    }
  }
  if (!url || !describeUrl(url).ok) return null;
  return { url, transport, headers, from: "mcp-proxy" };
}

function remoteDraft(
  name: string,
  url: string,
  transport: Transport | undefined,
  fields: PasteField[],
  convertedFrom?: "mcp-remote" | "mcp-proxy",
): PasteRemoteDraft | null {
  const described = describeUrl(url);
  if (!described.ok) return null;
  return {
    kind: "remote",
    name,
    url,
    maskedUrl: described.maskedUrl,
    urlHasSecret: described.urlHasSecret,
    ...(transport ? { transport } : {}),
    fields,
    ...(convertedFrom ? { convertedFrom } : {}),
  };
}

const DOCKER_VALUED = new Set(["-e", "--env", "-v", "--volume", "-p", "--publish", "--name", "-w", "--workdir", "-u", "--user", "--network", "--net", "--entrypoint", "--mount", "-l", "--label", "--platform", "--env-file", "--add-host", "--memory", "-m", "--cpus"]);

/** Rewrite `docker run -e NAME[=v]` so values live in the environment, not in
 * the arguments. Returns the new args, the env pairs and the image name. */
function dockerRun(args: readonly string[]): { args: string[]; env: Array<[string, string | undefined]>; image: string | undefined } {
  const out: string[] = [];
  const env: Array<[string, string | undefined]> = [];
  let image: string | undefined;
  let i = 0;
  if (args[0] === "run") {
    out.push("run");
    i = 1;
  } else {
    return { args: [...args], env, image };
  }
  for (; i < args.length; i += 1) {
    const arg = args[i]!;
    const valued = arg.startsWith("--env=") ? "--env" : DOCKER_VALUED.has(arg) ? arg : null;
    if (arg === "-e" || arg === "--env" || arg.startsWith("--env=")) {
      const spec = arg.startsWith("--env=") ? arg.slice("--env=".length) : args[(i += 1)] ?? "";
      const at = spec.indexOf("=");
      const name = at === -1 ? spec : spec.slice(0, at);
      env.push([name, at === -1 ? undefined : spec.slice(at + 1)]);
      out.push(arg.startsWith("--env=") ? "--env" : arg, name);
      continue;
    }
    if (valued) {
      out.push(arg, args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      out.push(arg);
      continue;
    }
    image = arg;
    out.push(...args.slice(i));
    break;
  }
  return { args: out, env, image };
}

const ENV_PAIR = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

function parseCommandTokens(tokens: string[], used: Set<string>, options: PasteOptions, context: FieldContext): ParsedEntry | null {
  const env: Array<[string, string | undefined]> = [];
  let start = 0;
  while (start < tokens.length && ENV_PAIR.test(tokens[start]!)) {
    const match = ENV_PAIR.exec(tokens[start]!)!;
    env.push([match[1]!, match[2]!]);
    start += 1;
  }
  const rest = tokens.slice(start);
  if (rest.length === 0) return null;

  const bridge = parseBridge(rest);
  if (bridge) {
    const fields = bridge.headers.map(([name, value]) => makeField({ type: "header", name }, value, context));
    const name = uniqueName(deriveNameFromUrl(bridge.url), used, options);
    const draft = remoteDraft(name, bridge.url, bridge.transport, fields, bridge.from);
    return draft ? { draft, notes: [] } : null;
  }

  const command = rest[0]!;
  let args = rest.slice(1);
  let label: string;
  const commandBase = command.split(/[\\/]/).pop() ?? command;
  if (commandBase === "docker" || commandBase === "podman") {
    const run = dockerRun(args);
    args = run.args;
    env.push(...run.env);
    label = run.image ? nameFromPackage(run.image.split("/").pop() ?? run.image) : commandBase;
  } else if (["npx", "bunx", "pnpx", "uvx", "pipx"].includes(commandBase) || ((commandBase === "pnpm" || commandBase === "yarn") && args[0] === "dlx")) {
    const tail = commandBase === "pnpm" || commandBase === "yarn" ? args.slice(1) : args;
    const spec = tail.find((token, index) => !token.startsWith("-") && !LAUNCHERS_WITH_PACKAGE_OPTIONS.has(tail[index - 1] ?? ""));
    label = spec ? nameFromPackage(spec) : commandBase;
  } else {
    const bare = commandBase.replace(/\.(cmd|exe|bat)$/i, "");
    label = (INTERPRETERS.has(bare.toLowerCase()) ? nameFromScript(args) : null) ?? bare;
  }
  const fields = env.map(([name, value]) => makeField({ type: "env", name }, value, context));
  return {
    draft: { kind: "stdio", name: uniqueName(label, used, options), command, args, fields },
    notes: [],
  };
}

const CLAUDE_VALUED = new Set(["--transport", "-t", "--scope", "-s", "--env", "-e", "--header", "-H", "--callback-port", "--client-id"]);

function parseClaudeMcp(tokens: string[], used: Set<string>, options: PasteOptions, context: FieldContext): { entries: ParsedEntry[] } | { error: PasteFailureReason } | null {
  if (tokens[0] !== "claude" || tokens[1] !== "mcp") return null;
  if (tokens[2] === "add-json") {
    const name = tokens[3];
    const json = tokens[4];
    if (!name || json === undefined) return { error: "unrecognized" };
    const parsed = parseJsonc(json);
    if (!parsed.ok) return { error: "invalid-json" };
    const entry = entryToDraft(name, parsed.value, used, options, context);
    return "draft" in entry ? { entries: [entry] } : { error: "invalid-entry" };
  }
  if (tokens[2] !== "add") return null;
  let transport: Transport | undefined;
  const positionals: string[] = [];
  const headers: Array<[string, string]> = [];
  const env: Array<[string, string | undefined]> = [];
  let after: string[] | null = null;
  for (let i = 3; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--") {
      after = tokens.slice(i + 1);
      break;
    }
    const inline = token.startsWith("--") && token.includes("=");
    const flag = inline ? token.slice(0, token.indexOf("=")) : token;
    if (CLAUDE_VALUED.has(flag)) {
      const value = inline ? token.slice(token.indexOf("=") + 1) : tokens[(i += 1)] ?? "";
      if (flag === "--transport" || flag === "-t") transport = transportFromAlias(value);
      else if (flag === "--header" || flag === "-H") {
        const pair = splitHeader(value);
        if (pair) headers.push(pair);
      } else if (flag === "--env" || flag === "-e") {
        const at = value.indexOf("=");
        env.push([at === -1 ? value : value.slice(0, at), at === -1 ? undefined : value.slice(at + 1)]);
      }
    } else if (token.startsWith("-")) {
      continue;
    } else {
      positionals.push(token);
    }
  }
  const explicit = positionals[0];
  if (!explicit) return { error: "unrecognized" };
  const target = positionals[1];
  const looksRemote = transport !== undefined || (after === null && target !== undefined && /^https?:\/\//i.test(target));
  if (looksRemote) {
    if (!target) return { error: "unrecognized" };
    const fields = headers.map(([name, value]) => makeField({ type: "header", name }, value, context));
    const draft = remoteDraft(uniqueName(explicit, used, options), target, transport, fields);
    return draft ? { entries: [{ draft, notes: [] }] } : { error: "unrecognized" };
  }
  const commandTokens = after ?? positionals.slice(1);
  if (commandTokens.length === 0) return { error: "unrecognized" };
  const fields = env.map(([name, value]) => makeField({ type: "env", name }, value, context));
  const draft: PasteStdioDraft = { kind: "stdio", name: uniqueName(explicit, used, options), command: commandTokens[0]!, args: commandTokens.slice(1), fields };
  return { entries: [{ draft, notes: [] }] };
}

// ── JSON and JSONC ──────────────────────────────────────────────────────

/** Remove comments and trailing commas outside strings, then parse. */
function parseJsonc(text: string): { ok: true; value: unknown } | { ok: false } {
  let out = "";
  let i = 0;
  const source = text.replace(/^﻿/, "");
  while (i < source.length) {
    const char = source[i]!;
    if (char === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else {
      out += char;
      i += 1;
    }
  }
  // A comma followed only by whitespace and a closing bracket is a trailing comma.
  let cleaned = "";
  let inString = false;
  for (let k = 0; k < out.length; k += 1) {
    const char = out[k]!;
    if (inString) {
      cleaned += char;
      if (char === "\\") {
        cleaned += out[k + 1] ?? "";
        k += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      cleaned += char;
      continue;
    }
    if (char === ",") {
      let n = k + 1;
      while (n < out.length && /\s/.test(out[n]!)) n += 1;
      if (out[n] === "}" || out[n] === "]") continue;
    }
    cleaned += char;
  }
  try {
    return { ok: true, value: JSON.parse(cleaned) as unknown };
  } catch {
    return { ok: false };
  }
}

function inputDescriptions(root: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  const lists = [root.inputs, isObject(root.mcp) ? root.mcp.inputs : undefined];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (isObject(item) && typeof item.id === "string" && typeof item.description === "string" && item.description.trim()) {
        map.set(item.id, item.description.trim());
      }
    }
  }
  return map;
}

const STDIO_KEYS = new Set(["command", "args", "env", "type"]);
const REMOTE_KEYS = new Set(["url", "serverUrl", "httpUrl", "type", "transport", "headers"]);

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

type EntryResult = ParsedEntry | { skipped: PasteNote };

function entryToDraft(rawName: string, raw: unknown, used: Set<string>, options: PasteOptions, context: FieldContext): EntryResult {
  const skip = (): EntryResult => ({ skipped: { key: "skippedNothing", entry: rawName } });
  if (!isObject(raw)) return skip();
  const urlKey = (["url", "serverUrl", "httpUrl"] as const).find((key) => typeof raw[key] === "string");
  const hasCommand = typeof raw.command === "string" && raw.command.trim() !== "";
  const remoteType = transportFromAlias(raw.type) ?? transportFromAlias(raw.transport);
  const mixed = urlKey !== undefined && hasCommand && remoteType === undefined && raw.type !== "stdio";
  if (mixed) return { skipped: { key: "skippedBoth", entry: rawName } };
  const remote = urlKey !== undefined && (!hasCommand || remoteType !== undefined);
  const notes: PasteNote[] = [];
  const ignored = (keys: Set<string>) => {
    for (const key of Object.keys(raw)) if (!keys.has(key)) notes.push({ key: "ignoredKey", entry: rawName, field: key });
  };

  if (remote) {
    const url = (raw[urlKey!] as string).trim();
    if (!describeUrl(url).ok) return { skipped: { key: "skippedLink", entry: rawName } };
    const fields: PasteField[] = [];
    if (raw.headers !== undefined) {
      if (!isObject(raw.headers)) return skip();
      for (const [name, value] of Object.entries(raw.headers)) {
        const text = scalarText(value);
        if (text === null) return skip();
        fields.push(makeField({ type: "header", name }, text, context));
      }
    }
    ignored(REMOTE_KEYS);
    const name = uniqueName(rawName, used, options);
    const draft = remoteDraft(name, url, remoteType, fields);
    return draft ? { draft, notes } : skip();
  }

  if (!hasCommand) return skip();
  let args: string[] = [];
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string")) {
      return { skipped: { key: "skippedArgs", entry: rawName } };
    }
    args = raw.args as string[];
  }
  const envEntries: Array<[string, string]> = [];
  if (raw.env !== undefined) {
    if (!isObject(raw.env)) return skip();
    for (const [name, value] of Object.entries(raw.env)) {
      const text = scalarText(value);
      if (text === null) return skip();
      envEntries.push([name, text]);
    }
  }

  const command = (raw.command as string).trim();
  const envRecord: Record<string, string> = {};
  for (const [name, value] of envEntries) put(envRecord, name, value);
  const bridge = parseBridge([command, ...args]);
  if (bridge) {
    const usedEnv = new Set<string>();
    const fields = bridge.headers.map(([name, value]) => makeField({ type: "header", name }, value, { ...context, env: envRecord, usedEnv }));
    if (envEntries.some(([name]) => !usedEnv.has(name))) notes.push({ key: "ignoredEnv", entry: rawName });
    ignored(STDIO_KEYS);
    const draft = remoteDraft(uniqueName(rawName, used, options), bridge.url, bridge.transport, fields, bridge.from);
    return draft ? { draft, notes } : skip();
  }
  const fields = envEntries.map(([name, value]) => makeField({ type: "env", name }, value, context));
  ignored(STDIO_KEYS);
  return { draft: { kind: "stdio", name: uniqueName(rawName, used, options), command, args, fields }, notes };
}

function looksLikeEntry(value: unknown): boolean {
  return isObject(value) && (typeof value.command === "string" || typeof value.url === "string" || typeof value.serverUrl === "string" || typeof value.httpUrl === "string");
}

function parseJsonSnippet(text: string, options: PasteOptions): PasteResult {
  let parsed = parseJsonc(text);
  if (!parsed.ok && text.trimStart().startsWith('"')) parsed = parseJsonc(`{${text.trim().replace(/,$/, "")}}`);
  if (!parsed.ok) return fail("invalid-json");
  const root = parsed.value;
  if (!isObject(root)) return fail("unrecognized");

  let entries: Array<[string, unknown]> | null = null;
  if (isObject(root.mcpServers)) entries = Object.entries(root.mcpServers);
  else if (isObject(root.servers)) entries = Object.entries(root.servers);
  else if (isObject(root.mcp) && isObject(root.mcp.servers)) entries = Object.entries(root.mcp.servers);
  else if (looksLikeEntry(root)) entries = [["", root]];
  else if (Object.keys(root).length > 0 && Object.values(root).every(looksLikeEntry)) entries = Object.entries(root);
  if (!entries || entries.length === 0) return fail("unrecognized");
  if (entries.length > MAX_PASTE_SERVERS) return fail("too-many");

  const context: FieldContext = { inputs: inputDescriptions(root) };
  const used = new Set<string>();
  const drafts: PasteDraft[] = [];
  const notes: PasteNote[] = [];
  for (const [rawName, value] of entries) {
    let name = rawName;
    if (name === "" && isObject(value)) {
      const link = [value.url, value.serverUrl, value.httpUrl].find((candidate): candidate is string => typeof candidate === "string");
      const described = link ? describeUrl(link.trim()) : null;
      if (described?.ok) name = deriveNameFromUrl(link!.trim());
      else if (typeof value.command === "string") {
        const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === "string") : [];
        const tokens = [value.command, ...args];
        const parsedCommand = parseCommandTokens(tokens, new Set(), {}, context);
        name = parsedCommand?.draft.name ?? "server";
      }
    }
    const result = entryToDraft(name || "server", value, used, options, context);
    if ("skipped" in result) notes.push(result.skipped);
    else {
      drafts.push(result.draft);
      notes.push(...result.notes);
    }
  }
  if (drafts.length === 0) return fail("invalid-entry");
  return succeed("json", drafts, notes);
}

// ── detection ───────────────────────────────────────────────────────────

function firstMeaningfulLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) return trimmed;
  }
  return "";
}

const TOML_HEADER = /^\[\[?[A-Za-z0-9_."' -]+\]\]?$/;
const TOML_PAIR = /^[A-Za-z_][\w.-]*\s*=\s*(".*"|'.*'|\[.*\]|\d+|true|false)$/;
/** Longest line the TOML test looks at: real config lines are short, and a
 * bounded line keeps every pattern linear (review L1). */
const TOML_MAX_LINE = 400;

function looksLikeToml(text: string): boolean {
  let firstMeaningful: string | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > TOML_MAX_LINE) continue;
    if (TOML_HEADER.test(trimmed)) return true;
    if (firstMeaningful === null && !trimmed.startsWith("#")) firstMeaningful = trimmed;
  }
  return firstMeaningful !== null && TOML_PAIR.test(firstMeaningful);
}

function looksLikeYaml(text: string): boolean {
  const line = firstMeaningfulLine(text);
  return line === "---" || /^[A-Za-z_][\w-]*:\s*$/.test(line) || /^-\s+[\w-]+:/.test(line);
}

const DOTTED_LINK = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/\S*$/i;
const LOCAL_LINK = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/\S*)?$/i;

function parseLink(text: string, options: PasteOptions): PasteResult | null {
  const single = !/\s/.test(text);
  let url: string | null = null;
  if (/^https?:\/\//i.test(text)) {
    if (!single) return fail("unrecognized");
    url = text;
  } else if (single && LOCAL_LINK.test(text)) url = `http://${text}`;
  else if (single && DOTTED_LINK.test(text)) url = `https://${text}`;
  if (url === null) return null;
  const described = describeUrl(url);
  if (!described.ok) return fail("unrecognized");
  const name = uniqueName(deriveNameFromUrl(url), new Set(), options);
  const draft = remoteDraft(name, url, undefined, []);
  return draft ? succeed("link", [draft], []) : fail("unrecognized");
}

/** Turn pasted text into drafts. Never runs or fetches anything. */
export function parsePaste(input: string, options: PasteOptions = {}): PasteResult {
  const text = input.trim();
  if (!text) return fail("empty");
  if (new TextEncoder().encode(input).length > MAX_PASTE_BYTES) return fail("too-large");
  const startsJson = text.startsWith("{") || text.startsWith("[") || (text.startsWith('"') && /^"[^"]+"\s*:/.test(text));
  if (text.startsWith("[") && looksLikeToml(text)) return fail("toml");
  if (startsJson) return parseJsonSnippet(text, options);
  if (looksLikeToml(text)) return fail("toml");
  if (looksLikeYaml(text)) return fail("yaml");

  const link = parseLink(text, options);
  if (link) return link;

  const tokenized = tokenizeCommand(text);
  if (!tokenized.ok) return fail(tokenized.reason);
  if (tokenized.tokens.length === 0) return fail("empty");
  const context: FieldContext = { inputs: new Map() };
  const used = new Set<string>();
  const claude = parseClaudeMcp(tokenized.tokens, used, options, context);
  if (claude) {
    if ("error" in claude) return fail(claude.error);
    return succeed("command", claude.entries.map((entry) => entry.draft), claude.entries.flatMap((entry) => entry.notes));
  }
  const entry = parseCommandTokens(tokenized.tokens, used, options, context);
  if (!entry) return fail("unrecognized");
  return succeed("command", [entry.draft], entry.notes);
}
