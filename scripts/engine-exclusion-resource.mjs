// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The packaged engine-exclusion addon (native/engine-exclusion, built by scripts/build-engine-exclusion.mjs). Without it Murage cannot
// remove a deleted conversation's copies from the coding engines' files (it leaves them alone and says so), so a package that lacks
// it, or carries one for another platform, is refused when it is assembled: electron-builder's copier only warns on a missing source.
import { lstatSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";

// What each platform's addon must be: the image type AND the machine it runs on (a zero-filled file with a magic number, or an
// image for another architecture, is refused). `arch` is the package's target ("arm64", "x64"); a macOS universal image is accepted
// only when it carries that architecture.
const MACHINE = {
  macho: { arm64: 0x0100000c, x64: 0x01000007 },
  elf: { arm64: 0xb7, x64: 0x3e },
  pe: { arm64: 0xaa64, x64: 0x8664 },
};

/** The machines an image is built for, or null when it is not an image of `platform` (Mach-O, ELF or PE). */
function machinesOf(file, platform, size) {
  const read = (at, length) => { const out = Buffer.alloc(length); return readSync(file, out, 0, length, at) < length ? null : out; };
  const head = read(0, 8);
  if (!head) return null;
  if (platform === "darwin") {
    const magic = head.readUInt32BE(0);
    if (magic === 0xcffaedfe) { const h = read(4, 4); return h ? [h.readUInt32LE(0)] : null; }                    // 64-bit little-endian Mach-O
    if (magic === 0xcafebabe) {                                                                                  // universal
      const count = head.readUInt32BE(4);
      if (count < 1 || count > 8) return null;
      const table = read(8, count * 20);
      if (!table) return null;
      return Array.from({ length: count }, (_, i) => table.readUInt32BE(i * 20));
    }
    return null;
  }
  if (platform === "linux") {
    if (!(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46 && head[4] === 2 && head[5] === 1)) return null; // 64-bit little-endian ELF
    const h = read(18, 2);
    return h ? [h.readUInt16LE(0)] : null;
  }
  if (platform === "win32") {
    if (!(head[0] === 0x4d && head[1] === 0x5a)) return null;
    const at = read(0x3c, 4);
    if (!at) return null;
    const offset = at.readUInt32LE(0);
    if (offset < 0x40 || offset + 6 > size) return null;
    const sig = read(offset, 6);
    if (!sig || sig.readUInt32BE(0) !== 0x50450000) return null;
    return [sig.readUInt16LE(4)];
  }
  return null;
}

/** Throws unless `<resources>/engine-exclusion.node` is a regular, single-link file of a plausible size whose header is an
 * executable image of `platform` (Mach-O, ELF or PE). Returns its path. */
export function validateEngineExclusionResource(resources, platform, arch = process.arch) {
  const kind = { darwin: "macho", linux: "elf", win32: "pe" }[platform];
  if (!kind) throw new Error("ENGINE_EXCLUSION_PLATFORM_UNSUPPORTED");
  const want = MACHINE[kind][arch];
  if (want === undefined) throw new Error("ENGINE_EXCLUSION_PLATFORM_UNSUPPORTED");
  const file = path.join(resources, "engine-exclusion.node");
  let details;
  try { details = lstatSync(file); } catch { throw new Error("ENGINE_EXCLUSION_RESOURCE_MISSING"); }
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 || details.size < 1024 || details.size > 4 * 1024 * 1024) throw new Error("ENGINE_EXCLUSION_RESOURCE_INVALID");
  const fd = openSync(file, "r");
  try {
    const machines = machinesOf(fd, platform, details.size);
    if (!machines || !machines.includes(want)) throw new Error("ENGINE_EXCLUSION_RESOURCE_MISMATCH");
  } finally { closeSync(fd); }
  return file;
}

/** Loads the addon at `file` in a fresh process of the release environment (when this machine can run it) and checks that it answers
 * with the version this build expects and offers `processes`. Returns "loaded", or "skipped" when the package is for another platform
 * or architecture than this machine's (the release pipeline runs this on each target). Throws ENGINE_EXCLUSION_RESOURCE_UNLOADABLE. */
export function loadEngineExclusionResource(file, platform, arch, expectedVersion, run) {
  if (platform !== process.platform || arch !== process.arch) return "skipped";
  const code = "const a=require(process.argv[1]);process.stdout.write(JSON.stringify([a.version(),typeof a.processes,typeof a.lock,typeof a.renameNoReplace]))";
  let out;
  try { out = run(process.execPath, ["-e", code, file]); } catch { throw new Error("ENGINE_EXCLUSION_RESOURCE_UNLOADABLE"); }
  let answer;
  try { answer = JSON.parse(String(out)); } catch { throw new Error("ENGINE_EXCLUSION_RESOURCE_UNLOADABLE"); }
  if (answer[0] !== expectedVersion || answer[1] !== "function" || answer[2] !== "function" || answer[3] !== "function") throw new Error("ENGINE_EXCLUSION_RESOURCE_VERSION");
  return "loaded";
}
