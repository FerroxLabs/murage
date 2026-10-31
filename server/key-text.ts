// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-KEY-TEXT (design section 14, the 1.0.13 cut): what the key guard reads as a path, what it reads as data.
// Each read here only ever narrows what a row is run over, and only when the text is positively modeled: anything this
// module cannot establish gives `undefined`, and the caller keeps today's whole read. It reads no disk.

import { lex, Unreadable, type Token, type Word } from "./shell/lex.ts";
import { SECRET_SHAPES, SENSITIVE_PATHS, SENSITIVE_RULES, SENSITIVE_TEXT, TEMPLATE_BASENAMES, luhn } from "../shared/sensitive-paths.ts";
import type { GrantCall, ResolvedCall } from "../shared/app-action-grant.ts";

export const PATH_RULES: readonly RegExp[] = SENSITIVE_PATHS.map((row) => row.re);
export const TEXT_RULES: readonly RegExp[] = SENSITIVE_TEXT.map((row) => row.re);

const templateNames = TEMPLATE_BASENAMES.map((name) => name.replace(/\./g, "\\.")).join("|");
/** A folder name on the way down: never `..`, so the word stays below where it starts. */
const DOWN = String.raw`(?:(?!\.\.[\\/])[\w.-]+[\\/])*`;
const WORD_START = String.raw`(?<=^|[\s"'=])`;
const WORD_END = String.raw`(?=$|[\s"';|&)])`;
const RELATIVE_TEMPLATE = new RegExp(`${WORD_START}${DOWN}(?:${templateNames})${WORD_END}`, "gi");
/** Text that moves where a relative word lands: the word can no longer be placed in the project. */
const MOVES_FOLDER = /(?:^|[\s;&|(`"'])(?:cd|chdir|pushd|popd|sl|Set-Location|Push-Location)(?=$|[\s;&|)"'])|\s-C\b|--(?:git-dir|work-tree|cwd|prefix|directory)\b/i;

/** A1, Rule 64's scope in text: a template basename inside the project is ordinary. A relative word that stays below
 * the folder the call runs in, or a full path under that folder, and only when the text does not move folders. Every
 * other spelling (`/srv/prod/.env.example`, `../.env.example`, `.env.example.`) keeps the row. */
export function withoutProjectTemplates(text: string, cwd: string | undefined): string {
  if (!/\.env\./i.test(text) || MOVES_FOLDER.test(text)) return text;
  let out = text.replace(RELATIVE_TEMPLATE, "_");
  if (cwd) {
    const root = cwd.replace(/[\\/]+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\\|\//g, String.raw`[\\/]`);
    if (root) out = out.replace(new RegExp(`${WORD_START}${root}[\\\\/]${DOWN}(?:${templateNames})${WORD_END}`, "gi"), "_");
  }
  return out;
}

/** A card number by network prefix: Visa, Mastercard, American Express, Discover. */
const secretCardShape = /(?<![\d-])(?:4\d|5[1-5]|2[2-7]|3[47]|6[05])(?:[ -]?\d){11,17}(?![\d-])/;

/** A card number at the key guard: a known card prefix and length, passing the Luhn check. Bare Luhn would stop one
 * command in ten that carries a 13-digit millisecond time. `secretShapeIn` keeps its wider read for a template's body. */
export function keyValueShapeIn(text: string): string | null {
  for (const row of SECRET_SHAPES) if (row.re.test(text)) return row.re.source;
  for (const match of text.matchAll(new RegExp(secretCardShape.source, "g"))) {
    const digits = match[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return secretCardShape.source;
  }
  return null;
}

const ROW_IDS: ReadonlyMap<string, string> = new Map([
  ...SENSITIVE_PATHS.map((row) => [row.re.source, row.id] as const),
  ...SENSITIVE_TEXT.map((row) => [row.re.source, row.id] as const),
  ...SECRET_SHAPES.map((row) => [row.re.source, row.id] as const),
  [secretCardShape.source, "card-number"] as const,
]);
/** `row=` on the asked line: a row's id, never its text. */
export const keyRowId = (rule: string | undefined): string | undefined => (rule === undefined ? undefined : ROW_IDS.get(rule));

// --- B1: known file tools -------------------------------------------------------------------------------------------

interface FileToolFields {
  /** fields that name a path */
  paths: readonly string[];
  /** fields that choose whose contents print: a glob */
  globs?: readonly string[];
  /** content and search text: read for value shapes only */
  data?: readonly string[];
  /** numbers, flags and names of modes: no path, no value */
  plain?: readonly string[];
  read?: true;
}

const CLAUDE_FILE_TOOLS: ReadonlyMap<string, FileToolFields> = new Map<string, FileToolFields>([
  ["Read", { paths: ["file_path"], plain: ["offset", "limit", "pages"], read: true }],
  ["NotebookRead", { paths: ["notebook_path"], plain: ["cell_id"], read: true }],
  ["Write", { paths: ["file_path"], data: ["content"] }],
  ["Edit", { paths: ["file_path"], data: ["old_string", "new_string"], plain: ["replace_all"] }],
  ["MultiEdit", { paths: ["file_path"], data: ["edits"] }],
  ["NotebookEdit", { paths: ["notebook_path"], data: ["new_source"], plain: ["cell_id", "cell_type", "edit_mode"] }],
  ["Grep", { paths: ["path"], globs: ["glob", "include"], data: ["pattern"], plain: ["type", "output_mode", "head_limit", "offset", "multiline", "-A", "-B", "-C", "-i", "-n", "context"] }],
  ["Glob", { paths: ["path"], data: ["pattern"] }],
]);
const PI_FILE_TOOLS: ReadonlyMap<string, FileToolFields> = new Map<string, FileToolFields>([
  ["read", { paths: ["path"], plain: ["offset", "limit"], read: true }],
  ["write", { paths: ["path"], data: ["content"] }],
  ["edit", { paths: ["path"], data: ["oldText", "newText", "edits"] }],
  ["grep", { paths: ["path"], globs: ["glob"], data: ["pattern"], plain: ["ignoreCase", "literal", "context", "limit"] }],
]);
/** ACP names a tool by its protocol kind, never by its title. Stamped `opencode` `write` is the same edit. */
const ACP_KINDS: ReadonlyMap<string, FileToolFields> = new Map<string, FileToolFields>([
  ["read", { paths: ["path", "file_path", "filePath"], plain: ["offset", "limit", "line"], read: true }],
  ["edit", { paths: ["path", "file_path", "filePath"], data: ["content", "old_string", "new_string", "oldText", "newText", "edits"] }],
]);

export interface FileToolRead {
  paths: string[];
  globs: string[];
  /** a read kind: a tooling place may be read, a key place cards (3.2) */
  read: boolean;
  /** the card text came from the engine's own title, so it stays in the read; false: it is a copy of the input */
  summaryRead: boolean;
}

function fileToolTable(tool: string, call: GrantCall | undefined, resolved: ResolvedCall): FileToolFields | undefined {
  const name = call?.toolCall?.name;
  if (resolved.kind === "engine") return resolved.wrapped ? undefined : resolved.byKind ? ACP_KINDS.get(resolved.name) : resolved.name === "write" ? ACP_KINDS.get("edit") : undefined;
  if (resolved.kind !== "unstamped") return undefined;
  if (call?.engine === "claude") return tool === name ? CLAUDE_FILE_TOOLS.get(tool) : undefined;
  if (call?.engine === "pi") return name !== undefined ? PI_FILE_TOOLS.get(name) : undefined;
  return undefined;
}

/** B1: the fields of a known file tool by role, or undefined for today's whole read. Every field must be known and every
 * path field a plain string: a field this table does not name could be a path. */
export function fileToolRead(tool: string, call: GrantCall | undefined, resolved: ResolvedCall, summary: string): FileToolRead | undefined {
  const table = fileToolTable(tool, call, resolved);
  const input = resolved.kind === "engine" ? resolved.input : call?.toolCall?.input;
  if (!table || !input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const body = input as Record<string, unknown>;
  const known = new Set([...table.paths, ...(table.globs ?? []), ...(table.data ?? []), ...(table.plain ?? [])]);
  const paths: string[] = [], globs: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!known.has(key)) return undefined;
    if (table.paths.includes(key)) { if (typeof value !== "string") return undefined; paths.push(value); }
    if (table.globs?.includes(key)) { if (typeof value !== "string") return undefined; globs.push(value); }
    if (table.plain?.includes(key) && typeof value === "object" && value !== null) return undefined;
  }
  const native = resolved.kind === "unstamped";
  if (native && !summaryIsInputCopy(summary, body, tool, paths)) return undefined;
  return { paths, globs, read: table.read === true, summaryRead: !native };
}

/** The drivers' own card text for a file call: the input as JSON up to 200 characters (Claude), or `Edit <path>` and
 * `pi wants to use <tool>` (Pi). Anything else was not built from the input and stays in the read. */
function summaryIsInputCopy(summary: string, input: Record<string, unknown>, tool: string, paths: readonly string[]): boolean {
  if (summary === "" || summary === tool) return true;
  if (summary === JSON.stringify(input).slice(0, 200)) return true;
  if (paths.some((path) => summary === `${tool} ${path}`.slice(0, 2_000))) return true;
  return /^pi wants to use [\w-]{1,80}$/.test(summary);
}

/** The rows a read-kind file tool is judged by: a tooling place's contents are not a key, so reading one passes. A write
 * cards on every row. Rows 15, 16 and 19 stay out of this: the murage-exec env file carries the whole environment
 * (execEnvFileText), the hook env files carry the hook's own secret, and a Fuigo config can carry a provider key. */
const READ_PASS = new Set(["project-tooling", "agy-workspace-hooks", "project-git"]);
const GIT_CONFIG = /(^|[\s/"'])\.git[\\/]config\b/i;
const READ_KIND_RULES: readonly RegExp[] = [
  ...SENSITIVE_RULES.filter((re) => !SENSITIVE_PATHS.some((row) => row.re === re && READ_PASS.has(row.id))),
  GIT_CONFIG,
];
/** A path a read kind may judge by the narrower rows: no climb, so the row that names it names where it lands. */
export function readKindRules(path: string): readonly RegExp[] {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path) ? SENSITIVE_RULES : READ_KIND_RULES;
}

/** 3.5: a local hold a Read may drop: exactly a tooling row's id. `project-git` needs the path check, which the caller makes. */
export const isReadPassHold = (id: string): boolean => READ_PASS.has(id);

// --- the split and D2, D3 ---------------------------------------------------------------------------------------------

/** The word list of the 3.3 split: anything here makes the whole text unmodeled. */
const UNMODELED_WORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "select", "in", "!", "[[", "]]", "{", "}",
  "eval", "exec", "source", ".", "trap", "alias", "xargs", "enable", "hash", "shopt", "bind", "unalias",
]);
const WRAPPERS = new Set(["sudo", "command", "builtin", "nice", "time", "nohup"]);
/** Narrowing (iii): a trace prints what the split calls silent. */
const TRACING = /\bset\s+[-+][a-zA-Z]*x|\bxtrace\b|BASH_XTRACEFD|SHELLOPTS|\bPS4\b/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const MAX_SIMPLE_COMMANDS = 64;
const HOME_VARS = new Set(["HOME"]);

/** Downstream of a data command only these may run: nothing here reads an operand or turns input into a path. */
function fitsFilter(words: readonly Word[]): boolean {
  const text = words.map(plainWord);
  if (text.some((word) => word === undefined)) return false;
  const [program, ...rest] = text as string[];
  if (program === "cat" || program === "less" || program === "more") return rest.length === 0;
  if (program === "wc") return rest.every((word) => /^-[lcwm]$/.test(word));
  if (program === "head" || program === "tail") {
    for (let i = 0; i < rest.length; i++) {
      if (/^-\d+$/.test(rest[i]!)) continue;
      if (/^-[nc]$/.test(rest[i]!) && /^\d+$/.test(rest[i + 1] ?? "")) { i++; continue; }
      return false;
    }
    return true;
  }
  return false;
}

function plainWord(word: Word): string | undefined {
  if (word.parts.length !== 1) return undefined;
  const [part] = word.parts;
  return part?.kind === "lit" && part.quote === "none" ? part.text : undefined;
}

/** A word as bash hands it on, or undefined for a part this read does not model. `path`: a variable part other than a
 * leading home is unmodeled. */
function wordText(word: Word, path: boolean, forGlob: boolean): string | undefined {
  let out = "";
  for (const [index, part] of word.parts.entries()) {
    switch (part.kind) {
      case "lit": out += forGlob ? part.text.replace(part.quote === "none" ? /[*?]/g : /[*?[\]]/g, "_") : part.text; break;
      case "tilde": out += `~${part.user}`; break;
      case "glob": out += part.text; break;
      case "var":
        if (part.op !== undefined || part.word !== undefined) return undefined;
        if (path && !(index === 0 && HOME_VARS.has(part.name))) return undefined;
        out += `$${part.name}`;
        break;
      default: return undefined;
    }
  }
  return out;
}

interface SimpleCommand { words: Word[]; redirects: Word[] }

/** Lexed tokens into pipelines of simple commands, or undefined when the text is not modeled. */
function pipelinesOf(tokens: readonly Token[]): SimpleCommand[][] | undefined {
  const pipelines: SimpleCommand[][] = [[]];
  let current: SimpleCommand = { words: [], redirects: [] };
  let count = 0;
  const end = (pipe: boolean): boolean => {
    if (!current.words.length && !current.redirects.length) { if (pipe) return false; }
    else { pipelines[pipelines.length - 1]!.push(current); count++; }
    current = { words: [], redirects: [] };
    if (!pipe) pipelines.push([]);
    return count <= MAX_SIMPLE_COMMANDS;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "eof") break;
    if (token.kind === "word") { current.words.push(token.word); continue; }
    if (token.kind === "newline") { if (!end(false)) return undefined; continue; }
    if (token.heredoc) return undefined;
    if (token.op === ";" || token.op === "&&" || token.op === "||" || token.op === "&") { if (!end(false)) return undefined; continue; }
    if (token.op === "|" || token.op === "|&") { if (!end(true)) return undefined; continue; }
    if ([">", ">>", ">|", "<", "<>", "&>", "&>>", "<<<", ">&", "<&"].includes(token.op)) {
      const next = tokens[i + 1];
      if (next?.kind !== "word") return undefined;
      i++;
      // `>&2`, `2>&1`, `<&3`, `>&-`: a descriptor, no file
      if ((token.op === ">&" || token.op === "<&") && /^(?:\d+|-)$/.test(plainWord(next.word) ?? "")) continue;
      current.redirects.push(next.word);
      continue;
    }
    return undefined;
  }
  return end(false) ? pipelines.filter((pipeline) => pipeline.length) : undefined;
}

/** Where the program stands after assignments and wrappers, or -1 for none, or undefined when unmodeled. Narrowing (ii):
 * any option on a wrapper. `env` is a wrapper only when a program follows its assignments. */
function programIndex(words: readonly Word[]): number | undefined {
  let at = 0;
  const assignments = () => { while (at < words.length && ASSIGNMENT.test(wordText(words[at]!, false, false) ?? "")) at++; };
  assignments();
  for (;;) {
    const word = words[at];
    if (!word) return -1;
    const text = plainWord(word);
    if (text === undefined) return undefined;
    if (!WRAPPERS.has(text) && text !== "env") return at;
    const next = words[at + 1];
    if (next && (plainWord(next) ?? wordText(next, false, false) ?? "-").startsWith("-")) return undefined;
    if (!next) return text === "env" ? -1 : at;
    at++;
    if (text === "env") assignments();
    if (text === "env" && at >= words.length) return -1;
  }
}

/** D2 and D3: which of a simple command's words are data. */
function dataWords(words: readonly Word[], program: number): Set<Word> | undefined {
  const name = plainWord(words[program]!);
  const data = new Set<Word>();
  const rest = words.slice(program + 1);
  if (name === "echo") { for (const word of rest) data.add(word); return data; }
  if (name === "printf") {
    if (plainWord(rest[0] ?? { parts: [] }) === "-v") return undefined;
    for (const word of rest) data.add(word);
    return data;
  }
  if (name !== "git") return data;
  const verb = plainWord(rest[0] ?? { parts: [] });
  if (verb !== "commit" && verb !== "tag") return data;
  for (let i = 1; i < rest.length; i++) {
    const text = plainWord(rest[i]!) ?? "";
    if (text === "--") break;
    if (text === "-m" || text === "--message" || /^-[aqsvnef]+m$/.test(text)) {
      const message = rest[i + 1];
      if (message) { data.add(message); i++; }
      continue;
    }
    if ((wordText(rest[i]!, false, false) ?? "").startsWith("--message=")) data.add(rest[i]!);
  }
  return data;
}

export interface CommandDataRead {
  /** the command's path-position words, data operands out: what the path rows read */
  paths: string;
  /** the same words as the glob reader takes them */
  globs: string;
}

/** The split (3.3) and D2, D3 over one bash text, or undefined when the text is unmodeled or carries no data operand. */
export function commandDataRead(command: string): CommandDataRead | undefined {
  const read = splitCommand(command);
  return typeof read === "object" ? read : undefined;
}

/** The same read with its reason: `unmodeled` keeps today's read as a named class on the asked line; `plain` is a modeled
 * text with nothing to take out. */
export function splitCommand(command: string): CommandDataRead | "unmodeled" | "plain" {
  return splitOf(command) ?? "unmodeled";
}

function splitOf(command: string): CommandDataRead | "plain" | undefined {
  if (TRACING.test(command) || /(?:^|[\s;&|(])\\/.test(command)) return undefined;
  let tokens: Token[];
  try { tokens = lex(command); } catch (error) {
    if (error instanceof Unreadable) return undefined;
    return undefined;
  }
  const pipelines = pipelinesOf(tokens);
  if (!pipelines) return undefined;
  const paths: string[] = [], globs: string[] = [];
  let masked = false;
  for (const pipeline of pipelines) {
    for (const [stage, simple] of pipeline.entries()) {
      const program = programIndex(simple.words);
      if (program === undefined) return undefined;
      const name = program >= 0 ? plainWord(simple.words[program]!) : undefined;
      if (program >= 0 && (name === undefined || UNMODELED_WORDS.has(name))) return undefined;
      let data: Set<Word> | undefined = new Set();
      if (program >= 0 && stage === 0) {
        data = dataWords(simple.words, program);
        if (!data) return undefined;
        if (data.size && !pipeline.slice(1).every((next) => !next.redirects.length && fitsFilter(next.words))) return undefined;
      }
      for (const word of simple.words) {
        const text = wordText(word, true, false), glob = wordText(word, true, true);
        if (data.has(word)) {
          if (wordText(word, false, false) === undefined) return undefined;
          masked = true;
          continue;
        }
        // an assignment's value is a path word too (narrowing i); only a home variable may lead it
        if (text === undefined || glob === undefined) return undefined;
        paths.push(text); globs.push(glob);
      }
      for (const word of simple.redirects) {
        const text = wordText(word, true, false), glob = wordText(word, true, true);
        if (text === undefined || glob === undefined) return undefined;
        paths.push(text); globs.push(glob);
      }
    }
  }
  return masked ? { paths: paths.join(" "), globs: globs.join(" ") } : "plain";
}
