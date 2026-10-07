// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { browserExtensionRuntimeDir } from "./browser-extension-paths.ts";
describe("Fable L4 and L5: registration and socket files live in the data folder", () => {
  it("uses the data folder on Mac and Linux when the socket path fits", () => {
    expect(browserExtensionRuntimeDir({ dataDir: "/home/ann/.murage", platform: "linux", env: {} })).toBe("/home/ann/.murage/bx-run");
  });
  it("fits a real Mac data folder, so the socket stays out of /tmp there too", () => {
    expect(browserExtensionRuntimeDir({ dataDir: "/Users/alex/Library/Application Support/murage", platform: "darwin", env: {} })).toBe("/Users/alex/Library/Application Support/murage/bx-run");
  });
  it("never names a predictable /tmp or %TEMP% folder for the default case", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) expect(browserExtensionRuntimeDir({ dataDir: platform === "win32" ? "C:\\Users\\ann\\AppData\\Roaming\\murage" : "/home/ann/.murage", platform, env: {} })).not.toMatch(/^\/tmp|Temp|TEMP/);
  });
  it("Windows uses a sibling folder, so the native helper creates browser-extension itself (W1)", () => {
    expect(browserExtensionRuntimeDir({ dataDir: "C:\\d", platform: "win32", env: {} })).toMatch(/bx-run$/);
  });
  it("a very deep data folder falls back to the user's own runtime folder, never the shared /tmp name of before", () => {
    const deep = "/Users/ann/Library/Application Support/murage/" + "x".repeat(60);
    expect(browserExtensionRuntimeDir({ dataDir: deep, platform: "darwin", env: {}, tmp: "/var/folders/ab/T", uid: 501 })).toMatch(/^\/var\/folders\/ab\/T\/murage-mbe-[0-9a-f]{12}-501$/);
    expect(browserExtensionRuntimeDir({ dataDir: deep, platform: "linux", env: { XDG_RUNTIME_DIR: "/run/user/1000" } })).toMatch(/^\/run\/user\/1000\/murage-mbe-/);
  });
  it("the test override still wins", () => {
    expect(browserExtensionRuntimeDir({ dataDir: "/d", platform: "linux", env: { MURAGE_BROWSER_EXTENSION_RUNTIME_ROOT: "/x" } })).toMatch(/^\/x\/mbe-/);
  });
});

describe("L5: the fallback folder is the user's own, never one another user pre-created", () => {
  const deep = "/Users/ann/Library/Application Support/murage/" + "x".repeat(60);
  const uid = process.getuid?.() ?? 0;
  const hash = createHash("sha256").update(deep).digest("hex").slice(0, 12);
  const roots: string[] = [];
  const root = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "mbe-l5-"))); roots.push(dir); return dir; };
  const cleanup = () => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); };
  it("on macOS uses the per-user TMPDIR, not /tmp", () => {
    const tmp = root();
    try { expect(browserExtensionRuntimeDir({ dataDir: deep, platform: "darwin", env: { TMPDIR: tmp }, uid })).toBe(join(tmp, `murage-mbe-${hash}-${uid}`)); } finally { cleanup(); }
  });
  it("keeps the Unix socket length limit", () => {
    const tmp = root();
    try {
      const dir = browserExtensionRuntimeDir({ dataDir: deep, platform: "darwin", env: { TMPDIR: tmp }, uid });
      expect(Buffer.byteLength(join(dir, "browser-0123456789abcdef.sock"))).toBeLessThanOrEqual(103);
      expect(() => browserExtensionRuntimeDir({ dataDir: deep, platform: "darwin", env: { TMPDIR: "/" + "t".repeat(120) }, uid })).toThrow();
    } finally { cleanup(); }
  });
  it("uses the predictable name when it is free or already ours at mode 0700", () => {
    const tmp = root(); const name = join(tmp, `murage-mbe-${hash}-${uid}`);
    try {
      mkdirSync(name, { mode: 0o700 }); chmodSync(name, 0o700);
      expect(browserExtensionRuntimeDir({ dataDir: deep, platform: "linux", env: {}, tmp, uid })).toBe(name);
    } finally { cleanup(); }
  });
  it("picks a fresh unique name when the predictable one has the wrong mode", () => {
    const tmp = root(); const name = join(tmp, `murage-mbe-${hash}-${uid}`);
    try {
      mkdirSync(name); chmodSync(name, 0o777);
      const dir = browserExtensionRuntimeDir({ dataDir: deep, platform: "linux", env: {}, tmp, uid });
      expect(dir).not.toBe(name); expect(dir.startsWith(tmp)).toBe(true); expect(() => statSync(dir)).toThrow();
    } finally { cleanup(); }
  });
  it("fails closed only when no candidate works", () => {
    const tmp = root(); const name = join(tmp, `murage-mbe-${hash}-${uid}`);
    try {
      mkdirSync(name); chmodSync(name, 0o777);
      mkdirSync(`${name}-fixed`); chmodSync(`${name}-fixed`, 0o777);
      expect(() => browserExtensionRuntimeDir({ dataDir: deep, platform: "linux", env: {}, tmp, uid, random: () => "fixed" })).toThrow(/runtime/i);
    } finally { cleanup(); }
  });
});
