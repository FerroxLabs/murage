// DESIGN 1022-cua-windows R1, R2, R3, R4a, R6c: staging the Windows driver through the real prepare-cua-windows
// entry (stageWindowsDriver), with real-shaped fixture zips and PEs built here, and the electron-builder win entries.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { NETWORK_DLLS, peImportedDlls, stageWindowsDriver } from "./prepare-cua-windows.mjs";
import * as pins from "../shared/cua-driver-windows-pins.mjs";
import { LINUX_CUA_RELEASE } from "./cua-linux-release.mjs";

const provenanceFile = JSON.parse(fs.readFileSync(new URL("./cua-driver-0.55.0-windows-provenance.json", import.meta.url), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-cua-win-stage-")); dirs.push(dir); return dir; };

/** A minimal PE32+ whose import table names `imports` and whose delay-load table names `delayed`. */
function fixturePe(imports = ["kernel32.dll", "user32.dll"], delayed = []) {
  const fileAlign = 0x200, sectionRva = 0x1000, sectionRaw = 0x200;
  const body = Buffer.alloc(0x400);
  let cursor = 0;
  const putName = (name) => { const at = cursor; body.write(`${name}\0`, cursor, "latin1"); cursor += name.length + 1; return sectionRva + at; };
  const importNames = imports.map(putName);
  const delayNames = delayed.map(putName);
  cursor = (cursor + 7) & ~7;
  const importAt = cursor;
  importNames.forEach((rva, i) => body.writeUInt32LE(rva, importAt + i * 20 + 12));
  cursor = importAt + (importNames.length + 1) * 20;
  const delayAt = cursor;
  delayNames.forEach((rva, i) => { body.writeUInt32LE(1, delayAt + i * 32); body.writeUInt32LE(rva, delayAt + i * 32 + 4); });
  cursor = delayAt + (delayNames.length + 1) * 32;
  const header = Buffer.alloc(sectionRaw);
  header.writeUInt16LE(0x5a4d, 0);
  header.writeUInt32LE(0x80, 0x3c);
  header.writeUInt32LE(0x00004550, 0x80);
  header.writeUInt16LE(0x8664, 0x84);
  header.writeUInt16LE(1, 0x86);
  header.writeUInt16LE(240, 0x94);
  const optional = 0x98;
  header.writeUInt16LE(0x20b, optional);
  header.writeUInt32LE(fileAlign, optional + 36);
  header.writeUInt32LE(16, optional + 108);
  const directories = optional + 112;
  if (importNames.length) { header.writeUInt32LE(sectionRva + importAt, directories + 8); header.writeUInt32LE((importNames.length + 1) * 20, directories + 12); }
  if (delayNames.length) { header.writeUInt32LE(sectionRva + delayAt, directories + 13 * 8); header.writeUInt32LE((delayNames.length + 1) * 32, directories + 13 * 8 + 4); }
  const section = optional + 240;
  header.write(".rdata", section, "latin1");
  header.writeUInt32LE(body.length, section + 8);
  header.writeUInt32LE(sectionRva, section + 12);
  header.writeUInt32LE(body.length, section + 16);
  header.writeUInt32LE(sectionRaw, section + 20);
  return Buffer.concat([header, body]);
}

/** A deflate zip of `files` ({ name: bytes }) under one folder, as the release packs it. */
function fixtureZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, bytes] of Object.entries(files)) {
    const data = deflateRawSync(bytes);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

/** A real-shaped release zip (every member the real one has) and a provenance pinning exactly these bytes. */
function release({ cursor = fixturePe(), driver = Buffer.concat([fixturePe(["kernel32.dll", "ws2_32.dll"]), Buffer.from("driver")]) } = {}) {
  const dir = "cua-driver-rs-0.55.0-windows-x86_64";
  const zip = fixtureZip({
    [`${dir}/cua-driver.exe`]: driver,
    [`${dir}/cua-cursor-theme.exe`]: cursor,
    [`${dir}/cua-driver-uia.exe`]: fixturePe(),
    [`${dir}/cua_driver_sdk.dll`]: Buffer.from("dll"),
    [`${dir}/cua_driver_node_runtime.node`]: Buffer.from("node"),
    [`${dir}/cua_driver_abi.h`]: Buffer.from("/* abi */"),
  });
  const provenance = { ...provenanceFile, zips: { x64: { ...provenanceFile.zips.x64, sha256: sha256(zip) } }, staged: { x64: { "cua-driver.exe": { sha256: sha256(driver) }, "cua-cursor-theme.exe": { sha256: sha256(cursor) } } } };
  return { zip, provenance, driver, cursor, dir };
}

describe("W-P1 the staged zip is the published one (R1)", () => {
  it("a zip whose sha256 is not the pinned one is rejected and nothing is staged", () => {
    const { zip, provenance } = release();
    const out = path.join(tmp(), "out");
    const other = Buffer.concat([zip, Buffer.from([0])]);
    expect(() => stageWindowsDriver({ zipBytes: other, outDir: out, provenance })).toThrow(/not the pinned release asset/);
    expect(fs.existsSync(out)).toBe(false);
  });
  it("the pinned zip sha256 is the release checksums.txt line", () => {
    expect(provenanceFile.zips.x64).toMatchObject({ name: "cua-driver-rs-0.55.0-windows-x86_64-binary.zip", sha256: "357b93254183c0e24a501eb9ad3a6e0f3738a67bfed55c0c292959b540d9b4a7" });
    expect(provenanceFile.checksumsSha256).toBe("5286f927241d1b2179063baa461e9355105aebc65a7254b9b72ad882ccb08336");
  });
});

describe("W-P2 only the two members, hash-checked (R2)", () => {
  it("a real-shaped zip stages exactly cua-driver.exe and cua-cursor-theme.exe", () => {
    const { zip, provenance } = release();
    const out = path.join(tmp(), "out");
    stageWindowsDriver({ zipBytes: zip, outDir: out, provenance });
    expect(fs.readdirSync(out).sort()).toEqual(["cua-cursor-theme.exe", "cua-driver.exe"]);
  });
  it("a 1-byte-changed cua-driver.exe throws", () => {
    const base = release();
    const changed = Buffer.from(base.driver); changed[changed.length - 1] ^= 1;
    const zip = fixtureZip({ [`${base.dir}/cua-driver.exe`]: changed, [`${base.dir}/cua-cursor-theme.exe`]: base.cursor });
    const provenance = { ...base.provenance, zips: { x64: { ...base.provenance.zips.x64, sha256: sha256(zip) } } };
    expect(() => stageWindowsDriver({ zipBytes: zip, outDir: path.join(tmp(), "out"), provenance })).toThrow(/cua-driver.exe sha256 is not the pinned member/);
  });
});

describe("W-P3 one version, one pin set (R3)", () => {
  it("the shared pins the app runs equal the windows provenance record", () => {
    expect(pins.WINDOWS_DRIVER_VERSION).toBe(provenanceFile.version);
    expect(pins.WINDOWS_DRIVER_CONTRACT_VERSION).toBe(provenanceFile.contractVersion);
    expect(pins.WINDOWS_DRIVER_SHA256).toBe(provenanceFile.staged.x64["cua-driver.exe"].sha256);
    expect(pins.WINDOWS_CURSOR_SHA256).toBe(provenanceFile.staged.x64["cua-cursor-theme.exe"].sha256);
  });
  // D1 cross-check (r8): the Windows pins name the same release as the cua-upgrade pin set (darwin provenance record,
  // linux staging pin) and the @trycua/cua-driver dependency in package.json. Mutant M-P3: windows JSON 0.54.0.
  it("the windows record is the same release as the cua-upgrade pin set and package.json", () => {
    // the upgrade record is named by the shipped dependency, never by the windows record under test
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const upgrade = JSON.parse(fs.readFileSync(new URL(`./cua-driver-${pkg.dependencies["@trycua/cua-driver"]}-provenance.json`, import.meta.url), "utf8"));
    const versions = { windows: provenanceFile.version, upgrade: upgrade.version, linux: LINUX_CUA_RELEASE.version, packageJson: pkg.dependencies["@trycua/cua-driver"] };
    expect(versions).toEqual({ windows: upgrade.version, upgrade: upgrade.version, linux: upgrade.version, packageJson: upgrade.version });
    expect(provenanceFile.sourceCommit).toBe(upgrade.sourceCommit);
    const checksums = new Set();
    const walk = (node) => { if (node && typeof node === "object") for (const [key, value] of Object.entries(node)) key === "checksumsTxtSha256" ? checksums.add(value) : walk(value); };
    walk(upgrade);
    expect([...checksums]).toEqual([provenanceFile.checksumsSha256]);
  });
});

describe("W-P5 no folder copy (R4a)", () => {
  it("every win extraResources entry into cua-win32-x64 copies one .exe file; exactly the two names", () => {
    const yml = fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
    const rest = yml.slice(yml.indexOf("\nwin:\n") + 1);
    const next = rest.slice(5).search(/\n[A-Za-z]/);
    const win = next >= 0 ? rest.slice(0, next + 5) : rest;
    const entries = [...win.matchAll(/- from: (\S+)\n\s+to: (\S+)/g)].map(([, from, to]) => ({ from, to })).filter((entry) => entry.to.startsWith("cua-win32-x64"));
    expect(entries.map((entry) => entry.to).sort()).toEqual(["cua-win32-x64/cua-cursor-theme.exe", "cua-win32-x64/cua-driver.exe"]);
    for (const entry of entries) expect(entry.from, entry.to).toMatch(/^dist-native\/cua-win32-x64\/[^/]+\.exe$/);
  });
});

describe("W-P6 the cursor helper has no network path of its own (R6c)", () => {
  it("a cursor helper without network imports stages", () => {
    const { zip, provenance } = release({ cursor: fixturePe(["kernel32.dll", "user32.dll", "gdi32.dll"]) });
    expect(stageWindowsDriver({ zipBytes: zip, outDir: path.join(tmp(), "out"), provenance })).toEqual(["cua-driver.exe", "cua-cursor-theme.exe"]);
  });
  it("a cursor helper importing winhttp.dll throws", () => {
    const { zip, provenance } = release({ cursor: fixturePe(["kernel32.dll", "WINHTTP.dll"]) });
    expect(() => stageWindowsDriver({ zipBytes: zip, outDir: path.join(tmp(), "out"), provenance })).toThrow(/imports a network library: winhttp.dll/);
  });
  it("a cursor helper delay-loading ws2_32.dll throws", () => {
    const { zip, provenance } = release({ cursor: fixturePe(["kernel32.dll"], ["ws2_32.dll"]) });
    expect(() => stageWindowsDriver({ zipBytes: zip, outDir: path.join(tmp(), "out"), provenance })).toThrow(/imports a network library: ws2_32.dll/);
  });
  it("the PE reader names both tables", () => {
    expect(peImportedDlls(fixturePe(["kernel32.dll"], ["dnsapi.dll"]))).toEqual(["kernel32.dll", "dnsapi.dll"]);
    expect(NETWORK_DLLS).toContain("iphlpapi.dll");
  });
});
