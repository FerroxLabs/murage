// Read-only pinned native fixtures. Packaging stages these under dist-native;
// the offline release gate mounts the same assets beside its age tool directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKUP_AGE_PINS } from "../shared/backup-age-pins.mjs";
import { RESTIC_PINS } from "../shared/backup-restic-pin.mjs";

export function backupNativeFixture(name) {
  const pin = { age: BACKUP_AGE_PINS["darwin-arm64"], restic: RESTIC_PINS["darwin-arm64"] }[name];
  assert.ok(pin, "known pinned native fixture");
  const relative = path.join(`backup-${name}`, "arm64", name);
  const candidates = [
    ...(name === "age" && process.env.MURAGE_BACKUP_TEST_AGE_FILE ? [process.env.MURAGE_BACKUP_TEST_AGE_FILE] : []),
    fileURLToPath(new URL(`../dist-native/backup-${name}/arm64/${name}`, import.meta.url)),
    ...(process.env.MURAGE_BACKUP_TEST_AGE_DIR ? [path.resolve(process.env.MURAGE_BACKUP_TEST_AGE_DIR, "..", relative)] : []),
  ];
  const file = candidates.find(candidate => existsSync(candidate));
  assert.ok(file, `Missing pinned ${name} fixture: stage dist-native or provide the offline runtime beside MURAGE_BACKUP_TEST_AGE_DIR`);
  assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), name === "age" ? pin.executableSha256 : pin.originalSha256, `Actual pinned ${name} fixture required`);
  return file;
}
