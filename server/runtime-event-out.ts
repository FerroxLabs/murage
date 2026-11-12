// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What of a runtime event leaves the server. A permission ask carries
// server-side records next to its card fields: the engine's raw tool call,
// the MCP mounts and the F12 record (`execEnv`), whose `env` is the exact map
// handed to the engine process, provider API key included on a turn with a
// configured provider. A window, a paired phone or a companion stream allowed
// to see the thread reads the card, never those records.
//
// An ask goes out as an ALLOWLIST: every field of `request.opened` is named
// below as out (true) or kept in the server (false), so a field added to the
// contract later does not compile until someone decides which it is.
import type { RuntimeEvent } from "./contracts.ts";
import { envInfoOf, isExecEnv } from "../shared/mount-identity.ts";

type RequestOpened = Extract<RuntimeEvent, { type: "request.opened" }>;

const REQUEST_OPENED_OUT: Record<keyof RequestOpened, boolean> = {
  eventId: true,
  provider: true,
  providerInstanceId: true,
  threadId: true,
  createdAt: true,
  turnId: true,
  itemId: true,
  requestId: true,
  // the native protocol message: an engine's own frame can hold anything
  raw: false,
  // v1 V5: the driver's own note that the ask's tool item never came; the server marks the turn from it
  itemUnseen: false,
  // 1.0.19 A3: the asked call's key and whether it is ambiguous; the server reads them for the ask's outside context
  callKey: false,
  callKeyAmbiguous: false,
  type: true,
  requestType: true,
  tool: true,
  summary: true,
  choices: true,
  approvalScope: true,
  questionTool: true,
  questions: true,
  folderTrust: true,
  filePaths: true,
  toolResultDirs: true,
  // the engine's raw call is the stop line's, and can be a whole file
  toolCall: false,
  toolInput: true,
  reason: true,
  toolKind: true,
  toolIdentity: true,
  // proven against server-side only (shared/app-action-grant.ts)
  mcpMounts: false,
  toolEngine: true,
  toolInputMissing: true,
  localHold: false,
  // how the gates read the command text: server-side only
  commandShell: false,
  // the map handed to the engine process: credentials
  execEnv: false,
  executionCwd: false,
  // its value-free projection (names, shell, provenance, managed names): out (Astra #9)
  envInfo: true,
  toolInputTruncated: true,
};

const OUT_FIELDS = Object.entries(REQUEST_OPENED_OUT).filter(([, out]) => out).map(([name]) => name);

/** The ask with `envInfo` derived from its F12 record (never taken from the event as given: only the projection of a
 * well-formed record goes out). */
function withExecEnvInfo(event: RequestOpened): RequestOpened {
  const { envInfo: _given, ...rest } = event;
  return isExecEnv(event.execEnv) ? { ...rest, envInfo: envInfoOf(event.execEnv) } as RequestOpened : rest as RequestOpened;
}

/** The ask as it leaves the server: the allowlisted fields only. */
export function requestOpenedOut(event: RequestOpened): RequestOpened {
  const source = withExecEnvInfo(event) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const name of OUT_FIELDS) if (Object.hasOwn(source, name) && source[name] !== undefined) out[name] = source[name];
  return out as unknown as RequestOpened;
}

/** 1.0.19 A3 (Astra r1 H1): the call key and its ambiguity flag are the server's own records (the ask's outside context),
 *  never on the stream or in the log, on any event that carries them. */
function withoutCallKey<T>(event: T): T {
  if (!event || typeof event !== "object" || (!Object.hasOwn(event, "callKey") && !Object.hasOwn(event, "callKeyAmbiguous"))) return event;
  const { callKey: _key, callKeyAmbiguous: _ambiguous, ...rest } = event as T & { callKey?: unknown; callKeyAmbiguous?: unknown };
  return rest as T;
}

// NOLIMITS 1.0.18 (design NOLIMITS-S1S2-H6-ALLOWLIST.md L1-L4): a tool start goes into the event log as an ALLOWLIST. Its
// display text (a title derived from a shell command, an ACP display title, a summary, spoken lines) and its input's file
// text are never written: ordinary confidential text is not credential-shaped, so redaction would let it through. The live
// event is untouched (chips, narration, phone recognition and the outside judge read the original).

/** An engine identifier: no whitespace, quote, `/`, `=`, `<`, `>`, `$`, `|` or `;`, so it carries no file text. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
/** The ACP ToolKind enum plus Murage's own `notice`: the only kinds a log row keeps. */
export const LOGGED_TOOL_KINDS: ReadonlySet<string> = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other", "notice"]);
/** Drivers whose tool start title is, by construction, the tool's name (claude.ts `title: b.name`, antigravity.ts
 *  `title: payload.tool_name`). No other provider's title is ever logged. */
const TITLE_IS_TOOL_NAME: ReadonlySet<string> = new Set(["claudeAgent", "antigravityAgent"]);
/** The envelope every logged event keeps (ids only: the sanitizer keeps a value only when it is an identifier). */
const EVENT_ENVELOPE = ["type", "eventId", "provider", "providerInstanceId", "threadId", "turnId", "createdAt", "itemId", "requestId"] as const;

// toolStartPaths (NOLIMITS-S1S2-H6-LOGGER-REDESIGN.md 2.1): the paths a call names and its wrapped tool name, nothing else
const PATH_FIELDS: ReadonlySet<string> = new Set([
  "path", "file_path", "filePath", "filepath", "files", "paths", "dir", "directory", "cwd", "folder", "notebook_path",
  "target_file", "old_path", "new_path", "move_path", "destination", "directory_path", "root", "workdir", "working_directory",
  // an ask's own path lists (request.opened filePaths, toolResultDirs)
  "filePaths", "toolResultDirs",
]);
const NAME_FIELDS: ReadonlySet<string> = new Set(["tool_name", "toolName"]);
const WRAPPERS: ReadonlySet<string> = new Set(["tool_input", "toolInput", "args", "arguments", "input", "params", "parameters"]);
const PATH_MAX_BYTES = 1024;
const KEPT_MAX = 64;
const WRAPPER_MAX_DEPTH = 4;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const identOrUndefined = (value: unknown): string | undefined => typeof value === "string" && IDENT.test(value) ? value : undefined;
/** GrokBuild case 21: a logged path is a path, never text. A value holding whitespace, a quote, `$`, a backtick, `|`, `;` or a
 *  newline is a command or prose in a path field, and is dropped (a real path with a space is the accepted cost). A value with
 *  no path separator (`/` or `\`) is a word, not a path, and is dropped too, except `.`, `..` and `~`. */
const UNSAFE_PATH = /[\s"'`$|;]/;
/** Astra r1 M12: a logged path is built from path characters only (letters and digits of any script, combining marks, and
 *  `_ . - / \ : ~ @ + , %`). `<`, `>`, `&`, `(`, `)`, `*`, `?`, `!`, `=`, `#`, brackets, braces and every other shell
 *  metacharacter drop the value, so `cat</w/private.txt` is not a path. */
const PATH_CHARS = /^[\p{L}\p{N}\p{M}_.\-/\\:~@+,%]+$/u;
const BARE_PATHS: ReadonlySet<string> = new Set([".", "..", "~"]);
const pathOrUndefined = (value: unknown): string | undefined => {
  if (typeof value !== "string" || UNSAFE_PATH.test(value) || !PATH_CHARS.test(value)) return undefined;
  // The separator test reads the CAPPED value: a word whose only separator sits past the cap is logged as a word otherwise.
  const capped = capBytes(value, PATH_MAX_BYTES);
  return /[/\\]/.test(capped) || BARE_PATHS.has(capped) ? capped : undefined;
};
/** A Codex change's kind: the three the protocol defines, nothing else. */
const CHANGE_KINDS: ReadonlySet<string> = new Set(["add", "update", "delete"]);

function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > max) break;
    out += ch;
    bytes += n;
  }
  return out;
}

function projectPaths(value: Record<string, unknown>, depth: number, budget: { left: number }): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (budget.left <= 0) break;
    const item = value[key];
    if (PATH_FIELDS.has(key)) {
      const single = pathOrUndefined(item);
      if (single !== undefined) { out[key] = single; budget.left--; }
      else if (Array.isArray(item)) {
        const kept: string[] = [];
        for (const entry of item) {
          if (kept.length >= KEPT_MAX || budget.left <= 0) break;
          const path = pathOrUndefined(entry);
          if (path !== undefined) { kept.push(path); budget.left--; }
        }
        if (kept.length) out[key] = kept;
      }
    } else if (NAME_FIELDS.has(key)) {
      const name = identOrUndefined(item);
      if (name !== undefined) { out[key] = name; budget.left--; }
    } else if (WRAPPERS.has(key)) {
      if (isPlainObject(item) && depth + 1 <= WRAPPER_MAX_DEPTH) {
        const inner = projectPaths(item, depth + 1, budget);
        if (inner) out[key] = inner;
      }
    } else if (key === "changes" || key === "locations") {
      if (!Array.isArray(item)) continue;
      const kept: Array<Record<string, unknown>> = [];
      for (const entry of item) {
        if (kept.length >= KEPT_MAX || budget.left <= 0) break;
        const path = isPlainObject(entry) ? pathOrUndefined(entry.path) : undefined;
        if (path === undefined) continue;
        const row: Record<string, unknown> = { path };
        budget.left--;
        if (key === "changes") {
          // a Codex change's kind: `add` / `update` / `delete`, or `{ type }` of one of them (case 21)
          const kind = isPlainObject(entry.kind) ? entry.kind.type : entry.kind;
          if (typeof kind === "string" && CHANGE_KINDS.has(kind)) row.kind = kind;
        }
        kept.push(row);
      }
      if (kept.length) out[key] = kept;
    }
    // every other key is dropped, and nothing under it is read
  }
  return Object.keys(out).length ? out : undefined;
}

/** A tool start's input as the event log keeps it: the strings under the allowlisted path keys and the wrapped tool name,
 *  reached only through allowlisted wrapper keys (depth <= 4), each capped, at most 64 per event. A non-object input (a
 *  bounded string, an array, a number, null) projects to undefined. Never throws, never mutates. Exported for tests. */
export function toolStartPaths(input: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(input)) return undefined;
  try {
    return projectPaths(input, 0, { left: KEPT_MAX });
  } catch {
    return undefined;
  }
}

function kindLabel(event: Record<string, unknown>): string {
  if (typeof event.toolKind === "string" && LOGGED_TOOL_KINDS.has(event.toolKind)) return event.toolKind;
  return event.origin === "murage" ? "murage" : "tool";
}

/** The trusted tool name of an engine tool start (provenance first, shape second), or undefined. */
function loggedToolName(event: Record<string, unknown>): string | undefined {
  if (event.origin !== "engine") return undefined;
  const identity = event.toolIdentity;
  const identityName = identity && typeof identity === "object" ? (identity as { name?: unknown }).name : undefined;
  // driver code sets an identity from engine protocol fields, never from a display string
  if (typeof identityName === "string") return identOrUndefined(identityName);
  if (typeof event.provider === "string" && TITLE_IS_TOOL_NAME.has(event.provider)) return identOrUndefined(event.title);
  return undefined;
}

/** The logged `title` of a tool start (L2): a trusted tool name, else a fixed label from its kind. Exported for tests. */
export function loggedToolTitle(event: unknown): string {
  const e = event && typeof event === "object" ? event as Record<string, unknown> : {};
  return loggedToolName(e) ?? kindLabel(e);
}

/** L3: an identity keeps its namespace, name and kind only when each is an identifier; nothing left, no identity. */
function loggedToolIdentity(identity: unknown): Record<string, string> | undefined {
  if (!identity || typeof identity !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const key of ["namespace", "name", "kind"] as const) {
    const value = identOrUndefined((identity as Record<string, unknown>)[key]);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The runtime frame a stream gets (live, and the replay buffer that resumes
 * it): a tool's input and result stay out, and an ask goes out allowlisted. */
export function windowRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  if (event.type === "item.started") return { ...withoutCallKey(event), input: undefined };
  if (event.type === "item.completed" && event.itemType === "tool") return { ...event, result: undefined };
  if (event.type === "request.opened") return requestOpenedOut(event);
  return event;
}

// GrokBuild case 18: a shell ask's command is in its `summary` (Claude askSummary, Codex codexApprovalText, every driver's
// card headline), often in its `reason`, and whole in `toolInput`. The log keeps the fixed label and the input's paths; the
// live card (windowRuntimeEvent) keeps the command.
/** Shell tool names as engines file them (bare, lower case): shared/approval-plain.ts SHELL_TOOLS plus Codex/Pi/agy names. */
export const SHELL_ASK_TOOLS: ReadonlySet<string> = new Set([
  "bash", "shell", "execute", "powershell", "pwsh", "run_terminal_cmd", "run_terminal_command", "exec_command", "run_command",
  "run_shell_command", "terminal", "local_shell", "sh", "zsh", "cmd",
]);
/** Input keys that hold a command line (Claude/Codex/ACP `command`, openai-style `cmd`, agy `CommandLine`). */
const COMMAND_INPUT_KEYS: ReadonlySet<string> = new Set(["command", "cmd", "CommandLine", "commandLine"]);
export const SHELL_LABEL = "shell";

export const bareToolName = (tool: unknown): string =>
  typeof tool === "string" ? (tool.replace(/^mcp__.+?__/, "").split(/__|[./]/).pop() ?? "").toLowerCase() : "";
function parsedObject(value: unknown): Record<string, unknown> | undefined {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string") return undefined;
  try { const parsed: unknown = JSON.parse(value); return isPlainObject(parsed) ? parsed : undefined; } catch { return undefined; }
}
const namesCommand = (input: Record<string, unknown> | undefined): boolean =>
  !!input && Object.keys(input).some((key) => COMMAND_INPUT_KEYS.has(key));

function isShellAsk(event: Record<string, unknown>): boolean {
  const call = isPlainObject(event.toolCall) ? event.toolCall : undefined;
  return SHELL_ASK_TOOLS.has(bareToolName(event.tool)) || SHELL_ASK_TOOLS.has(bareToolName(call?.name))
    || event.toolKind === "execute" || event.commandShell !== undefined
    || namesCommand(parsedObject(call?.input)) || namesCommand(parsedObject(event.toolInput));
}

/** Astra r1 H8: EVERY logged ask (shell or not) has `summary` and `reason` as a fixed label and `toolInput` as the call's paths
 *  only (JSON text, as the contract types it), from the bounded text when it parses, else the engine's structured call. A
 *  Claude Write ask's file content, a WebFetch url, a question's words: none is written. */
function askLabel(event: Record<string, unknown>): string {
  if (isShellAsk(event)) return SHELL_LABEL;
  if (event.requestType === "question") return "question";
  return typeof event.toolKind === "string" && LOGGED_TOOL_KINDS.has(event.toolKind) ? event.toolKind : "permission";
}
function askLabels(e: Record<string, unknown>): Record<string, unknown> {
  const label = askLabel(e);
  const call = isPlainObject(e.toolCall) ? e.toolCall : undefined;
  const paths = e.toolInput !== undefined ? toolStartPaths(parsedObject(e.toolInput) ?? parsedObject(call?.input)) : undefined;
  return {
    summary: label,
    reason: e.reason !== undefined ? label : undefined,
    toolInput: paths ? JSON.stringify(paths) : undefined,
    tool: identOrUndefined(e.tool) ?? "tool",
    // OPENAI-TOOLS-109 s8 (b): the call's name only, never its input
    toolCall: identOrUndefined(call?.name) !== undefined ? { name: call!.name } : undefined,
    // Astra #9: the value-free projection of a well-formed F12 record, never a given envInfo
    envInfo: isExecEnv(e.execEnv) ? envInfoOf(e.execEnv) : undefined,
    // F5: the missing field's name when a driver names one of these, else a fixed label (some drivers name it in prose)
    toolInputMissing: e.toolInputMissing === undefined ? undefined
      : typeof e.toolInputMissing === "string" && MISSING_INPUT_FIELDS.has(e.toolInputMissing) ? e.toolInputMissing : "field",
  };
}
/** The field names drivers set as an ask's `toolInputMissing` (claude.ts, codex-hook.ts, acp/core.ts). */
const MISSING_INPUT_FIELDS: ReadonlySet<string> = new Set(["kind", "patch", "input", "tool_name", "command", "tool_input", "path"]);

// GrokBuild case 19: Rule 67's tripwire line (codex-hook.ts tripwireLine) names the command. The live error keeps it; the log
// keeps this sentence.
const TRIPWIRE_HEAD = "Codex ran `";
const TRIPWIRE_TAIL = "` without Murage's check; the turn was stopped";
export const TRIPWIRE_LOGGED_MESSAGE = "Codex ran a command without Murage's check; the turn was stopped";
/** Any other error's text (engine stderr, a provider's message) can quote a file or a command: the log keeps this label and the
 *  error's structured fields (errorKind, engineCode, setup, ...). */
export const ERROR_LOGGED_MESSAGE = "runtime error";
function loggedErrorMessage(message: unknown): string {
  return typeof message === "string" && message.startsWith(TRIPWIRE_HEAD) && message.endsWith(TRIPWIRE_TAIL) ? TRIPWIRE_LOGGED_MESSAGE : ERROR_LOGGED_MESSAGE;
}

// ── THE persisted-row sanitizer (MurageMain ruling 2026-11-06; Astra r1 H8-H11, GrokBuild cases 18-21) ──────────────────
// Every row this server persists from a run goes through persistedRow: the thread's event log (loggedRuntimeEvent), the
// native trace (nativeTraceFrame, native/<thread>.ndjson) and the decision log (decision-log.ts loggedDecision). It is an
// ALLOWLIST by value class, applied at any depth:
//   - numbers, booleans and null stay (sizes, exit codes, token counts, flags);
//   - a string stays only under an identifier key (ids, names, kind/status enums, timestamps) and only when it is an
//     identifier (no whitespace, quote, `/`, `<`, `>`, `$`, `|`, `;`), under `method` when it is a method name, under a
//     model key when it is a model name;
//   - a path key (PATH_FIELDS, `changes`, `locations`) keeps toolStartPaths' projection (M12's path characters);
//   - an input key (`input`, `rawInput`, `arguments`, `args`, `tool_input`, `toolInput`) keeps the call's paths, in the shape
//     it came (JSON text stays JSON text);
//   - command keys, payload keys (output, diff, text, data, ...) and a result frame's `content` are dropped whole;
//   - every other string (a title, a description, a message, prose, file text, a key a future engine adds) is dropped.
// Fixed labels (a tool start's title, an ask's summary, an error's message) are set by trusted code after the walk. The live
// event is untouched: cards, chips, narration, phone recognition and the outside judge read the original.

/** Keys whose string value is kept when it is an identifier. */
const PERSIST_ID_KEYS: ReadonlySet<string> = new Set([
  // engine frames
  "type", "subtype", "sessionUpdate", "kind", "status", "id", "callId", "call_id", "toolCallId", "tool_use_id", "itemId", "item_id",
  "threadId", "thread_id", "turnId", "turn_id", "sessionId", "session_id", "requestId", "request_id", "name", "tool", "toolName",
  "tool_name", "server", "namespace", "optionId", "role", "stop_reason", "parent_tool_use_id", "uuid", "jsonrpc", "priority",
  // runtime events
  "eventId", "provider", "providerInstanceId", "createdAt", "itemType", "origin", "toolKind", "requestType", "behavior", "source",
  "streamKind", "approvalScope", "toolEngine", "stopReason", "errorKind", "engineCode", "localFailure",
  "localFailureEngine", "interjectionId", "beforeItemId", "denials",
  // decision rows
  "at", "decision", "botId", "batchId",
  // the native trace: a permission answer's outcome (`trust`, `reject`, `selected`, `cancelled`) and the fixed labels Murage's own
  // driver records carry (drivers/acp/core.ts: acpPool, askStop, fuigoInterjection, fuigoSilenceWatch and their reason)
  "outcome", "reason", "acpPool", "askStop", "fuigoInterjection", "fuigoSilenceWatch", "processGeneration",
]);
/** Keys whose string value is kept only when it is one of its contract's values (contracts.ts). `decidedBy` is never logged
 *  (the Inspector reads it from the decision log), and `toolInputMissing` is a label (loggedEventLabels). */
const PERSIST_ENUMS: Readonly<Record<string, ReadonlySet<string>>> = {
  folderTrustLate: new Set(["finished", "stopped", "failed", "timeout"]),
  deniedBy: new Set(["user", "timeout", "system"]),
  mcpReadiness: new Set(["unknown"]),
  // OpenCode stderr failure categories (acp/core.ts persistEngineStderr): the closed OpenCodeFailure values, never engine text
  categories: new Set(["authentication", "rate_limit", "unavailable", "tool_count"]),
};
const PERSIST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PERSIST_MODEL_KEYS: ReadonlySet<string> = new Set(["model", "routed", "requested"]);
const PERSIST_MODEL = /^[A-Za-z0-9_.:@/[\]-]{1,128}$/;
const PERSIST_METHOD = /^[A-Za-z][A-Za-z0-9_./:-]{0,127}$/;
/** Keys that hold a tool call's input: kept as its paths only. */
const PERSIST_INPUT_KEYS: ReadonlySet<string> = new Set(["input", "rawInput", "arguments", "args", "tool_input", "toolInput"]);
/** Keys dropped whole, whatever they hold: a command line, a tool's output or a change's text. A JSON-RPC `result` is walked
 *  like any object (its ids, enums and numbers stay: a prompt's stopReason, a permission answer's outcome), so a result's text,
 *  output or content still never reaches disk. */
const PERSIST_DROP_KEYS: ReadonlySet<string> = new Set([
  "command", "cmd", "parsed_cmd", "commandActions", "CommandLine", "commandLine",
  "output", "aggregatedOutput", "formatted_output", "stdout", "stderr", "structuredContent", "diff", "patch",
  "unified_diff", "text", "delta", "data", "value", "partial_json", "thinking", "signature",
]);
/** `content` is walked only as a message's content list (Claude's `message.content`, which lists its tool calls) and never in a
 *  frame whose type names a result or an output (Claude tool_result, Codex function_call_output, ...): everywhere else (an ACP
 *  tool call's diff and text content, a chunk's text, an MCP result) it is dropped whole. */
const PERSIST_RESULT_TYPE = /result|output/i;
const PERSIST_MAX_DEPTH = 40;
const PERSIST_MAX_NODES = 20_000;

/** A tool input as a persisted row keeps it: its paths, in the shape it came (JSON text stays JSON text). */
function persistedInput(value: unknown): unknown {
  const paths = toolStartPaths(parsedObject(value));
  if (!paths) return undefined;
  return typeof value === "string" ? JSON.stringify(paths) : paths;
}

function persistedString(key: string | undefined, value: string): string | undefined {
  if (key === undefined) return undefined;
  if (Object.hasOwn(PERSIST_ENUMS, key)) return PERSIST_ENUMS[key]!.has(value) ? value : undefined;
  if (PERSIST_ID_KEYS.has(key)) return PERSIST_ID.test(value) ? value : undefined;
  if (PERSIST_MODEL_KEYS.has(key)) return PERSIST_MODEL.test(value) ? value : undefined;
  if (key === "method") return PERSIST_METHOD.test(value) ? value : undefined;
  return undefined;
}

function persistWalk(value: unknown, key: string | undefined, depth: number, budget: { left: number }): unknown {
  if (--budget.left < 0) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (key !== undefined) {
    if (PERSIST_DROP_KEYS.has(key)) return undefined;
    if (PATH_FIELDS.has(key) || key === "changes" || key === "locations") return toolStartPaths({ [key]: value })?.[key];
    if (PERSIST_INPUT_KEYS.has(key)) return persistedInput(value);
  }
  if (typeof value === "string") return persistedString(key, value);
  if (depth >= PERSIST_MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const item of value) {
      const one = persistWalk(item, key, depth + 1, budget);
      if (one !== undefined) kept.push(one);
    }
    return value.length && !kept.length ? undefined : kept;
  }
  if (!isPlainObject(value)) return undefined;
  const resultFrame = typeof value.type === "string" && PERSIST_RESULT_TYPE.test(value.type);
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    if (name === "content" && (resultFrame || key !== "message")) continue;
    const one = persistWalk(item, name, depth + 1, budget);
    if (one !== undefined) out[name] = one;
  }
  return Object.keys(value).length && !Object.keys(out).length ? undefined : out;
}

/** THE persisted-row sanitizer: `value` walked by the allowlist above, then the trusted `labels` set over it (a label whose
 *  value is undefined removes that key). Never throws, never mutates; a value nothing of survives is `{}` plus the labels. */
export function persistedRow(value: unknown, labels: Record<string, unknown> = {}): Record<string, unknown> {
  let row: Record<string, unknown> = {};
  try {
    const walked = persistWalk(value, undefined, 0, { left: PERSIST_MAX_NODES });
    if (isPlainObject(walked)) row = walked;
  } catch {
    row = {};
  }
  for (const [name, label] of Object.entries(labels)) {
    if (label === undefined) delete row[name];
    else row[name] = label;
  }
  return row;
}

/** What the native trace writes for a frame that is not an object (a raw text line): this label, never the text. */
export const NATIVE_TEXT_LABEL = "[text not logged]";

/** An engine frame as the native trace keeps it (case 20, Astra r1 H10): the persisted-row allowlist at any depth, so a
 *  fileChange keeps its paths and kinds, a tool_result or output frame its ids, and a frame of an unknown shape its ids and
 *  numbers only. Never throws, never mutates. */
export function nativeTraceFrame(msg: unknown): unknown {
  if (msg === undefined || msg === null || typeof msg === "boolean" || typeof msg === "number") return msg;
  if (typeof msg === "string") return NATIVE_TEXT_LABEL;
  try {
    const walked = persistWalk(msg, undefined, 0, { left: PERSIST_MAX_NODES });
    return walked === undefined ? {} : walked;
  } catch {
    return {};
  }
}

/** The record the thread's event log keeps: everything a bug report needs,
 * never the map handed to the engine process (its value-free projection
 * instead, Astra #9). */
export function loggedRuntimeEvent<T>(given: T): T {
  if (!isPlainObject(given)) return persistedRow(given) as unknown as T;
  const e = given as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : "";
  // an unknown type keeps its envelope only
  const fields = Object.hasOwn(LOGGED_EVENT_FIELDS, type) ? LOGGED_EVENT_FIELDS[type]! : [];
  const labels = loggedEventLabels(e, type);
  const source: Record<string, unknown> = {};
  for (const name of [...EVENT_ENVELOPE, ...fields]) if (Object.hasOwn(e, name) && !Object.hasOwn(labels, name)) source[name] = e[name];
  return persistedRow(source, labels) as unknown as T;
}

/** The fields each event type may log besides its envelope (each still walked by persistedRow). A field not named here (raw,
 *  execEnv, callKey, mcpMounts, localHold, commandShell, a tool's result or detail, an image's bytes, a future field) is
 *  never written. */
const LOGGED_EVENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "session.started": ["sessionId", "model", "sessionContract"],
  "turn.subtask": ["subtask", "subtasks"],
  "session.exited": ["reason"],
  "turn.started": [],
  "turn.retrying": ["attempt", "delayMs", "reason", "maxAttempts"],
  "turn.completed": ["ok", "stopReason", "cost", "charge", "denials", "usage", "toolsUnavailable", "mcpReadiness", "deniedBy"],
  "item.started": ["itemType", "origin", "title", "input", "toolKind", "toolIdentity"],
  "item.updated": ["itemType", "tokens"],
  "item.completed": ["itemType", "origin", "ok", "text", "beforeItemId"],
  "content.delta": ["streamKind", "delta"],
  "content.reset": ["streamKind"],
  "plan.updated": ["entries"],
  "engine.commands": ["commands"],
  "steer.confirmed": ["interjectionId"],
  "question.async": ["questions"],
  "request.opened": OUT_FIELDS.filter((name) => !(EVENT_ENVELOPE as readonly string[]).includes(name)),
  // decidedBy is never logged (contracts.ts: the Inspector serves it from the decision log)
  "request.resolved": ["behavior", "source", "approvalScope", "folderTrustLate"],
  "thread.token-usage.updated": ["input", "output", "cachedInput"],
  "turn.served-model": ["routed", "requested"],
  "runtime.error": ["message", "setup", "authRequired", "claudeUpdate", "errorKind", "engineCode", "limitResetsAt", "localFailure", "localFailureEngine", "providerError", "diagnostic"],
};

/** Labels set over a logged event by trusted code: never a value copied from display text. */
function loggedEventLabels(e: Record<string, unknown>, type: string): Record<string, unknown> {
  switch (type) {
    case "item.started": {
      const tool = e.itemType === "tool";
      return {
        // L2: a trusted tool name, else a fixed label from its kind; a reasoning start's title is display text
        title: tool ? loggedToolTitle(e) : "reasoning",
        toolKind: typeof e.toolKind === "string" && LOGGED_TOOL_KINDS.has(e.toolKind) ? e.toolKind : undefined,
        toolIdentity: loggedToolIdentity(e.toolIdentity),
        input: toolStartPaths(e.input),
      };
    }
    // Astra r1 H9: a tool completion keeps its ids and ok (result and detail are not logged fields); a reply its label
    case "item.completed": return e.itemType === "assistant_text" ? { text: REPLY_LOGGED_TEXT } : {};
    case "request.opened": return askLabels(e);
    case "runtime.error": return { message: loggedErrorMessage(e.message) };
    // conversation deletion reads these back (conversation-deletion.ts collectLogSessions via threadSessionLines) to remove the
    // engine's own session: an engine's session handle (an id, or Pi's session file path) and the instance id stay whole
    case "session.started": return { sessionId: e.sessionId === null ? null : sessionHandle(e.sessionId), providerInstanceId: sessionHandle(e.providerInstanceId) };
    case "turn.retrying": return { reason: "retry" };
    case "session.exited": return { reason: e.reason !== undefined ? "exited" : undefined };
    case "content.delta": return { delta: "" };
    default: return {};
  }
}
/** An engine-issued session handle or a configured instance id: letters, digits and path characters, no whitespace, quote, `$`,
 *  backtick, `|`, `;`, `<`, `>`, `&`, bracket or control character; at most 1,024 characters. */
const SESSION_HANDLE = /^[\p{L}\p{N}\p{M}_.:@+,%~/\\-]{1,1024}$/u;
const sessionHandle = (value: unknown): string | undefined => typeof value === "string" && SESSION_HANDLE.test(value) ? value : undefined;
/** The logged text of an engine reply: this label, never the reply (it can quote any file the turn read). */
export const REPLY_LOGGED_TEXT = "[reply text not logged]";
