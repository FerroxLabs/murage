import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("./browser-windows-identity.ts", () => ({ verifyWindowsBrowserSignatures: vi.fn(async () => { throw new Error("Native signature calls are forbidden in this source fixture"); }) }));
import { createWindowsBackupResourceResolver, observeWindowsBackupFile, WINDOWS_BACKUP_RAW_SHA256, type WindowsBackupResourceDependencies } from "./windows-backup-resources.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function localFile(bytes = "fixture-content") {
  const directory = mkdtempSync(join(tmpdir(), "murage-windows-resource-test-")); roots.push(directory);
  const path = join(directory, "resource"); writeFileSync(path, bytes); return { directory, path };
}
const app = "C:\\Installed\\Murage.exe", resources = "C:\\Installed\\resources", tools = win32.join(resources, "backup-tools", "x64"), helper = win32.join(tools, "murage-backup-age.exe");
function directoryStat(ino: bigint, symbolic = false): BigIntStats {
  return { dev: 1n, ino, size: 0n, nlink: 1n, mtimeNs: 1n, ctimeNs: 1n, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => symbolic } as BigIntStats;
}
function fixture() {
  const entries = new Map([
    [app, { digest: "app", dirty: false, closed: false }],
    [helper, { digest: "helper", dirty: false, closed: false }],
    [win32.join(tools, "age.exe"), { digest: WINDOWS_BACKUP_RAW_SHA256.age, dirty: false, closed: false }],
    [win32.join(tools, "age-keygen.exe"), { digest: WINDOWS_BACKUP_RAW_SHA256.keygen, dirty: false, closed: false }],
    [win32.join(tools, "LICENSE"), { digest: WINDOWS_BACKUP_RAW_SHA256.license, dirty: false, closed: false }],
  ]);
  const ids = new Map<string, bigint>(), redirects = new Map<string, string>();
  let symbolicDirectory = "", replacedDirectory = "", closeFailure = "";
  const observeFile = vi.fn((path: string, max: number) => {
    expect(max).toBeGreaterThan(0); const entry = entries.get(path); if (!entry) throw new Error("missing resource");
    return { sha256: entry.digest, assertUnchanged: () => { if (entry.dirty) throw new Error("resource changed"); },
      close: () => { entry.closed = true; if (path === closeFailure) throw new Error("close failure"); } };
  });
  const verifySignatures = vi.fn(async (_paths: string[]) => {});
  const io: WindowsBackupResourceDependencies = {
    platform: "win32", arch: "x64", observeFile, verifySignatures,
    realpath: path => redirects.get(path) ?? path,
    lstat: path => { if (!ids.has(path)) ids.set(path, BigInt(ids.size + 1)); return directoryStat(ids.get(path)! + (path === replacedDirectory ? 100n : 0n), path === symbolicDirectory); },
  };
  return { entries, redirects, io, observeFile, verifySignatures,
    set symbolicDirectory(path: string) { symbolicDirectory = path; },
    set replacedDirectory(path: string) { replacedDirectory = path; },
    set closeFailure(path: string) { closeFailure = path; },
    resolve: () => createWindowsBackupResourceResolver({ resourcesPath: resources, currentExecutable: app }, io)(),
  };
}

it("returns only the fixed helper after app/helper signatures and all raw pins", async () => {
  const f = fixture(); await expect(f.resolve()).resolves.toEqual({ executable: helper });
  expect(f.verifySignatures).toHaveBeenCalledExactlyOnceWith([app, helper]);
  expect(f.observeFile.mock.calls.map(call => call[0])).toEqual([...f.entries.keys()]);
  expect([...f.entries.values()].every(entry => entry.closed)).toBe(true);
});

it.each(["linux", "darwin"] as const)("does not enable %s or fall back to its executables", async platform => {
  const f = fixture(); f.io.platform = platform;
  await expect(f.resolve()).rejects.toMatchObject({ code: "AGE_TOOL_PLATFORM_UNQUALIFIED" }); expect(f.observeFile).not.toHaveBeenCalled();
});
it("refuses non-x64 Windows", async () => {
  const f = fixture(); f.io.arch = "arm64";
  await expect(f.resolve()).rejects.toMatchObject({ code: "AGE_TOOL_PLATFORM_UNQUALIFIED" }); expect(f.verifySignatures).not.toHaveBeenCalled();
});

it.each(["C:\\Program Files\\nodejs\\node.exe", "C:\\Other\\Murage.exe", "C:\\Installed\\Other.exe"])("binds the current process to the owning app: %s", async currentExecutable => {
  const f = fixture(); await expect(createWindowsBackupResourceResolver({ resourcesPath: resources, currentExecutable }, f.io)()).rejects.toMatchObject({ code: "AGE_TOOL_UNVERIFIED" });
  expect(f.observeFile).not.toHaveBeenCalled();
});

it.each(["\\\\server\\resources", "\\\\?\\C:\\Installed\\resources", "C:\\Installed\\..\\resources", "C:\\Installed\\resources:stream", "C:\\Installed\\resources.", "C:\\Installed\\resources\n"])("refuses ambiguous resource path %j", async resourcesPath => {
  const f = fixture(); await expect(createWindowsBackupResourceResolver({ resourcesPath, currentExecutable: app }, f.io)()).rejects.toMatchObject({ code: "AGE_TOOL_UNVERIFIED" });
  expect(f.verifySignatures).not.toHaveBeenCalled();
});

it("rejects observed junction/symlink ancestors before inspecting executable bytes", async () => {
  const f = fixture(); f.symbolicDirectory = resources;
  await expect(f.resolve()).rejects.toMatchObject({ code: "AGE_TOOL_UNVERIFIED" }); expect(f.observeFile).not.toHaveBeenCalled();
});

it("rejects a canonical path redirected outside the owning app", async () => {
  const f = fixture(); f.redirects.set(helper, "C:\\Other\\murage-backup-age.exe");
  await expect(f.resolve()).rejects.toMatchObject({ code: "AGE_TOOL_UNVERIFIED" }); expect(f.verifySignatures).not.toHaveBeenCalled();
  expect(f.entries.get(app)?.closed).toBe(true);
});

it.each(["age.exe", "age-keygen.exe", "LICENSE"])("requires unchanged raw bytes for %s; no normalization/signing fallback", async leaf => {
  const f = fixture(); f.entries.get(win32.join(tools, leaf))!.digest = "f".repeat(64);
  await expect(f.resolve()).rejects.toMatchObject({ code: "AGE_TOOL_UNVERIFIED" }); expect(f.verifySignatures).not.toHaveBeenCalled();
  expect(f.entries.get(helper)?.closed).toBe(true);
  expect(f.observeFile.mock.calls.every(([path]) => f.entries.get(path)?.closed)).toBe(true);
});

it("requires the complete pinned resource bundle", async () => {
  const f = fixture(); f.entries.delete(win32.join(tools, "LICENSE"));
  await expect(f.resolve()).rejects.toMatchObject({ code: "AGE_TOOL_UNVERIFIED" }); expect(f.verifySignatures).not.toHaveBeenCalled();
  expect([...f.entries.values()].every(entry => entry.closed)).toBe(true);
});

it("never accepts unsigned/wrong-publisher app or helper and sanitizes verifier errors", async () => {
  const f = fixture(); f.verifySignatures.mockRejectedValue(new Error("private native diagnostic"));
  const caught = await f.resolve().catch(error => error);
  expect(caught.code).toBe("AGE_TOOL_UNVERIFIED"); expect(caught.message).not.toContain("private native diagnostic");
  expect([...f.entries.values()].every(entry => entry.closed)).toBe(true);
});

it("rechecks every held file after async signature verification", async () => {
  const f = fixture(); f.verifySignatures.mockImplementation(async () => { f.entries.get(app)!.dirty = true; });
  await expect(f.resolve()).rejects.toMatchObject({ code: "AGE_TOOL_UNVERIFIED" });
  expect([...f.entries.values()].every(entry => entry.closed)).toBe(true);
});

it("refuses ancestry replacement after signatures finish", async () => {
  const f = fixture(); f.verifySignatures.mockImplementation(async () => { f.replacedDirectory = tools; });
  await expect(f.resolve()).rejects.toMatchObject({ code: "AGE_TOOL_UNVERIFIED" });
  expect([...f.entries.values()].every(entry => entry.closed)).toBe(true);
});

it("closes every other observation even if a close fails", async () => {
  const f = fixture(); f.closeFailure = win32.join(tools, "LICENSE");
  await expect(f.resolve()).rejects.toMatchObject({ code: "AGE_TOOL_UNVERIFIED" });
  expect([...f.entries.values()].every(entry => entry.closed)).toBe(true);
});

it("default bounded reader hashes real held bytes and is explicitly closed", () => {
  const f = localFile(); const held = observeWindowsBackupFile(f.path, 1024);
  expect(held.sha256).toBe(createHash("sha256").update("fixture-content").digest("hex")); held.assertUnchanged(); held.close(); held.close();
  expect(() => held.assertUnchanged()).toThrow();
});

it("default reader rejects symlinks, hardlinks and oversized files", () => {
  const f = localFile(); const symbolic = join(f.directory, "symbolic"); symlinkSync(f.path, symbolic);
  expect(() => observeWindowsBackupFile(symbolic, 1024)).toThrow();
  linkSync(f.path, join(f.directory, "hardlink")); expect(() => observeWindowsBackupFile(f.path, 1024)).toThrow();
  const other = localFile(); expect(() => observeWindowsBackupFile(other.path, 2)).toThrow();
});

it("default reader rejects same-size byte edits after observation", () => {
  const f = localFile("abcd"); const held = observeWindowsBackupFile(f.path, 1024);
  try { writeFileSync(f.path, "wxyz"); expect(() => held.assertUnchanged()).toThrow(); } finally { held.close(); }
});

it("default reader rejects named-path replacement despite its still-held original fd", () => {
  const f = localFile(); const held = observeWindowsBackupFile(f.path, 1024);
  try { renameSync(f.path, join(f.directory, "original")); writeFileSync(f.path, "fixture-content"); expect(() => held.assertUnchanged()).toThrow(); } finally { held.close(); }
});
