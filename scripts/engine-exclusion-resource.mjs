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

/** The machines an image is built for, or null when it is not a loadable image of `platform`: a Mach-O bundle (MH_BUNDLE), an ELF shared
 * object (ET_DYN) or a PE DLL (IMAGE_FILE_DLL). A file that only starts like one (a header with nothing behind it) is not an addon. */
function machinesOf(file, platform, size) {
  const read = (at, length) => { const out = Buffer.alloc(length); return readSync(file, out, 0, length, at) < length ? null : out; };
  const head = read(0, 8);
  if (!head) return null;
  if (platform === "darwin") {
    const MH_BUNDLE = 8;
    const thin = (at) => { const h = read(at, 16); return h && h.readUInt32BE(0) === 0xcffaedfe && h.readUInt32LE(12) === MH_BUNDLE ? h.readUInt32LE(4) : null; };
    const magic = head.readUInt32BE(0);
    if (magic === 0xcffaedfe) { const machine = thin(0); return machine === null ? null : [machine]; }          // 64-bit little-endian Mach-O bundle
    if (magic === 0xcafebabe) {                                                                                  // universal: every slice is checked
      const count = head.readUInt32BE(4);
      if (count < 1 || count > 8) return null;
      const table = read(8, count * 20);
      if (!table) return null;
      const machines = [];
      for (let i = 0; i < count; i++) { const machine = thin(table.readUInt32BE(i * 20 + 8)); if (machine === null || machine !== table.readUInt32BE(i * 20)) return null; machines.push(machine); }
      return machines;
    }
    return null;
  }
  if (platform === "linux") {
    if (!(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46 && head[4] === 2 && head[5] === 1)) return null; // 64-bit little-endian ELF
    const h = read(16, 4);
    return h && h.readUInt16LE(0) === 3 ? [h.readUInt16LE(2)] : null; // ET_DYN
  }
  if (platform === "win32") {
    if (!(head[0] === 0x4d && head[1] === 0x5a)) return null;
    const at = read(0x3c, 4);
    if (!at) return null;
    const offset = at.readUInt32LE(0);
    if (offset < 0x40 || offset + 24 > size) return null;
    const sig = read(offset, 24);
    if (!sig || sig.readUInt32BE(0) !== 0x50450000) return null;
    return (sig.readUInt16LE(22) & 0x2000) !== 0 ? [sig.readUInt16LE(4)] : null; // IMAGE_FILE_DLL
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

/** Windows: the calls that replaced every PowerShell Murage started itself (murage-releases #1), plus the handle calls. A Windows package
 * whose addon lacks one is refused (ENGINE_EXCLUSION_RESOURCE_FUNCTIONS): a missing call must fail the build, never degrade the app.
 * Kept equal to server/engine-exclusion.ts's HANDLE_FUNCTIONS + WINDOWS_NATIVE_FUNCTIONS (engine-exclusion-r20.test.ts). */
export const WINDOWS_ADDON_FUNCTIONS = ["openFile", "handleRead", "handleWrite", "handleSync", "handleLock", "handleMarkDelete", "handleId", "handleSize", "handleClose", "removeTree",
  "authenticode", "jobCreate", "jobAssign", "jobClose", "jobStop", "processStart", "driveInfo", "fileOwnerSid", "accountSid", "machineSid", "domainSids", "speechVoices", "speechToWave"];

/** macOS and Linux: the calls the server makes on top of lock / processes / renameNoReplace (engine-exec.ts writers, engine-fs.ts fullSync,
 * engine-redo.ts bootId). A package whose addon lacks one is refused too. Every export the code calls is on this list or on
 * WINDOWS_ADDON_FUNCTIONS (engine-exclusion-called-exports.test.ts derives the called names from server/ and electron/). */
export const POSIX_ADDON_FUNCTIONS = ["writers", "fullSync", "bootId"];
/** What a package for `platform` must export besides the four every platform answers for. */
export const requiredAddonFunctions = (platform) => (platform === "win32" ? WINDOWS_ADDON_FUNCTIONS : POSIX_ADDON_FUNCTIONS);

/** Loads the addon at `file` for real, with the TARGET package's own runtime, and checks that it answers with the version this build
 * expects, offers its functions and lists this very process among the machine's processes (a stub with a valid header cannot). `binary`
 * is the packaged Electron executable, run as Node (ELECTRON_RUN_AS_NODE=1); a macOS package for the other architecture is run through
 * arch(1) (Rosetta, or the arm64 slice). A package this machine cannot run is NOT passed unchecked: it throws
 * ENGINE_EXCLUSION_RESOURCE_UNTESTED, so the release runs on a machine for each target. `run(command, args, env)` executes and returns
 * the output; it throws when the process fails. Returns "loaded". Throws ENGINE_EXCLUSION_RESOURCE_UNLOADABLE / _VERSION / _UNTESTED. */
export function loadEngineExclusionResource(file, platform, arch, expectedVersion, run, binary, host = { platform: process.platform, arch: process.arch }) {
  if (!binary || typeof run !== "function") throw new Error("ENGINE_EXCLUSION_RESOURCE_UNTESTED");
  const code = "const a=require(process.argv[1]);const l=a.processes();const w=" + JSON.stringify(requiredAddonFunctions(platform)) + ";process.stdout.write(JSON.stringify([a.version(),typeof a.processes,typeof a.lock,typeof a.renameNoReplace,Array.isArray(l)&&l.some(p=>p&&p.pid===process.pid),w.filter(n=>typeof a[n]!==\"function\")]))";
  let command = binary, args = ["-e", code, file];
  if (platform !== host.platform) throw new Error("ENGINE_EXCLUSION_RESOURCE_UNTESTED");
  if (arch !== host.arch) {
    if (platform !== "darwin") throw new Error("ENGINE_EXCLUSION_RESOURCE_UNTESTED");
    command = "/usr/bin/arch"; args = [arch === "x64" ? "-x86_64" : "-arm64", binary, ...args];
  }
  let out;
  try { out = run(command, args, { ELECTRON_RUN_AS_NODE: "1" }); } catch (e) { console.error("engine-exclusion load failed:", JSON.stringify({ command, args, status: e?.status, signal: e?.signal, code: e?.code, stderr: String(e?.stderr ?? "").slice(0, 4000), stdout: String(e?.stdout ?? "").slice(0, 2000), message: String(e?.message ?? "").slice(0, 2000) })); throw new Error("ENGINE_EXCLUSION_RESOURCE_UNLOADABLE"); }
  let answer;
  try { answer = JSON.parse(String(out)); } catch { console.error("engine-exclusion answer unreadable:", JSON.stringify(String(out).slice(0, 4000))); throw new Error("ENGINE_EXCLUSION_RESOURCE_UNLOADABLE"); }
  if (answer[0] !== expectedVersion || answer[1] !== "function" || answer[2] !== "function" || answer[3] !== "function" || answer[4] !== true) throw new Error("ENGINE_EXCLUSION_RESOURCE_VERSION");
  if (!(Array.isArray(answer[5]) && answer[5].length === 0)) { console.error("engine-exclusion addon lacks:", JSON.stringify(answer[5])); throw new Error("ENGINE_EXCLUSION_RESOURCE_FUNCTIONS"); }
  return "loaded";
}
