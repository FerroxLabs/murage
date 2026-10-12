// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Is a coding engine closed? Murage removes a deleted conversation from an engine's own files ONLY while that engine is closed
// (engine-exec.ts brackets every home with this check, before and after its steps). The answer is one of three:
//   closed    no process of this user is the engine, and none of the engine's own lock files or locks says it is working
//   open      a process is the engine, or one of its locks is held
//   unknown   something could not be read (a process whose program or arguments cannot be seen, a lock that could not be probed)
// Open and unknown are treated the same by the caller: nothing is touched and the home stays pending.
//
// A process is the engine by its program (the executable's file name, or the application bundle it lives in) or, for a command
// line tool that another program runs (node, python, bun), by an argument that names the engine's package or script. Processes of
// other users are not looked at: an engine's files belong to the user whose engine it is. Murage's own process is never an engine.
import nodePath from "node:path";

import type { NativeProcess } from "./engine-exclusion.ts";
import { exclOps, mutOps } from "./engine-fs.ts";

export type ClosedState = "closed" | "open" | "unknown";

interface Matcher {
  /** executable file names (lower case, no .exe) and, for a launcher that keeps the name, the first argument's file name */
  names: string[];
  /** executable file names that start with one of these */
  prefixes?: string[];
  /** a pattern for the full path of the executable (an application bundle, a versioned install folder) */
  paths?: RegExp[];
  /** an argument that contains one of these (with "/" for every separator) belongs to the engine's package */
  packages?: string[];
  /** an argument whose file name, without .py .js .mjs .cjs .exe, is one of these (a script run by an interpreter) */
  scripts?: string[];
}

const MATCHERS: Record<string, Matcher> = {
  claude: { names: ["claude"], paths: [/[\\/]Claude\.app[\\/]/i, /[\\/]claude[\\/]versions[\\/]/i], packages: ["@anthropic-ai/claude-code"] },
  codex: { names: ["codex", "codex-app-server"], packages: ["@openai/codex"] },
  fuigo: { names: ["fuigo", "grok"] },
  grok: { names: ["fuigo", "grok"] },
  gemini: { names: ["gemini"], packages: ["@google/gemini-cli"] },
  qwen: { names: ["qwen"], packages: ["@qwen-code/"] },
  kimi: { names: ["kimi", "kimi-cli"], scripts: ["kimi", "kimi-cli", "kimi_cli"], packages: ["kimi_cli"] },
  hermes: { names: ["hermes"], scripts: ["hermes"], packages: ["hermes_agent", "hermes-agent"] },
  opencode: { names: ["opencode"], packages: ["opencode-ai"] },
  droid: { names: ["droid"] },
  cursor: { names: ["cursor-agent", "cursor"], paths: [/[\\/]Cursor\.app[\\/]/i, /[\\/]cursor-agent[\\/]/i], packages: ["cursor-agent"] },
  antigravity: { names: ["agy", "antigravity"], prefixes: ["language_server"], paths: [/[\\/]Antigravity\.app[\\/]/i] },
};

/** Programs that run another program's script: when their arguments cannot be read, what they run cannot be told. */
const INTERPRETER = /^(node|nodejs|bun|deno|electron|python|python3|python3\.\d+|pythonw|uv|uvx|npx|pnpm|tsx|ruby|perl)$/;

const slash = (text: string): string => text.replace(/\\/g, "/");
const fileName = (path: string): string => nodePath.win32.basename(slash(path)).toLowerCase().replace(/\.exe$/, "");
const scriptName = (path: string): string => fileName(path).replace(/\.(py|js|mjs|cjs)$/, "");

/** closed / open / unknown from the process list alone. */
export function processState(engine: string, processes: readonly NativeProcess[], ownPid: number = exclOps.ownPid()): ClosedState {
  const matcher = MATCHERS[engine];
  if (!matcher) return "unknown";
  let unknown = false;
  for (const proc of processes) {
    if (proc.pid === ownPid || proc.mine === false) continue;
    if (proc.exe === null) {
      // A process of this user whose program cannot be seen could be the engine.
      if (proc.mine === true) unknown = true;
      continue;
    }
    if (proc.exe === "") continue; // no program: a zombie
    const name = fileName(proc.exe);
    if (matcher.names.includes(name) || matcher.prefixes?.some((prefix) => name.startsWith(prefix)) || matcher.paths?.some((pattern) => pattern.test(proc.exe!))) return "open";
    if (proc.argv === null) {
      if (INTERPRETER.test(name)) unknown = true;
      continue;
    }
    const argv = proc.argv;
    if (argv[0] && matcher.names.includes(fileName(argv[0]))) return "open";
    if (matcher.packages && argv.some((argument) => matcher.packages!.some((pkg) => slash(argument).includes(pkg)))) return "open";
    if (matcher.scripts && argv.slice(0, 4).some((argument) => matcher.scripts!.includes(scriptName(argument)))) return "open";
  }
  return unknown ? "unknown" : "closed";
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
}

/** Is `engine`, whose files are under `home`, closed right now? */
export function engineState(engine: string, home: string, options: ClosedOptions = {}): ClosedState {
  let processes: NativeProcess[];
  try { processes = exclOps.processes(); } catch { return "unknown"; }
  const states: ClosedState[] = [processState(engine, processes)];
  if (states[0] === "open") return "open";
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
  return worst(...states);
}
