// Read-only verification for pre-staged host age tools. No download path.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backupAgePinForTarget } from "../shared/backup-age-pins.mjs";

export function backupTestToolPin() {
  const pin = backupAgePinForTarget(process.platform, process.arch);
  if (!pin || [pin.archiveSha256, pin.executableSha256, pin.keygenSha256].some(hash => !/^[a-f0-9]{64}$/.test(hash ?? ""))) {
    throw Error(`BACKUP_TEST_FIXTURE_PIN_MISSING: ${process.platform}-${process.arch}`);
  }
  return pin;
}

export function verifyBackupTestFixtureTools(toolDirectory) {
  const pin = backupTestToolPin();
  if (!toolDirectory || !path.isAbsolute(toolDirectory)) {
    throw Error("BACKUP_TEST_FIXTURE_CACHE_REQUIRED: set MURAGE_BACKUP_TEST_AGE_DIR to an absolute pre-staged cache directory");
  }
  const directory = path.resolve(toolDirectory);
  for (const [name, hash] of [["age", pin.executableSha256], ["age-keygen", pin.keygenSha256]]) {
    const file = path.join(directory, name);
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch (cause) {
      throw Error(`BACKUP_TEST_FIXTURE_CACHE_MISSING: ${file}; stage with node scripts/prepare-backup-test-fixtures.mjs --cache-directory <absolute-directory>`, { cause });
    }
    if (createHash("sha256").update(bytes).digest("hex") !== hash) {
      throw Error(`BACKUP_TEST_FIXTURE_CACHE_MISMATCH: ${file}; restore the pinned fixture before running tests`);
    }
  }
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw Error("BACKUP_TEST_FIXTURE_ARGUMENTS_INVALID: expected one cache directory");
    process.stdout.write(`${verifyBackupTestFixtureTools(process.argv[2])}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
