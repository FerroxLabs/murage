// WIN-BACKUP-RT-1018: the one test that takes a real encrypted backup on
// Windows all the way back. Every other Windows backup test mocks the helper
// transport, the resolver or spawn (installation-windows-backup-operations.test.ts),
// and the age round trips skip on Windows (no pin in backup-age-pins.mjs).
//
// Real here: the product's own Windows resolver (hash-pins age.exe / age-keygen.exe
// / LICENSE, held-file checks, folder ancestry), its elevation check, the native
// helper murage-backup-age.exe, the pinned age.exe, the real encrypt, readback, restore.
// Injected: ONLY the Authenticode check (a CI runner has no signed installed app),
// through the test seam in installation-backup-encryption.ts, plus a fixture
// resources folder laid out like an install.
//
// The helper refuses an elevated token (native/backup-age/transport.cpp:134, exit 72),
// as the product does for a person who started Murage with Run as administrator. The
// hosted runner's own account is an elevated administrator, so CI runs THIS file alone
// as a local standard user it creates (ci.yml, "Round trip as a standard Windows user"),
// and the first test asserts that precondition. The elevated side has its own test,
// installation-windows-backup-elevated.test.ts, in the ordinary Windows shard.
//
// MURAGE_TEST_WIN_BACKUP_TOOLS names the folder holding murage-backup-age.exe, age.exe,
// age-keygen.exe and LICENSE (CI builds the helper and fetches the pinned age).
// MURAGE_TEST_REQUIRE_WIN_BACKUP_RT=1 turns "not configured" into a failure, so the CI
// job can never pass by skipping.
//
// Mutants: MURAGE_TEST_RT_MUTANT=<name> breaks one thing and the positive test must then fail. The normal CI
// job sets none. They are exercised by throwaway CI branches that set the variable (the workflow does not),
// one run per mutant, each expected RED for the reason named here:
//   ciphertext   flip one byte of the archive, so the genuine restore refuses it (decrypt);
//   alter        change one byte of a restored workspace file (byte compare);
//   drop         remove a restored workspace file (file set / byte compare);
//   dropgroups   remove the restored groups.json (file set; it is not a rewritten file);
//   stray        add an unexpected file to the restored tree (file set, other direction);
//   memorymeta   empty the restored memory_meta table (row compare);
//   cursor       put a native resume cursor back into the restored bots.json (exact cursor check);
//   instances    empty the restored config.json instances (deep equal).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setWindowsBackupRuntimeTestSeam } from "./installation-backup-encryption.ts";
import { restoreEncryptedInstallationNew, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { backupFixture } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { expectRestoredByMeaning, meaningOf, seedPreservedSettings } from "./testing/restored-by-meaning.ts";
import { readWindowsTokenElevation } from "./windows-token-elevation.ts";

const toolsSource = process.env.MURAGE_TEST_WIN_BACKUP_TOOLS;
const enabled = process.platform === "win32" && process.arch === "x64" && Boolean(toolsSource);
const required = process.env.MURAGE_TEST_REQUIRE_WIN_BACKUP_RT === "1";
const TOOL_FILES = ["murage-backup-age.exe", "age.exe", "age-keygen.exe", "LICENSE"];
/** By its full path: the vitest setup scrubs PATH-like state, and the token must not depend on PATH. */
const WHOAMI = "C:\\Windows\\System32\\whoami.exe";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path: string) => sha256(readFileSync(path));

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); setWindowsBackupRuntimeTestSeam(null); });

// The token this file runs under, read with whoami.exe by its full path: High Mandatory Level (S-1-16-12288) is an
// elevated token, Medium (S-1-16-8192) a standard one. Printed for the job log and asserted below.
let token: "elevated" | "not elevated" | "unknown" = "unknown";
beforeAll(() => {
  if (!enabled) return;
  try {
    const groups = execFileSync(WHOAMI, ["/groups"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    token = groups.includes("S-1-16-12288") ? "elevated" : groups.includes("S-1-16-8192") ? "not elevated" : "unknown";
    console.info(`WINRT_TOKEN_ELEVATED=${token === "elevated"} (${token}; whoami.exe: High S-1-16-12288 ${groups.includes("S-1-16-12288") ? "present" : "absent"}, Medium S-1-16-8192 ${groups.includes("S-1-16-8192") ? "present" : "absent"}; product check says ${String(readWindowsTokenElevation())})`);
  } catch (error) { console.info(`WINRT_TOKEN_ELEVATED=unknown (${String(error)})`); }
});

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
  expect(token, "precondition: a standard (not elevated) Windows token").toBe("not elevated");
  const rig = install();
  const fixture = backupFixture(); roots.push(fixture.parent);
  const live = Buffer.concat([Buffer.from("# Deal desk - do not lose this\n"), Buffer.from("0123456789abcdef".repeat(4096))]);
  mkdirSync(join(fixture.data, "workspaces"), { recursive: true });
  writeFileSync(join(fixture.data, "workspaces", "live-deal.md"), live);
  seedPreservedSettings(fixture.data, fixture.db);
  fixture.db.close();
  const destination = join(fixture.parent, "backups"); mkdirSync(destination);
  const options = { ageExecutable: rig.age, identity: rig.identity, recipient: rig.recipient,
    selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const };
  const written = await writeEncryptedInstallationBackup(fixture.data, join(destination, "backup.age"), options);
  return { rig, fixture, options, written, live };
}

describe("Windows: a real encrypted backup restores, byte for byte where it must and by meaning where restore rewrites", () => {
  it.skipIf(!required)("is configured on the CI runner (cannot pass by skipping)", () => {
    expect(enabled).toBe(true);
  });

  it.skipIf(!required)("runs as a standard Windows user, not elevated (precondition: the helper refuses an elevated token)", () => {
    expect(token, "whoami.exe shows a Medium, not a High, mandatory level").toBe("not elevated");
    expect(readWindowsTokenElevation(), "the product's own elevation check agrees").toBe(false);
  });

  it.skipIf(!enabled)("encrypts with the pinned age.exe through the native helper, restores to a new location, and the restored tree is exactly what restore must produce", { timeout: 300_000 }, async () => {
    const { fixture, options, written, live } = await backUp();
    const meaning = meaningOf(fixture.data);
    const sourceHashes = new Map(meaning.files.map(file => [file, fileHash(join(fixture.data, file))]));
    expect(sourceHashes.get("workspaces/live-deal.md")).toBe(sha256(live));
    // The helper and age.exe really ran: the archive on disk is age's own format, is not the plaintext, and its hash is the receipt's.
    const archive = readFileSync(written.path);
    expect(archive.subarray(0, 21).toString("latin1"), "age.exe wrote an age archive").toBe("age-encryption.org/v1");
    expect(archive.includes(Buffer.from("Deal desk - do not lose this")), "the archive does not hold the plaintext").toBe(false);
    expect(sha256(archive), "the receipt hash is the archive's hash").toBe(written.sha256);
    const mutant = process.env.MURAGE_TEST_RT_MUTANT;
    if (mutant) console.info(`WINRT_MUTANT=${mutant}`);
    if (mutant === "ciphertext") {
      const bytes = readFileSync(written.path); bytes[Math.floor(bytes.length / 2)] ^= 0xff; writeFileSync(written.path, bytes);
    }
    const target = join(fixture.parent, "restored-installation");
    const result = await restoreEncryptedInstallationNew(target, written.path, mutant === "ciphertext" ? sha256(readFileSync(written.path)) : written.sha256, options);
    expect(result.status, "the restore reports success").toBe("restored-review-required");
    expect(result.encryptedSha256, "the restore read the archive that was written").toBe(written.sha256);
    // Post-restore mutants: each damages the restored tree in one way the strict comparison must notice.
    const live2 = join(target, "workspaces", "live-deal.md");
    if (mutant === "alter") { const bytes = readFileSync(live2); bytes[bytes.length - 1] ^= 0x01; writeFileSync(live2, bytes); }
    if (mutant === "drop") rmSync(live2);
    if (mutant === "dropgroups") rmSync(join(target, "groups.json"));
    if (mutant === "stray") writeFileSync(join(target, "stray.txt"), "not from the backup\n");
    if (mutant === "memorymeta") { const db = new DatabaseSync(join(target, "messages.db")); try { db.exec("DELETE FROM memory_meta"); } finally { db.close(); } }
    if (mutant === "cursor") {
      const file = join(target, "bots.json"), bots = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>[];
      bots[0].resumeCursors = { fixture: "native-cursor" }; writeFileSync(file, JSON.stringify(bots) + "\n");
    }
    if (mutant === "instances") {
      const file = join(target, "config.json"), config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      config.instances = {}; writeFileSync(file, JSON.stringify(config) + "\n");
    }
    // Default-strict: every file not named as rewritten is byte-equal; the rewritten documents, every database
    // table and the two marker files are compared in full against the expected form (see restored-by-meaning.ts).
    expectRestoredByMeaning(meaning, fixture.data, target, result, file => {
      expect(fileHash(join(target, file)), `${file} did not come back byte for byte`).toBe(sourceHashes.get(file));
    });
    expect(readFileSync(live2).equals(live)).toBe(true);
  });

  it.skipIf(!enabled)("refuses a backup with one corrupted ciphertext byte and restores nothing", { timeout: 300_000 }, async () => {
    const { fixture, options, written } = await backUp();
    const bytes = readFileSync(written.path); bytes[Math.floor(bytes.length / 2)] ^= 0xff; writeFileSync(written.path, bytes);
    const target = join(fixture.parent, "restored-installation");
    // The caller passes the corrupted file's own hash, so the archive-hash gate passes and the refusal must come from the real decrypt.
    const refusal = await restoreEncryptedInstallationNew(target, written.path, sha256(bytes), options).then(() => null, (error: unknown) => error as { code?: unknown });
    expect(refusal, "a corrupted archive must be refused").not.toBeNull();
    expect(refusal!.code, "refused by the decrypt (age.exe exited non-zero), as in installation-backup-encryption.test.ts:19").toBe("AGE_PROCESS_FAILED");
    expect(() => lstatSync(target)).toThrow();
  });
});
