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
//   open      a process is the engine (whoever runs it) on this home (homeScope: its own environment names this home, or cannot
//             be read), or one of its locks is held
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
import { sha16 } from "./engine-plan-core.ts";

export type ClosedState = "closed" | "open" | "unknown";
/** The answer and how it was reached: from the processes, from the engine's own locks, or because the process list could not be had. `app`:
 * the desktop application that is open (Claude, Cursor), when that is what made the engine count as open. */
export interface EngineVerdict { state: ClosedState; via: "process" | "lock" | "enumeration"; app?: string; /** see ProcessVerdict */ unknownBy?: ProcessVerdict["unknownBy"]; /** see ProcessVerdict */ holders?: ProcessVerdict["holders"] }

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
  // The Claude app: its own program and its helpers (Contents/MacOS, Contents/Frameworks), never Contents/Helpers, where Chrome starts
  // the "Claude in Chrome" native host whenever Chrome runs, with the app closed. On Windows the app lives in AnthropicClaude, next to
  // its updater and the same native host: only the app's own program there (app-<version>\claude.exe) is the app.
  claude: { names: ["claude"], paths: [/[\\/]claude[\\/]versions[\\/]/i], apps: [{ pattern: /[\\/]Claude\.app[\\/]Contents[\\/](MacOS|Frameworks)[\\/]/i, label: "Claude" }, { pattern: /[\\/]AnthropicClaude[\\/]app-[^\\/]+[\\/]claude\.exe$/i, label: "Claude" }], packages: ["@anthropic-ai/claude-code", "@anthropic-ai/claude-agent-sdk"] },
  // Codex starts `codex app-server --listen unix:// --managed-daemon` (and `app-server daemon pid-update-loop`) that outlives the terminal for
  // as long as the machine is up. It is not the engine in use: while Codex works it holds thread-writer-locks/<id>.lock (about a minute
  // after the terminal closes) and the history.jsonl lock, and those are what engineState reads for Codex.
  codex: { names: ["codex", "codex-app-server"], prefixes: ["codex"], packages: ["@openai/codex"], background: (argv) => argv.includes("--managed-daemon") || (argv.includes("app-server") && argv.includes("daemon")) },
  fuigo: { names: ["fuigo", "grok"] },
  grok: { names: ["fuigo", "grok"] },
  gemini: { names: ["gemini"], packages: ["@google/gemini-cli"] },
  qwen: { names: ["qwen"], packages: ["@qwen-code/"] },
  kimi: { names: ["kimi", "kimi-cli"], scripts: ["kimi", "kimi-cli", "kimi_cli"], packages: ["kimi_cli"] },
  // Hermes' gateway (`hermes_cli.main ... gateway run`, the two words together) stays up for days whether or not Hermes is in use;
  // Hermes' own database lock says when it is writing (engineState probes it). A folder or profile named "gateway" is not the gateway.
  hermes: { names: ["hermes"], scripts: ["hermes"], packages: ["hermes_agent", "hermes-agent", "hermes_cli"], background: (argv) => { const at = argv.indexOf("gateway"); return at >= 0 && argv[at + 1] === "run"; } },
  opencode: { names: ["opencode"], packages: ["opencode-ai"] },
  droid: { names: ["droid"], prefixes: ["droid"] },
  cursor: { names: ["cursor-agent", "cursor"], paths: [/[\\/]cursor-agent[\\/]/i], apps: [{ pattern: /[\\/]Cursor\.app[\\/]/i, label: "Cursor" }], packages: ["cursor-agent"] },
  // Antigravity's language server is a program of its own (language_server_macos_arm, ...); other editors ship one of the same name
  // (Windsurf, Codeium), so it counts only from Antigravity's own install folder.
  antigravity: { names: ["agy", "antigravity"], paths: [/antigravity[^\\/]*[\\/].*language_server[^\\/]*$/i], apps: [{ pattern: /[\\/]Antigravity\.app[\\/]/i, label: "Antigravity" }] },
};

/** Programs that run another program's script, with or without a version (node-24, python3.12, bun1): when their arguments cannot be
 * read, what they run cannot be told. */
const INTERPRETER = /^(node|nodejs|bun|deno|electron|python|pythonw|uv|uvx|npx|pnpm|tsx|ruby|perl)(-?\d+(\.\d+)*)?$/;

const slash = (text: string): string => text.replace(/\\/g, "/");
const fileName = (path: string): string => nodePath.win32.basename(slash(path)).toLowerCase().replace(/\.exe$/, "");
const scriptName = (path: string): string => fileName(path).replace(/\.(py|js|mjs|cjs)$/, "");
const looksLikePath = (text: string): boolean => /[\\/]/.test(text) || /^[A-Za-z]:/.test(text);
const identityKey = (path: string): string => (exclOps.mode === "win32" ? slash(path).toLowerCase() : path);

export interface ProcessVerdict {
  state: ClosedState;
  app?: string;
  /** when the answer is unknown: the processes that made it so (pid, the name read, the owner), for a log line or a test message */
  unknownBy?: Array<{ pid: number; name: string | null; uid: number | null; why: "arguments" | "program" }>;
  /** when the answer is open: the processes that made it so (pid, parent, image, the first arguments, which rule matched), for a log line or a test message */
  holders?: Array<{ pid: number; ppid: number; name: string | null; exe: string | null; argv: string[]; by: string }>;
}

/** The holders ride along as a non-enumerable field: a diagnostic for the log line and test messages that no comparison of verdicts sees. */
function withHolders<T extends object>(verdict: T, holders: readonly unknown[]): T {
  if (holders.length) Object.defineProperty(verdict, "holders", { value: holders.slice(0, 5), enumerable: false });
  // what holds it, by program and rule, over EVERY holder (the list above keeps five): what a repeated log line is compared on
  if (holders.length) Object.defineProperty(verdict, "holderKinds", { value: [...new Set(holders.map((item) => { const h = item as { name?: string | null; by?: string }; return `${h.name ?? ""}|${h.by ?? ""}`; }))].sort(), enumerable: false });
  return verdict;
}

/** closed / open / unknown from the process list alone. `identities`: the real paths of the programs Murage is configured to run for this engine.
 * `counts` (a private scope, see engineState): whether a process that IS the engine counts toward open: true yes, false no, null it
 * cannot be told (its arguments cannot be read), which makes the answer unknown, as an unreadable interpreter does. */
export function processVerdict(engine: string, processes: readonly NativeProcess[], ownPid: number = exclOps.ownPid(), identities: readonly string[] = [], counts?: (proc: NativeProcess) => boolean | null): ProcessVerdict {
  const matcher = MATCHERS[engine];
  if (!matcher) return { state: "unknown" };
  const known = new Set(identities.map(identityKey));
  const resolved = (path: string): string | null => {
    if (!known.size || !looksLikePath(path)) return null;
    const real = exclOps.realpathOf(path);
    return real === null ? null : identityKey(real);
  };
  let open = false, plain = false, app: string | undefined;
  const unknownBy: NonNullable<ProcessVerdict["unknownBy"]> = [];
  const holders: NonNullable<ProcessVerdict["holders"]> = [];
  for (const proc of processes) {
    if (proc.pid === ownPid) continue;
    const exe = proc.exe ?? null;
    const comm = proc.comm ?? null;
    const name = exe !== null ? fileName(exe) : comm !== null ? fileName(comm) : null;
    const argv = proc.argv ?? null;
    // An interpreter by its program, or (its program unreadable: another user's process on Linux) by the first argument the system
    // still shows: Linux's own name for a process is its main thread's, which Node sets to "MainThread".
    const interpreter = (name !== null && INTERPRETER.test(name)) || (exe === null && !!argv?.[0] && INTERPRETER.test(fileName(argv[0])));
    if (argv !== null && matcher.background?.(argv)) continue;
    // 1. it is the engine, whoever owns it
    let bundle: string | undefined;
    if (exe !== null) bundle = matcher.apps?.find((item) => item.pattern.test(exe))?.label;
    let isEngine = bundle !== undefined;
    let isPlain = false;
    let by = bundle !== undefined ? "app" : "";
    if (!isEngine && name !== null && name !== "" && (matcher.names.includes(name) || matcher.prefixes?.some((prefix) => name.startsWith(prefix)))) { isEngine = isPlain = true; by = "program name"; }
    if (!isEngine && exe !== null && matcher.paths?.some((pattern) => pattern.test(exe))) { isEngine = isPlain = true; by = "install path"; }
    if (!isEngine && argv !== null) {
      if (argv[0] && matcher.names.includes(fileName(argv[0]))) { isEngine = isPlain = true; by = "argv[0] name"; }
      else if (matcher.packages && argv.some((argument) => matcher.packages!.some((pkg) => slash(argument).includes(pkg)))) { isEngine = isPlain = true; by = "package in arguments"; }
      else if (matcher.scripts && argv.slice(0, 4).some((argument) => matcher.scripts!.includes(scriptName(argument)))) { isEngine = isPlain = true; by = "script name"; }
    }
    if (!isEngine && known.size) {
      const candidates = [exe, ...(argv ?? []).slice(0, 4)].filter((item): item is string => typeof item === "string" && item !== "");
      if (candidates.some((candidate) => known.has(identityKey(candidate)) || (resolved(candidate) !== null && known.has(resolved(candidate)!)))) { isEngine = isPlain = true; by = "configured program"; }
    }
    // an interpreter running the engine's script: by the script's name, and by where the link to the script leads
    if (!isEngine && interpreter && argv !== null) {
      const script = argv.slice(1, 4).find((argument) => argument !== "" && !argument.startsWith("-"));
      if (script !== undefined) {
        if (matcher.names.includes(scriptName(script)) || matcher.scripts?.includes(scriptName(script))) { isEngine = isPlain = true; by = "interpreter script name"; }
        else if (matcher.packages && looksLikePath(script)) {
          const real = exclOps.realpathOf(script);
          if (real !== null && matcher.packages.some((pkg) => slash(real).includes(pkg))) { isEngine = isPlain = true; by = "interpreter script package"; }
        }
      }
    }
    if (isEngine && counts) {
      const named = counts(proc);
      if (named === false) continue;
      if (named === null) { unknownBy.push({ pid: proc.pid, name, uid: proc.uid ?? null, why: "arguments" }); continue; }
    }
    if (isEngine) {
      open = true;
      holders.push({ pid: proc.pid, ppid: proc.ppid, name, exe, argv: (argv ?? []).slice(0, 4).map((item) => item.slice(0, 200)), by });
      if (isPlain) plain = true; else app ??= bundle;
      continue;
    }
    // 2. an interpreter whose arguments cannot be read
    if (interpreter && argv === null) {
      const uid = proc.uid ?? null;
      const other = exclOps.mode === "posix" && uid !== null && uid !== 0 && uid !== exclOps.ownUid();
      if (!other) unknownBy.push({ pid: proc.pid, name, uid, why: "arguments" });
      continue;
    }
    // 3. neither the program nor its name can be read
    if (exe === null && comm === null) unknownBy.push({ pid: proc.pid, name: null, uid: proc.uid ?? null, why: "program" });
  }
  if (open) return withHolders(plain || app === undefined ? { state: "open" } : { state: "open", app }, holders);
  return unknownBy.length ? { state: "unknown", unknownBy } : { state: "closed" };
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
      // read only: a lock can be taken on a handle opened for reading, and a file the owner made read only is still looked at
      const held = exclOps.openFile(path, "probe");
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

// ── Murage's private engine scopes ───────────────────────────────────────
//
// Codex and Grok run Murage's turns in a scope of Murage's own (drivers/scoped-cli-home.ts): `<data folder>/native/<engine>-scope/<id>`,
// one per bot, given to the engine as CODEX_HOME / GROK_HOME. The owner's own Codex or Grok reads ~/.codex or ~/.grok and never opens
// a scope, so a scope's gate does not ask whether Codex or Grok runs somewhere on the machine (F16 design, phase 2 r3).
//
// A home is PRIVATE only when ALL of these hold, read again at every call (a scope that changes mid-run falls to the machine-wide gate):
//   it is `<native>/<engine>-scope/<id>` for engine codex or grok; the scope folder and the home are real folders, not links or junctions;
//   its .murage-scope.json parses, with `realHome` an absolute path and `botId` an id; `id` is scopeId(realHome, botId); `subdir` is
//   empty or absent; the marker points at no login generation and the home holds no `login-g<N>` folder.
//
// The private gate (engineState): an unreadable or partial process list is unknown, as everywhere. A process that IS the engine counts
// toward open only when one of its arguments names the scope (the path itself or a path under it; Windows compares case folded with
// "/" for "\"), and one whose arguments cannot be read makes the answer unknown. The engine's own locks inside the scope count exactly
// as for any other home. Murage's own engine processes on the scope are proven closed by the hold on them (holdHomes) before anything
// is planned, and a busy one skips the scope.
//
// STATED LIMIT (accepted, Sean's standing approval after the review-round cap, 2026-10-23): a process started OUTSIDE Murage with only
// its environment pointing at a scope (CODEX_HOME=<scope> codex resume <id>), whose arguments do not name the scope and which holds
// none of the scope's files or locks at that moment, is not seen. Pointing an engine at Murage's private folder is unsupported. A
// deletion removes only the files of the conversation being deleted (keyed by its thread ids and working folder, with the owner checks
// of the planners), so the only session this can affect is a deliberate out-of-Murage resume of that same deleted conversation: its
// next append can write lines of the deleted conversation back into Murage's private folder, or find its own transcript gone. No other
// conversation's data is ever removed or changed by it, and every write still runs under the engine's lock, an in-place compare or
// SQLite's transaction.
export const SCOPED_ENGINES: readonly string[] = ["codex", "grok"];
const SCOPE_MARKER = ".murage-scope.json";
const SCOPE_ID = /^[a-f0-9]{16}$/;
const BOT_ID = /^[\w-]+$/;
const GENERATION_DIR = /^login-g\d+$/;

let configuredNative: string | null = null;
/** Where Murage's scopes are: `<data folder>/native`. The deletion service passes it to every engine-history job. Unset, no home is
 * private and every home has the machine-wide gate (the stricter answer). */
export function configureScopes(nativeDir: string | null | undefined): void { configuredNative = nativeDir || null; }
export const scopeRootOf = (nativeDir: string, engine: string): string => nodePath.join(nativeDir, `${engine}-scope`);
/** drivers/scoped-cli-home.ts scopeId, the same hash (a structure test keeps the two equal). */
export const scopeIdOf = (realHome: string, botId?: string | null): string => sha16(Buffer.from(JSON.stringify([realHome, botId ?? null])));

const realDir = (path: string): boolean => exclOps.isRealDir(path);

/** What `home` is: one of Murage's private scopes (with its bot), a scope that has login generations (never planned), or neither. */
export function scopeStateOf(engine: string, home: string, nativeDir: string | null = configuredNative): { kind: "private" | "generations"; botId: string } | { kind: "none" } {
  if (!nativeDir || !SCOPED_ENGINES.includes(engine)) return { kind: "none" };
  const root = scopeRootOf(nativeDir, engine);
  const id = nodePath.basename(home);
  if (nodePath.dirname(home) !== root || !SCOPE_ID.test(id) || !realDir(root) || !realDir(home)) return { kind: "none" };
  let marker: { realHome?: unknown; botId?: unknown; subdir?: unknown; generation?: unknown };
  try {
    const text = exclOps.textOf(nodePath.join(home, SCOPE_MARKER));
    if (text === null) return { kind: "none" };
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "none" };
    marker = parsed as typeof marker;
  } catch { return { kind: "none" }; }
  const { realHome, botId } = marker;
  if (typeof realHome !== "string" || !nodePath.isAbsolute(realHome) || typeof botId !== "string" || !BOT_ID.test(botId)) return { kind: "none" };
  if (scopeIdOf(realHome, botId) !== id) return { kind: "none" };
  if (marker.subdir !== undefined && marker.subdir !== "") return { kind: "none" };
  let names: string[];
  try { names = exclOps.namesIn(home); } catch { return { kind: "none" }; }
  if ((marker.generation !== undefined && marker.generation !== 0) || names.some((name) => GENERATION_DIR.test(name))) return { kind: "generations", botId };
  return { kind: "private", botId };
}

/** Is `home` one of Murage's PRIVATE scopes (the rule above)? */
export const privateScopeHome = (engine: string, home: string, nativeDir: string | null = configuredNative): boolean => scopeStateOf(engine, home, nativeDir).kind === "private";

/** Is `home` inside an engine's scope folder at all (private or not)? Such a home is planned and recovered only while it is PRIVATE. */
export function inScopeFolder(engine: string, home: string, nativeDir: string | null = configuredNative): boolean {
  if (!nativeDir || !SCOPED_ENGINES.includes(engine)) return false;
  const root = scopeRootOf(nativeDir, engine);
  return home === root || home.startsWith(`${root}${nodePath.sep}`);
}

/** Every scope of these bots that a deletion covers, found from the scopes' own markers (never from an instance's current environment,
 * so a removed instance or a changed CODEX_HOME / GROK_HOME still finds them): PRIVATE ones to plan, and ones with login generations,
 * which are never planned (the deletion names them as a leftover). */
export function scopeCandidates(nativeDir: string, botIds: Iterable<string>): Array<{ engine: string; home: string; kind: "private" | "generations" }> {
  const bots = new Set(botIds);
  const out: Array<{ engine: string; home: string; kind: "private" | "generations" }> = [];
  if (!bots.size) return out;
  for (const engine of SCOPED_ENGINES) {
    const root = scopeRootOf(nativeDir, engine);
    let names: string[];
    try { names = realDir(root) ? exclOps.namesIn(root) : []; } catch { names = []; }
    for (const name of names.sort()) {
      const home = nodePath.join(root, name);
      const state = scopeStateOf(engine, home, nativeDir);
      if (state.kind !== "none" && bots.has(state.botId)) out.push({ engine, home, kind: state.kind });
    }
  }
  return out;
}

/** Does one of a process's arguments name the scope `keys` (the scope path, and its real path when that differs, as identityKey has
 * them): the path itself or a path under it, never another scope whose id merely starts the same. Null: the arguments cannot be read. */
function namesScope(keys: readonly string[]): (proc: NativeProcess) => boolean | null {
  const bounded = (text: string, key: string): boolean => {
    for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + 1)) {
      const next = text[at + key.length];
      if (next === undefined || next === "/" || next === "\\" || next === "\"" || next === "'") return true;
    }
    return false;
  };
  return (proc) => (proc.argv === null || proc.argv === undefined ? null : proc.argv.some((argument) => keys.some((key) => bounded(identityKey(argument), key))));
}

const scopeKeys = (home: string): string[] => {
  const keys = new Set([identityKey(home).replace(/[\\/]+$/, "")]);
  try { const real = exclOps.realpathOf(home); if (real !== null) keys.add(identityKey(real).replace(/[\\/]+$/, "")); } catch { /* the path as given */ }
  return [...keys];
};


// ── whose home is it ─────────────────────────────────────────────────────
//
// A process that IS the engine holds `home` only when the home its engine resolves from the process's OWN environment is that home,
// inside it, or around it (or around a SQLite file the plan changes). The resolution is engineHomeFor's (conversation-deletion.ts):
//   claude        CLAUDE_CONFIG_DIR, else <HOME>/.claude and <USERPROFILE>/.claude
//   codex         CODEX_HOME, else <user home>/.codex; and CODEX_SQLITE_HOME when it is set
//   fuigo, grok   by the process's own name: fuigo FUIGO_HOME or <user home>/.fuigo, grok GROK_HOME or <user home>/.grok (both when the
//                 name is neither, or it is the program Murage is configured to run); FUIGO_HOME and GROK_HOME whenever they are set
// Fail closed (the process counts, as before this rule): the addon cannot read its environment (another user's, protected, gone, an
// older build), it has no user home and no engine variable, a variable is a relative path, it was matched as a desktop application
// (whose engine home is not in its environment), or the engine is not one of these four. Paths are compared as written and by real
// path, case folded on Windows and macOS. (designs/ENGINE-CLOSED-SCOPE.md)
/** Paths of processes and homes are paths of this machine's file system: Windows rules (drive letters, either separator, case folded)
 * on Windows, and wherever the exclusion layer models Windows (tests). The addon's mode is the platform in the app; a test that runs the
 * POSIX model of the layer on a Windows machine still has Windows paths. */
const windowsPaths = (): boolean => exclOps.mode === "win32" || process.platform === "win32";
const pathApi = (): typeof nodePath.posix => (windowsPaths() ? nodePath.win32 : nodePath.posix);
export const HOME_SCOPED_ENGINES: readonly string[] = ["claude", "codex", "fuigo", "grok"];
/** The only variables of another process that are read: the ones that decide an engine's home. */
export const HOME_VARIABLES: readonly string[] = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CODEX_SQLITE_HOME", "FUIGO_HOME", "GROK_HOME"];

/** The homes `engine` uses in a process with this environment, or null when that cannot be told. */
export function homesOfProcess(engine: string, environment: Readonly<Record<string, string | undefined>>, names: readonly string[], configured: boolean): string[] | null {
  const api = pathApi();
  const value = (name: string): string | undefined => (typeof environment[name] === "string" && environment[name] !== "" ? environment[name] : undefined);
  // the user's home as the engine finds it: HOME on macOS and Linux (without it, the system's account record: not told here), and
  // on Windows USERPROFILE or HOME, whichever the engine reads
  const users = (windowsPaths() ? [value("HOME"), value("USERPROFILE")] : [value("HOME")]).filter((item): item is string => item !== undefined);
  const under = (variable: string, folder: string): string[] => { const set = value(variable); return set !== undefined ? [set] : users.map((user) => api.join(user, folder)); };
  let homes: string[];
  if (engine === "claude") homes = under("CLAUDE_CONFIG_DIR", ".claude");
  else if (engine === "codex") homes = [...under("CODEX_HOME", ".codex"), ...(value("CODEX_SQLITE_HOME") !== undefined ? [value("CODEX_SQLITE_HOME")!] : [])];
  else if (engine === "fuigo" || engine === "grok") {
    const kinds = new Set(names.filter((name) => name === "fuigo" || name === "grok"));
    if (configured || kinds.size === 0) { kinds.add("fuigo"); kinds.add("grok"); }
    homes = [...kinds].flatMap((kind) => under(kind === "fuigo" ? "FUIGO_HOME" : "GROK_HOME", `.${kind}`));
    for (const variable of ["FUIGO_HOME", "GROK_HOME"]) if (value(variable) !== undefined) homes.push(value(variable)!);
  } else return null;
  if (!homes.length || homes.some((home) => !api.isAbsolute(home))) return null;
  return [...new Set(homes)];
}

/** A path as it is compared: absolute, "/" for every separator, no trailing one, case folded where the file system folds it; and its
 * real path too, when that is different. */
function pathKeys(path: string): string[] {
  const api = pathApi();
  const fold = windowsPaths() || process.platform === "darwin";
  const key = (text: string): string => { const plain = slash(api.resolve(text)).replace(/\/+$/, ""); return fold ? plain.toLowerCase() : plain; };
  const keys = new Set([key(path)]);
  const real = exclOps.realpathOf(path);
  if (real !== null) keys.add(key(real));
  return [...keys];
}
const related = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** For engineState: does a process that IS the engine use `home` (or the folder of one of `dbs`)? Undefined: every one counts. */
export function homeScope(engine: string, home: string, dbs: readonly string[] = [], identities: readonly string[] = []): ((proc: NativeProcess) => boolean) | undefined {
  if (!HOME_SCOPED_ENGINES.includes(engine)) return undefined;
  const matcher = MATCHERS[engine]!;
  const api = pathApi();
  const targets = [home, ...dbs.map((db) => api.dirname(db))].flatMap(pathKeys);
  const known = identities.map(identityKey);
  return (proc) => {
    const exe = proc.exe ?? null;
    if (exe !== null && matcher.apps?.some((item) => item.pattern.test(exe))) return true;
    let environment: Record<string, string> | null;
    try { environment = exclOps.environment(proc.pid, HOME_VARIABLES); } catch { environment = null; }
    if (!environment) return true;
    const names = [exe, proc.comm ?? null, proc.argv?.[0] ?? null].filter((item): item is string => typeof item === "string" && item !== "").map(fileName);
    // the program Murage is configured to run for this engine, whatever its name (a renamed copy): the engine's own home counts too
    const configured = [exe, ...(proc.argv ?? []).slice(0, 4)].some((item) => typeof item === "string" && item !== "" && known.some((path) => path === identityKey(item) || (looksLikePath(item) && path === identityKey(exclOps.realpathOf(item) ?? ""))));
    const homes = homesOfProcess(engine, environment, names, configured);
    if (!homes) return true;
    return homes.flatMap(pathKeys).some((key) => targets.some((target) => related(key, target)));
  };
}

/** The processes Murage started itself, at any depth (its own engines and their helpers): this process and every descendant of it in
 * one snapshot of the process list. */
function ownTree(processes: readonly NativeProcess[], ownPid: number): Set<number> {
  // A parent's pid can be reused once it has exited (Windows keeps a child's parent id as it was): an edge counts only when the parent
  // on the list started no later than the child, so a process started under an old pid of Murage's is never taken for Murage's own.
  const started = new Map(processes.map((proc) => [proc.pid, proc.start]));
  const plausible = (proc: NativeProcess) => { const parent = started.get(proc.ppid), child = proc.start; return typeof parent !== "number" || typeof child !== "number" || parent <= 0 || child <= 0 || parent <= child; };
  const children = new Map<number, number[]>();
  for (const proc of processes) if (proc.pid !== proc.ppid && plausible(proc)) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid]);
  const own = new Set<number>([ownPid]);
  for (const queue = [ownPid]; queue.length;) for (const child of children.get(queue.pop()!) ?? []) if (!own.has(child)) { own.add(child); queue.push(child); }
  return own;
}

/** A cheap look before a deletion attempt holds anything (conversation-deletion.ts): is the engine open on `home` by a program Murage did
 * NOT start (the owner's own Claude Code, Grok or Codex in a terminal)? Counted with engineState's own rules (processVerdict and the same
 * home or scope gate), minus Murage's own process tree. "open" only when such a process was seen; anything else (closed, unknown, the list
 * could not be read) is "not-seen", and the attempt goes on to the full gate (engineState) as before. It only ever makes an attempt do
 * less: a home it calls open is left exactly as an engineState "open" leaves it. */
export function foreignEngineHolders(engine: string, home: string, options: Pick<ClosedOptions, "identities"> = {}): { state: "open" | "not-seen"; app?: string; holders?: ProcessVerdict["holders"]; /** no process outside Murage's own tree counts: every one that holds the home (if any) is Murage's own */ ownOnly?: true; /** program|rule of every holder, sorted (holders keeps five) */ kinds?: string[] } {
  let processes: NativeProcess[];
  try {
    processes = exclOps.processes();
    if (!Array.isArray(processes) || !sane(processes)) return { state: "not-seen" };
  } catch { return { state: "not-seen" }; }
  const own = ownTree(processes, exclOps.ownPid());
  const gate = privateScopeHome(engine, home) ? namesScope(scopeKeys(home)) : homeScope(engine, home, [], options.identities);
  const counts = (proc: NativeProcess): boolean | null => (own.has(proc.pid) ? false : gate ? gate(proc) : true);
  const seen = processVerdict(engine, processes, exclOps.ownPid(), options.identities, counts);
  if (seen.state !== "open") return seen.state === "closed" ? { state: "not-seen", ownOnly: true } : { state: "not-seen" };
  const kinds = (seen as { holderKinds?: string[] }).holderKinds;
  return { state: "open", ...(seen.app ? { app: seen.app } : {}), ...(seen.holders?.length ? { holders: seen.holders } : {}), ...(kinds?.length ? { kinds } : {}) };
}

/** Is `engine`, whose files are under `home`, closed right now? A PRIVATE scope (see above) has the private gate; any other home
 * counts only the engine processes on that home (homeScope). */
export function engineState(engine: string, home: string, options: ClosedOptions = {}): EngineVerdict {
  let processes: NativeProcess[];
  try {
    processes = exclOps.processes();
    if (!Array.isArray(processes) || !sane(processes)) return { state: "unknown", via: "enumeration" };
  } catch { return { state: "unknown", via: "enumeration" }; }
  // the private gate: only an engine process whose arguments name this scope counts (the stated limit is at the rule above);
  // elsewhere only an engine process on THIS home counts (homeScope, ENGINE-CLOSED-SCOPE.md); one whose home cannot be told counts
  const counts = privateScopeHome(engine, home) ? namesScope(scopeKeys(home)) : homeScope(engine, home, options.dbs, options.identities);
  let seen = processVerdict(engine, processes, exclOps.ownPid(), options.identities, counts);
  // A process that could not be read may be one that was ending as it was looked at (a hook's `node -e`, a dying interpreter): the
  // list is read once more, and only what is still unreadable then counts.
  if (seen.state === "unknown") {
    try {
      const again = exclOps.processes();
      if (Array.isArray(again) && sane(again)) { processes = again; seen = processVerdict(engine, again, exclOps.ownPid(), options.identities, counts); }
    } catch { /* the first answer stands */ }
  }
  if (seen.state === "open") return withHolders({ state: "open", via: "process", ...(seen.app ? { app: seen.app } : {}) }, seen.holders ?? []);
  const states: ClosedState[] = [];
  const at = (...parts: string[]) => nodePath.join(home, ...parts);
  try {
    if (engine === "claude") {
      const lock = exclOps.mtimeOf(at("history.jsonl.lock"));
      if (lock !== null && !options.ignoreHistoryLock && (options.now ?? Date.now()) - lock < CLAUDE_LOCK_STALE_MS) states.push("open");
      // an IDE's lock file names the process that wrote it: open while that process is running; one that cannot be read says nothing
      // either way (unknown: "is open" is said only when a process or a lock was seen)
      for (const name of exclOps.namesIn(at("ide")).filter((item) => item.endsWith(".lock"))) {
        let pid: unknown;
        try { pid = (JSON.parse(exclOps.textOf(at("ide", name)) ?? "") as { pid?: unknown }).pid; } catch { states.push("unknown"); continue; }
        if (typeof pid !== "number") states.push("unknown");
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
  if (seen.state === "unknown" || fromLocks === "unknown") return { state: "unknown", via: seen.state === "unknown" ? "process" : "lock", ...(seen.unknownBy ? { unknownBy: seen.unknownBy } : {}) };
  return { state: "closed", via: "process" };
}
