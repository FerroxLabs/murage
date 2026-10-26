// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.5 r8: code an interpreter or a shell loads before its own program, from
// a flag (`node -r x`, `ruby -I dir`, `perl -MX`, `php -d auto_prepend_file=x`)
// or from a variable (`NODE_OPTIONS`, `RUBYOPT`, `BASH_ENV`, `LD_PRELOAD`), is a
// file the reader does not see. One list, read by the POSIX reader (walk.ts)
// and the PowerShell reader (pwsh.ts) alike, whatever the program is: none,
// `-`, the null device, a file or inline code.
import { Unreadable } from "./lex.ts";

/** Variables an interpreter or a shell reads code, a code folder or its own
 * options from when it starts. Named anywhere in a text, they count. */
export const LOADER_VARIABLES: readonly string[] = [
  "NODE_OPTIONS", "NODE_PATH",
  "RUBYOPT", "RUBYLIB", "GEM_HOME", "GEM_PATH",
  "PERL5OPT", "PERL5LIB", "PERLLIB", "PERL5DB",
  "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE",
  "BASH_ENV", "ENV", "ZDOTDIR", "SHELLOPTS", "BASHOPTS", "PS0", "PS1", "PS2", "PS3", "PS4", "RPS1", "RPS2", "PROMPT", "RPROMPT", "PROMPT_COMMAND",
  "PHPRC", "PHP_INI_SCAN_DIR",
  "LUA_INIT", "LUA_PATH", "LUA_CPATH",
  "R_PROFILE", "R_PROFILE_USER", "R_ENVIRON", "R_ENVIRON_USER", "R_LIBS", "R_LIBS_USER",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
];
/** Families by prefix: the macOS loader's, bash's exported functions, lua's versioned ones. */
const LOADER_PREFIXES: readonly string[] = ["DYLD_", "BASH_FUNC_", "LUA_INIT_", "LUA_PATH_", "LUA_CPATH_"];
/** Folders the startup files of a shell or an interpreter are found from
 * (`~/.zshenv`, `~/.bash_profile`, python's user site, fish's config). Read
 * everywhere (`$HOME/x`), so only setting one counts. */
const HOME_VARIABLES: ReadonlySet<string> = new Set(["HOME", "XDG_CONFIG_HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]);

const NAMES = `(?:${LOADER_VARIABLES.join("|")}|(?:${LOADER_PREFIXES.join("|")})[A-Za-z0-9_%]*)`;
/** A loader name as a whole word: not part of a longer name. */
const POSIX_MENTION = new RegExp(`(?<![A-Za-z0-9_])${NAMES}(?![A-Za-z0-9_])`);
/** PowerShell names are any case. `env:` with no name after it,
 * `SetEnvironmentVariable`, or `Set-Item`/`New-Item` on `env:` set a
 * variable a value may name; `$env:HOME = …` sets a home folder. */
const PWSH_MENTION = new RegExp(
  `(?<![A-Za-z0-9_])${NAMES}(?![A-Za-z0-9_])|env:(?![A-Za-z_])|SetEnvironmentVariable|\\b(?:set-item|new-item|si|ni)\\b[^;|\\n]*env:|env:\\{?(?:${[...HOME_VARIABLES].join("|")})\\}?\\s*[+]?=`,
  "i",
);

/** The startup files a shell or an interpreter reads before its program, by
 * name: a text that names one (writes it, links it, copies it) and runs a
 * shell or an interpreter asks, as a loader variable does. */
const STARTUP_FILES = /(?<![A-Za-z0-9_.-])(?:\.bashrc|\.bash_profile|\.bash_login|\.profile|\.zshenv|\.zshrc|\.zprofile|\.zlogin|\.zlogout|config\.fish|\.Rprofile|\.Renviron|usercustomize\.py|sitecustomize\.py|\.irbrc|\.pythonrc(?:\.py)?)(?![A-Za-z0-9_.-])/i;

/** The loader variable or startup file this text names anywhere, or what
 * sets one, or undefined. */
export function mentionsLoaderVariable(text: string, dialect: "posix" | "pwsh"): string | undefined {
  // PowerShell's backtick escapes a letter inside a name (`$env:NODE_OPT`IONS`)
  const read = dialect === "pwsh" ? text.replace(/`/g, "") : text;
  return (dialect === "pwsh" ? PWSH_MENTION : POSIX_MENTION).exec(read)?.[0] ?? STARTUP_FILES.exec(read)?.[0];
}

/** A file this read wrote or linked that a shell or an interpreter reads
 * before its program (`echo x > ~/.zshe\nv`: the lexed path, however it was
 * spelled), or undefined. */
export function namesStartupFile(text: string): string | undefined {
  return STARTUP_FILES.exec(text)?.[0];
}

export function writtenStartupFile(paths: Iterable<string>): string | undefined {
  for (const path of paths) {
    const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
    if (STARTUP_FILES.test(base)) return path;
  }
  return undefined;
}

/** Is a name being set a loader variable or a home folder? (`export
 * $'NODE_OPT\x49ONS'=…` reaches here decoded, as a literal name.) */
export function isLoaderName(name: string): boolean {
  return LOADER_VARIABLES.includes(name) || HOME_VARIABLES.has(name) || LOADER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Per interpreter: the short-option letters whose value is code loaded first
 * (or the folder it is found in), and the letters that take the rest of the
 * word as their value, which ends a bundle (`-we`, `-i.bak`, `-l015`). */
const CLUSTERS: Record<string, { code: string; rest: string }> = {
  perl: { code: "MmdI", rest: "eEixCDV" },
  ruby: { code: "I", rest: "eEKCFTWx" },
  // php -B/-R/-E/-F take code of their own, run with no script file
  php: { code: "dczBREF", rest: "rftS" },
  lua: { code: "l", rest: "e" },
};

/** A library by its bare name (`-rjson`, `-r set`) comes from ruby's own load
 * path, which holds no relative folder unless `-I` or RUBYLIB put one there. */
const bareLibrary = (library: string | undefined): boolean => library !== undefined && /^[A-Za-z0-9_-]+$/.test(library);

/** An interpreter option whose value is code that runs before the program,
 * or a folder or file such code is found in (1.0.5 r6, r8): node's
 * `-r`/`--require`/`--import`/`--loader`/`--experimental-loader` and the
 * files it reads options from (`--env-file`, `--experimental-config-file`);
 * ruby's `-I` always, and `-r` with a path; perl's `-M`/`-m`/`-d`/`-I`; php's
 * `-d`/`-c`/`-z`. Attached or not, with `=` or not, anywhere in a bundle of
 * short options (`perl -wMX`, `ruby -wI dir`, `php -nd x=y`). */
export function loadsCodeFirst(key: string, option: string, next: string | undefined): boolean {
  const name = option.includes("=") ? option.slice(0, option.indexOf("=")) : option;
  if (key === "node") return /^-r/.test(name) || ["--require", "--import", "--loader", "--experimental-loader", "--env-file", "--env-file-if-exists", "--experimental-config-file", "--experimental-default-config-file"].includes(name);
  if (key === "php" && ["--define", "--php-ini", "--zend-extension"].includes(name)) return true;
  const cluster = CLUSTERS[key];
  if (!cluster || !option.startsWith("-") || option.startsWith("--")) return false;
  if (key === "ruby") return rubyLoadsFirst(option, next);
  for (let k = 1; k < option.length; k++) {
    const letter = option[k]!;
    if (cluster.code.includes(letter)) return true;
    if (cluster.rest.includes(letter)) return false;
  }
  return false;
}

/** Ruby letters whose value is the rest of the word (`-e`, `-E`, `-C`, `-F`,
 * `-x`, `-i`, and a `-W:` category): what follows is a value, not options. */
const RUBY_VALUE_LETTERS = "eECFxi:";

/** 1.0.5 r8c (simpler rule): `-I…` and `-r…` on their own keep their reading
 * (`-rjson` from ruby's own load path stays ordinary). Any other bundle with
 * `I` or `r` in it, before a letter that takes the rest as its value, asks,
 * whatever comes between (`-wI`, `-WI`, `-W2r`, `-T1I`, `-KuI`). */
function rubyLoadsFirst(option: string, next: string | undefined): boolean {
  if (option[1] === "I") return true;
  if (option[1] === "r") return !bareLibrary(option.length > 2 ? option.slice(2) : next);
  for (let k = 1; k < option.length; k++) {
    const letter = option[k]!;
    if (RUBY_VALUE_LETTERS.includes(letter)) return false;
    if (letter === "I" || letter === "r") return true;
  }
  return false;
}

/** R reads `.Rprofile` from the folder it runs in, and the user's own,
 * before any code, unless told not to. */
export function rReadsProfile(words: ReadonlyArray<string | undefined>): boolean {
  return !words.some((word) => word === "--vanilla" || word === "--no-init-file");
}

/** `python -m` modules that run no file the text names and take no code:
 * the rest load a file or code the reader does not see (`runpy`, `pdb`,
 * `trace`, `timeit`, `cProfile`, a module of the project's own). */
export const PYTHON_TOOL_MODULES: ReadonlySet<string> = new Set(["pip", "pytest", "unittest", "venv", "ensurepip", "http.server", "json.tool"]);

/** `python -m X` (or `-mX`, `-Im X`) with a module outside the tool set. */
export function pythonModuleLoads(option: string, next: string | undefined): boolean {
  const match = /^-[bBdEhiIOqsSuvV]*m(.*)$/.exec(option);
  if (!match) return false;
  const module = match[1] ? match[1] : next;
  return module === undefined || !PYTHON_TOOL_MODULES.has(module);
}

/** What a read has seen so far, kept by reference through every fork of
 * the walk (subshell, branch, `eval`, nested text): a loader variable set or
 * named, and an interpreter or shell run. Either order asks: the reader does
 * not follow which comes first at run time. */
export interface LoaderMarks {
  variable?: string;
  runner?: string;
  /** this read wrote a file it cannot name (inline code that writes, a
   * redirect or a copy to a value): it may be a startup file, read by a
   * shell, python or R run after it */
  unplacedWrite?: string;
}

/** Programs that read startup files from the home folder or the folder they run in. */
const STARTUP_READERS = /^(?:sh|bash|zsh|dash|ksh|fish|ash|mksh|python[0-9.]*|rscript|r)$/i;

/** A shell, python or R runs after an unplaced write (1.0.5 r8 lanereview). */
export function checkUnplacedWrite(marks: LoaderMarks, name: string): void {
  const base = name.replace(/^.*[\\/]/, "");
  if (marks.unplacedWrite !== undefined && STARTUP_READERS.test(base)) throw new Unreadable("opaque", `${name} may read a startup file this text wrote (${marks.unplacedWrite})`);
}

function check(marks: LoaderMarks): void {
  if (marks.variable !== undefined && marks.runner !== undefined) {
    throw new Unreadable("opaque", `${marks.runner} may load code first (${marks.variable})`);
  }
}

/** A loader variable is set, named, or set by a name a value gives. */
export function markLoaderVariable(marks: LoaderMarks, why: string): void {
  marks.variable ??= why;
  check(marks);
}

/** An interpreter or a shell runs. */
export function markLoaderRunner(marks: LoaderMarks, name: string): void {
  marks.runner ??= name;
  check(marks);
}
