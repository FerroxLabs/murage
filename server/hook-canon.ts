// Canonical hook bytes live in the server, never in a writable data directory.
// Folder identity rechecks narrow, but cannot eliminate, same-user ancestor
// swaps between a check and a pathname syscall (design §3.4a's accepted limit).
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { renameWithRetry, syncParentDirectory } from "./atomic.ts";

export type EngineName = "codex" | "antigravity" | "hermes";
export type CanonFile = {
  path: string; bytes: Buffer; sha256: string;
  kind: "script" | "launcher" | "config" | "env";
  engine: EngineName; root: string;
};
export type Why = "missing" | "changed" | "link" | "not-a-file" | "linked-copy" | "mode" | "owner" | "folder";
export type Ensure = { ok: true; restored: { path: string; why: Why }[] }
  | { ok: false; path: string; why: Why; error: string };
export type UsePoint = "V-C1" | "V-C2" | "V-C3" | "V-A1" | "V-A2" | "V-A3" | "V-A4" | "V-A5" | "V-H1" | "V-H2" | "V-ANY";
export type CanonOwner = { engineInstance?: string; turn?: string; revoke?: () => void; stop?: () => void };
export type CanonSet = CanonOwner & { id: string; files: CanonFile[] };
export type ReparseInspection = { state: "clean" } | { state: "link"; tag: string }
  | { state: "unknown"; error: string; identityChanged?: boolean };
type QueryExec = (exe: string, args: string[], options: { encoding: "utf8"; timeout: number; windowsHide: boolean; shell: false }) => string;
/** Fault seams operate on real fixture files; production uses the defaults. */
export type CanonOptions = {
  platform?: NodeJS.Platform; log?: (line: string) => void;
  rename?: typeof fs.renameSync; open?: typeof fs.openSync;
  write?: typeof fs.writeFileSync; chmod?: typeof fs.fchmodSync; unlink?: typeof fs.unlinkSync;
  uuid?: () => string; sleep?: (ms: number) => void; exec?: QueryExec;
  query?: (path: string) => ReparseInspection;
  beforeRecheck?: (path: string, operation: string) => void;
};
type Generation = { generation: number; file: CanonFile; refs: Set<string> };
type LiveSet = { set: CanonSet; paths: string[]; owner: CanonOwner; folders: Map<string, fs.Stats> };
const generations = new Map<string, Generation>();
const live = new Map<string, LiveSet>();
let nextGeneration = 0;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const same = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const queryPoints = new Set<UsePoint>(["V-C1", "V-A1", "V-A2", "V-A3", "V-H1"]);
const plain: Record<Why, string> = {
  missing: "it was missing", changed: "it had been changed", link: "it was a link",
  "not-a-file": "it was not a file", "linked-copy": "it had a second name",
  mode: "its permissions had been widened", owner: "it belonged to another user", folder: "its folder had been changed",
};
const engineLabel: Record<EngineName, string> = { codex: "Codex", antigravity: "Antigravity", hermes: "Hermes" };

function copyFile(file: CanonFile): CanonFile {
  const root = resolve(file.root), path = resolve(file.path), rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Hook path must be inside its native root");
  const bytes = Buffer.from(file.bytes), sha256 = hash(bytes);
  if (sha256 !== file.sha256) throw new Error("Canonical hash does not match bundled bytes");
  return { ...file, root, path, bytes, sha256 };
}

/** A replacement generation becomes current for ALL owners of that path. */
export function registerCanon(files: CanonFile[], owner: CanonOwner = {}): CanonSet {
  // Validate the whole registration before changing any live generation.
  const copies = files.map(copyFile);
  const seen = new Set<string>();
  for (const f of copies) {
    if (seen.has(f.path)) throw new Error("Duplicate canonical path");
    seen.add(f.path);
    const old = generations.get(f.path);
    if (old && (old.file.root !== f.root || old.file.engine !== f.engine || old.file.kind !== f.kind)) throw new Error("Conflicting canonical path ownership");
  }
  const set: CanonSet = Object.freeze({ ...owner, id: randomUUID(), get files() {
    return copies.map(f => {
      const current = generations.get(f.path)?.file ?? f;
      return { ...current, bytes: Buffer.from(current.bytes) };
    });
  } });
  for (const file of copies) {
    const prior = generations.get(file.path);
    const refs = prior?.refs ?? new Set<string>(); refs.add(set.id);
    if (!prior || !prior.file.bytes.equals(file.bytes)) generations.set(file.path, { generation: ++nextGeneration, file, refs });
  }
  live.set(set.id, { set, paths: copies.map(f => f.path), owner: { ...owner }, folders: new Map() });
  return set;
}

export function dropCanon(set: CanonSet): void {
  const state = live.get(set.id);
  if (!state || state.set !== set) return;
  live.delete(set.id);
  for (const path of state.paths) {
    const entry = generations.get(path);
    entry?.refs.delete(set.id);
    if (entry?.refs.size === 0) generations.delete(path);
  }
}

let warnedReparse = false;
function unknownReparse(error: string, options: CanonOptions, identityChanged = false): ReparseInspection {
  if (!warnedReparse) {
    warnedReparse = true;
    try { (options.log ?? console.warn)("hooks: Windows reparse inspection unavailable; unchanged entries still require identity and canonical-byte checks"); } catch { /* logging cannot authorize a repair */ }
  }
  return { state: "unknown", error, ...(identityChanged ? { identityChanged: true } : {}) };
}

/** fsutil queries metadata, not contents. Bracket its pathname query with
 * identity checks; this still has the pathname-utility limit in §3.4. */
export function reparseTag(path: string, options: CanonOptions = {}): ReparseInspection {
  try {
    const before = fs.lstatSync(path);
    let output = "", failure: unknown;
    try {
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      if (!win32.isAbsolute(systemRoot)) return unknownReparse("SystemRoot is not absolute", options);
      output = String((options.exec ?? execFileSync)(win32.join(systemRoot, "System32", "fsutil.exe"), ["reparsepoint", "query", path],
        { encoding: "utf8", timeout: 5000, windowsHide: true, shell: false }));
    } catch (error) {
      failure = error;
      const e = error as { stdout?: string | Buffer; stderr?: string | Buffer };
      output = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    const after = fs.lstatSync(path);
    if (!same(before, after)) return unknownReparse("Entry identity changed during reparse inspection", options, true);
    // Timeout/access/privilege errors cannot be made clean by incidental output.
    if (failure && ["ETIMEDOUT", "EACCES", "EPERM", "ENOENT"].includes(String(codeOf(failure)))) return unknownReparse(errorText(failure), options);
    if (/privilege|access is denied|requires elevation/i.test(output)) return unknownReparse(output, options);
    const tag = /Reparse Tag Value\s*:\s*(0x[0-9a-f]+)/i.exec(output)?.[1];
    if (tag) return { state: "link", tag };
    if (/not a reparse point/i.test(output) || /(?:\b4390\b|0x1126\b)/i.test(output)) return { state: "clean" };
    return unknownReparse(failure ? errorText(failure) : "Unclassified reparse query output", options);
  } catch (error) { return unknownReparse(errorText(error), options, true); }
}

class RepairFailure extends Error {
  readonly path: string;
  readonly why: Why;
  constructor(path: string, why: Why, message: string) { super(message); this.path = path; this.why = why; }
}
type Plan = { path: string; root: string; folder: boolean; file?: CanonFile; stat?: fs.Stats; why?: Why; inspection?: ReparseInspection; identityFailed?: boolean };
type Context = {
  options: CanonOptions; platform: NodeJS.Platform; at: UsePoint;
  folders: Map<string, fs.Stats>; roots: Map<string, string>;
};
function fail(path: string, why: Why, message: string): never { throw new RepairFailure(path, why, message); }
function lstat(path: string): fs.Stats | undefined {
  try { return fs.lstatSync(path); } catch (e) { if (codeOf(e) === "ENOENT") return undefined; throw e; }
}
function folderPaths(file: CanonFile): string[] {
  const paths = [file.root]; let path = file.root;
  for (const part of relative(file.root, dirname(file.path)).split(sep).filter(Boolean)) { path = join(path, part); paths.push(path); }
  return paths;
}
function identity(path: string, root: string, stat: fs.Stats, ctx: Context): boolean {
  try {
    const real = fs.realpathSync.native(path);
    if (!same(stat, fs.statSync(path)) || !same(stat, fs.lstatSync(real))) return false;
    const R = ctx.roots.get(root);
    if (R === undefined) return false;
    const expected = join(R, relative(root, path));
    return ctx.platform === "win32" || ctx.platform === "darwin" ? real.toLowerCase() === expected.toLowerCase() : real === expected;
  } catch { return false; }
}
function fileFinding(file: CanonFile, stat: fs.Stats, ctx: Context): Why | undefined {
  if (stat.isSymbolicLink()) return "link";
  if (!stat.isFile()) return "not-a-file";
  if (stat.nlink !== 1) return "linked-copy";
  if (ctx.platform !== "win32") {
    if ((stat.mode & 0o777) !== 0o600) return "mode";
    if (stat.uid !== process.getuid?.()) return "owner";
  }
  if (stat.size !== file.bytes.length) return "changed";
}
function readFinding(file: CanonFile, stat: fs.Stats, ctx: Context): Why | undefined {
  let fd: number | undefined;
  try {
    const K = fs.constants;
    fd = (ctx.options.open ?? fs.openSync)(file.path, K.O_RDONLY | (K.O_NOFOLLOW ?? 0) | (K.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !same(opened, stat)) return "changed";
    const metadata = fileFinding(file, opened, ctx);
    const actualHash = hash(fs.readFileSync(fd));
    if (metadata) return metadata;
    if (actualHash !== file.sha256) return "changed";
    if (!same(opened, fs.lstatSync(file.path))) return "changed";
  } catch { return "changed"; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function inspect(plan: Plan, ctx: Context, query: boolean): void {
  const { path, root, folder } = plan;
  const stat = plan.stat;
  if (!stat) { plan.why = "missing"; return; }
  if (query) plan.inspection = ctx.options.query ? ctx.options.query(path) : reparseTag(path, ctx.options);
  // Also bracket an injected query; a changed identity is never unchanged use.
  if (query && !same(stat, fs.lstatSync(path))) plan.inspection = unknownReparse("Entry changed around inspection", ctx.options, true);
  if (folder) {
    if (stat.isSymbolicLink()) plan.why = "link";
    else if (!stat.isDirectory()) plan.why = "folder";
    else {
      if (path === root && !ctx.roots.has(root)) ctx.roots.set(root, fs.realpathSync.native(root));
      if (!identity(path, root, stat, ctx)) { plan.why = "folder"; plan.identityFailed = true; }
      else if (ctx.platform !== "win32" && stat.uid !== process.getuid?.()) plan.why = "owner";
      else if (ctx.platform !== "win32" && (stat.mode & 0o077)) plan.why = "mode";
      ctx.folders.set(path, stat);
    }
  } else {
    const file = plan.file!;
    plan.why = fileFinding(file, stat, ctx);
    // Even early metadata findings wait for query AND read-only inspection.
    if (stat.isFile()) {
      const content = readFinding(file, stat, ctx);
      plan.why ??= content;
    }
    if (ctx.platform === "win32" && !identity(path, root, stat, ctx)) { plan.why ??= "link"; plan.identityFailed = true; }
  }
  if (plan.inspection?.state === "unknown" && plan.inspection.identityChanged) { plan.why ??= folder ? "folder" : "changed"; plan.identityFailed = true; }
  if (plan.inspection?.state === "link") {
    plan.why = "link";
    // A confirmed redirect is the entry we must move aside, not an ancestor
    // we may follow. The query's before/after identity still has to match.
    plan.identityFailed = false;
  }
}
function recheck(path: string, root: string, ctx: Context, operation: string, includeSelf = false): void {
  ctx.options.beforeRecheck?.(path, operation);
  const last = includeSelf ? path : dirname(path);
  if (path === root && !includeSelf) return; // the owner's layout above native is outside this registry
  const chain = folderPaths({ root, path: join(last, "entry") } as CanonFile);
  for (const folder of chain) {
    const expected = ctx.folders.get(folder);
    const actual = lstat(folder);
    if (!expected || !actual || !actual.isDirectory() || actual.isSymbolicLink() || !same(expected, actual) || !identity(folder, root, actual, ctx)) {
      fail(folder, "folder", "Hook folder identity changed before " + operation);
    }
  }
}
function rename(from: string, to: string, root: string, ctx: Context, checkedPath = to): void {
  renameWithRetry(from, to, (a, b) => {
    recheck(checkedPath, root, ctx, "rename");
    (ctx.options.rename ?? fs.renameSync)(a, b);
  }, ctx.platform, ctx.options.sleep);
}
function moveAside(path: string, root: string, ctx: Context): string {
  const moved = join(dirname(path), `.murage-moved-${basename(path)}-${process.pid}-${(ctx.options.uuid ?? randomUUID)()}`);
  // Preserve existing entries, including an unlikely collision at the move name.
  if (lstat(moved)) fail(path, "changed", "Move-aside name already exists");
  rename(path, moved, root, ctx, path);
  return moved;
}
function logRepair(file: CanonFile, why: Why, moved: string[], ctx: Context): void {
  try {
    (ctx.options.log ?? console.info)(`hooks: Murage put back its tool check file for ${engineLabel[file.engine]} (${plain[why]}): ${JSON.stringify(file.path)}${moved.length ? `; moved aside to ${moved.join(", ")}, then put back` : ""}`);
  } catch { /* a completed repair does not depend on its log sink */ }
}
function repairFolder(plan: Plan, ctx: Context): void {
  const { path, root, why } = plan;
  if (!why) return;
  if (why === "owner") fail(path, why, "Hook folder belongs to another user");
  if (plan.identityFailed) fail(path, "folder", "Hook folder identity could not be confirmed");
  if (why === "mode") {
    let fd: number | undefined;
    try {
      recheck(path, root, ctx, "folder-open", true);
      const K = fs.constants;
      fd = (ctx.options.open ?? fs.openSync)(path, K.O_RDONLY | K.O_DIRECTORY | K.O_NOFOLLOW);
      if (!same(fs.fstatSync(fd), plan.stat!)) fail(path, "mode", "Folder handle identity changed");
      recheck(path, root, ctx, "folder-chmod", true);
      (ctx.options.chmod ?? fs.fchmodSync)(fd, 0o700);
    } catch (e) { if (e instanceof RepairFailure && e.why === "folder") throw e; fail(path, "mode", errorText(e)); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    return;
  }
  let moved: string | undefined;
  if (plan.stat) { moved = moveAside(path, root, ctx); ctx.folders.delete(path); }
  recheck(path, root, ctx, "mkdir"); fs.mkdirSync(path, { mode: 0o700 });
  const stat = fs.lstatSync(path);
  if (path === root) ctx.roots.set(root, fs.realpathSync.native(root));
  if (!stat.isDirectory() || !identity(path, root, stat, ctx)) fail(path, "folder", "Restored folder identity differs");
  ctx.folders.set(path, stat);
  const check: Plan = { path, root, folder: true, stat };
  inspect(check, ctx, ctx.platform === "win32");
  if (check.why) fail(path, check.why, "Restored folder failed inspection");
  if (moved) {
    try { (ctx.options.log ?? console.info)(`hooks: tool check folder moved aside to ${moved}, then put back`); } catch { /* logging only */ }
  }
}
function repairFile(plan: Plan, ctx: Context): void {
  const file = plan.file!, why = plan.why!;
  const moved: string[] = [];
  let temp: string | undefined, fd: number | undefined;
  try {
    if (why === "link" || why === "not-a-file") moved.push(moveAside(file.path, file.root, ctx));
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = join(dirname(file.path), `.${basename(file.path)}.${process.pid}.${(ctx.options.uuid ?? randomUUID)()}.tmp`);
      try {
        recheck(file.path, file.root, ctx, "temp-create");
        fd = (ctx.options.open ?? fs.openSync)(candidate, "wx", 0o600);
        temp = candidate; break; // ownership begins only after the exclusive open succeeds
      } catch (e) { if (codeOf(e) !== "EEXIST" || attempt === 2) throw e; }
    }
    if (fd === undefined || temp === undefined) fail(file.path, why, "No exclusive temp file");
    recheck(file.path, file.root, ctx, "temp-write"); (ctx.options.write ?? fs.writeFileSync)(fd, file.bytes);
    recheck(file.path, file.root, ctx, "temp-sync"); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    try { rename(temp, file.path, file.root, ctx); }
    catch (e) {
      if (ctx.platform !== "win32" || !["EPERM", "EACCES"].includes(String(codeOf(e)))) throw e;
      moved.push(moveAside(file.path, file.root, ctx));
      rename(temp, file.path, file.root, ctx);
    }
    temp = undefined;
    recheck(file.path, file.root, ctx, "directory-sync"); syncParentDirectory(file.path, ctx.platform);
    recheck(file.path, file.root, ctx, "post-restore");
    const check: Plan = { path: file.path, root: file.root, folder: false, file, stat: lstat(file.path) };
    inspect(check, ctx, ctx.platform === "win32");
    if (check.why) fail(file.path, check.why, "Restored hook failed inspection");
    logRepair(file, why, moved, ctx);
  } catch (error) {
    if (error instanceof RepairFailure) throw error;
    fail(file.path, why, errorText(error));
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve the repair error */ } }
    if (temp !== undefined) {
      // Never clean up a planted collision; only our successfully opened name.
      recheck(file.path, file.root, ctx, "temp-cleanup");
      try { (ctx.options.unlink ?? fs.unlinkSync)(temp); } catch { /* preserve the repair error */ }
    }
  }
}
function ensureFiles(files: CanonFile[], folders: Map<string, fs.Stats>, at: UsePoint, options: CanonOptions): Ensure {
  let current = files[0]?.path ?? "";
  try {
    folders.clear();
    const ctx: Context = { options, platform: options.platform ?? process.platform, at, folders, roots: new Map() };
    const plans: Plan[] = [], folderPlans = new Map<string, Plan>();
    const query = ctx.platform === "win32" && queryPoints.has(at);
    // Query-bearing Windows anchors inspect the whole set before mutation.
    // Else repair each folder before descending: a POSIX owner may have read
    // permission on a widened folder (0644) but no search permission on it.
    for (const file of files) {
      let obstructed = false;
      for (const path of folderPaths(file)) {
        current = path;
        let plan = folderPlans.get(path);
        if (!plan) {
          plan = { path, root: file.root, folder: true, stat: obstructed ? undefined : lstat(path) };
          if (!obstructed) inspect(plan, ctx, query); else plan.why = "missing";
          if (!query) {
            repairFolder(plan, ctx);
            // Descendants must use the verified replacement, not the old link
            // or obstruction. Shared ancestors are repaired only once.
            plan.stat = ctx.folders.get(path);
            plan.why = undefined;
          } else plans.push(plan);
          folderPlans.set(path, plan);
        }
        if (!plan.stat?.isDirectory() || plan.stat.isSymbolicLink() || plan.why === "link" || plan.identityFailed) obstructed = true;
      }
      current = file.path;
      const plan: Plan = { path: file.path, root: file.root, folder: false, file, stat: obstructed ? undefined : lstat(file.path) };
      if (!obstructed) inspect(plan, ctx, query); else plan.why = "missing";
      plans.push(plan);
    }
    // DECIDE: unknown never authorizes mutation, even of another entry.
    for (const plan of plans) {
      if (plan.inspection?.state === "unknown" && plan.why) fail(plan.path, plan.why, plan.inspection.error);
      if (plan.folder && plan.why === "owner") fail(plan.path, "owner", "Hook folder belongs to another user");
      if (plan.folder && plan.identityFailed) fail(plan.path, "folder", "Hook folder identity differs");
    }
    // REPAIR: verified ancestors are installed before any descendant writes.
    const restored: { path: string; why: Why }[] = [];
    for (const plan of plans) {
      current = plan.path;
      if (plan.folder) repairFolder(plan, ctx);
      else if (plan.why) { repairFile(plan, ctx); restored.push({ path: plan.path, why: plan.why }); }
    }
    return { ok: true, restored };
  } catch (e) {
    return { ok: false, path: e instanceof RepairFailure ? e.path : current, why: e instanceof RepairFailure ? e.why : "folder", error: errorText(e) };
  }
}

/** Synchronous, never throws. Callers must route ok:false before hand-off. */
export function ensureCanon(set: CanonSet, at: UsePoint, options: CanonOptions = {}): Ensure {
  try {
    const state = live.get(set.id);
    if (!state || state.set !== set) return { ok: false, path: "", why: "missing", error: "Canonical set is not live" };
    return ensureFiles(state.paths.map(path => generations.get(path)!.file), state.folders, at, options);
  } catch (e) { return { ok: false, path: "", why: "changed", error: errorText(e) }; }
}
/** The standalone writer uses the same inspection and restoration contract. */
export function restoreOne(file: CanonFile, options: CanonOptions = {}): Ensure {
  try { return ensureFiles([copyFile(file)], new Map(), "V-C1", options); }
  catch (e) { return { ok: false, path: file.path, why: "changed", error: errorText(e) }; }
}
export function ensureAllLive(at: UsePoint, options: CanonOptions = {}): Ensure[] {
  const results: Ensure[] = [];
  for (const state of [...live.values()]) {
    const result = ensureCanon(state.set, at, options); results.push(result);
    if (!result.ok) {
      // Attempt both callbacks even when an owner callback itself fails.
      try { state.owner.revoke?.(); } catch { /* stop still required */ }
      try { state.owner.stop?.(); } catch { /* other sets still require inspection */ }
    }
  }
  return results;
}

// These rendered bodies deliberately contain none of the shell metacharacters
// prohibited by T16. Launch-line quoting and script stdin adoption belong to S2.
const EVENT_CODEX = "let ev='PreToolUse';let evok=0;let raw=null;try{raw=f.readFileSync(0);const j=JSON.parse(raw.toString('utf8'));const n=j.hook_event_name;if(['PreToolUse','SessionStart','Stop','SubagentStop'].includes(n)){ev=n;evok=1}}catch(e){}if(evok===1){globalThis.MURAGE_HOOK_STDIN=raw}";
const DENY_CODEX = "function(e){if(e==='SessionStart'){return null}if(e==='Stop'){return null}if(e==='SubagentStop'){return null}return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Murage could not confirm its tool check'}}}";
function loader(engine: EngineName): string {
  const event = engine === "codex" ? EVENT_CODEX : "let ev=null;let evok=1;";
  const deny = engine === "codex" ? DENY_CODEX : engine === "antigravity" ? "function(e){return {decision:'deny',reason:'Murage could not confirm its tool check'}}" : "function(e){return null}";
  const exit = engine === "codex" ? "function(e){if(e==='SessionStart'){return 2}return 0}" : engine === "antigravity" ? "function(e){return 0}" : "function(e){return 1}";
  return "const f=require('fs'),c=require('crypto'),M=require('module'),P=require('path'),K=f.constants;const p=process.argv[1],h=process.argv[2];let b=null;"
    + "const w=function(s){const B=Buffer.from(s,'utf8');let o=0;while(B.length-o){const n=f.writeSync(1,B,o,B.length-o);if(n===0){throw new Error('w0')}o=o+n}};"
    + event + ";const DENY_OF=" + deny + ";const EXIT_OF=" + exit + ";"
    + "const d=function(){let ok=0;try{const D=DENY_OF(ev);if(D===null){}else{w(JSON.stringify(D))}ok=1}catch(e){}if(ok===1){process.exit(EXIT_OF(ev))}else{process.exit(" + (engine === "hermes" ? "1" : "2") + ")}};"
    + "if(evok===1){}else{d()}try{let fl=K.O_RDONLY;if(typeof K.O_NOFOLLOW==='number'){fl=fl+K.O_NOFOLLOW}if(typeof K.O_NONBLOCK==='number'){fl=fl+K.O_NONBLOCK}const fd=f.openSync(p,fl);if(f.fstatSync(fd).isFile()){b=f.readFileSync(fd)}else{b=null}f.closeSync(fd);if(b===null){d()}if(c.createHash('sha256').update(b).digest('hex')===h){}else{d()}if(typeof globalThis.MURAGE_LOADER_AFTER_VERIFY==='function'){globalThis.MURAGE_LOADER_AFTER_VERIFY()}globalThis.MURAGE_HOOK_FILE=p;if(p.endsWith('.mjs')){import('data:text/javascript;base64,'+b.toString('base64')).catch(d)}else{const m=new M(p,null);m.filename=p;m.paths=M._nodeModulePaths(P.dirname(p));m._compile(b.toString('utf8'),p)}}catch(e){d()}";
}
export const HOOK_LOADER: Readonly<Record<EngineName, string>> = Object.freeze({ codex: loader("codex"), antigravity: loader("antigravity"), hermes: loader("hermes") });
