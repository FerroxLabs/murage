import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { migrateMemorySchema } from "../server/memory/schema.ts";
import { acquireDataDirLease, dataDirLeasePaths, inspectDataDirLease } from "./data-dir-lease.mjs";
import { allocateSeparateInstallation, planSeparateInstallation, publishInstallationSelection, resolveInstallationSelection } from "./installation-selection.mjs";
import { assertRestoreReviewed } from "./restore-review.mjs";

const cli = fileURLToPath(new URL("../scripts/installation-recovery.ts", import.meta.url));
const roots = [], evidence = [];
const output = fileURLToPath(new URL("../.planning/0149-separate-recovery-confirm/", import.meta.url));
test.after(() => { mkdirSync(output, { recursive: true }); writeFileSync(path.join(output, "archive-integration.json"), JSON.stringify(evidence, null, 2) + "\n"); });
test.afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fingerprint(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
for (const kind of ["primary", "child", "reaper"]) test(`real archive restores separately with foreign ${kind} intact across startup selection and activation`, () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "murage-separate-archive-"))); roots.push(root);
  const original = path.join(root, "original"), userData = path.join(root, "desktop"), archive = path.join(root, "snapshot.zip"); mkdirSync(original); mkdirSync(userData);
  const env = { PATH: path.dirname(process.execPath), HOME: root, USERPROFILE: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const run = (args, delegated = {}) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { env: { ...env, ...delegated }, timeout: 30_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  writeFileSync(path.join(original, "config.json"), JSON.stringify({ profile: { name: "Offline archive fixture" }, instances: { fixture: { driver: "openai-compat", enabled: true, config: { key: "PRIVATE_FAKE_CANARY" } } } }));
  writeFileSync(path.join(original, "bots.json"), JSON.stringify([{ id: "bot", threadId: "thread", name: "Preserved history", autoApprove: true, computer: "host", busy: true }]));
  writeFileSync(path.join(original, "groups.json"), "[]");
  const db = new DatabaseSync(path.join(original, "messages.db"));
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id)); CREATE INDEX messages_thread ON messages(thread_id); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);");
  migrateMemorySchema(db, "active"); db.close();
  // Valid backup is produced BEFORE planting the foreign claim. No live/raw copy.
  const saved = run(["backup", "--data-dir", original, "--output", archive]);
  const paths = dataDirLeasePaths(original), dead = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { env, encoding: "utf8" }));
  const record = (host, pid = process.pid) => ({ version: 1, pid, host, token: randomUUID(), createdAt: Date.now() - 1000 });
  const foreign = record("foreign-fixture.invalid");
  let anchor = kind === "child" ? paths.childLeasePath : paths.leasePath;
  if (kind === "reaper") { const primary = record(hostname(), dead); writeFileSync(paths.leasePath, JSON.stringify(primary), { mode: 0o600 }); anchor = `${paths.leasePath}.reap-${primary.token}`; foreign.targetToken = primary.token; }
  writeFileSync(anchor, JSON.stringify(foreign), { mode: 0o600 });
  assert.equal(inspectDataDirLease(original).claimKind, kind);
  assert.equal(inspectDataDirLease(original).code, "LEASE_FOREIGN_HOST");
  const files = [...readdirSync(original).map(name => path.join(original, name)), ...readdirSync(root).filter(name => name.startsWith(path.basename(paths.leasePath))).map(name => path.join(root, name))];
  const before = files.map(file => [file, fingerprint(file)]);
  const preview = run(["plan-restore", "--archive", archive]);
  assert.equal(preview.sha256, saved.sha256);
  const plan = allocateSeparateInstallation(planSeparateInstallation(userData, original, original));
  const lease = acquireDataDirLease(plan.dataDirectory);
  let restored;
  try {
    restored = run(["restore", "--data-dir", plan.dataDirectory, "--archive", archive, "--sha256", preview.sha256], lease.utilityServerLeaseEnvironment());
    assert.equal(restored.previousDataDir, null);
    publishInstallationSelection(plan, restored);
  } finally { lease.release(); }
  const selected = resolveInstallationSelection(userData, original);
  assert.equal(selected.dataDirectory, plan.dataDirectory);
  assert.throws(() => assertRestoreReviewed(selected.dataDirectory));
  const config = JSON.parse(readFileSync(path.join(selected.dataDirectory, "config.json"), "utf8"));
  assert.equal(JSON.stringify(config).includes("PRIVATE_FAKE_CANARY"), false);
  assert.equal(config.engineDiscovery, "explicit");
  assert.ok(Object.values(config.instances).every(instance => instance.enabled === false));
  assert.equal(JSON.parse(readFileSync(path.join(selected.dataDirectory, "bots.json"), "utf8"))[0].autoApprove, false);
  const memory = new DatabaseSync(path.join(selected.dataDirectory, "messages.db"), { readOnly: true });
  assert.equal(memory.prepare("SELECT mode FROM memory_meta WHERE id=1").get().mode, "paused"); memory.close();
  const report = run(["review", "--data-dir", selected.dataDirectory]);
  assert.equal(report.engines, "disabled"); assert.equal(report.schedules, "paused");
  run(["activate", "--data-dir", selected.dataDirectory, "--review-hash", report.reviewHash]);
  const startup = `import {resolveInstallationSelection} from ${JSON.stringify(new URL("./installation-selection.mjs", import.meta.url).href)};import {assertRestoreReviewed} from ${JSON.stringify(new URL("./restore-review.mjs", import.meta.url).href)};import {acquireDataDirLease} from ${JSON.stringify(new URL("./data-dir-lease.mjs", import.meta.url).href)};const s=resolveInstallationSelection(process.argv[1],process.argv[2]);const lease=acquireDataDirLease(s.dataDirectory);try{assertRestoreReviewed(s.dataDirectory);process.stdout.write(JSON.stringify(s));}finally{lease.release();}`;
  const restarted = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", startup, userData, original], { env, encoding: "utf8", timeout: 15_000 }));
  assert.equal(restarted.dataDirectory, selected.dataDirectory);
  assert.deepEqual(files.map(file => [file, fingerprint(file)]), before);
  assert.equal(inspectDataDirLease(original).code, "LEASE_FOREIGN_HOST");
  evidence.push({ kind, result: "PASS", snapshotId: saved.snapshotId, originalAndAnchorHashesUnchanged: true, pausedMemory: true, engines: report.engines, schedules: report.schedules, freshProcessSelection: true });
});
test("changed archive hash cannot publish startup selection", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "murage-separate-hash-"))); roots.push(root);
  const original = path.join(root, "original"), userData = path.join(root, "desktop"); mkdirSync(original); mkdirSync(userData);
  writeFileSync(path.join(original, "config.json"), "{}");
  const archive = path.join(root, "snapshot.zip"), env = { PATH: path.dirname(process.execPath), HOME: root, USERPROFILE: root };
  execFileSync(process.execPath, [cli, "backup", "--data-dir", original, "--output", archive], { env, stdio: "pipe", timeout: 30_000 });
  const plan = allocateSeparateInstallation(planSeparateInstallation(userData, original, original));
  let failure;
  try { execFileSync(process.execPath, [cli, "restore", "--data-dir", plan.dataDirectory, "--archive", archive, "--sha256", "0".repeat(64)], { env, stdio: "pipe", timeout: 30_000 }); } catch (error) { failure = error; }
  assert.equal(JSON.parse(String(failure.stderr)).error, "ARCHIVE_HASH_CHANGED");
  assert.equal(existsSync(plan.selector), false);
  assert.equal(resolveInstallationSelection(userData, original).dataDirectory, original);
  evidence.push({ kind: "hash-mismatch", result: "PASS", selectorNotPublished: true });
});
