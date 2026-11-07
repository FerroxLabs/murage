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
// job can never pass by skipping. MURAGE_TEST_RT_MUTANT=1 flips one ciphertext byte
// before the genuine restore; the positive test must then go red.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setWindowsBackupRuntimeTestSeam } from "./installation-backup-encryption.ts";
import { restoreEncryptedInstallationNew, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { backupFixture } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

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
afterEach(() => { setWindowsBackupRuntimeTestSeam(null); for (const root of roots.splice(0)) removeTempDirSync(root); });

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
    overrides: { verifySignatures: async () => {}, nativeAuthenticode: () => null },
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
    expect(before.get("workspaces/live-deal.md")).toBe(sha256(live));
    if (process.env.MURAGE_TEST_RT_MUTANT === "1") {
      const bytes = readFileSync(written.path); bytes[Math.floor(bytes.length / 2)] ^= 0xff; writeFileSync(written.path, bytes);
    }
    const target = join(fixture.parent, "restored-installation");
    await restoreEncryptedInstallationNew(target, written.path, written.sha256, options);
    const after = digestTree(target);
    for (const [file, digest] of before) {
      if (SIDECAR.test(file)) continue;
      expect(after.get(file), `restored ${file}`).toBe(digest);
    }
    expect(after.get("workspaces/live-deal.md")).toBe(sha256(live));
    expect(readFileSync(join(target, "workspaces", "live-deal.md")).equals(live)).toBe(true);
  });

  it.skipIf(!enabled)("refuses a backup with one corrupted ciphertext byte and restores nothing", { timeout: 300_000 }, async () => {
    const { fixture, options, written } = await backUp();
    const bytes = readFileSync(written.path); bytes[Math.floor(bytes.length / 2)] ^= 0xff; writeFileSync(written.path, bytes);
    const target = join(fixture.parent, "restored-installation");
    await expect(restoreEncryptedInstallationNew(target, written.path, sha256(bytes), options)).rejects.toBeTruthy();
    expect(() => lstatSync(target)).toThrow();
  });
});
