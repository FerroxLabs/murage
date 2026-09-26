// W-D1 (0.1.60 Windows customer re-test 2): every Windows backup stopped with
// ENCRYPTED_BACKUP_FAILED. The native helper (native/backup-age/transport.cpp,
// pinDirectories) opens every folder above the backup folder share-read only
// for as long as the private stage is open, so nothing can be renamed or hard
// linked into those folders. The data-folder lease publishes its records by
// hard link into the folder that holds the data folder, which by default is
// C:\Users\<name>: the same folder that sits above "Murage Backups". The lease
// was taken inside the private stage, its link failed with EBUSY, and the
// writer folded that into ENCRYPTED_BACKUP_FAILED.
//
// This models the helper's pins in the source fixture: while a fake private
// stage is open, a link or rename into any pinned folder fails with EBUSY, as
// NTFS does. The backup must take the lease before the helper starts and let
// it go after the helper closes.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transport: vi.fn(), resources: vi.fn(), verify: vi.fn(), pinned: new Set<string>(), linkCalls: [] as string[] }));
// electron/*.mjs is loaded outside vitest's module graph, so vi.mock("node:fs")
// would not reach the lease. Patch the builtin itself and sync its ESM exports.
const realLink = fs.linkSync, realRename = fs.renameSync;
function busy(target: string, syscall: string) {
  // NTFS folds case, and so does the product's win32 path canonicalisation.
  if (!mocks.pinned.has(dirname(target).toLowerCase())) return;
  throw Object.assign(new Error(`EBUSY: resource busy or locked, ${syscall}`), { code: "EBUSY", errno: -4082, syscall });
}
function pinNtfs() {
  fs.linkSync = ((existing: fs.PathLike, target: fs.PathLike) => { mocks.linkCalls.push(String(target)); busy(String(target), "link"); return realLink(existing, target); }) as typeof fs.linkSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => { busy(String(to), "rename"); return realRename(from, to); }) as typeof fs.renameSync;
  syncBuiltinESMExports();
}
function unpinNtfs() { fs.linkSync = realLink; fs.renameSync = realRename; syncBuiltinESMExports(); }
vi.mock("./installation-windows-backup-transport.ts", () => ({ runWindowsBackupTransport: mocks.transport }));
vi.mock("./windows-backup-resources.ts", () => ({ createWindowsBackupResourceResolver: mocks.resources }));
import * as encryption from "./installation-backup-encryption.ts";
import { writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { initializeMessageTables } from "./message-tables.ts";
import type { WindowsBackupContext, WindowsBackupDependencies, WindowsBackupRequest } from "./installation-windows-backup-transport.ts";
import { captureFailureSentence, describeCaptureError } from "../shared/backup-capture-failure.mjs";

const descriptors = Object.fromEntries(["platform", "arch", "execPath"].map(key => [key, Object.getOwnPropertyDescriptor(process, key)!]));
const helper = "C:\\Installed\\resources\\backup-tools\\x64\\murage-backup-age.exe", age = "C:\\Installed\\resources\\backup-tools\\x64\\age.exe";
const options = { ageExecutable: age, identity: `AGE-SECRET-KEY-1${"A".repeat(58)}\n`, recipient: `age1${"a".repeat(50)}`,
  selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const };
const roots: string[] = [];
const events: string[] = [];
// Same constraint as installation-windows-backup-operations.test.ts: under
// platform=win32 the product case-folds canonical paths, which only resolves
// where the scratch filesystem folds case too.
const caseFoldingScratch = (() => {
  const probe = mkdtempSync(join(tmpdir(), "murage-win-casefold-"));
  try { writeFileSync(join(probe, "Probe"), ""); return existsSync(join(probe, "probe")); }
  finally { rmSync(probe, { recursive: true, force: true }); }
})();
const staged = it.skipIf(!caseFoldingScratch);

/** The default Windows layout: the data folder and the backup folder side by side. */
function fixture() {
  const original = realpathSync(mkdtempSync(join(tmpdir(), "murage-win-pins-")));
  const home = join(dirname(original), original.slice(dirname(original).length + 1).toLowerCase());
  if (original !== home) renameSync(original, home); roots.push(home);
  const data = join(home, ".murage"); mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({ profile: { name: "Sam Lee" } }));
  writeFileSync(join(data, "bots.json"), JSON.stringify([{ id: "bot", threadId: "thread", name: "Ember" }]));
  writeFileSync(join(data, "groups.json"), "[]");
  const db = new DatabaseSync(join(data, "messages.db"));
  try { initializeMessageTables(db); } finally { db.close(); }
  const backups = join(home, "murage backups"); mkdirSync(backups);
  return { home, data, archive: join(backups, `${randomUUID()}.age`) };
}
/** Every folder from the drive root down to `directory`, as pinDirectories holds them. */
function ancestors(directory: string) {
  const result: string[] = [];
  for (let current = directory; ; current = dirname(current)) { result.push(current); if (current === parse(current).root || dirname(current) === current) return result; }
}
async function pinningTransport(request: WindowsBackupRequest<unknown>, dependencies: WindowsBackupDependencies) {
  await dependencies.verifyHelper();
  const pins = ancestors(request.parentDirectory);
  const directory = join(request.parentDirectory, `.murage-backup-${randomUUID()}`); mkdirSync(directory, { mode: 0o700 });
  for (const pin of pins) mocks.pinned.add(pin.toLowerCase());
  events.push(`${request.operation}:pinned`);
  const controller = new AbortController();
  const context: WindowsBackupContext = { directory, sourceIdentity: { volumeSerial: "1", fileId: "a".repeat(32) }, sourceBytes: 1, stageIdentity: { volumeSerial: "1", fileId: "b".repeat(32) }, signal: controller.signal };
  try {
    if (request.operation === "decrypt") { context.plaintext = join(directory, "authenticated.zip"); writeFileSync(context.plaintext, fs.readFileSync(request.ciphertext!)); }
    const validated = await request.validate(context);
    return { value: validated.value, directory, plaintext: context.plaintext, ciphertextSha256: validated.ciphertextSha256, helperClosed: true, guardsClosed: true };
  } catch (error) { controller.abort(); throw Object.assign(error as Error, { retainedDirectory: directory, helperClosed: true }); }
  finally { for (const pin of pins) mocks.pinned.delete(pin.toLowerCase()); events.push(`${request.operation}:released`); }
}

beforeEach(() => {
  for (const [key, value] of Object.entries({ platform: "win32", arch: "x64", execPath: "C:\\Installed\\Murage.exe" })) Object.defineProperty(process, key, { ...descriptors[key], value });
  mocks.pinned.clear(); mocks.linkCalls.length = 0; events.length = 0; pinNtfs();
  mocks.verify.mockReset().mockResolvedValue({ executable: helper }); mocks.resources.mockReset().mockReturnValue(mocks.verify); mocks.transport.mockReset().mockImplementation(pinningTransport);
  vi.spyOn(encryption, "encryptBackupStream").mockImplementation(async (_exe, _recipient, input, output) => {
    const chunks: Buffer[] = []; for await (const chunk of input) chunks.push(Buffer.from(chunk));
    writeFileSync(output, Buffer.concat(chunks), { flag: "wx", mode: 0o600 });
  });
});
afterEach(() => {
  unpinNtfs(); vi.restoreAllMocks(); for (const [key, descriptor] of Object.entries(descriptors)) Object.defineProperty(process, key, descriptor);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

staged("takes the data-folder lease before the helper pins the folders above the backup folder (W-D1)", async () => {
  const f = fixture();
  const result = await writeEncryptedInstallationBackup(f.data, f.archive, options);
  expect(existsSync(f.archive)).toBe(true);
  expect(result.path).toBe(f.archive.toLowerCase());
  // The lease record really was published into the pinned home folder, and
  // only while nothing held it.
  expect(mocks.linkCalls.some(target => dirname(target).toLowerCase() === f.home.toLowerCase() && /\.murage-data-owner-[0-9a-f]{64}\.lease$/.test(target))).toBe(true);
  expect(events).toEqual(["private-stage:pinned", "decrypt:pinned", "decrypt:released", "private-stage:released"]);
  expect(mocks.pinned.size).toBe(0);
  // The lease is gone again once the backup returns.
  expect(fs.readdirSync(f.home).filter(name => name.startsWith(".murage-data-owner-") && name.endsWith(".lease"))).toEqual([]);
});

staged("a link refused inside the capture is logged with its step and errno, never its path", async () => {
  const f = fixture();
  // Pin the data folder's parent from outside for the whole run: the lease
  // itself now cannot be published, which is the shape the customer saw.
  for (const pin of ancestors(f.home)) mocks.pinned.add(pin.toLowerCase());
  const caught = await writeEncryptedInstallationBackup(f.data, f.archive, options).catch(error => error);
  // Named for what the person can do, not the old "check your recovery key".
  expect(caught.code).toBe("BACKUP_FILE_IN_USE");
  expect(captureFailureSentence({ stage: "capture", code: caught.code })).not.toMatch(/recovery key/i);
  const cause = describeCaptureError(caught);
  expect(cause).toMatchObject({ step: "offline-open", errno: "EBUSY", syscall: "link", innerCode: "LEASE_IO", code: "BACKUP_FILE_IN_USE" });
  expect(JSON.stringify(cause).toLowerCase()).not.toContain(f.home.toLowerCase());
  expect(JSON.stringify(cause)).not.toMatch(/murage-data-owner|\.lease/);
  expect(existsSync(f.archive)).toBe(false);
});

staged("a helper that can't make its private folder in the backup folder is named as a folder problem, not a key problem (W-D1)", async () => {
  const f = fixture();
  // What the real helper did on the VM when the backup folder refused writes: exit 72 before PREPARED.
  mocks.transport.mockImplementationOnce(async () => {
    throw Object.assign(new (await import("./installation-database-snapshot.ts")).InstallationSnapshotError("AGE_PROCESS_FAILED"),
      { toolDiagnostic: { tool: "murage-backup-age", toolStep: "prepare", exitCode: 72 }, helperClosed: true });
  });
  const caught = await writeEncryptedInstallationBackup(f.data, f.archive, options).catch(error => error);
  expect(caught.code).toBe("BACKUP_FOLDER_UNUSABLE");
  expect(describeCaptureError(caught)).toMatchObject({ step: "private-stage", tool: "murage-backup-age", toolStep: "prepare", exitCode: 72, innerCode: "AGE_PROCESS_FAILED" });
  const sentence = captureFailureSentence({ stage: "capture", code: caught.code });
  expect(sentence).toMatch(/backup folder/);
  expect(sentence).not.toMatch(/recovery key/i);
  // Once past PREPARED, a helper failure keeps its own code.
  mocks.transport.mockImplementationOnce(async () => {
    throw Object.assign(new (await import("./installation-database-snapshot.ts")).InstallationSnapshotError("AGE_PROCESS_FAILED"),
      { toolDiagnostic: { tool: "murage-backup-age", toolStep: "release", exitCode: 72 }, helperClosed: true });
  });
  expect((await writeEncryptedInstallationBackup(f.data, f.archive, options).catch(error => error)).code).toBe("AGE_PROCESS_FAILED");
});
