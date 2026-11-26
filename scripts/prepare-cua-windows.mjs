#!/usr/bin/env node
// Stage the Windows computer-use driver (DESIGN 1022-cua-windows D1, D2, R1, R2, R6c).
// Owner: the Windows builder lane (build-1022-cua-windows).
//
// The published 0.55.0 x86_64 zip is accepted only when its sha256 is the pinned one (the line in the release's
// checksums.txt). Exactly two members are staged, each hash-checked against its pin: cua-driver.exe and
// cua-cursor-theme.exe. cua-driver-uia.exe, the dll, the .node and the header are never staged. The cursor helper
// must not import a network library (import table and delay-load table). Usage:
//   node scripts/prepare-cua-windows.mjs --offline <zip> [--out dist-native/cua-win32-x64]
//   node scripts/prepare-cua-windows.mjs [--out ...]            (downloads the pinned release asset)
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PROVENANCE_PATH = path.join(ROOT, "scripts", "cua-driver-0.55.0-windows-provenance.json");
export const STAGED_NAMES = Object.freeze(["cua-driver.exe", "cua-cursor-theme.exe"]);
export const NETWORK_DLLS = Object.freeze(["ws2_32.dll", "winhttp.dll", "wininet.dll", "urlmon.dll", "dnsapi.dll", "iphlpapi.dll"]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The members of a zip (central directory), inflated on demand. Stored (0) and deflate (8) only. */
export function readZip(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("not a zip: no end of central directory");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("zip central directory is damaged");
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({
      name,
      read() {
        if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error(`zip member ${name} is damaged`);
        const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
        const data = bytes.subarray(start, start + compressedSize);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return inflateRawSync(data);
        throw new Error(`zip member ${name} uses unsupported method ${method}`);
      },
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Every dll a PE names in its import table and its delay-load import table, lower-cased. Throws on a malformed PE. */
export function peImportedDlls(pe) {
  if (pe.length < 0x40 || pe.readUInt16LE(0) !== 0x5a4d) throw new Error("not a PE file");
  const header = pe.readUInt32LE(0x3c);
  if (pe.readUInt32LE(header) !== 0x00004550) throw new Error("not a PE file");
  const sections = pe.readUInt16LE(header + 6);
  const optionalSize = pe.readUInt16LE(header + 20);
  const optional = header + 24;
  const magic = pe.readUInt16LE(optional);
  const directories = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : NaN);
  if (Number.isNaN(directories)) throw new Error("unknown PE optional header");
  const table = optional + optionalSize;
  const toOffset = (rva) => {
    for (let i = 0; i < sections; i += 1) {
      const s = table + i * 40;
      const va = pe.readUInt32LE(s + 12);
      const size = Math.max(pe.readUInt32LE(s + 8), pe.readUInt32LE(s + 16));
      if (rva >= va && rva < va + size) return pe.readUInt32LE(s + 20) + (rva - va);
    }
    throw new Error(`PE rva ${rva} is outside every section`);
  };
  const cString = (rva) => { const start = toOffset(rva); const stop = pe.indexOf(0, start); return pe.subarray(start, stop).toString("latin1").toLowerCase(); };
  const names = [];
  const importRva = pe.readUInt32LE(directories + 8);
  if (importRva) {
    for (let d = toOffset(importRva); ; d += 20) {
      const nameRva = pe.readUInt32LE(d + 12);
      if (!nameRva && !pe.readUInt32LE(d) && !pe.readUInt32LE(d + 16)) break;
      names.push(cString(nameRva));
    }
  }
  const delayRva = pe.readUInt32LE(directories + 13 * 8);
  if (delayRva) {
    for (let d = toOffset(delayRva); ; d += 32) {
      const nameRva = pe.readUInt32LE(d + 4);
      if (!nameRva) break;
      names.push(cString(nameRva));
    }
  }
  return names;
}

/** Check and stage. Returns the staged names; throws (and stages nothing) on any mismatch. */
export function stageWindowsDriver({ zipBytes, outDir, provenance = JSON.parse(fs.readFileSync(PROVENANCE_PATH, "utf8")) }) {
  const pins = provenance.staged.x64;
  if (sha256(zipBytes) !== provenance.zips.x64.sha256) throw new Error("cua-driver Windows zip sha256 is not the pinned release asset");
  const entries = readZip(zipBytes);
  const staged = new Map();
  for (const name of STAGED_NAMES) {
    const matches = entries.filter((entry) => path.posix.basename(entry.name) === name);
    if (matches.length !== 1) throw new Error(`cua-driver Windows zip must hold exactly one ${name}`);
    const bytes = matches[0].read();
    if (sha256(bytes) !== pins[name].sha256) throw new Error(`${name} sha256 is not the pinned member`);
    staged.set(name, bytes);
  }
  const imports = peImportedDlls(staged.get("cua-cursor-theme.exe"));
  const network = imports.filter((dll) => NETWORK_DLLS.includes(dll));
  if (network.length) throw new Error(`cua-cursor-theme.exe imports a network library: ${network.join(", ")}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, bytes] of staged) fs.writeFileSync(path.join(outDir, name), bytes);
  return [...staged.keys()];
}

async function main(argv) {
  const offlineAt = argv.indexOf("--offline");
  const outAt = argv.indexOf("--out");
  const outDir = path.resolve(outAt >= 0 ? argv[outAt + 1] : path.join(ROOT, "dist-native", "cua-win32-x64"));
  const provenance = JSON.parse(fs.readFileSync(PROVENANCE_PATH, "utf8"));
  let zipBytes;
  if (offlineAt >= 0) zipBytes = fs.readFileSync(argv[offlineAt + 1]);
  else {
    const url = `https://github.com/trycua/cua/releases/download/${provenance.release}/${provenance.zips.x64.name}`;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`download failed: ${response.status}`);
    zipBytes = Buffer.from(await response.arrayBuffer());
  }
  const staged = stageWindowsDriver({ zipBytes, outDir, provenance });
  console.log(`staged ${staged.join(", ")} into ${outDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
