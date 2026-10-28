// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import {
  DESCRIPTOR_FILE, checkInputFile, checkInputRoot, defaultOutputRoot, ensureOutputRoot, isCleanAbsolute, loadDescriptor, sourcePaths, validateDescriptor, within, writeDescriptor,
  type SentinelDescriptor,
} from "./paths.ts";
import { INST, cleanupFixtures, makeInstall } from "./scan-fixtures.ts";
import { ownerOnlyVerdict, parseDacl } from "./win-acl.ts";

const posixOnly = process.platform === "win32" ? it.skip : it;
const dirs: string[] = [];
afterEach(() => { cleanupFixtures(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

function descriptor(overrides: Partial<SentinelDescriptor> = {}): SentinelDescriptor {
  const installationRoot = "/home/owner/.murage";
  const inputRoot = `${installationRoot}/health`;
  return {
    version: 1, installationId: INST, installationRoot, inputRoot, outputRoot: `/home/owner/.local/state/MurageSentinel/${INST}`,
    sources: sourcePaths(inputRoot, "linux"), executable: { path: "/opt/Murage/murage", entry: "/opt/Murage/resources/server/sentinel/cli.js", sha256: null },
    scheduleRevision: 3, ...overrides,
  };
}

describe("descriptor validation", () => {
  it("accepts the fixed shape and rebuilds source paths from the input root", () => {
    const parsed = validateDescriptor(descriptor(), "linux");
    expect(parsed.ok).toBe(true);
  });

  it("takes an optional list of the producers the installation runs, always with server", () => {
    const both = validateDescriptor({ ...descriptor(), producers: ["server", "desktop"] }, "linux");
    expect(both.ok && both.value.producers).toEqual(["server", "desktop"]);
    const serverOnly = validateDescriptor({ ...descriptor(), producers: ["server"] }, "linux");
    expect(serverOnly.ok && serverOnly.value.producers).toEqual(["server"]);
    const none = validateDescriptor(descriptor(), "linux");
    expect(none.ok && none.value.producers).toBeUndefined();
    for (const producers of [[], ["desktop"], ["server", "server"], ["server", "cloud"], "server"]) {
      expect(validateDescriptor({ ...descriptor(), producers }, "linux")).toEqual({ ok: false, reason: "producers" });
    }
  });

  it("refuses unknown keys, credentials-like extras and wrong versions", () => {
    expect(validateDescriptor({ ...descriptor(), token: "x" }, "linux")).toEqual({ ok: false, reason: "descriptor-shape" });
    expect(validateDescriptor({ ...descriptor(), version: 2 }, "linux")).toEqual({ ok: false, reason: "descriptor-version" });
    expect(validateDescriptor({ ...descriptor(), installationId: "Owner Name" }, "linux")).toEqual({ ok: false, reason: "installation-id" });
  });

  it("requires inputRoot to be exactly <installationRoot>/health and every source to be its fixed name", () => {
    expect(validateDescriptor(descriptor({ inputRoot: "/home/owner/.murage/logs" }), "linux")).toEqual({ ok: false, reason: "input-root" });
    const sources = { ...sourcePaths("/home/owner/.murage/health", "linux"), backupStatus: "/home/owner/.murage/health/../owner.json" };
    expect(validateDescriptor(descriptor({ sources }), "linux").ok).toBe(false);
  });

  it("refuses an output root inside the installation root, or one holding it, or with the wrong name", () => {
    expect(validateDescriptor(descriptor({ outputRoot: `/home/owner/.murage/MurageSentinel/${INST}` }), "linux")).toEqual({ ok: false, reason: "output-root-containment" });
    expect(validateDescriptor(descriptor({ installationRoot: `/home/owner/.local/state/MurageSentinel/${INST}/data`, inputRoot: `/home/owner/.local/state/MurageSentinel/${INST}/data/health`, sources: sourcePaths(`/home/owner/.local/state/MurageSentinel/${INST}/data/health`, "linux") }), "linux"))
      .toEqual({ ok: false, reason: "output-root-containment" });
    expect(validateDescriptor(descriptor({ outputRoot: "/home/owner/.local/state/Other/x" }), "linux")).toEqual({ ok: false, reason: "output-root-name" });
  });

  it("refuses relative, unnormalized, UNC and NUL paths", () => {
    expect(isCleanAbsolute("relative/path", "linux")).toBe(false);
    expect(isCleanAbsolute("/a/../b", "linux")).toBe(false);
    expect(isCleanAbsolute("/a/b/", "linux")).toBe(false);
    expect(isCleanAbsolute("//server/share", "linux")).toBe(false);
    expect(isCleanAbsolute("/a\0b", "linux")).toBe(false);
    expect(isCleanAbsolute("\\\\server\\share\\x", "win32")).toBe(false);
    expect(isCleanAbsolute("\\\\?\\C:\\x", "win32")).toBe(false);
    expect(isCleanAbsolute("C:\\Users\\Owner\\AppData\\Local", "win32")).toBe(true);
    expect(isCleanAbsolute("/home/ówner/my data/x", "linux")).toBe(true);
  });

  it("compares containment case-insensitively on Windows and macOS", () => {
    expect(within("C:\\Users\\Owner\\Data", "c:\\users\\owner\\data\\health", "win32")).toBe(true);
    expect(within("/Users/Owner/Data", "/users/owner/data/x", "darwin")).toBe(true);
    expect(within("/home/a", "/home/ab", "linux")).toBe(false);
  });
});

describe("default output roots", () => {
  it("uses the per-OS state location with the installation id", () => {
    expect(defaultOutputRoot(INST, { platform: "darwin", home: "/Users/owner", env: {} })).toBe(`/Users/owner/Library/Application Support/MurageSentinel/${INST}`);
    expect(defaultOutputRoot(INST, { platform: "win32", home: "C:\\Users\\owner", env: { LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" } })).toBe(`C:\\Users\\owner\\AppData\\Local\\MurageSentinel\\${INST}`);
    expect(defaultOutputRoot(INST, { platform: "linux", home: "/home/owner", env: { XDG_STATE_HOME: "/srv/state" } })).toBe(`/srv/state/MurageSentinel/${INST}`);
    expect(defaultOutputRoot(INST, { platform: "linux", home: "/home/owner", env: { XDG_STATE_HOME: "relative" } })).toBe(`/home/owner/.local/state/MurageSentinel/${INST}`);
    expect(defaultOutputRoot(INST, { platform: "win32", home: "C:\\Users\\owner", env: {} })).toBeNull();
    expect(defaultOutputRoot("not a token", { platform: "linux", home: "/home/owner", env: {} })).toBeNull();
  });
});

describe("filesystem guards", () => {
  posixOnly("loads a written descriptor and refuses one that is group-readable, linked or misplaced", () => {
    const fx = makeInstall();
    expect(loadDescriptor(fx.descriptorPath).ok).toBe(true);
    chmodSync(fx.descriptorPath, 0o644);
    expect(loadDescriptor(fx.descriptorPath)).toEqual({ ok: false, reason: "descriptor-permissions" });
    chmodSync(fx.descriptorPath, 0o600);
    const alias = join(fx.base, DESCRIPTOR_FILE);
    symlinkSync(fx.descriptorPath, alias);
    expect(loadDescriptor(alias).ok).toBe(false);
    const hard = join(fx.base, "bin", DESCRIPTOR_FILE);
    linkSync(fx.descriptorPath, hard);
    expect(loadDescriptor(fx.descriptorPath)).toEqual({ ok: false, reason: "descriptor-hard-link" });
  });

  posixOnly("refuses an output root inside a repository checkout", () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-sentinel-repo-")));
    dirs.push(base);
    mkdirSync(join(base, ".git"));
    expect(ensureOutputRoot(join(base, "MurageSentinel", INST))).toEqual({ ok: false, reason: "repository" });
  });

  posixOnly("creates the output root owner-only and tightens broader bits on a directory we own", () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-sentinel-out-")));
    dirs.push(base);
    const root = join(base, "MurageSentinel", INST);
    expect(ensureOutputRoot(root)).toEqual({ ok: true, value: root });
    chmodSync(root, 0o755);
    expect(ensureOutputRoot(root).ok).toBe(true);
    const link = join(base, "MurageSentinel", "f".repeat(32));
    symlinkSync(root, link);
    expect(ensureOutputRoot(link)).toEqual({ ok: false, reason: "link" });
    expect(ensureOutputRoot(root, { uid: 4242 })).toEqual({ ok: false, reason: "owner" });
  });

  it("on Windows trusts only the injected DACL verdict, never chmod", () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-sentinel-acl-")));
    dirs.push(base);
    const root = join(base, "MurageSentinel", INST);
    // Simulated: run the Windows branch with POSIX paths only when this host is not Windows (path shape is checked first).
    if (process.platform !== "win32") {
      expect(ensureOutputRoot(root, { platform: "win32", aclCheck: () => "owner-only" })).toEqual({ ok: false, reason: "path" });
      return;
    }
    expect(ensureOutputRoot(root, { aclCheck: () => "broad", aclRestrict: () => false })).toEqual({ ok: false, reason: "acl" });
  });

  posixOnly("checks input files: symlinks, hard links, non-regular files and escapes are refused", () => {
    const fx = makeInstall();
    const backup = fx.file("backupStatus");
    expect(checkInputFile(backup, fx.health)).toEqual({ ok: true, value: null });
    writeFileSync(join(fx.base, "elsewhere.json"), "{}", { mode: 0o600 });
    symlinkSync(join(fx.base, "elsewhere.json"), backup);
    expect(checkInputFile(backup, fx.health)).toEqual({ ok: false, reason: "link" });
    const stats = fx.file("dbStatsManifest");
    linkSync(join(fx.base, "elsewhere.json"), stats);
    expect(checkInputFile(stats, fx.health)).toEqual({ ok: false, reason: "hard-link" });
    mkdirSync(fx.file("serverCurrent"));
    expect(checkInputFile(fx.file("serverCurrent"), fx.health)).toEqual({ ok: false, reason: "not-file" });
    expect(checkInputFile(join(fx.base, "elsewhere.json"), fx.health)).toEqual({ ok: false, reason: "escape" });
  });

  posixOnly("refuses a redirected or broadly writable input root", () => {
    const fx = makeInstall();
    expect(checkInputRoot(fx.health).ok).toBe(true);
    chmodSync(fx.health, 0o777);
    expect(checkInputRoot(fx.health)).toEqual({ ok: false, reason: "permissions" });
    chmodSync(fx.health, 0o700);
    const alias = join(fx.base, "health-link");
    symlinkSync(fx.health, alias);
    expect(checkInputRoot(alias)).toEqual({ ok: false, reason: "link" });
  });

  it("Windows: refuses an input root whose DACL is not verified owner-only (broad, unknown or a failed check)", () => {
    const fx = makeInstall();
    const win = (verdict: () => "owner-only" | "broad" | "unknown") => checkInputRoot(fx.health, { platform: "win32", aclCheck: verdict });
    expect(win(() => "owner-only").ok).toBe(true);
    expect(win(() => "broad")).toEqual({ ok: false, reason: "acl" });
    expect(win(() => "unknown")).toEqual({ ok: false, reason: "acl" });
    expect(win(() => { throw new Error("icacls missing"); })).toEqual({ ok: false, reason: "acl" });
  });

  posixOnly("handles Unicode and spaces in every root", () => {
    const fx = makeInstall("murage sentinel ü 数据-");
    expect(loadDescriptor(fx.descriptorPath).ok).toBe(true);
  });

  posixOnly("refuses a descriptor whose installation root is a symlink alias", () => {
    const fx = makeInstall();
    const alias = join(fx.base, "data-alias");
    symlinkSync(fx.descriptor.installationRoot, alias);
    const d = { ...fx.descriptor, installationRoot: alias, inputRoot: join(alias, "health"), sources: sourcePaths(join(alias, "health")) };
    expect(writeDescriptor(d).ok).toBe(true);
    expect(loadDescriptor(fx.descriptorPath)).toEqual({ ok: false, reason: "installation-root-link" });
  });
});

describe("Windows DACL verdict (SDDL by SID)", () => {
  const user = "S-1-5-21-1111111111-2222222222-3333333333-1001";
  it("accepts a protected DACL with only the user, SYSTEM and Administrators", () => {
    expect(ownerOnlyVerdict(`murage\r\nD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${user})\r\n`, user)).toBe("owner-only");
  });
  it("calls inherited or extra principals broad, and never reads a drive letter in the name line as a DACL", () => {
    expect(ownerOnlyVerdict(`x\r\nD:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;${user})`, user)).toBe("broad");
    expect(ownerOnlyVerdict(`x\r\nD:PAI(A;OICI;FA;;;${user})(A;OICI;0x1200a9;;;BU)`, user)).toBe("broad");
    expect(ownerOnlyVerdict(`x\r\nD:PAI(A;OICI;FA;;;${user})(A;OICI;FA;;;WD)`, user)).toBe("broad");
    expect(parseDacl("D:\\Users\\owner\\x")?.allow ?? []).toEqual([]);
    expect(ownerOnlyVerdict("D:\\Users\\owner", user)).not.toBe("owner-only");
  });
  it("is unknown without the user's own entry or a valid SID", () => {
    expect(ownerOnlyVerdict("x\nD:PAI(A;OICI;FA;;;SY)", user)).toBe("unknown");
    expect(ownerOnlyVerdict("x\nD:PAI(A;OICI;FA;;;SY)", "owner")).toBe("unknown");
  });
  it("reads the built-in Administrator's alias as that account: owner-only for a RID-500 user, root-like for anyone else", () => {
    // What icacls /save writes on a GitHub Windows runner (runneradmin is the built-in Administrator, RID 500) after the
    // restriction: the user's own entry is "LA", never the numeric SID.
    const admin = "S-1-5-21-1111111111-2222222222-3333333333-500";
    const restricted = "MurageSentinel\r\nD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)\r\n";
    expect(ownerOnlyVerdict(restricted, admin)).toBe("owner-only");
    expect(ownerOnlyVerdict(restricted, user)).toBe("unknown");
    expect(ownerOnlyVerdict(`x\r\nD:PAI(A;OICI;FA;;;LA)(A;OICI;FA;;;${user})`, user)).toBe("owner-only");
    // Still refused: inherited (unprotected) entries, and any broad entry beside LA.
    expect(ownerOnlyVerdict("x\r\nD:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;LA)", admin)).toBe("broad");
    expect(ownerOnlyVerdict("x\r\nD:PAI(A;OICI;FA;;;LA)(A;OICI;0x1200a9;;;BU)", admin)).toBe("broad");
    expect(ownerOnlyVerdict("x\r\nD:PAI(A;OICI;FA;;;LA)(A;;0x1200a9;;;WD)", admin)).toBe("broad");
    expect(ownerOnlyVerdict("x\r\nD:PAI(A;OICI;FA;;;LA)(A;OICI;FA;;;LG)", admin)).toBe("broad");
    // The runner's temp folder as created (inherited, Users can read): broad, so the restriction runs.
    expect(ownerOnlyVerdict("x\r\nD:(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;ID;FA;;;LA)(A;OICIIOID;GA;;;CO)(A;OICIID;0x1200a9;;;BU)", admin)).toBe("broad");
  });
  it("never skips an entry it cannot read: a conditional ACE or a null DACL makes the DACL unparseable", () => {
    expect(parseDacl(`x\r\nD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${user})(XA;;FA;;;WD;(Member_of {SID(BA)}))(A;;FA;;;WD)`)).toBeNull();
    expect(ownerOnlyVerdict(`x\r\nD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${user})(XA;;FA;;;WD;(Member_of {SID(BA)}))(A;;FA;;;WD)`, user)).toBe("unknown");
    expect(ownerOnlyVerdict("x\r\nD:NO_ACCESS_CONTROL", user)).toBe("unknown");
    // The case review found: a RID-500 user, LA, and a conditional entry for Users that must not be skipped.
    expect(ownerOnlyVerdict("x\r\nD:P(A;;FA;;;LA)(XA;;FA;;;WD;(Member_of {SID(BU)}))", "S-1-5-21-1-2-3-500")).toBe("unknown");
    expect(ownerOnlyVerdict(`x\r\nD:PAI(A;OICI;FA;;;${user})(XA;;FA;;;BU)`, user)).toBe("unknown");
    expect(ownerOnlyVerdict(`x\r\nD:PAI(A;OICI;FA;;;${user})(A;;FA;;;WD;extra)`, user)).toBe("unknown");
    expect(ownerOnlyVerdict(`x\r\nD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${user})S:(ML;;NW;;;HI)`, user)).toBe("owner-only");
  });
  it("reads SY and BA as their SIDs, and any other account, by alias or number, as broad", () => {
    expect(ownerOnlyVerdict(`x\r\nD:PAI(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)(A;OICI;FA;;;${user})`, user)).toBe("owner-only");
    expect(ownerOnlyVerdict(`x\r\nD:PAI(A;OICI;FA;;;${user})(A;OICI;FA;;;S-1-1-0)`, user)).toBe("broad");
    expect(parseDacl("x\r\nD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)")?.allow).toEqual(["S-1-5-18", "S-1-5-32-544", "LA"]);
    for (const other of ["WD", "BU", "AU", "LG", "CO", "OW", "AC", "DU", "S-1-5-11", "S-1-5-32-545"]) {
      expect(ownerOnlyVerdict(`x\r\nD:PAI(A;OICI;FA;;;${user})(A;OICI;FA;;;${other})`, user)).toBe("broad");
    }
  });
});
