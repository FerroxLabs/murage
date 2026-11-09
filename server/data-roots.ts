// The data-root model (designs/S5-DATADIR-PATHS.md r4.1 section 3, DR0-DR7).
//
// A root is a top-level DATA_DIR folder that may live on another disk through a symlink or a junction:
// `workspaces` and `providers`. A linked root works by default; only a link BELOW a root is refused.
// Every consumer that walks from DATA_DIR into a root goes through ownedPath / ownedLeaf / rootFor here,
// so no site keeps its own ancestor walk.
//
// DR1: canonical() is applied only to the current candidate DATA_DIR/R. A recorded target and a boot
// snapshot are FROZEN spellings: they are compared after lexical normalisation only, never resolved again.
// DR3: the per-turn check is O(1) per root (one lstat, one realpath, one lstat of T), never proportional to history.
import fs, { type Stats } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { isAbsolute, join, parse, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./config.ts";
import { setWorkspacesTargetsProvider } from "./data-dir-guard.ts";

export const DATA_ROOT_NAMES = ["workspaces", "providers"] as const;
export type RootName = (typeof DATA_ROOT_NAMES)[number];
export type RootKind = "absent" | "plain" | "link";
export type RootState = "absent" | "ok" | "unavailable" | "changed" | "refused";
export type WorkspaceTreeCode = "link-below-root" | "not-a-folder" | "root-changed" | "root-unavailable" | "root-refused" | "escape";

export class WorkspaceTreeError extends Error {
  readonly code: WorkspaceTreeCode;
  readonly root?: RootName;
  constructor(code: WorkspaceTreeCode, root?: RootName) {
    super(workspaceTreeText(code, root));
    this.name = "WorkspaceTreeError";
    this.code = code;
    this.root = root;
  }
}

/** Section 6 texts. working-folder is not a worded code, so the card shows these as written; the reason class is in the log only. */
export function workspaceTreeText(code: WorkspaceTreeCode, root: RootName = "workspaces"): string {
  const folder = root === "providers" ? "Claude accounts folder" : "workspaces folder";
  if (code === "root-changed") return "The linked folder in Murage's data folder points to a different place than before, so Murage did not start the turn there.";
  if (code === "root-unavailable") return `Murage's ${folder} is a link to a place that cannot be opened right now, for example a disk that is not connected, so the turn did not start. Connect it, then retry.`;
  if (code === "root-refused") return `Murage's ${folder} is a link to a place Murage keeps separate from bot work (your home folder, the system disk, or Murage's own data folder). Point the link at a folder of its own, then retry.`;
  return "A folder in this bot's workspace is a link or is not a folder, and Murage never writes through a link there, so the turn did not start. Remove the link, or start a new conversation.";
}

export interface RootIdentity { target: string; dev: number; ino: number }
export interface LinkedRootRecord extends RootIdentity { at: string }
export interface RootRecordFile {
  schema: 1;
  root: string;
  previous: Array<{ root: string; at: string; source: "start" | "restore" }>;
  linkedRoots?: Partial<Record<RootName, LinkedRootRecord>>;
}
export interface RootSnapshot { name: RootName; state: RootState; lexical: string; canonical: string }
export interface OwnedPath { lexical: string; canonical: string; created: string[] }

/** Seams: replaced in tests only. Every filesystem call the model makes goes through these. */
export const dataRootSeams = {
  lstat: (path: string): Stats => fs.lstatSync(path),
  realpath: (path: string): string => fs.realpathSync.native(path),
  mkdir: (path: string): void => { fs.mkdirSync(path, { mode: 0o700 }); },
  homedir: (): string => osHomedir(),
  platform: (): NodeJS.Platform => process.platform,
  systemDrive: (): string => process.env.SystemDrive || "C:",
  /** Between the turn's DR3 check and its use (D5i seam). */
  afterCheck: (_name: RootName): void => {},
};

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const lstatOrNull = (path: string): Stats | null => {
  try { return dataRootSeams.lstat(path); } catch (error) { if (errno(error) === "ENOENT") return null; throw error; }
};
const realDir = (stat: Stats | null): boolean => Boolean(stat && stat.isDirectory() && !stat.isSymbolicLink());

/** DR1 lexical normalisation, applied to frozen spellings and to fresh canonical results alike: one `\\?\` strip
 * (and `\\?\UNC\` -> `\\`), NFC on darwin, case fold on win32 (for comparison only). */
export function comparable(path: string, platform: NodeJS.Platform = dataRootSeams.platform()): string {
  let value = stripLongPrefix(path);
  if (platform === "darwin") value = value.normalize("NFC");
  if (platform === "win32") value = value.replace(/\//g, "\\").toLowerCase();
  return value;
}
function stripLongPrefix(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}
/** DR1 canonical(p): realpath, one long-prefix strip, NFC on darwin. The win32 case fold is for comparison only. */
export function canonical(path: string): string {
  let value = stripLongPrefix(dataRootSeams.realpath(path));
  if (dataRootSeams.platform() === "darwin") value = value.normalize("NFC");
  return value;
}
/** DR1 identity: canonical paths equal; ino compared only when both are nonzero and dev is unchanged. */
export function sameRoot(recorded: RootIdentity, now: RootIdentity): boolean {
  if (comparable(recorded.target) !== comparable(now.target)) return false;
  return recorded.dev !== now.dev || !recorded.ino || !now.ino || recorded.ino === now.ino;
}
/** inner is, or lies inside, outer (comparable forms). */
function sameOrInsideComparable(inner: string, outer: string): boolean {
  const s = dataRootSeams.platform() === "win32" ? "\\" : "/";
  const a = comparable(inner), b = comparable(outer);
  if (a === b) return true;
  const base = b.endsWith(s) ? b : b + s;
  return a.startsWith(base);
}
const overlaps = (a: string, b: string): boolean => sameOrInsideComparable(a, b) || sameOrInsideComparable(b, a);

interface RootEntry {
  name: RootName;
  /** The kind the boot lstat saw. Kept for logs; never reset by unavailable or changed. */
  bootKind: RootKind;
  /** The kind and reference this boot admits. Equal to the boot kind, except: an absent root that a real dir
   * appears at becomes plain, and a successful DR7 confirm replaces both (BUILD-FIX 1). */
  admittedKind: RootKind;
  reference?: RootIdentity;
  /** Driver ruling 05:02Z: a plain root seen ENOENT mid-boot; the next walker with create recreates it (DR4). */
  recreate?: boolean;
  state: RootState;
  logged: boolean;
}

export type RootLog = (line: string) => void;

/** One installation's roots. The process singleton is bound to DATA_DIR (dataRoots()); tests construct their own. */
export class DataRoots {
  readonly dataDir: string;
  readonly recordPath: string;
  private canonicalDataDir: string;
  private record: RootRecordFile | undefined;
  private recordWritable = true;
  private entries = new Map<RootName, RootEntry>();
  private log: RootLog;

  constructor(dataDir: string, log: RootLog = line => console.warn(line)) {
    this.dataDir = dataDir;
    this.recordPath = join(dataDir, ".murage-root.json");
    this.canonicalDataDir = dataDir;
    this.log = log;
  }

  /** P1 + DR2, once at startup after the data-dir lease. Never throws for the record alone (Fable r4 L3). */
  boot(options: { canonicalRoot?: string; now?: () => string; readOnly?: boolean } = {}): void {
    try { this.canonicalDataDir = canonical(this.dataDir); } catch { this.canonicalDataDir = this.dataDir; }
    try { this.home = canonical(dataRootSeams.homedir()); } catch { this.home = dataRootSeams.homedir(); }
    const at = (options.now ?? (() => new Date().toISOString()))();
    if (options.readOnly) { this.readOnly = true; this.record = { schema: 1, root: this.dataDir, previous: [] }; }
    else this.loadAndRotateRecord(options.canonicalRoot ?? this.dataDir, at);
    for (const name of DATA_ROOT_NAMES) this.bootRoot(name);
  }

  /** The previous canonical roots this installation recorded (section 1); never derived from a path's shape. */
  previousRoots(): string[] { return (this.record?.previous ?? []).map(item => item.root); }
  linkedRecord(name: RootName): LinkedRootRecord | undefined { return this.record?.linkedRoots?.[name]; }
  bootKind(name: RootName): RootKind | undefined { return this.entries.get(name)?.bootKind; }

  private loadAndRotateRecord(root: string, at: string): void {
    let existing: RootRecordFile | undefined;
    let raw: string | undefined;
    try { raw = fs.readFileSync(this.recordPath, "utf8"); } catch (error) { if (errno(error) !== "ENOENT") this.log(`data-root-record unreadable code=${errno(error) ?? "error"}`); }
    if (raw !== undefined) {
      existing = parseRecord(raw);
      if (!existing) {
        try { fs.renameSync(this.recordPath, `${this.recordPath}.corrupt-${randomUUID()}`); } catch { /* the rewrite below replaces it */ }
        this.log("data-root-record corrupt: renamed aside, rewritten without previous roots");
      }
    }
    const next: RootRecordFile = existing ? { ...existing, previous: [...existing.previous] } : { schema: 1, root, previous: [] };
    if (existing && comparable(existing.root) !== comparable(root)) {
      if (!isFilesystemRoot(existing.root)) next.previous = [{ root: existing.root, at, source: "start" as const }, ...existing.previous.filter(item => comparable(item.root) !== comparable(existing!.root))].slice(0, 4);
      // P2: a link on the old computer says nothing about this one.
      delete next.linkedRoots;
      next.root = root;
    }
    next.previous = next.previous.filter(item => comparable(item.root) !== comparable(root));
    this.record = next;
    if (!existing || JSON.stringify(existing) !== JSON.stringify(next)) this.writeRecord();
  }

  private readOnly = false;
  private home: string | undefined;
  private writeRecord(): boolean {
    if (!this.record || this.readOnly) return false;
    try {
      const temp = `${this.recordPath}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(this.record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, this.recordPath);
      this.recordWritable = true;
      return true;
    } catch (error) {
      if (this.recordWritable) this.log(`data-root-record write failed code=${errno(error) ?? "error"}`);
      this.recordWritable = false;
      return false;
    }
  }

  private recordLink(name: RootName, identity: RootIdentity): void {
    if (!this.record) this.record = { schema: 1, root: this.dataDir, previous: [] };
    this.record.linkedRoots = { ...(this.record.linkedRoots ?? {}), [name]: { ...identity, at: new Date().toISOString() } };
    this.writeRecord();
  }

  private bootRoot(name: RootName): void {
    const lexical = join(this.dataDir, name);
    let stat: Stats | null;
    try { stat = lstatOrNull(lexical); } catch { stat = null; }
    const bootKind: RootKind = !stat ? "absent" : stat.isSymbolicLink() ? "link" : "plain";
    const entry: RootEntry = { name, bootKind, admittedKind: bootKind, state: "ok", logged: false };
    this.entries.set(name, entry);
    if (bootKind === "absent") { entry.state = "absent"; return; }
    if (bootKind === "plain" && !stat!.isDirectory()) { entry.state = "unavailable"; return; }
    if (bootKind === "plain") {
      try { const T = canonical(lexical); const t = dataRootSeams.lstat(T); entry.reference = { target: T, dev: t.dev, ino: t.ino }; }
      catch { entry.state = "unavailable"; }
      return;
    }
    this.evaluate(entry, true);
  }

  /** check(R) of DR3, which DR2's link branch also is. Sets and returns the entry's state. */
  private evaluate(entry: RootEntry, allowFirstSight: boolean): RootState {
    const lexical = join(this.dataDir, entry.name);
    let stat: Stats | null;
    try { stat = lstatOrNull(lexical); } catch { return this.set(entry, "unavailable"); }
    if (!stat) {
      // Driver ruling 05:02Z: a plain root found ENOENT mid-boot is recreated by the DR4 absent-root rule
      // (with create); read-only consumers see it absent-and-empty (BUILD-FIX 6). A link root stays unavailable.
      if (entry.admittedKind === "link") return this.set(entry, "unavailable");
      if (entry.admittedKind === "plain") entry.recreate = true;
      return this.set(entry, "absent");
    }
    const kind: RootKind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "plain" : "absent";
    if (kind === "absent") return this.set(entry, "changed");
    if (entry.recreate) {
      // a concurrent creator's real dir after the ENOENT: a new snapshot; a link is changed (Astra r4 H1: plain never becomes first sight)
      if (kind === "link") return this.set(entry, "changed");
      return this.adoptRecreated(entry, lexical);
    }
    if (entry.admittedKind === "absent") {
      // BUILD-FIX 7 (Fable r4.1 M3): a real non-link dir that appeared since boot is ok, snapshot taken now; a link is changed.
      if (kind === "link") return this.set(entry, "changed");
      try { const T = canonical(lexical); const t = dataRootSeams.lstat(T); entry.reference = { target: T, dev: t.dev, ino: t.ino }; entry.admittedKind = "plain"; return this.set(entry, "ok"); }
      catch { return this.set(entry, "unavailable"); }
    }
    if (kind !== entry.admittedKind) return this.set(entry, "changed");
    let T: string;
    try { T = canonical(lexical); } catch { return this.set(entry, "unavailable"); }
    let target: Stats;
    try { target = dataRootSeams.lstat(T); } catch { return this.set(entry, "unavailable"); }
    if (!realDir(target)) return this.set(entry, kind === "link" && !entry.reference ? "unavailable" : "changed");
    const now: RootIdentity = { target: T, dev: target.dev, ino: target.ino };
    if (kind === "link") {
      const refusal = this.refusalOf(entry.name, T);
      if (refusal) { if (!entry.logged || entry.state !== "refused") this.log(`data-root-refused root=${entry.name} reason=${refusal}`); entry.logged = true; return this.set(entry, "refused"); }
      const recorded = this.record?.linkedRoots?.[entry.name];
      if (!recorded) {
        // First sight exists only for a root the boot (or a confirm) admitted as a link (Astra r4 H1).
        if (!allowFirstSight && entry.bootKind !== "link") return this.set(entry, "changed");
        this.recordLink(entry.name, now);
        entry.reference = now;
        return this.set(entry, "ok");
      }
      entry.reference = { target: recorded.target, dev: recorded.dev, ino: recorded.ino };
      return this.set(entry, sameRoot(entry.reference, now) ? "ok" : "changed");
    }
    if (!entry.reference) { entry.reference = now; return this.set(entry, "ok"); }
    return this.set(entry, sameRoot(entry.reference, now) ? "ok" : "changed");
  }

  private set(entry: RootEntry, state: RootState): RootState {
    if (state !== "ok" && state !== "absent" && !entry.logged) { this.log(`data-root-${state} root=${entry.name}`); entry.logged = true; }
    entry.state = state;
    return state;
  }

  /** DR2 refusal list for a link's canonical target T; returns a reason code or undefined. */
  private refusalOf(name: RootName, T: string): string | undefined {
    const platform = dataRootSeams.platform();
    if (isFilesystemRoot(T, platform) && (platform !== "win32" || comparable(parse(T).root) === comparable(`${dataRootSeams.systemDrive()}\\`))) return "system-root";
    if (T === "/" ) return "system-root";
    if (overlaps(T, this.canonicalDataDir)) return "data-dir";
    // HOME is resolved once per model, so the per-turn check stays one realpath per root (D5h counter)
    if (this.home === undefined) { try { this.home = canonical(dataRootSeams.homedir()); } catch { this.home = dataRootSeams.homedir(); } }
    if (this.home && sameOrInsideComparable(this.home, T)) return "home";
    for (const other of DATA_ROOT_NAMES) {
      if (other === name) continue;
      const otherEntry = this.entries.get(other);
      const otherT = otherEntry?.reference?.target ?? this.record?.linkedRoots?.[other]?.target;
      if (otherT && overlaps(T, otherT)) return "other-root";
    }
    return undefined;
  }

  /** DR3 rootFor(R): one O(1) check. Returns the turn's snapshot when ok (or absent with create:false, BUILD-FIX 6);
   * throws WorkspaceTreeError otherwise. With create, an absent root is made a real 0o700 dir (DR4). */
  rootFor(name: RootName, options: { create?: boolean } = {}): RootSnapshot {
    const entry = this.entry(name);
    let state = this.evaluate(entry, false);
    const lexical = join(this.dataDir, name);
    if (state === "absent") {
      if (!options.create) return { name, state: "absent", lexical, canonical: join(this.canonicalDataDir, name) };
      state = this.createAbsent(entry);
    }
    if (state !== "ok") throw new WorkspaceTreeError(state === "changed" ? "root-changed" : state === "refused" ? "root-refused" : "root-unavailable", name);
    dataRootSeams.afterCheck(name);
    return { name, state, lexical, canonical: entry.reference!.target };
  }

  /** A root's state for read-only display (GET /api/data-dir/roots, logs): runs the same O(1) check. */
  status(name: RootName): RootState { return this.evaluate(this.entry(name), false); }

  /** The current canonical target, for the gated GET in state "changed" only (Astra r4 L1). */
  candidate(name: RootName): string | undefined {
    if (this.status(name) !== "changed") return undefined;
    try { return canonical(join(this.dataDir, name)); } catch { return undefined; }
  }

  private createAbsent(entry: RootEntry): RootState {
    const lexical = join(this.dataDir, entry.name);
    // DATA_DIR itself is not a root and may not exist yet on a fresh install (b17 made it with the recursive mkdir)
    // A recreated plain root never makes DATA_DIR: a missing DATA_DIR (an unmounted volume) stays "unavailable" (driver ruling 05:02Z).
    if (!entry.recreate) { try { fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 }); } catch { /* the root mkdir below reports it */ } }
    try { dataRootSeams.mkdir(lexical); }
    catch (error) {
      if (errno(error) !== "EEXIST") return this.set(entry, "unavailable");
      // Fable r4 M4: a concurrent creator's real dir is fine; a link planted while absent is "changed", never recorded.
    }
    const stat = lstatOrNull(lexical);
    if (!realDir(stat)) return this.set(entry, "changed");
    if (entry.recreate) return this.adoptRecreated(entry, lexical);
    try { const T = canonical(lexical); const t = dataRootSeams.lstat(T); entry.reference = { target: T, dev: t.dev, ino: t.ino }; entry.admittedKind = "plain"; return this.set(entry, "ok"); }
    catch { return this.set(entry, "unavailable"); }
  }

  private adoptRecreated(entry: RootEntry, lexical: string): RootState {
    try {
      const T = canonical(lexical); const t = dataRootSeams.lstat(T);
      if (!realDir(t)) return this.set(entry, "changed");
      entry.reference = { target: T, dev: t.dev, ino: t.ino };
      entry.recreate = false;
      entry.logged = false;
      this.log(`data-root-recreated root=${entry.name}`);
      return this.set(entry, "ok");
    } catch { return this.set(entry, "unavailable"); }
  }

  private entry(name: RootName): RootEntry {
    let entry = this.entries.get(name);
    if (!entry) { this.bootRoot(name); entry = this.entries.get(name)!; }
    return entry;
  }

  /** DR7 confirm: allowed only in state "changed"; re-runs the whole of DR2 on the current state. */
  confirm(name: RootName): { status: 200 | 409; state: RootState; restart?: true } {
    const entry = this.entry(name);
    const state = this.evaluate(entry, false);
    if (state !== "changed") return { status: 409, state };
    const lexical = join(this.dataDir, name);
    const stat = lstatOrNull(lexical);
    if (!stat?.isSymbolicLink()) {
      // a plain dir that differs, or no boot snapshot to compare with (Fable r4.1 L1): restart.
      return { status: 409, state, restart: true };
    }
    let T: string;
    try { T = canonical(lexical); } catch { return { status: 409, state }; }
    let target: Stats;
    try { target = dataRootSeams.lstat(T); } catch { return { status: 409, state }; }
    if (!realDir(target) || this.refusalOf(name, T)) return { status: 409, state };
    const identity = { target: T, dev: target.dev, ino: target.ino };
    this.recordLink(name, identity);
    // BUILD-FIX 1: the confirm is the one place after boot that replaces the admitted kind and frozen snapshot.
    entry.admittedKind = "link";
    entry.recreate = false;
    entry.reference = identity;
    entry.logged = false;
    entry.state = "ok";
    return { status: 200, state: "ok" };
  }

  /** C12 read-only protection lookup (BUILD-FIX 4): the frozen admitted target plus the current resolved candidate. Never admits. */
  protectedTargets(name: RootName): string[] {
    const out = new Set<string>();
    const entry = this.entries.get(name);
    const frozen = entry?.reference?.target ?? this.record?.linkedRoots?.[name]?.target;
    if (frozen) out.add(frozen);
    try { out.add(canonical(join(this.dataDir, name))); } catch { /* absent or dangling: only the frozen one */ }
    return [...out];
  }

  /** DR4: the ONE walker. */
  ownedPath(lexicalPath: string, options: { create?: boolean; snapshot?: RootSnapshot } = {}): OwnedPath {
    const rel = relative(this.dataDir, lexicalPath);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("../")) throw new WorkspaceTreeError("escape");
    const parts = rel.split(/[\\/]/).filter(Boolean);
    if (parts.some(part => part === "." || part === "..")) throw new WorkspaceTreeError("escape");
    const created: string[] = [];
    let base = this.canonicalDataDir;
    let walk = parts;
    const first = parts[0] as RootName | undefined;
    let rootName: RootName | undefined;
    if (first && (DATA_ROOT_NAMES as readonly string[]).includes(first)) {
      rootName = first;
      let snapshot = options.snapshot?.name === first ? options.snapshot : undefined;
      if (!snapshot || snapshot.state !== "ok") {
        const wasAbsent = this.entries.get(first)?.state === "absent" || this.status(first) === "absent";
        snapshot = this.rootFor(first, { create: options.create });
        if (wasAbsent && snapshot.state === "ok") created.push(snapshot.lexical);
      }
      if (snapshot.state === "absent") {
        // read-only on an absent root: nothing below exists (BUILD-FIX 6)
        return { lexical: lexicalPath, canonical: join(snapshot.canonical, ...parts.slice(1)), created };
      }
      base = snapshot.canonical;
      walk = parts.slice(1);
    }
    let at = base;
    let stopped = false;
    for (const part of walk) {
      at = join(at, part);
      if (stopped) continue;
      let stat = lstatOrNull(at);
      if (!stat) {
        if (!options.create) { stopped = true; continue; }
        try { dataRootSeams.mkdir(at); created.push(at); } catch (error) { if (errno(error) !== "EEXIST") throw error; }
        stat = lstatOrNull(at);
      }
      if (!stat) throw new WorkspaceTreeError("not-a-folder", rootName);
      if (stat.isSymbolicLink()) throw new WorkspaceTreeError("link-below-root", rootName);
      if (!stat.isDirectory()) throw new WorkspaceTreeError("not-a-folder", rootName);
    }
    return { lexical: lexicalPath, canonical: at, created };
  }

  /** DR4 ownedLeaf: the read form for files. The leaf must be a regular file with one name, not a link. */
  ownedLeaf(lexicalPath: string, options: { snapshot?: RootSnapshot } = {}): { lexical: string; canonical: string; stat: Stats } {
    const parent = this.ownedPath(join(lexicalPath, ".."), { create: false, snapshot: options.snapshot });
    const leaf = join(parent.canonical, lexicalPath.split(/[\\/]/).filter(Boolean).pop() ?? "");
    const stat = dataRootSeams.lstat(leaf);
    if (stat.isSymbolicLink()) throw new WorkspaceTreeError("link-below-root");
    if (!stat.isFile() || stat.nlink !== 1) throw new WorkspaceTreeError("not-a-folder");
    return { lexical: lexicalPath, canonical: leaf, stat };
  }
}

function parseRecord(raw: string): RootRecordFile | undefined {
  try {
    const value = JSON.parse(raw) as Partial<RootRecordFile>;
    if (!value || value.schema !== 1 || typeof value.root !== "string" || !isAbsolute(value.root) || !Array.isArray(value.previous)) return undefined;
    const previous = value.previous.filter((item): item is RootRecordFile["previous"][number] => Boolean(item) && typeof item.root === "string" && isAbsolute(item.root) && !isFilesystemRoot(item.root) && (item.source === "start" || item.source === "restore")).slice(0, 4);
    const linked: Partial<Record<RootName, LinkedRootRecord>> = {};
    for (const name of DATA_ROOT_NAMES) {
      const item = value.linkedRoots?.[name];
      if (item && typeof item.target === "string" && isAbsolute(item.target) && Number.isFinite(item.dev) && Number.isFinite(item.ino)) linked[name] = { target: item.target, dev: item.dev, ino: item.ino, at: String(item.at ?? "") };
    }
    return { schema: 1, root: value.root, previous, ...(Object.keys(linked).length ? { linkedRoots: linked } : {}) };
  } catch { return undefined; }
}

/** `/`, a drive root `X:\`, or a UNC share root: never recorded as a previous root. */
export function isFilesystemRoot(path: string, platform: NodeJS.Platform = dataRootSeams.platform()): boolean {
  const value = stripLongPrefix(path);
  if (platform === "win32") {
    const p = parse(value.replace(/\//g, "\\"));
    return p.root !== "" && p.dir === p.root && p.base === "";
  }
  return value === "/";
}

let singleton: DataRoots | undefined;
/** The running installation's roots. Booted lazily on first use if the server did not call bootDataRoots(). */
export function dataRoots(): DataRoots {
  if (!singleton) { singleton = new DataRoots(DATA_DIR); singleton.boot(); }
  return singleton;
}
/** Server startup, after the data-dir lease (P1). */
export function bootDataRoots(): DataRoots {
  singleton = new DataRoots(DATA_DIR);
  singleton.boot();
  return singleton;
}
const foreign = new Map<string, DataRoots>();
/** The roots of a data dir a caller names explicitly (policy and tests pass one): the singleton for DATA_DIR, else a
 * read-only model of that folder (no root record is written for it; first sight is in memory only). */
export function rootsFor(dataDir: string): DataRoots {
  if (dataDir === DATA_DIR) return dataRoots();
  let roots = foreign.get(dataDir);
  if (!roots) { roots = new DataRoots(dataDir, () => {}); roots.boot({ readOnly: true }); foreign.set(dataDir, roots); }
  return roots;
}
// C12: the guard asks for the workspaces root's targets through a getter, so protectedRootRefusal stays pure and the guard
// never imports this module (config.ts loads the guard first). Only an already-booted model is asked; the guard never boots one.
setWorkspacesTargetsProvider(dataDir => (singleton && dataDir === singleton.dataDir ? singleton : foreign.get(dataDir))?.protectedTargets("workspaces") ?? []);
/** Tests only: drop the singleton so the next call boots against the current DATA_DIR state. */
export function resetDataRootsForTest(roots?: DataRoots): void { singleton = roots; }

export const rootFor = (name: RootName, options?: { create?: boolean }): RootSnapshot => dataRoots().rootFor(name, options);
export const ownedPath = (lexicalPath: string, options?: { create?: boolean; snapshot?: RootSnapshot }): OwnedPath => dataRoots().ownedPath(lexicalPath, options);
export const ownedLeaf = (lexicalPath: string, options?: { snapshot?: RootSnapshot }) => dataRoots().ownedLeaf(lexicalPath, options);
