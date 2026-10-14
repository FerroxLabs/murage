// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { exclOps } from "./engine-fs.ts";

const isSyncedHome = exclOps.syncedHomeIn;
type SyncedHomeEnv = Parameters<typeof exclOps.syncedHomeIn>[1] & object;

const same = (path: string) => path;
/** An environment with these files and folders (and nothing else) on disk. */
const disk = (files: Record<string, string | null> = {}): Required<Pick<SyncedHomeEnv, "exists" | "text" | "registryRoots">> => ({
  exists: (path) => Object.keys(files).some((name) => name === path || name.startsWith(`${path}/`)),
  text: (path) => files[path] ?? null,
  registryRoots: () => [],
});

describe("a synced home is told by the markers sync clients leave (never by a folder's name)", () => {
  const mac = { platform: "darwin" as const, home: "/Users/fixture", env: {}, real: same, ...disk() };
  const win = { platform: "win32" as const, home: "C:\\Users\\a", env: { USERPROFILE: "C:\\Users\\a", OneDrive: "C:\\Users\\a\\OneDrive - Corp", OneDriveConsumer: "C:\\Users\\a\\OneDrive", OneDriveCommercial: "D:\\Work\\OD" }, real: same, ...disk() };
  const linux = { platform: "linux" as const, home: "/home/a", env: {}, real: same, ...disk() };
  it("macOS roots", () => {
    for (const p of ["/Users/fixture/Library/CloudStorage/GoogleDrive-x/My Drive/h/f.jsonl", "/Users/fixture/Library/CloudStorage/OneDrive-Personal/h/f", "/Users/fixture/Library/Mobile Documents/com~apple~CloudDocs/h/f"]) expect(isSyncedHome(p, mac), p).toBe(true);
    expect(isSyncedHome("/Users/fixture/.claude/history.jsonl", mac)).toBe(false);
  });
  it("Windows roots, and the registry's sync roots", () => {
    for (const p of ["C:\\Users\\a\\OneDrive - Corp\\h\\f", "C:\\Users\\a\\OneDrive\\h\\f", "D:\\Work\\OD\\h\\f", "G:\\My Drive\\h\\f"]) expect(isSyncedHome(p, win), p).toBe(true);
    expect(isSyncedHome("C:\\Users\\a\\.claude\\history.jsonl", win)).toBe(false);
    expect(isSyncedHome("E:\\Box Sync\\h\\f", win)).toBe(false);
    expect(isSyncedHome("E:\\Box Sync\\h\\f", { ...win, registryRoots: () => ["E:\\Box Sync"] })).toBe(true);
  });
  it("Dropbox: the roots in its info.json, wherever they are; a folder only NAMED Dropbox is not synced", () => {
    const info = JSON.stringify({ personal: { path: "/data/shared-things" }, business: { path: "/work/db-team" } });
    const env = { ...linux, ...disk({ "/home/a/.dropbox/info.json": info }) };
    expect(isSyncedHome("/data/shared-things/h/f", env)).toBe(true);
    expect(isSyncedHome("/work/db-team/h", env)).toBe(true);
    expect(isSyncedHome("/home/a/Dropbox/h/f", linux)).toBe(false);
    expect(isSyncedHome("/home/a/Dropbox-archive/h/f", env)).toBe(false);
    const markers = { ...linux, ...disk({ "/home/a/.dropbox/info.json": JSON.stringify({ personal: { path: "/home/a/Dropbox" } }), "/home/a/Dropbox/.dropbox.cache/x": "" }) };
    expect(isSyncedHome("/home/a/Dropbox/h/f", markers)).toBe(true);
  });
  it("Google Drive's mirror folders in any ancestor", () => {
    const env = { ...linux, ...disk({ "/srv/mirror/.tmp.driveupload/x": "" }) };
    expect(isSyncedHome("/srv/mirror/engines/kimi", env)).toBe(true);
    expect(isSyncedHome("/srv/other/engines/kimi", env)).toBe(false);
  });
  it("a link into a synced folder", () => {
    const env = { ...linux, env: {}, ...disk({ "/srv/mirror/.tmp.drivedownload/x": "" }) };
    expect(isSyncedHome("/home/a/.claude/f", { ...env, real: (p) => p.replace("/home/a/.claude", "/srv/mirror/x") })).toBe(true);
  });
});
