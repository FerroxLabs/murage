import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { dropCanon, ensureCanon, registerCanon, reparseTag, type CanonFile, type CanonOptions } from "./hook-canon.ts";
import { removeTempDir } from "./testing/cleanup.ts";

// A portable regression for the review's excluded Windows gate. The actual
// native cases below must run on Windows; injected tags do not qualify them.
it("T25 native Windows cases are selected by the Windows gate", () => {
  const rows = fs.readFileSync(new URL("../ci/gate-tests.txt", import.meta.url), "utf8").split(/\r?\n/);
  const row = rows.find(line => line.startsWith("server/hook-canon-windows.test.ts\t"));
  expect(row, "native T25 must be a blocking Windows gate").toBeDefined();
  expect(row!.split("\t")[1].split("+")).toContain("windows");
});

const bytes = Buffer.from("module.exports = 'canonical';\n");
const roots: string[] = [];
const system32 = (exe: string) => win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
function command(exe: string, args: string[]) {
  return execFileSync(system32(exe), args, { encoding: "utf8", timeout: 10000, windowsHide: true, shell: false });
}
function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), "murage-t25-")); roots.push(dir);
  const root = join(dir, "native"); fs.mkdirSync(root);
  const path = join(root, "hook.cjs"); fs.writeFileSync(path, bytes);
  return { dir, root, path };
}
function canonical(path: string, root: string): CanonFile {
  return { path, root, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), engine: "codex", kind: "script" };
}
function spies() {
  return { rename: vi.fn(fs.renameSync), open: vi.fn(fs.openSync), chmod: vi.fn(fs.fchmodSync), unlink: vi.fn(fs.unlinkSync) };
}
function unchanged(ops: ReturnType<typeof spies>) {
  expect(ops.rename).not.toHaveBeenCalled();
  expect(ops.open.mock.calls.filter(call => call[1] === "wx")).toHaveLength(0);
  expect(ops.chmod).not.toHaveBeenCalled(); expect(ops.unlink).not.toHaveBeenCalled();
}
function ensure(path: string, root: string, options: CanonOptions = {}) {
  const set = registerCanon([canonical(path, root)]);
  try { return ensureCanon(set, "V-C1", options); } finally { dropCanon(set); }
}
// Record the real utility output without substituting its classification.
const recordedExec: NonNullable<CanonOptions["exec"]> = (exe, args, options) => {
  try { const output = execFileSync(exe, args, options); console.info(JSON.stringify({ exe, args, output })); return output; }
  catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number; code?: string };
    console.info(JSON.stringify({ exe, args, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), status: e.status, code: e.code }));
    throw error;
  }
};
afterEach(async () => { for (const dir of roots.splice(0)) await removeTempDir(dir); });

describe.skipIf(process.platform !== "win32")("T25 native Windows (non-elevated)", () => {
  it("runs as a non-elevated user", () => {
    const groups = command("whoami.exe", ["/groups", "/fo", "csv", "/nh"]);
    console.info(groups);
    expect(groups).toContain("S-1-16-8192"); // medium integrity
    expect(groups).not.toMatch(/S-1-16-(?:12288|16384)/); // high/system integrity
  });
  it("ordinary file and folder are clean and unchanged", () => {
    const { root, path } = fixture(); const before = fs.statSync(path); const ops = spies();
    expect(reparseTag(root, { exec: recordedExec })).toEqual({ state: "clean" });
    expect(reparseTag(path, { exec: recordedExec })).toEqual({ state: "clean" });
    expect(ensure(path, root, { ...ops, exec: recordedExec })).toEqual({ ok: true, restored: [] });
    unchanged(ops); expect(fs.statSync(path).ino).toBe(before.ino); expect(fs.readFileSync(path)).toEqual(bytes);
  });
  it("junction is moved aside and restored without changing its target", () => {
    const { dir, root } = fixture(); const outside = join(dir, "outside"); fs.mkdirSync(outside);
    const target = join(outside, "hook.cjs"); fs.writeFileSync(target, bytes);
    const before = fs.statSync(target); const scope = join(root, "scope"); fs.symlinkSync(outside, scope, "junction");
    expect(reparseTag(scope, { exec: recordedExec })).toMatchObject({ state: "link", tag: "0xa0000003" });
    expect(ensure(join(scope, "hook.cjs"), root, { exec: recordedExec })).toMatchObject({ ok: true });
    expect(fs.lstatSync(scope).isSymbolicLink()).toBe(false);
    expect(fs.readdirSync(outside)).toEqual(["hook.cjs"]); expect(fs.statSync(target).ino).toBe(before.ino);
    expect(fs.readFileSync(target)).toEqual(bytes);
    const moved = fs.readdirSync(root).find(name => name.startsWith(".murage-moved-scope-"));
    expect(moved).toBeDefined(); expect(fs.lstatSync(join(root, moved!)).isSymbolicLink()).toBe(true);
  });
  it("cloud non-junction reparse file is moved aside and restored", () => {
    // MAIN provisions a disposable online-only OneDrive fixture as documented.
    // An absent fixture is a failure on Windows, never a silent skip or seam.
    const path = process.env.MURAGE_T25_CLOUD_FILE;
    expect(path, "provide the dedicated online-only fixture described in docs/verification/hook-canon-windows.md").toBeTruthy();
    expect(basename(path!)).toBe("murage-t25-cloud.cjs");
    expect(basename(dirname(path!))).toMatch(/^murage-t25-cloud-/);
    expect(fs.lstatSync(path!).isSymbolicLink()).toBe(false);
    const inspection = reparseTag(path!, { exec: recordedExec });
    expect(inspection.state).toBe("link");
    if (inspection.state !== "link") throw new Error("native non-junction fixture is required");
    expect(inspection.tag.toLowerCase()).not.toMatch(/^0xa000000[3c]$/);
    const root = dirname(path!);
    expect(ensure(path!, root, { exec: recordedExec })).toMatchObject({ ok: true, restored: [{ why: "link" }] });
    expect(reparseTag(path!, { exec: recordedExec })).toEqual({ state: "clean" });
    expect(fs.readFileSync(path!)).toEqual(bytes);
    expect(fs.readdirSync(root).some(name => name.startsWith(".murage-moved-murage-t25-cloud.cjs-"))).toBe(true);
  });
  it("ACL read-attributes denial is unknown and permits no repair mutation", () => {
    const { root, path } = fixture(); const ops = spies();
    fs.writeFileSync(path, "changed");
    const sid = /S-1-5-[0-9-]+/.exec(command("whoami.exe", ["/user", "/fo", "csv", "/nh"]))?.[0];
    expect(sid).toBeDefined();
    try {
      console.info(command("icacls.exe", [path, "/deny", `*${sid}:(RA)`]));
      // lstat itself may be denied, so record the real utility result even
      // when reparseTag correctly stops before reaching its utility call.
      try { recordedExec(system32("fsutil.exe"), ["reparsepoint", "query", path],
        { encoding: "utf8", timeout: 5000, windowsHide: true, shell: false }); } catch { /* recorded above */ }
      expect(reparseTag(path, { exec: recordedExec })).toMatchObject({ state: "unknown" });
      expect(ensure(path, root, { ...ops, exec: recordedExec })).toMatchObject({ ok: false });
      unchanged(ops);
    } finally { console.info(command("icacls.exe", [path, "/remove:d", `*${sid}`])); }
    expect(fs.readFileSync(path, "utf8")).toBe("changed");
  });
  it.each([false, true])("timeout is unknown with zero mutation (changed %s)", changed => {
    const { root, path } = fixture(); if (changed) fs.writeFileSync(path, "changed");
    const exec = vi.fn(() => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); });
    const ops = spies();
    expect(reparseTag(path, { exec })).toMatchObject({ state: "unknown" });
    expect(ensure(path, root, { ...ops, exec })).toMatchObject({ ok: !changed }); unchanged(ops);
    expect(exec).toHaveBeenCalled();
  });
});
