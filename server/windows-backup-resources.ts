import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { win32 } from "node:path";
import { verifyWindowsBrowserSignatures } from "./browser-windows-identity.ts";
import { InstallationSnapshotError } from "./installation-database-snapshot.ts";
import { WINDOWS_BACKUP_RAW_SHA256 } from "../shared/windows-backup-tools.mjs";

// Provenance pins only. These do not add Windows to platform admission.
export { WINDOWS_BACKUP_RAW_SHA256 } from "../shared/windows-backup-tools.mjs";
const fail = (): never => { throw new InstallationSnapshotError("AGE_TOOL_UNVERIFIED"); };
const regular = (stat: BigIntStats, maxBytes: number) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(maxBytes);
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function hashDescriptor(fd: number, maxBytes: number) {
  const hash = createHash("sha256"), buffer = Buffer.alloc(65536); let offset = 0;
  for (;;) {
    const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes - offset + 1), offset);
    if (!bytes) break;
    offset += bytes; if (offset > maxBytes) fail(); hash.update(buffer.subarray(0, bytes));
  }
  return hash.digest("hex");
}
export interface WindowsBackupFileObservation {
  readonly sha256: string;
  assertUnchanged(): void;
  close(): void;
}

/** Bounded held-file observation. Windows lstat/fstat checks do not claim an
 * atomic no-follow open or a native deny-write lease; those are transport gates. */
export function observeWindowsBackupFile(path: string, maxBytes: number): WindowsBackupFileObservation {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024 ** 2) fail();
  const before = lstatSync(path, { bigint: true }); if (!regular(before, maxBytes)) fail();
  const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  let closed = false;
  const close = () => { if (!closed) { closeSync(fd); closed = true; } };
  try {
    const opened = fstatSync(fd, { bigint: true }); if (!regular(opened, maxBytes) || !sameFile(before, opened)) fail();
    const sha256 = hashDescriptor(fd, maxBytes);
    if (!sameFile(before, fstatSync(fd, { bigint: true })) || !sameFile(before, lstatSync(path, { bigint: true }))) fail();
    const assertUnchanged = () => {
      if (closed) fail();
      const held = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
      if (!regular(held, maxBytes) || !regular(named, maxBytes) || !sameFile(before, held) || !sameFile(before, named)) fail();
      if (hashDescriptor(fd, maxBytes) !== sha256 || !sameFile(before, fstatSync(fd, { bigint: true })) || !sameFile(before, lstatSync(path, { bigint: true }))) fail();
    };
    return { sha256, assertUnchanged, close };
  } catch { close(); return fail(); }
}

export interface WindowsBackupResourceDependencies {
  platform: NodeJS.Platform;
  arch: string;
  lstat(path: string): BigIntStats;
  realpath(path: string): string;
  observeFile(path: string, maxBytes: number): WindowsBackupFileObservation;
  verifySignatures(files: string[]): Promise<void>;
}
const defaults: WindowsBackupResourceDependencies = {
  platform: process.platform, arch: process.arch,
  // Native realpath: this module only runs on Windows, and the JavaScript one
  // keeps the spelling it was given — so an 8.3 path such as
  // C:\PROGRA~1\Murage\resources\backup-tools compared equal to itself and
  // passed the "already canonical, no junction on the way" check below.
  lstat: path => lstatSync(path, { bigint: true }), realpath: realpathSync.native,
  observeFile: observeWindowsBackupFile,
  verifySignatures: files => verifyWindowsBrowserSignatures(files, process.env.SystemRoot),
};
const equalPath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function canonicalDosPath(path: string) {
  if (typeof path !== "string" || !/^[A-Za-z]:\\/.test(path) || path.length <= 3 || path.length > 8192 || !equalPath(win32.normalize(path), path)) fail();
  for (const component of path.slice(3).split("\\")) {
    if (!component || component.length > 255 || /[\x00-\x1f\x7f\\/:*?"<>|]/.test(component) || /[ .]$/.test(component) ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(?:\.|$)/i.test(component)) fail();
  }
  return path;
}
function ancestry(path: string): string[] {
  const result: string[] = [];
  for (let current = path; ; current = win32.dirname(current)) {
    result.unshift(current); if (win32.dirname(current) === current) return result;
  }
}

/** Trusted-host inputs only. No renderer executable/options, standalone Node
 * fallback, PE normalization or signature mutation is admitted here. */
export function createWindowsBackupResourceResolver(
  host: { resourcesPath: string; currentExecutable?: string },
  overrides: Partial<WindowsBackupResourceDependencies> = {},
): () => Promise<{ executable: string }> {
  const io = { ...defaults, ...overrides };
  return async () => {
    const opened: WindowsBackupFileObservation[] = [];
    try {
      if (io.platform !== "win32" || io.arch !== "x64") throw new InstallationSnapshotError("AGE_TOOL_PLATFORM_UNQUALIFIED");
      const resources = canonicalDosPath(host.resourcesPath), current = canonicalDosPath(host.currentExecutable ?? process.execPath);
      if (win32.basename(resources).toLowerCase() !== "resources") fail();
      const app = win32.join(win32.dirname(resources), "Murage.exe"); if (!equalPath(current, app)) fail();
      const tools = win32.join(resources, "backup-tools", "x64"), executable = win32.join(tools, "murage-backup-age.exe");
      const directories = ancestry(tools).map(path => {
        const stat = io.lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !equalPath(io.realpath(path), path)) fail();
        return { path, stat };
      });
      const files = [
        { path: app, max: 512 * 1024 ** 2 },
        { path: executable, max: 64 * 1024 ** 2 },
        { path: win32.join(tools, "age.exe"), max: 64 * 1024 ** 2, sha256: WINDOWS_BACKUP_RAW_SHA256.age },
        { path: win32.join(tools, "age-keygen.exe"), max: 64 * 1024 ** 2, sha256: WINDOWS_BACKUP_RAW_SHA256.keygen },
        { path: win32.join(tools, "LICENSE"), max: 1024 ** 2, sha256: WINDOWS_BACKUP_RAW_SHA256.license },
      ];
      for (const file of files) {
        if (!equalPath(io.realpath(file.path), file.path)) fail();
        const observed = io.observeFile(file.path, file.max); opened.push(observed);
        if (file.sha256 && observed.sha256 !== file.sha256) fail();
      }
      // Signature verifier is generic; its separate browser PE normalizer is not used.
      // Raw upstream age/keygen bytes must remain untouched by Windows signing.
      await io.verifySignatures([app, executable]);
      for (const observed of opened) observed.assertUnchanged();
      for (const { path, stat } of directories) {
        const after = io.lstat(path);
        if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || !equalPath(io.realpath(path), path)) fail();
      }
      for (const file of files) if (!equalPath(io.realpath(file.path), file.path)) fail();
      return { executable };
    } catch (error) {
      if (error instanceof InstallationSnapshotError && error.code === "AGE_TOOL_PLATFORM_UNQUALIFIED") throw error;
      return fail();
    } finally {
      let closeFailed = false;
      for (const file of opened.reverse()) { try { file.close(); } catch { closeFailed = true; } }
      if (closeFailed) fail();
    }
  };
}
