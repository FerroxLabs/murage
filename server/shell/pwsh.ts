// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A small PowerShell and cmd reader for the always-ask rules. Reached from
// `powershell -Command <text>`, `cmd /c <text>`, and from command text that
// starts with a cmdlet or `rd`/`rmdir`/`del`/`format`. Statements split on
// `;`, `|`, `&&`, `||` and newlines; `'…'` is literal, `"…"` expands,
// backticks escape, `#` and `<# … #>` are comments, `@'…'@` and `@"…"@` are
// here-strings (`@"…"@` expands as `"…"` does). It asks on anything that
// hides a command: an encoded command, Invoke-Expression, a call operator on
// a value, a subexpression in command position, a .NET call, an unterminated
// quote, an assignment whose right side is not quoted text, variables or a
// number (`$x = Get-Item` runs a command the reader will not follow through a
// value). A single `&` after a statement backgrounds it, so what follows is
// read as a statement of its own. cmd text has its own tokenizer, `lexCmd`. `rm`, `rmdir`,
// `rd`, `del`, `erase` and `ri` with PowerShell-style `-Parameters` are
// Remove-Item, as its aliases; with `/s` they are cmd's. Everything else
// that is not a recognized delete or disk command is ordinary.

import { isPlain, literalText, MAX_TEXT_CHARS, Unreadable, type Part, type Quote, type Word } from "./lex.ts";
import { candidatesOf, expandWord, fork, fromFileWord, MAX_DEPTH, PHYSICAL_DRIVE, resolveName, resolveWritten, runsRemote, simpleCommand, walkForeignExecutor, type Provenance, type Visitor, type WalkContext } from "./walk.ts";

export const POWERSHELLS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const CMDS = new Set(["cmd", "cmd.exe"]);
const EVALS = new Set(["invoke-expression", "iex"]);
/** Every alias of Remove-Item, and what the same name is under cmd. */
const DELETE_ALIASES: Record<string, "remove-item" | "rd" | "del"> = {
  "remove-item": "remove-item", ri: "remove-item", rm: "remove-item", rmdir: "rd", rd: "rd", del: "del", erase: "del",
};
const BLANK = " \t\r";
const VAR_CHAR = /[A-Za-z0-9_:]/;

/** A statement, and whether a pipe joined it to the one before. */
interface Statement {
  words: Word[];
  piped: boolean;
}

interface Lexed {
  statements: Statement[];
  /** subexpressions and script blocks, each a script of its own */
  nested: string[];
}

function lexPwsh(s: string): Lexed {
  const statements: Statement[] = [];
  const nested: string[] = [];
  let words: Word[] = [];
  let parts: Part[] = [];
  let i = 0;
  const lit = (text: string, quote: Quote) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === "lit" && last.quote === quote) last.text += text;
    else parts.push({ kind: "lit", text, quote });
  };
  const endWord = () => {
    if (parts.length) words.push({ parts });
    parts = [];
  };
  // the next statement reads what the one before it writes
  let piped = false;
  const endStatement = (pipe = false) => {
    endWord();
    // a pipe at the end of a line goes on to the next one
    if (!words.length && !pipe) return;
    if (words.length) statements.push({ words, piped });
    words = [];
    piped = pipe;
  };
  const matching = (open: string, close: string, from: number): number => {
    let depth = 1;
    let j = from;
    while (j < s.length) {
      const c = s[j]!;
      if (c === "`") { j += 2; continue; }
      if (c === "'" || c === '"') {
        const end = s.indexOf(c, j + 1);
        if (end < 0) throw new Unreadable("quote", c);
        j = end + 1;
        continue;
      }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return j; }
      j++;
    }
    throw new Unreadable("substitution", open);
  };
  const dollar = (quote: "none" | "double"): void => {
    const next = s[i + 1];
    if (next === "(") {
      const end = matching("(", ")", i + 2);
      nested.push(s.slice(i + 2, end));
      parts.push({ kind: "subst", text: s.slice(i + 2, end), quote });
      i = end + 1;
      return;
    }
    if (next === "{") {
      const end = s.indexOf("}", i + 2);
      if (end < 0) throw new Unreadable("expansion", "${");
      parts.push({ kind: "var", name: s.slice(i + 2, end).toLowerCase(), quote });
      i = end + 1;
      return;
    }
    let j = i + 1;
    while (j < s.length && VAR_CHAR.test(s[j]!)) j++;
    if (j === i + 1) { lit("$", quote); i++; return; }
    parts.push({ kind: "var", name: s.slice(i + 1, j).replace(/:$/, "").toLowerCase(), quote });
    i = j;
  };
  /** Inside `"…"` (to its closing quote) or a `@"…"@` body (to `end`):
   * backticks escape, `$` expands, `""` is a quote. */
  const doubleQuoted = (end?: number): void => {
    for (;;) {
      if (end !== undefined && i >= end) return;
      const d = s[i];
      if (d === undefined) throw new Unreadable("quote", '"');
      if (d === '"' && end === undefined) { if (s[i + 1] === '"') { lit('"', "double"); i += 2; continue; } i++; return; }
      if (d === "`") { lit(s[i + 1] ?? "", "double"); i += 2; continue; }
      if (d === "$") { dollar("double"); continue; }
      lit(d, "double");
      i++;
    }
  };
  while (i < s.length) {
    const c = s[i]!;
    if (BLANK.includes(c)) { endWord(); i++; continue; }
    if (c === "\n" || c === ";") { endStatement(); i++; continue; }
    if (c === "|") {
      // `a || b` runs b on a's failure: a branch the reader does not follow
      if (s[i + 1] === "|") throw new Unreadable("operator", "||");
      endStatement(true);
      i++;
      let j = i;
      while (j < s.length && BLANK.includes(s[j]!)) j++;
      if (s[j] === "|") throw new Unreadable("operator", "||" + s[j]);
      continue;
    }
    if (c === "&") {
      if (s[i + 1] === "&") { endStatement(); i += 2; continue; }
      // at the start of a statement `&` calls what follows; anywhere else it
      // ends the statement (cmd's separator, PowerShell's background job)
      if (words.length === 0 && parts.length === 0) {
        words.push({ parts: [{ kind: "lit", text: "&", quote: "none" }] });
      } else {
        endStatement();
      }
      i++;
      continue;
    }
    if (c === "#" && parts.length === 0) {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (s.startsWith("<#", i)) {
      const end = s.indexOf("#>", i + 2);
      if (end < 0) throw new Unreadable("quote", "<#");
      i = end + 2;
      continue;
    }
    const afterEquals = parts.length > 0 && (() => { const last = parts[parts.length - 1]!; return last.kind === "lit" && last.quote === "none" && last.text.endsWith("="); })();
    if ((s.startsWith("@'", i) || s.startsWith('@"', i)) && (parts.length === 0 || afterEquals)) {
      // `$p=@"…"@`: the here-string is the value, a word of its own
      if (afterEquals) endWord();
      const close = `\n${s[i + 1]}@`;
      const end = s.indexOf(close, i + 2);
      if (end < 0) throw new Unreadable("quote", "@'");
      const start = i + 2 + (/^\r?\n/.exec(s.slice(i + 2))?.[0].length ?? 0);
      if (s[i + 1] === "'") {
        // `@'…'@` is one literal
        lit(s.slice(start, end), "single");
      } else {
        // `@"…"@` expands exactly as `"…"` does: the same routine, to its closer
        i = start;
        doubleQuoted(end);
        if (parts.length === 0) lit("", "double");
      }
      i = end + close.length;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let text = "";
      for (;;) {
        const end = s.indexOf("'", j);
        if (end < 0) throw new Unreadable("quote", "'");
        text += s.slice(j, end);
        if (s[end + 1] === "'") { text += "'"; j = end + 2; continue; }
        i = end + 1;
        break;
      }
      lit(text, "single");
      continue;
    }
    if (c === '"') {
      i++;
      doubleQuoted();
      continue;
    }
    if (c === "`") {
      if (s[i + 1] === "\n") { i += 2; continue; }
      lit(s[i + 1] ?? "", "none");
      i += 2;
      continue;
    }
    if (c === "$") { dollar("none"); continue; }
    if ((c === "(" || c === "{") && parts.length === 0) {
      const close = c === "(" ? ")" : "}";
      const end = matching(c, close, i + 1);
      nested.push(s.slice(i + 1, end));
      parts.push({ kind: "subst", text: s.slice(i + 1, end), quote: "none" });
      i = end + 1;
      continue;
    }
    if (c === "~" && parts.length === 0) {
      parts.push({ kind: "tilde", user: "" });
      i++;
      continue;
    }
    if (c === "*" || c === "?") {
      parts.push({ kind: "glob", text: c });
      i++;
      continue;
    }
    lit(c, "none");
    i++;
  }
  endStatement();
  return { statements, nested };
}

/** The word written back as PowerShell text, for a nested `-Command`. */
export function renderPwshWord(word: Word): string {
  return word.parts.map((part) => {
    switch (part.kind) {
      case "lit": return part.text;
      case "var": return `$${part.name}`;
      case "subst": return `$(${part.text})`;
      case "tilde": return "~";
      case "glob": return part.text;
      default: return "";
    }
  }).join("");
}

/** Walk PowerShell or cmd text, visiting every statement. */
const ASSIGNMENT_OP = /^(\+=|-=|\*=|\/=|%=|\?\?=|=)(?!=)/;
const DOTNET_CALL = /::|\.[A-Za-z_]\w*\s*\(/;
const NUMBER = /^-?\d+(\.\d+)?(kb|mb|gb|tb|pb|l|d)?$/i;

/** The words after an assignment operator in this statement, when it has
 * one: `$x = …`, `$x=…`, `$x +=…`, `$x.Name = …`. Undefined when there is
 * no assignment. */
function assignmentRhs(words: Word[]): { rhs: Word[]; op: string; glued: boolean } | undefined {
  const after = (text: string, rest: Part[]): Word[] => {
    const parts: Part[] = [...(text ? [{ kind: "lit", text, quote: "none" } as Part] : []), ...rest];
    return parts.length ? [{ parts }] : [];
  };
  const first = words[0]!;
  // the operator glued to the name: `$x=Remove-Item`, `$x+=1`
  const glued = first.parts[0]?.kind === "var" ? first.parts[1] : undefined;
  if (glued && glued.kind === "lit" && glued.quote === "none") {
    const op = ASSIGNMENT_OP.exec(glued.text);
    if (op) return { rhs: [...after(glued.text.slice(op[0].length), first.parts.slice(2)), ...words.slice(1)], op: op[1]!, glued: true };
  }
  // the operator as a word of its own or glued to the value: `$x = …`,
  // `$x.Name = 1`, `$x =Remove-Item`
  for (let i = 1; i < words.length; i++) {
    const lead = words[i]!.parts[0];
    if (!lead || lead.kind !== "lit" || lead.quote !== "none") continue;
    const op = ASSIGNMENT_OP.exec(lead.text);
    if (op) return { rhs: [...after(lead.text.slice(op[0].length), words[i]!.parts.slice(1)), ...words.slice(i + 1)], op: op[1]!, glued: false };
  }
  return undefined;
}


/** A right side that runs nothing: one number, or one word of quoted text
 * and variables only (`'a'`, `"$y"`, `"${y}0"`, `"$($y)"`, `$y`), with a
 * subexpression that is one variable read as that variable. Undefined for
 * anything else (`Get-Item x`, `(…)`, `$y.Name`). */
function bindable(rhs: Word[]): Word | undefined {
  if (rhs.length !== 1) return undefined;
  const word = rhs[0]!;
  if (word.parts.every((part) => part.kind === "lit") && NUMBER.test(literalText(word) ?? "")) return word;
  const parts: Part[] = [];
  for (const part of word.parts) {
    if (part.kind === "lit" && part.quote !== "none") { parts.push(part); continue; }
    if (part.kind === "var" && part.op === undefined) { parts.push(part); continue; }
    if (part.kind === "subst") {
      const one = /^\s*\$(?:\{([^}]+)\}|([A-Za-z0-9_:]+))\s*$/.exec(part.text);
      if (one) { parts.push({ kind: "var", name: (one[1] ?? one[2])!.replace(/:$/, "").toLowerCase(), quote: part.quote }); continue; }
    }
    return undefined;
  }
  return { parts };
}

/** The target of every output redirect in a statement (`> f`, `>>f`, `2> f`,
 * `*>f`, `echo hi>f`), as written. `>&1`-style duplicates are not files. */
function redirectTargets(words: Word[]): Word[] {
  const targets: Word[] = [];
  for (let w = 0; w < words.length; w++) {
    const parts = words[w]!.parts;
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p]!;
      if (part.kind !== "lit" || part.quote !== "none") continue;
      const at = part.text.indexOf(">");
      if (at < 0) continue;
      let end = at + 1;
      if (part.text[end] === ">") end++;
      const rest = part.text.slice(end);
      if (rest.startsWith("&")) break;
      const tail: Part[] = [...(rest ? [{ kind: "lit", text: rest, quote: "none" } as Part] : []), ...parts.slice(p + 1)];
      if (tail.length) targets.push({ parts: tail });
      else if (words[w + 1]) targets.push(words[w + 1]!);
      break;
    }
  }
  return targets;
}

/** The name a statement binds: `$x = …` and `$x=…`, not `$x.Name = …`. */
function assignedName(words: Word[], glued: boolean): string | undefined {
  const first = words[0]!;
  const named = first.parts[0];
  if (!named || named.kind !== "var" || named.op !== undefined) return undefined;
  if (glued ? first.parts.length >= 2 : first.parts.length === 1) return named.name;
  return undefined;
}

/** `Set-Variable d value`, `sv -Name d -Value value`: the name and value, when
 * both are literal or variables. */
function setVariable(args: Word[]): { name: string; value: Word } | undefined {
  let name: string | undefined;
  let value: Word | undefined;
  const positional: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const text = literalText(args[i]!);
    if (text?.startsWith("-")) {
      const option = text.toLowerCase();
      if ("-name".startsWith(option) && option.length >= 2) { name = literalText(args[++i] ?? { parts: [] }); continue; }
      if ("-value".startsWith(option) && option.length >= 2) { value = args[++i]; continue; }
      return undefined;
    }
    positional.push(args[i]!);
  }
  name ??= positional[0] ? literalText(positional.shift()!) : undefined;
  value ??= positional.shift();
  if (name === undefined || !value || positional.length) return undefined;
  const bound = bindable([value]);
  return bound ? { name: name.toLowerCase(), value: bound } : undefined;
}

/** What a Windows statement writes down a pipe (UPSEC 10.3 Windows output
 * rows), computed and never assumed: an emitter's literal words, a file
 * reader's file, a lister's roots, a filter's own input. Anything else is a value. */
const PWSH_EMITTERS = new Set(["write-output", "echo", "write"]);
const PWSH_FILE_READERS = new Set(["get-content", "gc", "cat", "type"]);
const PWSH_LISTERS = new Set(["get-childitem", "gci", "ls", "dir"]);
const PWSH_LISTER_FLAGS = new Set(["-recurse", "-force", "-file", "-directory", "-hidden", "-name"]);
const PWSH_LISTER_VALUES = new Set(["-filter", "-include", "-exclude", "-depth"]);
const PWSH_ITEMS = new Set(["get-item", "gi", "resolve-path", "rvpa"]);
const PWSH_FILTERS = new Set(["where-object", "?", "select-object", "select", "sort-object", "sort"]);
const CMD_EMITTERS = new Set(["echo"]);
const CMD_FILE_READERS = new Set(["type"]);
const CMD_LISTERS = new Set(["dir"]);

const valueOutput = (why: string): Provenance => ({ kind: "value", why });

/** A word that is one quoted string or here-string, and nothing else. */
function stringExpression(word: Word): boolean {
  return word.parts.length > 0 && word.parts.every((part) => part.kind === "lit" && part.quote !== "none");
}

/** Emitted words as the next program reads them: literal text, or a value. */
function emitted(words: Word[], render: (word: Word) => string): Provenance {
  if (!words.every(isPlain)) return valueOutput("emitted text with a value");
  return { kind: "literal", text: words.map(render).join(" "), words };
}

/** A reader of one literal file: that file, read through `resolveWritten`. */
function readFile(args: Word[], ctx: WalkContext, pwsh: boolean): Provenance {
  const only = args.length === 1 ? literalText(args[0]!) : undefined;
  // PowerShell's options start with `-`, so `/tmp/x.sh` is a path; to cmd `/x` is a switch
  if (only === undefined || only.startsWith("-") || (!pwsh && only.startsWith("/"))) return valueOutput("a file reader with options or a value");
  return { kind: "file", path: resolveWritten(ctx, only.replace(/\\/g, "/")) };
}

function pwshOutputOf(words: Word[], input: Provenance | undefined, ctx: WalkContext): Provenance {
  if (words.length === 1 && stringExpression(words[0]!)) return emitted(words, renderPwshWord);
  const first = literalText(words[0]!);
  const call = first === "&" || first === "." ? words.slice(1) : words;
  if (!call.length) return valueOutput("a call");
  const name = resolveName(call[0]!);
  const args = call.slice(1);
  if (name === undefined) return valueOutput("a value");
  if (PWSH_EMITTERS.has(name)) return emitted(args, renderPwshWord);
  if (PWSH_FILE_READERS.has(name)) return readFile(args, ctx, true);
  if (PWSH_FILTERS.has(name)) return input ?? valueOutput("a filter of nothing");
  const roots: Word[] = [];
  if (PWSH_LISTERS.has(name) || PWSH_ITEMS.has(name)) {
    // a pattern value (`-Filter *.log`) is fixed text with wildcards in it
    const fixed = (word: Word | undefined) => !!word && word.parts.every((part) => part.kind === "lit" || part.kind === "tilde" || part.kind === "glob");
    for (let i = 0; i < args.length; i++) {
      const text = literalText(args[i]!);
      if (text === undefined) {
        if (!isPlain(args[i]!)) return valueOutput("a lister given a value");
        roots.push(args[i]!);
        continue;
      }
      const option = text.toLowerCase();
      if (option.startsWith("-")) {
        if (!PWSH_LISTERS.has(name)) return valueOutput("an item lookup with options");
        if (PWSH_LISTER_FLAGS.has(option)) continue;
        if (PWSH_LISTER_VALUES.has(option) && fixed(args[i + 1])) { i++; continue; }
        return valueOutput(`${name} ${text}`);
      }
      roots.push(args[i]!);
    }
    if (!roots.length && PWSH_ITEMS.has(name)) return valueOutput("an item lookup of nothing");
    return { kind: "roots", roots: roots.length ? roots : [{ parts: [{ kind: "lit", text: ".", quote: "none" }] }] };
  }
  return valueOutput(`the output of ${name}`);
}

/** cmd's output rows: `echo`, `type` of one file, `dir` with only `/b`, `/s`, `/a…`. */
function cmdOutputOf(words: Word[] | undefined, ctx: WalkContext): Provenance {
  if (!words?.length) return valueOutput("the output of a block");
  const name = resolveName(words[0]!)?.replace(/\.(exe|com)$/, "");
  const args = words.slice(1);
  if (name !== undefined && CMD_EMITTERS.has(name)) return emitted(args, renderCmdWord);
  if (name !== undefined && CMD_FILE_READERS.has(name)) return readFile(args, ctx, false);
  if (name !== undefined && CMD_LISTERS.has(name)) {
    const roots: Word[] = [];
    for (const arg of args) {
      const text = literalText(arg);
      if (text === undefined) return valueOutput("dir given a value");
      if (/^\/(b|s|a[-a-z]*)$/i.test(text)) continue;
      if (text.startsWith("/")) return valueOutput(`dir ${text}`);
      roots.push(arg);
    }
    return { kind: "roots", roots: roots.length ? roots : [{ parts: [{ kind: "lit", text: ".", quote: "none" }] }] };
  }
  return valueOutput(`the output of ${name ?? "a value"}`);
}

/** A nested PowerShell or cmd given no text to run reads its commands from
 * its input: literal input is walked, a file this text wrote as written, a
 * download as `runsRemote` says; any other input asks. */
export function walkShellInput<H>(pwsh: boolean, stdin: Provenance, ctx: WalkContext, visitor: Visitor<H>, hops = 0): H | null {
  if (hops > MAX_DEPTH) throw new Unreadable("depth");
  switch (stdin.kind) {
    case "literal": {
      // the input is the program: its commands have nothing left to read
      const inner = fork(ctx, true);
      delete inner.stdin;
      return pwsh ? walkPwsh(stdin.text, inner, visitor) : walkCmd(stdin.text, inner, visitor);
    }
    case "file": { const written = ctx.written.get(resolveWritten(ctx, stdin.path)); return written ? walkShellInput(pwsh, written, ctx, visitor, hops + 1) : null; }
    case "remote": runsRemote(!!ctx.elevated); return null;
    case "roots": case "value": throw new Unreadable("expansion", "a shell reads a value on its input");
  }
}

/** What a nested `powershell`/`pwsh` or `cmd` runs, read from its own
 * arguments (UPSEC 10.6). `text`: `-Command <text>`, `-CommandWithArgs`,
 * `cmd /c <text>`, or Windows PowerShell's first positional word, which is
 * its command. `stdin`: `-Command -`, `-File -` and the `-c -` forms read
 * their code from standard input (`explicit`), as a shell given nothing to
 * run does. `file`: `-File <path>`, or `pwsh`'s first positional word,
 * which is its script. `-EncodedCommand` and `-EncodedArguments` ask. */
export type NestedProgram = { kind: "text"; words: Word[] } | { kind: "stdin"; explicit: boolean } | { kind: "file"; word: Word };

/** PowerShell's own parameters that take a value, by full name and alias. */
const PWSH_VALUE_PARAMETERS = ["-executionpolicy", "-windowstyle", "-workingdirectory", "-configurationname", "-configurationfile", "-custompipename", "-inputformat", "-outputformat", "-psconsolefile", "-version", "-settingsfile"];
const PWSH_VALUE_ALIASES = new Set(["-ex", "-ep", "-w", "-wd", "-config", "-inp", "-if", "-o", "-of", "-v", "-settings"]);
/** `-name` or an abbreviation of it at least `min` long (PowerShell takes any unique prefix). */
const abbreviates = (text: string, name: string, min = 2) => text.length >= min && name.startsWith(text);

export function nestedProgram(program: string, args: Word[]): NestedProgram {
  const name = program.toLowerCase().replace(/\.exe$/, "");
  if (name === "cmd") {
    for (let i = 0; i < args.length; i++) {
      const text = (literalText(args[i]!) ?? "").toLowerCase();
      if (text === "/c" || text === "/k" || text === "/r") return { kind: "text", words: args.slice(i + 1) };
    }
    return { kind: "stdin", explicit: false };
  }
  for (let i = 0; i < args.length; i++) {
    const raw = literalText(args[i]!);
    // a word the text does not fix may be any parameter
    if (raw === undefined) throw new Unreadable("expansion", `a value in the arguments of ${program}`);
    const text = raw.toLowerCase();
    if (text === "-") return { kind: "stdin", explicit: true };
    if (!text.startsWith("-")) return name === "powershell" ? { kind: "text", words: args.slice(i) } : { kind: "file", word: args[i]! };
    const option = text.replace(/:.*$/, "");
    if (option === "-ec" || abbreviates(option, "-encodedcommand") || abbreviates(option, "-encodedarguments", 9) || option === "-ea") throw new Unreadable("pwsh", "-EncodedCommand");
    if (option === "-cwa" || abbreviates(option, "-commandwithargs", 9) || abbreviates(option, "-command")) {
      const rest = args.slice(i + 1);
      if (rest.length === 0 || literalText(rest[0]!) === "-") return { kind: "stdin", explicit: true };
      return { kind: "text", words: rest };
    }
    if (abbreviates(option, "-file")) {
      const script = args[i + 1];
      if (!script || literalText(script) === "-") return { kind: "stdin", explicit: true };
      return { kind: "file", word: script };
    }
    if (!text.includes(":") && (PWSH_VALUE_ALIASES.has(option) || PWSH_VALUE_PARAMETERS.some((full) => abbreviates(option, full, 3)))) i++;
  }
  return { kind: "stdin", explicit: false };
}

/** Run what a nested PowerShell or cmd is given, other than text: its input,
 * or a script file. Input it reads as code that the text does not fix asks
 * when the shell was told to read it (`-Command -`); a shell left to read
 * an interactive terminal runs nothing this text says. A script this text
 * wrote is walked as written; one it did not write is a file on disk. */
export function walkNestedInput<H>(pwsh: boolean, program: NestedProgram & { kind: "stdin" | "file" }, stdin: Provenance | undefined, ctx: WalkContext, visitor: Visitor<H>): H | null {
  if (program.kind === "file") {
    const path = literalText(program.word);
    if (path === undefined) {
      if (ctx.written.size) throw new Unreadable("expansion", "a shell runs a file a value names, after this text wrote files");
      return null;
    }
    return walkShellInput(pwsh, { kind: "file", path }, ctx, visitor);
  }
  if (stdin) return walkShellInput(pwsh, stdin, ctx, visitor);
  if (program.explicit) throw new Unreadable("expansion", "a shell reads its commands from input the text does not fix");
  return null;
}

/** Cmdlets that act on the items piped into them when no path is given: the
 * delete, move, rename and ACL families. */
const PIPELINE_TARGETS = new Set(["remove-item", "ri", "move-item", "mi", "rename-item", "rni", "set-acl"]);
const PATH_PARAMETERS = new Set(["-path", "-literalpath", "-lp", "-pspath"]);
const VALUE_PARAMETERS = new Set([
  "-filter", "-include", "-exclude", "-credential", "-stream", "-erroraction", "-ea", "-warningaction", "-wa", "-informationaction", "-infa",
  "-errorvariable", "-ev", "-warningvariable", "-wv", "-informationvariable", "-iv", "-outvariable", "-ov", "-outbuffer", "-ob", "-pipelinevariable", "-pv",
  "-destination", "-newname", "-aclobject",
]);

/** Does a cmdlet name its own path: a positional word, or `-Path`/`-LiteralPath`? */
function namesPath(args: Word[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const text = literalText(args[i]!);
    if (text === undefined || !text.startsWith("-")) return true;
    const option = text.toLowerCase().replace(/:.*$/, "");
    if (PATH_PARAMETERS.has(option)) return true;
    if (VALUE_PARAMETERS.has(option) && !text.includes(":")) i++;
  }
  return false;
}

/** The operands the piped items become (UPSEC 10.6): a lister's roots, one
 * literal per line, the items of a list file, or one value. */
function pipelineOperands(stdin: Provenance, ctx: WalkContext, hops = 0): Word[] {
  if (hops > MAX_DEPTH) throw new Unreadable("depth");
  switch (stdin.kind) {
    case "roots": return stdin.roots;
    case "literal": return stdin.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => ({ parts: [{ kind: "lit", text: line, quote: "single" }] }));
    case "file": { const written = ctx.written.get(resolveWritten(ctx, stdin.path)); return written ? pipelineOperands(written, ctx, hops + 1) : [fromFileWord(stdin.path)]; }
    case "remote": case "value": return [{ parts: [{ kind: "var", name: "-pipeline-input", quote: "none" }] }];
  }
}

export function walkPwsh<H>(text: string, ctx: WalkContext, visitor: Visitor<H>): H | null {
  if (ctx.depth > MAX_DEPTH) throw new Unreadable("depth");
  if (text.length > MAX_TEXT_CHARS) throw new Unreadable("length");
  const { statements, nested } = lexPwsh(text);
  for (const inner of nested) {
    const hit = walkPwsh(inner, fork(ctx, true), visitor);
    if (hit) return hit;
  }
  // what the statement before writes down the pipe, when one joins them
  let carried: Provenance | undefined;
  for (const statement of statements) {
    // a statement no pipe feeds reads what this shell was given (a nested
    // `pwsh -Command` or `cmd /c` reached by a pipe, UPSEC 10.6)
    let stdin = statement.piped ? carried : ctx.stdin;
    carried = pwshOutputOf(statement.words, stdin, ctx);
    let words = statement.words;
    // a redirect: its target read through the names this text bound
    if (visitor.pwshRedirect) {
      for (const target of redirectTargets(words)) {
        const hit = visitor.pwshRedirect(target, candidatesOf(target, ctx), ctx);
        if (hit) return hit;
      }
    }
    // a .NET call (`[IO.Directory]::Delete(…)`, `$x.Delete()`) runs code the
    // reader does not model
    if (words.some((word) => DOTNET_CALL.test(renderPwshWord(word)))) {
      // a .NET call that names a physical drive (`[IO.File]::WriteAllBytes('\\.\PhysicalDrive0', …)`) is a disk write
      if (words.some((word) => PHYSICAL_DRIVE.test(renderPwshWord(word)))) {
        const hit = visitor.command(simpleCommand(".net-call", words, ctx), ctx);
        if (hit) return hit;
      }
      throw new Unreadable("pwsh", "a .NET call");
    }
    // `$x = 'a'`, `$x = "$y"` bind a value that runs nothing; any other right
    // side (`$x = Remove-Item …`, `$x = (…)`) is not followed
    const assignment = assignmentRhs(words);
    if (assignment) {
      const value = bindable(assignment.rhs);
      if (!value) throw new Unreadable("pwsh", "an assignment whose right side is not literal");
      const name = assignedName(words, assignment.glued);
      if (name !== undefined) {
        if (assignment.op === "=") { ctx.bound.set(name, expandWord(value, ctx)); ctx.arrays.delete(name); } else ctx.bound.set(name, null);
      }
      continue;
    }
    const first = literalText(words[0]!);
    if (first === "&" || first === ".") words = words.slice(1);
    if (words.length === 0) continue;
    // `$_.Length -gt 1mb`, `(Get-Item x).Name`: an expression, not a call
    // (calling a value takes `&`, which is read above and asks)
    const lead = words[0]!.parts[0];
    if (first !== "&" && first !== "." && lead && (lead.kind === "var" || lead.kind === "subst")) continue;
    // `'text'`, `@'…'@`: a string expression, written down the pipe
    if (first !== "&" && first !== "." && stringExpression(words[0]!)) continue;
    const name = resolveName(words[0]!);
    if (name === undefined) throw new Unreadable("dynamic-name", renderPwshWord(words[0]!));
    let program = name.replace(/\.(exe|com|cmd|bat)$/, "");
    if (EVALS.has(program)) throw new Unreadable("dynamic-eval", program);
    const args = words.slice(1);
    if (program === "set-variable" || program === "sv") {
      const set = setVariable(args);
      if (!set) throw new Unreadable("pwsh", "Set-Variable with a value the reader does not follow");
      ctx.bound.set(set.name, expandWord(set.value, ctx));
      ctx.arrays.delete(set.name);
      continue;
    }
    const alias = DELETE_ALIASES[program];
    if (alias) {
      // `rmdir -Recurse -Force ~` is Remove-Item under its alias; `rd /s` is cmd's
      const texts = args.map(literalText);
      const dashed = texts.some((text) => text !== undefined && /^-[A-Za-z]/.test(text));
      const slashed = texts.some((text) => text !== undefined && /^\/[a-z]+$/i.test(text));
      if (dashed && slashed) throw new Unreadable("pwsh", `${program} with both -Parameters and /switches`);
      // given piped items, the alias is PowerShell's: cmd's delete takes no pipe
      program = dashed || (stdin && !slashed) ? "remove-item" : alias;
    }
    if (POWERSHELLS.has(program) || CMDS.has(program)) {
      const pwsh = POWERSHELLS.has(program);
      const run = nestedProgram(program, args);
      if (run.kind === "text") {
        // the text the inner shell runs has to be fixed by this text
        if (run.words.some((word) => !word.parts.every((part) => part.kind === "lit" || part.kind === "tilde"))) throw new Unreadable("expansion", `a value in text ${program} runs`);
        const inner = run.words.map(renderPwshWord).join(" ");
        const nested = fork(ctx, true);
        if (stdin) nested.stdin = stdin;
        const hit = pwsh ? walkPwsh(inner, nested, visitor) : walkCmd(inner, nested, visitor);
        if (hit) return hit;
        continue;
      }
      // `-Command -`, `-File`, or nothing to run: its input or its script
      const hit = walkNestedInput(pwsh, run, stdin, ctx, visitor);
      if (hit) return hit;
      continue;
    }
    // `bash -c …`, `python -c …`, `wsl …`: walked as the POSIX reader walks
    // them, reading what the pipe before them writes
    const foreign = walkForeignExecutor(program, args, ctx, visitor, stdin);
    if (foreign !== undefined) { if (foreign) return foreign; continue; }
    // piped items are the operands of a delete, move, rename or ACL cmdlet that names no path
    const operands = stdin && PIPELINE_TARGETS.has(program) && !namesPath(args) ? [...args, ...pipelineOperands(stdin, ctx)] : args;
    const spelled = literalText(words[0]!);
    const hit = visitor.command(simpleCommand(program, operands, ctx, spelled !== undefined ? { program: { text: spelled, dialect: "windows" } } : {}), ctx);
    if (hit) return hit;
  }
  return null;
}

// cmd: its own language, with its own tokenizer (UPSEC 3.5).

type CmdToken =
  | { kind: "word"; word: Word }
  | { kind: "op"; op: "&" | "&&" | "||" | "|" | "\n" | "(" | ")" }
  | { kind: "redirect"; op: string; target?: Word };

const CMD_BLANK = " \t\r";
/** cmd keywords the reader does not model: they ask. */
const CMD_UNMODELED = new Set(["goto", "setlocal", "endlocal", "shift", "set"]);
const START_FLAGS = new Set(["/b", "/wait", "/min", "/max", "/low", "/normal", "/high", "/realtime", "/abovenormal", "/belownormal", "/i", "/separate", "/shared"]);

/** cmd text as cmd reads it: `rem` and `::` at a statement start comment to
 * the physical newline (`&` included); `#` is a character; `^` escapes the
 * next character and `^⏎` continues the line; `"` toggles quoting, inside
 * which only `"` is special; `&`, `&&`, `||`, `|` and newlines separate;
 * `(` and `)` make blocks; `%NAME%`, `!NAME!`, `%%i`, `%~dpi` and `%i` are
 * values; `@` at a statement start is dropped. */
export function lexCmd(s: string): CmdToken[] {
  if (s.length > MAX_TEXT_CHARS) throw new Unreadable("length");
  const tokens: CmdToken[] = [];
  let parts: Part[] = [];
  let i = 0;
  let depth = 0;
  let atStart = true;
  let quoted = false;
  let redirect: string | undefined;
  const lit = (text: string, quote: Quote) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === "lit" && last.quote === quote) last.text += text;
    else parts.push({ kind: "lit", text, quote });
  };
  const endWord = () => {
    if (parts.length) {
      const word = { parts };
      if (redirect !== undefined) { tokens.push({ kind: "redirect", op: redirect, target: word }); redirect = undefined; } else tokens.push({ kind: "word", word });
      atStart = false;
    }
    parts = [];
  };
  const op = (o: "&" | "&&" | "||" | "|" | "\n" | "(" | ")") => {
    endWord();
    if (redirect !== undefined) throw new Unreadable("cmd", `${redirect} without a target`);
    tokens.push({ kind: "op", op: o });
    atStart = true;
  };
  const variable = (quote: Quote): boolean => {
    const rest = s.slice(i, i + 256);
    const forVar = /^%%?~([A-Za-z]*(?:\$[^:%\s]*:)?)([A-Za-z0-9])|^%%([A-Za-z])/.exec(rest);
    if (forVar) {
      // `%~i` and `%~fi` are the item itself (unquoted, made full); any other
      // modifier (`%~dpi`, the item's parent) is a value of its own, never
      // the item's binding
      const modifiers = forVar[1] ?? "";
      const letter = forVar[2] ?? forVar[3]!;
      const name = modifiers === "" || /^f+$/i.test(modifiers) ? `%${letter}` : `%~${modifiers}${letter}`;
      parts.push({ kind: "var", name, quote });
      i += forVar[0].length;
      return true;
    }
    const env = /^%([^%\s]+)%/.exec(rest);
    if (env) { parts.push({ kind: "var", name: env[1]!.toUpperCase(), quote }); i += env[0].length; return true; }
    const single = /^%([A-Za-z0-9*])/.exec(rest);
    if (single) { parts.push({ kind: "var", name: `%${single[1]}`, quote }); i += single[0].length; return true; }
    const delayed = /^!([^!\s]+)!/.exec(rest);
    if (delayed) { parts.push({ kind: "var", name: `!${delayed[1]!.toUpperCase()}`, quote }); i += delayed[0].length; return true; }
    return false;
  };
  while (i < s.length) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') { quoted = false; i++; continue; }
      if (c === "\n") throw new Unreadable("quote", '" in cmd text');
      if ((c === "%" || c === "!") && variable("double")) continue;
      lit(c, "double");
      i++;
      continue;
    }
    if (atStart && parts.length === 0) {
      if (CMD_BLANK.includes(c)) { i++; continue; }
      if (c === "@") { i++; continue; }
      if (s.startsWith("::", i) || /^rem(\s|$)/i.test(s.slice(i, i + 4))) {
        while (i < s.length && s[i] !== "\n") i++;
        continue;
      }
    }
    if (c === "^") {
      const next = s[i + 1];
      if (next === undefined) { i++; continue; }
      if (next === "\n") { i += 2; continue; }
      lit(next, "none");
      i += 2;
      continue;
    }
    if (c === '"') { quoted = true; if (!parts.length) lit("", "double"); i++; continue; }
    if (CMD_BLANK.includes(c)) { endWord(); i++; continue; }
    if (c === "\n") { op("\n"); i++; continue; }
    if (c === "&") { if (s[i + 1] === "&") { op("&&"); i += 2; } else { op("&"); i++; } continue; }
    if (c === "|") { if (s[i + 1] === "|") { op("||"); i += 2; } else { op("|"); i++; } continue; }
    if (c === "(" && parts.length === 0) { op("("); depth++; i++; continue; }
    if (c === ")" && depth > 0) { op(")"); depth--; i++; continue; }
    const fd = parts.length === 0 && /^[0-9]>/.test(s.slice(i, i + 2));
    if (c === ">" || c === "<" || fd) {
      endWord();
      const m = /^[0-9]?(>>|>|<)(&[0-9])?/.exec(s.slice(i))!;
      i += m[0].length;
      // `2>&1` duplicates a descriptor; `< f` reads
      if (!m[2]) redirect = m[1]!;
      continue;
    }
    if ((c === "%" || c === "!") && variable("none")) continue;
    lit(c, "none");
    i++;
  }
  if (quoted) throw new Unreadable("quote", '" in cmd text');
  endWord();
  if (redirect !== undefined) throw new Unreadable("cmd", `${redirect} without a target`);
  if (depth > 0) throw new Unreadable("cmd", "( without )");
  return tokens;
}

/** The items one word of a cmd `for` list stands for, as words: split at
 * unquoted `,`, `;` and `=`; a `*` or `?` (quoted or not) is a wildcard cmd
 * matches against files, so it is a glob part; values stay values. */
function cmdForItems(word: Word): Word[] {
  const items: Word[] = [];
  let parts: Part[] = [];
  const push = () => { if (parts.length) items.push({ parts }); parts = []; };
  for (const part of word.parts) {
    if (part.kind !== "lit") { parts.push(part); continue; }
    let text = "";
    const flush = () => { if (text) parts.push({ kind: "lit", text, quote: part.quote }); text = ""; };
    for (const c of part.text) {
      if (part.quote === "none" && (c === "," || c === ";" || c === "=")) { flush(); push(); continue; }
      if (c === "*" || c === "?") { flush(); parts.push({ kind: "glob", text: c }); continue; }
      text += c;
    }
    flush();
  }
  push();
  return items;
}

/** A `for` variable is put in once, as cmd matched or listed it: a wildcard
 * item is the files it matched, not a pattern the shell globs again. Only
 * an item with a blank in it is split again by the command, so only then is
 * it a value that may stand for several words. */
function forItemWord(word: Word, state: WalkContext): Word {
  return {
    parts: word.parts.map((part) => {
      if (part.kind !== "var" || part.quote !== "none" || !part.name.startsWith("%")) return part;
      const values = state.bound.get(part.name);
      const unsplit = !!values && values.every((value) => value.parts.every((p) => p.kind !== "lit" || !/\s/.test(p.text)));
      return unsplit ? { ...part, quote: "double" as const } : part;
    }),
  };
}

/** A cmd word written back as cmd text, for a nested `cmd /c`. */
function renderCmdWord(word: Word): string {
  return word.parts.map((part) => (part.kind === "lit" ? part.text : part.kind === "var" ? (part.name.startsWith("%") ? part.name : part.name.startsWith("!") ? `${part.name}!` : `%${part.name}%`) : "")).join("");
}

const bareCmd = (token: CmdToken | undefined): string | undefined => (token?.kind === "word" ? literalText(token.word)?.toLowerCase() : undefined);

/** Walk cmd text: every statement, `for` bodies with the loop variable bound
 * to a literal list, both blocks of an `if`, `call`, `start` and `cmd /c`
 * looked through. */
export function walkCmd<H>(text: string, ctx: WalkContext, visitor: Visitor<H>): H | null {
  if (ctx.depth > MAX_DEPTH) throw new Unreadable("depth");
  const tokens = lexCmd(text);
  let pos = 0;
  const separator = (token: CmdToken | undefined) => token?.kind === "op" && token.op !== "(" && token.op !== ")";
  // the words of the last simple statement, for what it writes down a pipe
  let lastWords: Word[] | undefined;

  const list = (state: WalkContext, inBlock: boolean): H | null => {
    for (;;) {
      // whether the separator before this statement was the pipe (UPSEC 10.6)
      let piped = false;
      while (separator(tokens[pos])) { piped = (tokens[pos] as { op: string }).op === "|"; pos++; }
      const token = tokens[pos];
      if (!token) { if (inBlock) throw new Unreadable("cmd", "( without )"); return null; }
      if (token.kind === "op" && token.op === ")") {
        if (!inBlock) throw new Unreadable("cmd", ") without (");
        pos++;
        return null;
      }
      const hit = statement(state, piped);
      if (hit) return hit;
    }
  };

  const statement = (state: WalkContext, piped = false): H | null => {
    const token = tokens[pos];
    if (token?.kind === "op" && token.op === "(") { pos++; const hit = list(state, true); lastWords = undefined; return hit; }
    const keyword = bareCmd(token);
    if (keyword === "for") { const hit = forStatement(state); lastWords = undefined; return hit; }
    if (keyword === "if") { const hit = ifStatement(state); lastWords = undefined; return hit; }
    const words: Word[] = [];
    const redirects: Array<{ op: string; target: Word }> = [];
    for (;;) {
      const next = tokens[pos];
      if (!next || next.kind === "op") break;
      pos++;
      if (next.kind === "redirect") { if (next.target) redirects.push({ op: next.op, target: next.target }); continue; }
      words.push(next.word);
    }
    if (tokens[pos]?.kind === "op" && (tokens[pos] as { op: string }).op === "(") throw new Unreadable("cmd", "( inside a statement");
    const stdin = piped ? cmdOutputOf(lastWords, state) : state.stdin;
    lastWords = words;
    return simple(words, redirects, state, stdin);
  };

  const forStatement = (state: WalkContext): H | null => {
    pos++;
    let unknown = false;
    while (tokens[pos]?.kind === "word" && (bareCmd(tokens[pos]) ?? "").startsWith("/")) {
      const option = bareCmd(tokens[pos])!;
      pos++;
      if (/^\/[fdrl]$/.test(option)) unknown = true;
      // `/f "options"`, `/r folder`: a value before the variable
      if ((option === "/f" || option === "/r") && tokens[pos]?.kind === "word" && !((tokens[pos] as { word: Word }).word.parts[0]?.kind === "var")) pos++;
    }
    const variableToken = tokens[pos];
    const variable = variableToken?.kind === "word" && variableToken.word.parts.length === 1 && variableToken.word.parts[0]!.kind === "var" ? variableToken.word.parts[0]!.name : undefined;
    if (!variable || !variable.startsWith("%")) throw new Unreadable("cmd", "for without a variable");
    pos++;
    if (bareCmd(tokens[pos]) !== "in") throw new Unreadable("cmd", "for without in");
    pos++;
    const open = tokens[pos];
    if (open?.kind !== "op" || open.op !== "(") throw new Unreadable("cmd", "for without a list");
    pos++;
    const items: Word[] = [];
    for (;;) {
      const next = tokens[pos];
      if (!next) throw new Unreadable("cmd", "for list without )");
      pos++;
      if (next.kind === "op" && next.op === ")") break;
      if (next.kind !== "word") throw new Unreadable("cmd", "for list");
      // items are separated by blanks, commas and semicolons (outside quotes)
      for (const item of cmdForItems(next.word)) items.push(item);
    }
    if (bareCmd(tokens[pos]) !== "do") throw new Unreadable("cmd", "for without do");
    pos++;
    const body = fork(state);
    const values = items.flatMap((item) => expandWord(item, state));
    const literal = !unknown && values.every((value) => value.parts.every((part) => part.kind !== "var" && part.kind !== "subst"));
    body.bound.set(variable, literal ? values : null);
    return statement(body);
  };

  const ifStatement = (state: WalkContext): H | null => {
    pos++;
    const word = () => { const t = tokens[pos]; if (t?.kind !== "word") throw new Unreadable("cmd", "if without a condition"); pos++; return t.word; };
    while (bareCmd(tokens[pos]) === "/i" || bareCmd(tokens[pos]) === "not") pos++;
    const lead = bareCmd(tokens[pos]);
    if (lead === "exist" || lead === "defined" || lead === "errorlevel" || lead === "cmdextversion") { pos++; word(); }
    else {
      const left = word();
      const next = bareCmd(tokens[pos]);
      if (next !== undefined && /^(==|equ|neq|lss|leq|gtr|geq)$/.test(next)) { pos++; word(); }
      else if (!renderCmdWord(left).includes("==")) throw new Unreadable("cmd", "if condition");
    }
    const hit = statement(fork(state));
    if (hit) return hit;
    if (bareCmd(tokens[pos]) === "else") { pos++; return statement(fork(state)); }
    return null;
  };

  const simple = (words: Word[], redirects: Array<{ op: string; target: Word }>, state: WalkContext, stdin?: Provenance): H | null => {
    for (const { op: redirectOp, target } of redirects) {
      if (redirectOp === "<" || !visitor.pwshRedirect) continue;
      const hit = visitor.pwshRedirect(target, candidatesOf(target, state), state);
      if (hit) return hit;
    }
    let rest = words;
    for (;;) {
      if (rest.length === 0) return null;
      const resolved = resolveName(rest[0]!);
      if (resolved === undefined) throw new Unreadable("dynamic-name", renderCmdWord(rest[0]!));
      const name = resolved.replace(/\.(exe|com|bat|cmd)$/, "");
      if (CMD_UNMODELED.has(name)) throw new Unreadable("cmd", name);
      if (name === "call") { rest = rest.slice(1); continue; }
      if (name === "start") {
        let i = 1;
        // a quoted first argument is the window title
        if (rest[i] && rest[i]!.parts[0]?.kind === "lit" && (rest[i]!.parts[0] as { quote: Quote }).quote === "double") i++;
        for (; i < rest.length; i++) {
          const option = (literalText(rest[i]!) ?? "").toLowerCase();
          if (START_FLAGS.has(option) || /^\/(node|affinity)$/.test(option)) { if (/^\/(node|affinity)$/.test(option)) i++; continue; }
          if (option === "/d") { i++; continue; }
          break;
        }
        rest = rest.slice(i);
        continue;
      }
      const args = rest.slice(1);
      if (CMDS.has(name) || POWERSHELLS.has(name)) {
        const pwsh = POWERSHELLS.has(name);
        const run = nestedProgram(name, args);
        // `-Command -`, `-File`, or nothing to run: its input or its script
        if (run.kind !== "text") return walkNestedInput(pwsh, run, stdin, state, visitor);
        const inner = run.words;
        // a `%i` reaches the inner cmd as written (an interactive line does
        // not expand it); `%NAME%` and `!NAME!` are values the outer one fills in
        if (inner.some((word) => !word.parts.every((part) => part.kind === "lit" || (part.kind === "var" && part.name.startsWith("%"))))) throw new Unreadable("expansion", `a value in text ${name} runs`);
        const innerText = inner.map(renderCmdWord).join(" ");
        const nested = fork(state, true);
        if (stdin) nested.stdin = stdin;
        return pwsh ? walkPwsh(innerText, nested, visitor) : walkCmd(innerText, nested, visitor);
      }
      const program = name === "rmdir" ? "rd" : name === "erase" ? "del" : name;
      // `bash -c …`, `python -c …`, `wsl …`: walked as the POSIX reader walks them
      // cmd's own delete commands take no piped paths, so nothing is appended
      const foreign = walkForeignExecutor(program, args, state, visitor, stdin);
      if (foreign !== undefined) return foreign;
      const spelled = literalText(rest[0]!);
      return visitor.command(simpleCommand(program, args.map((arg) => forItemWord(arg, state)), state, spelled !== undefined ? { program: { text: spelled, dialect: "windows" } } : {}), state);
    }
  };

  return list(ctx, false);
}

/** Which Windows reader this text is for: a cmdlet, a .NET call or
 * `powershell` is PowerShell; `cmd` is cmd; a name both shells have (`rd`,
 * `rmdir`, `del`, `erase`, `format`) is read under both. Null for text that
 * starts the way a POSIX shell's does. */
export function looksLikePowerShell(text: string): "pwsh" | "cmd" | "both" | null {
  // a static .NET call: `[IO.File]::WriteAllBytes(…)`
  if (/^\s*\[[A-Za-z][\w.]*\]::[A-Za-z]/.test(text)) return "pwsh";
  // `$x = …` opens PowerShell text; in a POSIX shell it would run `=…`
  if (/^\s*\$[A-Za-z_][\w:]*\s*=/.test(text)) return "pwsh";
  const match = /^\s*(?:&\s*)?([A-Za-z][\w.-]*)(?=[\s;|&]|$)/.exec(text);
  if (!match) return null;
  const first = match[1]!;
  if (/^[A-Z][a-z]+-[A-Z]/.test(first)) return "pwsh";
  const lower = first.toLowerCase();
  if (POWERSHELLS.has(lower)) return "pwsh";
  if (CMDS.has(lower)) return "cmd";
  if (["rd", "rmdir", "del", "erase", "format", "format.com"].includes(lower)) return "both";
  return ["format-volume", "clear-disk", "initialize-disk", "remove-item", "ri", "set-location"].includes(lower) ? "pwsh" : null;
}
