// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner's startup files by RESOLVED identity (APP-GRANT-FIXPLAN-r6 section (c); design Rules 35, 74a, 74d).
//
// Rule 74a re-captures the owner's environment after an APPROVED write to a startup file, and Rule 74d re-runs its check.
// Which files are startup files is the Rule 74d list, built from the owner's map as captured BEFORE the pins
// (`HandedEnv.ownerStartup`: the pins set ZDOTDIR to /dev/null and remove BASH_ENV, ENV and CLAUDE_ENV_FILE, so the
// handed map alone no longer says where the owner's files are) and from the handed map. Every entry and every target an
// ask names is placed part by part in order (shared/in-project.ts), and they are compared by real path, by each
// intermediate real path and by device and inode, never by spelling: a symlink, `link/../.zshrc`, a hard link and the
// file BASH_ENV names all match. A target that cannot be placed, or a command that cannot be read whole, counts as
// touching; its only effect is one extra re-capture. cmd's AutoRun has no file and stays a text row of Rule 35.

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { commandArgument } from "../shared/app-action-grant.ts";
import { SENSITIVE_TEXT } from "../shared/sensitive-paths.ts";
import { joinReal, realDir, realPathInOrder, type RealPath } from "../shared/in-project.ts";
import type { HandedEnv } from "./engine-env.ts";

/** The owner's names that say where their startup files are, read from the owner map before the pins. */
export const OWNER_STARTUP_NAMES = ["HOME", "ZDOTDIR", "BASH_ENV", "ENV", "PSQLRC", "CLAUDE_ENV_FILE"] as const;
/** The names that each name one file the shell or a tool reads at start (Rule 74d). */
const NAMED_FILES = ["BASH_ENV", "ENV", "PSQLRC", "CLAUDE_ENV_FILE"] as const;
/** The handed names that point at Murage's own murage-exec wrapper and its per-turn env file. */
const MURAGE_EXEC_NAMES = ["CLAUDE_CODE_SHELL_PREFIX", "MURAGE_EXEC_ENV_FILE"] as const;

const HOME_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout", ".bash_profile", ".bash_login", ".bashrc", ".profile", ".bash_logout", ".psqlrc"];
const ZDOTDIR_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"];
const ETC_FILES = ["/etc/profile", "/etc/bash.bashrc", "/etc/bashrc", "/etc/zshenv", "/etc/zsh/zshenv", "/etc/zprofile", "/etc/zshrc", "/etc/zlogin"];
const ETC_DIRS = ["/etc/profile.d"];

/** One startup file (or, with `under`, a folder whose every file is one) by resolved identity. */
export interface StartupEntry {
  real: RealPath;
  /** `dev:ino` when the file exists, so a hard link is the same file. */
  devIno?: string;
  under?: true;
}

export interface StartupSet {
  entries: StartupEntry[];
  /** An entry the list names could not be placed: every ask counts as touching. */
  cannot: boolean;
}

function devInoOf(real: string): string | undefined {
  try {
    const stat = statSync(real);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

/** The owner's startup names, from the owner map before any pin is applied. */
export function ownerStartupOf(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of OWNER_STARTUP_NAMES) if (typeof env[name] === "string" && env[name] !== "") out[name] = env[name]!;
  return out;
}

const isNullDevice = (value: string) => value === "/dev/null" || value.toUpperCase() === "NUL";

/** The Rule 74d list for one hand, as resolved identities. `perCommandEnv` is a command's own literal assignments
 *  (`BASH_ENV=/x cmd`); `cwd` places the `.envrc` of the command's folder and any relative name. */
export function startupSet(handed: HandedEnv, perCommandEnv: Readonly<Record<string, string>> = {}, cwd?: string): StartupSet {
  const owner = handed.ownerStartup ?? {};
  const home = owner.HOME ?? handed.env.HOME ?? homedir();
  const entries: StartupEntry[] = [];
  let cannot = false;
  const add = (path: string, under?: true) => {
    const placed = realPathInOrder(path, cwd ?? home, { home });
    if ("cannot" in placed) { cannot = true; return; }
    const devIno = under ? undefined : devInoOf(placed.real);
    entries.push({ real: placed.real, ...(devIno ? { devIno } : {}), ...(under ? { under } : {}) });
  };
  const addIn = (base: string, names: readonly string[]) => {
    const real = realPathInOrder(base, cwd ?? home, { home });
    if ("cannot" in real) { cannot = true; return; }
    for (const name of names) {
      const parts = name.split("/");
      const joined = joinReal(real.real, ...parts);
      if ("cannot" in joined) { cannot = true; continue; }
      add(joined.path);
    }
  };
  addIn(home, [...HOME_FILES, ".config/fish/config.fish"]);
  const fish = realPathInOrder(home, cwd ?? home, { home });
  if ("cannot" in fish) cannot = true;
  else {
    const conf = joinReal(fish.real, ".config", "fish", "conf.d");
    if ("cannot" in conf) cannot = true; else add(conf.path, true);
  }
  if (owner.ZDOTDIR && !isNullDevice(owner.ZDOTDIR)) addIn(owner.ZDOTDIR, ZDOTDIR_FILES);
  for (const path of ETC_FILES) add(path);
  for (const path of ETC_DIRS) add(path, true);
  for (const name of NAMED_FILES) {
    for (const value of [owner[name], handed.env[name], perCommandEnv[name]]) {
      if (typeof value === "string" && value !== "" && !isNullDevice(value)) add(value);
    }
  }
  for (const name of MURAGE_EXEC_NAMES) {
    const value = handed.env[name];
    if (typeof value !== "string" || value === "") continue;
    add(value);
    // the wrapper's private folder holds the per-turn env files too
    if (name === "CLAUDE_CODE_SHELL_PREFIX") {
      const p = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) ? win32 : posix;
      const folder = realDir(p.dirname(value));
      if (folder) entries.push({ real: folder, under: true });
    }
  }
  if (cwd) addIn(cwd, [".envrc"]);
  return { entries, cannot };
}

// ---- the hands this server made ---------------------------------------------------------------------------------------------
// noteStartupFileEvent reads runtime events that do not carry the hand, so every hand handEnv makes is remembered here
// (bounded); an ask is compared against the list of each.

const HANDS_MAX = 32;
const hands: HandedEnv[] = [];

/** Called by handEnv for every hand it makes. */
export function rememberHand(handed: HandedEnv): void {
  hands.push(handed);
  while (hands.length > HANDS_MAX) hands.shift();
}

/** Tests only: the hands remembered so far (item 175 proves a spawn-only key is in none of them). */
export function rememberedHandsForTest(): readonly HandedEnv[] {
  return [...hands];
}

function knownHands(): HandedEnv[] {
  if (hands.length) return [...hands];
  // no engine was handed a map yet: the server's own account stands in
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (typeof value === "string") env[name] = value;
  if (!env.HOME) env.HOME = homedir();
  return [{ env, absent: [], capture: "fallback", ownerStartup: ownerStartupOf(env), pins: new Map() }];
}

// ---- the targets an ask names -----------------------------------------------------------------------------------------------

/** Programs whose only file effects are the literal words they are given (and redirections). Any other program might
 *  write anywhere, so a command naming one cannot be read whole. This stands at the Rule 75 `targetsOf` seam
 *  (server/drivers/codex-hook.ts shellTargetsSeam) until the walker lands, and reads every word as a target, plus the
 *  destination a copy-like program derives inside a folder operand. */
const LITERAL_PROGRAMS = new Set([
  "echo", "printf", "cat", "tee", "cp", "mv", "rm", "touch", "mkdir", "rmdir", "ln", "chmod", "chown", "head", "tail",
  "grep", "egrep", "fgrep", "ls", "wc", "sort", "uniq", "cut", "tr", "diff", "cmp", "true", "false", "test", "dd",
  "install", "stat", "readlink", "realpath", "basename", "dirname", "pwd", "date", "base64", "md5sum", "shasum",
  "sha256sum", "file", "du", "df", "jq",
]);

/** The literal programs that write into a folder operand under a name they derive from another operand: `cp a dir`
 *  writes `dir/a`, as `mv`, `ln` and `install` do (`-t dir`, `--target-directory=dir` included). */
const COPY_PROGRAMS = new Set(["cp", "mv", "ln", "install"]);

const UNQUOTED_FORBIDDEN = new Set([";", "&", "$", "`", "(", ")", "{", "}", "*", "?", "[", "]", "#", "!", "\n", "\r"]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

interface CommandRead {
  targets: string[];
  env: Record<string, string>;
  /** Per copy-like stage, its operands (an `=` value split out): a folder among them receives the others by basename. */
  copies: string[][];
}

/** A copy-like stage's operands: every word, and the value of an `--option=value` word. */
function copyOperands(words: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of words) {
    if (text === "") continue;
    out.push(text);
    const eq = text.indexOf("=");
    if (text.startsWith("-") && eq >= 0 && eq < text.length - 1) out.push(text.slice(eq + 1));
  }
  return out;
}

/** Every word and redirection target of a command line made only of literal words, or undefined when it is not. */
export function readCommand(command: string): CommandRead | undefined {
  type Word = { text: string; quoted: boolean };
  const stages: Word[][] = [[]];
  const redirects: string[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  let pendingRedirect = false;
  const end = () => {
    if (inWord) {
      if (pendingRedirect) { redirects.push(word); pendingRedirect = false; }
      else stages[stages.length - 1]!.push({ text: word, quoted });
    }
    word = ""; inWord = false; quoted = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === " " || ch === "\t") { end(); continue; }
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return undefined;
      word += command.slice(i + 1, close); inWord = true; quoted = true; i = close; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < command.length; j++) {
        const c = command[j]!;
        if (c === '"') break;
        if (c === "$" || c === "`" || c === "!") return undefined;
        if (c === "\\") {
          const next = command[j + 1];
          if (next === undefined || next === "\n") return undefined;
          if (next === '"' || next === "\\") { word += next; j++; continue; }
        }
        word += c;
      }
      if (j >= command.length) return undefined;
      inWord = true; quoted = true; i = j; continue;
    }
    if (ch === "\\") {
      const next = command[i + 1];
      if (next === undefined || next === "\n" || next === "\r") return undefined;
      word += next; inWord = true; quoted = true; i++; continue;
    }
    if (ch === "|") {
      if (pendingRedirect || command[i + 1] === "|") return undefined;
      end();
      if (!stages[stages.length - 1]!.length) return undefined;
      stages.push([]);
      continue;
    }
    if (ch === ">" || ch === "<") {
      if (pendingRedirect) return undefined;
      // a stream number written right before the operator is part of it
      if (inWord && !quoted && /^\d+$/.test(word)) { word = ""; inWord = false; }
      end();
      let k = i + 1;
      if (ch === "<" && command[k] === "<") return undefined; // a here-document or here-string
      if (ch === ">" && (command[k] === ">" || command[k] === "|")) k++;
      else if (ch === "<" && command[k] === ">") k++;
      if (command[k] === "&") {
        const dup = /^&(\d+|-)(?=$|[ \t|])/.exec(command.slice(k));
        if (!dup) return undefined;
        i = k + dup[0].length - 1;
        continue;
      }
      pendingRedirect = true;
      i = k - 1;
      continue;
    }
    if (UNQUOTED_FORBIDDEN.has(ch)) return undefined;
    if (ch === "~" && !(inWord === false && (command[i + 1] === "/" || command[i + 1] === undefined || command[i + 1] === " " || command[i + 1] === "\t"))) return undefined;
    word += ch; inWord = true;
  }
  end();
  if (pendingRedirect) return undefined;
  if (stages.some((stage) => stage.length === 0)) return undefined;
  const env: Record<string, string> = {};
  const targets: string[] = [...redirects];
  const copies: string[][] = [];
  for (const stage of stages) {
    let at = 0;
    for (; at < stage.length; at++) {
      const assignment = stage[at]!.quoted ? null : ASSIGNMENT.exec(stage[at]!.text);
      if (!assignment) break;
      env[assignment[1]!] = assignment[2]!;
      if (assignment[2]) targets.push(assignment[2]);
    }
    const program = stage[at];
    if (!program || !LITERAL_PROGRAMS.has(program.text)) return undefined;
    if (COPY_PROGRAMS.has(program.text)) copies.push(copyOperands(stage.slice(at + 1).map((word) => word.text)));
    for (const { text } of stage.slice(at + 1)) {
      if (text === "") continue;
      targets.push(text);
      const eq = text.indexOf("=");
      if (eq >= 0 && eq < text.length - 1) targets.push(text.slice(eq + 1));
    }
  }
  return { targets, env, copies };
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

/** Every string the ask carries about its call, for the one text row (cmd's AutoRun). */
function askTexts(ask: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (typeof value === "string") out.push(value);
    else if (depth < 6 && Array.isArray(value)) for (const item of value) walk(item, depth + 1);
    else if (depth < 6 && value && typeof value === "object") for (const item of Object.values(value)) walk(item, depth + 1);
  };
  for (const key of ["filePaths", "toolCall", "toolInput", "summary"]) walk(ask[key], 0);
  return out;
}

const AUTORUN = SENSITIVE_TEXT.filter((row) => row.id === "cmd-autorun");

type AskTargets = { paths: string[]; env: Record<string, string>; copies: string[][]; cwd?: string } | { unreadable: true };

/** The targets an ask names: its filePaths, the structured paths of its call, and for a command every target of it. */
function targetsOfAsk(ask: Record<string, unknown>): AskTargets {
  const paths: string[] = [];
  let env: Record<string, string> = {};
  let copies: string[][] = [];
  for (const path of Array.isArray(ask.filePaths) ? ask.filePaths : []) {
    if (typeof path !== "string") return { unreadable: true };
    paths.push(path);
  }
  const call = record(ask.toolCall);
  const input = record(call?.input);
  const execEnv = record(ask.execEnv);
  const cwd = str(execEnv?.cwd) ?? str(input?.cwd) ?? str(input?.workdir);
  for (const key of ["file_path", "filePath", "path", "notebook_path"]) {
    const value = str(input?.[key]);
    if (value) paths.push(value);
  }
  if (Array.isArray(input?.paths)) for (const value of input.paths) if (typeof value === "string") paths.push(value);
  const command = input?.command ?? input?.cmd;
  if (typeof command === "string") {
    const read = readCommand(command);
    if (!read) return { unreadable: true };
    paths.push(...read.targets);
    env = read.env;
    copies = read.copies;
  } else if (Array.isArray(command)) {
    const argv = command.filter((part): part is string => typeof part === "string");
    if (argv.length !== command.length || !argv.length || !LITERAL_PROGRAMS.has(argv[0]!)) return { unreadable: true };
    paths.push(...argv.slice(1).filter(Boolean));
    if (COPY_PROGRAMS.has(argv[0]!)) copies = [copyOperands(argv.slice(1))];
  } else if (command !== undefined || ask.toolInputTruncated === true || ask.toolInputMissing !== undefined) {
    return { unreadable: true };
  }
  return { paths, env, copies, ...(cwd ? { cwd } : {}) };
}

/** The tool names that run a shell command, across the drivers (the union of the lists auto-approve, stop-line and
 *  mobile-push-risk read). */
const COMMAND_TOOL_NAMES = new Set(["bash", "shell", "sh", "zsh", "powershell", "pwsh", "execute", "exec_command", "run_command", "computer_exec",
  "terminal", "run_shell_command", "run_terminal_cmd"]);

/** The keys commandArgument reads a command from, so a key present in a shape it does not read still counts. */
const COMMAND_KEYS = ["command", "cmd", "script", "code"] as const;

/** Whether an ask runs a command: its call carries a command, or its tool is a command tool. */
function runsCommand(ask: Record<string, unknown>): boolean {
  const call = record(ask.toolCall);
  const input = record(call?.input);
  // the shared command reader's keys, read by the reader itself, and any of those keys present in another shape
  if (commandArgument(input) !== undefined || COMMAND_KEYS.some((key) => input?.[key] !== undefined)) return true;
  const name = typeof call?.name === "string" ? call.name : typeof ask.tool === "string" ? ask.tool : "";
  return COMMAND_TOOL_NAMES.has(name.toLowerCase().replace(/^mcp__.+__/, "").split(".").pop()!);
}

function isFolder(real: string): boolean {
  try { return statSync(real).isDirectory(); } catch { return false; }
}

const baseName = (path: string): string => (path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "");

/** The destinations a copy derives: for each operand that is a folder on disk, the folder joined with the basename of
 *  every other operand (the Rule 75 write target of `cp a dir`). */
function derivedTargets(copies: readonly string[][], cwd: string, home: string): { paths: string[]; cannot: boolean } {
  const paths: string[] = [];
  for (const operands of copies) {
    for (const operand of operands) {
      const placed = realPathInOrder(operand, cwd, { home });
      if ("cannot" in placed || !isFolder(placed.real)) continue;
      for (const other of operands) {
        if (other === operand) continue;
        const name = baseName(other);
        if (!name || name === "." || name === "..") continue;
        const joined = joinReal(placed.real, name);
        if ("cannot" in joined) return { paths, cannot: true };
        paths.push(joined.path);
      }
    }
  }
  return { paths, cannot: false };
}

function within(base: string, target: string): boolean {
  if (target === base) return true;
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return target.startsWith(base.endsWith(sep) ? base : base + sep);
}

function matches(entry: StartupEntry, real: string, intermediates: readonly string[], devIno: string | undefined): boolean {
  if (entry.under) return within(entry.real, real) || intermediates.some((step) => within(entry.real, step));
  if (entry.real === real || intermediates.includes(entry.real)) return true;
  return entry.devIno !== undefined && entry.devIno === devIno;
}

/** Whether a permission ask touches a startup file of the owner's (Rules 35, 74a, 74d): any target it names, placed by
 *  real path, is one of the Rule 74d list by real path, intermediate or device and inode. A target that cannot be
 *  placed, or a command that cannot be read whole, counts as touching. */
export function askTouchesStartup(ask: Record<string, unknown>): boolean {
  if (askTexts(ask).some((text) => AUTORUN.some((row) => row.re.test(text)))) return true;
  // Interim (Astra build r8 item 2), until the walker-based targetsOf (Rule 75e) reads a command's every target: a command is
  // not read whole, so every command ask counts as touching and its allow re-captures.
  if (runsCommand(ask)) return true;
  const named = targetsOfAsk(ask);
  if ("unreadable" in named) return true;
  if (!named.paths.length) return false;
  for (const handed of knownHands()) {
    const set = startupSet(handed, named.env, named.cwd);
    if (set.cannot) return true;
    const home = handed.ownerStartup?.HOME ?? handed.env.HOME ?? homedir();
    for (const path of named.paths) {
      const placed = realPathInOrder(path, named.cwd ?? "", { home });
      if ("cannot" in placed) return true;
      const devIno = devInoOf(placed.real);
      if (set.entries.some((entry) => matches(entry, placed.real, placed.intermediates, devIno))) return true;
    }
    // a copy into a folder writes the folder plus a derived name; a copied folder holds every startup file under it
    const derived = derivedTargets(named.copies, named.cwd ?? "", home);
    if (derived.cannot) return true;
    for (const path of derived.paths) {
      const placed = realPathInOrder(path, named.cwd ?? "", { home });
      if ("cannot" in placed) return true;
      const devIno = devInoOf(placed.real);
      if (set.entries.some((entry) => matches(entry, placed.real, placed.intermediates, devIno) || within(placed.real, entry.real))) return true;
    }
  }
  return false;
}
