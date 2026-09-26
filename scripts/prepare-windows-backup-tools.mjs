import { createHash } from "node:crypto";
import { constants, closeSync, copyFileSync, createWriteStream, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import { WINDOWS_BACKUP_ARCHIVE, WINDOWS_BACKUP_RAW_SHA256 } from "../shared/windows-backup-tools.mjs";
import { RESTIC_PINS } from "../shared/backup-restic-pin.mjs";

const maxBytes = 64 * 1024 ** 2;
const members = new Map([["age/age.exe", ["age.exe", WINDOWS_BACKUP_RAW_SHA256.age]], ["age/age-keygen.exe", ["age-keygen.exe", WINDOWS_BACKUP_RAW_SHA256.keygen]], ["age/LICENSE", ["LICENSE", WINDOWS_BACKUP_RAW_SHA256.license]]]);
const unchanged = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1;
function hash(file) {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) throw Error("WINDOWS_BACKUP_RESOURCE_UNSAFE");
  const fd = openSync(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    if (!unchanged(before, fstatSync(fd))) throw Error("WINDOWS_BACKUP_RESOURCE_CHANGED");
    const digest = createHash("sha256"), buffer = Buffer.alloc(65536); let total = 0;
    for (;;) { const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break; total += n; if (total > maxBytes) throw Error("WINDOWS_BACKUP_RESOURCE_LIMIT"); digest.update(buffer.subarray(0, n)); }
    if (!unchanged(before, fstatSync(fd)) || !unchanged(before, lstatSync(file))) throw Error("WINDOWS_BACKUP_RESOURCE_CHANGED");
    return digest.digest("hex");
  } finally { closeSync(fd); }
}
function realDirectory(path) { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("WINDOWS_BACKUP_DIRECTORY_UNSAFE"); }
export function verifyWindowsBackupTools(directory, { restic = true } = {}) {
  realDirectory(directory);
  for (const [name, digest] of members.values()) if (hash(join(directory, name)) !== digest) throw Error(`WINDOWS_BACKUP_RAW_MISMATCH: ${name}`);
  // Off-site copies: the raw upstream restic.exe, never signed or rewritten.
  if (restic && hash(join(directory, RESTIC_PINS["win32-x64"].executable)) !== RESTIC_PINS["win32-x64"].originalSha256) throw Error("WINDOWS_BACKUP_RAW_MISMATCH: restic.exe");
}
async function extract(archive, directory) {
  const zip = await new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip)));
  const seen = new Set(); let inFlight;
  try {
    if (zip.entryCount > 32) throw Error("WINDOWS_BACKUP_ARCHIVE_ENTRIES");
    await new Promise((resolve, reject) => {
      zip.once("error", reject); zip.once("end", resolve);
      zip.on("entry", entry => {
        inFlight = (async () => {
          const target = members.get(entry.fileName);
          if (target) {
            const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (seen.has(entry.fileName) || (mode && mode !== 0o100000) || (entry.externalFileAttributes & 0x10) || entry.isEncrypted() || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 1 || entry.uncompressedSize > maxBytes) throw Error("WINDOWS_BACKUP_ARCHIVE_ENTRY_UNSAFE");
            seen.add(entry.fileName);
            const input = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
            let bytes = 0;
            const bound = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; done(bytes > maxBytes ? Error("WINDOWS_BACKUP_ARCHIVE_LIMIT") : null, chunk); } });
            await pipeline(input, bound, createWriteStream(join(directory, target[0]), { flags: "wx", mode: 0o600 }));
            if (bytes !== entry.uncompressedSize) throw Error("WINDOWS_BACKUP_ARCHIVE_SIZE");
          }
          zip.readEntry();
        })().catch(error => { zip.close(); reject(error); });
      });
      zip.readEntry();
    });
    if (seen.size !== members.size) throw Error("WINDOWS_BACKUP_ARCHIVE_INCOMPLETE");
  } finally { zip.close(); await inFlight?.catch(() => {}); }
}
/** Explicit Windows build preparation only. Never executes or signs a tool. */
export async function stageWindowsBackupTools({ root = fileURLToPath(new URL("../", import.meta.url)), archive } = {}) {
  const output = join(root, "dist-native", "backup-tools", "win32-x64");
  realDirectory(root);
  for (const parent of [join(root, "dist-native"), join(root, "dist-native", "backup-tools"), output]) {
    if (existsSync(parent)) realDirectory(parent); else mkdirSync(parent);
  }
  for (const [name, digest] of members.values()) if (existsSync(join(output, name)) && hash(join(output, name)) !== digest) throw Error("WINDOWS_BACKUP_RESOURCE_COLLISION");
  if ([...members.values()].every(([name]) => existsSync(join(output, name)))) { verifyWindowsBackupTools(output, { restic: false }); return output; }
  const scratch = mkdtempSync(join(tmpdir(), "murage-windows-age-stage-"));
  try {
    const input = archive ?? join(scratch, "age.zip");
    if (!archive) {
      const response = await fetch(WINDOWS_BACKUP_ARCHIVE.url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok || !response.body) throw Error("WINDOWS_BACKUP_DOWNLOAD_FAILED");
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > maxBytes) throw Error("WINDOWS_BACKUP_DOWNLOAD_LIMIT"); chunks.push(chunk); }
      writeFileSync(input, Buffer.concat(chunks), { flag: "wx", mode: 0o600 });
    }
    if (hash(input) !== WINDOWS_BACKUP_ARCHIVE.sha256) throw Error("WINDOWS_BACKUP_ARCHIVE_MISMATCH");
    await extract(input, scratch); verifyWindowsBackupTools(scratch, { restic: false });
    for (const [name] of members.values()) if (!existsSync(join(output, name))) copyFileSync(join(scratch, name), join(output, name), constants.COPYFILE_EXCL);
    verifyWindowsBackupTools(output, { restic: false }); return output;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw Error("WINDOWS_BACKUP_STAGE_ARGUMENTS");
  await stageWindowsBackupTools({ archive: process.argv[2] });
}
