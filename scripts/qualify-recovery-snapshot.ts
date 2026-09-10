// Disposable Windows runner only. Never accepts a source installation argument.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { writeInstallationArchive } from "../server/installation-archive.ts";
import { prepareInstallationRestore } from "../server/installation-restore-preparation.ts";
import { restoredConnectionProfile } from "../electron/restored-connections.mjs";

assert.equal(process.platform, "win32");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.ok(process.env.RUNNER_TEMP);
const executable = resolve("native/recovery-snapshot/fixture.exe");
const evidence = resolve(".planning/0150-recovery-native");
mkdirSync(evidence, { recursive: true });
const results: unknown[] = [];
function hashes(root: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(join(root, prefix))) {
    const path = join(prefix, name), stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) result[path] = "reparse";
    else if (stat.isDirectory()) Object.assign(result, hashes(root, path));
    else result[path] = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
  }
  return result;
}
// Frozen qualification cases: first real-provider failure stops this round.
for (const scenario of ["cancel", "identity", "unc", "overlap", "idle", "concurrent", "journal", "restore", "reparse", "quota", "invalid-records"]) {
  const root = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP!), "murage-vss-fixture-"));
  const source = join(root, "source"), clone = join(root, "clone"); mkdirSync(source);
  const config = { profile: { name: "before" }, instances: { fake: { driver: "claudeAgent", enabled: true, config: { apiKey: "fake-do-not-import" } } } };
  writeFileSync(join(source, "config.json"), JSON.stringify(config));
  writeFileSync(join(source, "bots.json"), JSON.stringify([{ id: "bot", threadId: "t", name: "Preserved", busy: false }]));
  const db = new DatabaseSync(join(source, "messages.db"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id));
    CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);`);
  let sequence = 0;
  const insert = () => {
    const id = `m${++sequence}`;
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("t", id, sequence, "bot", "text", id, JSON.stringify({ id, at: sequence, role: "bot", kind: "text", text: id }));
    db.prepare("INSERT OR REPLACE INTO thread_state VALUES('t',?)").run(id); db.exec("COMMIT");
  };
  insert();
  if (scenario === "invalid-records") db.exec("UPDATE thread_state SET active_leaf_id='missing'");
  const paths = dataDirLeasePaths(source);
  const anchors = [paths.leasePath, paths.childLeasePath, `${paths.leasePath}.reap-fixture`];
  for (const path of anchors) writeFileSync(path, JSON.stringify({ version: 1, host: "foreign-fixture", pid: 999999, token: "foreign-canary" }));
  const anchorBefore = anchors.map(path => readFileSync(path, "utf8"));
  if (scenario === "journal") { mkdirSync(join(source, ".package-import-transaction")); writeFileSync(join(source, ".package-import-transaction", "journal.json"), "{}"); }
  if (scenario === "restore") writeFileSync(`${paths.leasePath}.restore.json`, "{}");
  if (scenario === "reparse") { mkdirSync(join(root, "external")); symlinkSync(join(root, "external"), join(source, "attachments"), "junction"); }
  if (scenario === "quota") { mkdirSync(join(source, "attachments")); writeFileSync(join(source, "attachments", "large"), Buffer.alloc(256)); }
  const before = hashes(source);
  let timer: ReturnType<typeof setInterval> | undefined;
  let writes = 0, afterCapture = false;
  if (scenario === "concurrent") timer = setInterval(() => {
    insert(); writes++;
    writeFileSync(join(source, "config.next"), JSON.stringify({ ...config, profile: { name: afterCapture ? "after-snapshot" : "before" } }));
    renameSync(join(source, "config.next"), join(source, "config.json"));
  }, 10);
  try {
    const child = spawn(executable, [root, scenario, basename(`${paths.leasePath}.restore.json`)], { stdio: ["pipe", "pipe", "inherit"] });
    const timeout = setTimeout(() => child.kill(), 180000);
    const terminal = new Promise<number | null>((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
    let receipt: any;
    try {
      for await (const line of createInterface({ input: child.stdout })) {
        const message = JSON.parse(line);
        if (message.event === "captured") {
          if (scenario === "concurrent") {
            afterCapture = true; insert(); writes++;
            writeFileSync(join(source, "config.next"), JSON.stringify({ ...config, profile: { name: "after-snapshot" } }));
            renameSync(join(source, "config.next"), join(source, "config.json"));
          }
          child.stdin.write("continue\n");
        } else if (message.event === "result") receipt = message.receipt;
      }
      assert.equal(await terminal, 0, "native fixture process must finish normally");
    } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); }
    assert.ok(receipt, "native receipt missing");
    results.push({ scenario, root, receipt });
    writeFileSync(join(evidence, "results.json"), JSON.stringify(results, null, 2));
    const expectedCopy = ["idle", "concurrent", "invalid-records"].includes(scenario);
    assert.equal(receipt.copyComplete, expectedCopy, JSON.stringify(receipt));
    if (expectedCopy) {
      assert.equal(receipt.status, 0); assert.equal(receipt.snapshotReleased, true);
      assert.notEqual(receipt.captureTime, "0");
      assert.match(receipt.fileId, /^[a-f0-9]{32}$/); assert.match(receipt.volume, /^\\\\\?\\Volume\{/);
      const capturedConfig = JSON.parse(readFileSync(join(clone, "config.json"), "utf8"));
      assert.equal(capturedConfig.profile.name, "before", "snapshot excludes post-capture replacement");
      const archive = join(root, "validated.zip");
      if (scenario === "invalid-records") await assert.rejects(writeInstallationArchive(clone, archive), { code: "INVALID_ACTIVE_BRANCH" });
      else {
        await writeInstallationArchive(clone, archive);
        const prepared = await prepareInstallationRestore(archive, root);
        const restored = JSON.parse(readFileSync(join(prepared.stateDirectory, "config.json"), "utf8"));
        assert.ok(Object.values(restored.instances).every((instance: any) => instance.enabled === false));
        assert.ok(!JSON.stringify(restored).includes("fake-do-not-import"));
        assert.ok(restoredConnectionProfile(prepared.stateDirectory));
        const copied = new DatabaseSync(join(prepared.stateDirectory, "messages.db"), { readOnly: true });
        try { assert.equal(copied.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok"); assert.ok(Number(copied.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n) >= 1); }
        finally { copied.close(); }
      }
    } else {
      assert.notEqual(receipt.status, 0);
      if (receipt.snapshotId !== "{00000000-0000-0000-0000-000000000000}") assert.equal(receipt.snapshotReleased, true);
      assert.equal(existsSync(join(root, "validated.zip")), false);
    }
    assert.deepEqual(anchors.map(path => readFileSync(path, "utf8")), anchorBefore);
    if (scenario === "concurrent") { assert.ok(writes > 0); insert(); }
    else assert.deepEqual(hashes(source), before, "idle original and sidecars unchanged");
    console.log(`PASS ${scenario}`);
  } finally { if (timer) clearInterval(timer); db.close(); }
}
console.log("Native capture qualification scenarios passed; production elevation, full archive selection/activation and native dialog gates remain pending.");
