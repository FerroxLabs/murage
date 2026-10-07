// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B1 (review fix round 1): "low" is an ALLOWLIST outcome. A shell command is
// low only when this file can positively establish it as read-only:
//   - it parses (quotes close, nothing it does not understand);
//   - its commands are joined only by ; && || | and newline;
//   - there are no redirects at all, no command or process
//     substitution, no backgrounding, no here-documents, no grouping;
//   - every command word is plain (no quote, backslash or expansion inside
//     it) and is on the list below, with argument limits where that command
//     can write or run something.
// Anything else, including every interpreter, a script run by name, source,
// wrappers (env, nice, timeout, xargs...) and odd quoting, is NOT read-only,
// and the caller rates it risky. A parse failure is not read-only either.
// One pass, linear in the text; no backtracking patterns.

interface Word { text: string; bare: boolean; dyn: boolean }

/** Words per command, or null when the line cannot be read as simple commands. */
function parse(text: string): Word[][] | null {
  const commands: Word[][] = [];
  let words: Word[] = [];
  let buf = "";
  let inWord = false;
  let bare = true;
  // dyn: the shell would expand this word (unquoted glob, brace, tilde, or any $)
  let dyn = false;
  const endWord = () => { if (inWord) words.push({ text: buf, bare, dyn }); buf = ""; inWord = false; bare = true; dyn = false; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  const n = text.length;
  for (let i = 0; i < n; i += 1) {
    const c = text[i]!;
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) return null;
      buf += text.slice(i + 1, close); inWord = true; bare = false; i = close; continue;
    }
    if (c === "\"") {
      let j = i + 1;
      for (; j < n && text[j] !== "\""; j += 1) {
        const d = text[j]!;
        if (d === "`") return null;
        if (d === "$") { if (text[j + 1] === "(" || text[j + 1] === "{") return null; dyn = true; }
        if (d === "\\") { j += 1; if (j >= n) return null; buf += text[j]; continue; }
        buf += d;
      }
      if (j >= n) return null;
      inWord = true; bare = false; i = j; continue;
    }
    if (c === "\\") return null;
    if (c === "`" || c === "<" || c === "(" || c === ")" || c === "{" || c === "}" || c === "#" && !inWord) return null;
    // control characters are a parser-versus-shell mismatch (bash keeps CR in a word): refuse
    // any line break (LF, CR, VT, FF, NEL, LS, PS) or control character: a multi-line command is never low
    if (c === "\n" || c === "\r" || c === "\0" || c === "\u0085" || c === "\u2028" || c === "\u2029" || (c < " " && c !== "\t")) return null;
    if (c === " " || c === "\t") { endWord(); continue; }
    if (c === ";") { endCommand(); continue; }
    if (c === "|") { if (text[i + 1] === "&") return null; if (text[i + 1] === "|") i += 1; endCommand(); continue; }
    if (c === "&") {
      if (text[i + 1] === "&") { i += 1; endCommand(); continue; }
      if (text[i + 1] !== ">") return null; // backgrounding
    }
    if (c === ">" || c === "&") {
      // a redirect: [fd]> or &> , to /dev/null or to an fd (>&1, 2>&1)
      let j = c === "&" ? i + 1 : i;
      if (text[j + 1] === ">") return null; // >> appends
      j += 1;
      if (text[j] === "&") {
        j += 1;
        let k = j;
        while (k < n && text[k] >= "0" && text[k] <= "9") k += 1;
        if (k === j) return null;
        // the fd digits typed before `>` are part of the redirect, not a word
        if (inWord && /^[0-9]+$/.test(buf)) { buf = ""; inWord = false; bare = true; } else endWord();
        i = k - 1; continue;
      }
      while (j < n && (text[j] === " " || text[j] === "\t")) j += 1;
      let k = j;
      while (k < n && !" \t\n\r;&|<>()".includes(text[k]!)) k += 1;
      if (text.slice(j, k) !== "/dev/null") return null;
      if (inWord && /^[0-9]+$/.test(buf)) { buf = ""; inWord = false; bare = true; } else endWord();
      i = k - 1; continue;
    }
    if (c === "$") {
      const d = text[i + 1] ?? "";
      if (d === "(" || d === "{" || d === "'" || d === "\"") return null;
      bare = false; dyn = true;
    }
    if (c === "~" || c === "*" || c === "?" || c === "[" || c === "]") dyn = true;
    if (c === "~" || c === "=" || c === "*" || c === "?" || c === "[" || c === "!") bare = false;
    buf += c; inWord = true;
  }
  endCommand();
  return commands;
}

/** Whether an argument word carries no expansion the shell could use to
 *  smuggle an option past the checks below. */
const literal = (w: Word) => !w.dyn;

/** What a command may be given. Every option must match EXACTLY: a short
 *  letter in `flags` (a cluster is fine only if every letter is), a long name
 *  in `long`, or a value-taking option in `valued`/`valuedLong`. An abbreviated
 *  long option, an unknown option, or an option-like word after `--` is not
 *  recognised, so the command is not read-only. */
interface Spec {
  flags?: string;
  long?: string[];
  valued?: string;
  valuedLong?: string[];
  /** `-20` style counts (head, tail). */
  digits?: boolean;
  /** Most operands, when bounded. */
  max?: number;
}

/** The operands left after the options (null when an option is not allowed),
 *  and whether a pattern was given by option (grep/rg -e, --regexp). */
interface Matched { operands: string[]; patternByOption: boolean }
function matches(args: Word[], spec: Spec): Matched | null {
  const flags = spec.flags ?? "", valued = spec.valued ?? "";
  const long = new Set(spec.long ?? []), valuedLong = new Set(spec.valuedLong ?? []);
  const operands: string[] = [];
  let patternByOption = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (!literal(a)) return null;
    const t = a.text;
    if (t === "--") {
      for (const rest of args.slice(i + 1)) { if (!literal(rest) || rest.text.startsWith("-")) return null; operands.push(rest.text); }
      break;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t.slice(2) : t.slice(2, eq);
      if (valuedLong.has(name)) {
        if (name === "regexp") patternByOption = true;
        if (eq === -1) { i += 1; if (i >= args.length || !literal(args[i]!)) return null; }
        continue;
      }
      if (long.has(name) && eq === -1) continue;
      return null;
    }
    if (t.startsWith("-") && t.length > 1) {
      if (spec.digits && /^-[0-9]+$/.test(t)) continue;
      let consumed = false;
      for (let k = 1; k < t.length && !consumed; k += 1) {
        const letter = t[k]!;
        if (valued.includes(letter)) {
          consumed = true;
          if (letter === "e") patternByOption = true;
          if (k === t.length - 1) { i += 1; if (i >= args.length || !literal(args[i]!)) return null; }
        } else if (!flags.includes(letter)) return null;
      }
      continue;
    }
    operands.push(t);
  }
  return spec.max === undefined || operands.length <= spec.max ? { operands, patternByOption } : null;
}

const SPECS: Record<string, Spec> = {
  ls: { flags: "aAlhtrSR1dFGiknspcuf", long: ["all", "almost-all", "human-readable", "recursive", "reverse", "size", "directory", "classify"] },
  cat: { flags: "nbsTEvAetu", long: ["number", "number-nonblank", "squeeze-blank", "show-all"] },
  head: { flags: "qv", valued: "nc", valuedLong: ["lines", "bytes"], digits: true },
  tail: { flags: "qv", valued: "nc", valuedLong: ["lines", "bytes"], digits: true },
  wc: { flags: "lwcmL", long: ["lines", "words", "bytes", "chars"] },
  pwd: { flags: "LP", max: 0 },
  echo: { flags: "neE" },
  stat: { flags: "xs" },
  du: { flags: "hskmcax", valued: "d", valuedLong: ["max-depth"], long: ["human-readable", "summarize"] },
  df: { flags: "hkmiTPa", long: ["human-readable"] },
  which: { flags: "as" },
  tree: { flags: "adfiFCNL", valued: "L", long: ["noreport", "dirsfirst"] },
  grep: {
    flags: "ivnclLwxrEFHhoqsaI", valued: "emABC",
    long: ["ignore-case", "invert-match", "line-number", "count", "files-with-matches", "files-without-match", "word-regexp", "line-regexp", "recursive", "extended-regexp", "fixed-strings", "with-filename", "no-filename", "only-matching", "quiet", "no-messages", "text"],
    valuedLong: ["max-count", "after-context", "before-context", "context", "regexp"],
  },
  rg: {
    flags: "inlcwxFvsSuHhoq", valued: "etTmABCg",
    long: ["hidden", "no-ignore", "files", "count", "files-with-matches", "line-number", "ignore-case", "fixed-strings", "word-regexp", "smart-case", "no-heading", "heading", "only-matching", "quiet"],
    valuedLong: ["max-count", "type", "regexp", "glob", "after-context", "before-context", "context", "max-depth"],
  },
};

/** What one command reads: the path operands it names (null when it is not
 *  read-only at all) and whether it touches the file system (its cwd or a path). */
interface Reads { paths: string[]; fs: boolean }

/** printf takes no options, and no %n. */
function printfReads(args: Word[]): Reads | null {
  return args.every((a) => literal(a) && !a.text.startsWith("-") && !a.text.includes("%n")) ? { paths: [], fs: false } : null;
}

const SED_SCRIPT = /^(?:[0-9]+|\$|[0-9]+,[0-9]+|[0-9]+,\$)?(?:[pdq=]|s\/[^/\;]*\/[^/\;]*\/[gpiI0-9]*)$/;
function sedReads(args: Word[]): Reads | null {
  if (!args.every(literal)) return null;
  const flags = args.filter((a) => a.text.startsWith("-"));
  if (!flags.every((f) => ["-n", "-E", "-r", "-s"].includes(f.text))) return null;
  const pos = args.filter((a) => !a.text.startsWith("-"));
  if (pos.length < 1 || !SED_SCRIPT.test(pos[0]!.text)) return null;
  return { paths: pos.slice(1).map((w) => w.text), fs: true };
}

/** find: paths, then only these tests and print; nothing that executes or writes. */
function findReads(args: Word[]): Reads | null {
  const valued = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth"]);
  const bare = new Set(["-print", "-print0", "-o", "-a"]);
  const paths: string[] = [];
  let expression = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (!literal(a)) return null;
    if (a.text.startsWith("-")) {
      expression = true;
      if (valued.has(a.text)) { i += 1; if (i >= args.length || !literal(args[i]!)) return null; continue; }
      if (bare.has(a.text)) continue;
      return null;
    }
    if (expression) return null; // an operand after the expression (a `!` or `(` form): not read
    paths.push(a.text);
  }
  return { paths, fs: true };
}

/** Any `..` component: never folded textually (a symlink before it would make
 *  the fold wrong), so the command is not read-only. */
const hasDotDot = (operand: string) => operand.split("/").includes("..");

function commandReads(words: Word[]): Reads | null {
  const head = words[0]!;
  if (!head.bare) return null;
  const name = head.text;
  if (!/^[a-z][a-z0-9._+-]*$/i.test(name)) return null; // a path, an assignment, an operator word: not on the list
  const args = words.slice(1);
  switch (name) {
    case "printf": return printfReads(args);
    case "sed": return sedReads(args);
    case "find": return findReads(args);
    case "echo": { const m = matches(args, SPECS.echo!); return m ? { paths: [], fs: false } : null; }
    case "which": { const m = matches(args, SPECS.which!); return m ? { paths: [], fs: false } : null; }
    default: {
      const spec = Object.hasOwn(SPECS, name) ? SPECS[name] : undefined;
      const m = spec ? matches(args, spec) : null;
      if (!m) return null;
      let paths = m.operands;
      // grep and rg: the first operand is the pattern unless -e/--regexp gave it (rg --files has none)
      if ((name === "grep" || name === "rg") && !m.patternByOption && !args.some((a) => a.text === "--files")) paths = paths.slice(1);
      return { paths: paths, fs: true };
    }
  }
}

/** A character-level gate that runs BEFORE any parsing (round 5). The parser
 *  below reads shell syntax, and four bypasses came from what it did not model,
 *  so low starts with the text itself being plain: ASCII letters, digits, space
 *  and `. / - _ , : @ + =`, quotes only as balanced pairs, and the separators
 *  `|` `;` `&&` `||`. Everything else, even inside quotes, is risky: `> < $ `
 *  ( ) { } [ ] * ? ~ ! # % ^ \ &` (but `&&`), any whitespace but a plain space,
 *  non-ASCII, NUL. A word starting with `=` is risky (zsh `=cmd`). */
function plainText(text: string): boolean {
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    const code = c.charCodeAt(0);
    if (code > 126 || code < 32) return false;
    if (quote) { if (c === quote) { quote = ""; continue; } }
    else if (c === "'" || c === "\"") { quote = c; continue; }
    if (c === "&") { if (quote || text[i + 1] !== "&") return false; i += 1; continue; }
    if (c === "|" || c === ";") continue;
    if (c === " ") continue;
    // `=` must follow a letter, digit or `-` (not a quote, space or separator): zsh `=cmd`, `""=ls`
    if (c === "=" && !/[A-Za-z0-9-]/.test(text[i - 1] ?? " ")) return false;
    if (!/[A-Za-z0-9.\/\-_,:@+=]/.test(c)) return false;
  }
  return quote === "";
}

/** True only when the whole line is positively read-only AND everything it
 *  reads is inside the workspace: the cwd and every path operand. One line only,
 *  no `cd`, no `..` component anywhere. `inside` is the caller's real workspace
 *  read check (it resolves symlinks); absent means risky. Never throws. */
export function isReadOnlyCommand(text: string, inside?: (path: string) => boolean): boolean {
  try {
    if (!plainText(text)) return false;
    const commands = parse(text);
    if (!commands || commands.length === 0) return false;
    for (const words of commands) {
      const reads = commandReads(words);
      if (!reads) return false;
      if (!reads.fs) continue;
      // relative paths are the engine's own cwd's; nothing here changes it (no cd)
      if (!inside || !inside(".")) return false;
      for (const operand of reads.paths) {
        if (hasDotDot(operand) || !inside(operand)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** The commands that can be low, for tests and docs. */
export const LOW_COMMANDS: readonly string[] = [...Object.keys(SPECS), "printf", "sed", "find"];
