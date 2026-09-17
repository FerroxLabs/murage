// Test-only staging of the hash-pinned upstream backup tools that the Node and
// Vitest suites read or execute. Packaging keeps using prepare-backup-age.mjs
// and prepare-backup-restic.mjs; nothing here is shipped.
//
// Stages, on every host:
//   dist-native/backup-age/arm64/age        pinned darwin-arm64 age (payload fixture)
//   dist-native/backup-restic/arm64/restic  pinned darwin-arm64 restic (payload fixture)
// and, with --tool-directory on a host that has an age pin (darwin-arm64,
// linux-x64), that host's age and age-keygen for MURAGE_BACKUP_TEST_AGE_DIR.
// The environment assignment is printed on stdout so CI can append it to
// $GITHUB_ENV.
//
// Every archive and every extracted byte is checked against shared pins before
// it is written, so the decompressor's provenance does not matter: tar.gz is
// read in-process, and bzip2 is /usr/bin/bzip2 on POSIX or the first bzip2.exe
// on PATH on Windows (Git for Windows provides one on GitHub runners).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { BACKUP_AGE_PINS, backupAgePinForTarget } from "../shared/backup-age-pins.mjs";
import { RESTIC_ARCHIVE_SHA256, RESTIC_ARCHIVE_URL, RESTIC_ORIGINAL_SHA256 } from "../shared/backup-restic-pin.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const LIMIT = 64 * 1024 ** 2;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const refuse = code => { throw Error(code); };

async function download(url, expectedSha256) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) refuse("BACKUP_TEST_FIXTURE_DOWNLOAD_FAILED");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > LIMIT) refuse("BACKUP_TEST_FIXTURE_DOWNLOAD_LIMIT"); chunks.push(Buffer.from(chunk)); }
  const bytes = Buffer.concat(chunks);
  if (sha256(bytes) !== expectedSha256) refuse("BACKUP_TEST_FIXTURE_ARCHIVE_MISMATCH");
  return bytes;
}

/** Regular-file members of an uncompressed ustar/GNU tar, by exact name. */
export function tarMembers(tar, wanted) {
  const found = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString("latin1").replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 136).trim() || "0", 8), type = field(156, 157) || "0";
    const prefix = field(257, 263).startsWith("ustar") ? field(345, 500) : "";
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) refuse("BACKUP_TEST_FIXTURE_ARCHIVE_INVALID");
    if (wanted.includes(name)) {
      if (type !== "0" || found.has(name)) refuse("BACKUP_TEST_FIXTURE_ARCHIVE_INVALID");
      found.set(name, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (wanted.some(name => !found.has(name))) refuse("BACKUP_TEST_FIXTURE_ARCHIVE_INVALID");
  return found;
}

function bzip2Executable() {
  if (process.platform !== "win32") return "/usr/bin/bzip2";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = directory && path.join(directory, "bzip2.exe");
    if (candidate && path.isAbsolute(candidate) && existsSync(candidate)) return candidate;
  }
  return refuse("BACKUP_TEST_FIXTURE_BZIP2_UNAVAILABLE");
}

function place(file, bytes, expectedSha256) {
  if (sha256(bytes) !== expectedSha256) refuse("BACKUP_TEST_FIXTURE_PAYLOAD_MISMATCH");
  if (existsSync(file)) {
    if (sha256(readFileSync(file)) !== expectedSha256) refuse("BACKUP_TEST_FIXTURE_EXISTING_MISMATCH");
  } else {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o755 });
    renameSync(temporary, file);
  }
  chmodSync(file, 0o755);
  return file;
}

async function ageMembers(pin, names) {
  const archive = await download(pin.url, pin.archiveSha256);
  return tarMembers(gunzipSync(archive, { maxOutputLength: 4 * LIMIT }), names.map(name => `age/${name}`));
}

export async function stageBackupTestFixtures({ root = repository, toolDirectory } = {}) {
  const darwin = BACKUP_AGE_PINS["darwin-arm64"];
  const darwinMembers = await ageMembers(darwin, ["age"]);
  place(path.join(root, "dist-native", darwin.stagingDirectory, darwin.arch, "age"), darwinMembers.get("age/age"), darwin.executableSha256);

  const compressed = await download(RESTIC_ARCHIVE_URL, RESTIC_ARCHIVE_SHA256);
  const restic = execFileSync(bzip2Executable(), ["-dc"], { input: compressed, stdio: ["pipe", "pipe", "pipe"], timeout: 60_000, maxBuffer: LIMIT });
  place(path.join(root, "dist-native", "backup-restic", "arm64", "restic"), restic, RESTIC_ORIGINAL_SHA256);

  if (toolDirectory === undefined) return null;
  if (!path.isAbsolute(toolDirectory)) refuse("BACKUP_TEST_FIXTURE_TOOL_DIRECTORY_INVALID");
  const host = backupAgePinForTarget(process.platform, process.arch);
  if (!host) return null;
  const members = await ageMembers(host, ["age", "age-keygen"]);
  place(path.join(toolDirectory, "age"), members.get("age/age"), host.executableSha256);
  place(path.join(toolDirectory, "age-keygen"), members.get("age/age-keygen"), host.keygenSha256);
  return toolDirectory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || (args.length === 2 && args[0] === "--tool-directory"))) refuse("BACKUP_TEST_FIXTURE_ARGUMENTS_INVALID");
  const staged = await stageBackupTestFixtures({ toolDirectory: args[1] });
  if (staged) process.stdout.write(`MURAGE_BACKUP_TEST_AGE_DIR=${staged}\n`);
}
