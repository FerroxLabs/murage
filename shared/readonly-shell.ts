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
// The rule is "understood or refused". Anything that could write, run another
// program, reach the network, expand variables, glob or chain commands
// returns undefined, and undefined means the approval card is raised exactly
// as before:
//   - no `;`, `&`, `&&`, `||`, newline, `$`, backtick, `(`, `)`, `{`, `}`,
//     globs, `~`, `#`, `!`, `@`, `^` outside quotes; no `$` or backtick inside
//     double quotes;
//   - the only redirections are `2>/dev/null` and `2>&1`;
//   - programs are bare names from a short allow-list, each with an
//     allow-list of options (no `tail -f`, no `grep -f`, no `jq -f`/`--rawfile`);
//   - `python -c` scripts pass a static check: a few safe modules with
//     allow-listed attributes, no dunder, no frame or code attributes, no
//     eval/exec/getattr/globals, and `open()` only read-only on a path the
//     caller accepts. Every python argument after the script is a path.
// Shared (no Node imports) so the approval card can also say such a command
// in plain words ("read call_00_x.json").

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

function jqStage(args: Word[]): StageResult {
  const paths: string[] = [];
  let filter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text;
    if (filter === undefined && text.startsWith("-") && text !== "-") {
      if (/^-[rcsenMSja]+$/.test(text)) continue;
      if (/^--(raw-output|compact-output|slurp|tab|sort-keys|null-input|exit-status|monochrome-output|join-output|ascii-output|raw-input)$/.test(text)) continue;
      if (text === "--indent") { if (!NUMBER.test(args[++i]?.text ?? "")) return undefined; continue; }
      if (text === "--arg" || text === "--argjson") {
        const name = args[++i]?.text; const value = args[++i];
        if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value === undefined) return undefined;
        continue;
      }
      return undefined;
    }
    if (filter === undefined) { filter = text; continue; }
    if (text.startsWith("-")) return undefined;
    paths.push(text);
  }
  if (filter === undefined) return undefined;
  // jq cannot write or reach the network, but it can read the environment
  // and load modules from disk. Neither is reading the bot's own result.
  if (/\$ENV|\benv\b|\b(import|include|input_filename|getpath|\$__loc__|\$__prog)\b/.test(filter.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) return undefined;
  if (/\$__/.test(filter)) return undefined;
  return { paths };
}

// ---- python -c ------------------------------------------------------------

/** The modules a script may import, each with the only attributes it may
 * read on them. `*` means any lowercase name (math has no submodules). */
const PY_MODULES: Record<string, ReadonlySet<string> | "*"> = {
  json: new Set(["load", "loads", "dump", "dumps", "JSONDecodeError"]),
  sys: new Set(["stdin", "stdout", "stderr", "argv", "exit", "maxsize"]),
  re: new Set(["search", "match", "fullmatch", "findall", "finditer", "sub", "subn", "split", "compile", "escape", "I", "IGNORECASE", "M", "MULTILINE", "S", "DOTALL", "X", "VERBOSE", "A", "ASCII"]),
  collections: new Set(["Counter", "defaultdict", "OrderedDict", "namedtuple", "deque"]),
  itertools: new Set(["islice", "chain", "groupby", "count", "zip_longest", "product", "permutations", "combinations", "accumulate", "takewhile", "dropwhile"]),
  math: "*",
  statistics: new Set(["mean", "median", "mode", "stdev", "pstdev", "variance", "quantiles"]),
  textwrap: new Set(["shorten", "wrap", "fill", "dedent", "indent"]),
  pprint: new Set(["pprint", "pformat"]),
  datetime: new Set(["datetime", "date", "time", "timedelta", "timezone"]),
  string: new Set(["ascii_letters", "ascii_lowercase", "ascii_uppercase", "digits", "punctuation", "whitespace", "printable"]),
  operator: new Set(["itemgetter"]),
  functools: new Set(["reduce"]),
  csv: new Set(["reader", "DictReader", "writer", "DictWriter"]),
  base64: new Set(["b64decode", "b64encode"]),
  html: new Set(["unescape", "escape"]),
  unicodedata: new Set(["normalize", "name"]),
  heapq: new Set(["nlargest", "nsmallest"]),
};

/** Builtins that run code, reach attributes by a computed name, or read input. */
const PY_FORBIDDEN_NAMES = new Set([
  "eval", "exec", "compile", "getattr", "setattr", "delattr", "globals", "locals", "vars",
  "breakpoint", "input", "memoryview", "help", "license", "credits", "copyright", "exit", "quit",
  "attrgetter", "methodcaller", "modules", "builtins", "importlib", "mro", "subclasses",
]);

/** Attributes that lead from an ordinary object to frames, code or builtins. */
const PY_FORBIDDEN_ATTRIBUTE = /^(gi|cr|ag|f|tb|co)_|^(open|mro|modules|format_map|system|popen|spawn|fork|remove|unlink|rmdir|rename|chmod|write_text|write_bytes|mkdir)$/;

type Literal = { start: number; end: number; body: string; prefix: string };

/** Find every string literal (with r/b/u/f prefixes and triple quotes). */
function pythonLiterals(script: string): Literal[] | undefined {
  const out: Literal[] = [];
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (ch === "#") {
      // A comment runs to the end of the line; `-c` scripts rarely have one.
      const nl = script.indexOf("\n", i);
      out.push({ start: i, end: nl < 0 ? script.length : nl, body: "", prefix: "#" });
      i = nl < 0 ? script.length : nl;
      continue;
    }
    if (ch !== "'" && ch !== '"') continue;
    // The prefix (r, b, u, f, rb, fr, …) is the run of letters right before
    // the quote. Anything else glued to a quote is not something this reads.
    let p = i;
    while (p > 0 && /[A-Za-z0-9_]/.test(script[p - 1]!)) p--;
    const prefix = script.slice(p, i).toLowerCase();
    if (prefix.length > 2 || !/^[rbuf]*$/.test(prefix)) return undefined;
    const triple = script.startsWith(ch.repeat(3), i);
    const quote = triple ? ch.repeat(3) : ch;
    let j = i + quote.length;
    let body = "";
    const raw = prefix.includes("r");
    for (; j < script.length; j++) {
      if (script.startsWith(quote, j)) break;
      const c = script[j]!;
      if (!triple && c === "\n") return undefined;
      if (c === "\\" && j + 1 < script.length) {
        body += raw ? c + script[j + 1] : script[j + 1];
        j++;
        continue;
      }
      body += c;
    }
    if (j >= script.length) return undefined;
    out.push({ start: p, end: j + quote.length, body, prefix });
    i = j + quote.length - 1;
  }
  return out;
}

/** The expressions inside an f-string's braces (`{{` is a literal brace). */
function fStringExpressions(body: string): string[] | undefined {
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "{") {
      if (body[i + 1] === "{") { i++; continue; }
      let depth = 1; let j = i + 1;
      for (; j < body.length && depth > 0; j++) {
        if (body[j] === "{") depth++;
        else if (body[j] === "}") depth--;
      }
      if (depth !== 0) return undefined;
      out.push(body.slice(i + 1, j - 1));
      i = j - 1;
    } else if (ch === "}") {
      if (body[i + 1] === "}") { i++; continue; }
      return undefined;
    }
  }
  return out;
}

/** The script with literal number n replaced by `"n"` (comments dropped), and
 * the code inside f-string braces appended with its literals as `"x"`, so an
 * `open()` written inside an f-string never matches the call pattern below. */
function pythonCode(script: string, depth = 0): { code: string; literals: string[] } | undefined {
  if (depth > 3) return undefined;
  const found = pythonLiterals(script);
  if (!found) return undefined;
  const literals: string[] = [];
  let code = "";
  let at = 0;
  const extra: string[] = [];
  for (const literal of found) {
    code += script.slice(at, literal.start);
    at = literal.end;
    if (literal.prefix === "#") continue;
    code += depth === 0 ? `"${literals.length}"` : '"x"';
    literals.push(literal.prefix.includes("f") ? "\u0000" : literal.body);
    if (literal.prefix.includes("f")) {
      const expressions = fStringExpressions(literal.body);
      if (!expressions) return undefined;
      for (const expression of expressions) {
        const inner = pythonCode(expression, depth + 1);
        if (!inner) return undefined;
        extra.push(inner.code);
      }
    }
  }
  code += script.slice(at);
  return { code: [code, ...extra].join("\n"), literals };
}

const OPEN_CALL = /\bopen\s*\(\s*(?:"(\d+)"|sys\s*\.\s*argv\s*\[\s*(\d{1,2})\s*\])\s*(?:,\s*(?:mode\s*=\s*)?"(\d+)"\s*)?(?:,\s*(?:encoding|errors|newline)\s*=\s*"\d+"\s*)*\)/g;
const IMPORT_LINE = /^\s*(?:import\s+([A-Za-z0-9_,\s]+)|from\s+([A-Za-z_][A-Za-z0-9_]*)\s+import\s+\(?([A-Za-z0-9_,\s]+)\)?)\s*$/;

/** Is this `python -c` script read-only? `readable(path)` decides each file it opens. */
export function safePythonScript(script: string, argv: readonly string[], readable: (path: string) => boolean): boolean {
  if (script.includes("__") || script.length > 8_000) return false;
  const parsed = pythonCode(script);
  if (!parsed) return false;
  const { literals } = parsed;
  // Imports: plain `import a, b` or `from a import x, y`, allow-listed, no
  // `as`. Each import statement is checked and then removed, so that below a
  // module name may only ever appear as `module.allowed_attribute`.
  const kept: string[] = [];
  for (const statement of parsed.code.split(/([\n;])/)) {
    if (statement === "\n" || statement === ";") { kept.push(statement); continue; }
    if (!/\b(import|from)\b/.test(statement)) { kept.push(statement); continue; }
    const match = IMPORT_LINE.exec(statement);
    if (!match) return false;
    if (match[1] !== undefined) {
      const names = match[1].split(",").map((name) => name.trim());
      if (!names.every((name) => Object.hasOwn(PY_MODULES, name))) return false;
    } else {
      const allowed = Object.hasOwn(PY_MODULES, match[2]!) ? PY_MODULES[match[2]!]! : undefined;
      if (!allowed) return false;
      const names = match[3]!.split(",").map((name) => name.trim());
      if (!names.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && (allowed === "*" ? /^[a-z][a-z0-9_]*$/.test(name) : allowed.has(name)))) return false;
    }
    kept.push("");
  }
  const code = kept.join("");
  // Python folds non-ASCII identifiers (a full-width `ｅｖａｌ` is `eval`), so
  // only ASCII is read here; a backslash continuation could split a name.
  if ([...code].some((ch) => ch.charCodeAt(0) > 0x7f) || code.includes("\\")) return false;
  // `open(...)`: read-only, on a path the caller accepts.
  let openCalls = 0;
  for (const match of code.matchAll(OPEN_CALL)) {
    openCalls++;
    const path = match[1] !== undefined ? literals[Number(match[1])] : argv[Number(match[2]) - 1];
    if (path === undefined || path.includes("\u0000") || !readable(path)) return false;
    if (match[3] !== undefined && !/^r[bt]?$/.test(literals[Number(match[3])] ?? "")) return false;
  }
  const identifiers = [...code.matchAll(/(\.\s*)?\b([A-Za-z_][A-Za-z0-9_]*)\b(\s*\.\s*([A-Za-z_][A-Za-z0-9_]*))?/g)];
  let opens = 0;
  for (const m of identifiers) {
    const name = m[2]!;
    const attribute = Boolean(m[1]);
    if (name === "open" && !attribute) { opens++; continue; }
    if (attribute) {
      if (name.startsWith("_") || PY_FORBIDDEN_ATTRIBUTE.test(name) || PY_FORBIDDEN_NAMES.has(name)) return false;
    } else if (PY_FORBIDDEN_NAMES.has(name)) return false;
    // `module.attribute`: the module must be read through an allowed name.
    // A module named any other way (`j = json`, `f(json)`) could be aliased.
    if (!attribute && Object.hasOwn(PY_MODULES, name)) {
      const attr = m[4];
      const allowed = PY_MODULES[name]!;
      if (attr === undefined) return false;
      if (allowed === "*" ? !/^[a-z][a-z0-9_]*$/.test(attr) : !allowed.has(attr)) return false;
    }
    const chained = m[4];
    if (chained !== undefined && (chained.startsWith("_") || PY_FORBIDDEN_ATTRIBUTE.test(chained) || PY_FORBIDDEN_NAMES.has(chained))) return false;
  }
  return opens === openCalls;
}

function pythonStage(args: Word[], readable: (path: string) => boolean): StageResult {
  let i = 0;
  for (; i < args.length; i++) {
    const text = args[i]!.text;
    if (/^-[ISBuEsq]+$/.test(text)) continue;
    break;
  }
  if (args[i]?.text !== "-c" || args[i + 1] === undefined) return undefined;
  const script = args[i + 1]!.text;
  const argv = args.slice(i + 2).map((arg) => arg.text);
  if (argv.some((value) => value.startsWith("-"))) return undefined;
  if (!safePythonScript(script, argv, readable)) return undefined;
  // every argument after the script is a file it may open
  return { paths: argv };
}

const PROGRAMS = /^(cat|head|tail|wc|grep|jq|python3?|python3\.\d{1,2})$/;

/**
 * The files a read-only command reads, or undefined. `readable` is asked about
 * every path a python script opens by literal; the caller still checks every
 * returned path itself.
 */
export function parseReadOnlyCommand(command: string, readable: (path: string) => boolean = () => true): ReadOnlyCommand | undefined {
  if (typeof command !== "string" || command.length > 16_000) return undefined;
  const stages = tokenize(command.trim());
  if (!stages?.length || stages.length > 6) return undefined;
  const paths: string[] = [];
  const programs: string[] = [];
  const opened: string[] = [];
  const track = (path: string) => { const ok = readable(path); if (ok) opened.push(path); return ok; };
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
    else result = pythonStage(args, track);
    if (!result) return undefined;
    if (result.paths.some((path) => path === "-" || path === "")) return undefined;
    // The first stage reads files; a later stage reads the pipe (it may also name files).
    if (s === 0 && result.paths.length === 0 && opened.length === 0) return undefined;
    paths.push(...result.paths);
    programs.push(program);
  }
  for (const path of opened) if (!paths.includes(path)) paths.push(path);
  return paths.length ? { paths, programs } : undefined;
}
