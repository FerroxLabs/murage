// WIN-BACKUP-RT-1018: the one test that takes a real encrypted backup on
// Windows all the way back. Every other Windows backup test mocks the helper
// transport, the resolver or spawn (installation-windows-backup-operations.test.ts),
// and the age round trips skip on Windows (no pin in backup-age-pins.mjs).
//
// Real here: the product's own Windows resolver (hash-pins age.exe / age-keygen.exe
// / LICENSE, held-file checks, folder ancestry), the native helper
// murage-backup-age.exe, the pinned age.exe, the real encrypt, readback, restore.
// Injected: ONLY the Authenticode check (a CI runner has no signed installed app),
// through the test seam in installation-backup-encryption.ts, plus a fixture
// resources folder laid out like an install.
//
// MURAGE_TEST_WIN_BACKUP_TOOLS names the folder holding murage-backup-age.exe, age.exe,
// age-keygen.exe and LICENSE (CI builds the helper and fetches the pinned age).
// MURAGE_TEST_REQUIRE_WIN_BACKUP_RT=1 turns "not configured" into a failure, so the CI
// job can never pass by skipping. MURAGE_TEST_RT_MUTANT=ciphertext flips one ciphertext byte
// before the genuine restore; =alter / =drop change or remove one restored workspace file after a
// successful restore. Each must turn the positive test red (see the mutant note in that test).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setWindowsBackupRuntimeTestSeam } from "./installation-backup-encryption.ts";
import { restoreEncryptedInstallationNew, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { backupFixture } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { expectRestoredByMeaning, meaningOf } from "./testing/restored-by-meaning.ts";

const toolsSource = process.env.MURAGE_TEST_WIN_BACKUP_TOOLS;
const enabled = process.platform === "win32" && process.arch === "x64" && Boolean(toolsSource);
const required = process.env.MURAGE_TEST_REQUIRE_WIN_BACKUP_RT === "1";
const TOOL_FILES = ["murage-backup-age.exe", "age.exe", "age-keygen.exe", "LICENSE"];
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function digestTree(root: string, relative = "", into = new Map<string, string>()) {
  for (const name of readdirSync(join(root, relative)).sort()) {
    const next = relative ? `${relative}/${name}` : name;
    const stat = lstatSync(join(root, next));
    if (stat.isDirectory()) digestTree(root, next, into);
    else if (stat.isFile()) into.set(next, sha256(readFileSync(join(root, next))));
  }
  return into;
}
/** SQLite sidecars are not reproduced by a restore (the snapshot checkpoints the WAL). */
const SIDECAR = /\.db-(wal|shm)$/;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); setWindowsBackupRuntimeTestSeam(null); });

function install() {
  const original = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-win-rt-")));
  const root = join(dirname(original), original.slice(dirname(original).length + 1).toLowerCase());
  if (original !== root) renameSync(original, root);
  roots.push(root);
  const app = join(root, "installed"), resources = join(app, "resources"), tools = join(resources, "backup-tools", "x64");
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(app, "Murage.exe"), Buffer.from("MZ murage fixture executable\n"));
  for (const file of TOOL_FILES) copyFileSync(join(toolsSource!, file), join(tools, file));
  setWindowsBackupRuntimeTestSeam({
    host: { resourcesPath: resources, currentExecutable: join(app, "Murage.exe") },
  });
  const keygen = join(tools, "age-keygen.exe");
  const identity = execFileSync(keygen, [], { encoding: "utf8", env: { PATH: "" }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4096 });
  const recipient = execFileSync(keygen, ["-y"], { input: identity, encoding: "utf8", env: { PATH: "" }, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 4096 }).trim();
  return { root, age: join(tools, "age.exe"), identity, recipient };
}

async function backUp() {
  const rig = install();
  const fixture = backupFixture(); roots.push(fixture.parent);
  const live = Buffer.concat([Buffer.from("# Deal desk - do not lose this\n"), Buffer.from("0123456789abcdef".repeat(4096))]);
  mkdirSync(join(fixture.data, "workspaces"), { recursive: true });
  writeFileSync(join(fixture.data, "workspaces", "live-deal.md"), live);
  fixture.db.close();
  const destination = join(fixture.parent, "backups"); mkdirSync(destination);
  const options = { ageExecutable: rig.age, identity: rig.identity, recipient: rig.recipient,
    selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const };
  const written = await writeEncryptedInstallationBackup(fixture.data, join(destination, "backup.age"), options);
  return { rig, fixture, options, written, live };
}

describe("Windows: a real encrypted backup restores byte for byte", () => {
  it.skipIf(!required)("is configured on the CI runner (cannot pass by skipping)", () => {
    expect(enabled).toBe(true);
  });

  it.skipIf(!enabled)("encrypts with the pinned age.exe through the native helper, restores to a new location, and every byte matches", { timeout: 300_000 }, async () => {
    const { fixture, options, written, live } = await backUp();
    const before = digestTree(fixture.data);
    const meaning = meaningOf(fixture.data);
    expect(before.get("workspaces/live-deal.md")).toBe(sha256(live));
    // Mutants (each must turn this test red; CI runs them, a normal run sets none):
    //   ciphertext: flip a byte of the archive, so the genuine restore refuses it;
    //   alter / drop: restore succeeds, then ONE restored workspace file is altered or removed,
    //   so only the byte compare below can notice (not a decrypt error).
    const mutant = process.env.MURAGE_TEST_RT_MUTANT;
    if (mutant === "ciphertext" || mutant === "1") {
      const bytes = readFileSync(written.path); bytes[Math.floor(bytes.length / 2)] ^= 0xff; writeFileSync(written.path, bytes);
    }
    const target = join(fixture.parent, "restored-installation");
    await restoreEncryptedInstallationNew(target, written.path, written.sha256, options);
    const restoredLive = join(target, "workspaces", "live-deal.md");
    if (mutant === "alter") { const bytes = readFileSync(restoredLive); bytes[bytes.length - 1] ^= 0x01; writeFileSync(restoredLive, bytes); }
    if (mutant === "drop") rmSync(restoredLive);
    const after = digestTree(target);
    // The owner's own files (everything that is not a settings document or database) come back byte for byte,
    // as in server/backup-restore-roundtrip.test.ts:183-185.
    const opaque = [...before.keys()].filter(file => !/\.(json|db)$/.test(file) && !SIDECAR.test(file));
    expect(opaque, "the fixture must hold opaque user content to prove byte fidelity with").toEqual(["workspaces/live-deal.md", "workspaces/report.md"]);
    for (const file of opaque) expect(after.get(file), `${file} did not come back byte for byte`).toBe(before.get(file));
    expect(readFileSync(restoredLive).equals(live)).toBe(true);
    // Settings and the database are rewritten by restore (safe, paused form): checked by meaning, never skipped.
    expectRestoredByMeaning(meaning, target);
  });

  it.skipIf(!enabled)("refuses a backup with one corrupted ciphertext byte and restores nothing", { timeout: 300_000 }, async () => {
    const { fixture, options, written } = await backUp();
    const bytes = readFileSync(written.path); bytes[Math.floor(bytes.length / 2)] ^= 0xff; writeFileSync(written.path, bytes);
    const target = join(fixture.parent, "restored-installation");
    // The caller passes the corrupted file own hash, so the archive-hash gate passes and the refusal must come from the real decrypt.
    const refusal = await restoreEncryptedInstallationNew(target, written.path, sha256(bytes), options).then(() => null, (error: unknown) => error as { code?: unknown });
    expect(refusal, "a corrupted archive must be refused").not.toBeNull();
    expect(typeof refusal!.code, "the refusal carries a named code").toBe("string");
    expect(refusal!.code, "refused by the decrypt, not by the hash gate").not.toMatch(/^ARCHIVE_HASH/);
    expect(() => lstatSync(target)).toThrow();
  });
});
