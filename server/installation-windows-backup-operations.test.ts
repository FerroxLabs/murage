import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ transport: vi.fn(), resources: vi.fn(), verify: vi.fn(), spawn: vi.fn() }));
vi.mock("./installation-windows-backup-transport.ts", () => ({ runWindowsBackupTransport: mocks.transport }));
vi.mock("./windows-backup-resources.ts", () => ({ createWindowsBackupResourceResolver: mocks.resources }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn }));
import * as encryption from "./installation-backup-encryption.ts";
import * as archives from "./installation-archive.ts";
import * as preparation from "./installation-restore-preparation.ts";
import { inspectEncryptedInstallationBackup, writeEncryptedInstallationBackup, restoreEncryptedInstallationNew } from "./installation-encrypted-backup.ts";
import { installationRecoveryCommand } from "./installation-recovery-command.ts";
import { InstallationSnapshotError } from "./installation-database-snapshot.ts";
import { assertRestoreReviewed } from "../electron/restore-review.mjs";
import { initializeMessageTables } from "./message-tables.ts";
import { initializeImageOperations } from "./image-operations-schema.ts";
import { migrateMemorySchema } from "./memory/schema.ts";
import type { WindowsBackupContext, WindowsBackupDependencies, WindowsBackupRequest } from "./installation-windows-backup-transport.ts";

const descriptors = Object.fromEntries(["platform", "arch", "execPath"].map(key => [key, Object.getOwnPropertyDescriptor(process, key)!]));
const helper = "C:\\Installed\\resources\\backup-tools\\x64\\murage-backup-age.exe", age = "C:\\Installed\\resources\\backup-tools\\x64\\age.exe";
const options = { ageExecutable: age, identity: `AGE-SECRET-KEY-1${"A".repeat(58)}\n`, recipient: `age1${"a".repeat(50)}`,
  selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const };
const roots: string[] = [], privateRoots: string[] = [], events: string[] = [];
let target: string | undefined, failDecrypt = false;
// The Windows source fixture models NTFS's case-insensitive lookups: under
// platform=win32 the product case-folds canonical paths (data-dir-lease.mjs
// normalizedCanonicalPath) around mixed-case mkdtemp stage names, which only
// resolve where the scratch filesystem folds case (Windows, macOS). Stage-level
// cases run only there; on a case-sensitive host the simulation cannot hold.
const caseFoldingScratch = (() => {
  const probe = mkdtempSync(join(tmpdir(), "murage-win-casefold-"));
  try { writeFileSync(join(probe, "Probe"), ""); return existsSync(join(probe, "probe")); }
  finally { rmSync(probe, { recursive: true, force: true }); }
})();
const staged = it.skipIf(!caseFoldingScratch);
function fixture() {
  const original = realpathSync(mkdtempSync(join(tmpdir(), "murage-win-operation-")));
  const root = join(dirname(original), original.slice(dirname(original).length + 1).toLowerCase());
  if (original !== root) renameSync(original, root); roots.push(root);
  const data = join(root, "installation"); mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({ profile: { name: "Fixture" }, instances: { fixture: { driver: "fuigoAgent", enabled: true, config: { apiKey: "FAKE-PRIVATE-CANARY" } } } }));
  writeFileSync(join(data, "bots.json"), JSON.stringify([{ id: "bot", threadId: "thread", name: "Fixture", autoApprove: true, resumeCursors: { fixture: "synthetic" } }]));
  writeFileSync(join(data, "groups.json"), "[]"); writeFileSync(join(data, "startup-background.json"), JSON.stringify({ keepRunning: true, startAtLogin: true }));
  mkdirSync(join(data, "workspaces")); writeFileSync(join(data, "workspaces", "report.md"), "synthetic saved output");
  const db = new DatabaseSync(join(data, "messages.db"));
  try { initializeMessageTables(db); initializeImageOperations(db); migrateMemorySchema(db, "active"); } finally { db.close(); }
  return { root, data, archive: join(root, "backup.age") };
}
async function fakeTransport(request: WindowsBackupRequest<unknown>, dependencies: WindowsBackupDependencies) {
  await dependencies.verifyHelper(); const controller = new AbortController();
  const directory = join(request.parentDirectory, `.murage-backup-${randomUUID()}`); mkdirSync(directory, { mode: 0o700 }); privateRoots.push(directory); events.push(`${request.operation}:prepared`);
  const context: WindowsBackupContext = { directory, sourceIdentity: { volumeSerial: "1", fileId: "a".repeat(32) }, sourceBytes: 1, stageIdentity: { volumeSerial: "1", fileId: "b".repeat(32) }, signal: controller.signal };
  try {
    if (request.operation === "decrypt") {
      context.plaintext = join(directory, "authenticated.zip"); copyFileSync(request.ciphertext!, context.plaintext);
      if (failDecrypt) throw new InstallationSnapshotError("AGE_PROCESS_FAILED");
      events.push("decrypt:authenticated");
    }
    const validated = await request.validate(context);
    if (request.operation === "decrypt") expect(validated.ciphertextSha256).toBe(createHash("sha256").update(readFileSync(request.ciphertext!)).digest("hex"));
    if (request.operation === "private-stage" && target) expect(existsSync(target)).toBe(false);
    events.push(`${request.operation}:released`);
    return { value: validated.value, directory, plaintext: context.plaintext, ciphertextSha256: validated.ciphertextSha256, helperClosed: true, guardsClosed: true };
  } catch (error) { controller.abort(); throw Object.assign(error as Error, { retainedDirectory: directory }); }
}
beforeEach(() => {
  for (const [key, value] of Object.entries({ platform: "win32", arch: "x64", execPath: "C:\\Installed\\Murage.exe" })) Object.defineProperty(process, key, { ...descriptors[key], value });
  privateRoots.length = 0; events.length = 0; target = undefined; failDecrypt = false;
  mocks.verify.mockReset().mockResolvedValue({ executable: helper }); mocks.resources.mockReset().mockReturnValue(mocks.verify); mocks.transport.mockReset().mockImplementation(fakeTransport);
  mocks.spawn.mockReset().mockImplementation(() => { throw new Error("No native process in Windows source fixture"); });
  vi.spyOn(encryption, "encryptBackupStream").mockImplementation(async (_exe, _recipient, input, output) => {
    const chunks: Buffer[] = []; for await (const chunk of input) chunks.push(Buffer.from(chunk));
    writeFileSync(output, Buffer.concat(chunks), { flag: "wx", mode: 0o600 }); events.push("encrypt:closed");
  });
});
afterEach(() => {
  vi.restoreAllMocks(); for (const [key, descriptor] of Object.entries(descriptors)) Object.defineProperty(process, key, descriptor);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

staged("writes only beneath a native private root and publishes after every stage/age closure", async () => {
  const f = fixture(); target = f.archive; const before = readFileSync(join(f.data, "config.json"));
  const result = await writeEncryptedInstallationBackup(f.data, f.archive, options);
  expect(result.path).toBe(f.archive.toLowerCase()); expect(existsSync(f.archive)).toBe(true); expect(readFileSync(join(f.data, "config.json"))).toEqual(before);
  expect(events).toEqual(["private-stage:prepared", "encrypt:closed", "decrypt:prepared", "decrypt:authenticated", "decrypt:released", "private-stage:released"]);
  expect(privateRoots[1].startsWith(privateRoots[0] + "/")).toBe(true); expect(privateRoots.every(path => !existsSync(path))).toBe(true);
  expect(readdirSync(f.root).some(name => name.startsWith(".murage-encrypted"))).toBe(false); expect(mocks.spawn).not.toHaveBeenCalled();
});

staged("inspects through existing strict parser only after authenticated native completion", async () => {
  const f = fixture(); await writeEncryptedInstallationBackup(f.data, f.archive, options);
  const inspect = vi.spyOn(archives, "inspectArchiveEntries"); events.length = 0;
  const result = await inspectEncryptedInstallationBackup(f.archive, f.root, options);
  expect(inspect).toHaveBeenCalledOnce(); expect(events).toEqual(["decrypt:prepared", "decrypt:authenticated", "decrypt:released"]);
  expect(readFileSync(join(result.stateDirectory, "raw", "config.json"), "utf8")).toContain("FAKE-PRIVATE-CANARY");
  expect(inspect.mock.calls[0][1]).toBe(result.directory); expect(result.directory.includes(".murage-backup-")).toBe(true);
});

staged("retains all Windows failed-decrypt output and never inspects unauthenticated bytes", async () => {
  const f = fixture(); await writeEncryptedInstallationBackup(f.data, f.archive, options); failDecrypt = true;
  const inspect = vi.spyOn(archives, "inspectArchiveEntries");
  const caught = await inspectEncryptedInstallationBackup(f.archive, f.root, options).catch(error => error);
  expect(caught.code).toBe("AGE_PROCESS_FAILED"); expect(existsSync(caught.retainedDirectory)).toBe(true); expect(inspect).not.toHaveBeenCalled();
});

staged("keeps raw snapshot staging and refuses publication after Windows readback failure", async () => {
  const f = fixture(); failDecrypt = true; target = f.archive;
  const caught = await writeEncryptedInstallationBackup(f.data, f.archive, options).catch(error => error);
  expect(caught).toMatchObject({ code: "AGE_PROCESS_FAILED", retainedDirectory: privateRoots[0] });
  expect(existsSync(join(caught.retainedDirectory, "backup.age"))).toBe(true); expect(existsSync(f.archive)).toBe(false);
});

staged("waits for pending extraction to close after helper rejection before returning retained failure", async () => {
  const f = fixture(); await writeEncryptedInstallationBackup(f.data, f.archive, options);
  let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; }); let extractionClosed = false;
  vi.spyOn(archives, "inspectArchiveEntries").mockImplementationOnce(async (_archive, parent, _parse, limits) => {
    const fd = openSync(join(parent, "pending-extraction"), "wx");
    return new Promise<never>((_resolve, reject) => {
      limits!.signal!.addEventListener("abort", () => { setImmediate(() => { closeSync(fd); extractionClosed = true; reject(new InstallationSnapshotError("SNAPSHOT_CANCELLED")); }); }, { once: true }); started();
    });
  });
  mocks.transport.mockImplementationOnce(async (request: WindowsBackupRequest<unknown>) => {
    const directory = join(request.parentDirectory, `.murage-backup-${randomUUID()}`); mkdirSync(directory); const plaintext = join(directory, "authenticated.zip"); copyFileSync(request.ciphertext!, plaintext);
    const controller = new AbortController(); const pending = request.validate({ directory, plaintext, sourceIdentity: { volumeSerial: "1", fileId: "a".repeat(32) }, sourceBytes: 1, stageIdentity: { volumeSerial: "1", fileId: "b".repeat(32) }, signal: controller.signal }); void pending.catch(() => {});
    await began; controller.abort(); throw Object.assign(new InstallationSnapshotError("AGE_PROCESS_FAILED"), { retainedDirectory: directory });
  });
  const caught = await inspectEncryptedInstallationBackup(f.archive, f.root, options).catch(error => error);
  expect(extractionClosed).toBe(true); expect(caught.code).toBe("AGE_PROCESS_FAILED"); expect(existsSync(caught.retainedDirectory)).toBe(true);
});

staged("waits for an aborted encryption writer to finish teardown before reporting private-stage loss", async () => {
  const f = fixture(); let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; }); let writerClosed = false;
  vi.mocked(encryption.encryptBackupStream).mockImplementationOnce(async (_exe, _recipient, input: Readable, _output, limits) => {
    input.on("error", () => {}); started();
    await new Promise<void>((_resolve, reject) => limits.signal!.addEventListener("abort", () => { setImmediate(() => { writerClosed = true; reject(new InstallationSnapshotError("AGE_PROCESS_FAILED")); }); }, { once: true }));
  });
  mocks.transport.mockImplementationOnce(async (request: WindowsBackupRequest<unknown>) => {
    const directory = join(request.parentDirectory, `.murage-backup-${randomUUID()}`); mkdirSync(directory); privateRoots.push(directory); const controller = new AbortController();
    const pending = request.validate({ directory, sourceIdentity: { volumeSerial: "0", fileId: "0".repeat(32) }, sourceBytes: 0, stageIdentity: { volumeSerial: "1", fileId: "b".repeat(32) }, signal: controller.signal }); void pending.catch(() => {});
    await began; controller.abort(); throw Object.assign(new InstallationSnapshotError("AGE_PROCESS_FAILED"), { retainedDirectory: directory });
  });
  const caught = await writeEncryptedInstallationBackup(f.data, f.archive, options).catch(error => error);
  expect(writerClosed).toBe(true); expect(caught.code).toBe("AGE_PROCESS_FAILED"); expect(existsSync(caught.retainedDirectory)).toBe(true); expect(existsSync(f.archive)).toBe(false);
});

staged("restores the paused candidate through the private preparation parent and same-volume journal", async () => {
  const f = fixture(); const backup = await writeEncryptedInstallationBackup(f.data, f.archive, options);
  const prepare = vi.spyOn(preparation, "prepareInstallationRestore"), target = join(f.root, "restored");
  const result = await restoreEncryptedInstallationNew(target, f.archive, backup.sha256, options);
  expect(result.activationAvailable).toBe(false); expect(result.rawFidelityActivated).toBe(false); expect(() => assertRestoreReviewed(target)).toThrow();
  expect(prepare.mock.calls[0][1]).toBe(dirname(prepare.mock.calls[0][0])); expect(prepare.mock.calls[0][1]).toContain(".murage-backup-");
  expect(readFileSync(join(target, "config.json"), "utf8")).not.toContain("FAKE-PRIVATE-CANARY"); expect(existsSync(join(target, "startup-background.json"))).toBe(false);
  expect(privateRoots.every(path => !existsSync(path))).toBe(true);
});

it.each(["backup-encrypted", "inspect-encrypted", "restore-encrypted-new"])("verifies the actual host before requesting identity for %s", async command => {
  const readIdentity = vi.fn(async () => options.identity); mocks.verify.mockRejectedValue(new InstallationSnapshotError("AGE_TOOL_UNVERIFIED"));
  const args = command === "backup-encrypted" ? ["--data-dir", "/unused", "--output", "/unused.age", "--age-tool", age, "--recipient", options.recipient, "--credential-policy", options.selection.credentialPolicy]
    : command === "inspect-encrypted" ? ["--archive", "/unused.age", "--age-tool", age]
    : ["--data-dir", "/unused", "--archive", "/unused.age", "--sha256", "a".repeat(64), "--age-tool", age];
  await expect(installationRecoveryCommand([command, ...args], { readIdentity })).rejects.toMatchObject({ code: "AGE_TOOL_UNVERIFIED" });
  expect(readIdentity).not.toHaveBeenCalled(); expect(mocks.transport).not.toHaveBeenCalled();
  expect(mocks.resources).toHaveBeenCalledWith({ resourcesPath: "C:\\Installed\\resources", currentExecutable: "C:\\Installed\\Murage.exe" });
});

it("rejects an arbitrary age path instead of substituting the host tool", async () => {
  const readIdentity = vi.fn(async () => options.identity);
  await expect(installationRecoveryCommand(["inspect-encrypted", "--archive", "/unused.age", "--age-tool", "C:\\Other\\age.exe"], { readIdentity })).rejects.toMatchObject({ code: "AGE_TOOL_UNVERIFIED" });
  expect(readIdentity).not.toHaveBeenCalled(); expect(mocks.transport).not.toHaveBeenCalled();
});

it("the Windows encryption entry verifies fixed resources and uses the existing bounded runner", async () => {
  vi.mocked(encryption.encryptBackupStream).mockRestore(); const f = fixture(); const output = join(f.root, "runner.age");
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), stdin: undefined as unknown as Writable, kill: vi.fn(), unref: vi.fn() });
  const input: Buffer[] = [];
  child.stdin = new Writable({ write(chunk, _encoding, done) { input.push(Buffer.from(chunk)); done(); }, final(done) {
    child.stdout.end("fake-encrypted-output"); child.stderr.end(); done(); queueMicrotask(() => child.emit("close", 0));
  } });
  mocks.spawn.mockReturnValue(child);
  await encryption.encryptBackupStream(age, options.recipient, Readable.from(["synthetic-input"]), output, { maxBytes: 1024, timeoutMs: 1000 });
  expect(Buffer.concat(input).toString()).toBe("synthetic-input"); expect(readFileSync(output, "utf8")).toBe("fake-encrypted-output");
  expect(mocks.verify.mock.invocationCallOrder[0]).toBeLessThan(mocks.spawn.mock.invocationCallOrder[0]);
  expect(mocks.spawn).toHaveBeenCalledWith(age, ["--encrypt", "--recipient", options.recipient, "--output", "-"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "" }, windowsHide: true });
});
