// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A strict reader for one narrow kind of shell command: a pipeline of
// read-only programs (cat, head, tail, wc, grep, jq, python -c) that reads
// named files and prints to stdout. It answers with the file paths the
// command reads, or `undefined` for anything it does not fully understand.
//
// What it is for: an engine that saves a large tool result to a file (Fuigo's
// `<session>/mcp/call_00_<id>.json`, Claude's `<session>/tool-results/`) tells
// its model to query that file with `cat … | python3 -c …` or `jq`. Those
// reads are the bot reading its OWN output, so server/own-tool-results.ts
// answers them without a card, but only when this parser accepts the command
// AND every path it returns is inside the turn's own result folder.
//
// The rule is "understood or refused", and for the two languages in the
// pipeline (python, jq) "understood" means ALLOW-LISTED: a script passes only
// when every token of it is one this file has decided is harmless. A denylist
// of dangerous names was bypassed twice in review (rc13: `sys.argv`
// reassignment; then `type(sys.stdin.buffer.raw)(path)`, a CR hiding code
// after a `#`, and jq's `"\(env)"`), because a Turing-complete language always
// has one more door. Now:
//   - the whole command refuses any control character but LF and TAB;
//   - no `;`, `&`, `&&`, `||`, newline, `$`, backtick, `(`, `)`, `{`, `}`,
//     globs, `~`, `#`, `!`, `@`, `^` outside quotes; no `$` or backtick inside
//     double quotes; the only redirections are `2>/dev/null` and `2>&1`;
//   - programs are bare names from a short allow-list, each with an
//     allow-list of options (no `tail -f`, no `grep -f`, no `jq -f`);
//   - `python -c` reads STDIN ONLY and takes no argument after the script. The
//     script is printable ASCII + LF, is tokenized, and every identifier must
//     be a listed keyword, a listed pure builtin, a listed module used only as
//     `module.listed_attribute`, a listed method name after a `.`, or a local
//     the script itself binds (never a Python builtin name). See
//     safePythonScript below for the lists.
//   - `jq` takes `-r -c -M -S --arg name literal` only, and a filter whose
//     every word, variable, format and string escape is listed (no `env`,
//     `$ENV`, `input`, `import`, `\(` interpolation, `@sh`).
// Every file a command reads is a literal word of cat/head/tail/wc/grep/jq,
// and the caller checks each one. Shared (no Node imports) so the approval
// card can also say such a command in plain words ("read call_00_x.json").

export interface ReadOnlyCommand {
  /** Every file path the command reads, in order. Never empty. */
  paths: string[];
  /** The programs in the pipeline, in order. */
  programs: string[];
}

type Word = { text: string; quoted: boolean };

/** Characters that must never appear outside quotes. `|` and `>` are handled
 * by the tokenizer itself. */
const UNQUOTED_FORBIDDEN = new Set([";", "&", "$", "`", "(", ")", "{", "}", "*", "?", "[", "]", "~", "#", "!", "@", "^", "<", "\n", "\r"]);

/** Split one command line into pipeline stages of words, or undefined. */
function tokenize(command: string): Word[][] | undefined {
  const stages: Word[][] = [[]];
  let word = "";
  let inWord = false;
  let quoted = false;
  const end = () => {
    if (inWord) stages[stages.length - 1]!.push({ text: word, quoted });
    word = ""; inWord = false; quoted = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === " " || ch === "\t") { end(); continue; }
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return undefined;
      word += command.slice(i + 1, close);
      inWord = true; quoted = true; i = close; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = "";
      for (; j < command.length; j++) {
        const c = command[j]!;
        if (c === '"') break;
        if (c === "$" || c === "`") return undefined;
        if (c === "\\") {
          const next = command[j + 1];
          if (next === undefined) return undefined;
          if (next === '"' || next === "\\" || next === "$" || next === "`") { text += next; j++; continue; }
          if (next === "\n") return undefined;
          text += c; continue;
        }
        text += c;
      }
      if (j >= command.length) return undefined;
      word += text; inWord = true; quoted = true; i = j; continue;
    }
    if (ch === "\\") {
      const next = command[i + 1];
      if (next === undefined || next === "\n" || next === "\r") return undefined;
      word += next; inWord = true; quoted = true; i++; continue;
    }
    if (ch === "|") {
      if (command[i + 1] === "|" || command[i + 1] === "&") return undefined;
      end();
      if (!stages[stages.length - 1]!.length) return undefined;
      stages.push([]);
      continue;
    }
    if (ch === ">") {
      // Only `2>/dev/null` and `2>&1`: the stream number must be the whole word so far.
      if (!(inWord && !quoted && word === "2")) return undefined;
      const rest = command.slice(i + 1);
      const target = /^(\s*\/dev\/null|&1)(?=$|[ \t|])/.exec(rest);
      if (!target) return undefined;
      word = ""; inWord = false; quoted = false;
      i += target[0].length;
      continue;
    }
    if (UNQUOTED_FORBIDDEN.has(ch)) return undefined;
    word += ch; inWord = true;
  }
  end();
  if (stages.some((stage) => stage.length === 0)) return undefined;
  return stages;
}

const NUMBER = /^\+?\d{1,9}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Printable ASCII and LF: the only characters a script or filter may hold. */
function printableAsciiLf(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 0x0a && (code < 0x20 || code > 0x7e)) return false;
  }
  return true;
}

type StageResult = { paths: string[] } | undefined;

function catStage(args: Word[]): StageResult {
  const paths: string[] = [];
  for (const arg of args) {
    if (!arg.quoted && /^-[nAbesTvEtu]+$/.test(arg.text)) continue;
    if (arg.text.startsWith("-")) return undefined;
    paths.push(arg.text);
  }
  return { paths };
}

function headTailStage(args: Word[], program: "head" | "tail"): StageResult {
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text;
    if (/^-[nc]$/.test(text)) {
      const value = args[++i]?.text;
      if (value === undefined || !(NUMBER.test(value) || (program === "tail" && /^\+\d{1,9}$/.test(value)) || (program === "head" && /^-\d{1,9}$/.test(value)))) return undefined;
      continue;
    }
    if (/^-[nc]\+?\d{1,9}$/.test(text) || /^-\d{1,9}$/.test(text) || /^--(lines|bytes)=\+?\d{1,9}$/.test(text) || text === "-q" || text === "-v") continue;
    if (text.startsWith("-")) return undefined;
    paths.push(text);
  }
  return { paths };
}

function wcStage(args: Word[]): StageResult {
  const paths: string[] = [];
  for (const arg of args) {
    if (/^-[lwcmL]+$/.test(arg.text)) continue;
    if (arg.text.startsWith("-")) return undefined;
    paths.push(arg.text);
  }
  return { paths };
}

function grepStage(args: Word[]): StageResult {
  const paths: string[] = [];
  let pattern = false;
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text;
    if (text === "--") {
      const rest = args.slice(i + 1).map((arg) => arg.text);
      if (!pattern) { if (!rest.length) return undefined; pattern = true; rest.shift(); }
      paths.push(...rest);
      break;
    }
    if (text === "-e") { if (args[++i] === undefined) return undefined; pattern = true; continue; }
    if (/^-[mABC]$/.test(text)) { if (!NUMBER.test(args[++i]?.text ?? "")) return undefined; continue; }
    if (/^-[mABC]\d{1,9}$/.test(text)) continue;
    if (/^--color(=(never|auto|always))?$/.test(text)) continue;
    if (/^-[iInvcwxlLoEFHhsqab]+$/.test(text)) continue;
    if (text.startsWith("-")) return undefined;
    if (!pattern) { pattern = true; continue; }
    paths.push(text);
  }
  return pattern ? { paths } : undefined;
}

// ---- jq ------------------------------------------------------------------

/** Every bare word a filter may use. Absent on purpose: env, input, inputs,
 * debug, stderr, input_filename, input_line_number, import, include, getpath,
 * setpath, delpaths, modulemeta, get_search_list, halt, halt_error, error,
 * now, mktime, gmtime, localtime, strftime, strptime, todate, fromdate, date,
 * until, while, repeat, label, break, def, reduce, foreach, tostream,
 * fromstream, truncate_stream, splits, ltrimstr variants that read files. */
const JQ_WORDS = new Set([
  "if", "then", "elif", "else", "end", "as", "and", "or", "not", "try", "catch",
  "select", "map", "map_values", "keys", "keys_unsorted", "length", "utf8bytelength", "values", "has", "in", "inside", "contains",
  "startswith", "endswith", "ltrimstr", "rtrimstr", "trim", "ltrim", "rtrim", "split", "join",
  "ascii_downcase", "ascii_upcase", "tostring", "tonumber", "tojson", "fromjson", "type", "empty", "null", "true", "false",
  "first", "last", "nth", "limit", "reverse", "sort", "sort_by", "group_by", "unique", "unique_by", "min", "max", "min_by", "max_by",
  "add", "any", "all", "flatten", "range", "floor", "ceil", "round", "sqrt", "abs",
  "test", "match", "capture", "sub", "gsub", "ascii", "explode", "implode",
  "recurse", "paths", "leaf_paths", "path", "arrays", "objects", "iterables", "booleans", "numbers", "strings", "nulls", "scalars",
  "to_entries", "from_entries", "with_entries", "del", "indices", "index", "rindex", "walk", "transpose", "combinations",
  "isempty", "infinite", "nan", "isinfinite", "isnan", "isnormal", "pick", "toarray",
]);
const JQ_FORMATS = new Set(["json", "text", "csv", "tsv", "html", "uri", "base64", "base64d", "base32", "base32d"]);
const JQ_OPS = ["//=", "|=", "+=", "-=", "*=", "/=", "%=", "==", "!=", "<=", ">=", "//", "..", "|", ",", "(", ")", "[", "]", "{", "}", ":", ";", "?", "+", "-", "*", "/", "%", "<", ">", "=", "."];

type JqToken = { kind: "word" | "field" | "var" | "format" | "string" | "number" | "op"; text: string };

function tokenizeJq(filter: string): JqToken[] | undefined {
  const out: JqToken[] = [];
  for (let i = 0; i < filter.length;) {
    const ch = filter[i]!;
    if (ch === " " || ch === "\n") { i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      for (; j < filter.length && filter[j] !== '"'; j++) {
        if (filter[j] !== "\\") continue;
        const next = filter[j + 1];
        if (next === "u") { if (!/^[0-9a-fA-F]{4}$/.test(filter.slice(j + 2, j + 6))) return undefined; j += 5; continue; }
        // `\(` is string interpolation: code inside a string. Refused.
        if (next === undefined || !'"\\/bfnrt'.includes(next)) return undefined;
        j++;
      }
      if (j >= filter.length) return undefined;
      out.push({ kind: "string", text: filter.slice(i + 1, j) });
      i = j + 1; continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(filter.slice(i));
    if (ch === "$" || ch === "@") {
      const rest = /^[A-Za-z_][A-Za-z0-9_]*/.exec(filter.slice(i + 1));
      if (!rest) return undefined;
      out.push({ kind: ch === "$" ? "var" : "format", text: rest[0] });
      i += 1 + rest[0].length; continue;
    }
    if (ch === "." && /[A-Za-z_]/.test(filter[i + 1] ?? "")) {
      const rest = /^[A-Za-z_][A-Za-z0-9_]*/.exec(filter.slice(i + 1))!;
      out.push({ kind: "field", text: rest[0] });
      i += 1 + rest[0].length; continue;
    }
    if (name) { out.push({ kind: "word", text: name[0] }); i += name[0].length; continue; }
    const number = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(filter.slice(i));
    if (number) { out.push({ kind: "number", text: number[0] }); i += number[0].length; continue; }
    const op = JQ_OPS.find((candidate) => filter.startsWith(candidate, i));
    if (!op) return undefined;
    out.push({ kind: "op", text: op });
    i += op.length;
  }
  return out;
}

/** Is this jq filter made only of listed words, declared variables, listed
 * formats, plain strings and operators? `declared` are the `--arg` names. */
export function safeJqFilter(filter: string, declared: ReadonlySet<string> = new Set()): boolean {
  if (filter.length > 4000 || !printableAsciiLf(filter) || filter.includes("__")) return false;
  const tokens = tokenizeJq(filter);
  if (!tokens) return false;
  const bound = new Set(declared);
  // `… as $x`, `… as [$a, $b]`, `… as {k: $v}` bind the variables that follow.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word" || token.text !== "as") continue;
    const next = tokens[i + 1];
    if (next?.kind === "var") { bound.add(next.text); continue; }
    if (next?.kind !== "op" || (next.text !== "[" && next.text !== "{")) return false;
    let depth = 0;
    let j = i + 1;
    for (; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.kind === "op" && (t.text === "[" || t.text === "{")) depth++;
      else if (t.kind === "op" && (t.text === "]" || t.text === "}")) { depth--; if (depth === 0) break; }
      else if (t.kind === "var") bound.add(t.text);
    }
    if (depth !== 0) return false;
  }
  const stack: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "op" && "([{".includes(token.text)) stack.push(token.text);
    else if (token.kind === "op" && ")]}".includes(token.text)) stack.pop();
    if (token.kind === "format" && !JQ_FORMATS.has(token.text)) return false;
    if (token.kind === "var" && (!bound.has(token.text) || token.text === "ENV")) return false;
    if (token.kind !== "word" || JQ_WORDS.has(token.text)) continue;
    // `{id: .id}`: a key directly inside braces is data, not a function.
    const next = tokens[i + 1];
    if (stack[stack.length - 1] === "{" && next?.kind === "op" && next.text === ":") continue;
    return false;
  }
  return true;
}

function jqStage(args: Word[]): StageResult {
  const paths: string[] = [];
  const declared = new Set<string>();
  let filter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text;
    if (filter === undefined && text.startsWith("-")) {
      if (/^-[rcMS]+$/.test(text)) continue;
      if (/^--(raw-output|compact-output|monochrome-output|sort-keys)$/.test(text)) continue;
      if (text === "--arg") {
        const name = args[++i]?.text; const value = args[++i];
        if (!name || !IDENTIFIER.test(name) || name === "ENV" || name.startsWith("__") || value === undefined) return undefined;
        declared.add(name);
        continue;
      }
      return undefined;
    }
    if (filter === undefined) { filter = text; continue; }
    if (text.startsWith("-")) return undefined;
    paths.push(text);
  }
  if (filter === undefined || !safeJqFilter(filter, declared)) return undefined;
  return { paths };
}

// ---- python -c ------------------------------------------------------------

const PY_KEYWORDS = new Set([
  "for", "in", "if", "elif", "else", "and", "or", "not", "is", "None", "True", "False",
  "import", "from", "as", "lambda", "def", "return", "break", "continue", "pass", "try", "except",
]);

/** Pure builtins: data in, data out. No type, open, getattr, vars, dir, eval,
 * exec, compile, input, object, super, id, hash, callable, bytes. */
const PY_BUILTINS = new Set([
  "print", "len", "str", "int", "float", "bool", "list", "dict", "set", "tuple", "sorted", "reversed",
  "min", "max", "sum", "abs", "round", "any", "all", "enumerate", "range", "zip", "map", "filter",
  "isinstance", "repr", "iter", "next", "chr", "ord", "divmod", "format",
  "Exception", "KeyError", "ValueError", "IndexError", "TypeError", "AttributeError", "ZeroDivisionError", "StopIteration",
]);

/** The modules a script may import, each with the only attributes it may read. */
const PY_MODULES: Record<string, ReadonlySet<string>> = {
  json: new Set(["load", "loads", "dump", "dumps"]),
  sys: new Set(["stdin", "stdout", "stderr"]),
  re: new Set(["search", "match", "fullmatch", "findall", "finditer", "sub", "subn", "split", "compile", "escape", "I", "IGNORECASE", "M", "MULTILINE", "S", "DOTALL"]),
  collections: new Set(["Counter"]),
};

/** Method names on str, dict, list, match objects, Counter and stdin. */
const PY_METHODS = new Set([
  "get", "keys", "values", "items", "append", "extend", "insert", "pop", "index", "count", "sort", "reverse", "copy", "update", "setdefault",
  "join", "split", "rsplit", "splitlines", "strip", "lstrip", "rstrip", "lower", "upper", "title", "capitalize", "casefold",
  "startswith", "endswith", "replace", "format", "find", "rfind", "partition", "rpartition", "zfill", "ljust", "rjust", "center",
  "isdigit", "isalpha", "isalnum", "isspace", "isupper", "islower",
  "read", "readline", "readlines", "most_common", "elements", "total", "group", "groups", "groupdict", "span", "start", "end",
]);
const PY_ATTRS = new Set([...PY_METHODS, ...Object.values(PY_MODULES).flatMap((names) => [...names])]);

/** Every name Python's `builtins` module exposes (3.8–3.13). A local may never
 * take one of these names: `open = open` would bind the file opener. */
const PY_RESERVED = new Set([
  "ArithmeticError", "AssertionError", "AttributeError", "BaseException", "BaseExceptionGroup", "BlockingIOError", "BrokenPipeError",
  "BufferError", "BytesWarning", "ChildProcessError", "ConnectionAbortedError", "ConnectionError", "ConnectionRefusedError",
  "ConnectionResetError", "DeprecationWarning", "EOFError", "Ellipsis", "EncodingWarning", "EnvironmentError", "Exception",
  "ExceptionGroup", "False", "FileExistsError", "FileNotFoundError", "FloatingPointError", "FutureWarning", "GeneratorExit",
  "IOError", "ImportError", "ImportWarning", "IndentationError", "IndexError", "InterruptedError", "IsADirectoryError", "KeyError",
  "KeyboardInterrupt", "LookupError", "MemoryError", "ModuleNotFoundError", "NameError", "None", "NotADirectoryError",
  "NotImplemented", "NotImplementedError", "OSError", "OverflowError", "PendingDeprecationWarning", "PermissionError",
  "ProcessLookupError", "PythonFinalizationError", "RecursionError", "ReferenceError", "ResourceWarning", "RuntimeError",
  "RuntimeWarning", "StopAsyncIteration", "StopIteration", "SyntaxError", "SyntaxWarning", "SystemError", "SystemExit", "TabError",
  "TimeoutError", "True", "TypeError", "UnboundLocalError", "UnicodeDecodeError", "UnicodeEncodeError", "UnicodeError",
  "UnicodeTranslateError", "UnicodeWarning", "UserWarning", "ValueError", "Warning", "WindowsError", "ZeroDivisionError",
  "abs", "aiter", "all", "anext", "any", "ascii", "bin", "bool", "breakpoint", "bytearray", "bytes", "callable", "chr",
  "classmethod", "compile", "complex", "copyright", "credits", "delattr", "dict", "dir", "divmod", "enumerate", "eval", "exec",
  "exit", "filter", "float", "format", "frozenset", "getattr", "globals", "hasattr", "hash", "help", "hex", "id", "input", "int",
  "isinstance", "issubclass", "iter", "len", "license", "list", "locals", "map", "max", "memoryview", "min", "next", "object",
  "oct", "open", "ord", "pow", "print", "property", "quit", "range", "repr", "reversed", "round", "set", "setattr", "slice",
  "sorted", "staticmethod", "str", "sum", "super", "tuple", "type", "vars", "zip", "_",
]);

type PyToken = { kind: "name" | "number" | "string" | "op" | "newline"; text: string; prefix?: string; body?: string };

/** Longest first, so `**=` is found before `**` before `*`. No `@`, `->`, `!`, `\`. */
const PY_OPS = [
  "**=", "//=", ">>=", "<<=",
  ":=", "**", "//", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>",
  "+", "-", "*", "/", "%", "<", ">", "=", "(", ")", "[", "]", "{", "}", ",", ":", ".", ";", "~", "&", "|", "^",
];
const PY_ASSIGN = new Set(["=", "+=", "-=", "*=", "/=", "//=", "%=", "**=", "&=", "|=", "^=", "<<=", ">>="]);
const PY_NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?[jJ]?|\.\d[\d_]*(?:[eE][+-]?\d+)?[jJ]?)/;
const PY_PREFIX = /^(?:r|u|b|f|rb|br|fr|rf)$/i;

function readPythonString(script: string, at: number, prefix: string): { token: PyToken; end: number } | undefined {
  const q = script[at]!;
  const triple = script.startsWith(q.repeat(3), at);
  const quote = triple ? q.repeat(3) : q;
  let j = at + quote.length;
  const start = j;
  for (;;) {
    if (j >= script.length) return undefined;
    if (script.startsWith(quote, j)) break;
    const c = script[j]!;
    if (c === "\\") { j += 2; continue; }
    if (c === "\n" && !triple) return undefined;
    j++;
  }
  return { token: { kind: "string", text: script.slice(at, j + quote.length), prefix, body: script.slice(start, j) }, end: j + quote.length };
}

/** Names, numbers, strings, operators and newlines, or undefined for anything else. */
function tokenizePython(script: string): PyToken[] | undefined {
  const out: PyToken[] = [];
  for (let i = 0; i < script.length;) {
    const ch = script[i]!;
    if (ch === " ") { i++; continue; }
    if (ch === "\n") { out.push({ kind: "newline", text: "\n" }); i++; continue; }
    if (ch === "#") { const nl = script.indexOf("\n", i); i = nl < 0 ? script.length : nl; continue; }
    if (ch === "'" || ch === '"') {
      const found = readPythonString(script, i, "");
      if (!found) return undefined;
      out.push(found.token); i = found.end; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < script.length && /[A-Za-z0-9_]/.test(script[j]!)) j++;
      const name = script.slice(i, j);
      const q = script[j];
      if (q === "'" || q === '"') {
        if (!PY_PREFIX.test(name)) return undefined;
        const found = readPythonString(script, j, name.toLowerCase());
        if (!found) return undefined;
        out.push(found.token); i = found.end; continue;
      }
      out.push({ kind: "name", text: name }); i = j; continue;
    }
    if (/\d/.test(ch) || (ch === "." && /\d/.test(script[i + 1] ?? ""))) {
      const m = PY_NUMBER.exec(script.slice(i));
      if (!m) return undefined;
      const j = i + m[0].length;
      // `1if x else 2` and `1.real` are Python; our number boundary must be Python's, so neither is read.
      if (/[A-Za-z_.]/.test(script[j] ?? "")) return undefined;
      out.push({ kind: "number", text: m[0] }); i = j; continue;
    }
    const op = PY_OPS.find((candidate) => script.startsWith(candidate, i));
    if (!op) return undefined;
    out.push({ kind: "op", text: op });
    i += op.length;
  }
  return out;
}

/** The expression inside each `{…}` of an f-string body (format specs
 * recurse; conversions `!r|s|a` are dropped), or undefined. */
function fStringExpressions(body: string, depth: number): string[] | undefined {
  if (depth > 3) return undefined;
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "}") { if (body[i + 1] === "}") { i++; continue; } return undefined; }
    if (ch !== "{") continue;
    if (body[i + 1] === "{") { i++; continue; }
    let nested = 1;
    let j = i + 1;
    while (j < body.length && nested > 0) {
      const c = body[j]!;
      if (c === "\\" || c === "#") return undefined;
      if (c === "'" || c === '"') {
        let k = j + 1;
        while (k < body.length && body[k] !== c) { if (body[k] === "\\") return undefined; k++; }
        if (k >= body.length) return undefined;
        j = k + 1; continue;
      }
      if (c === "{") nested++;
      else if (c === "}") nested--;
      j++;
    }
    if (nested !== 0) return undefined;
    const inner = body.slice(i + 1, j - 1);
    // Split expression / conversion / format spec at the top level.
    let level = 0;
    let cut = inner.length;
    for (let k = 0; k < inner.length; k++) {
      const c = inner[k]!;
      if (c === "'" || c === '"') { k = inner.indexOf(c, k + 1); if (k < 0) return undefined; continue; }
      if ("([{".includes(c)) level++;
      else if (")]}".includes(c)) level--;
      else if (level === 0 && c === "!" && inner[k + 1] !== "=") { cut = k; break; }
      else if (level === 0 && c === ":" ) { cut = k; break; }
    }
    const expression = inner.slice(0, cut);
    let rest = inner.slice(cut);
    if (rest.startsWith("!")) {
      if (!/^![rsa](?=:|$)/.test(rest)) return undefined;
      rest = rest.slice(2);
    }
    if (rest.startsWith(":")) {
      const spec = fStringExpressions(rest.slice(1), depth + 1);
      if (!spec) return undefined;
      out.push(...spec);
    }
    if (!expression.trim()) return undefined;
    out.push(expression);
    i = j - 1;
  }
  return out;
}

/** `str.format` fields may be `{}`, `{name}` or `{0}` with `!r` and a flat
 * spec: no attribute (`{0.real}`), no index (`{0[x]}`), no nesting. */
function flatFormatFields(body: string): boolean {
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "}") { if (body[i + 1] === "}") { i++; continue; } return false; }
    if (ch !== "{") continue;
    if (body[i + 1] === "{") { i++; continue; }
    const close = body.indexOf("}", i);
    if (close < 0 || !/^[A-Za-z0-9_]*(?:![rsa])?(?::[^{}]*)?$/.test(body.slice(i + 1, close))) return false;
    i = close;
  }
  return true;
}

type PyUnit = { tokens: PyToken[]; depth: number[]; open: (string | null)[] };

/** Bracket depth before each token and the innermost open bracket, or undefined when unbalanced. */
function annotate(tokens: PyToken[]): PyUnit | undefined {
  const stack: string[] = [];
  const depth: number[] = [];
  const open: (string | null)[] = [];
  for (const token of tokens) {
    // A closing bracket sits at its opener's depth, so `closing()` finds it.
    if (token.kind === "op" && ")]}".includes(token.text)) {
      const expected = { ")": "(", "]": "[", "}": "{" }[token.text];
      if (stack.pop() !== expected) return undefined;
    }
    depth.push(stack.length);
    open.push(stack[stack.length - 1] ?? null);
    if (token.kind === "op" && "([{".includes(token.text)) stack.push(token.text);
  }
  return stack.length ? undefined : { tokens, depth, open };
}

/** The index of the bracket closing the one at `at`. */
function closing(unit: PyUnit, at: number): number | undefined {
  for (let i = at + 1; i < unit.tokens.length; i++) if (unit.depth[i] === unit.depth[at]) return i;
  return undefined;
}

/** The script and every f-string expression in it, each tokenized. */
function pythonUnits(script: string, depth = 0): PyUnit[] | undefined {
  if (depth > 3) return undefined;
  const tokens = tokenizePython(script);
  if (!tokens) return undefined;
  const unit = annotate(tokens);
  if (!unit) return undefined;
  const units = [unit];
  for (const token of tokens) {
    if (token.kind !== "string" || !token.prefix!.includes("f")) continue;
    const expressions = fStringExpressions(token.body!, 0);
    if (!expressions) return undefined;
    for (const expression of expressions) {
      const inner = pythonUnits(expression, depth + 1);
      if (!inner) return undefined;
      units.push(...inner);
    }
  }
  return units;
}

/** The names a unit binds: assignment targets, loop targets, `as`, def/lambda
 * names and parameters, keyword arguments. False when a target is an attribute. */
function pythonBindings(unit: PyUnit, bound: Set<string>): boolean {
  const { tokens, depth, open } = unit;
  const targets = (from: number, to: number): boolean => {
    for (let k = from; k < to; k++) {
      const token = tokens[k]!;
      if (token.kind === "op" && "([{".includes(token.text)) {
        const close = closing(unit, k);
        if (close === undefined || close >= to) return false;
        const before = k > from ? tokens[k - 1] : undefined;
        const callOrIndex = before !== undefined && (before.kind === "name" || before.kind === "string" || (before.kind === "op" && ")]".includes(before.text)));
        if (!callOrIndex && !targets(k + 1, close)) return false;
        k = close;
        continue;
      }
      if (token.kind !== "name" || PY_KEYWORDS.has(token.text)) continue;
      const before = tokens[k - 1];
      if (before?.kind === "op" && before.text === ".") return false;
      const after = tokens[k + 1];
      if (after?.kind === "op" && (after.text === "(" || after.text === "[")) continue;
      bound.add(token.text);
    }
    return true;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "op" && PY_ASSIGN.has(token.text)) {
      const enclosing = open[i];
      if (enclosing === "(") {
        // keyword argument or parameter default: `name=`
        const before = tokens[i - 1];
        if (token.text !== "=" || before?.kind !== "name") return false;
        if (tokens[i - 2]?.kind === "op" && tokens[i - 2]!.text === ".") return false;
        bound.add(before.text);
        continue;
      }
      if (enclosing !== null) return false;
      let s = i - 1;
      for (; s >= 0; s--) {
        const u = tokens[s]!;
        if (depth[s] !== 0) continue;
        if (u.kind === "newline" || (u.kind === "op" && (u.text === ";" || u.text === ":" || PY_ASSIGN.has(u.text)))) break;
      }
      if (!targets(s + 1, i)) return false;
      continue;
    }
    if (token.kind === "op" && token.text === ":=") {
      const before = tokens[i - 1];
      if (before?.kind !== "name" || (tokens[i - 2]?.kind === "op" && tokens[i - 2]!.text === ".")) return false;
      bound.add(before.text);
      continue;
    }
    if (token.kind !== "name") continue;
    if (token.text === "for") {
      let j = i + 1;
      for (; j < tokens.length; j++) if (tokens[j]!.kind === "name" && tokens[j]!.text === "in" && depth[j] === depth[i]) break;
      if (j >= tokens.length || !targets(i + 1, j)) return false;
    } else if (token.text === "as") {
      const next = tokens[i + 1];
      if (next?.kind !== "name") return false;
      bound.add(next.text);
    } else if (token.text === "def") {
      const name = tokens[i + 1];
      const paren = tokens[i + 2];
      if (name?.kind !== "name" || paren?.kind !== "op" || paren.text !== "(") return false;
      const close = closing(unit, i + 2);
      if (close === undefined || !targets(i + 3, close)) return false;
      bound.add(name.text);
    } else if (token.text === "lambda") {
      let j = i + 1;
      for (; j < tokens.length; j++) if (tokens[j]!.kind === "op" && tokens[j]!.text === ":" && depth[j] === depth[i]) break;
      if (j >= tokens.length || !targets(i + 1, j)) return false;
    }
  }
  return true;
}

/** Import statements: `import M, M` or `from M import N, N`, whole statements
 * only. Returns the token indexes they cover, adding `from` names to bound. */
function pythonImports(unit: PyUnit, bound: Set<string>): Set<number> | undefined {
  const { tokens, depth } = unit;
  const covered = new Set<number>();
  let start = 0;
  for (let i = 0; i <= tokens.length; i++) {
    const token = tokens[i];
    const boundary = token === undefined || (depth[i] === 0 && (token.kind === "newline" || (token.kind === "op" && token.text === ";")));
    if (!boundary) continue;
    const statement = tokens.slice(start, i);
    const head = statement[0];
    if (head?.kind === "name" && (head.text === "import" || head.text === "from")) {
      const names = (from: number): string[] | undefined => {
        const out: string[] = [];
        for (let k = from; k < statement.length; k += 2) {
          const name = statement[k];
          const comma = statement[k + 1];
          if (name?.kind !== "name") return undefined;
          out.push(name.text);
          if (comma === undefined) break;
          if (comma.kind !== "op" || comma.text !== "," || statement[k + 2] === undefined) return undefined;
        }
        return out;
      };
      if (head.text === "import") {
        const modules = names(1);
        if (!modules?.length || !modules.every((m) => Object.hasOwn(PY_MODULES, m))) return undefined;
      } else {
        const module = statement[1];
        const keyword = statement[2];
        if (module?.kind !== "name" || !Object.hasOwn(PY_MODULES, module.text) || keyword?.kind !== "name" || keyword.text !== "import") return undefined;
        const allowed = PY_MODULES[module.text]!;
        const imported = names(3);
        if (!imported?.length || !imported.every((n) => allowed.has(n))) return undefined;
        for (const n of imported) bound.add(n);
      }
      for (let k = start; k < i; k++) covered.add(k);
    }
    start = i + 1;
  }
  return covered;
}

/** Every name token is a keyword, a pure builtin, `module.listed`, a listed
 * attribute, or a bound local that is not a Python builtin. */
function pythonNamesOk(unit: PyUnit, bound: ReadonlySet<string>, skip: ReadonlySet<number>): boolean {
  const { tokens } = unit;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "name" || skip.has(i)) continue;
    const before = tokens[i - 1];
    const after = tokens[i + 1];
    const assigning = after?.kind === "op" && (PY_ASSIGN.has(after.text) || after.text === ":=");
    if (before?.kind === "op" && before.text === ".") {
      if (!PY_ATTRS.has(token.text) || assigning) return false;
      continue;
    }
    if (token.text === "import" || token.text === "from") return false;
    if (PY_KEYWORDS.has(token.text)) { if (assigning) return false; continue; }
    if (Object.hasOwn(PY_MODULES, token.text)) {
      const attribute = tokens[i + 2];
      if (assigning || after?.kind !== "op" || after.text !== "." || attribute?.kind !== "name" || !PY_MODULES[token.text]!.has(attribute.text)) return false;
      continue;
    }
    if (PY_BUILTINS.has(token.text)) { if (assigning) return false; continue; }
    if (bound.has(token.text) && !PY_RESERVED.has(token.text)) continue;
    return false;
  }
  return true;
}

/** Is this `python -c` script a pure stdin-to-stdout program made only of
 * listed tokens? Printable ASCII + LF, no `__`, every name allow-listed. */
export function safePythonScript(script: string): boolean {
  if (script.length > 8_000 || !printableAsciiLf(script) || script.includes("__")) return false;
  const units = pythonUnits(script);
  if (!units) return false;
  const bound = new Set<string>();
  const skips: Set<number>[] = [];
  for (const unit of units) {
    const covered = pythonImports(unit, bound);
    if (!covered || !pythonBindings(unit, bound)) return false;
    skips.push(covered);
  }
  for (const name of bound) if (Object.hasOwn(PY_MODULES, name)) return false;
  const usesFormat = units.some((unit) => unit.tokens.some((t) => t.kind === "name" && t.text === "format"));
  for (const [index, unit] of units.entries()) {
    if (!pythonNamesOk(unit, bound, skips[index]!)) return false;
    if (usesFormat && unit.tokens.some((t) => t.kind === "string" && !t.prefix!.includes("f") && !flatFormatFields(t.body!))) return false;
  }
  return true;
}

/** `python [-ISBuEsq] -c <script>` and nothing after the script: the script
 * reads the pipe. A file argument, even one the caller would accept, refuses
 * the command, because the script could read something else in its place. */
function pythonStage(args: Word[]): StageResult {
  let i = 0;
  for (; i < args.length; i++) {
    const text = args[i]!.text;
    if (/^-[ISBuEsq]+$/.test(text)) continue;
    break;
  }
  if (args[i]?.text !== "-c" || args.length !== i + 2) return undefined;
  if (!safePythonScript(args[i + 1]!.text)) return undefined;
  return { paths: [] };
}

const PROGRAMS = /^(cat|head|tail|wc|grep|jq|python3?|python3\.\d{1,2})$/;

/**
 * The files a read-only command reads, or undefined. Every path is a literal
 * word of the command; the caller checks each one.
 */
export function parseReadOnlyCommand(command: string): ReadOnlyCommand | undefined {
  if (typeof command !== "string" || command.length > 16_000) return undefined;
  // No control character but LF and TAB anywhere, quoted or not: a CR is a
  // line end for Python and jq and must never reach a stage.
  for (let i = 0; i < command.length; i++) {
    const code = command.charCodeAt(i);
    if ((code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f) return undefined;
  }
  const stages = tokenize(command.trim());
  if (!stages?.length || stages.length > 6) return undefined;
  const paths: string[] = [];
  const programs: string[] = [];
  for (let s = 0; s < stages.length; s++) {
    const [head, ...args] = stages[s]!;
    if (!head || head.quoted || !PROGRAMS.test(head.text)) return undefined;
    const program = head.text;
    let result: StageResult;
    if (program === "cat") result = catStage(args);
    else if (program === "head" || program === "tail") result = headTailStage(args, program);
    else if (program === "wc") result = wcStage(args);
    else if (program === "grep") result = grepStage(args);
    else if (program === "jq") result = jqStage(args);
    else result = pythonStage(args);
    if (!result) return undefined;
    if (result.paths.some((path) => path === "-" || path === "")) return undefined;
    // The first stage reads files (so python, which names none, never comes
    // first); a later stage reads the pipe and may also name files.
    if (s === 0 && result.paths.length === 0) return undefined;
    paths.push(...result.paths);
    programs.push(program);
  }
  return paths.length ? { paths, programs } : undefined;
}
