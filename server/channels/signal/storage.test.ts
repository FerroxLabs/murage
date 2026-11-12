// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { removeTempDirSync } from "../../testing/cleanup.ts";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentUserSid, ownerOnlyVerdict, ownerVerdict, windowsAclRestrict } from "../../win-acl.ts";
import {
  createSignalStorageGuard, signalStorageRoots, windowsSecurityRead,
  defaultSecurityRunner, type SecurityRunner, type WindowsSecurityEntry,
} from "./storage.ts";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) removeTempDirSync(dir); });
function fixture(prefix = "murage-signal-storage-") {
  const dataDir = fs.mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dataDir);
  const roots = signalStorageRoots(dataDir, "connection-1");
  for (const root of roots) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = join(roots[2]!, "key");
  fs.writeFileSync(key, "fixture key", { mode: 0o600 });
  return { dataDir, roots, key };
}
const sid = "S-1-5-21-1-2-3-1001";
const sddl = `O:${sid}G:SYD:P(A;;FA;;;${sid})(A;;FA;;;SY)`;
function entries(dataDir: string): WindowsSecurityEntry[] {
  const rows: WindowsSecurityEntry[] = [];
  function walk(path: string) {
    const stat = fs.lstatSync(path);
    rows.push({ path, attributes: stat.isDirectory() ? 16 : 128, sddl });
    if (stat.isDirectory()) for (const name of fs.readdirSync(path)) walk(join(path, name));
  }
  walk(dataDir);
  return rows;
}
function windowsFixture() {
  const f = fixture();
  let rows = entries(f.dataDir);
  const run = vi.fn<SecurityRunner>((_file, args) => {
    if (args.includes("/user")) return `"fixture","${sid}"`;
    if (args.includes("-Command")) return rows.map(row => JSON.stringify(row)).join("\n");
    const row = rows.find(row => row.path === args[0])!;
    // icacls /grant:r replaces only the named principals, not an explicit WD
    // grant. Keep that behavior in the fake so broad-ACL repair is meaningful.
    if (args.includes("/grant:r")) row.sddl = row.sddl!.replace("D:(", "D:P(").replaceAll(";ID;", ";;");
    if (args.includes("/remove:g")) row.sddl = row.sddl!.replace(/\(A;;FA;;;WD\)/g, "");
    return "";
  });
  const open = vi.fn(fs.openSync);
  const guard = createSignalStorageGuard({ dataDir: f.dataDir, connectionId: "connection-1", platform: "win32", run, fs: { openSync: open } });
  return { ...f, rows, run, guard, open, setRows: (next: WindowsSecurityEntry[]) => { rows = next; } };
}
const blocked = (reason: string, path: string, scope = "signal") => ({ state: "blocked", reason, path, scope });

// Windows runs are mandatory qualification: an absent fixture is an error,
// never a reason to skip owner cases. The flag also catches a misrouted CI job.
function requireWindowsQualification(platform: string, current: string | null, env: NodeJS.ProcessEnv): string {
  const foreign = env.MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID;
  if (platform !== "win32" || !current || !/^S-1-(?:\d+-){1,14}\d+$/.test(current)
      || !foreign || !/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(foreign) || foreign === current) {
    throw new Error("T-WIN-QUALIFICATION requires a real elevated Windows runner and a second local user's SID in MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID");
  }
  return foreign;
}

// Qualification fixture only: an unhandled, non-Microsoft tag with a GUID and
// no name-surrogate bit. It needs neither OneDrive nor an external mount. The
// runner must support NTFS reparse points; setup failure fails the test. Only
// the fresh file passed by the test is touched, and the same tag is removed in
// finally before normal fixture cleanup. The production reader still uses CLM.
function setNonLinkReparse(path: string, remove: boolean): void {
  const output = defaultSecurityRunner(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
      env: { ...process.env, MURAGE_TEST_REPARSE_PATH: path, MURAGE_TEST_REPARSE_REMOVE: remove ? "1" : "0" },
      timeout: 15_000,
      input: String.raw`& {
  $ErrorActionPreference = 'Stop'
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class SignalReparseFixture {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
    IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool DeviceIoControl(SafeFileHandle file, uint code, byte[] input,
    uint size, IntPtr output, uint capacity, out uint returned, IntPtr overlapped);
  public static void Apply(string path, bool remove) {
    // REPARSE_GUID_DATA_BUFFER: tag, zero data length, reserved, then GUID.
    byte[] buffer = new byte[24];
    BitConverter.GetBytes((uint)0x00000042).CopyTo(buffer, 0);
    new Guid("9af30f63-4a97-4a98-a061-287c21b2e54d").ToByteArray().CopyTo(buffer, 8);
    // GENERIC_WRITE, share R/W/delete, OPEN_EXISTING, OPEN_REPARSE_POINT |
    // BACKUP_SEMANTICS. Never open through the fixture's reparse point.
    using (SafeFileHandle file = CreateFileW(path, 0x40000000, 7, IntPtr.Zero,
      3, 0x02200000, IntPtr.Zero)) {
      if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint returned;
      if (!DeviceIoControl(file, remove ? 0x000900ACu : 0x000900A4u, buffer,
        (uint)buffer.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero))
        throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@
  [SignalReparseFixture]::Apply($env:MURAGE_TEST_REPARSE_PATH, ($env:MURAGE_TEST_REPARSE_REMOVE -eq '1'))
  'fixture-ready'
}

`,
    });
  if (output.trim() !== "fixture-ready") throw new Error("T-WIN-REPARSE requires a real NTFS non-link reparse fixture");
}

describe("T-WIN-QUALIFICATION prerequisites", () => {
  const foreign = "S-1-5-21-9-8-7-1001";
  const configured = { MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID: foreign };
  it.each([
    ["missing SID", "win32", {}],
    ["empty SID", "win32", { MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID: "" }],
    ["malformed SID", "win32", { MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID: "not-a-sid" }],
    ["current user", "win32", { MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID: sid }],
    ["accepted SYSTEM owner", "win32", { MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID: "S-1-5-18" }],
    ["accepted Administrators owner", "win32", { MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID: "S-1-5-32-544" }],
    ["non-Windows host", "linux", configured],
  ] as const)("fails closed on %s; kills optional qualification", (_reason, platform, env) => {
    expect(requireWindowsQualification("win32", sid, configured)).toBe(foreign);
    expect(() => requireWindowsQualification(platform, sid, env)).toThrow("T-WIN-QUALIFICATION");
  });
  it("fails closed on unknown current owner; kills unchecked identity", () => {
    expect(requireWindowsQualification("win32", sid, configured)).toBe(foreign);
    expect(() => requireWindowsQualification("win32", null, configured)).toThrow("T-WIN-QUALIFICATION");
  });
  it("requires a real Windows host when MURAGE_TEST_WINDOWS_QUALIFICATION=1", () => {
    if (process.env.MURAGE_TEST_WINDOWS_QUALIFICATION === "1") {
      requireWindowsQualification(process.platform, currentUserSid(), process.env);
    }
  });
});

describe.skipIf(process.platform === "win32")("POSIX isolated storage", () => {
  it("T-MODES repairs broad folders and files once; kills skipped mode checks", async () => {
    const f = fixture();
    const guard = createSignalStorageGuard({ dataDir: f.dataDir, connectionId: "connection-1" });
    expect(await guard.check()).toEqual({ state: "ok" });
    fs.chmodSync(f.roots[2]!, 0o755);
    fs.chmodSync(f.key, 0o644);
    expect(await guard.check()).toEqual({ state: "ok" });
    expect(fs.statSync(f.roots[2]!).mode & 0o777).toBe(0o700);
    expect(fs.statSync(f.key).mode & 0o777).toBe(0o600);
  });
  it("T-MODES blocks a failed repair, then permits an explicit retry", async () => {
    const f = fixture();
    const chmod = vi.fn(fs.fchmodSync);
    const guard = createSignalStorageGuard({ dataDir: f.dataDir, connectionId: "connection-1", fs: { fchmodSync: chmod } });
    expect(await guard.check()).toEqual({ state: "ok" });
    fs.chmodSync(f.key, 0o644);
    chmod.mockImplementationOnce(() => {});
    expect(await guard.check()).toEqual(blocked("storage-permissions", f.key));
    expect(chmod).toHaveBeenCalledTimes(1);
    expect(await guard.repair()).toEqual({ state: "ok" });
    expect(chmod).toHaveBeenCalledTimes(2);
  });
  it.each(["key", "auth", "signal", "data", "ledger"])("T-POSIX-OWNER blocks foreign %s before opening or repairing; kills chown-and-continue", async which => {
    const f = fixture();
    const path = ({ key: f.key, auth: f.roots[2], signal: f.roots[1], data: f.dataDir, ledger: f.roots[5] })[which]!;
    let foreign = false;
    const open = vi.fn(fs.openSync);
    const chmod = vi.fn(fs.fchmodSync);
    const guard = createSignalStorageGuard({ dataDir: f.dataDir, connectionId: "connection-1", fs: {
      lstatSync: p => { const stat = fs.lstatSync(p); if (foreign && p === path) stat.uid = (process.getuid?.() ?? 0) + 123; return stat; },
      openSync: open, fchmodSync: chmod,
    } });
    expect(await guard.check()).toEqual({ state: "ok" });
    open.mockClear(); foreign = true;
    expect(await guard.repair()).toEqual(blocked("storage-owner", path, which === "data" ? "data-dir" : "signal"));
    expect(open).not.toHaveBeenCalled();
    expect(chmod).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.key, "utf8")).toBe("fixture key");
  });
  it.each(["key", "auth", "channels"])("T-MODES refuses a symlink at %s; kills following links", async which => {
    const f = fixture();
    const guard = createSignalStorageGuard({ dataDir: f.dataDir, connectionId: "connection-1" });
    expect(await guard.check()).toEqual({ state: "ok" });
    const path = which === "key" ? f.key : which === "auth" ? f.roots[2]! : join(f.dataDir, "channels");
    const target = `${path}-target`;
    fs.renameSync(path, target);
    fs.symlinkSync(target, path);
    expect(await guard.check()).toEqual(blocked("storage-permissions", path));
  });
  it("T-MODES never repairs DATA_DIR", async () => {
    const f = fixture();
    const guard = createSignalStorageGuard({ dataDir: f.dataDir, connectionId: "connection-1" });
    expect(await guard.check()).toEqual({ state: "ok" });
    fs.chmodSync(f.dataDir, 0o755);
    expect(await guard.repair()).toEqual(blocked("storage-permissions", f.dataDir, "data-dir"));
    expect(fs.statSync(f.dataDir).mode & 0o777).toBe(0o755);
  });
  it("T-POSIX-OWNER permits root only on DATA_DIR; kills root ownership everywhere", async () => {
    const f = fixture();
    const fixtureUid = 1234;
    let rootOwnsKey = false;
    const guard = createSignalStorageGuard({ dataDir: f.dataDir, connectionId: "connection-1", uid: fixtureUid, fs: {
      lstatSync: path => {
        const stat = fs.lstatSync(path);
        stat.uid = path === f.dataDir || (rootOwnsKey && path === f.key) ? 0 : fixtureUid;
        return stat;
      },
    } });
    expect(await guard.check()).toEqual({ state: "ok" });
    rootOwnsKey = true;
    expect(await guard.repair()).toEqual(blocked("storage-owner", f.key));
  });
  it("T-MODES rejects a swapped inode before chmod; kills path-only repairs", async () => {
    const f = fixture();
    let swapped = false;
    const chmod = vi.fn(fs.fchmodSync);
    const guard = createSignalStorageGuard({ dataDir: f.dataDir, connectionId: "connection-1", fs: {
      fchmodSync: chmod,
      fstatSync: fd => { const stat = fs.fstatSync(fd); if (swapped) stat.ino++; return stat; },
    } });
    fs.chmodSync(f.key, 0o644);
    expect(await guard.check()).toEqual({ state: "ok" });
    chmod.mockClear();
    fs.chmodSync(f.key, 0o644);
    swapped = true;
    expect(await guard.repair()).toEqual(blocked("storage-permissions", f.key));
    expect(chmod).not.toHaveBeenCalled();
  });
  it("T-MODES checks new files after exit and uses O_NOFOLLOW for repair", async () => {
    const f = fixture();
    const open = vi.fn(fs.openSync);
    const guard = createSignalStorageGuard({ dataDir: f.dataDir, connectionId: "connection-1", fs: { openSync: open } });
    expect(await guard.check()).toEqual({ state: "ok" });
    const added = join(f.roots[3]!, "new-key");
    fs.writeFileSync(added, "fixture", { mode: 0o644 });
    expect(await guard.check()).toEqual({ state: "ok" });
    expect(open.mock.calls.find(call => call[0] === added)?.[1]).toBe(fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    expect(fs.statSync(added).mode & 0o777).toBe(0o600);
  });
});

describe("Windows policy with an isolated fake reader", () => {
  it.each(["key", "auth", "signal", "data"])("T-WIN-OWNER checks %s owner before its accepted DACL; kills DACL-only checks", async which => {
    const f = windowsFixture();
    expect(await f.guard.check()).toEqual({ state: "ok" });
    const path = ({ key: f.key, auth: f.roots[2], signal: f.roots[1], data: f.dataDir })[which]!;
    f.rows.find(row => row.path === path)!.sddl = sddl.replace(`O:${sid}`, "O:S-1-5-21-9-8-7-1001");
    f.run.mockClear(); f.open.mockClear();
    expect(await f.guard.check()).toEqual(blocked("storage-owner", path, which === "data" ? "data-dir" : "signal"));
    expect(await f.guard.repair()).toEqual(blocked("storage-owner", path, which === "data" ? "data-dir" : "signal"));
    expect(f.open, "foreign-owned keys must never be opened, even to repair permissions").not.toHaveBeenCalled();
    expect(f.run.mock.calls.every(([, args]) => args.includes("/user") || args.includes("-Command"))).toBe(true);
    expect(fs.readFileSync(f.key, "utf8")).toBe("fixture key");
  });
  it("T-WIN-OWNER accepts BA and SYSTEM owners", async () => {
    const f = windowsFixture();
    for (const owner of [sid, "BA", "SY"]) {
      f.rows.find(row => row.path === f.key)!.sddl = sddl.replace(`O:${sid}`, `O:${owner}`);
      expect(await f.guard.check()).toEqual({ state: "ok" });
    }
  });
  it.each(["key", "auth", "data", "channels"])("T-WIN-REPARSE rejects the attribute on %s despite ordinary lstat; kills symlink-only checks", async which => {
    const f = windowsFixture();
    expect(await f.guard.check()).toEqual({ state: "ok" });
    const path = ({ key: f.key, auth: f.roots[2], data: f.dataDir, channels: join(f.dataDir, "channels") })[which]!;
    f.rows.find(row => row.path === path)!.attributes |= 0x400;
    f.run.mockClear();
    expect(await f.guard.repair()).toEqual(blocked("storage-permissions", path, which === "data" ? "data-dir" : "signal"));
    expect(f.run.mock.calls.some(([, args]) => args.includes("/grant:r"))).toBe(false);
  });
  it.each(["D:(A;ID;FA;;;", "D:P(A;;FA;;;WD)(A;;FA;;;"])("T-WIN-INHERIT repairs broad DACL %s once and rereads", async prefix => {
    const f = windowsFixture();
    expect(await f.guard.check()).toEqual({ state: "ok" });
    f.rows.find(row => row.path === f.key)!.sddl = `O:${sid}${prefix}${sid})`;
    f.run.mockClear();
    expect(await f.guard.check()).toEqual({ state: "ok" });
    const repairs = f.run.mock.calls.filter(([, args]) => args.includes("/grant:r"));
    expect(repairs).toHaveLength(1);
    expect(repairs[0]![2].timeout).toBe(15_000);
    expect(f.run.mock.calls.filter(([, args]) => args.includes("-Command"))).toHaveLength(2);
    expect(repairs[0]![1]).not.toContain("/setowner");
  });
  it("T-WIN-INHERIT blocks an unrepairable DACL without looping", async () => {
    const f = windowsFixture();
    expect(await f.guard.check()).toEqual({ state: "ok" });
    f.rows.find(row => row.path === f.key)!.sddl = `O:${sid}D:(A;ID;FA;;;${sid})`;
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation((file, args, options) => args.includes("/grant:r") ? "" : original(file, args, options));
    f.run.mockClear();
    expect(await f.guard.check()).toEqual(blocked("storage-permissions", f.key));
    expect(f.run.mock.calls.filter(([, args]) => args.includes("/grant:r"))).toHaveLength(1);
  });
  it.each(["WD", "BU", "AU", "S-1-1-0", "S-1-5-32-545", "S-1-5-11"])("T-WIN-INHERIT never repairs DATA_DIR with a broad %s grant", async broad => {
    const f = windowsFixture();
    const row = f.rows.find(row => row.path === f.dataDir)!;
    row.sddl = `O:${sid}D:(A;ID;FA;;;${sid})`;
    expect(await f.guard.check()).toEqual({ state: "ok" });
    row.sddl += `(A;;FR;;;${broad})`;
    f.run.mockClear();
    expect(await f.guard.repair()).toEqual(blocked("storage-permissions", f.dataDir, "data-dir"));
    expect(f.run.mock.calls.some(([, args]) => args.includes("/grant:r"))).toBe(false);
  });
  it.each(["missing-owner", "bad-dacl", "missing-row"])("T-WIN-INHERIT fails closed on %s without a blind repair", async fault => {
    const f = windowsFixture();
    expect(await f.guard.check()).toEqual({ state: "ok" });
    if (fault === "missing-row") f.setRows(f.rows.filter(row => row.path !== f.key));
    else f.rows.find(row => row.path === f.key)!.sddl = fault === "missing-owner" ? `D:P(A;;FA;;;${sid})` : `O:${sid}D:garbled`;
    f.run.mockClear();
    expect(await f.guard.repair()).toEqual(blocked("storage-permissions", f.key));
    expect(f.run.mock.calls.some(([, args]) => args.includes("/grant:r"))).toBe(false);
  });
  it("T-WIN-MANY reads 500 auth files in one call with only six roots in the environment", async () => {
    const f = windowsFixture();
    expect(await f.guard.check()).toEqual({ state: "ok" });
    for (let n = 0; n < 500; n++) fs.writeFileSync(join(f.roots[2]!, `key-${n}`), "fixture");
    f.setRows(entries(f.dataDir));
    f.run.mockClear();
    expect(await f.guard.check()).toEqual({ state: "ok" });
    const calls = f.run.mock.calls.filter(([, args]) => args.includes("-Command"));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]![2].env.MURAGE_SIGNAL_ROOTS!)).toEqual(f.roots);
    f.rows = entries(f.dataDir);
    f.rows.find(row => row.path.endsWith("key-499"))!.sddl = sddl.replace(`O:${sid}`, "O:BU");
    f.setRows(f.rows);
    expect(await f.guard.check()).toEqual(blocked("storage-owner", join(f.roots[2]!, "key-499")));
  });
});

describe("Windows reader transport", () => {
  it.each(["../outside", "a/b", "a\\b", "", ".", ".."])("refuses connection path %s before any filesystem access", connectionId => {
    expect(signalStorageRoots("/fixture", "connection-1")).toHaveLength(6);
    expect(() => signalStorageRoots("/fixture", connectionId)).toThrow("Invalid Signal connection id");
  });
  it("T-WIN-CLM fake preserves plain JSON roots with Unicode and a quote, never script interpolation", async () => {
    const roots = signalStorageRoots("/fixture/私の O'Brien", "connection-1");
    const run = vi.fn<SecurityRunner>((file, args, options) => {
      expect(file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      expect(args).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"]);
      expect(JSON.parse(options.env.MURAGE_SIGNAL_ROOTS!)).toEqual(roots);
      expect(options.input).toContain("$env:MURAGE_SIGNAL_ROOTS | ConvertFrom-Json");
      expect(options.input).toContain("Get-Item -LiteralPath");
      expect(options.input).toContain("Get-Acl -LiteralPath");
      expect(options.input).not.toContain("O'Brien");
      expect(options.input).not.toMatch(/::|FromBase64String|GetSecurityDescriptorSddlForm/);
      return roots.map(path => JSON.stringify({ path, attributes: 16, sddl })).join("\r\n");
    });
    const rows = await windowsSecurityRead(roots, run, { SystemRoot: "C:\\Windows" });
    expect(rows?.map(row => row.path)).toEqual(roots);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each(["not json", '{"path":"/fixture","attributes":0}', '{"path":"/fixture","attributes":"1024","sddl":"O:SY"}'])(
    "T-WIN-CLM fake rejects malformed output %s; kills partial reader acceptance", async bad => {
      const roots = signalStorageRoots("/fixture", "connection-1");
      const good = roots.map(path => JSON.stringify({ path, attributes: 16, sddl })).join("\n");
      expect(await windowsSecurityRead(roots, () => good)).toHaveLength(6);
      expect(await windowsSecurityRead(roots, () => `${good}\n${bad}`)).toBeNull();
    },
  );
  it("T-WIN-CLM fake fails closed on reader failure", async () => {
    const roots = signalStorageRoots("/fixture", "connection-1");
    expect(await windowsSecurityRead(roots, () => roots.map(path => JSON.stringify({ path, attributes: 16, sddl })).join("\n"))).toHaveLength(6);
    expect(await windowsSecurityRead(roots, () => { throw new Error("fixture failure"); })).toBeNull();
  });
});

// The blocking Windows quality step runs this group with a provisioned SID.
// Ordinary shards run the same simulated policy cases on all three OSes.
describe.skipIf(process.platform !== "win32" || process.env.MURAGE_TEST_WINDOWS_QUALIFICATION !== "1")("real Windows isolated reader (requires provisioned Windows quality runner; Linux/macOS cannot qualify B3)", () => {
  const aclRun = (file: string, args: readonly string[]) => defaultSecurityRunner(file, args, { env: process.env, timeout: 15_000 });
  const icacls = () => win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
  function protectedFixture() {
    const f = fixture();
    // Own temporary paths only, including DATA_DIR: fixture setup, not guard repair.
    for (const row of entries(f.dataDir)) expect(windowsAclRestrict(row.path, aclRun)).toBe(true);
    const run = vi.fn<SecurityRunner>(defaultSecurityRunner);
    const guard = createSignalStorageGuard({ dataDir: f.dataDir, connectionId: "connection-1", run });
    return { ...f, guard, run };
  }
  it("T-WIN-CLM returns identical owner, attributes and DACL in full and constrained language", async () => {
    const f = fixture("murage-signal-私の O'Brien-");
    const unicode = join(f.roots[2]!, "私の O'Brien");
    fs.mkdirSync(unicode);
    fs.writeFileSync(join(unicode, "鍵"), "fixture");
    const full = await windowsSecurityRead(f.roots);
    const constrained = await windowsSecurityRead(f.roots, (file, args, options) => defaultSecurityRunner(file, args, {
      ...options, input: `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n${options.input}`,
    }));
    expect(full).not.toBeNull();
    expect(constrained).toEqual(full);
    expect(full!.some(row => row.path === join(unicode, "鍵"))).toBe(true);
    const current = currentUserSid();
    expect(current).not.toBeNull();
    for (const row of full!) {
      expect(ownerVerdict(row.sddl!, current!)).toBe("ok");
      expect(row.sddl).toContain("D:");
    }
  }, 60_000);
  it("T-WIN-INHERIT repairs a real explicit Everyone grant and an inherited key DACL", async () => {
    const f = protectedFixture();
    expect(await f.guard.check()).toEqual({ state: "ok" });
    aclRun(icacls(), [f.key, "/grant", "*S-1-1-0:R", "/q"]);
    expect(await f.guard.check()).toEqual({ state: "ok" });
    const afterExplicit = await windowsSecurityRead(f.roots);
    expect(afterExplicit!.find(row => row.path === f.key)!.sddl).not.toMatch(/;;;(?:WD|S-1-1-0)\)/);
    aclRun(icacls(), [f.key, "/inheritance:e", "/q"]);
    expect(await f.guard.check()).toEqual({ state: "ok" });
    const afterInherited = await windowsSecurityRead(f.roots);
    expect(ownerOnlyVerdict(afterInherited!.find(row => row.path === f.key)!.sddl!, currentUserSid()!)).toBe("owner-only");
  }, 60_000);
  it.each(["junction", "dir", "file"] as const)("T-WIN-REPARSE refuses a real %s link without enumerating its target", async kind => {
    const f = protectedFixture();
    const target = fs.mkdtempSync(join(tmpdir(), "murage-signal-junction-target-"));
    temporary.push(target);
    fs.writeFileSync(join(target, "outside"), "fixture");
    const junction = join(f.roots[2]!, "link");
    if (kind === "file") fs.writeFileSync(junction, "fixture");
    else fs.mkdirSync(junction);
    expect(windowsAclRestrict(junction, aclRun)).toBe(true);
    expect(await f.guard.check()).toEqual({ state: "ok" });
    if (kind === "file") fs.unlinkSync(junction);
    else fs.rmdirSync(junction);
    fs.symlinkSync(kind === "file" ? join(target, "outside") : target, junction, kind);
    try {
      const rows = await windowsSecurityRead(f.roots);
      expect(rows!.find(row => row.path === junction)!.attributes & 0x400).toBe(0x400);
      expect(rows!.find(row => row.path === junction)!.sddl).toBeNull();
      expect(rows!.some(row => row.path === join(junction, "outside"))).toBe(false);
      expect(await f.guard.check()).toEqual(blocked("storage-permissions", junction));
      expect(fs.readFileSync(join(target, "outside"), "utf8")).toBe("fixture");
    } finally { fs.unlinkSync(junction); }
  }, 60_000);
  it("T-WIN-REPARSE refuses a real non-link reparse tag with ordinary lstat; kills symlink-only checks", async () => {
    const f = protectedFixture();
    const path = f.key;
    expect(await f.guard.check()).toEqual({ state: "ok" });
    const before = (await windowsSecurityRead(f.roots))!.find(row => row.path === path)!;
    expect(before.attributes & 0x400).toBe(0);
    expect(ownerOnlyVerdict(before.sddl!, currentUserSid()!)).toBe("owner-only");
    setNonLinkReparse(path, false);
    try {
      // A name-surrogate link would let Node's independent link guard mask a
      // deleted Windows attribute check, so prove this is an ordinary file.
      expect(fs.lstatSync(path).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(path).isFile()).toBe(true);
      const rows = await windowsSecurityRead(f.roots);
      expect(rows).not.toBeNull();
      const row = rows!.find(row => row.path === path)!;
      expect(row.attributes & 0x400).toBe(0x400);
      expect(row.sddl).toBeNull();
      // Keep all other guard inputs accepted to isolate the attribute mutant;
      // Get-Acl is deliberately not called on a reparse point by the real reader.
      const run = vi.fn<SecurityRunner>((file, args, options) => args.includes("-Command")
        ? rows!.map(entry => JSON.stringify(entry.path === path ? { ...entry, sddl: before.sddl } : entry)).join("\n")
        : defaultSecurityRunner(file, args, options));
      const guard = createSignalStorageGuard({ dataDir: f.dataDir, connectionId: "connection-1", run });
      expect(await guard.repair()).toEqual(blocked("storage-permissions", path));
      expect(run.mock.calls.some(([, args]) => args.includes("/grant:r"))).toBe(false);
      expect(await f.guard.check()).toEqual(blocked("storage-permissions", path));
    } finally { setNonLinkReparse(path, true); }
    expect(await f.guard.check()).toEqual({ state: "ok" });
  }, 60_000);
  // The elevated Windows proof runner provisions a second local account. No
  // test creates users or changes ownership outside its disposable fixture.
  it.each(["key", "auth", "signal", "data"])(
    "T-WIN-OWNER rejects real foreign-owned %s with an accepted DACL; kills DACL-only checks and setowner repair", async which => {
      const current = currentUserSid();
      const foreignOwnerSid = requireWindowsQualification(process.platform, current, process.env);
      const f = protectedFixture();
      const path = ({ key: f.key, auth: f.roots[2], signal: f.roots[1], data: f.dataDir })[which]!;
      expect(await f.guard.check()).toEqual({ state: "ok" });
      const before = (await windowsSecurityRead(f.roots))!.find(row => row.path === path)!.sddl!;
      try {
        aclRun(icacls(), [path, "/setowner", `*${foreignOwnerSid}`, "/q"]);
        const rows = await windowsSecurityRead(f.roots);
        const foreignSddl = rows!.find(row => row.path === path)!.sddl!;
        expect(ownerOnlyVerdict(foreignSddl, current!)).toBe("owner-only");
        expect(ownerVerdict(foreignSddl, current!)).toBe("foreign");
        expect(foreignSddl.slice(foreignSddl.indexOf("D:"))).toBe(before.slice(before.indexOf("D:")));
        f.run.mockClear();
        expect(await f.guard.repair()).toEqual(blocked("storage-owner", path, which === "data" ? "data-dir" : "signal"));
        expect(f.run.mock.calls.every(([, args]) => args.includes("/user") || args.includes("-Command"))).toBe(true);
        expect((await windowsSecurityRead(f.roots))!.find(row => row.path === path)!.sddl).toBe(foreignSddl);
      } finally { aclRun(icacls(), [path, "/setowner", `*${current}`, "/q"]); }
      expect(await f.guard.check()).toEqual({ state: "ok" });
      expect(fs.readFileSync(f.key, "utf8")).toBe("fixture key");
    }, 60_000,
  );
});
