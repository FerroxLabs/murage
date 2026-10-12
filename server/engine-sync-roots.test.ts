// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { exclOps } from "./engine-fs.ts";
const inSyncRoot = exclOps.inSyncRootIn;

const same = (path: string) => path;
describe("a home inside a sync client's folder is never joined (R8)", () => {
  const mac = { platform: "darwin" as const, home: "/Users/fixture", env: {}, real: same };
  const win = { platform: "win32" as const, home: "C:\\Users\\a", env: { USERPROFILE: "C:\\Users\\a", OneDrive: "C:\\Users\\a\\OneDrive - Corp", OneDriveConsumer: "C:\\Users\\a\\OneDrive", OneDriveCommercial: "D:\\Work\\OD" }, real: same };
  const linux = { platform: "linux" as const, home: "/home/a", env: {}, real: same };
  it("macOS roots", () => {
    for (const p of ["/Users/fixture/Library/CloudStorage/GoogleDrive-x/My Drive/h/f.jsonl", "/Users/fixture/Library/CloudStorage/OneDrive-Personal/h/f", "/Users/fixture/Library/Mobile Documents/com~apple~CloudDocs/h/f", "/Users/fixture/Dropbox/h/f", "/Users/fixture/Dropbox (Personal)/h/f"]) expect(inSyncRoot(p, mac), p).toBe(true);
    expect(inSyncRoot("/Users/fixture/.claude/history.jsonl", mac)).toBe(false);
  });
  it("Windows roots", () => {
    for (const p of ["C:\\Users\\a\\OneDrive - Corp\\h\\f", "C:\\Users\\a\\OneDrive\\h\\f", "D:\\Work\\OD\\h\\f", "C:\\Users\\a\\Dropbox\\h\\f", "C:\\Users\\a\\Google Drive\\h\\f", "G:\\My Drive\\h\\f"]) expect(inSyncRoot(p, win), p).toBe(true);
    expect(inSyncRoot("C:\\Users\\a\\.claude\\history.jsonl", win)).toBe(false);
  });
  it("Linux root, and a link into a sync folder", () => {
    expect(inSyncRoot("/home/a/Dropbox/h/f", linux)).toBe(true);
    expect(inSyncRoot("/home/a/.claude/f", linux)).toBe(false);
    expect(inSyncRoot("/home/a/.claude/f", { ...linux, real: (p) => p.replace("/.claude", "/Dropbox/x") })).toBe(true);
  });
});
