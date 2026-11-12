import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { removeTempDir } from "./testing/cleanup.ts";
import type { CanonFile, CanonSet, CanonOptions } from "./hook-canon.ts";

let canon: typeof import("./hook-canon.ts");
let dir: string, root: string, file: CanonFile, set: CanonSet;
let sets: CanonSet[];
const digest = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const bytes = Buffer.from("module.exports = 'canonical';\n");
const log = vi.fn();
const options = (): CanonOptions => ({ log, sleep: () => {} });
function register(files: CanonFile[] = [file], owner = {}) {
  const s = canon.registerCanon(files, owner); sets.push(s); return s;
}
function put(path = file.path, data = bytes) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path, data, { mode: 0o600 });
}
function ensure(opts: CanonOptions = {}) { return canon.ensureCanon(set, "V-C1", { ...options(), ...opts }); }
function mutationSpies() {
  return { rename: vi.fn(fs.renameSync), open: vi.fn(fs.openSync), chmod: vi.fn(fs.fchmodSync), unlink: vi.fn(fs.unlinkSync) };
}
function noMutation(ops: ReturnType<typeof mutationSpies>) {
  expect(ops.rename).not.toHaveBeenCalled();
  expect(ops.open.mock.calls.filter(c => c[1] === "wx")).toHaveLength(0);
  expect(ops.chmod).not.toHaveBeenCalled();
  expect(ops.unlink).not.toHaveBeenCalled();
}
beforeEach(async () => {
  dir = fs.mkdtempSync(join(tmpdir(), "murage-canon-"));
  root = join(dir, "native"); sets = []; log.mockClear();
  // Dynamic import gives each missing-implementation RED a named assertion.
  canon = await import("./hook-canon.ts");
  file = { path: join(root, "codex-scope", "scope", "murage-hook.mjs"), root, bytes: Buffer.from(bytes), sha256: digest(bytes), kind: "script", engine: "codex" };
  set = register();
});
afterEach(async () => { for (const s of sets ?? []) canon?.dropCanon(s); if (dir) await removeTempDir(dir); vi.restoreAllMocks(); syncBuiltinESMExports(); });

describe("canonical hook files", () => {
  it("T1 restores a missing F1 and logs one plain explanation", () => {
    expect(ensure()).toEqual({ ok: true, restored: [{ path: file.path, why: "missing" }] });
    expect(fs.readFileSync(file.path)).toEqual(bytes);
    expect(log).toHaveBeenCalledTimes(1); expect(log.mock.calls[0][0]).toContain("it was missing");
    expect(log.mock.calls[0][0]).toContain(file.path);
  });
  it("T2 restores a same-size content change", () => {
    put(file.path, Buffer.from(bytes.toString().replace("canonical", "malicious")));
    expect(ensure()).toMatchObject({ ok: true, restored: [{ why: "changed" }] });
    expect(fs.readFileSync(file.path)).toEqual(bytes);
  });
  it("T3 restores an appended byte", () => {
    put(file.path, Buffer.concat([bytes, Buffer.from("x")]));
    expect(ensure()).toMatchObject({ ok: true, restored: [{ why: "changed" }] });
    expect(fs.readFileSync(file.path)).toEqual(bytes);
  });
  it("T4 replaces a canonical-byte symlink without changing its outside target", () => {
    const outside = join(dir, "outside"); put(outside); fs.mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, file.path); const before = fs.statSync(outside);
    expect(ensure()).toMatchObject({ ok: true, restored: [{ why: "link" }] });
    expect(fs.lstatSync(file.path).isFile()).toBe(true);
    expect(fs.statSync(outside).mtimeMs).toBe(before.mtimeMs); expect(fs.readFileSync(outside)).toEqual(bytes);
    const moved = fs.readdirSync(dirname(file.path)).find(n => n.startsWith(".murage-moved-"))!;
    expect(fs.lstatSync(join(dirname(file.path), moved)).isSymbolicLink()).toBe(true);
  });
  it("T5 moves a substituted scope link aside and restores F1-F4 without visiting its target", () => {
    const files = [file, ...["murage-hook.cmd", "hooks.json", "hook-env/123-gate.env"].map((p, i) => ({ ...file, path: join(dirname(file.path), p), kind: ["launcher", "config", "env"][i] as CanonFile["kind"] }))];
    canon.dropCanon(set); set = register(files);
    const outside = join(dir, "outside"); fs.mkdirSync(outside); put(join(outside, "sentinel"));
    fs.mkdirSync(dirname(dirname(file.path)), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, dirname(file.path), "dir"); const before = fs.readdirSync(outside);
    expect(ensure()).toMatchObject({ ok: true, restored: files.map(f => ({ path: f.path, why: "missing" })) });
    for (const f of files) expect(fs.readFileSync(f.path)).toEqual(bytes);
    expect(fs.readdirSync(outside)).toEqual(before);
    const parent = dirname(dirname(file.path)); const moved = fs.readdirSync(parent).find(n => n.startsWith(".murage-moved-"))!;
    expect(fs.lstatSync(join(parent, moved)).isSymbolicLink()).toBe(true);
  });
  it("T5 also replaces a link at native itself without touching its target", () => {
    const outside = join(dir, "outside"); fs.mkdirSync(outside); put(join(outside, "sentinel"));
    fs.symlinkSync(outside, root, "dir");
    expect(ensure()).toMatchObject({ ok: true });
    expect(fs.readdirSync(outside)).toEqual(["sentinel"]); expect(fs.readFileSync(file.path)).toEqual(bytes);
  });
  it("T6 replaces a hard link with a distinct inode", () => {
    put(); const outside = join(dir, "outside"); fs.linkSync(file.path, outside);
    expect(ensure()).toMatchObject({ ok: true, restored: [{ why: "linked-copy" }] });
    expect(fs.statSync(file.path).ino).not.toBe(fs.statSync(outside).ino); expect(fs.readFileSync(outside)).toEqual(bytes);
  });
  it("T7 repairs file mode and tightens the verified folder handle", () => {
    put(); fs.chmodSync(file.path, 0o644); fs.chmodSync(dirname(file.path), 0o755);
    const chmod = vi.fn(fs.fchmodSync);
    expect(ensure({ chmod })).toMatchObject({ ok: true, restored: [{ why: "mode" }] });
    expect(fs.statSync(file.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirname(file.path)).mode & 0o777).toBe(0o700);
    expect(chmod).toHaveBeenCalledWith(expect.any(Number), 0o700);
  });
  it.each(["native", "codex-scope", "scope"])("T7 repairs non-searchable 0644 %s before inspecting children as its non-root owner", folder => {
    expect(process.getuid?.(), "this regression must run as a non-root POSIX owner").not.toBe(0);
    put();
    const path = folder === "native" ? root : folder === "codex-scope" ? dirname(dirname(file.path)) : dirname(file.path);
    const before = fs.statSync(file.path);
    fs.chmodSync(path, 0o644);
    const chmod = vi.fn(fs.fchmodSync);
    try {
      expect(ensure({ chmod })).toEqual({ ok: true, restored: [] });
      expect(fs.statSync(path).mode & 0o777).toBe(0o700);
      expect(chmod).toHaveBeenCalledWith(expect.any(Number), 0o700);
      expect(fs.statSync(file.path).ino).toBe(before.ino);
      expect(fs.readFileSync(file.path)).toEqual(bytes);
    } finally { fs.chmodSync(path, 0o700); }
  });
  it("T7 refuses a failed folder handle chmod before descendant repair", () => {
    put(file.path, Buffer.from("changed")); const scope = dirname(file.path);
    fs.chmodSync(scope, 0o644);
    const chmod = vi.fn(() => { throw Object.assign(new Error("chmod refused"), { code: "EPERM" }); });
    const ops = mutationSpies();
    try {
      expect(ensure({ ...ops, chmod })).toMatchObject({ ok: false, path: scope, why: "mode" });
      expect(chmod).toHaveBeenCalledTimes(1);
      expect(ops.rename).not.toHaveBeenCalled();
      expect(ops.open.mock.calls.filter(c => c[1] === "wx")).toHaveLength(0);
      expect(fs.statSync(scope).mode & 0o777).toBe(0o644);
    } finally { fs.chmodSync(scope, 0o700); }
    expect(fs.readFileSync(file.path, "utf8")).toBe("changed");
  });
  it("T8 preserves an obstructing directory and its contents", () => {
    put(join(file.path, "kept"));
    expect(ensure()).toMatchObject({ ok: true, restored: [{ why: "not-a-file" }] });
    const moved = fs.readdirSync(dirname(file.path)).find(n => n.startsWith(".murage-moved-"))!;
    expect(fs.readFileSync(join(dirname(file.path), moved, "kept"))).toEqual(bytes);
  });
  it.each([false, true])("T9 win32 exhausted replace moves aside without chmod (hard link %s)", hardlink => {
    put(file.path, Buffer.from("old bytes")); const outside = join(dir, "outside");
    if (hardlink) fs.linkSync(file.path, outside);
    fs.chmodSync(file.path, 0o400); const before = fs.statSync(file.path);
    let refused = 0;
    const rename = vi.fn((a: fs.PathLike, b: fs.PathLike) => {
      if (String(a).endsWith(".tmp") && b === file.path && refused++ < 6) throw Object.assign(new Error("locked"), { code: "EPERM" });
      fs.renameSync(a, b);
    });
    const chmod = vi.fn(fs.fchmodSync); const pathnameChmod = vi.spyOn(fs, "chmodSync");
    syncBuiltinESMExports();
    expect(ensure({ platform: "win32", query: () => ({ state: "clean" }), rename, chmod })).toMatchObject({ ok: true });
    expect(refused).toBe(7); expect(chmod).not.toHaveBeenCalled(); expect(pathnameChmod).not.toHaveBeenCalled();
    const moved = join(dirname(file.path), fs.readdirSync(dirname(file.path)).find(n => n.startsWith(".murage-moved-"))!);
    expect(fs.readFileSync(moved, "utf8")).toBe("old bytes"); expect(fs.statSync(moved).mode).toBe(before.mode);
    expect(fs.readFileSync(file.path)).toEqual(bytes);
    if (hardlink) { expect(fs.statSync(outside).mode).toBe(before.mode); expect(fs.readFileSync(outside, "utf8")).toBe("old bytes"); }
  });
  it("T10 persistent EPERM returns failure and never truncates the target", () => {
    put(file.path, Buffer.from("prior bytes"));
    const rename = vi.fn(() => { throw Object.assign(new Error("share-delete locked"), { code: "EPERM" }); });
    expect(ensure({ platform: "win32", query: () => ({ state: "clean" }), rename })).toMatchObject({ ok: false, path: file.path });
    expect(fs.readFileSync(file.path, "utf8")).toBe("prior bytes");
    expect(fs.readdirSync(dirname(file.path)).filter(n => n.endsWith(".tmp"))).toEqual([]);
  });
  it("T10 partial temp write failure leaves the target intact", () => {
    put(file.path, Buffer.from("prior bytes"));
    const write = ((fd: number) => { fs.writeSync(fd, "partial"); throw new Error("disk full"); }) as typeof fs.writeFileSync;
    expect(ensure({ write })).toMatchObject({ ok: false });
    expect(fs.readFileSync(file.path, "utf8")).toBe("prior bytes");
  });
  it("T11 unchanged canon performs no mutations and emits no log", () => {
    put(); const ops = mutationSpies();
    expect(ensure(ops)).toEqual({ ok: true, restored: [] }); noMutation(ops); expect(log).not.toHaveBeenCalled();
  });
  it("T12 an occupied temp symlink is not followed or cleaned up", () => {
    put(file.path, Buffer.from("changed")); const outside = join(dir, "outside"); put(outside, Buffer.from("sentinel"));
    const planted = join(dirname(file.path), `.${basename(file.path)}.${process.pid}.planted.tmp`); fs.symlinkSync(outside, planted);
    const uuid = vi.fn().mockReturnValueOnce("planted").mockReturnValue("fresh");
    const result = ensure({ uuid });
    // Check the outside-write witness first, including when a bad temp open
    // also makes the post-restore check fail.
    expect(fs.readFileSync(outside, "utf8")).toBe("sentinel");
    expect(result).toMatchObject({ ok: true });
    expect(uuid).toHaveBeenCalledTimes(2); expect(fs.lstatSync(planted).isSymbolicLink()).toBe(true);
  });
  it("T12 stops after three occupied temp names and preserves each entry", () => {
    put(file.path, Buffer.from("prior"));
    for (const id of ["one", "two", "three"]) put(join(dirname(file.path), `.${basename(file.path)}.${process.pid}.${id}.tmp`), Buffer.from(id));
    const uuid = vi.fn().mockReturnValueOnce("one").mockReturnValueOnce("two").mockReturnValueOnce("three");
    expect(ensure({ uuid })).toMatchObject({ ok: false }); expect(uuid).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(file.path, "utf8")).toBe("prior");
    for (const id of ["one", "two", "three"]) expect(fs.readFileSync(join(dirname(file.path), `.${basename(file.path)}.${process.pid}.${id}.tmp`), "utf8")).toBe(id);
  });
  it("one current generation survives replacement registration and either owner's drop", () => {
    const newer = Buffer.from("current generation"); const other = register([{ ...file, bytes: newer, sha256: digest(newer) }]);
    newer.fill(0); file.bytes.fill(0); // caller buffers cannot rewrite the canonical generation
    expect(set.files[0].bytes.toString()).toBe("current generation");
    expect(ensure()).toMatchObject({ ok: true }); expect(fs.readFileSync(file.path, "utf8")).toBe("current generation");
    canon.dropCanon(other); put(file.path, Buffer.from("changed"));
    expect(canon.ensureAllLive("V-ANY", options())).toHaveLength(1);
    expect(fs.readFileSync(file.path, "utf8")).toBe("current generation");
    canon.dropCanon(set); expect(canon.ensureAllLive("V-ANY", options())).toEqual([]);
  });
  it("a failed live set revokes and stops its owner even if revoke throws", () => {
    canon.dropCanon(set); const revoke = vi.fn(() => { throw new Error("revoke callback"); }); const stop = vi.fn();
    set = register([file], { engineInstance: "child-1", turn: "turn-1", revoke, stop });
    const result = canon.ensureAllLive("V-ANY", { ...options(), open: (() => { throw new Error("no write"); }) as typeof fs.openSync });
    expect(result).toMatchObject([{ ok: false }]); expect(revoke).toHaveBeenCalledTimes(1); expect(stop).toHaveBeenCalledTimes(1);
  });
  it("refuses a parent substitution before temp creation without outside mutation", () => {
    put(file.path, Buffer.from("changed")); const outside = join(dir, "outside"); fs.mkdirSync(outside); put(join(outside, basename(file.path)), Buffer.from("sentinel"));
    let swapped = false;
    const result = ensure({ beforeRecheck: (_path, op) => {
      if (op !== "temp-create" || swapped) return;
      swapped = true; fs.renameSync(dirname(file.path), join(dir, "old-scope")); fs.symlinkSync(outside, dirname(file.path), "dir");
    } });
    expect(result).toMatchObject({ ok: false, why: "folder" });
    expect(fs.readdirSync(outside)).toEqual([basename(file.path)]); expect(fs.readFileSync(join(outside, basename(file.path)), "utf8")).toBe("sentinel");
  });
});

describe("T25 inspection before mutation", () => {
  const unknown = () => ({ state: "unknown" as const, error: "query unavailable" });
  it("ordinary files and folders stay unchanged after clean inspection", () => {
    put(); const ops = mutationSpies(); const query = vi.fn(() => ({ state: "clean" as const }));
    expect(ensure({ ...ops, platform: "win32", query })).toEqual({ ok: true, restored: [] }); noMutation(ops);
    expect(query.mock.calls).toHaveLength(4);
  });
  it("unknown inspection permits unchanged canon", () => {
    put(); const ops = mutationSpies(); expect(ensure({ ...ops, platform: "win32", query: unknown })).toEqual({ ok: true, restored: [] }); noMutation(ops);
  });
  it.each(["size", "hash", "nlink", "folder"])("unknown plus %s failure blocks every mutation in the set", fault => {
    put();
    if (fault === "size") fs.appendFileSync(file.path, "x");
    if (fault === "hash") fs.writeFileSync(file.path, bytes.toString().replace("canonical", "malicious"));
    if (fault === "nlink") fs.linkSync(file.path, join(dir, "outside"));
    if (fault === "folder") { fs.renameSync(dirname(file.path), join(dir, "old-scope")); fs.writeFileSync(dirname(file.path), "obstruction"); }
    const missing = { ...file, path: join(root, "earlier-missing", "hook.cjs") };
    canon.dropCanon(set); set = register([missing, file]);
    const ops = mutationSpies(); const exec = vi.fn(() => { throw Object.assign(new Error("unclassified"), { code: "EACCES" }); });
    expect(ensure({ ...ops, platform: "win32", exec })).toMatchObject({ ok: false });
    expect(exec).toHaveBeenCalled(); noMutation(ops); expect(fs.existsSync(dirname(missing.path))).toBe(false);
  });
  it("missing files get no query and are restored, then inspected", () => {
    const query = vi.fn((path: string) => { expect(fs.existsSync(path)).toBe(true); return { state: "clean" as const }; });
    expect(ensure({ platform: "win32", query })).toMatchObject({ ok: true });
    expect(query.mock.calls.some(([p]) => p === file.path)).toBe(true);
  });
  it("a confirmed non-junction tag moves the affected entry aside (classification seam)", () => {
    put(); let tagged = true;
    const query = (path: string) => { if (path === file.path && tagged) { tagged = false; return { state: "link" as const, tag: "0x9000001a" }; } return { state: "clean" as const }; };
    expect(ensure({ platform: "win32", query })).toMatchObject({ ok: true, restored: [{ why: "link" }] });
    expect(fs.readdirSync(dirname(file.path)).some(n => n.startsWith(".murage-moved-"))).toBe(true);
  });
  it("a tagged folder is preserved and its descendants are restored in a new folder", () => {
    put(); const scope = dirname(file.path); const before = fs.statSync(scope); let tagged = true;
    const query = (path: string) => {
      if (path === scope && tagged) { tagged = false; return { state: "link" as const, tag: "0x8000001b" }; }
      return { state: "clean" as const };
    };
    expect(ensure({ platform: "win32", query })).toMatchObject({ ok: true, restored: [{ why: "missing" }] });
    expect(fs.statSync(scope).ino).not.toBe(before.ino);
    const moved = join(dirname(scope), fs.readdirSync(dirname(scope)).find(n => n.startsWith(".murage-moved-"))!);
    expect(fs.readFileSync(join(moved, basename(file.path)))).toEqual(bytes); expect(fs.readFileSync(file.path)).toEqual(bytes);
  });
  it("reparseTag uses a bounded absolute utility invocation and recognizes ordinary status 4390", () => {
    put(); const exec = vi.fn(() => { throw Object.assign(new Error("exit 1"), { stdout: "Error: The file or directory is not a reparse point. (4390)", status: 1 }); });
    expect(canon.reparseTag(file.path, { exec })).toEqual({ state: "clean" });
    expect(exec).toHaveBeenCalledWith(expect.stringMatching(/^[A-Z]:\\Windows\\System32\\fsutil\.exe$/i), ["reparsepoint", "query", file.path], expect.objectContaining({ timeout: 5000, shell: false }));
  });
  it.each(["EACCES", "ETIMEDOUT"])("reparseTag classifies %s as unknown without changing the entry", code => {
    put(); const before = fs.statSync(file.path);
    const exec = vi.fn(() => { throw Object.assign(new Error(code), { code }); });
    expect(canon.reparseTag(file.path, { exec })).toMatchObject({ state: "unknown" });
    expect(fs.statSync(file.path).ino).toBe(before.ino); expect(fs.readFileSync(file.path)).toEqual(bytes);
  });
  it("an identity swap around the utility query is unknown", () => {
    put(); const exec = vi.fn(() => { fs.renameSync(file.path, join(dir, "old-file")); put(); return "Reparse Tag Value : 0x9000001a"; });
    expect(canon.reparseTag(file.path, { exec })).toMatchObject({ state: "unknown" });
  });
});

describe("rendered loader bodies", () => {
  it.each(["codex", "antigravity", "hermes"] as const)("%s verifies and executes a buffer without shell metacharacters", engine => {
    const source = "require('fs').writeFileSync(process.argv[3], 'ran')";
    const path = join(dir, "hook.cjs"), marker = join(dir, "marker"); put(path, Buffer.from(source));
    expect(canon.HOOK_LOADER[engine]).not.toMatch(/["$`\\%!^&|<>\r\n]/);
    const result = spawnSync(process.execPath, ["-e", canon.HOOK_LOADER[engine], path, digest(source), marker], { input: '{"hook_event_name":"PreToolUse"}', encoding: "utf8", timeout: 5000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(fs.readFileSync(marker, "utf8")).toBe("ran");
  });
  it.each([
    ["codex", "PreToolUse", 0, "permissionDecision"], ["codex", "SessionStart", 2, ""],
    ["codex", "Stop", 0, ""], ["codex", "SubagentStop", 0, ""],
    ["antigravity", "PreToolUse", 0, "decision"], ["hermes", "PreToolUse", 1, ""],
  ] as const)("%s %s fails with its own protocol", (engine, event, status, key) => {
    const result = spawnSync(process.execPath, ["-e", canon.HOOK_LOADER[engine], join(dir, "missing.cjs"), digest(bytes)], { input: JSON.stringify({ hook_event_name: event }), encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(status);
    if (key) expect(result.stdout).toContain(`"${key}":"deny"`); else expect(result.stdout).toBe("");
  });
});

it("T18 pins the five bundled static artifacts", async () => {
  const { CODEX_HOOK_SCRIPT, hookWindowsLauncher } = await import("./drivers/codex-hook.ts");
  const { ANTIGRAVITY_RELAY_SCRIPT } = await import("./drivers/antigravity-relay.ts");
  const { ANTIGRAVITY_ASK_HOOK_SOURCE } = await import("./drivers/antigravity.ts");
  const { HERMES_ASK_HOOK_SOURCE } = await import("./drivers/acp/hermes.ts");
  // S2 adds authenticated env reads, cached stdin and the inline loader.
  // Keep literal pins; never derive the expectations. The first two pins also
  // include the preB-locale wording change from "safety check" to "tool check".
  expect([CODEX_HOOK_SCRIPT, hookWindowsLauncher(), ANTIGRAVITY_RELAY_SCRIPT, ANTIGRAVITY_ASK_HOOK_SOURCE, HERMES_ASK_HOOK_SOURCE].map(digest)).toEqual([
    "fdb23c85d18cdd4dd371bfc1265d134477ed77b19360d13131009cc4421d12bc",
    "d702c52b49d07e0cde12f88bc9593626a9e899c0bd9764ae96013977cb711a65",
    "b099a4f718660714bf0e1dbe775c4f3b4f8557199f8dd7dd5201dd930a5ca244",
    "7b544440c92b151e4d1cb972178f6f02ea93ef87149da22619e03634d13eb72e",
    "90783cc2dc5fe0f3fcd9711415f756325c0fefef3a8bd0a82b56a2e60f1f05c1",
  ]);
});


for (const engine of ['codex', 'hermes'] as const) it(`R3 real ${engine} repair obstruction preserves the other delivery set`, async () => {
  const safety = await import('./hook-safety.ts');
  const brokenFile = { ...file, engine };
  const healthyFile = { ...file, engine: engine === 'codex' ? 'hermes' as const : 'codex' as const, path: join(root, 'healthy', 'hook') };
  // Retire the default registration before assigning this file's engine.
  canon.dropCanon(set);
  const broken = register([brokenFile]), healthy = register([healthyFile]);
  const brokenOwner = { engine, revoke: vi.fn(), stop: vi.fn() };
  const healthyOwner = { engine: healthyFile.engine, revoke: vi.fn(), stop: vi.fn() };
  safety.ownHookCanon(broken, brokenOwner); safety.ownHookCanon(healthy, healthyOwner);
  expect(canon.ensureCanon(broken, 'V-C1').ok).toBe(true);
  expect(canon.ensureCanon(healthy, 'V-C1').ok).toBe(true);
  fs.writeFileSync(file.path, 'changed bytes');
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === file.path) throw Object.assign(new Error('fixture locked replacement'), { code: 'EIO' });
    return rename(from, to);
  });
  syncBuiltinESMExports();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(safety.checkAllHookCanon('V-H2', healthy)).toBe(true);
    expect(fs.readFileSync(file.path, 'utf8')).toBe('changed bytes');
    expect(fs.readFileSync(healthyFile.path)).toEqual(bytes);
    expect(healthyOwner.revoke).not.toHaveBeenCalled(); expect(healthyOwner.stop).not.toHaveBeenCalled();
    expect(brokenOwner.revoke).toHaveBeenCalledOnce(); expect(brokenOwner.stop).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(engine));
    expect(warn.mock.calls[0][0]).toContain(file.path);
  } finally { safety.releaseHookCanon(broken); safety.releaseHookCanon(healthy); }
});

it('R3 a foreign changed file is restored atomically without revoking the healthy delivery', async () => {
  const safety = await import('./hook-safety.ts');
  const healthyFile = { ...file, engine: 'hermes' as const, path: join(root, 'hermes', 'hook') };
  const healthy = register([healthyFile]);
  const owner = { engine: 'Hermes', revoke: vi.fn(), stop: vi.fn() };
  safety.ownHookCanon(healthy, owner);
  expect(ensure().ok).toBe(true); expect(canon.ensureCanon(healthy, 'V-H1').ok).toBe(true);
  fs.writeFileSync(file.path, 'changed bytes');
  const originalInode = fs.statSync(file.path).ino;
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    expect(safety.checkAllHookCanon('V-H2', healthy)).toBe(true);
    expect(fs.readFileSync(file.path)).toEqual(bytes);
    expect(fs.statSync(file.path).ino).not.toBe(originalInode);
    expect(owner.revoke).not.toHaveBeenCalled(); expect(owner.stop).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Codex'));
    expect(info.mock.calls[0][0]).toContain(file.path);
  } finally { safety.releaseHookCanon(healthy); }
});

it("loads in the server's native TypeScript runtime", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `await import(${JSON.stringify(new URL("./hook-canon.ts", import.meta.url).href)})`], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
});
