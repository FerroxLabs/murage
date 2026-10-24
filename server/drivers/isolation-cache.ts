// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-turn isolation setup is worked out once per set of inputs, not on every
// turn. An enumerator (plugin names, owner MCP servers, skills, a scoped home's
// entry list, project context files) runs under `memoDeps`: every file or
// folder it reads goes through `readText` / `listDir` / `pathExists`, which
// record it as a dependency. The next turn only stats those dependencies
// (mtime + size, or "missing"); if none changed the stored result is returned
// and nothing is rebuilt. Add, remove or edit an owner file and the next turn
// rebuilds. The key carries the rest of the inputs (Murage's server set, CLI
// version). `isolationStats` counts builds and hits per cache, for the tests.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { splitCliString, windowsCommandFile } from "../env-path.ts";

type Recorder = (path: string) => void;
let recorder: Recorder | null = null;

/** "missing", or "<mtimeMs>:<size>" of a file or folder (a folder's mtime moves when entries are added or removed). */
export function pathSig(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}

const note = (path: string) => recorder?.(path);
export function readText(path: string): string {
  note(path);
  return readFileSync(path, "utf8");
}
export function listDir(path: string): string[] {
  note(path);
  return readdirSync(path);
}
export function pathExists(path: string): boolean {
  note(path);
  return existsSync(path);
}
/** Record a dependency the enumerator reads some other way. */
export const trackPath = note;

interface Entry { value: unknown; deps: Array<[string, string]> }
const caches = new Map<string, Map<string, Entry>>();
const stats = new Map<string, { builds: number; hits: number }>();
const MAX_ENTRIES = 64;

export function isolationStats(name: string): { builds: number; hits: number } {
  return { ...(stats.get(name) ?? { builds: 0, hits: 0 }) };
}
export function resetIsolationCache(): void {
  caches.clear();
  stats.clear();
  resetVersionProbeBackoff();
}

/** Result of `build` for (name, key), reused while every path it read keeps its signature. */
export function memoDeps<T>(name: string, key: string, build: () => T): T {
  let cache = caches.get(name);
  if (!cache) caches.set(name, (cache = new Map()));
  const counter = stats.get(name) ?? { builds: 0, hits: 0 };
  stats.set(name, counter);
  const found = cache.get(key);
  if (found && found.deps.every(([path, sig]) => pathSig(path) === sig)) {
    counter.hits++;
    return found.value as T;
  }
  const seen = new Set<string>();
  const outer = recorder;
  recorder = (path) => { seen.add(path); outer?.(path); };
  let value: T;
  try {
    value = build();
  } finally {
    recorder = outer;
  }
  counter.builds++;
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { value, deps: [...seen].map((path) => [path, pathSig(path)] as [string, string]) });
  return value;
}

/** The file a CLI resolves to on `env`'s PATH (itself when it already names a path) with its "<mtime>:<size>"; null when not found. */
function cliFileSig(cli: string, env: Record<string, string | undefined>): { path: string; sig: string } | null {
  const candidates = isAbsolute(cli) || /[\\/]/.test(cli)
    ? [cli]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((dir) => process.platform === "win32" ? [".exe", ".cmd", ""].map((ext) => join(dir, cli + ext)) : [join(dir, cli)]);
  for (const path of candidates) {
    const sig = pathSig(path);
    if (sig !== "missing") return { path, sig };
  }
  return null;
}

/** "<resolved path>:<mtime>:<size>" of a CLI, found on PATH when it is a bare name; "unresolved" when not found. */
export function cliSig(cli: string, env: Record<string, string | undefined> = process.env): string {
  const found = cliFileSig(cli, env);
  return found ? `${found.path}:${found.sig}` : "unresolved";
}

/** The file cliSig signs for `cli` on `env`'s PATH, or null when none is found: the binary whose `--version` a driver
 *  probed. A spawn handed another PATH (the owner's captured shell PATH, engine-env.ts) launches this file, so the
 *  version the driver gated on and the catalog it showed belong to the process that runs. */
export function cliFile(cli: string, env: Record<string, string | undefined> = process.env): string | null {
  return cliFileSig(cli, env)?.path ?? null;
}

/** The engine executable a turn spawns: on macOS and Linux, a bare command name (the whole cli, or the head word of a
 *  cli that carries fixed arguments, `ag claude agp`) becomes the file cliFile finds on `env`, the env the driver's
 *  `--version` probe ran on (Murage's own PATH), so the handed map's PATH (the owner's captured shell PATH, which the
 *  child keeps for its own lookups) never picks a different, older build than the one Murage version-checked. A cli that
 *  already names a path is spawned as it is (spawn reports its own ENOENT). On Windows the bare name becomes the file
 *  found PATHEXT-aware on `env`'s PATH first, then on Murage's own PATH (env-path.ts whichWin), the same order execCli's
 *  `--version` probe uses: so a driver that puts its engine's folder first (the bundled Fuigo, or the Fuigo build it
 *  version-checked) runs that file, never an npm `.cmd` shim that happens to sit earlier on Murage's PATH. spawnCli then
 *  parses a `.cmd` it is handed down to the program it wraps. A name found nowhere is kept, so spawn reports its own
 *  ENOENT. A Cloud home runs the image's CLI by name and keeps `cli`. On macOS and Linux a bare name found nowhere on `env`
 *  throws ENOENT; it never falls back to whatever the shell PATH would find. */
export function engineLaunchFile(cli: string, env: Record<string, string | undefined>): string {
  if (process.env.MURAGE_CLOUD_ROLE === "home") return cli;
  const trimmed = cli.trim();
  // resolveCliSpawn's own order: an existing file whose path has spaces is one word, never split
  if (trimmed.includes(" ") && existsSync(trimmed)) return cli;
  const [head, ...fixed] = splitCliString(cli);
  if (!head || /[\\/]/.test(head) || (process.platform === "win32" && /^[a-zA-Z]:/.test(head))) return cli;
  const file = process.platform === "win32" ? windowsCommandFile(head, env.PATH) : cliFile(head, env);
  if (!file && process.platform === "win32") return cli;
  if (!file) {
    const error: NodeJS.ErrnoException = new Error(`spawn ${head} ENOENT`);
    error.code = "ENOENT";
    error.errno = -2;
    error.syscall = `spawn ${head}`;
    error.path = head;
    throw error;
  }
  if (fixed.length === 0) return file;
  // Re-quoted for resolveCliSpawn's one tokenizer pass (splitCliString), which strips the quotes again.
  const quote = (token: string): string => !token.includes("'") ? `'${token}'` : !token.includes('"') ? `"${token}"` : (() => {
    throw new Error(`the engine command ${JSON.stringify(cli)} has an argument with both quote characters; Murage cannot launch it`);
  })();
  return [file, ...fixed].map(quote).join(" ");
}

// A `--version` probe that fails (times out, exits non-zero, prints nothing)
// is remembered per CLI signature, so a working CLI with a slow or broken
// `--version` costs one probe per backoff window, not one per turn. The window
// doubles from VERSION_PROBE_BACKOFF_MIN_MS up to VERSION_PROBE_BACKOFF_MAX_MS;
// a changed CLI file (new signature) or a success starts over.
export const VERSION_PROBE_BACKOFF_MIN_MS = 30_000;
export const VERSION_PROBE_BACKOFF_MAX_MS = 15 * 60_000;
const versionFailures = new Map<string, { sig: string; failures: number; retryAt: number }>();

/** May the turn path probe `--version` for this CLI now? False only while a failure for the same signature is backing off. */
export function versionProbeAllowed(key: string, sig: string, now: number = Date.now()): boolean {
  const failed = versionFailures.get(key);
  return !failed || failed.sig !== sig || now >= failed.retryAt;
}

/** Record a probe's outcome for the backoff above. */
export function noteVersionProbe(key: string, sig: string, ok: boolean, now: number = Date.now()): void {
  if (ok) {
    versionFailures.delete(key);
    return;
  }
  const previous = versionFailures.get(key);
  const failures = previous && previous.sig === sig ? previous.failures + 1 : 1;
  const delay = Math.min(VERSION_PROBE_BACKOFF_MAX_MS, VERSION_PROBE_BACKOFF_MIN_MS * 2 ** Math.min(failures - 1, 16));
  if (versionFailures.size >= MAX_ENTRIES && !versionFailures.has(key)) versionFailures.delete(versionFailures.keys().next().value as string);
  versionFailures.set(key, { sig, failures, retryAt: now + delay });
}

export function resetVersionProbeBackoff(): void {
  versionFailures.clear();
  knownVersions.clear();
}

// A SUCCESSFUL `--version` is remembered per CLI key and signature (resolved path, mtime, size), for the whole process: every driver
// instance and every turn that names the same, unchanged binary reads it back instead of spawning it again. A replaced file (new
// mtime or size) has a new signature, so an update is re-probed once.
const knownVersions = new Map<string, { sig: string; version: string }>();

/** The version a probe already read from this exact CLI file, or undefined (never probed, or the file changed since). */
export function knownCliVersion(key: string, sig: string): string | undefined {
  if (sig === "unresolved") return undefined;
  const known = knownVersions.get(key);
  return known && known.sig === sig ? known.version : undefined;
}

/** Remember a successful probe for `knownCliVersion`. */
export function rememberCliVersion(key: string, sig: string, version: string): void {
  if (sig === "unresolved" || !version) return;
  if (knownVersions.size >= MAX_ENTRIES && !knownVersions.has(key)) knownVersions.delete(knownVersions.keys().next().value as string);
  knownVersions.set(key, { sig, version });
}
