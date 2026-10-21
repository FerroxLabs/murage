import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { nativeAuthenticodeIn, requireBrowserSignature, verifyWindowsBrowserImage, verifyWindowsBrowserSignatures, WINDOWS_BROWSER_PUBLISHER, type UnsignedPePin } from "./browser-windows-identity.ts";

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
  return { original, signed, pin, pe, optional, security };
}

describe("Windows browser original-byte binding", () => {
  it("accepts exact originals and signing-only changes without changing the pinned hash", () => {
    const { original, signed, pin } = fixture();
    expect(verifyWindowsBrowserImage(original, pin)).toEqual({ signed: false });
    expect(verifyWindowsBrowserImage(signed, pin)).toEqual({ signed: true });
  });
  it("rejects content changes even with a well-formed certificate table", () => {
    const { signed, pin } = fixture(); signed[400] ^= 1;
    expect(() => verifyWindowsBrowserImage(signed, pin)).toThrow(/pinned original/);
  });
  it.each(["truncated", "bad-dos", "out-of-bounds-pe", "bad-pe", "wrong-machine", "short-optional", "wrong-magic", "short-directories", "certificate-overlaps-image", "certificate-past-image", "truncated-certificate", "invalid-certificate", "trailing-data"])("rejects %s", kind => {
    const { signed, pin, pe, optional, security } = fixture(); let bytes = signed;
    if (kind === "truncated") bytes = signed.subarray(0, 100);
    if (kind === "bad-dos") bytes[0] = 0;
    if (kind === "out-of-bounds-pe") bytes.writeUInt32LE(0xfffffff0, 0x3c);
    if (kind === "bad-pe") bytes.writeUInt32LE(0, pe);
    if (kind === "wrong-machine") bytes.writeUInt16LE(0xaa64, pe + 4);
    if (kind === "short-optional") bytes.writeUInt16LE(32, pe + 20);
    if (kind === "wrong-magic") bytes.writeUInt16LE(0x10b, optional);
    if (kind === "short-directories") bytes.writeUInt32LE(4, optional + 108);
    if (kind === "certificate-overlaps-image") bytes.writeUInt32LE(504, security);
    if (kind === "certificate-past-image") bytes.writeUInt32LE(520, security);
    if (kind === "truncated-certificate") bytes = bytes.subarray(0, bytes.length - 1);
    if (kind === "invalid-certificate") bytes.writeUInt32LE(100, pin.bytes);
    if (kind === "trailing-data") bytes = Buffer.concat([bytes, Buffer.alloc(8)]);
    expect(() => verifyWindowsBrowserImage(bytes, pin)).toThrow(/pinned original/);
  });
  it("without the native check it refuses, and there is no PowerShell fallback left to start", async () => {
    await expect(verifyWindowsBrowserSignatures(["C:\\ok.exe"], "C:\\Windows", null)).rejects.toMatchObject({ signatureStatus: "helper-missing" });
    expect(readFileSync(new URL("./browser-windows-identity.ts", import.meta.url), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n")).not.toMatch(/powershell|Get-AuthenticodeSignature -LiteralPath|child_process/i);
  });
  it("the native check needs no PowerShell and is exactly as strict", async () => {
    const answers: Record<string, unknown> = {
      "C:\\ok.exe": { status: "Valid", publisher: WINDOWS_BROWSER_PUBLISHER, code: 0 },
      "C:\\unsigned.exe": { status: "NotSigned", publisher: "", code: 0x800b0100 },
      "C:\\other.exe": { status: "Valid", publisher: "Other Publisher", code: 0 },
      "C:\\tampered.exe": { status: "HashMismatch", publisher: "", code: 0x80096010 },
    };
    const native = { authenticode: vi.fn(async (file: string) => answers[file]) };
    // A PowerShell run would need a real Windows; a native answer never reaches it.
    await expect(verifyWindowsBrowserSignatures(["C:\\ok.exe", "C:\\ok.exe"], "C:\\NoWindows", native)).resolves.toBeUndefined();
    expect(native.authenticode).toHaveBeenCalledTimes(2);
    for (const [file, status] of [["C:\\unsigned.exe", "NotSigned"], ["C:\\other.exe", "publisher"], ["C:\\tampered.exe", "HashMismatch"]] as const)
      await expect(verifyWindowsBrowserSignatures(["C:\\ok.exe", file], "C:\\NoWindows", native)).rejects.toMatchObject({ signatureStatus: status });
    native.authenticode.mockRejectedValueOnce(new Error("did not finish"));
    await expect(verifyWindowsBrowserSignatures(["C:\\ok.exe"], "C:\\NoWindows", native)).rejects.toThrow("did not finish");
  });
  it("finds no native check off Windows or without the app's addon", () => {
    expect(nativeAuthenticodeIn(undefined)).toBeNull();
    expect(nativeAuthenticodeIn("/no/such/resources")).toBeNull();
  });
  it("requires OS-valid signature and the exact configured Azure publisher", () => {
    const config = parse(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
    expect(WINDOWS_BROWSER_PUBLISHER).toBe(config.win.azureSignOptions.publisherName);
    expect(() => requireBrowserSignature({ status: "Valid", publisher: WINDOWS_BROWSER_PUBLISHER })).not.toThrow();
    for (const result of [null, {}, { status: "NotSigned", publisher: WINDOWS_BROWSER_PUBLISHER }, { status: "HashMismatch", publisher: WINDOWS_BROWSER_PUBLISHER }, { status: "Valid", publisher: "Different Publisher" }, { status: "Valid", publisher: WINDOWS_BROWSER_PUBLISHER + " attacker" }]) expect(() => requireBrowserSignature(result)).toThrow(/valid Ferrox Labs signature/);
  });
});
