// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The contract: Murage starts only when the engine is closed, and edits only under the engine's own lock.
//
// Is a coding engine closed? This is the POLICY GATE of engine-history deletion: it decides whether Murage tries a file now and whether a
// home counts as finished. It is not what keeps an engine's file safe from a write that lands while the engine starts a moment after the
// answer: that is the hold on the file, the compare of the planned bytes just before each write, and the crash journal (engine-exec.ts).
// The answer is one of three, and says how it was reached (`via`):
//   closed    no process is the engine, and none of the engine's own lock files or locks says it is working
//   open      a process is the engine (whoever runs it), or one of its locks is held
//   unknown   something could not be read: the process list, a process whose program or arguments cannot be seen, a lock
// Open and unknown are told apart to the owner ("is open" only when it is open) and treated alike by the caller: nothing is touched
// and the home stays pending.
//
// How a process is judged (processVerdict), process by process, the worst answer winning. `name` is the file name of the program, or
// the name the system gives the process when the program cannot be seen.
//   1. It IS the engine, whoever owns it: its name or name prefix is the engine's, its program is in the engine's application bundle,
//      an argument names the engine's package or script, or its program or one of its first arguments is (by real path) the program
//      Murage is configured to run for this engine. A command line tool that another program runs (node, python, bun) is judged by
//      the script it runs too, by name and by where the link to it leads (`node ~/.nvm/.../bin/claude` runs the package's cli.js).
//   2. It is a program that runs another program's script (INTERPRETER) and its arguments cannot be read: unknown, unless the
//      system says it belongs to another ordinary user (not root, not this user), whose scripts are not this user's engine.
//   3. Neither its program nor its name can be read: unknown. Anything else that is not the engine and not an interpreter (a Windows
//      System or Registry process, a shell, a browser) contributes nothing.
import nodePath from "node:path";

import type { NativeProcess } from "./engine-exclusion.ts";
import { exclOps, mutOps } from "./engine-fs.ts";

export type ClosedState = "closed" | "open" | "unknown";
/** The answer and how it was reached: from the processes, from the engine's own locks, or because the process list could not be had. `app`:
 * the desktop application that is open (Claude, Cursor), when that is what made the engine count as open. */
export interface EngineVerdict { state: ClosedState; via: "process" | "lock" | "enumeration"; app?: string }

interface Matcher {
  /** executable file names (lower case, no .exe) and, for a launcher that keeps the name, the first argument's file name */
  names: string[];
  /** executable file names that start with one of these */
  prefixes?: string[];
  /** a pattern for the full path of the executable (a versioned install folder) */
  paths?: RegExp[];
  /** a desktop application bundle: a program inside one counts as the engine and the owner is told the application's name */
  apps?: Array<{ pattern: RegExp; label: string }>;
  /** an argument that contains one of these (with "/" for every separator) belongs to the engine's package */
  packages?: string[];
  /** an argument whose file name, without .py .js .mjs .cjs .exe, is one of these (a script run by an interpreter) */
  scripts?: string[];
  /** a process of the engine that stays running whether or not the engine is in use (a managed daemon): it is not "the engine is open";
   * the engine's own locks say when it is working */
  background?: (argv: readonly string[]) => boolean;
}

const MATCHERS: Record<string, Matcher> = {
  claude: { names: ["claude"], paths: [/[\\/]claude[\\/]versions[\\/]/i], apps: [{ pattern: /[\\/]Claude\.app[\\/]/i, label: "Claude" }], packages: ["@anthropic-ai/claude-code", "@anthropic-ai/claude-agent-sdk"] },
  // Codex starts `codex app-server --listen unix:// --managed-daemon` (and `app-server daemon pid-update-loop`) that outlives the terminal for
  // as long as the machine is up. It is not the engine in use: while Codex works it holds thread-writer-locks/<id>.lock (about a minute
  // after the terminal closes) and the history.jsonl lock, and those are what engineState reads for Codex.
  codex: { names: ["codex", "codex-app-server"], prefixes: ["codex"], packages: ["@openai/codex"], background: (argv) => argv.includes("--managed-daemon") || (argv.includes("app-server") && argv.includes("daemon")) },
  fuigo: { names: ["fuigo", "grok"] },
  grok: { names: ["fuigo", "grok"] },
  gemini: { names: ["gemini"], packages: ["@google/gemini-cli"] },
  qwen: { names: ["qwen"], packages: ["@qwen-code/"] },
  kimi: { names: ["kimi", "kimi-cli"], scripts: ["kimi", "kimi-cli", "kimi_cli"], packages: ["kimi_cli"] },
  hermes: { names: ["hermes"], scripts: ["hermes"], packages: ["hermes_agent", "hermes-agent", "hermes_cli"] },
  opencode: { names: ["opencode"], packages: ["opencode-ai"] },
  droid: { names: ["droid"], prefixes: ["droid"] },
  cursor: { names: ["cursor-agent", "cursor"], paths: [/[\\/]cursor-agent[\\/]/i], apps: [{ pattern: /[\\/]Cursor\.app[\\/]/i, label: "Cursor" }], packages: ["cursor-agent"] },
  antigravity: { names: ["agy", "antigravity"], prefixes: ["language_server"], apps: [{ pattern: /[\\/]Antigravity\.app[\\/]/i, label: "Antigravity" }] },
};

/** Programs that run another program's script, with or without a version (node-24, python3.12, bun1): when their arguments cannot be
 * read, what they run cannot be told. */
const INTERPRETER = /^(node|nodejs|bun|deno|electron|python|pythonw|uv|uvx|npx|pnpm|tsx|ruby|perl)(-?\d+(\.\d+)*)?$/;

const slash = (text: string): string => text.replace(/\\/g, "/");
const fileName = (path: string): string => nodePath.win32.basename(slash(path)).toLowerCase().replace(/\.exe$/, "");
const scriptName = (path: string): string => fileName(path).replace(/\.(py|js|mjs|cjs)$/, "");
const looksLikePath = (text: string): boolean => /[\\/]/.test(text) || /^[A-Za-z]:/.test(text);
const identityKey = (path: string): string => (exclOps.mode === "win32" ? slash(path).toLowerCase() : path);

export interface ProcessVerdict { state: ClosedState; app?: string }

/** closed / open / unknown from the process list alone. `identities`: the real paths of the programs Murage is configured to run for this engine. */
export function processVerdict(engine: string, processes: readonly NativeProcess[], ownPid: number = exclOps.ownPid(), identities: readonly string[] = []): ProcessVerdict {
  const matcher = MATCHERS[engine];
  if (!matcher) return { state: "unknown" };
  const known = new Set(identities.map(identityKey));
  const resolved = (path: string): string | null => {
    if (!known.size || !looksLikePath(path)) return null;
    const real = exclOps.realpathOf(path);
    return real === null ? null : identityKey(real);
  };
  let unknown = false, open = false, plain = false, app: string | undefined;
  for (const proc of processes) {
    if (proc.pid === ownPid) continue;
    const exe = proc.exe ?? null;
    const comm = proc.comm ?? null;
    const name = exe !== null ? fileName(exe) : comm !== null ? fileName(comm) : null;
    const argv = proc.argv ?? null;
    if (argv !== null && matcher.background?.(argv)) continue;
    // 1. it is the engine, whoever owns it
    let bundle: string | undefined;
    if (exe !== null) bundle = matcher.apps?.find((item) => item.pattern.test(exe))?.label;
    let isEngine = bundle !== undefined;
    let isPlain = false;
    if (!isEngine && name !== null && name !== "" && (matcher.names.includes(name) || matcher.prefixes?.some((prefix) => name.startsWith(prefix)))) isEngine = isPlain = true;
    if (!isEngine && exe !== null && matcher.paths?.some((pattern) => pattern.test(exe))) isEngine = isPlain = true;
    if (!isEngine && argv !== null) {
      if (argv[0] && matcher.names.includes(fileName(argv[0]))) isEngine = isPlain = true;
      else if (matcher.packages && argv.some((argument) => matcher.packages!.some((pkg) => slash(argument).includes(pkg)))) isEngine = isPlain = true;
      else if (matcher.scripts && argv.slice(0, 4).some((argument) => matcher.scripts!.includes(scriptName(argument)))) isEngine = isPlain = true;
    }
    if (!isEngine && known.size) {
      const candidates = [exe, ...(argv ?? []).slice(0, 4)].filter((item): item is string => typeof item === "string" && item !== "");
      if (candidates.some((candidate) => known.has(identityKey(candidate)) || (resolved(candidate) !== null && known.has(resolved(candidate)!)))) isEngine = isPlain = true;
    }
    // an interpreter running the engine's script: by the script's name, and by where the link to the script leads
    if (!isEngine && name !== null && INTERPRETER.test(name) && argv !== null) {
      const script = argv.slice(1, 4).find((argument) => argument !== "" && !argument.startsWith("-"));
      if (script !== undefined) {
        if (matcher.names.includes(scriptName(script)) || matcher.scripts?.includes(scriptName(script))) isEngine = isPlain = true;
        else if (matcher.packages && looksLikePath(script)) {
          const real = exclOps.realpathOf(script);
          if (real !== null && matcher.packages.some((pkg) => slash(real).includes(pkg))) isEngine = isPlain = true;
        }
      }
    }
    if (isEngine) {
      open = true;
      if (isPlain) plain = true; else app ??= bundle;
      continue;
    }
    // 2. an interpreter whose arguments cannot be read
    if (name !== null && INTERPRETER.test(name) && argv === null) {
      const uid = proc.uid ?? null;
      const other = exclOps.mode === "posix" && uid !== null && uid !== 0 && uid !== exclOps.ownUid();
      if (!other) unknown = true;
      continue;
    }
    // 3. neither the program nor its name can be read
    if (exe === null && comm === null) unknown = true;
  }
  if (open) return plain || app === undefined ? { state: "open" } : { state: "open", app };
  return { state: unknown ? "unknown" : "closed" };
}

/** closed / open / unknown from the process list alone (see processVerdict for the app that is open). */
export function processState(engine: string, processes: readonly NativeProcess[], ownPid: number = exclOps.ownPid(), identities: readonly string[] = []): ClosedState {
  return processVerdict(engine, processes, ownPid, identities).state;
}

const CLAUDE_LOCK_STALE_MS = 10_000;

/** Is a file's whole-file lock taken by someone else? Probed by taking it and letting go at once. A file that is not there is not locked. */
function lockHeld(path: string): ClosedState {
  try {
    if (exclOps.mtimeOf(path) === null) return "closed";
    if (exclOps.mode === "win32") {
      const held = exclOps.openFile(path, "shared");
      if (!held) return "open";
      try { return held.lock() ? "closed" : "open"; } finally { mutOps.close(held); }
    }
    const fd = mutOps.openRead(path);
    try { return exclOps.lock(fd) ? "closed" : "open"; } finally { mutOps.close(fd); }
  } catch { return "unknown"; }
}

/** A SQLite store another process is writing: BEGIN IMMEDIATE cannot be taken. */
function databaseBusy(path: string): ClosedState {
  try {
    if (exclOps.mtimeOf(path) === null) return "closed";
    const db = mutOps.openDbWrite(path, "PRAGMA busy_timeout=250;") as unknown as { exec(sql: string): void; close(): void };
    try {
      try { db.exec("BEGIN IMMEDIATE"); } catch (error) { return /busy|locked/i.test(String((error as Error)?.message)) ? "open" : "unknown"; }
      try { db.exec("ROLLBACK"); } catch { return "unknown"; }
      return "closed";
    } finally { db.close(); }
  } catch { return "unknown"; }
}

const worst = (...states: ClosedState[]): ClosedState => (states.includes("open") ? "open" : states.includes("unknown") ? "unknown" : "closed");

export interface ClosedOptions {
  /** the SQLite files of this home a plan will change (Hermes, OpenCode: probed with BEGIN IMMEDIATE) */
  dbs?: readonly string[];
  now?: number;
  /** Murage's own history lock is there (Claude): it is not a sign that Claude is working */
  ignoreHistoryLock?: boolean;
  /** the real paths of the programs Murage is configured to run for this engine (a renamed copy still counts as the engine) */
  identities?: readonly string[];
}

/** A process list that is not the whole machine is no answer: it must hold this process and, where a parent always exists, its parent. */
function sane(processes: readonly NativeProcess[]): boolean {
  const own = exclOps.ownPid();
  if (!processes.some((proc) => proc.pid === own)) return false;
  const parent = exclOps.ownPpid();
  return exclOps.mode === "win32" || parent <= 0 || processes.some((proc) => proc.pid === parent);
}

/** Is `engine`, whose files are under `home`, closed right now? */
export function engineState(engine: string, home: string, options: ClosedOptions = {}): EngineVerdict {
  let processes: NativeProcess[];
  try {
    processes = exclOps.processes();
    if (!Array.isArray(processes) || !sane(processes)) return { state: "unknown", via: "enumeration" };
  } catch { return { state: "unknown", via: "enumeration" }; }
  const seen = processVerdict(engine, processes, exclOps.ownPid(), options.identities);
  if (seen.state === "open") return { state: "open", via: "process", ...(seen.app ? { app: seen.app } : {}) };
  const states: ClosedState[] = [];
  const at = (...parts: string[]) => nodePath.join(home, ...parts);
  try {
    if (engine === "claude") {
      const lock = exclOps.mtimeOf(at("history.jsonl.lock"));
      if (lock !== null && !options.ignoreHistoryLock && (options.now ?? Date.now()) - lock < CLAUDE_LOCK_STALE_MS) states.push("open");
      // an IDE's lock file names the process that wrote it: open while that process is running, and when it cannot be read
      for (const name of exclOps.namesIn(at("ide")).filter((item) => item.endsWith(".lock"))) {
        let pid: unknown;
        try { pid = (JSON.parse(exclOps.textOf(at("ide", name)) ?? "") as { pid?: unknown }).pid; } catch { states.push("open"); continue; }
        if (typeof pid !== "number") states.push("open");
        else if (processes.some((proc) => proc.pid === pid && proc.pid !== exclOps.ownPid())) states.push("open");
      }
    } else if (engine === "codex") {
      states.push(lockHeld(at("history.jsonl")));
      const writers = at("thread-writer-locks");
      for (const name of exclOps.namesIn(writers).filter((item) => item.endsWith(".lock"))) states.push(lockHeld(nodePath.join(writers, name)));
    } else if (engine === "fuigo" || engine === "grok") {
      states.push(lockHeld(at("logs", "unified.jsonl")));
    } else if (engine === "hermes" || engine === "opencode") {
      for (const db of options.dbs ?? []) states.push(databaseBusy(db));
    }
  } catch { states.push("unknown"); }
  const fromLocks = worst(...states);
  if (fromLocks === "open") return { state: "open", via: "lock" };
  if (seen.state === "unknown" || fromLocks === "unknown") return { state: "unknown", via: seen.state === "unknown" ? "process" : "lock" };
  return { state: "closed", via: "process" };
}
