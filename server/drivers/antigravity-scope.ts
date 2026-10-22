// Antigravity (`agy`) reads its whole setup from `$HOME/.gemini`: MCP servers
// (config/mcp_config.json and plugins), hooks, skills, workflows, rules and
// the GEMINI.md / AGENTS.md instruction files. It has no flag or environment
// variable that moves or narrows any of them (checked against agy 1.3.3).
//
// So each Murage turn runs agy with a Murage-owned HOME: the owner's real home
// mirrored entry by entry (login, keychain, conversations, git and ssh setup
// all resolve to the real files), except the personal items listed below,
// which are simply absent. The one file Murage writes is the scoped copy of
// mcp_config.json holding Murage's own servers. The owner's own ~/.gemini is
// never written to for tools or config.
//
// HOW ENTRIES ARE MIRRORED. Folders are symlinks (junctions on Windows, which
// need no privilege). Files are symlinks where the OS allows it; where it does
// not (an ordinary Windows account without Developer Mode), a hard link (no
// privilege, same volume), else a copy of a small file. A file in the home
// root that none of these can mirror (a locked NTUSER.DAT) is left out; one
// under ~/.gemini that cannot be mirrored stops the build (the caller fails
// open). Murage's servers are mounted the same way on every OS.
//
// RECONCILE, NEVER DISCARD. On dispose (and, for a crashed run, at the next
// start, from the manifest written beside the scoped home):
//   - an entry agy created in the scoped tree moves into the real home; if the
//     real home has gained the same folder meanwhile (two first turns), the
//     two are merged entry by entry;
//   - a mirrored file agy replaced (temp file + rename over our link, or a
//     changed copy) is written back through to the real file, in place, so a
//     refreshed login reaches the owner's real file and a symlinked real file
//     stays a symlink;
//   - when both sides changed, the newer one wins and the other is kept under
//     native/antigravity-kept/, as is anything that cannot be reconciled.
//     "Newer" is the time agy WROTE each side (the scoped file's mtime against
//     the real file's), never the time of the reconcile: a file written through
//     keeps its source's mtime, so a later reconcile of an older write cannot
//     look newer than it is. Reads, compares and write-backs of one real file
//     run under a lock shared by every Murage process (native/antigravity-locks),
//     so two scopes disposing at once cannot interleave.
// OWNERSHIP. Each manifest names the server process that built the scope and,
// once spawned, the agy child (pid + start time). Startup recovery touches a
// scope only when its owner and its child are provably gone: a detached agy
// that outlived a crashed server keeps its home, its login refresh and its
// conversation writes, until it exits.
// Nothing agy wrote is deleted without first being reconciled or kept.
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { listDir, memoDeps, pathExists } from "./isolation-cache.ts";
import { ownProcessRecord, processRunning, recordOf, sleepSync, type ProcessRecord } from "./process-identity.ts";

/** Names under ~/.gemini that carry the owner's personal instructions. */
export const ANTIGRAVITY_PERSONAL_GEMINI_ENTRIES = ["GEMINI.md", "AGENTS.md"] as const;
/** Names under ~/.gemini/config that are personal: tools, hooks, skills,
 * workflows and rules. `mcp_config.json` is replaced, not mirrored. */
export const ANTIGRAVITY_PERSONAL_CONFIG_ENTRIES = [
  "mcp_config.json",
  "plugins",
  "plugins.json",
  "hooks.json",
  "skills",
  "skills.json",
  "rules",
  "rules.json",
  "workflows",
  "workflows.json",
  "global_workflows",
  "sidecars",
  "GEMINI.md",
  "AGENTS.md",
] as const;
/** Names under ~/.gemini/antigravity-cli that are personal. */
export const ANTIGRAVITY_PERSONAL_CLI_ENTRIES = ["hooks.json"] as const;

/** A file copied instead of linked is at most this big under ~/.gemini, and at the home root. */
export const MIRROR_COPY_MAX_BYTES = 64 * 1024 * 1024;
export const MIRROR_ROOT_COPY_MAX_BYTES = 1024 * 1024;

export interface AntigravityMcpEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AntigravityScopedHome {
  /** The HOME (and USERPROFILE) to give the agy child. */
  home: string;
  /** Record the agy child that runs in this home (pid + start time), so a restart after a crash does not reconcile or remove the home of a child that is still running. Call right after the spawn. */
  adoptChild: (pid: number | undefined) => void;
  /** Reconciles what agy wrote into the real home, then removes the scoped tree. Idempotent. */
  dispose: () => void;
}

/** File operations the mirror uses; replaceable so tests can act as a Windows account without symlink rights. */
export interface MirrorOps {
  symlink: (target: string, path: string, type?: "dir" | "file" | "junction") => void;
  link: (existing: string, path: string) => void;
  copyFile: (from: string, to: string) => void;
}
const NODE_OPS: MirrorOps = {
  symlink: (target, path, type) => symlinkSync(target, path, type),
  link: (existing, path) => linkSync(existing, path),
  copyFile: (from, to) => copyFileSync(from, to),
};

/** How one entry of a scoped folder was mirrored, and what the real one looked like then. */
export interface MirrorRecord {
  /** Path relative to the scoped home. */
  rel: string;
  real: string;
  kind: "symlink" | "junction" | "hardlink" | "copy";
  /** Signature of the real file at build time (files only). */
  realSig?: string;
  /** sha256 of a copied file's bytes at build time. */
  copyHash?: string;
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A folder's entry names and which are folders, worked out once until the folder changes. */
function listing(dir: string): Array<[string, boolean]> {
  return memoDeps("agy-entries", dir, () => {
    try {
      return listDir(dir).map((name) => [name, isDirectory(join(dir, name))] as [string, boolean]);
    } catch {
      pathExists(dir);
      return [];
    }
  });
}
/** Uncached: the scoped tree changes during the turn. */
function freshEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** mtime, size and inode of a file, following links; "missing" when absent. */
function fileSig(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return "missing";
  }
}
function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface MirrorOptions {
  ops?: MirrorOps;
  platform?: NodeJS.Platform;
  /** Allow the hard-link and copy fallbacks for files (callers that reconcile on dispose). */
  fallback?: boolean;
  /** Entries that cannot be mirrored at all are left out instead of failing (the home root). */
  skipUnmirrorable?: boolean;
  /** Prefix for MirrorRecord.rel. */
  relBase?: string;
}

/** Mirror every entry of `realDir` into `scopedDir`, except `omit`, which the caller handles. Returns what was mirrored and how. */
export function mirrorDirectory(realDir: string, scopedDir: string, omit: ReadonlySet<string>, options: MirrorOptions = {}): MirrorRecord[] {
  const ops = options.ops ?? NODE_OPS;
  const windows = (options.platform ?? process.platform) === "win32";
  const records: MirrorRecord[] = [];
  mkdirSync(scopedDir, { recursive: true, mode: 0o700 });
  for (const [name, isDir] of listing(realDir)) {
    if (omit.has(name)) continue;
    const real = join(realDir, name);
    const scoped = join(scopedDir, name);
    const rel = options.relBase ? join(options.relBase, name) : name;
    if (isDir) {
      try {
        ops.symlink(real, scoped, windows ? "junction" : undefined);
        records.push({ rel, real, kind: windows ? "junction" : "symlink" });
      } catch (error) {
        if (!options.skipUnmirrorable) throw error;
      }
      continue;
    }
    const realSig = fileSig(real);
    try {
      ops.symlink(real, scoped, windows ? "file" : undefined);
      records.push({ rel, real, kind: "symlink", realSig });
      continue;
    } catch (error) {
      if (!options.fallback) {
        if (options.skipUnmirrorable) continue;
        throw error;
      }
    }
    try {
      ops.link(real, scoped);
      records.push({ rel, real, kind: "hardlink", realSig });
      continue;
    } catch { /* another volume, or a file that cannot be linked: try a copy */ }
    try {
      const limit = options.skipUnmirrorable ? MIRROR_ROOT_COPY_MAX_BYTES : MIRROR_COPY_MAX_BYTES;
      if (statSync(real).size > limit) throw new Error(`${name} is too large to copy into the scoped home`);
      ops.copyFile(real, scoped);
      records.push({ rel, real, kind: "copy", realSig, copyHash: hashFile(scoped) });
    } catch (error) {
      rmSync(scoped, { force: true });
      if (!options.skipUnmirrorable) throw error;
    }
  }
  return records;
}

/** The scoped folders Murage itself creates, relative to the scoped home, with what each leaves out. */
function scopedLevels(): Array<{ rel: string; omit: ReadonlySet<string> }> {
  return [
    { rel: "", omit: new Set([".gemini"]) },
    { rel: ".gemini", omit: new Set([...ANTIGRAVITY_PERSONAL_GEMINI_ENTRIES, "config", "antigravity-cli"]) },
    { rel: join(".gemini", "config"), omit: new Set(ANTIGRAVITY_PERSONAL_CONFIG_ENTRIES) },
    { rel: join(".gemini", "antigravity-cli"), omit: new Set(ANTIGRAVITY_PERSONAL_CLI_ENTRIES) },
  ];
}

interface ScopeManifest {
  realHome: string;
  home: string;
  records: MirrorRecord[];
  /** Murage wrote the scoped mcp_config.json (it is Murage's, and goes with the tree). */
  mounted: boolean;
  /** Murage wrote the scoped hooks.json of an Ask turn (it is Murage's, and goes with the tree). */
  askHook?: boolean;
  /** The server process that built the scope. */
  owner?: ProcessRecord;
  /** The agy child that runs in it, once spawned. */
  child?: ProcessRecord;
}
/** Scopes of this process that have not been disposed. */
const liveScopes = new Set<string>();

/** A restart simulated in a test: this process forgets the scopes it was running. */
export function forgetLiveScopes(): void {
  liveScopes.clear();
}

function writeManifest(manifest: ScopeManifest): void {
  const path = manifestPath(manifest.home);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(manifest), { mode: 0o600 });
  try { renameSync(temp, path); } catch (error) { rmSync(temp, { force: true }); throw error; }
}
const manifestPath = (home: string) => `${home}.manifest.json`;
/** Where entries that cannot be reconciled are kept: beside the scope root, Murage-owned. */
const keptRoot = (scopeRoot: string) => join(dirname(scopeRoot), "antigravity-kept");

/** Build the scoped home. Throws when it cannot (disk full, an unmirrorable login file); the caller fails open. */
export function buildAntigravityScopedHome(options: {
  realHome: string;
  scopeRoot: string;
  name: string;
  servers: Record<string, AntigravityMcpEntry | undefined>;
  /** An Ask turn's hooks.json (the Ask hard stop, ../ask-stop.ts): written as .gemini/config/hooks.json, Murage's
   *  own file that goes with the tree like the mount file. The owner's own hooks.json is never mirrored. */
  askStopHooks?: string;
  ops?: MirrorOps;
  platform?: NodeJS.Platform;
}): AntigravityScopedHome {
  const { realHome, scopeRoot, name } = options;
  const home = join(scopeRoot, name);
  if ((existsSync(home) || existsSync(manifestPath(home))) && recoverScopedHome(scopeRoot, name) === "running") {
    throw new Error(`the scoped home ${name} still belongs to a running Antigravity process`);
  }
  mkdirSync(scopeRoot, { recursive: true, mode: 0o700 });
  chmodSync(scopeRoot, 0o700);
  const records: MirrorRecord[] = [];
  let mounted = false;
  let askHook = false;
  try {
    for (const level of scopedLevels()) {
      records.push(...mirrorDirectory(join(realHome, level.rel), join(home, level.rel), level.omit, {
        ops: options.ops,
        platform: options.platform,
        fallback: true,
        skipUnmirrorable: level.rel === "",
        relBase: level.rel,
      }));
    }
    const servers: Record<string, AntigravityMcpEntry> = {};
    for (const [key, value] of Object.entries(options.servers)) {
      if (value) servers[key] = { command: value.command, args: [...value.args], env: { ...value.env } };
    }
    // Only when there is something to mount: a tool-less turn gets no file at all.
    if (Object.keys(servers).length) {
      const path = join(home, ".gemini", "config", "mcp_config.json");
      writeFileSync(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    mounted = Object.keys(servers).length > 0;
    if (options.askStopHooks !== undefined) {
      const path = join(home, ".gemini", "config", "hooks.json");
      writeFileSync(path, options.askStopHooks, { mode: 0o600 });
      chmodSync(path, 0o600);
      askHook = true;
    }
    // Written before the turn runs, so a crash mid-turn can still be reconciled at the next start.
    writeManifest({ realHome, home, records, mounted, askHook, owner: ownProcessRecord() });
    liveScopes.add(home);
  } catch (error) {
    // Nothing has run in it yet: only our own links and copies are there.
    rmSync(home, { recursive: true, force: true });
    rmSync(manifestPath(home), { force: true });
    throw error;
  }

  let disposed = false;
  let child: ProcessRecord | undefined;
  return {
    home,
    adoptChild: (pid) => {
      child = recordOf(pid);
      if (!child) return;
      try {
        writeManifest({ realHome, home, records, mounted, askHook, owner: ownProcessRecord(), child });
      } catch (error) {
        console.warn(`antigravity scope ${name}: child not recorded: ${(error as Error).message}`);
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      liveScopes.delete(home);
      try {
        // A child still running keeps its home: the next start reconciles it once it has exited.
        if (child && processRunning(child)) {
          console.warn(`antigravity scope ${name}: reconcile deferred: the agy process is still running`);
          return;
        }
        reconcileScopedHome({ realHome, home, records, mounted, askHook }, keptRoot(scopeRoot), name);
      } catch (error) {
        // The tree and its manifest stay; the next start reconciles them.
        console.warn(`antigravity scope ${name}: reconcile deferred: ${(error as Error).message}`);
      }
    },
  };
}

/**
 * A scoped home left by a run that stopped before its dispose: reconcile it
 * from its manifest, or, without one, keep the whole tree. Called at start for
 * every leftover, and before a name is reused. A home whose owner (the server
 * that built it) or agy child is still running is NOT touched: "running" is
 * returned and nothing is reconciled, kept or removed.
 */
export function recoverScopedHome(scopeRoot: string, name: string): "recovered" | "running" {
  const home = join(scopeRoot, name);
  if (liveScopes.has(home)) return "running";
  let manifest: ScopeManifest | null = null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(home), "utf8")) as ScopeManifest;
    if (parsed && typeof parsed.realHome === "string" && Array.isArray(parsed.records)) manifest = { ...parsed, home, mounted: parsed.mounted === true, askHook: parsed.askHook === true };
  } catch { /* no manifest: keep the tree below */ }
  if (manifest) {
    const owner = manifest.owner;
    // Another server process that is still running owns it (its own disposal reconciles). This very process
    // is not "another": a scope of ours that is not live is a deferred leftover.
    if (owner && Number.isInteger(owner.pid) && owner.pid !== process.pid && processRunning(owner)) return "running";
    // An agy that outlived a crashed server still writes its login and conversations here.
    if (manifest.child && Number.isInteger(manifest.child.pid) && processRunning(manifest.child)) return "running";
    reconcileScopedHome(manifest, keptRoot(scopeRoot), name);
    return "recovered";
  }
  // No manifest. A tree this process built is live (above); another process's tree is only kept if it is not
  // being built right now: a manifest is written within the build, so give a young tree the benefit of the doubt.
  try { if (Date.now() - statSync(home).mtimeMs < 60_000) return "running"; } catch { /* gone */ }
  if (existsSync(home)) moveInto(home, join(keptRoot(scopeRoot), `${name}-${Date.now()}`));
  rmSync(manifestPath(home), { force: true });
  return "recovered";
}

/** Every leftover scoped home under `scopeRoot`, reconciled or kept. */
export function recoverAllScopedHomes(scopeRoot: string): void {
  const names = new Set<string>();
  for (const entry of freshEntries(scopeRoot)) if (!entry.endsWith(".tmp")) names.add(entry.endsWith(".manifest.json") ? entry.slice(0, -".manifest.json".length) : entry);
  for (const name of names) {
    try { recoverScopedHome(scopeRoot, name); } catch { /* one bad leftover does not stop the rest */ }
  }
}

function moveInto(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** Replace the contents of `realPath` with `bytes` without replacing a symlink: the resolved target is written (temp + rename in its own folder), its mode kept. `mtimeMs` stamps the result with the time the bytes were WRITTEN by their source, so write-back order never reads as freshness. */
export function writeThrough(realPath: string, bytes: Buffer | string, mtimeMs?: number): void {
  let target = realPath;
  try { target = realpathSync(realPath); } catch { /* absent: create it where it is named */ }
  let mode = 0o600;
  try { mode = statSync(target).mode & 0o777; } catch { /* new file */ }
  mkdirSync(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.${basename(target)}.murage-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temp, bytes, { mode });
  try {
    if (mtimeMs !== undefined) {
      try { utimesSync(temp, new Date(mtimeMs), new Date(mtimeMs)); } catch { /* order is best effort on a volume that refuses it */ }
    }
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Another Murage process holds the lock on a real file: reconciling this scope waits for the next start. */
export class ReconcileBusyError extends Error {}

/** Timing of the cross-process lock around one real file's compare-and-write. */
export const antigravityLockConfig = { timeoutMs: 20_000, staleMs: 60_000 };

/** Run `fn` while holding the lock for `realPath`, shared by every Murage process. Throws when it cannot be had in time (the caller defers). */
export function withRealFileLock<T>(lockRoot: string, realPath: string, fn: () => T): T {
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const dir = join(lockRoot, createHash("sha256").update(realPath).digest("hex").slice(0, 24));
  const me = ownProcessRecord();
  const deadline = Date.now() + antigravityLockConfig.timeoutMs;
  for (;;) {
    try {
      mkdirSync(dir, { mode: 0o700 });
      try { writeFileSync(join(dir, "owner.json"), JSON.stringify(me), { mode: 0o600 }); } catch { /* an ownerless lock goes stale by age */ }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: ProcessRecord | null = null;
      try { holder = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as ProcessRecord; } catch { /* no owner yet */ }
      let age = 0;
      try { age = Date.now() - statSync(dir).mtimeMs; } catch { continue; } // released meanwhile
      const dead = holder && Number.isInteger(holder.pid) && holder.pid !== me.pid ? !processRunning(holder) : false;
      // Our own pid in a lock we do not hold is a leftover of an earlier call in this process.
      if (dead || (holder && holder.pid === me.pid) || age > antigravityLockConfig.staleMs) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new ReconcileBusyError(`another Murage process is reconciling ${basename(realPath)}`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

class Reconciler {
  private keptDir: string | null = null;
  private readonly keptRoot: string;
  private readonly name: string;
  private readonly lockRoot: string;
  constructor(keptRoot: string, name: string) {
    this.keptRoot = keptRoot;
    this.name = name;
    this.lockRoot = join(dirname(keptRoot), "antigravity-locks");
  }

  /** Keep `path` (moved) under the kept folder at `rel`. */
  keep(path: string, rel: string): void {
    this.keptDir ??= join(this.keptRoot, `${this.name}-${Date.now()}`);
    let to = join(this.keptDir, rel);
    for (let n = 2; existsSync(to); n++) to = join(this.keptDir, `${rel}.${n}`);
    moveInto(path, to);
  }

  /** Copy (not move) the real file at `realPath` under the kept folder before it is overwritten. */
  keepCopy(realPath: string, rel: string): void {
    this.keptDir ??= join(this.keptRoot, `${this.name}-${Date.now()}`);
    let to = join(this.keptDir, rel);
    for (let n = 2; existsSync(to); n++) to = join(this.keptDir, `${rel}.${n}`);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(realPath, to);
  }

  /** A changed file agy left at `scoped` for the real file `real` (whose signature was `realSig` at build). */
  file(scoped: string, real: string, rel: string, realSig: string | undefined): void {
    // Read, compare and write back under one lock: two scopes disposing at once cannot interleave.
    withRealFileLock(this.lockRoot, real, () => this.fileLocked(scoped, real, rel, realSig));
  }

  private fileLocked(scoped: string, real: string, rel: string, realSig: string | undefined): void {
    const now = fileSig(real);
    const scopedStat = statSync(scoped);
    if (now === "missing") {
      writeThrough(real, readFileSync(scoped), scopedStat.mtimeMs);
      rmSync(scoped, { force: true });
      return;
    }
    if (!statSync(real).isFile()) {
      this.keep(scoped, rel);
      return;
    }
    const scopedBytes = readFileSync(scoped);
    if (scopedBytes.equals(readFileSync(real))) {
      rmSync(scoped, { force: true });
      return;
    }
    // Unchanged since the build: agy's write is the newer one.
    const realUnchanged = realSig !== undefined && now === realSig;
    // Both are WRITE times: a file written back keeps its source's mtime (writeThrough), so the time of this
    // reconcile never decides which token is the fresher.
    const scopedNewer = scopedStat.mtimeMs >= statSync(real).mtimeMs;
    if (realUnchanged || scopedNewer) {
      if (!realUnchanged) this.keepCopy(real, rel);
      writeThrough(real, scopedBytes, scopedStat.mtimeMs);
      rmSync(scoped, { force: true });
    } else {
      this.keep(scoped, rel);
    }
  }

  /** An entry agy created (not one we mirrored): into the real home, merged with what is there. */
  adopt(scoped: string, real: string, rel: string): void {
    let scopedStat;
    try { scopedStat = lstatSync(scoped); } catch { return; }
    let realStat = null;
    try { realStat = lstatSync(real); } catch { /* absent */ }
    if (!realStat) {
      moveInto(scoped, real);
      return;
    }
    if (scopedStat.isDirectory() && !scopedStat.isSymbolicLink()) {
      let realIsDir = false;
      try { realIsDir = statSync(real).isDirectory(); } catch { /* broken link */ }
      if (!realIsDir) {
        this.keep(scoped, rel);
        return;
      }
      for (const child of freshEntries(scoped)) this.adopt(join(scoped, child), join(real, child), join(rel, child));
      if (!freshEntries(scoped).length) rmSync(scoped, { recursive: true, force: true });
      return;
    }
    if (scopedStat.isFile()) {
      this.file(scoped, real, rel, undefined);
      return;
    }
    this.keep(scoped, rel);
  }
}

/** Reconcile one scoped home into the real home (see the header), then remove what is left of it: only our own links and mounts. */
function reconcileScopedHome(manifest: ScopeManifest, keptRootDir: string, name: string): void {
  const { realHome, home, records, mounted, askHook } = manifest;
  const r = new Reconciler(keptRootDir, name);
  const mirrored = new Map(records.map((record) => [record.rel, record]));
  let unreconciled = false;
  const fail = (path: string, rel: string) => {
    // Anything that could not be reconciled is kept, never dropped.
    try { if (existsSync(path)) r.keep(path, rel); } catch { unreconciled = true; /* left in place; the tree is not removed below */ }
  };

  // 1. Mirrored entries agy replaced.
  for (const record of records) {
    const scoped = join(home, record.rel);
    let stat;
    try { stat = lstatSync(scoped); } catch { continue; } // removed: the link only; the real file is untouched
    try {
      if (record.kind === "symlink" || record.kind === "junction") {
        if (stat.isSymbolicLink()) continue;
        if (stat.isFile()) r.file(scoped, record.real, record.rel, record.realSig);
        else r.adopt(scoped, record.real, record.rel);
      } else if (record.kind === "hardlink") {
        if (stat.isFile() && stat.ino === statSync(record.real, { throwIfNoEntry: false })?.ino) continue;
        if (stat.isFile()) r.file(scoped, record.real, record.rel, record.realSig);
        else r.adopt(scoped, record.real, record.rel);
      } else {
        if (stat.isFile() && hashFile(scoped) === record.copyHash) continue;
        if (stat.isFile()) r.file(scoped, record.real, record.rel, record.realSig);
        else r.adopt(scoped, record.real, record.rel);
      }
    } catch (error) {
      if (error instanceof ReconcileBusyError) { unreconciled = true; continue; }
      fail(scoped, record.rel);
    }
  }

  // 2. Entries agy created in the folders Murage made.
  for (const level of scopedLevels()) {
    const scopedDir = join(home, level.rel);
    for (const entry of freshEntries(scopedDir)) {
      const rel = level.rel ? join(level.rel, entry) : entry;
      if (mirrored.has(rel)) continue;
      if (scopedLevels().some((l) => l.rel === rel)) continue; // a level of our own
      if (mounted && rel === join(".gemini", "config", "mcp_config.json")) continue; // our mount file
      if (askHook && rel === join(".gemini", "config", "hooks.json")) continue; // our Ask hook file
      if (level.omit.has(entry)) {
        // agy wrote a personal-named item (GEMINI.md, a skill) during a bot turn: kept
        // for the owner to look at, never put into or over their personal setup.
        fail(join(scopedDir, entry), rel);
        continue;
      }
      try {
        r.adopt(join(scopedDir, entry), join(realHome, rel), rel);
      } catch (error) {
        if (error instanceof ReconcileBusyError) { unreconciled = true; continue; }
        fail(join(scopedDir, entry), rel);
      }
    }
  }

  if (unreconciled) return; // keep the tree and its manifest for the next start
  // Only our links, copies already reconciled, and the mount file remain. Links are removed, never followed.
  rmSync(home, { recursive: true, force: true });
  rmSync(manifestPath(home), { force: true });
}

/** Murage's own keys in agy's global MCP file, left there by versions before 1.0.2. */
export const ANTIGRAVITY_LEGACY_FIXED_KEYS = ["murage-computer", "murage-agents"] as const;
export const ANTIGRAVITY_LEGACY_KEY_PREFIX = "murage-custom-";

/** The proxy files Murage's mounts ran (dev .ts or packaged .js). */
const proxyFile = (names: readonly string[]) => new RegExp(`^(?:${names.join("|")})\\.(?:ts|js)$`);
const COMPUTER_PROXIES = proxyFile(["computer-proxy", "host-computer-proxy", "container-mcp", "vps-container-mcp"]);
const AGENTS_PROXIES = proxyFile(["agents-proxy"]);
const REMOTE_PROXIES = proxyFile(["remote-mcp-proxy"]);
/** What process.execPath was when Murage wrote a mount: the packaged app's binary, Electron, or node in a dev tree. */
const MURAGE_EXECUTABLE = /^(?:murage|electron|node)(?:\.exe)?$/i;
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
/** The folders Murage's proxies live in: server/ (dev tree and Resources/server) or server/drivers/. */
const PROXY_FOLDER = /(?:^|[\\/])server(?:[\\/]drivers)?$/;

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? "";
const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

/** Murage's own executable and proxy: an absolute Murage/Electron/node binary running an absolute proxy file in a server folder. */
function murageLaunch(command: string, proxy: string, pattern: RegExp): boolean {
  return ABSOLUTE.test(command) && MURAGE_EXECUTABLE.test(fileName(command))
    && ABSOLUTE.test(proxy) && pattern.test(fileName(proxy)) && PROXY_FOLDER.test(folderOf(proxy));
}

const exactKeys = (env: Record<string, unknown>, names: readonly string[]) => {
  const have = Object.keys(env).sort();
  return have.length === names.length && [...names].sort().every((name, index) => name === have[index]);
};
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

/**
 * True only when `entry` under `key` is provably a mount Murage wrote before
 * 1.0.2 (antigravity.ts at 6a28f6423, ensureAntigravityOwnedMcpServers), in
 * the COMPLETE shape Murage wrote it:
 *   - exactly the keys `command`, `args`, `env`;
 *   - `command` an absolute path to Murage's own executable (the Murage app
 *     binary, Electron, or node: process.execPath), `args` exactly the proxy
 *     file(s) Murage ran, an absolute path of one of Murage's proxy file names
 *     inside a `server` or `server/drivers` folder;
 *   - an env of exactly the names Murage set, with ELECTRON_RUN_AS_NODE=1, a
 *     loopback harness URL, and a non-empty capability token.
 * Anything short of that (another executable, a proxy elsewhere, extra
 * arguments, an extra or empty token, a server the owner added under a
 * Murage-like key) is the owner's and stays. A Local VM / VPS computer
 * (a Cua Driver command passed through) cannot be told from the owner's own and stays.
 */
export function isLegacyMurageMount(key: string, entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (Object.keys(entry).sort().join(",") !== "args,command,env") return false;
  const { command, args, env } = entry as { command: unknown; args: unknown; env: unknown };
  if (typeof command !== "string" || !command) return false;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return false;
  if (!env || typeof env !== "object" || Array.isArray(env)) return false;
  const vars = env as Record<string, unknown>;
  const argv = args as string[];
  if (vars.ELECTRON_RUN_AS_NODE !== "1") return false;
  if (key === "murage-computer") {
    // The cloud-box adapter: one proxy argument, and exactly the five names Murage set.
    return argv.length === 1 && murageLaunch(command, argv[0]!, COMPUTER_PROXIES)
      && exactKeys(vars, ["ELECTRON_RUN_AS_NODE", "MURAGEBOX_BOX_ID", "MURAGEBOX_BOX_TOKEN", "MURAGE_CONTROL_URL", "MURAGE_CONTROL_TOKEN"])
      && nonEmpty(vars.MURAGEBOX_BOX_ID) && nonEmpty(vars.MURAGEBOX_BOX_TOKEN)
      && Object.values(vars).every((value) => typeof value === "string");
  }
  if (key === "murage-agents") {
    return argv.length === 1 && murageLaunch(command, argv[0]!, AGENTS_PROXIES)
      && nonEmpty(vars.MURAGE_COMMS_TOKEN) && nonEmpty(vars.MURAGE_BOT_ID) && nonEmpty(vars.MURAGE_THREAD_ID)
      && typeof vars.MURAGE_HARNESS_URL === "string" && LOOPBACK_URL.test(vars.MURAGE_HARNESS_URL)
      && Object.entries(vars).every(([name, value]) => typeof value === "string" && (name === "ELECTRON_RUN_AS_NODE" || name.startsWith("MURAGE_")));
  }
  if (key.startsWith(ANTIGRAVITY_LEGACY_KEY_PREFIX)) {
    // Only link servers carry Murage's proxy: `<proxy> --server <name>`. A copy of an owner's command server is indistinguishable from theirs and stays.
    const server = key.slice(ANTIGRAVITY_LEGACY_KEY_PREFIX.length);
    return argv.length === 3 && murageLaunch(command, argv[0]!, REMOTE_PROXIES) && argv[1] === "--server" && argv[2] === server
      && exactKeys(vars, ["ELECTRON_RUN_AS_NODE", "MURAGE_HARNESS_URL", "MURAGE_MCP_TOKEN"])
      && typeof vars.MURAGE_HARNESS_URL === "string" && LOOPBACK_URL.test(vars.MURAGE_HARNESS_URL) && nonEmpty(vars.MURAGE_MCP_TOKEN);
  }
  return false;
}

/**
 * Remove only Murage's own legacy mounts from the owner's global
 * mcp_config.json: an entry under one of Murage's old keys whose shape proves
 * Murage wrote it (isLegacyMurageMount). Every other entry, including an
 * ambiguous one under a Murage-like key, and every unknown top-level key, is
 * kept. A file that is missing, unreadable, not JSON or not the expected shape
 * keeps its bytes. A symlinked file stays a symlink: its target is updated in
 * place. Returns the keys removed.
 */
export function removeAntigravityLegacyMcpEntries(realHome: string): string[] {
  const path = join(realHome, ".gemini", "config", "mcp_config.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) return [];
  const servers = (config as { mcpServers?: unknown }).mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return [];
  const isOurs = (key: string, value: unknown) =>
    ((ANTIGRAVITY_LEGACY_FIXED_KEYS as readonly string[]).includes(key) || key.startsWith(ANTIGRAVITY_LEGACY_KEY_PREFIX))
    && isLegacyMurageMount(key, value);
  const entries = Object.entries(servers as Record<string, unknown>);
  const removed = entries.filter(([key, value]) => isOurs(key, value)).map(([key]) => key);
  if (!removed.length) return [];
  const kept = Object.fromEntries(entries.filter(([key, value]) => !isOurs(key, value)));
  writeThrough(path, `${JSON.stringify({ ...(config as object), mcpServers: kept }, null, 2)}\n`);
  return removed;
}
