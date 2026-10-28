// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compareVersions, GLIBC_FLOOR, maxGlibcVersion } from "./linux-floor.mjs";
import { LINUX_CUA_RELEASE } from "./cua-linux-release.mjs";

// Linux cua-driver-rs 0.19.3 (LINUX_CUA_RELEASE.version) prebuilt: the owner
// approved this ceiling on 2026-10-26. Only these exact paths and hashes qualify.
const CUA_REASON = `pinned Linux cua-driver-rs ${LINUX_CUA_RELEASE.version} prebuilt; ceiling approved by owner on 2026-10-26`;
export const REVIEWED_CEILINGS = Object.freeze({
  "resources/cua-linux-x64/cua-driver": Object.freeze({ sha256: LINUX_CUA_RELEASE.driverSha256, ceiling: "2.30", reason: CUA_REASON }),
  "resources/cua-linux-x64/cua-cursor-theme": Object.freeze({ sha256: LINUX_CUA_RELEASE.cursorThemeSha256, ceiling: "2.30", reason: CUA_REASON }),
});

export function exceedsCeiling(version, resourcePath, sha256) {
  const allowance = Object.hasOwn(REVIEWED_CEILINGS, resourcePath) ? REVIEWED_CEILINGS[resourcePath] : undefined;
  const ceiling = allowance && sha256 === allowance.sha256 ? allowance.ceiling : GLIBC_FLOOR;
  return version !== null && compareVersions(version, ceiling) > 0;
}

function readAt(fd, offset, length) {
  const bytes = Buffer.alloc(length);
  const count = readSync(fd, bytes, 0, length, offset);
  return bytes.subarray(0, count);
}

export function isElf(file) {
  const fd = openSync(file, "r");
  try { return readAt(fd, 0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])); }
  finally { closeSync(fd); }
}

export function* walkElfFiles(root) {
  const entry = lstatSync(root);
  if (entry.isSymbolicLink()) return;
  if (entry.isFile()) { if (isElf(root)) yield root; return; }
  if (entry.isDirectory()) {
    for (const name of readdirSync(root).sort()) yield* walkElfFiles(path.join(root, name));
  }
}

// Parse the ELF section table rather than executing the AppImage runtime.
// Supports ELF32/ELF64, both byte orders, and extended section counts.
function runtimeSectionsEnd(read, size) {
  const header = read(0, 64);
  if (header.length < 52 || header.readUInt32BE(0) !== 0x7f454c46 || ![1, 2].includes(header[4]) || ![1, 2].includes(header[5])) throw new Error("Invalid AppImage ELF header");
  const wide = header[4] === 2, little = header[5] === 1;
  if (wide && header.length < 64) throw new Error("Truncated AppImage ELF64 header");
  const u16 = (b, o) => little ? b.readUInt16LE(o) : b.readUInt16BE(o);
  const u32 = (b, o) => little ? b.readUInt32LE(o) : b.readUInt32BE(o);
  const word = (b, o) => wide ? Number(little ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o)) : u32(b, o);
  const offset = word(header, wide ? 40 : 32), entrySize = u16(header, wide ? 58 : 46);
  let count = u16(header, wide ? 60 : 48);
  const headerSize = wide ? 64 : 52;
  if (!Number.isSafeInteger(offset) || offset < headerSize || entrySize < (wide ? 64 : 40) || offset + entrySize > size) throw new Error("Invalid AppImage section table");
  if (count === 0) {
    const sectionZero = read(offset, entrySize);
    if (sectionZero.length !== entrySize) throw new Error("Truncated AppImage section table");
    count = word(sectionZero, wide ? 32 : 20);
  }
  const end = offset + entrySize * count;
  if (!Number.isSafeInteger(end) || count < 1 || end > size) throw new Error("Invalid AppImage section table bounds");
  return end;
}

function findOffset(read, size) {
  let offset = runtimeSectionsEnd(read, size);
  while (offset + 4 <= size) {
    const chunk = read(offset, Math.min(1024 * 1024, size - offset));
    const index = chunk.indexOf("hsqs", 0, "ascii");
    if (index !== -1) return offset + index;
    if (chunk.length < 4) break;
    offset += chunk.length - 3; // Include magic spanning two chunks.
  }
  throw new Error("AppImage squashfs superblock not found after ELF section headers");
}

export function findAppImageOffset(bytes) {
  return findOffset((offset, length) => bytes.subarray(offset, offset + length), bytes.length);
}

function appImageOffset(file) {
  const fd = openSync(file, "r");
  try { return findOffset((offset, length) => readAt(fd, offset, length), fstatSync(fd).size); }
  finally { closeSync(fd); }
}

function symbols(file, exec) {
  try { return String(exec("objdump", ["-T", file], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, maxBuffer: 32 * 1024 * 1024, timeout: 120000 })); }
  catch (error) {
    // GNU objdump returns 1 for a valid static ELF with no dynamic table (Go
    // tools, for example). Other tool/format failures must fail the gate.
    if (error.status === 1 && /not a dynamic object/.test(String(error.stderr)) && /DYNAMIC SYMBOL TABLE:\s*no symbols/.test(String(error.stdout))) return String(error.stdout);
    throw error;
  }
}

export function checkLinuxGlibcFloor(files, { exec = execFileSync, log = console.log, error = console.error } = {}) {
  const entries = [];
  let failed = false;
  for (const [resourcePath, allowance] of Object.entries(REVIEWED_CEILINGS)) {
    log(`Allowance ${resourcePath} sha256=${allowance.sha256} ceiling=GLIBC_${allowance.ceiling}: ${allowance.reason}`);
  }
  if (!files.length) { error("Usage: check-linux-glibc-floor.mjs <file.deb|file.AppImage|ELF>..."); return 1; }
  for (const argument of files) {
    let temp;
    const cuaStatus = new Map(Object.keys(REVIEWED_CEILINGS).map(resourcePath => [resourcePath, { found: false, matched: false }]));
    try {
      const file = path.resolve(argument);
      if (!lstatSync(file).isFile()) throw new Error("Input must be a regular file");
      const deb = file.endsWith(".deb"), appImage = file.endsWith(".AppImage");
      let root = file;
      if (deb || appImage) {
        temp = mkdtempSync(path.join(tmpdir(), "murage-glibc-floor-"));
        root = path.join(temp, "payload");
        const options = { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10 * 60 * 1000 };
        if (deb) exec("dpkg-deb", ["-x", file, root], options);
        else {
          // The runtime is itself shipped ELF code, so scan it as well.
          entries.push({ path: `${argument}:runtime`, max: maxGlibcVersion(symbols(file, exec)), resourcePath: "" });
          exec("unsquashfs", ["-no-xattrs", "-d", root, "-o", String(appImageOffset(file)), file], options);
        }
      } else if (!isElf(file)) throw new Error("Input is neither a package nor an ELF");
      // One app-relative rule: opt/Murage in a deb, squashfs root in an AppImage.
      const appRoot = deb ? path.join(root, "opt/Murage") : appImage ? root : null;
      if (appRoot) {
        for (const [resourcePath, allowance] of Object.entries(REVIEWED_CEILINGS)) {
          const candidate = path.join(appRoot, resourcePath);
          const details = lstatSync(candidate, { throwIfNoEntry: false });
          if (!details) continue;
          const status = cuaStatus.get(resourcePath);
          status.found = true;
          if (details.isFile()) status.sha256 = createHash("sha256").update(readFileSync(candidate)).digest("hex");
          status.matched = status.sha256 === allowance.sha256;
          if (!status.matched) { failed = true; error(`sha256 mismatch ${resourcePath}`); }
        }
      }
      let count = 0;
      for (const elf of walkElfFiles(root)) {
        const relative = deb || appImage ? path.relative(root, elf).split(path.sep).join("/") : path.basename(elf);
        // Only the actual package app roots qualify for reviewed exceptions;
        // arbitrary nested paths and bare input files never inherit them.
        const resourcePath = appRoot ? path.relative(appRoot, elf).split(path.sep).join("/") : "";
        entries.push({ path: deb || appImage ? `${argument}:${relative}` : argument, max: maxGlibcVersion(symbols(elf, exec)), resourcePath, sha256: cuaStatus.get(resourcePath)?.sha256 });
        count++;
      }
      if (!count) throw new Error("No ELF files found in payload");
    } catch (cause) {
      error(`${argument}: ${cause.message}`);
      failed = true;
    } finally {
      for (const [resourcePath, status] of cuaStatus) {
        log(`CUA ${argument}: ${resourcePath} found=${status.found ? "yes" : "no"} matched=${status.matched ? "yes" : "no"}`);
      }
      if (temp) rmSync(temp, { recursive: true, force: true });
    }
  }
  entries.sort((a, b) => compareVersions(b.max ?? "0.0", a.max ?? "0.0") || a.path.localeCompare(b.path));
  for (const entry of entries) {
    log(`${entry.max ?? "none"} ${entry.path}`);
    if (exceedsCeiling(entry.max, entry.resourcePath, entry.sha256)) { failed = true; error(`${entry.max} ${entry.path}`); }
  }
  log(`GLIBC floor ${GLIBC_FLOOR}: ${entries.length} ELF files; ${failed ? "FAIL" : "PASS"}. Highest entries:`);
  for (const entry of entries.slice(0, 10)) log(`${entry.max ?? "none"} ${entry.path}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = checkLinuxGlibcFloor(process.argv.slice(2));
