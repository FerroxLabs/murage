import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWindowsBackupTransport } from "./server/windows-client.mjs";
const root = dirname(fileURLToPath(import.meta.url)), probe = join(root, "native-probe.exe");
const helper = join(root, "resources", "backup-tools", "x64", "murage-backup-age.exe"), age = join(dirname(helper), "age.exe"), keygen = join(dirname(helper), "age-keygen.exe");
const receipts = [], record = (event, detail) => { const r = { event, ...detail }; receipts.push(r); console.log(JSON.stringify(r)); };
const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");
function native(...args) {
  const r = spawnSync(probe, args, { encoding: "utf8", timeout: 15000, maxBuffer: 1048576, windowsHide: true });
  assert.equal(r.status, 0, `fixture native error: ${r.error?.code ?? "none"} ${r.stdout}`); return JSON.parse(r.stdout.trim());
}
let child, childClosed, didClose = false;
try {
  record("case-start", { name: "native-client-helper-death", trigger: "first plaintext chunk while age alive and CHILD_CLOSED absent" });
  const token = native("--inert"); record("token", token); assert.equal(token.elevated, 0); assert.equal(token.integrity, 8192); assert.equal(token.inJob, 1);
  assert.equal(sha(helper), "ef3c7037e7c0619dfb1b50449c651b6cdff069b9e6600c0723fac0b5f23e0c90");
  assert.equal(sha(age), "2821a4ed191da07372acd302e5f6feae7a7985e285e1417765ebe74025af45f0");
  assert.equal(sha(keygen), "1549c7049be32695594bedd09bbd352a94b6013a9d5c43364f3c6cd7a09ab61c");
  record("resource-identity", { helperSha256: sha(helper), clientSha256: sha(join(root, "server", "windows-client.mjs")), reusedLiveGuardReceipt: "age-diagnostics-2-receipts.json" });
  const directory = join(root, `client-death-${randomUUID()}`); mkdirSync(directory);
  const keys = spawnSync(keygen, [], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }); assert.equal(keys.status, 0);
  const key = keys.stdout.split(/\r?\n/).find(line => line.startsWith("AGE-SECRET-KEY-1")) + "\n";
  const recipient = spawnSync(keygen, ["-y"], { input: key, encoding: "utf8", timeout: 10000 }); assert.equal(recipient.status, 0);
  const sourceBytes = 32 * 1024 * 1024;
  const encrypted = spawnSync(age, ["--encrypt", "--recipient", recipient.stdout.trim(), "--output", "-"], { input: Buffer.alloc(sourceBytes, 90), timeout: 30000, maxBuffer: 40 * 1024 * 1024 }); assert.equal(encrypted.status, 0);
  const ciphertext = join(directory, "original.age"); writeFileSync(ciphertext, encrypted.stdout); const beforeHash = sha(ciphertext), beforeId = native("--identity", ciphertext);
  let triggered = false, seenChildClosed = false, triggerError, killed, validated = false, publicationCalled = false, caught;
  const dependencies = {
    verifyHelper: async () => ({ executable: helper }),
    spawn: (...args) => {
      child = spawn(...args); childClosed = new Promise(resolve => child.once("close", code => { didClose = true; resolve(code); }));
      child.stderr.on("data", bytes => { if (bytes.includes(Buffer.from("CHILD_CLOSED"))) seenChildClosed = true; });
      child.stdout.on("data", bytes => {
        if (triggered) return; triggered = true; child.stdout.pause();
        try {
          assert.equal(seenChildClosed, false, "helper must still be transferring, not authenticated-closed");
          const agePid = native("--child", String(child.pid)).pid; assert.ok(agePid > 0, "actual live age child required at first output");
          record("death-trigger", { helperPid: child.pid, agePid, firstChunkBytes: bytes.length, childClosedStatusSeen: seenChildClosed, stdoutPaused: child.stdout.isPaused() });
          killed = native("--kill-and-wait", String(child.pid), String(agePid)); record("native-child-closure", killed);
        } catch (error) { triggerError = error; child.kill(); }
        finally { child.stdout.resume(); } // Drain only already-buffered output so Node can observe real close.
      });
      return child;
    },
  };
  try {
    await runWindowsBackupTransport({ operation: "decrypt", parentDirectory: directory, ciphertext, identity: key, maxBytes: 64 * 1024 * 1024, timeoutMs: 15000, closeTimeoutMs: 3000,
      validate: async () => { validated = true; return { value: 1, ciphertextSha256: beforeHash }; } }, dependencies).then(value => { publicationCalled = true; return value; });
  } catch (error) { caught = error; }
  assert.equal(triggerError, undefined, triggerError?.message); assert.equal(triggered, true); assert.equal(killed?.helperClosed, 1); assert.equal(killed?.ageClosed, 1);
  assert.equal(await childClosed, 73); assert.equal(didClose, true);
  assert.equal(validated, false); assert.equal(publicationCalled, false); assert.equal(caught?.code, "AGE_PROCESS_FAILED"); assert.equal(caught.helperClosed, true);
  assert.ok(existsSync(caught.retainedDirectory)); const partial = join(caught.retainedDirectory, "authenticated.zip"), stat = lstatSync(partial);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1); assert.ok(stat.size > 0 && stat.size < sourceBytes, "nonempty private partial must be retained");
  assert.equal(sha(ciphertext), beforeHash); assert.deepEqual(native("--identity", ciphertext), beforeId);
  record("case-result", { name: "native-client-helper-death", status: "passed", code: caught.code, validationCalled: validated, publicationContinuationCalled: publicationCalled,
    helperClosed: didClose, ageClosed: killed.ageClosed, retainedPartialBytes: stat.size, originalBytes: sourceBytes, originalHashUnchanged: true, originalIdentityUnchanged: true,
    strictProcessSignalGapAssertionReclassified: false });
} catch (error) { record("case-result", { name: "native-client-helper-death", status: "failed", message: error.message, stack: error.stack }); process.exitCode = 1; }
finally {
  if (child && !didClose) { child.kill(); await Promise.race([childClosed, new Promise(resolve => setTimeout(resolve, 5000))]); }
  record("cleanup", { helperClosed: !child || didClose });
  writeFileSync(join(root, "client-death-receipts.json"), JSON.stringify(receipts, null, 2) + "\n");
}
