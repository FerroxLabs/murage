// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Always allow this exact command here": a remembered grant keyed by the
// command's own text, the folder it runs in and the engine that asks. It is
// the narrow sibling of the per-program grant (`Bash:git`, see
// server/auto-approve.ts approvalKey), and it covers complex shell syntax
// that has no per-program key at all, because nothing is inferred from the
// text: the grant matches the same command, in the same folder, on the same
// engine, and nothing else.
//
// The grant rides in the bot's existing `alwaysAllow` list as one string,
// `exact:` + a JSON array [engine, folder, command], so every place that
// already scopes, copies, clears or refuses remembered grants (tasks, rooms,
// restore, channel people, question tools) treats it the same way. Guards
// still outrank it: server/auto-approve.ts consults it exactly where it
// consults the per-program grant.
//
// Shared with the renderer, so no node: imports here.

export const EXACT_COMMAND_PREFIX = "exact:";
export const EXACT_COMMAND_MAX_CHARS = 4_000;
const EXACT_CWD_MAX_CHARS = 1_024;
const EXACT_ENGINE_MAX_CHARS = 200;

export interface ExactCommand {
  /** the engine instance that asked (a provider instance id) */
  engine: string;
  /** the absolute folder the command runs in, spelled as reported */
  cwd: string;
  /** the command text, normalized by `normalizeCommand` */
  command: string;
}

/** Trim the ends and collapse runs of spaces and tabs between words to one
 * space. Nothing else changes: whitespace inside quotes, after a backslash
 * (or a Windows `^`) and every line break stays exactly as written, and a
 * here-doc or nested substitution is only trimmed. Anything the scan is unsure
 * of is left alone, so two commands that differ in meaning never normalize to
 * the same text. */
export function normalizeCommand(text: string): string {
  const trimmed = text.trim();
  // Here-doc bodies are data, and quotes nested inside `$(…)`, `${…}`,
  // backticks or `$'…'` do not pair up the way a flat scan reads them, so
  // those commands are only trimmed.
  if (/<<|\$\(|\$\{|`|\$'/.test(trimmed)) return trimmed;
  let out = "";
  let quote: "'" | '"' | undefined;
  let space = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (quote) {
      out += ch;
      if (quote === '"' && ch === "\\" && i + 1 < trimmed.length) out += trimmed[++i];
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === " " || ch === "\t") {
      space = true;
      continue;
    }
    if (space) {
      // a space next to a line break separates nothing
      if (ch !== "\n" && out.length > 0 && !out.endsWith("\n")) out += " ";
      space = false;
    }
    out += ch;
    if ((ch === "\\" || ch === "^") && i + 1 < trimmed.length) out += trimmed[++i];
    else if (ch === "'" || ch === '"') quote = ch;
  }
  return out;
}

function isAbsoluteFolder(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path);
}

function usableFolder(cwd: unknown): cwd is string {
  return typeof cwd === "string" && cwd.length > 0 && cwd.length <= EXACT_CWD_MAX_CHARS &&
    !/[\u0000-\u001f\u007f]/.test(cwd) && isAbsoluteFolder(cwd) && !cwd.split(/[\\/]/).includes("..");
}

function usableCommand(command: string): boolean {
  return command.length > 0 && command.length <= EXACT_COMMAND_MAX_CHARS &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command);
}

function usableEngine(engine: unknown): engine is string {
  return typeof engine === "string" && engine.length > 0 && engine.length <= EXACT_ENGINE_MAX_CHARS &&
    engine.trim() === engine && !/[\u0000-\u001f\u007f]/.test(engine);
}

/** The remembered key, or undefined when the command, folder or engine
 * cannot name one exact place (then the card offers no exact grant). */
export function exactCommandKey(input: ExactCommand): string | undefined {
  if (!usableEngine(input.engine) || !usableFolder(input.cwd) || typeof input.command !== "string") return undefined;
  const command = normalizeCommand(input.command);
  if (!usableCommand(command)) return undefined;
  return `${EXACT_COMMAND_PREFIX}${JSON.stringify([input.engine, input.cwd, command])}`;
}

export function isExactCommandKey(key: string): boolean {
  return key.startsWith(EXACT_COMMAND_PREFIX);
}

/** Read a remembered key back, for display. Only a key this module would
 * have written parses; anything else is undefined. */
export function parseExactCommandKey(key: string): ExactCommand | undefined {
  if (!isExactCommandKey(key)) return undefined;
  let parts: unknown;
  try { parts = JSON.parse(key.slice(EXACT_COMMAND_PREFIX.length)); } catch { return undefined; }
  if (!Array.isArray(parts) || parts.length !== 3 || !parts.every((part) => typeof part === "string")) return undefined;
  const [engine, cwd, command] = parts as [string, string, string];
  const parsed = { engine, cwd, command };
  return exactCommandKey(parsed) === key ? parsed : undefined;
}

const PLAIN_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** The command as the ENGINE reported it in its structured tool input, never
 * the card's display text. A string is taken as is; an argument list is
 * quoted so two different lists can never read as the same command. */
export function commandFromToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const command = (input as { command?: unknown }).command;
  if (typeof command === "string") return command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string")) return undefined;
  return (command as string[]).map((part) => PLAIN_ARG.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`).join(" ");
}

/** The folder the engine says this one command runs in: undefined when it
 * names none (the turn's folder applies), null when what it names cannot be
 * placed (relative, or two fields that disagree), which offers no grant. */
export function commandCwdFromToolInput(input: unknown): string | null | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const named = ["cwd", "workdir", "working_directory", "directory", "dir"]
    .filter((field) => record[field] !== undefined)
    .map((field) => record[field]);
  if (named.length === 0) return undefined;
  if (!named.every(usableFolder) || new Set(named).size > 1) return null;
  return named[0] as string;
}
