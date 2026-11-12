import { removeTempDirSync } from "../testing/cleanup.ts";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({
  platform: "linux", events: [] as string[], directoryFds: new Set<number>(),
  crash: "", volume: { format: "NTFS", driveType: 3 }, mount: "apfs, local, journaled",
  race: undefined as undefined | (() => void),
  fsType: undefined as number | undefined,
  readOnlyAncestor: "",
}));
// MAIN Round 2 migrates the transport to the existing native volume query.
// Keep the same volume evidence and all storage/durability assertions.
vi.mock("../engine-exclusion.ts", () => ({ requireWindowsAddon: () => ({
  driveInfo: () => injected.volume && ({ format: injected.volume.format,
    type: ({ 2: "Removable", 3: "Fixed", 4: "Network" } as Record<number, string>)[injected.volume.driveType] ?? "Unknown" }),
}) }));
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), platform: () => injected.platform }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: (file: string) => file.endsWith("mount")
    ? `disk on / (${injected.mount})\n`
    : JSON.stringify(injected.volume),
}));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const isDir = fs.existsSync(args[0]) && fs.statSync(args[0]).isDirectory();
      if (isDir && injected.platform === "win32") throw Object.assign(new Error("Windows directory handle"), { code: "EPERM" });
      if (isDir && String(args[0]) === injected.readOnlyAncestor) throw Object.assign(new Error("Read-only system volume"), { code: "EROFS" });
      const fd = fs.openSync(...args);
      if (isDir) injected.directoryFds.add(fd); else injected.directoryFds.delete(fd);
      return fd;
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[0] === "number") {
        injected.events.push("write");
        if (injected.crash === "torn") { fs.writeFileSync(args[0], "{torn"); throw new Error("power loss during write"); }
      }
      return fs.writeFileSync(...args);
    },
    fsyncSync: (fd: number) => {
      const kind = injected.directoryFds.has(fd) ? "directory-sync" : "file-sync";
      injected.events.push(kind);
      if (injected.crash === kind) throw new Error("flush failed");
      if (injected.crash === "post-publish-sync" && kind === "file-sync" && injected.events.includes("publish")) throw new Error("post-publication flush failed");
      fs.fsyncSync(fd);
    },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      injected.events.push("publish");
      if (injected.crash === "before-publish") throw new Error("power loss before publication");
      const race = injected.race; injected.race = undefined; race?.();
      fs.linkSync(...args);
      if (injected.crash === "after-publish") throw new Error("power loss after publication");
    },
    statfsSync: (...args: Parameters<typeof fs.statfsSync>) => {
      const stat = fs.statfsSync(...args);
      return { ...stat, type: injected.fsType ?? stat.type };
    },
    statSync: (...args: Parameters<typeof fs.statSync>) => {
      const stat = fs.statSync(...args);
      return String(args[0]) === injected.readOnlyAncestor ? { ...stat, dev: -1 } : stat;
    },
  };
});
import { FileApprovalJournal, runApprovedWrite } from "./approval-idempotency.ts";
let directory: string;
const applied = { status: "applied", result: { recordId: "safe" } } as const;
beforeEach(() => {
  injected.platform = "linux"; injected.crash = ""; injected.events = []; injected.race = undefined;
  injected.fsType = undefined;
  injected.readOnlyAncestor = "";
  injected.volume = { format: "NTFS", driveType: 3 }; injected.mount = "apfs, local, journaled";
  directory = realFs.mkdtempSync(join(tmpdir(), "hl-f03-"));
});
afterEach(() => removeTempDirSync(directory));
for (const platform of ["win32", "darwin", "linux"]) {
  it(`${platform}: flushes before atomic publication and uses the platform durability barrier`, () => {
    injected.platform = platform;
    const journal = new FileApprovalJournal(directory);
    injected.events = [];
    expect(journal.claim("id", "digest")).toBe(true);
    expect(injected.events.slice(0, 3)).toEqual(["write", "file-sync", "publish"]);
    expect(injected.events.slice(3)).toContain(platform === "win32" ? "file-sync" : "directory-sync");
    if (platform === "win32") expect(injected.events).not.toContain("directory-sync");
    expect(journal.settle("id", "digest", applied)).toEqual(applied);
    expect(new FileApprovalJournal(directory).get("id")).toMatchObject({ state: "applied" });
  });
  for (const crash of ["torn", "before-publish", "file-sync"]) {
    it(`${platform}: ${crash} cannot dispatch or become an approval after reopen`, async () => {
      injected.platform = platform;
      const journal = new FileApprovalJournal(directory);
      injected.crash = crash;
      const dispatch = vi.fn(async () => applied);
      await expect(runApprovedWrite(journal, "id", "digest", { dispatch, reconcile: dispatch })).rejects.toThrow();
      expect(dispatch).not.toHaveBeenCalled();
      injected.crash = "";
      // Orphaned complete and torn temps from an abrupt exit are never replayed.
      realFs.writeFileSync(join(directory, ".entry-orphan.tmp"), "{torn");
      const reopened = new FileApprovalJournal(directory);
      expect(reopened.get("id")).toBeUndefined();
      expect(reopened.claim("id", "digest")).toBe(true);
    });
  }
  it(`${platform}: crash after publication leaves pending and only reconciles`, async () => {
    injected.platform = platform;
    const journal = new FileApprovalJournal(directory);
    injected.crash = "after-publish";
    expect(() => journal.claim("id", "digest")).toThrow();
    injected.crash = "";
    const dispatch = vi.fn(async () => applied), reconcile = vi.fn(async () => applied);
    expect(await runApprovedWrite(new FileApprovalJournal(directory), "id", "digest", { dispatch, reconcile })).toEqual(applied);
    expect(dispatch).not.toHaveBeenCalled(); expect(reconcile).toHaveBeenCalledTimes(1);
  });
  it(`${platform}: duplicate approvalId racing at publication cannot replace winner`, () => {
    injected.platform = platform;
    const first = new FileApprovalJournal(directory), second = new FileApprovalJournal(directory);
    injected.race = () => expect(second.claim("id", "winner")).toBe(true);
    expect(first.claim("id", "loser")).toBe(false);
    expect(first.get("id")).toMatchObject({ requestDigest: "winner" });
    injected.race = () => expect(second.settle("id", "winner", applied)).toEqual(applied);
    expect(first.settle("id", "winner", { status: "conflict", reason: "unconfirmed" })).toEqual(applied);
  });
  it(`${platform}: post-publication barrier failure never dispatches, including on reopen`, async () => {
    injected.platform = platform;
    const journal = new FileApprovalJournal(directory);
    injected.crash = "post-publish-sync";
    const dispatch = vi.fn(async () => applied), reconcile = vi.fn(async () => applied);
    await expect(runApprovedWrite(journal, "id", "digest", { dispatch, reconcile })).rejects.toThrow(/HighLevel approval journal/);
    await expect(runApprovedWrite(new FileApprovalJournal(directory), "id", "digest", { dispatch, reconcile })).rejects.toThrow(/HighLevel approval journal/);
    expect(dispatch).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
    injected.crash = "";
    expect(await runApprovedWrite(new FileApprovalJournal(directory), "id", "digest", { dispatch, reconcile })).toEqual(applied);
    expect(dispatch).not.toHaveBeenCalled(); expect(reconcile).toHaveBeenCalledTimes(1);
  });
  it(`${platform}: torn terminal temp preserves pending for reconciliation`, async () => {
    injected.platform = platform;
    const journal = new FileApprovalJournal(directory);
    journal.claim("id", "digest");
    injected.crash = "torn";
    expect(() => journal.settle("id", "digest", applied)).toThrow();
    injected.crash = "";
    expect(new FileApprovalJournal(directory).get("id")).toMatchObject({ state: "pending" });
  });
}
for (const format of ["FAT", "FAT32", "exFAT"]) it(`win32: ${format} gives the owner an actionable storage error`, () => {
  injected.platform = "win32"; injected.volume.format = format;
  expect(() => new FileApprovalJournal(directory)).toThrow(/HighLevel approval journal.*local.*NTFS/i);
});
it("win32: mapped network NTFS is refused before writing an approval", () => {
  injected.platform = "win32"; injected.volume.driveType = 4;
  expect(() => new FileApprovalJournal(directory)).toThrow(/HighLevel approval journal.*network/i);
});
for (const mount of ["smbfs, nodev", "nfs", "exfat, local", "msdos, local"]) it(`darwin: refuses ${mount} with owner guidance`, () => {
  injected.platform = "darwin"; injected.mount = mount;
  expect(() => new FileApprovalJournal(directory)).toThrow(/HighLevel approval journal.*local.*APFS/i);
});
for (const [name, type] of Object.entries({ FAT: 0x4d44, exFAT: 0x2011bab0, NFS: 0x6969, CIFS: 0xff534d42, SMB2: 0xfe534d42, nineP: 0x01021997, Ceph: 0x00c36400 })) {
  it(`linux: ${name} is refused with owner guidance`, () => {
    injected.fsType = type;
    expect(() => new FileApprovalJournal(directory)).toThrow(/HighLevel approval journal.*local/i);
  });
}
for (const platform of ["darwin", "linux"]) it(`${platform}: reopening after directory creation failure retries ancestor barriers`, () => {
  injected.platform = platform;
  const nested = join(directory, "new-parent", "journal");
  injected.crash = "directory-sync";
  expect(() => new FileApprovalJournal(nested)).toThrow(/HighLevel approval journal/);
  injected.crash = ""; injected.events = [];
  new FileApprovalJournal(nested);
  // Both new directory names need a durable parent, even though mkdir now
  // reports EEXIST after the earlier failed initialization.
  expect(injected.events.filter(event => event === "directory-sync").length).toBeGreaterThanOrEqual(3);
});
for (const platform of ["darwin", "linux"]) it(`${platform}: directory barriers stop at the volume boundary`, () => {
  injected.platform = platform;
  injected.readOnlyAncestor = directory;
  const nested = join(directory, "data-volume", "journal");
  const journal = new FileApprovalJournal(nested);
  expect(journal.claim("id", "digest")).toBe(true);
});
