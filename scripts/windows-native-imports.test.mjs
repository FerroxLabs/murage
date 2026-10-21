import { describe, expect, it } from "vitest";
import { assertWindowsNativeImports, disallowedImports, isAllowedImport, peImportedDlls } from "./windows-native-imports.mjs";

// A small synthetic PE32+ image: one .idata section at RVA 0x1000 / file offset 0x200, holding a regular import table and a delay-load table.
function pe({ imports = [], delayed = [], plus = true, relativeDelay = true } = {}) {
  const buffer = Buffer.alloc(0x200 + 0x1000);
  buffer.writeUInt16LE(0x5a4d, 0); buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x4550, 0x80);
  const optionalSize = plus ? 240 : 224, optional = 0x98;
  buffer.writeUInt16LE(plus ? 0x8664 : 0x14c, 0x84); buffer.writeUInt16LE(1, 0x86); buffer.writeUInt16LE(optionalSize, 0x94);
  buffer.writeUInt16LE(plus ? 0x20b : 0x10b, optional);
  const imageBase = 0x180000000;
  if (plus) buffer.writeBigUInt64LE(BigInt(imageBase), optional + 24); else buffer.writeUInt32LE(0x10000000, optional + 28);
  const base = plus ? imageBase : 0x10000000;
  const directories = optional + (plus ? 112 : 96);
  buffer.writeUInt32LE(16, directories - 4);
  const section = optional + optionalSize;
  buffer.write(".idata", section); buffer.writeUInt32LE(0x1000, section + 8); buffer.writeUInt32LE(0x1000, section + 12); buffer.writeUInt32LE(0x1000, section + 16); buffer.writeUInt32LE(0x200, section + 20);
  let nameAt = 0x800; const put = (name) => { const rva = 0x1000 + nameAt; buffer.write(name + "\0", 0x200 + nameAt, "latin1"); nameAt += name.length + 1; return rva; };
  if (imports.length) {
    buffer.writeUInt32LE(0x1000, directories + 8); buffer.writeUInt32LE((imports.length + 1) * 20, directories + 12);
    imports.forEach((name, i) => { buffer.writeUInt32LE(put(name), 0x200 + i * 20 + 12); buffer.writeUInt32LE(0x2000, 0x200 + i * 20 + 16); });
  }
  if (delayed.length) {
    buffer.writeUInt32LE(0x1200, directories + 13 * 8); buffer.writeUInt32LE((delayed.length + 1) * 32, directories + 13 * 8 + 4);
    delayed.forEach((name, i) => { const at = 0x200 + 0x200 + i * 32, rva = put(name); buffer.writeUInt32LE(relativeDelay ? 1 : 0, at); buffer.writeUInt32LE(relativeDelay ? rva : base + rva, at + 4); });
  }
  return buffer;
}

describe("the Windows native import guard", () => {
  it("lists regular and delay-load imports", () => {
    expect(peImportedDlls(pe({ imports: ["KERNEL32.dll", "ADVAPI32.dll"], delayed: ["node.exe"] }))).toEqual(["KERNEL32.dll", "ADVAPI32.dll", "node.exe"]);
  });
  it("reads 32-bit images and absolute delay-load names", () => {
    expect(peImportedDlls(pe({ imports: ["KERNEL32.dll"], delayed: ["node.exe"], plus: false, relativeDelay: false }))).toEqual(["KERNEL32.dll", "node.exe"]);
  });
  it("passes the system allowlist, UCRT forwarders and the host exe", () => {
    const names = ["KERNEL32.dll", "ADVAPI32.dll", "USER32.dll", "ole32.dll", "OLEAUT32.dll", "WINTRUST.dll", "CRYPT32.dll", "USERENV.dll", "WS2_32.dll", "SHELL32.dll", "api-ms-win-crt-runtime-l1-1-0.dll", "api-ms-win-core-synch-l1-2-0.dll", "node.exe"];
    expect(disallowedImports(pe({ imports: names.slice(0, 8), delayed: names.slice(8) }))).toEqual([]);
  });
  it("fails closed on a C runtime that a clean Windows machine does not have", () => {
    const image = pe({ imports: ["KERNEL32.dll", "VCRUNTIME140.dll", "MSVCP140.dll", "VCRUNTIME140_1.dll", "MSVCR120.dll"], delayed: ["node.exe"] });
    expect(disallowedImports(image)).toEqual(["VCRUNTIME140.dll", "MSVCP140.dll", "VCRUNTIME140_1.dll", "MSVCR120.dll"]);
    expect(() => assertWindowsNativeImports(["engine-exclusion.node"], { read: () => image })).toThrow(/WINDOWS_NATIVE_IMPORTS_REFUSED: engine-exclusion\.node imports VCRUNTIME140\.dll/);
  });
  it("refuses a delay-loaded runtime too, and any unlisted DLL", () => {
    expect(disallowedImports(pe({ imports: ["KERNEL32.dll"], delayed: ["VCRUNTIME140.dll"] }))).toEqual(["VCRUNTIME140.dll"]);
    expect(isAllowedImport("api-ms-win-crt-x.exe")).toBe(false);
    expect(isAllowedImport("evil-api-ms-win-core-x.dll")).toBe(false);
    expect(isAllowedImport("ucrtbase.dll")).toBe(false);
  });
  it("accepts a static-runtime image and reports every file", () => {
    const good = pe({ imports: ["KERNEL32.dll"] }), report = assertWindowsNativeImports(["a.node", "b.exe"], { read: () => good });
    expect(report).toEqual({ "a.node": ["KERNEL32.dll"], "b.exe": ["KERNEL32.dll"] });
  });
  it("rejects files that are not intact PE images", () => {
    expect(() => peImportedDlls(Buffer.from("not a pe"))).toThrow(/PE_IMPORTS/);
    expect(() => peImportedDlls(Buffer.alloc(0x100))).toThrow(/PE_IMPORTS_NOT_PE/);
    const bad = pe({ imports: ["KERNEL32.dll"] }); bad.writeUInt32LE(0x50000, 0x200 + 12);
    expect(() => peImportedDlls(bad)).toThrow(/PE_IMPORTS_BAD_RVA/);
    expect(() => peImportedDlls(pe({ imports: ["KERNEL32.dll"] }).subarray(0, 0x300))).toThrow(/PE_IMPORTS/);
  });
});
