import assert from "node:assert/strict";
import { spawn, execFileSync, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { captureRecoveryCopy } from "../electron/installation-recovery-snapshot.mjs";

assert.equal(process.platform, "win32"); assert.equal(process.env.GITHUB_ACTIONS, "true");
const helper = resolve("native/recovery-snapshot/transport-fixture.exe");
const journal = `.murage-data-owner-${"a".repeat(64)}.lease.restore.json`;
if (process.argv[2] === "orphan") {
  const root = process.argv[3], nonce = randomUUID();
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
const original = JSON.stringify({ profile: { name: "transport canary" } }); writeFileSync(join(source, "config.json"), original);
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
const receipt = { source: process.env.GITHUB_SHA, transport: "emulated-elevation-same-runner-token", actualUac: "not-exercised", nativePolicyChecks: "passed", confirmationCancellation: "passed", parentDeath: "passed", guardedCapture: result };
writeFileSync(join(evidence, "result.json"), JSON.stringify(receipt, null, 2));
console.log("PASS native transport, cancellation, parent death and guarded VSS copy; actual UAC remains unproven.");
