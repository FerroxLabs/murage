// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The one Windows admission rule for browser images (windowsBrowserImageState), on small synthetic PE images: the pinned unsigned
// original plus only an Authenticode table, AND Windows' answer Valid + Ferrox Labs. Everything else fails closed.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearBrowserAdmissionCache, pinnedBinaryPath, resolveAgentBrowserBinary } from "./browser-engine.ts";
import { admitWindowsBrowserImage, clearWindowsBrowserImageCache, settleWindowsBrowserImageChecks, WINDOWS_BROWSER_PUBLISHER, windowsBrowserImageState, type UnsignedPePin } from "./browser-windows-identity.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

function fixture() {
  const original = Buffer.alloc(512, 0x41), pe = 64, optional = pe + 24, security = optional + 144;
  original.write("MZ", 0); original.writeUInt32LE(pe, 0x3c); original.writeUInt32LE(0x4550, pe);
  original.writeUInt16LE(0x8664, pe + 4); original.writeUInt16LE(240, pe + 20);
  original.writeUInt16LE(0x20b, optional); original.writeUInt32LE(16, optional + 108);
  original.writeUInt32LE(12345, optional + 64); original.fill(0, security, security + 8);
  const pin: UnsignedPePin = { bytes: original.length, checksum: 12345, sha256: createHash("sha256").update(original).digest("hex") };
  const signed = Buffer.concat([original, Buffer.alloc(32)]);
  signed.writeUInt32LE(999, optional + 64); signed.writeUInt32LE(original.length, security); signed.writeUInt32LE(32, security + 4);
  signed.writeUInt32LE(32, original.length); signed.writeUInt16LE(0x200, original.length + 4); signed.writeUInt16LE(2, original.length + 6);
  return { original, signed, pin };
}
const answer = (status: string, publisher: string) => ({ authenticode: vi.fn(async () => ({ status, publisher, code: 0 })) });
const temps: string[] = [];
function write(bytes: Buffer, name = "agent-browser.exe") { const dir = mkdtempSync(join(tmpdir(), "murage-winimg-")); temps.push(dir); const file = join(dir, name); writeFileSync(file, bytes); return file; }
afterEach(() => { for (const dir of temps.splice(0)) removeTempDirSync(dir); clearWindowsBrowserImageCache(); clearBrowserAdmissionCache(); });

describe("windowsBrowserImageState: the shared Windows admission rule", () => {
  it("accepts the signed image only once Windows answers Valid with the Ferrox Labs publisher", async () => {
    const { signed, pin } = fixture(), file = write(signed), native = answer("Valid", WINDOWS_BROWSER_PUBLISHER);
    expect(windowsBrowserImageState(file, pin, native)).toBe("checking");
    expect(await settleWindowsBrowserImageChecks(5_000)).toBe(true);
    expect(windowsBrowserImageState(file, pin, native, false)).toBe("ok");
    expect(native.authenticode).toHaveBeenCalledTimes(1);
    expect(native.authenticode).toHaveBeenCalledWith(file);
  });
  it("refuses a byte changed outside the certificate table without asking Windows", async () => {
    const { signed, pin } = fixture(); signed[300] ^= 1;
    const native = answer("Valid", WINDOWS_BROWSER_PUBLISHER);
    expect(await admitWindowsBrowserImage(write(signed), pin, native)).toBe("failed");
    expect(native.authenticode).not.toHaveBeenCalled();
  });
  it("refuses data appended after the certificate table", async () => {
    const { signed, pin } = fixture();
    expect(await admitWindowsBrowserImage(write(Buffer.concat([signed, Buffer.alloc(8)])), pin, answer("Valid", WINDOWS_BROWSER_PUBLISHER))).toBe("failed");
  });
  it("refuses a wrong publisher, a non-Valid status, and an unsigned original Windows calls NotSigned", async () => {
    const { signed, original, pin } = fixture();
    expect(await admitWindowsBrowserImage(write(signed), pin, answer("Valid", "Other Publisher"))).toBe("failed");
    expect(await admitWindowsBrowserImage(write(signed), pin, answer("HashMismatch", WINDOWS_BROWSER_PUBLISHER))).toBe("failed");
    expect(await admitWindowsBrowserImage(write(original), pin, answer("NotSigned", ""))).toBe("failed");
  });
  it.each([
    ["not a PE", (b: Buffer) => { b[0] = 0; }],
    ["PE header out of range", (b: Buffer) => { b.writeUInt32LE(0xfffffff0, 0x3c); }],
    ["certificate table out of range", (b: Buffer) => { b.writeUInt32LE(4096, 64 + 24 + 144); }],
    ["truncated", (b: Buffer) => b.subarray(0, 40)],
  ])("refuses a parse error: %s", async (_name, change) => {
    const { signed, pin } = fixture(), bytes = (change(signed) as Buffer | undefined) ?? signed;
    expect(await admitWindowsBrowserImage(write(bytes), pin, answer("Valid", WINDOWS_BROWSER_PUBLISHER))).toBe("failed");
  });
  it("refuses when the native signature check is unavailable, a link, a folder or a missing file", async () => {
    const { signed, pin } = fixture(), file = write(signed);
    expect(await admitWindowsBrowserImage(file, pin, null)).toBe("failed");
    const link = join(temps[0]!, "link.exe"); symlinkSync(file, link);
    expect(await admitWindowsBrowserImage(link, pin, answer("Valid", WINDOWS_BROWSER_PUBLISHER))).toBe("failed");
    const folder = join(temps[0]!, "folder.exe"); mkdirSync(folder);
    expect(await admitWindowsBrowserImage(folder, pin, answer("Valid", WINDOWS_BROWSER_PUBLISHER))).toBe("failed");
    expect(await admitWindowsBrowserImage(join(temps[0]!, "missing.exe"), pin, answer("Valid", WINDOWS_BROWSER_PUBLISHER))).toBe("failed");
  });
  it("a native call that throws is not admitted and is asked again; a replaced file is asked again", async () => {
    const { signed, pin } = fixture(), file = write(signed);
    const flaky = { authenticode: vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue({ status: "Valid", publisher: WINDOWS_BROWSER_PUBLISHER, code: 0 }) };
    expect(await admitWindowsBrowserImage(file, pin, flaky)).toBe("unfinished");
    expect(await admitWindowsBrowserImage(file, pin, flaky)).toBe("ok");
    const refusing = answer("Valid", "Other Publisher");
    writeFileSync(file, Buffer.concat([signed])); // rewritten: new mtime/ctime, so a new identity
    await new Promise(done => setTimeout(done, 20));
    writeFileSync(file, signed);
    expect(await admitWindowsBrowserImage(file, pin, refusing)).toBe("failed");
  });
});

describe("every Windows resolver path goes through the rule", () => {
  const ok = answer("Valid", WINDOWS_BROWSER_PUBLISHER);
  it("an unpinned agent-browser.exe on PATH is no longer admitted on win32", async () => {
    const file = write(fixture().signed);
    const options = { platform: "win32" as const, arch: "x64", env: { PATH: join(file, "..") }, dataDir: mkdtempSync(join(tmpdir(), "murage-winimg-data-")), authenticode: ok };
    temps.push(options.dataDir);
    expect(resolveAgentBrowserBinary(options)).toBeNull();
    await settleWindowsBrowserImageChecks(5_000);
    expect(resolveAgentBrowserBinary(options)).toBeNull();
  });
  it("an unpinned downloaded tools copy and an unpinned packaged bundle are refused on win32", () => {
    const data = mkdtempSync(join(tmpdir(), "murage-winimg-data-")); temps.push(data);
    const tools = pinnedBinaryPath(data, "win32"); mkdirSync(join(tools, ".."), { recursive: true }); writeFileSync(tools, fixture().signed);
    expect(resolveAgentBrowserBinary({ platform: "win32", arch: "x64", env: {}, dataDir: data, authenticode: ok })).toBeNull();
    const resources = mkdtempSync(join(tmpdir(), "murage-winimg-res-")); temps.push(resources);
    const engine = join(resources, "browser-engine"); mkdirSync(join(engine, "licenses"), { recursive: true });
    writeFileSync(join(engine, "agent-browser.exe"), fixture().signed); writeFileSync(join(engine, "manifest.json"), "{}");
    expect(resolveAgentBrowserBinary({ platform: "win32", arch: "x64", env: { MURAGE_RESOURCES_PATH: resources }, authenticode: ok })).toBeNull();
  });
});
