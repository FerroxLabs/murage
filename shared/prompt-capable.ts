// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rule 68f, row kind "prompt-capable" (APP-GRANT-FIXPLAN-r6 (e)+(h) (c), design delta 4' (c)): the one reader over
// PROMPT_ROWS (shared/arg-vocabulary.ts). It splits a command line into simple commands, judges each program word by its
// row, then what a wrapper or a body reader carries, and returns the first row that holds the card, or null. It only ever
// removes a standing answer: text it cannot split, or a program word only known when it runs, holds.

import {
  directSshMeetsRow, ESCALATOR_OPTIONS, GIT_CONFIG_MOVERS, GIT_FALSE_WORDS, GIT_SIGNING, GIT_TRUE_WORDS, gitNetworkCommand,
  ABSENT_PINS, ENV_PINS, gitSubcommand, GPG_ASKING_LETTERS, KEPT_ENV, GPG_ASKING_LONG, GPG_EFFECTIVE, GPG_HOLDING, GPG_HOME_NAMES, GPG_READ_ONLY, PIN_NAMES, pinOverride, PROMPT_BODY_READERS,
  PROMPT_ROWS, PTY_ADDRESS_PROGRAMS, repoSshCommandMismatch, SHELL_LEADING_WORDS, SSH_ADD_QUIET, sshRequestsTty, WRAPPER_PREFIXES,
  WRAPPER_VALUE_OPTIONS, type InheritedEnv, type PromptRow, type PromptRule, type SshSource,
} from "./arg-vocabulary.ts";
import { repoConfigValues } from "./disk-facts.ts";
import { realPathInOrder } from "./in-project.ts";

/** What the git rows read: the folder the command runs in (the exact-command cwd, else the turn's), the HOME handed to the
 *  engine, what the hand did with the owner's ssh setting, and (tests) the system git config file. Missing facts make only
 *  the git rows prompt-capable. */
export interface PromptFacts {
  cwd: string;
  home: string;
  ssh?: { source: SshSource; kept: boolean };
  systemConfig?: string;
}

export interface PromptHit { rule: PromptRule; note: string }

/** Bodies inside bodies past this depth are not read; the strict reader holds. */
const MAX_DEPTH = 6;

const ROW = new Map<PromptRule, PromptRow>(PROMPT_ROWS.map((row) => [row.rule, row]));
const hit = (rule: PromptRule, note?: string): PromptHit => ({ rule, note: note ?? ROW.get(rule)!.reason });
const unreadableHit = (): PromptHit => hit("unreadable");
const unreadable = unreadableHit;

/** Is this command text prompt-capable? The first row that holds, or null. */
export function promptVerdict(text: string, facts: PromptFacts | undefined): PromptHit | null {
  return judgeText(text, facts, true, 0);
}

/** Rule 68f case 1 (U19) over the same reading: the first simple command, wherever it stands (a wrapper's command, a shell
 *  body, a substitution), that sets a PIN_NAMES name to anything but the hand's pin or carries a listed option. `pins` is
 *  the requesting engine's handed pin map. Returns pinOverride's reason, or null. It never reads what it cannot split: the
 *  prompt reader holds that text on its own. */
export function pinOverrideIn(text: string, pins: ReadonlyMap<string, string>, shell?: "pwsh"): string | null {
  // Section 11 D2: a PowerShell command (Claude's PowerShell tool, Codex and ACP commands under `powershell.exe -Command`) is
  // read with PowerShell's own spellings first, then as every command is
  return (shell === "pwsh" ? pwshPinTouch(text) : null) ?? pinTouch(text, pins) ?? judgeText(text, { pins }, false, 0)?.note ?? null;
}

/** The pin mode of the reader: judges only Rule 68f case 1, never a prompt row. */
interface PinMode { pins: ReadonlyMap<string, string> }
type Facts = PromptFacts | PinMode | undefined;
const pinMode = (facts: Facts): facts is PinMode => facts !== undefined && "pins" in facts;
const PIN_RULE: PromptRule = "unreadable";
/** The programs Rule 68f case 1 reads options of. */
const PIN_PROGRAMS: ReadonlySet<string> = new Set(PIN_NAMES.filter((row) => row.options.length > 0).map((row) => row.program));

// ---- splitting ----------------------------------------------------------------------------------------------------------------

/** One word; `start` and `end` are its offsets in the text split. */
interface Word { text: string; dynamic: boolean; glob: boolean; quoted: boolean; assignment: string | undefined; start: number; end: number }
/** One simple command: its words, its here-documents, and the quoted bodies its words carry. */
interface Simple { words: Word[]; heredocs: Doc[]; bodies: string[] }
/** A here-document's body. Whether its delimiter was quoted decides only where the body may end: every body is checked as
 *  text with the static rules. */
interface Doc { body: string }
type Draft = Word & { braces: boolean };
/** `unsureDoc`: a here-document's delimiter or end line could not be read with certainty, or its body never closes. */
interface Split { commands: Simple[]; substitutions: string[]; quoted: string[]; cannot: boolean; unsureDoc: boolean }

const REDIRECTS = ["&>>", "&>", ">>", ">&", ">|", "<>", "<&", ">", "<"];

/** The index of the `)` closing a group opened just before `from`, or -1. */
function matchParen(text: string, from: number): number {
  let depth = 1;
  for (let k = from; k < text.length; k++) {
    const c = text[k];
    if (c === "\\") { k++; continue; }
    if (c === "'") { k = text.indexOf("'", k + 1); if (k < 0) return -1; continue; }
    if (c === '"') {
      k++;
      while (k < text.length && text[k] !== '"') k += text[k] === "\\" ? 2 : 1;
      if (k >= text.length) return -1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return k;
  }
  return -1;
}

function findBacktick(text: string, from: number): number {
  for (let k = from; k < text.length; k++) {
    if (text[k] === "\\") { k++; continue; }
    if (text[k] === "`") return k;
  }
  return -1;
}

/** `code`: the bodies of the expansions that run code inside a `${...}`, `$((...))` or `$"..."` form, read again as shell. */
interface DollarRead { end: number; dynamic: boolean; sub?: string; lenient?: string; literal?: string; quoted?: boolean; code?: string[] }

/** The index of the `}` closing a `${` opened just before `from`, nesting and quotes honoured, or -1. */
function matchBrace(text: string, from: number): number {
  let depth = 1;
  for (let k = from; k < text.length; k++) {
    const c = text[k]!;
    if (c === "\\") { k++; continue; }
    if (c === "'") { k = text.indexOf("'", k + 1); if (k < 0) return -1; continue; }
    if (c === '"') {
      k++;
      while (k < text.length && text[k] !== '"') k += text[k] === "\\" ? 2 : 1;
      if (k >= text.length) return -1;
      continue;
    }
    if (c === "`") { k = findBacktick(text, k + 1); if (k < 0) return -1; continue; }
    if (c === "(") { k = matchParen(text, k + 1); if (k < 0) return -1; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return k;
  }
  return -1;
}

/** One `$` form at `i`; null when it does not close. */
function readDollar(text: string, i: number, inDouble: boolean): DollarRead | null {
  const next = text[i + 1];
  if (next === "(") {
    const end = matchParen(text, i + 2);
    if (end < 0) return null;
    // `$(( ))` is arithmetic: its words are not commands, but a substitution inside it is
    if (text[i + 2] === "(") return { end: end + 1, dynamic: true, lenient: text.slice(i + 3, end - 1), code: codeBodies(text.slice(i + 3, end - 1)) };
    return { end: end + 1, dynamic: true, sub: text.slice(i + 2, end) };
  }
  if (next === "{") {
    // an operator's word (replacement, default, alternative, trim) is expanded, so what runs code in it is read as shell
    const braced = matchBrace(text, i + 2);
    const end = braced < 0 ? text.indexOf("}", i + 2) : braced;
    if (end < 0) return null;
    return { end: end + 1, dynamic: true, lenient: text.slice(i + 2, end), code: codeBodies(text.slice(i + 2, end)) };
  }
  if (!inDouble && next === "'") {
    let k = i + 2;
    while (k < text.length && text[k] !== "'") k += text[k] === "\\" ? 2 : 1;
    if (k >= text.length) return null;
    const body = text.slice(i + 2, k);
    // with no escape in it, `$'...'` is the literal text, read statically like '...'
    if (!body.includes("\\")) return { end: k + 1, dynamic: false, literal: body, quoted: true };
    return { end: k + 1, dynamic: true, lenient: body };
  }
  if (!inDouble && next === '"') {
    const read = readDouble(text, i + 2);
    if (!read) return null;
    return { end: read.end, dynamic: true, lenient: read.value, code: read.subs };
  }
  if (next !== undefined && /[A-Za-z_]/.test(next)) {
    let k = i + 1;
    while (k < text.length && /[A-Za-z0-9_]/.test(text[k]!)) k++;
    return { end: k, dynamic: true };
  }
  if (next !== undefined && /[0-9@*#?$!-]/.test(next)) return { end: i + 2, dynamic: true };
  return { end: i + 1, dynamic: false, literal: "$" };
}

interface DoubleRead { value: string; end: number; dynamic: boolean; subs: string[]; lenient: string[] }

/** A double-quoted body starting at `from` (after the opening quote); null when it does not close. */
function readDouble(text: string, from: number): DoubleRead | null {
  let value = "";
  let dynamic = false;
  const subs: string[] = [];
  const lenient: string[] = [];
  let k = from;
  while (k < text.length) {
    const c = text[k]!;
    if (c === '"') return { value, end: k + 1, dynamic, subs, lenient };
    if (c === "\\") {
      const n = text[k + 1];
      if (n === "\n") { k += 2; continue; }
      if (n !== undefined && /[$`"\\]/.test(n)) { value += n; k += 2; continue; }
      value += c;
      k++;
      continue;
    }
    if (c === "$") {
      const read = readDollar(text, k, true);
      if (!read) return null;
      if (read.dynamic) dynamic = true;
      if (read.sub !== undefined) subs.push(read.sub);
      if (read.code) subs.push(...read.code);
      if (read.lenient !== undefined) lenient.push(read.lenient);
      value += read.literal ?? "";
      k = read.end;
      continue;
    }
    if (c === "`") {
      const end = findBacktick(text, k + 1);
      if (end < 0) return null;
      dynamic = true;
      subs.push(text.slice(k + 1, end).replace(/\\([`\\$])/g, "$1"));
      k = end + 1;
      continue;
    }
    value += c;
    k++;
  }
  return null;
}

/** Split text into simple commands at `;`, `&&`, `||`, `|`, `&`, newline, `(`, `)`, `$(`, backtick and `{ }`, with every
 *  command substitution, quoted body and here-document kept for a second reading. */
function split(text: string): Split {
  const commands: Simple[] = [];
  const substitutions: string[] = [];
  const quoted: string[] = [];
  let cannot = false;
  let command: Simple = { words: [], heredocs: [], bodies: [] };
  // a here-document delimiter could not be read with certainty, so where its body ends is unknown
  let unsureDoc = false;
  let word: Draft | null = null;
  // closures read the declared type, so the loop reaches the word in progress through these two
  const current = (): Draft | null => word;
  let redirectNext = false;
  const pending: { delim: string; quoted: boolean; strip: boolean; target: Simple }[] = [];

  const startWord = (at: number): Draft => {
    if (word) return word;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(text.slice(at, at + 256));
    const fresh: Draft = { text: "", dynamic: false, glob: false, quoted: false, assignment: m ? m[1] : undefined, braces: false, start: at, end: at };
    word = fresh;
    return fresh;
  };
  const endWord = () => {
    const w = word;
    word = null;
    if (!w) return;
    if (redirectNext) { redirectNext = false; return; }
    if (!w.quoted && !w.dynamic && (w.text === "{" || w.text === "}")) { endCommand(); return; }
    if (w.braces) w.glob = true;
    command.words.push({ text: w.text, dynamic: w.dynamic, glob: w.glob, quoted: w.quoted, assignment: w.assignment, start: w.start, end: w.end });
  };
  const endCommand = () => {
    endWord();
    // a redirection-only command (`<<EOF` alone) is kept: its here-document is attached to it once the line ends
    if (command.words.length || command.heredocs.length || pending.some((doc) => doc.target === command)) commands.push(command);
    command = { words: [], heredocs: [], bodies: [] };
  };
  // A body runs to the line that is its delimiter. Where the reader cannot be certain of that line it never guesses: the line
  // is then not split, and U19 holds it. Uncertain: a body that never closes (the delimiter was read differently from how
  // the shell will read it, or the text ends first), and, under an unquoted delimiter, a line ending in a backslash (bash and
  // zsh join it with the next line before comparing, dash compares the line as written, so the two readings end the body in
  // different places).
  const readHeredocs = (from: number): number => {
    let k = from;
    for (const doc of pending) {
      let body = "";
      let closed = false;
      while (k < text.length) {
        const nl = text.indexOf("\n", k);
        const line = text.slice(k, nl < 0 ? text.length : nl);
        k = nl < 0 ? text.length : nl + 1;
        if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) { closed = true; break; }
        if (!doc.quoted && line.endsWith("\\")) { cannot = true; unsureDoc = true; return k; }
        body += `${line}\n`;
      }
      if (!closed) { cannot = true; unsureDoc = true; return k; }
      doc.target.heredocs.push({ body });
    }
    pending.length = 0;
    return k;
  };

  let i = 0;
  while (i < text.length) {
    const open = current();
    if (open) open.end = i;
    const ch = text[i]!;
    if (ch === "\0") { cannot = true; break; }
    if (ch === "\\") {
      if (text[i + 1] === "\n") { i += 2; continue; }
      const w = startWord(i);
      w.text += text[i + 1] ?? "";
      w.quoted = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) { cannot = true; break; }
      const w = startWord(i);
      const body = text.slice(i + 1, end);
      w.text += body;
      w.quoted = true;
      quoted.push(body);
      command.bodies.push(body);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      const read = readDouble(text, i + 1);
      if (!read) { cannot = true; break; }
      const w = startWord(i);
      w.text += read.value;
      w.quoted = true;
      if (read.dynamic) w.dynamic = true;
      substitutions.push(...read.subs);
      quoted.push(read.value, ...read.lenient);
      command.bodies.push(read.value, ...read.lenient);
      i = read.end;
      continue;
    }
    if (ch === "`") {
      const end = findBacktick(text, i + 1);
      if (end < 0) { cannot = true; break; }
      startWord(i).dynamic = true;
      substitutions.push(text.slice(i + 1, end).replace(/\\([`\\$])/g, "$1"));
      i = end + 1;
      continue;
    }
    if (ch === "$") {
      const read = readDollar(text, i, false);
      if (!read) { cannot = true; break; }
      const w = startWord(i);
      if (read.dynamic) w.dynamic = true;
      if (read.sub !== undefined) substitutions.push(read.sub);
      if (read.code) substitutions.push(...read.code);
      if (read.lenient !== undefined) { quoted.push(read.lenient); command.bodies.push(read.lenient); }
      if (read.quoted) { w.quoted = true; quoted.push(read.literal!); command.bodies.push(read.literal!); }
      w.text += read.literal ?? "";
      i = read.end;
      continue;
    }
    if ((ch === "<" || ch === ">") && text[i + 1] === "(") {
      const end = matchParen(text, i + 2);
      if (end < 0) { cannot = true; break; }
      startWord(i).dynamic = true;
      substitutions.push(text.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    if (ch === "<" || ch === ">" || (ch === "&" && text[i + 1] === ">")) {
      // a word of digits just before is the file descriptor
      const w = current();
      if (w && !w.quoted && !w.dynamic && /^\d+$/.test(w.text)) word = null;
      else endWord();
      if (text.startsWith("<<<", i)) { i += 3; redirectNext = true; continue; }
      if (text.startsWith("<<", i)) {
        i += 2;
        let strip = false;
        if (text[i] === "-") { strip = true; i++; }
        while (text[i] === " " || text[i] === "\t") i++;
        const read = readDelimiter(text, i);
        if (!read) { cannot = true; unsureDoc = true; break; }
        i = read.end;
        pending.push({ delim: read.delim, quoted: read.quoted, strip, target: command });
        continue;
      }
      const op = REDIRECTS.find((candidate) => text.startsWith(candidate, i))!;
      i += op.length;
      redirectNext = true;
      continue;
    }
    if (ch === "#" && !current()) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") { endWord(); i++; continue; }
    if (ch === "\n") {
      endCommand();
      i++;
      if (pending.length) i = readHeredocs(i);
      if (cannot) break;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") { endCommand(); i++; continue; }
    const w = startWord(i);
    if (ch === "*" || ch === "?" || ch === "[") w.glob = true;
    if (ch === "{" || ch === "}") w.braces = true;
    w.text += ch;
    i++;
  }
  if (!cannot) {
    const open = current();
    if (open) open.end = i;
    endCommand();
    if (pending.length) readHeredocs(text.length);
  }
  return { commands, substitutions, quoted, cannot, unsureDoc };
}

/** A here-document's delimiter, read as the shell reads it: quote marks dropped, every character inside them kept (`"E'OF"` is
 *  `E'OF`). Null when it cannot be read with certainty (an unclosed quote, a quote or backslash spanning a line, `$` or a
 *  backtick, which `$'...'`, `$"..."` and an expansion would read differently, or no word at all): the line is then not split,
 *  and U19 holds it. A quoted empty delimiter (`''`, `""`) is read: the body ends at the first empty line. */
function readDelimiter(text: string, from: number): { delim: string; quoted: boolean; end: number } | null {
  let delim = "";
  let quotedPart = false;
  let i = from;
  while (i < text.length && !/[\s;&|<>()]/.test(text[i]!)) {
    const c = text[i]!;
    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined || next === "\n") return null;
      delim += next;
      quotedPart = true;
      i += 2;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      const part = text.slice(i + 1, end);
      if (part.includes("\n")) return null;
      delim += part;
      quotedPart = true;
      i = end + 1;
    } else if (c === '"') {
      let k = i + 1;
      for (; k < text.length && text[k] !== '"'; k++) {
        const d = text[k]!;
        if (d === "\\" && /[\\"$`]/.test(text[k + 1] ?? "")) { delim += text[++k] ?? ""; continue; }
        if (d === "$" || d === "`" || d === "\n") return null;
        delim += d;
      }
      if (k >= text.length) return null;
      quotedPart = true;
      i = k + 1;
    } else if (c === "$" || c === "`") {
      return null;
    } else {
      delim += c;
      i++;
    }
  }
  return delim || quotedPart ? { delim, quoted: quotedPart, end: i } : null;
}

// ---- Rule 68f case 1, the static reading (threat verdict 2026-10-19, ship rule S, with the r2 amendment) ---------------------
// The order of a line is not modelled. If a pinned name (every ENV_PINS name and git's GIT_CONFIG* family) is set, removed,
// exported, cleared or named ANYWHERE on the line (an assignment, export and its kin, unset, read, printf -v, a
// parameter default, env -u/-i/-/-S, exec -c, an eval, shell, substitution or here-document body), the line is U19, whatever
// runs and in whatever order or branch. One form passes: a name given exactly the hand's pin (an assignment before a command,
// before `env`'s command or alone, `export` and its kin, `unset` of an absence pin). No mention is excused as data (build r19
// fallback): a search, a commit message or a document naming a pin holds too.
// U19 reads the line statically: a pinned name reached through a word only known when it runs is a program the engine chose
// to run, bounded by the approval that ran the line, so no dynamic word holds here.

const PINNED_NAMES = [...new Set(ENV_PINS.map((pin) => pin.name))].sort((a, b) => b.length - a.length);
const PINNED_ALTERNATION = `${PINNED_NAMES.join("|")}|GIT_CONFIG[A-Za-z0-9_]*`;
/** A pinned name as a whole identifier. */
const PINNED_NAME = new RegExp(`(?<![A-Za-z0-9_])(?:${PINNED_ALTERNATION})(?![A-Za-z0-9_])`, "g");
/** Windows spellings, where a name has no case: PowerShell's env: drive, cmd's set and setx, .NET's setter, a new environment. */
const WINDOWS_TOUCH = new RegExp(
  `env:\\\\?(?:\\*|(?:${PINNED_ALTERNATION})(?![A-Za-z0-9_]))|(?:^|[\\s&|(])setx?\\s+(?:/[a-z]\\s+)?"?(?:${PINNED_ALTERNATION})(?![A-Za-z0-9_])|SetEnvironmentVariable|UseNewEnvironment`,
  "i",
);
/** env's options that leave every inherited name as it is. */
const ENV_KEEPING_LONG = new Set(["--null", "--debug", "--help", "--version", "--list-signal-handling"]);
const ENV_KEEPING_LONG_PREFIX = ["--chdir=", "--ignore-signal", "--default-signal", "--block-signal"];

const firstName = (text: string): string | undefined => new RegExp(PINNED_NAME.source).exec(text)?.[0];
const named = (name: string) => `${name} is set, removed or named on this line, so Murage's pin may not hold`;
const cleared = (form: string) => `${form} changes the environment the command inherits, so Murage's pin may not hold`;

// ---- section 11 D2: PowerShell's spellings of setting, removing or naming an environment variable -----------------------------
// MurageMain's ruling (2026-10-21): PowerShell's semantics are not modelled. A command that mentions the env: provider
// (`env:`, `$env:`, `${env:}`, `Environment::`), `[Environment]`/`[System.Environment]` with a variable-name method, or
// SetEnvironmentVariable, whose variable name is not a plain static literal, holds (U19 class, every level): a name with `$`, a
// backtick, a subexpression, quote concatenation, a wildcard (`*`, `?`, `[`) or splatting is never resolved. Only a fully
// static literal name is read, and it holds when it is pinned. A benign static name (`$env:FOO=1`) and a read of the whole
// drive (`Get-ChildItem env:`) do not hold; the bare drive handed to a cmdlet that writes does.

/** Cmdlets and their aliases that write, remove, rename or copy an item, its content, a property or a variable. */
const PWSH_WRITER = /(?<![\w-])(?:new-item|ni|set-item|si|remove-item|ri|rm|rmdir|rd|del|erase|clear-item|cli|rename-item|rni|ren|move-item|mi|move|mv|copy-item|cpi|copy|cp|set-content|sc|add-content|ac|clear-content|clc|set-itemproperty|sp|new-itemproperty|remove-itemproperty|rp|clear-itemproperty|clp|rename-itemproperty|rnp|copy-itemproperty|cpp|move-itemproperty|mp)(?![\w-])/i;
const PINNED_UPPER = new Set(PINNED_NAMES.map((name) => name.toUpperCase()));
const pinnedAnyCase = (name: string): string | undefined => {
  const upper = name.toUpperCase();
  return PINNED_UPPER.has(upper) ? PINNED_NAMES.find((pin) => pin.toUpperCase() === upper) : upper.startsWith("GIT_CONFIG") ? upper : undefined;
};
const unclear = (form: string) => `${form} could not be read with certainty, so Murage's pin may not hold`;

/** U19 for a PowerShell line, or null. The line is read as written and with its backtick escapes taken away (`P`A`GER`
 * outside a name is PAGER); a hold in either reading holds. */
function pwshPinTouch(text: string): string | null {
  const plain = text.replace(/`([^\r\n])/g, "$1");
  for (const line of plain === text ? [text] : [text, plain]) {
    const found = providerPathTouch(line) ?? envDriveTouch(line) ?? environmentMethodTouch(line);
    if (found) return found;
  }
  return null;
}

/** The provider-qualified spelling of the drive (`Environment::PAGER`, `Microsoft.PowerShell.Core\Environment::PAGER`) is
 * never resolved. `[Environment]::` (the .NET class) is environmentMethodTouch's. */
function providerPathTouch(text: string): string | null {
  return /(?<![\]\w])environment::/i.test(text) ? unclear("the Environment provider path") : null;
}

/** Whether the text after a static name ends that name: in a variable (`$env:NAME`) an operator, a member access or a closing
 * mark or a path separator; in a path (`env:NAME`) only whitespace, a closing mark or a closing quote that no `+` follows. */
function staticNameEnd(after: string, variable: boolean): boolean {
  if (after === "") return true;
  const c = after.charAt(0);
  if (/[\s;|),}]/.test(c)) return true;
  // a closing quote ends the name only when the word ends with it (`env:pa"ger"` is one word, PAGER)
  if (PWSH_QUOTE.test(c)) return /^.(?:$|[\s;|),}\].])/.test(after) && !/^.\s*\+/.test(after);
  return variable && /[=.+\-*/%[\]\\]/.test(c);
}

/** PowerShell's quote characters (its typographic ones included). */
const PWSH_QUOTE = /['"\u2018\u2019\u201A\u201B\u201C\u201D\u201E]/;
const PWSH_QUOTES = /['"\u2018\u2019\u201A\u201B\u201C\u201D\u201E]/g;
const PINNED_ANY_CASE = new RegExp(`(?<![A-Za-z0-9_])(?:${PINNED_ALTERNATION})(?![A-Za-z0-9_])`, "i");

/** 14.2 #2: an env: path's word (up to whitespace, a separator, or the quote that closes it) holds when a quote or a caret
 * escape stands anywhere in it, and when any case variant of a pinned name stands in it, quotes and escapes read away. */
function envPathWordTouch(word: string): string | null {
  const close = /['"\u2018\u2019\u201A\u201B\u201C\u201D\u201E](?:$|[\s)}\];,.|])/.exec(word);
  const body = close ? word.slice(0, close.index) : word;
  if (PWSH_QUOTE.test(body) || body.includes("^")) return unclear(`env:${body}`);
  const hit = PINNED_ANY_CASE.exec(body.replace(PWSH_QUOTES, "").replace(/[\^`]/g, ""));
  return hit ? named(pinnedAnyCase(hit[0]) ?? hit[0]) : null;
}

function envDriveTouch(text: string): string | null {
  const writes = PWSH_WRITER.test(text);
  for (const match of text.matchAll(/(?<![A-Za-z0-9_])env:/gi)) {
    const start = match.index!;
    const braced = text.slice(Math.max(0, start - 2), start) === "${";
    const variable = braced || text.charAt(start - 1) === "$";
    let at = start + match[0].length;
    if (!variable && /[\\/]/.test(text.charAt(at))) at += 1;
    if (!variable) {
      const word = envPathWordTouch(/^[^\s;|,]*/.exec(text.slice(at))![0]);
      if (word) return word;
    }
    const name = /^[A-Za-z0-9_]*/.exec(text.slice(at))![0];
    const after = text.slice(at + name.length);
    if (braced) {
      if (after.charAt(0) !== "}") return unclear("${env:");
    } else if (!staticNameEnd(after, variable)) {
      return unclear(`env:${name}${after.charAt(0)}`);
    }
    if (!name) {
      // the drive itself: a read of it is benign, a cmdlet that writes given it is not
      if (variable || writes) return cleared("a cmdlet that writes, given the env: drive");
      continue;
    }
    const pinned = pinnedAnyCase(name);
    if (pinned) return named(pinned);
  }
  return null;
}

/** `[Environment]::SetEnvironmentVariable(...)` (and Get, and any spelling that names SetEnvironmentVariable): the first
 * argument must be a plain quoted literal; a pinned one holds a setter. */
function environmentMethodTouch(text: string): string | null {
  for (const match of text.matchAll(/(set|get)environmentvariables?\b/gi)) {
    const setter = match[1]!.toLowerCase() === "set";
    const after = text.slice(match.index! + match[0].length);
    if (!setter && /s$/i.test(match[0])) continue; // GetEnvironmentVariables(): the whole block, read
    const literal = /^\s*\(\s*(['"])([A-Za-z0-9_]+)\1\s*[,)]/.exec(after);
    if (!literal) {
      if (setter) return unclear("SetEnvironmentVariable with a name that is not a plain literal");
      if (/^\s*\(\s*\)/.test(after)) continue;
      return unclear("GetEnvironmentVariable with a name that is not a plain literal");
    }
    if (setter) {
      const pinned = pinnedAnyCase(literal[2]!);
      if (pinned) return named(pinned);
    }
  }
  return null;
}

/** A parameter expansion that assigns a pinned name (`${NAME=x}`, `${NAME:=x}`), wherever it stands. */
const ASSIGNING_EXPANSION = new RegExp(`\\$\\{(${PINNED_ALTERNATION})(?![A-Za-z0-9_]):?=`);

// ---- code bodies --------------------------------------------------------------------------------------------------------------
// An expansion that runs code is `$(`, a backtick, `<(` or `>(`. Wherever it stands (at any nesting depth, inside a `${...}`
// operator's word, inside double quotes, in any here-document) its body is read again as shell with the same static rules.
// Regions are read loosely: quotes are not honoured, an unclosed form runs to the end, so a body is read too often, never too
// rarely.

/** The body of every expansion in the region that runs code, outermost first; each is read again as shell, which finds the
 *  ones nested inside it. */
function codeBodies(region: string): string[] {
  const out: string[] = [];
  for (let k = 0; k < region.length; k++) {
    const c = region[k];
    if ((c === "$" || c === "<" || c === ">") && region[k + 1] === "(") {
      const end = matchParen(region, k + 2);
      out.push(region.slice(k + 2, end < 0 ? undefined : end));
      if (end < 0) break;
      k = end;
    } else if (c === "`") {
      const end = findBacktick(region, k + 1);
      out.push(region.slice(k + 1, end < 0 ? undefined : end).replace(/\\([`\\$])/g, "$1"));
      if (end < 0) break;
      k = end;
    }
  }
  return out;
}

// ---- build r17 to r19 (Fable's two Highs, Astra r17 to r19): no data excusal ---------------------------------------------------
// A pinned name anywhere on a line, in any word, quoted body or here-document, at any depth, is read with the static rules: no
// word or region is excused as data, so no reading of pipes, delimiters or quoting can excuse one wrongly. Every quoted body and
// here-document is read again as shell. Text written to a file and run later is the unread-file boundary, not covered here.

/** What a here-document gives to be read again as shell: its whole body, and (read loosely, so a quote the body leaves open
 *  cannot hide one) the body of every expansion in it that runs code. */
function docTexts(docs: readonly Doc[]): string[] {
  return docs.flatMap((doc) => [doc.body, ...codeBodies(doc.body)]);
}

/** The first pinned name in any here-document of the split, or null; a here-document whose delimiter or end cannot be read
 *  with certainty holds. */
function docTouch(parts: Split): string | null {
  if (parts.unsureDoc) return "where a here-document ends cannot be read with certainty, so Murage's pin may not hold";
  for (const command of parts.commands) for (const doc of command.heredocs) {
    const name = firstName(doc.body);
    if (name) return named(name);
  }
  return null;
}

/** U19 when the line touches a pinned name as code, or null. */
function pinTouch(text: string, pins: ReadonlyMap<string, string>): string | null {
  const windows = WINDOWS_TOUCH.exec(text);
  if (windows) return cleared(windows[0].trim());
  const assigning = ASSIGNING_EXPANSION.exec(text);
  if (assigning) return named(assigning[1]!);
  const top = split(text);
  const exempt = new Set<Word>();
  // offsets of a mention that is not a touch: the name of a word given exactly its pin
  const names = new Set<number>();
  const inDoc = docTouch(top);
  if (inDoc) return inDoc;
  if (!top.cannot) {
    for (const command of top.commands) {
      for (const word of pinnedAssignments(command.words, pins)) {
        exempt.add(word);
        const at = new RegExp(PINNED_NAME.source).exec(text.slice(word.start, word.end));
        if (at) names.add(word.start + at.index);
      }
    }
  }
  for (const match of text.matchAll(PINNED_NAME)) {
    const at = match.index!;
    if (names.has(at)) continue;
    return named(match[0]);
  }
  return touchIn(top, text, exempt, 0);
}

/** The words that give a pinned name exactly its pin at the line's top level: a plain assignment leading a command (or `env`'s
 *  command), a name `export` and its kin set (with no option but -x, -g or -r), and `unset` of an absence pin. */
function pinnedAssignments(words: readonly Word[], pins: ReadonlyMap<string, string>): Word[] {
  const out: Word[] = [];
  const exact = (word: Word, text: string = word.text) => {
    const eq = text.indexOf("=");
    if (eq <= 0 || isDynamic(word)) return false;
    const name = text.slice(0, eq);
    return PINNED_NAMES.includes(name) && pins.has(name) && text === `${name}=${pins.get(name)}`;
  };
  let i = 0;
  const take = () => {
    while (i < words.length && words[i]!.assignment !== undefined) {
      const word = words[i++]!;
      if (exact(word)) out.push(word);
    }
  };
  for (;;) {
    take();
    if (i < words.length && !isDynamic(words[i]!) && !words[i]!.quoted && SHELL_LEADING_WORDS.includes(words[i]!.text)) { i++; continue; }
    break;
  }
  const program = words[i];
  if (!program || isDynamic(program) || program.quoted) return out;
  const args = words.slice(i + 1);
  const keeping = (word: Word) => !isDynamic(word) && /^-[xgr]+$/.test(word.text);
  const setting = (word: Word) => !isDynamic(word) && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text);
  if (program.text === "env") {
    // env reads its own argv: past its options (a keeping one, or a dynamic word passed over as envTouch does; a clearing one
    // holds there), every `NAME=value` word, quoted or not, is an assignment
    let k = i + 1;
    for (; k < words.length; k++) {
      const word = words[k]!;
      if (isDynamic(word)) continue;
      const text = word.text;
      if (text === "--") { k++; break; }
      if (!text.startsWith("-") || text === "-") break;
      if (text === "--chdir" || text === "--unset" || /^-[0v]*[uC]$/.test(text)) k++;
    }
    for (; k < words.length && setting(words[k]!); k++) if (exact(words[k]!)) out.push(words[k]!);
  } else if (["export", "declare", "typeset", "local", "readonly"].includes(program.text)) {
    if (args.every((word) => setting(word) || keeping(word))) for (const word of args) if (setting(word) && exact(word)) out.push(word);
  } else if (program.text === "unset") {
    for (const word of args) if (!isDynamic(word) && ABSENT_PINS.includes(word.text)) out.push(word);
  }
  return out;
}

/** The first touch in a split text and every body it runs as code, or null. */
function touchIn(parts: Split, text: string, exempt: ReadonlySet<Word>, depth: number): string | null {
  if (depth > MAX_DEPTH) return "the line nests deeper than Murage reads, so a pin may not hold";
  const inDoc = docTouch(parts);
  if (inDoc) return inDoc;
  if (parts.cannot) return rawTouch(text);
  for (const command of parts.commands) {
    const found = commandTouch(command.words, exempt);
    if (found) return found;
    // a quoted word that gives a name exactly its pin (`export "PAGER=cat"`) is not read again
    const pinned = new Set(command.words.filter((word) => exempt.has(word)).map((word) => word.text));
    const docs = docTexts(command.heredocs);
    const bodies = [...docs, ...command.bodies.filter((body) => !pinned.has(body))];
    for (const body of bodies) {
      const inBody = touchIn(split(body), body, exempt, depth + 1);
      if (inBody) return inBody;
    }
  }
  for (const body of parts.substitutions) {
    const found = touchIn(split(body), body, exempt, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Text that cannot be split: a static env or exec option. */
function rawTouch(text: string): string | null {
  const clearing = /(?:^|[\s;&|(`'"])((?:env|exec)\s+-\S*)/.exec(text);
  return clearing ? cleared(clearing[1]!) : null;
}

/** One simple command: every pinned name it names, and every static word read as
 *  a possible `env` or `exec` with its options. */
function commandTouch(words: readonly Word[], exempt: ReadonlySet<Word>): string | null {
  for (let k = 0; k < words.length; k++) {
    const word = words[k]!;
    if (exempt.has(word)) continue;
    const name = firstName(word.text);
    if (name) return named(name);
  }
  for (let k = 0; k < words.length; k++) {
    const word = words[k]!;
    if (isDynamic(word)) continue;
    const program = programName(word.text);
    const args = words.slice(k + 1);
    const found = program === "env" ? envTouch(args) : program === "exec" ? execTouch(args) : null;
    if (found) return found;
  }
  return null;
}

/** env's options: any that clears or splits more words holds; a word only known when it runs is passed over and the static
 *  options around it are still read. */
function envTouch(args: readonly Word[]): string | null {
  for (let k = 0; k < args.length; k++) {
    const word = args[k]!;
    if (word.assignment !== undefined || isDynamic(word)) continue;
    const text = word.text;
    if (text === "--" || !text.startsWith("-")) return null;
    if (text === "-") return cleared("env -");
    if (text.startsWith("--")) {
      if (ENV_KEEPING_LONG.has(text) || ENV_KEEPING_LONG_PREFIX.some((prefix) => text.startsWith(prefix))) continue;
      if (text === "--chdir") { k++; continue; }
      if (text === "--unset") {
        if (!args[k + 1]) return cleared("env --unset");
        k++;
        continue;
      }
      if (text.startsWith("--unset=")) continue;
      return cleared(`env ${text}`);
    }
    for (let c = 1; c < text.length; c++) {
      const letter = text[c]!;
      if (letter === "0" || letter === "v") continue;
      if (letter === "u" || letter === "C") {
        if (c === text.length - 1) {
          if (!args[k + 1]) return cleared(`env -${letter}`);
          k++;
        }
        break;
      }
      return cleared(`env -${letter}`);
    }
  }
  return null;
}

/** exec's options: `-c` clears the environment (`-a` takes a name). A word only known when it runs ends the scan: in exec's
 *  option place it is the program itself, whose own options follow it. */
function execTouch(args: readonly Word[]): string | null {
  for (let k = 0; k < args.length; k++) {
    const word = args[k]!;
    if (isDynamic(word)) return null;
    const text = word.text;
    if (text === "--" || !/^-[A-Za-z]/.test(text)) return null;
    if (text.includes("c")) return cleared("exec -c");
    if (text.endsWith("a")) k++;
  }
  return null;
}

// ---- judging ------------------------------------------------------------------------------------------------------------------

function judgeText(text: string, facts: Facts, strict: boolean, depth: number, env: InheritedEnv = KEPT_ENV): PromptHit | null {
  if (pinMode(facts)) strict = false;
  if (depth > MAX_DEPTH) return strict ? unreadable() : null;
  const parts = split(text);
  if (parts.cannot && strict) return unreadable();
  // what an earlier command left in the shell (`export`, `unset`, a bare assignment) reaches every later one
  let state = env;
  for (const command of parts.commands) {
    const found = judgeSimple(command.words, command.heredocs, facts, strict, depth, state);
    if (found) return found;
    state = shellStateAfter(command.words, state, depth);
  }
  // a command substitution is code wherever it stands
  for (const sub of parts.substitutions) {
    const found = judgeText(sub, facts, !pinMode(facts), depth + 1, state);
    if (found) return found;
  }
  // a quoted body is read again as text; what it cannot say does not hold. For a pin, every quoted body and here-document is
  // read again (no data excusal)
  const bodies = pinMode(facts) ? parts.commands.flatMap((command) => [...docTexts(command.heredocs), ...command.bodies]) : parts.quoted;
  for (const body of bodies) {
    const found = judgeText(body, facts, false, depth + 1, state);
    if (found) return found;
  }
  return null;
}

// ---- the inherited environment (Rule 68f case 1: the effective value of each pinned name) ---------------------------------

/** The value an assignment word gives its name: a literal, or unknown when it expands or appends. */
function assignedValue(word: Word): { value: string } | "unknown" {
  if (isDynamic(word)) return "unknown";
  const eq = word.text.indexOf("=");
  if (eq > 0 && word.text[eq - 1] === "+") return "unknown";
  return { value: word.text.slice(eq + 1) };
}

/** `env` with these assignment words applied over it. */
function withAssignments(env: InheritedEnv, words: readonly Word[]): InheritedEnv {
  if (!words.length) return env;
  const names = new Map(env.names);
  for (const word of words) names.set(word.assignment!, assignedValue(word));
  return { names, rest: env.rest };
}

const NOTHING_KNOWN: InheritedEnv = { names: new Map(), rest: "unknown" };

/** What `env`'s own options do to the environment it hands on: `-i`/`--ignore-environment`/`-` clear it, `-u NAME`/
 *  `--unset=NAME` remove a name; a word only known when it runs (or a name it removes) is passed over, and the static options
 *  around it still apply. */
function envOptionsEffect(args: readonly Word[], env: InheritedEnv): InheritedEnv {
  let names = new Map(env.names);
  let rest = env.rest;
  const clear = () => { names = new Map(); rest = "cleared"; };
  for (let k = 0; k < args.length; k++) {
    const word = args[k]!;
    if (isDynamic(word)) continue;
    const text = word.text;
    if (text === "--") break;
    if (text === "-") { clear(); break; }
    if (!text.startsWith("-")) break;
    if (text === "--ignore-environment") { clear(); continue; }
    if (text === "--unset") {
      const target = args[++k];
      if (!target) return NOTHING_KNOWN;
      if (!isDynamic(target)) names.set(target.text, null);
      continue;
    }
    if (text.startsWith("--unset=")) { names.set(text.slice("--unset=".length), null); continue; }
    if (text === "--split-string" || text.startsWith("--split-string=")) break;
    if (text.startsWith("--")) { if (text === "--chdir") k++; continue; }
    let stop = false;
    for (let c = 1; c < text.length; c++) {
      const letter = text[c]!;
      if (letter === "i") { clear(); continue; }
      if (letter === "S") { stop = true; break; }
      if (letter === "u" || letter === "C") {
        const attached = text.slice(c + 1);
        if (letter === "u") {
          const target = attached !== "" ? attached : args[k + 1];
          if (target === undefined) return NOTHING_KNOWN;
          if (typeof target === "string") names.set(target, null);
          else if (!isDynamic(target)) names.set(target.text, null);
        }
        if (attached === "") k++;
        break;
      }
    }
    if (stop) break;
  }
  return { names, rest };
}

/** The shell's environment after this simple command ran in it: a bare assignment, `export`/`declare`/`typeset`/`local`/
 *  `readonly` (`export -n` and `+x` remove it from the environment), `unset`, and an `eval` of literal words. A name these
 *  set from a value the line does not show is unknown; a word only known when it runs among their arguments is passed over,
 *  and every static name before and after it still applies (U19 reads the line statically). */
function shellStateAfter(words: readonly Word[], env: InheritedEnv, depth: number): InheritedEnv {
  let i = 0;
  const assigns: Word[] = [];
  for (;;) {
    while (i < words.length && words[i]!.assignment !== undefined) assigns.push(words[i++]!);
    if (i < words.length && !isDynamic(words[i]!) && !words[i]!.quoted && SHELL_LEADING_WORDS.includes(words[i]!.text)) { i++; continue; }
    break;
  }
  if (i >= words.length) return withAssignments(env, assigns);
  const program = words[i]!;
  if (isDynamic(program)) return env;
  const name = programName(program.text);
  const args = words.slice(i + 1);
  if (["export", "declare", "typeset", "local", "readonly"].includes(name)) {
    const names = new Map(env.names);
    let removes = false;
    for (const arg of args) {
      if (isDynamic(arg) && arg.assignment === undefined) continue;
      const text = arg.text;
      if (arg.assignment === undefined && /^[-+]/.test(text)) {
        if ((name === "export" && /^-[A-Za-z]*n/.test(text)) || /^\+[A-Za-z]*x/.test(text)) removes = true;
        continue;
      }
      const eq = text.indexOf("=");
      if (eq > 0) names.set(text.slice(0, eq).replace(/\+$/, ""), removes ? null : assignedValue(arg));
      else if (removes) names.set(text, null);
    }
    return { names, rest: env.rest };
  }
  if (name === "unset") {
    const names = new Map(env.names);
    for (const arg of args) {
      if (isDynamic(arg)) continue;
      if (arg.text === "-f") return env;
      if (arg.text.startsWith("-")) continue;
      names.set(arg.text, null);
    }
    return { names, rest: env.rest };
  }
  if (name === "eval") {
    if (args.some(isDynamic)) return env;
    if (depth >= MAX_DEPTH) return NOTHING_KNOWN;
    let state = env;
    const parts = split(joined(args));
    if (parts.cannot) return NOTHING_KNOWN;
    for (const command of parts.commands) state = shellStateAfter(command.words, state, depth + 1);
    return state;
  }
  return env;
}

/** The program word's basename, `.exe` dropped, lowercase. */
function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.exe$/i, "").toLowerCase();
}

const isDynamic = (word: Word) => word.dynamic || word.glob;
const joined = (words: readonly Word[]) => words.map((word) => word.text).join(" ");

function judgeSimple(all: readonly Word[], heredocs: readonly Doc[], facts: Facts, strict: boolean, depth: number, env: InheritedEnv = KEPT_ENV): PromptHit | null {
  if (pinMode(facts)) strict = false;
  // in pin mode what cannot be read is not a pin override; the prompt reader holds it on its own
  const unreadable = (): PromptHit | null => (pinMode(facts) ? null : unreadableHit());
  let i = 0;
  // the names the command's environment sets: inherited from the line or a wrapper, then its own
  const assigned: string[] = [...env.names].filter(([, value]) => value !== null).map(([name]) => name);
  const own: Word[] = [];
  for (;;) {
    while (i < all.length && all[i]!.assignment !== undefined) { own.push(all[i]!); assigned.push(all[i++]!.assignment!); }
    if (i < all.length && !isDynamic(all[i]!) && !all[i]!.quoted && SHELL_LEADING_WORDS.includes(all[i]!.text)) { i++; continue; }
    break;
  }
  // what the program hands on: the inherited environment with the command's own assignments over it
  const child = withAssignments(env, own);
  const lenientDocs = () => {
    // a here-document is never data (build r17 item A): every body is read again
    const docs = docTexts(heredocs);
    for (const doc of docs) {
      const found = judgeText(doc, facts, false, depth + 1, child);
      if (found) return found;
    }
    return null;
  };
  if (i >= all.length) return lenientDocs();
  const programWord = all[i]!;
  // a listed option of a pin-bearing program holds behind any wrapper, listed or not, or a program only known when it runs:
  // every later static word naming such a program is read with its options (r2 amendment item 3)
  if (pinMode(facts)) {
    for (let k = i + 1; k < all.length; k++) {
      const word = all[k]!;
      if (isDynamic(word) || !PIN_PROGRAMS.has(programName(word.text))) continue;
      const behind = pinOverride(all.slice(k).map((each) => each.text), facts.pins, KEPT_ENV);
      if (behind) return { rule: PIN_RULE, note: behind.unknown };
    }
  }
  if (isDynamic(programWord)) return strict ? unreadable() : lenientDocs();
  const name = programName(programWord.text);
  const args = all.slice(i + 1);
  const argText = args.map((word) => word.text);

  if (pinMode(facts)) {
    // the command's own assignments, then its program and words, as pinOverride reads them
    const words = [...all.slice(0, i).filter((word) => word.assignment !== undefined).map((word) => word.text), ...all.slice(i).map((word) => word.text)];
    const override = pinOverride(words, facts.pins, env);
    if (override) return { rule: PIN_RULE, note: override.unknown };
  } else {
    // the rows, in table order
    for (const row of PROMPT_ROWS) {
      if (!row.programs.includes(name)) continue;
      const found = judgeRow(row.rule, name, args, argText, assigned, facts);
      if (found) return found;
    }
  }

  // then what the program carries: a wrapper's command, a shell's body, a dispatcher's words
  const again = (words: readonly Word[], docs: readonly Doc[] = heredocs, handed: InheritedEnv = child) => judgeSimple(words, docs, facts, strict, depth + 1, handed);
  const body = (text: string, handed: InheritedEnv = child) => judgeText(text, facts, !pinMode(facts), depth + 1, handed);
  if (name === "sudo" || name === "doas") {
    // a user switch: what the wrapped command inherits is not known from the line (its own assignments still are)
    const read = escalatorOptions(name, args);
    return read.dynamic ? unreadable() : again(args.slice(read.wrapped), heredocs, NOTHING_KNOWN);
  }
  if (WRAPPER_PREFIXES.has(name)) {
    const wrapped = wrapperCommand(name, args);
    if (wrapped === "unreadable") return strict ? unreadable() : null;
    const handed = name === "env" ? envOptionsEffect(args, child) : child;
    if (typeof wrapped === "string") return body(wrapped, handed);
    return again(wrapped, heredocs, handed);
  }
  if ((PROMPT_BODY_READERS.xargs as readonly string[]).includes(name)) return again(afterOptions(args, WRAPPER_VALUE_OPTIONS.xargs ?? ""), []);
  if ((PROMPT_BODY_READERS.watch as readonly string[]).includes(name)) {
    const rest = afterOptions(args, WRAPPER_VALUE_OPTIONS.watch ?? "");
    return rest.some(isDynamic) ? unreadable() : body(joined(rest));
  }
  if ((PROMPT_BODY_READERS.joined as readonly string[]).includes(name)) return args.some(isDynamic) ? unreadable() : body(joined(args));
  if ((PROMPT_BODY_READERS.shells as readonly string[]).includes(name)) {
    const at = shellBody(args);
    if (at === "unreadable") return unreadable();
    if (at !== undefined) return isDynamic(args[at]!) ? unreadable() : body(args[at]!.text);
    for (const doc of heredocs) {
      const found = body(doc.body);
      if (found) return found;
    }
    return null;
  }
  if ((PROMPT_BODY_READERS.cmd as readonly string[]).includes(name)) {
    const at = args.findIndex((word) => /^\/[ck]/i.test(word.text));
    if (at < 0) return lenientDocs();
    const first = args[at]!.text.slice(2);
    const rest = [first, ...args.slice(at + 1).map((word) => (isDynamic(word) ? "$X" : word.text))].filter(Boolean).join(" ");
    // cmd's own expansions (%NAME%, delayed !NAME!) are dynamic words of its body, read as such
    return body(rest.replace(/%[^%\s]+%|![^!\s]+!/g, "$$X"));
  }
  if ((PROMPT_BODY_READERS.powershell as readonly string[]).includes(name)) {
    const read = powershellBody(args);
    if (read === "unreadable") return unreadable();
    return read === undefined ? lenientDocs() : body(read);
  }
  if ((PROMPT_BODY_READERS.find as readonly string[]).includes(name)) {
    for (let k = 0; k < args.length; k++) {
      if (!(PROMPT_BODY_READERS.findExec as readonly string[]).includes(args[k]!.text)) continue;
      let end = k + 1;
      while (end < args.length && args[end]!.text !== ";" && args[end]!.text !== "+") end++;
      const found = again(args.slice(k + 1, end), []);
      if (found) return found;
      k = end;
    }
  }
  return lenientDocs();
}

function judgeRow(rule: PromptRule, name: string, args: readonly Word[], argText: readonly string[], assigned: readonly string[], facts: PromptFacts | undefined): PromptHit | null {
  switch (rule) {
    case "ssh-add":
      return args.length === 1 && !isDynamic(args[0]!) && SSH_ADD_QUIET.includes(argText[0]!) ? null : hit(rule);
    case "sudo":
    case "doas": {
      const read = escalatorOptions(name as "sudo" | "doas", args);
      return read.quiet && !read.dynamic ? null : hit(rule);
    }
    case "su":
    case "pkexec":
    case "new-console":
      return hit(rule);
    case "gpg":
      return gpgAsks(args, argText, assigned) ? hit(rule) : null;
    case "git-signing":
      return gitSigns(args, argText, assigned, facts) ? hit(rule) : null;
    case "repo-ssh-command":
      return repoSshCommand(args, argText, assigned, facts);
    case "pty":
      if (!PTY_ADDRESS_PROGRAMS.includes(name)) return hit(rule);
      return args.some(isDynamic) || argText.some((word) => /(^|[^A-Za-z])pty([^A-Za-z]|$)/i.test(word)) ? hit(rule) : null;
    case "ssh-tty":
      if (args.some(isDynamic)) return unreadable();
      return sshRequestsTty(argText) ? hit(rule) : null;
    case "direct-ssh": {
      if (args.some(isDynamic)) return unreadable();
      const read = directSshMeetsRow([name, ...argText]);
      return read.meets ? null : hit(rule, read.reason);
    }
    case "unreadable":
      return null;
  }
}

/** sudo's and doas's options, read with their argument-taking letters: whether a non-interactive form stands among them
 *  (no option undoes it), and where the wrapped command starts. */
function escalatorOptions(kind: "sudo" | "doas", args: readonly Word[]): { quiet: boolean; dynamic: boolean; wrapped: number } {
  const table = ESCALATOR_OPTIONS[kind];
  let quiet = false;
  let k = 0;
  while (k < args.length) {
    const word = args[k]!;
    if (isDynamic(word)) return { quiet, dynamic: true, wrapped: k };
    const text = word.text;
    if (text === "--") { k++; break; }
    if (!text.startsWith("-") || text === "-") break;
    if (text.startsWith("--")) {
      const option = text.split("=")[0]!;
      if (table.quiet.includes(option)) quiet = true;
      if (table.valueLong.includes(option) && !text.includes("=")) k++;
      k++;
      continue;
    }
    for (let c = 1; c < text.length; c++) {
      const letter = text[c]!;
      if (table.quiet.includes(`-${letter}`)) quiet = true;
      if (table.valueLetters.includes(letter)) {
        if (c === text.length - 1) k++;
        break;
      }
    }
    k++;
  }
  return { quiet, dynamic: false, wrapped: k };
}

/** The words after a dispatcher's options (`valueLetters` take an argument); `--` ends them. */
function afterOptions(args: readonly Word[], valueLetters: string): Word[] {
  let k = 0;
  while (k < args.length) {
    const text = args[k]!.text;
    if (isDynamic(args[k]!)) break;
    if (text === "--") { k++; break; }
    if (!text.startsWith("-") || text === "-") break;
    if (text.startsWith("--")) { k++; continue; }
    if (!/^-\d+$/.test(text)) {
      for (let c = 1; c < text.length; c++) {
        if (valueLetters.includes(text[c]!)) {
          if (c === text.length - 1) k++;
          break;
        }
      }
    }
    k++;
  }
  return args.slice(k);
}

/** A wrapper's command: its words, or text to read again (`env -S`), or unreadable. */
function wrapperCommand(name: string, args: readonly Word[]): Word[] | string | "unreadable" {
  if (name === "rtk") return args[0]?.text === "proxy" ? args.slice(1) : [...args];
  if (name === "env") {
    let k = 0;
    while (k < args.length) {
      const word = args[k]!;
      const text = word.text;
      if (isDynamic(word)) return "unreadable";
      if (text === "--") { k++; break; }
      // `S` in a short cluster splits only when it stands before a value letter (`-uGIT_ASKPASS` names a variable)
      const at = /^-[^-]/.test(text) ? clusterSplitAt(text) : -1;
      if (text === "--split-string" || text.startsWith("--split-string=") || at > 0) {
        const attached = text.startsWith("--split-string=") ? text.slice("--split-string=".length) : text.startsWith("--") ? "" : text.slice(at + 1);
        const rest = attached !== "" ? args.slice(k + 1) : args.slice(k + 2);
        const value = attached !== "" ? attached : args[k + 1]?.text ?? "";
        if (rest.some(isDynamic) || (attached === "" && args[k + 1] && isDynamic(args[k + 1]!))) return "unreadable";
        return [value, ...rest.map((word) => word.text)].join(" ");
      }
      // a lone `-` is `-i`; the command follows it
      if (text === "-") { k++; break; }
      if (!text.startsWith("-")) break;
      if (text.startsWith("--")) { k += text.includes("=") || !["--unset", "--chdir"].includes(text) ? 1 : 2; continue; }
      const letters = WRAPPER_VALUE_OPTIONS.env ?? "";
      let skip = 1;
      for (let c = 1; c < text.length; c++) if (letters.includes(text[c]!)) { if (c === text.length - 1) skip = 2; break; }
      k += skip;
    }
    return args.slice(k);
  }
  const rest = afterOptions(args, WRAPPER_VALUE_OPTIONS[name] ?? "");
  // timeout's duration
  if (name === "timeout") return rest.slice(1);
  return rest;
}

/** Where `S` stands in an env short-option cluster, before any letter that takes a value (`u`, `C`); -1 without one. */
function clusterSplitAt(text: string): number {
  for (let c = 1; c < text.length; c++) {
    if (text[c] === "S") return c;
    if ((WRAPPER_VALUE_OPTIONS.env ?? "").includes(text[c]!)) return -1;
  }
  return -1;
}

/** A shell's `-c` body: the index of the first operand after its options when a cluster holds `c`; undefined without one. */
function shellBody(args: readonly Word[]): number | "unreadable" | undefined {
  let command = false;
  let k = 0;
  while (k < args.length) {
    const word = args[k]!;
    // a dynamic word where an option may stand could itself be `-c`: whether the shell runs code is not readable
    if (isDynamic(word)) return "unreadable";
    const text = word.text;
    if (text === "--" || text === "-") { k++; break; }
    if (!/^[-+]/.test(text)) break;
    if (text.startsWith("--")) { k++; continue; }
    let skip = 1;
    for (let c = 1; c < text.length; c++) {
      if (text[0] === "-" && text[c] === "c") command = true;
      if ((text[c] === "o" || text[c] === "O") && c === text.length - 1) skip = 2;
    }
    k += skip;
  }
  if (!command) return undefined;
  return k < args.length ? k : "unreadable";
}

const PS_VALUE_OPTIONS = ["-executionpolicy", "-ep", "-windowstyle", "-workingdirectory", "-wd", "-configurationname", "-outputformat", "-inputformat", "-settingsfile", "-version", "-custompipename"];

/** PowerShell's command text: after `-Command` (or a prefix of it), or its first operand; `-EncodedCommand` is unreadable. */
function powershellBody(args: readonly Word[]): string | "unreadable" | undefined {
  for (let k = 0; k < args.length; k++) {
    const word = args[k]!;
    if (isDynamic(word)) return "unreadable";
    const option = word.text.toLowerCase();
    const rest = () => (args.slice(k + 1).some(isDynamic) ? "unreadable" : joined(args.slice(k + 1)));
    if (!option.startsWith("-")) return args.slice(k).some(isDynamic) ? "unreadable" : joined(args.slice(k));
    if (option.length >= 2 && "-command".startsWith(option)) return rest();
    if (option === "-e" || option === "-ec" || (option.length >= 4 && "-encodedcommand".startsWith(option))) return "unreadable";
    if (option.length >= 2 && "-file".startsWith(option)) return undefined;
    if (PS_VALUE_OPTIONS.includes(option)) k++;
  }
  return undefined;
}

// ---- gpg ----------------------------------------------------------------------------------------------------------------------

function gpgAsking(word: string): boolean {
  if (word.startsWith("--")) {
    const option = word.split("=")[0]!;
    if (GPG_READ_ONLY.includes(option)) return false;
    // an abbreviation of an asking command asks too
    return GPG_ASKING_LONG.includes(option) || (option.length > 3 && GPG_ASKING_LONG.some((asking) => asking.startsWith(option)));
  }
  return /^-[A-Za-z]+$/.test(word) && [...word.slice(1)].some((letter) => GPG_ASKING_LETTERS.includes(letter));
}

/** gpg asks unless the command is read-only, or the EFFECTIVE options (left to right, the last of --batch/--no-batch and
 *  the last --pinentry-mode win) are batch with pinentry-mode error; an options file, a home folder, --no-options or a
 *  form it cannot read holds. */
function gpgAsks(args: readonly Word[], argText: readonly string[], assigned: readonly string[]): boolean {
  if (args.some(isDynamic)) return true;
  if (argText.some((word) => GPG_READ_ONLY.includes(word.split("=")[0]!)) && !argText.some(gpgAsking)) return false;
  if (assigned.some((name) => GPG_HOME_NAMES.includes(name))) return true;
  let batch = false;
  let mode: string | undefined;
  const named = [GPG_EFFECTIVE.batch, GPG_EFFECTIVE.noBatch, GPG_EFFECTIVE.pinentry, ...GPG_HOLDING];
  for (let k = 0; k < argText.length; k++) {
    const word = argText[k]!;
    if (word === "--") break;
    if (!word.startsWith("--")) continue;
    const eq = word.indexOf("=");
    const option = eq < 0 ? word : word.slice(0, eq);
    if (GPG_HOLDING.includes(option)) return true;
    if (option === GPG_EFFECTIVE.batch) batch = true;
    else if (option === GPG_EFFECTIVE.noBatch) batch = false;
    else if (option === GPG_EFFECTIVE.pinentry) mode = eq < 0 ? argText[++k] : word.slice(eq + 1);
    else if (option.length > 3 && named.some((full) => full.startsWith(option))) return true;
  }
  return !(batch && mode === GPG_EFFECTIVE.quietPinentry);
}

// ---- git ----------------------------------------------------------------------------------------------------------------------

const GIT_MESSAGE_VALUES = ["-m", "--message", "-F", "--file", "--author", "--date", "-t", "--template", "-C", "-c", "--reuse-message", "--reedit-message"];

function lower(value: string | true | undefined): string | true | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

/** Whether git's configuration reaches outside the chain this reader reads: a per-command GIT_CONFIG_* (or git-dir, HOME)
 *  name, or a global option that moves it. */
function configMoved(globals: readonly Word[], assigned: readonly string[]): boolean {
  if (assigned.some((name) => GIT_CONFIG_MOVERS.namePrefixes.some((prefix) => name.startsWith(prefix)) || (GIT_CONFIG_MOVERS.names as readonly string[]).includes(name))) return true;
  return globals.some((word) => isDynamic(word) || (GIT_CONFIG_MOVERS.globals as readonly string[]).includes(word.text.split("=")[0]!));
}

/** The folder git reads its repository from, after each `-C`, placed as git places it (FIXPLAN (b)): each `-C` resolved
 *  segment by segment from the folder before it with real filesystem semantics, so `link/..` climbs from where the link
 *  points, never collapsed by spelling. A `-C` that does not resolve whole is null: the chain is unresolved and holds. */
function gitCwd(globals: readonly string[], cwd: string, home: string): string | null {
  const platform: NodeJS.Platform = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd) ? "win32" : process.platform;
  let at = cwd;
  for (let k = 0; k < globals.length; k++) {
    if (globals[k] !== "-C" || globals[k + 1] === undefined) continue;
    const placed = realPathInOrder(globals[++k]!, at, { platform, home, mustExist: true });
    if ("cannot" in placed) return null;
    at = placed.real;
  }
  return at;
}

/** git's `-c` pairs before the subcommand, separated (`-c k=v`) and attached (`-ck=v`), in order. */
function gitConfigPairs(globals: readonly string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < globals.length; k++) {
    const word = globals[k]!;
    if (word === "-c") { if (globals[k + 1] !== undefined) out.push(globals[++k]!); }
    else if (/^-c[^-]/.test(word)) out.push(word.slice(2));
  }
  return out;
}

function gitSigns(args: readonly Word[], argText: readonly string[], assigned: readonly string[], facts: PromptFacts | undefined): boolean {
  const { globals, sub } = gitSubcommand(argText);
  const kind = sub === undefined ? undefined
    : (GIT_SIGNING.commitMaking as readonly string[]).includes(sub) ? "commit" : sub === "tag" ? "tag" : sub === "push" ? "push" : undefined;
  if (!kind) return false;
  const restWords = args.slice(globals.length + 1);
  // the line's own flags, the last one wins
  let line: boolean | undefined;
  for (let k = 0; k < restWords.length; k++) {
    const word = restWords[k]!;
    const text = word.text;
    if (isDynamic(word)) {
      const previous = restWords[k - 1]?.text;
      if (previous !== undefined && GIT_MESSAGE_VALUES.includes(previous)) continue;
      if (/^--(message|file|author|date|template)=/.test(text) || /^-m./.test(text)) continue;
      return true;
    }
    if (text === "--") break;
    if (k > 0 && GIT_MESSAGE_VALUES.includes(restWords[k - 1]!.text)) continue;
    if (kind === "commit") {
      if ((GIT_SIGNING.commitOff as readonly string[]).includes(text)) line = false;
      else if (GIT_SIGNING.commitOn.some((flag) => text === flag || text.startsWith(flag.startsWith("--") ? `${flag}=` : flag)) || (/^-[A-Za-z]/.test(text) && !text.startsWith("--") && text.slice(1).includes("S"))) line = true;
    } else if (kind === "tag") {
      if ((GIT_SIGNING.tagOff as readonly string[]).includes(text)) line = false;
      else if (GIT_SIGNING.tagOn.some((flag) => text === flag || (flag.startsWith("--") && text.startsWith(`${flag}=`))) || (/^-[A-Za-z]/.test(text) && !text.startsWith("--") && /[su]/.test(text.slice(1)))) line = true;
    } else {
      if ((GIT_SIGNING.pushOff as readonly string[]).includes(text)) line = false;
      else if ((GIT_SIGNING.pushOn as readonly string[]).includes(text)) line = true;
      else if (text.startsWith("--signed=")) line = !GIT_FALSE_WORDS.includes(text.slice("--signed=".length).toLowerCase());
    }
  }
  if (line !== undefined) return line;
  if (kind === "push") return false;
  const keys: readonly string[] = kind === "commit" ? GIT_SIGNING.commitKeys : GIT_SIGNING.tagKeys;
  // `-c key[=value]` before the subcommand outranks the files
  const overridden = new Map<string, string | true>();
  for (const pair of gitConfigPairs(globals)) {
    const eq = pair.indexOf("=");
    const key = (eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    if (keys.includes(key)) overridden.set(key, eq < 0 ? true : pair.slice(eq + 1));
  }
  const signs = (value: string | true | undefined): boolean | "bad" | undefined => {
    const v = lower(value);
    if (v === undefined) return undefined;
    if (v === true || GIT_TRUE_WORDS.includes(v)) return true;
    return GIT_FALSE_WORDS.includes(v) ? false : "bad";
  };
  for (const value of overridden.values()) if (signs(value) !== false) return true;
  if (configMoved(args.slice(0, globals.length), assigned)) return true;
  if (keys.every((key) => overridden.has(key))) return false;
  if (!facts) return true;
  const at = gitCwd(globals, facts.cwd, facts.home);
  if (at === null) return true;
  const chain = repoConfigValues(at, facts.home, keys, { systemConfig: facts.systemConfig });
  if (!chain.ok) return true;
  return keys.some((key) => !overridden.has(key) && signs(chain.values[key]) !== undefined && signs(chain.values[key]) !== false);
}

function repoSshCommand(args: readonly Word[], argText: readonly string[], assigned: readonly string[], facts: PromptFacts | undefined): PromptHit | null {
  if (!gitNetworkCommand(argText)) return null;
  const setting = facts?.ssh?.source.setting;
  if (setting === "GIT_SSH_COMMAND" || setting === "GIT_SSH") return null;
  if (!facts) return hit("repo-ssh-command");
  const { globals } = gitSubcommand(argText);
  let chain: { ok: true; sshCommand?: string } | { ok: false } = { ok: false };
  const at = gitCwd(globals, facts.cwd, facts.home);
  if (at !== null && !configMoved(args.slice(0, globals.length), assigned)) {
    const read = repoConfigValues(at, facts.home, ["core.sshcommand"], { systemConfig: facts.systemConfig });
    const value = read.ok ? read.values["core.sshcommand"] : undefined;
    if (read.ok && value !== true) chain = value === undefined ? { ok: true } : { ok: true, sshCommand: value };
  }
  const held = repoSshCommandMismatch({ source: facts.ssh?.source ?? { setting: "none" }, kept: facts.ssh?.kept ?? false, gitArgs: argText, chain });
  return held.hold ? hit("repo-ssh-command", held.reason) : null;
}
