import assert from "node:assert/strict";
import { spawn, execFileSync, fork } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { captureRecoveryCopy } from "../electron/installation-recovery-snapshot.mjs";
import { DatabaseSync } from "node:sqlite";
import { migrateMemorySchema } from "../server/memory/schema.ts";
import { acquireDataDirLease, dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { allocateSeparateInstallation, planSeparateInstallation, publishInstallationSelection, resolveInstallationSelection } from "../electron/installation-selection.mjs";
import { assertRestoreReviewed } from "../electron/restore-review.mjs";
import { restoredConnectionProfile } from "../electron/restored-connections.mjs";

assert.equal(process.platform, "win32"); assert.equal(process.env.GITHUB_ACTIONS, "true");
const helper = resolve("native/recovery-snapshot/transport-fixture.exe");
if (process.argv[2] === "orphan") {
  const root = process.argv[3], nonce = randomUUID();
  const journal = dataDirLeasePaths(join(root, "source")).leasePath.split("\\").at(-1) + ".restore.json";
  const child = spawn(helper, ["--bridge", String(process.pid)], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", () => {});
  child.stdin.write(`MURAGE_RECOVERY_1\n${nonce}\n${join(root, "source")}\n${join(root, "orphan-clone")}\n${journal}\n`);
  for await (const line of createInterface({ input: child.stdout })) {
    const value = JSON.parse(line); assert.equal(value.event, "prepared");
    process.send({ bridgePid: child.pid }); process.exit(0);
  }
  process.exit(1);
}
const root = mkdtempSync(join(process.env.RUNNER_TEMP, "murage-transport-fixture-"));
const source = join(root, "source"); mkdirSync(source);
const original = JSON.stringify({ profile: { name: "transport canary" }, flux: { apiKey: "FAKE_PRIVATE_RECOVERY_KEY" }, instances: { fake: { driver: "claudeAgent", enabled: true } } }); writeFileSync(join(source, "config.json"), original);
writeFileSync(join(source, "bots.json"), JSON.stringify([{ id: "bot", threadId: "thread", name: "History", autoApprove: true, computer: "host", busy: true }]));
writeFileSync(join(source, "groups.json"), "[]");
const database = new DatabaseSync(join(source, "messages.db"));
database.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id)); CREATE INDEX messages_thread ON messages(thread_id); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);");
const message = { id: "m1", at: 1, role: "bot", kind: "text", text: "Preserved native recovery history" };
database.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("thread", message.id, message.at, message.role, message.kind, message.text, JSON.stringify(message));
database.exec("INSERT INTO thread_state VALUES('thread','m1')"); migrateMemorySchema(database, "active"); database.close();
const originalPaths = dataDirLeasePaths(source), journal = originalPaths.leasePath.split("\\").at(-1) + ".restore.json";
const anchors = [originalPaths.leasePath, originalPaths.childLeasePath, `${originalPaths.leasePath}.reap-fixture`];
for (const anchor of anchors) writeFileSync(anchor, JSON.stringify({ version: 1, host: "foreign-recovery-fixture", pid: process.pid, token: randomUUID(), createdAt: 1 }));
const preserved = [join(source, "config.json"), join(source, "bots.json"), join(source, "groups.json"), join(source, "messages.db"), ...anchors];
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const before = preserved.map(digest);
const evidence = resolve(".planning/0150-recovery-transport-native"); mkdirSync(evidence, { recursive: true });
execFileSync(helper, [], { stdio: "inherit", timeout: 30000 });
const common = { spawn, helper, source, restoreJournalLeaf: journal, env: process.env };
await assert.rejects(captureRecoveryCopy({ ...common, destination: join(root, "cancelled"), confirm: async () => false }), { code: "RECOVERY_CAPTURE_CANCELLED" });
assert.equal(existsSync(join(root, "cancelled")), false);
const result = await captureRecoveryCopy({ ...common, destination: join(root, "clone"), confirm: async preview => {
  assert.match(preview.sourceIdentity.fileId, /^[a-f0-9]{32}$/); return true;
} });
assert.equal(result.status, 0); assert.equal(result.snapshotReleased, true); assert.equal(result.copyComplete, true);
assert.equal(readFileSync(join(root, "clone", "config.json"), "utf8"), original);
assert.equal(readFileSync(join(source, "config.json"), "utf8"), original);
assert.ok(existsSync(join(root, "clone.capture.json")));
const cli = fileURLToPath(new URL("./installation-recovery.ts", import.meta.url));
const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot };
const run = (args, delegated = {}) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { env: { ...env, ...delegated }, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }));
const archive = join(root, "recovered.zip"); assert.equal(existsSync(archive), false);
const cloneOwner = acquireDataDirLease(result.directory);
let saved;
try { saved = run(["backup", "--data-dir", result.directory, "--output", archive], cloneOwner.utilityServerLeaseEnvironment()); }
finally { cloneOwner.release(); }
const desktop = join(root, "desktop"); mkdirSync(desktop);
const plan = allocateSeparateInstallation(planSeparateInstallation(desktop, source, source));
const restoredOwner = acquireDataDirLease(plan.dataDirectory);
try {
  const restored = run(["restore", "--data-dir", plan.dataDirectory, "--archive", archive, "--sha256", saved.sha256], restoredOwner.utilityServerLeaseEnvironment());
  publishInstallationSelection(plan, restored);
} finally { restoredOwner.release(); }
const selected = resolveInstallationSelection(desktop, source); assert.equal(selected.dataDirectory, plan.dataDirectory);
assert.throws(() => assertRestoreReviewed(selected.dataDirectory), { code: "RESTORE_REVIEW_REQUIRED" });
const restoredConfig = JSON.parse(readFileSync(join(selected.dataDirectory, "config.json"), "utf8"));
assert.ok(!JSON.stringify(restoredConfig).includes("FAKE_PRIVATE_RECOVERY_KEY"));
assert.ok(Object.values(restoredConfig.instances).every(instance => instance.enabled === false));
const connections = restoredConnectionProfile(selected.dataDirectory); assert.ok(connections); assert.equal(existsSync(connections.credentialsFile), false);
const copiedDb = new DatabaseSync(join(selected.dataDirectory, "messages.db"), { readOnly: true });
assert.equal(copiedDb.prepare("SELECT mode FROM memory_meta WHERE id=1").get().mode, "paused");
assert.equal(copiedDb.prepare("SELECT text FROM messages WHERE id='m1'").get().text, message.text); copiedDb.close();
const review = run(["review", "--data-dir", selected.dataDirectory]); assert.equal(review.engines, "disabled"); assert.equal(review.schedules, "paused");
run(["activate", "--data-dir", selected.dataDirectory, "--review-hash", review.reviewHash]);
const startup = `import {resolveInstallationSelection} from ${JSON.stringify(new URL("../electron/installation-selection.mjs", import.meta.url).href)};import {assertRestoreReviewed} from ${JSON.stringify(new URL("../electron/restore-review.mjs", import.meta.url).href)};import {acquireDataDirLease} from ${JSON.stringify(new URL("../electron/data-dir-lease.mjs", import.meta.url).href)};const selected=resolveInstallationSelection(process.argv[1],process.argv[2]);const owner=acquireDataDirLease(selected.dataDirectory);try{assertRestoreReviewed(selected.dataDirectory);process.stdout.write(JSON.stringify(selected));}finally{owner.release();}`;
const restarted = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", startup, desktop, source], { env, encoding: "utf8", timeout: 15000 }));
assert.equal(restarted.dataDirectory, selected.dataDirectory); assert.deepEqual(preserved.map(digest), before);
const worker = fork(fileURLToPath(import.meta.url), ["orphan", root], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
worker.stdout.resume(); worker.stderr.on("data", data => process.stderr.write(data));
const bridgePid = await new Promise((resolvePid, reject) => {
  const timeout = setTimeout(() => { worker.kill(); reject(new Error("orphan preparation timeout")); }, 15000);
  worker.once("message", value => { clearTimeout(timeout); resolvePid(value.bridgePid); });
  worker.once("error", reject);
});
let alive = true;
for (let i=0; i<100 && alive; i++) {
  await new Promise(resolveWait => setTimeout(resolveWait, 50));
  try { process.kill(bridgePid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
}
assert.equal(alive, false, "bridge must exit after its actual parent dies");
assert.equal(existsSync(join(root, "orphan-clone")), false);
const receipt = { source: process.env.GITHUB_SHA, transport: "emulated-elevation-same-runner-token", actualUac: "not-exercised", nativePolicyChecks: "passed", confirmationCancellation: "passed", parentDeath: "passed", guardedCapture: result, archiveRestore: "passed", history: "preserved", credentials: "excluded", enginesSchedulesMemory: "paused", freshProcessSelector: "passed", originalAndAnchors: "unchanged" };
writeFileSync(join(evidence, "result.json"), JSON.stringify(receipt, null, 2));
console.log("PASS native transport, cancellation, parent death and guarded VSS copy; actual UAC remains unproven.");
