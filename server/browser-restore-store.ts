// SPDX-License-Identifier: AGPL-3.0-or-later
// The bot's saved browser session, split so a relaunch answers at once.
//
// Pinned agent-browser 0.36.0 restores a saved session at launch (cli/src/native/state.rs
// load_state): cookies in one call, then a real Page.navigate to EVERY saved origin that
// has localStorage or sessionStorage, with a 500 ms sleep each, all before the first
// command answers. A used profile holds many origins, so N x (navigate + 0.5 s) ran past
// the 20 s command bound and could pass the 60 s start bound too.
//
// Before the engine starts, Murage moves the per-origin storage out of the engine's state
// file into its own store beside it, leaving the cookies. The engine then restores only
// the cookies at launch (one call). Each origin's storage goes back the first time the
// bot goes there (browser-native-relay.ts), once per engine run.
//
// The engine's next save (at its idle exit) holds the cookies and the storage of every
// origin it visited. At the next launch that save is merged in: an origin in the save
// replaces Murage's copy; an origin visited this run (restored by Murage, or reached by the
// owner) but missing from the save was emptied by the site (a sign-out), so Murage's copy
// goes too; any other origin was never opened this run and is kept. An origin not seen for
// 90 days is forgotten, and the store keeps at most the 500 most recently seen. The engine itself only ever kept what it visited
// in its last run, so this keeps more of the bot's sign-ins, never fewer.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import type { AgentBrowserSpec } from "./browser-engine.ts";

export type StorageEntry = { name: string; value: string };
export type OriginStorage = { localStorage: StorageEntry[]; sessionStorage: StorageEntry[] };
type EngineOrigin = { origin?: unknown; localStorage?: unknown; sessionStorage?: unknown };
/** One origin in Murage's store, with when it was last seen (merged in, restored or reached by the owner). */
type StoredOrigin = OriginStorage & { seenAt: number };
type Sidecar = {
  version: 1;
  origins: Record<string, StoredOrigin>;
  /** Origins visited during the current engine run: restored by Murage, or reached by the owner. */
  visited: string[];
  /** sha256 of the engine state file Murage last wrote: unchanged means the engine has not saved since. */
  written: string;
};

/** Murage's half of the store. Not a name the engine reads: it matches `<session>-*.json[.enc]` only. */
const SIDECAR_SUFFIX = ".murage-storage.enc";
/** An origin not seen for this long is forgotten. */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** The store keeps at most this many origins, the most recently seen. */
const MAX_ORIGINS = 500;

// The engine's own file encryption (state.rs encrypt_data): AES-256-GCM, key = sha256(key text),
// a 12-byte nonce first, the 16-byte tag last.
function keyOf(text: string) { return createHash("sha256").update(text, "utf8").digest(); }
export function encryptEngineData(data: Buffer, key: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(key), nonce);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}
export function decryptEngineData(data: Buffer, key: string): Buffer {
  if (data.length < 12 + 16 + 1) throw new Error("Saved browser state is too short");
  const decipher = createDecipheriv("aes-256-gcm", keyOf(key), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]);
}

/** Where the engine keeps saved sessions: `~/.agent-browser/sessions` (state.rs get_sessions_dir).
 * Its home comes from `dirs` 5, which reads HOME on macOS and Linux and the profile folder on
 * Windows, so Windows also looks in the server's own profile folder. */
export function engineSessionDirs(spec: AgentBrowserSpec): string[] {
  const dirs = [spec.env.HOME, spec.env.USERPROFILE, process.platform === "win32" ? homedir() : undefined]
    .filter((home): home is string => !!home).map(home => join(home, ".agent-browser", "sessions"));
  return [...new Set(dirs)];
}

/** The file the engine restores at launch: the newest `<session>-*.json` or `.json.enc` (state.rs find_auto_state_file). */
export function newestEngineState(dir: string, session: string): string | undefined {
  let best: { path: string; at: number } | undefined;
  let names: string[];
  try { names = readdirSync(dir); } catch { return undefined; }
  for (const name of names) {
    if (!name.startsWith(`${session}-`) || !(name.endsWith(".json") || name.endsWith(".json.enc"))) continue;
    const path = join(dir, name);
    let at: number;
    try { at = statSync(path).mtimeMs; } catch { continue; }
    if (!best || at > best.at) best = { path, at };
  }
  return best?.path;
}

function entries(value: unknown): StorageEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is StorageEntry => !!item && typeof item.name === "string" && typeof item.value === "string")
    .map(({ name, value }) => ({ name, value }));
}
function readJson(path: string, key: string): { bytes: Buffer; value: unknown } {
  const bytes = readFileSync(path);
  const text = path.endsWith(".enc") ? decryptEngineData(bytes, key).toString("utf8") : bytes.toString("utf8");
  return { bytes, value: JSON.parse(text) };
}
function writeJson(path: string, key: string, value: unknown): Buffer {
  const text = Buffer.from(JSON.stringify(value, null, 2), "utf8");
  const bytes = path.endsWith(".enc") ? encryptEngineData(text, key) : text;
  writeFileAtomic(path, bytes, { mode: 0o600 });
  return bytes;
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function readSidecar(path: string, key: string, now: number): Sidecar {
  const empty: Sidecar = { version: 1, origins: {}, visited: [], written: "" };
  if (!existsSync(path)) return empty;
  // A store Murage cannot read is replaced by the next launch's save, never trusted.
  try {
    const value = readJson(path, key).value as (Partial<Sidecar> & { restored?: unknown }) | null;
    if (!value || value.version !== 1 || !value.origins || typeof value.origins !== "object") return empty;
    const origins: Record<string, StoredOrigin> = {};
    for (const [origin, storage] of Object.entries(value.origins)) {
      // A copy written before seenAt existed counts as seen now.
      const seenAt = typeof storage?.seenAt === "number" && Number.isFinite(storage.seenAt) ? storage.seenAt : now;
      origins[origin] = { localStorage: entries(storage?.localStorage), sessionStorage: entries(storage?.sessionStorage), seenAt };
    }
    // `restored` is the list's earlier name.
    const visited: unknown = value.visited ?? value.restored;
    return { version: 1, origins, visited: Array.isArray(visited) ? visited.filter((o): o is string => typeof o === "string") : [], written: typeof value.written === "string" ? value.written : "" };
  } catch { return empty; }
}

/** Forgets origins not seen for MAX_AGE_MS, then all but the MAX_ORIGINS most recently seen. Returns how many went. */
function prune(sidecar: Sidecar, now: number): number {
  let dropped = 0;
  for (const [origin, stored] of Object.entries(sidecar.origins)) {
    if (now - stored.seenAt > MAX_AGE_MS) { delete sidecar.origins[origin]; dropped++; }
  }
  const kept = Object.entries(sidecar.origins);
  if (kept.length > MAX_ORIGINS) {
    kept.sort((a, b) => b[1].seenAt - a[1].seenAt);
    for (const [origin] of kept.slice(MAX_ORIGINS)) { delete sidecar.origins[origin]; dropped++; }
  }
  return dropped;
}

/** An address's origin as the browser names it (`location.origin`), or undefined for none. */
export function originOf(address: string): string | undefined {
  try { const url = new URL(address); return /^https?:$/u.test(url.protocol) && url.origin !== "null" ? url.origin : undefined; } catch { return undefined; }
}

export interface RestoreSession {
  /** Origins holding saved storage at this launch. */
  readonly origins: number;
  /** True while some saved origin has not gone back into the browser yet. */
  waiting(): boolean;
  /** The saved storage for an origin not restored this run yet. */
  pending(origin: string): OriginStorage | undefined;
  /** This origin's storage is back in the browser: never again this run. */
  restored(origin: string): void;
  /** The owner reached this origin themselves: what they did there wins, so Murage restores nothing over it. */
  passed(origin: string): void;
  /** One attempt to put this origin's storage back failed (its pages land elsewhere): no more tries this run.
   * Its saved copy stays for the next run. */
  abandoned(origin: string): void;
}

/** Split the saved session before the engine starts (no daemon is running). Returns the
 * restore session for this engine run, or undefined when this browser keeps no saved state. */
export function prepareBrowserRestore(spec: AgentBrowserSpec, log: (line: string) => void = line => console.log(line)): RestoreSession | undefined {
  const session = spec.env.AGENT_BROWSER_RESTORE;
  const key = spec.env.AGENT_BROWSER_ENCRYPTION_KEY;
  if (!session || !key || spec.env.AGENT_BROWSER_RESTORE_SAVE !== "auto") return undefined;
  const started = Date.now();
  const dirs = engineSessionDirs(spec);
  let dir = dirs.find(candidate => newestEngineState(candidate, session));
  dir ??= dirs.find(candidate => existsSync(join(candidate, `${session}${SIDECAR_SUFFIX}`)));
  if (!dir) return undefined;
  const sidecarPath = join(dir, `${session}${SIDECAR_SUFFIX}`);
  const sidecar = readSidecar(sidecarPath, key, started);
  const enginePath = newestEngineState(dir, session);
  let cookies = 0;
  let pruned = 0;
  let wrote = false;
  if (enginePath) {
    let read: { bytes: Buffer; value: unknown } | undefined;
    // An engine file Murage cannot read is left exactly as it is; the engine reports it itself.
    // A fixed phrase only: a parse error's message can quote the file, which holds sign-ins.
    try { read = readJson(enginePath, key); } catch { log("[browser] saved session could not be read; the engine restores it as before"); }
    const state = read?.value as { cookies?: unknown; origins?: unknown } | null | undefined;
    if (read && state && typeof state === "object" && Array.isArray(state.cookies)) {
      cookies = state.cookies.length;
      if (digest(read.bytes) !== sidecar.written) {
        // The engine saved since Murage last wrote this file: take in what it saved.
        const saved = new Set<string>();
        for (const item of Array.isArray(state.origins) ? state.origins as EngineOrigin[] : []) {
          if (typeof item?.origin !== "string") continue;
          const storage = { localStorage: entries(item.localStorage), sessionStorage: entries(item.sessionStorage) };
          if (!storage.localStorage.length && !storage.sessionStorage.length) continue;
          sidecar.origins[item.origin] = { ...storage, seenAt: started };
          saved.add(item.origin);
        }
        // Visited this run, then missing from the engine's save: the site emptied it.
        for (const origin of sidecar.visited) if (!saved.has(origin)) delete sidecar.origins[origin];
      }
      sidecar.visited = [];
      pruned = prune(sidecar, started);
      const split = { ...state, origins: [] };
      // The new file's digest is recorded first, so a stop between the two writes only repeats the merge.
      const text = Buffer.from(JSON.stringify(split, null, 2), "utf8");
      const bytes = enginePath.endsWith(".enc") ? encryptEngineData(text, key) : text;
      sidecar.written = digest(bytes);
      writeJson(sidecarPath, key, sidecar);
      writeFileAtomic(enginePath, bytes, { mode: 0o600 });
      wrote = true;
    }
  } else sidecar.visited = [];
  const save = () => { try { writeJson(sidecarPath, key, sidecar); } catch (error) { log(`[browser] restore store could not be saved (${(error as Error).message})`); } };
  if (!wrote) { pruned = prune(sidecar, started); if (pruned) save(); }
  if (pruned) log(`[browser] restore store: dropped ${pruned} origins not seen in 90 days or past the ${MAX_ORIGINS} most recently seen`);
  const origins = new Map(Object.entries(sidecar.origins).map(([origin, { localStorage, sessionStorage }]) => [origin, { localStorage, sessionStorage }]));
  /** This run visited the origin: kept on disk, so the next merge drops it if the engine's save no longer holds it. */
  const visit = (origin: string) => {
    origins.delete(origin);
    const stored = sidecar.origins[origin];
    if (stored) stored.seenAt = Date.now();
    if (sidecar.visited.includes(origin)) return;
    sidecar.visited.push(origin);
    save();
  };
  log(`[browser] restore store: ${origins.size} origins with saved storage, ${cookies} cookies; the engine restores the cookies at launch and each origin's storage on the bot's first visit (prepared in ${Date.now() - started} ms)`);
  return {
    origins: origins.size,
    waiting: () => origins.size > 0,
    pending: (origin) => origins.get(origin),
    restored: visit,
    passed: visit,
    abandoned(origin) { origins.delete(origin); },
  };
}

/** The script that puts one origin's storage back, run on a page of that origin. It does
 * nothing on any other origin, and answers with a word the caller looks for. */
export function restoreScript(origin: string, storage: OriginStorage): string {
  return `(() => { const d = ${JSON.stringify({ origin, ...storage })};
  if (location.origin !== d.origin) return "murage-restore-elsewhere";
  let failed = 0;
  for (const e of d.localStorage) { try { localStorage.setItem(e.name, e.value); } catch { failed++; } }
  for (const e of d.sessionStorage) { try { sessionStorage.setItem(e.name, e.value); } catch { failed++; } }
  return failed ? "murage-restore-partial" : "murage-restore-done"; })()`;
}
