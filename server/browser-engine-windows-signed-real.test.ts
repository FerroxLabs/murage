// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The REAL Authenticode-signed Windows browser images from a packaged installer (1.0.3 int run 39578406993: agent-browser.exe
// 13821840 bytes, chrome-headless-shell.exe 209488776 bytes) are admitted on every path, and a one-byte-tampered copy is refused.
// Needs WIN_SIGNED_BROWSER_RESOURCES (not MURAGE_*: the test setup strips those) = an unpacked installer's resources folder (browser-engine/ inside); skipped otherwise so the
// 13 MB + 209 MB binaries are never committed. Windows' own answer is a stub here (Linux has no WinVerifyTrust); the Vultr proof
// runs the same rule against the packaged native addon.
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearBrowserAdmissionCache, pinnedBinaryPath, settledBrowserEngineStatus } from "./browser-engine.ts";
import * as identity from "./browser-windows-identity.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const resources = process.env.WIN_SIGNED_BROWSER_RESOURCES;
const valid = () => ({ authenticode: vi.fn(async () => ({ status: "Valid", publisher: identity.WINDOWS_BROWSER_PUBLISHER, code: 0 })) });
const temps: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "murage-signed-real-")); temps.push(dir); return dir; };
afterEach(() => { for (const dir of temps.splice(0)) removeTempDirSync(dir); clearBrowserAdmissionCache(); (identity as { clearWindowsBrowserImageCache?: () => void }).clearWindowsBrowserImageCache?.(); });
const status = (env: NodeJS.ProcessEnv, authenticode: unknown, dataDir?: string) =>
  settledBrowserEngineStatus({ platform: "win32", arch: "x64", env, dataDir, authenticode } as Parameters<typeof settledBrowserEngineStatus>[0], { waitMs: 30_000 });
const tamper = (file: string) => { const bytes = readFileSync(file); bytes[4096] ^= 1; writeFileSync(file, bytes); };

describe.skipIf(!resources)("real signed Windows browser images (packaged installer bytes)", () => {
  const engine = () => join(resources!, "browser-engine", "agent-browser.exe");
  it("admits the packaged bundle (signed engine AND signed Chrome)", async () => {
    // Copied so the racy-clean admission cache and the tamper case never touch the source tree.
    const root = temp(); cpSync(resources!, root, { recursive: true });
    const native = valid();
    const result = await status({ MURAGE_RESOURCES_PATH: root }, native);
    expect(result).toMatchObject({ kind: "ready", binaryPath: join(root, "browser-engine", "agent-browser.exe") });
    expect(native.authenticode).toHaveBeenCalledTimes(2);
  }, 120_000);
  it("refuses the packaged bundle when one byte of the signed Chrome changes, and when the publisher is wrong", async () => {
    const root = temp(); cpSync(resources!, root, { recursive: true });
    tamper(join(root, "browser-engine", "chrome", "chrome-headless-shell-win64", "chrome-headless-shell.exe"));
    expect((await status({ MURAGE_RESOURCES_PATH: root }, valid())).kind).toBe("unavailable");
    const other = temp(); cpSync(resources!, other, { recursive: true });
    const wrong = { authenticode: vi.fn(async () => ({ status: "Valid", publisher: "Someone Else", code: 0 })) };
    expect((await status({ MURAGE_RESOURCES_PATH: other }, wrong)).kind).toBe("unavailable");
  }, 120_000);
  it("admits the signed engine as the downloaded tools copy and on PATH, and refuses a tampered copy on both", async () => {
    const data = temp(), tools = pinnedBinaryPath(data, "win32");
    mkdirSync(dirname(tools), { recursive: true }); copyFileSync(engine(), tools);
    expect(await status({}, valid(), data)).toMatchObject({ kind: "ready", binaryPath: tools });
    tamper(tools);
    expect((await status({}, valid(), data)).kind).toBe("unavailable");
    const bin = temp(); copyFileSync(engine(), join(bin, "agent-browser.exe"));
    expect(await status({ PATH: bin }, valid(), temp())).toMatchObject({ kind: "ready", binaryPath: join(bin, "agent-browser.exe") });
    tamper(join(bin, "agent-browser.exe"));
    expect((await status({ PATH: bin }, valid(), temp())).kind).toBe("unavailable");
  }, 120_000);
});
