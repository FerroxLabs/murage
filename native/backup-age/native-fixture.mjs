import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, linkSync, unlinkSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeRequest, createControlProtocol } from "./native/backup-age/protocol.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const probe = join(root, "native-probe.exe"), helper = join(root, "dist-native", "backup-tools", "win32-x64", "murage-backup-age.exe");
const age = join(dirname(helper), "age.exe"), keygen = join(dirname(helper), "age-keygen.exe");
const data = join(root, "synthetic spaces Ω");
const receipts = [], owned = new Set();
const record = (event, detail) => { const receipt = { event, ...detail }; receipts.push(receipt); console.log(JSON.stringify(receipt)); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function native(...args) {
  const result = spawnSync(probe, args, { encoding: "utf8", timeout: 15000, maxBuffer: 1048576, windowsHide: true });
  assert.equal(result.status, 0, `fixture probe failed: ${result.stdout}`);
  return JSON.parse(result.stdout.trim());
}
const deadline = setTimeout(() => { for (const child of owned) child.kill(); process.exitCode = 76; }, 8 * 60 * 1000);

function session(operation, ciphertext = "", key = "", options = {}) {
  const nonce = randomUUID(), maxBytes = 64 * 1024 * 1024;
  const encoded = encodeRequest({ nonce, operation, parentPid: process.pid, parentDirectory: data, ciphertext, maxBytes,
    timeoutMs: options.timeoutMs ?? 15000, closeTimeoutMs: 3000 }, key);
  const protocol = createControlProtocol(nonce, operation, maxBytes);
  const child = spawn(helper, ["--parent", String(process.pid)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { PATH: "" } }); owned.add(child);
  const directory = join(data, `.murage-backup-${nonce}`);
  let code, statusError, output = [], bytes = 0, notifications = [];
  const closed = new Promise(resolve => child.once("close", value => { code = value; owned.delete(child); resolve(value); }));
  child.stdin.on("error", () => {}); child.on("error", error => { statusError = error.message; });
  child.stderr.on("data", chunk => {
    try { notifications.push(...protocol.receive(chunk)); } catch (error) { statusError = error.message; }
  });
  if (!options.blockOutput) child.stdout.on("data", chunk => {
    try { protocol.plaintext(chunk.length); output.push(chunk); bytes += chunk.length; } catch (error) { statusError = error.message; }
  });
  child.stdin.write(encoded.header);
  if (encoded.key.length) child.stdin.write(encoded.key, () => encoded.key.fill(0));
  async function wait(check, label, milliseconds = 20000) {
    const until = Date.now() + milliseconds;
    while (!check()) {
      if (statusError) throw Error(`${label}: ${statusError}`);
      if (code !== undefined) throw Error(`${label}: helper closed ${code}`);
      assert.ok(Date.now() < until, `${label}: fixture timeout`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  return { child, directory, protocol, closed,
    async prepared() { await wait(() => notifications.some(n => n.event === "PREPARED"), "prepared"); return notifications.find(n => n.event === "PREPARED"); },
    start() { child.stdin.write(protocol.command("START")); },
    async plaintext() { await wait(() => protocol.plaintextComplete, "plaintext"); return Buffer.concat(output); },
    async release() { child.stdin.end(protocol.command("RELEASE")); const result = await closed; assert.equal(result, 0); assert.equal(statusError, undefined); protocol.close(result); return notifications.find(n => n.event === "RELEASED").fields[0]; },
    async cancelled() { try { child.stdin.end(protocol.command("CANCEL")); } catch { child.stdin.end(); } return closed; },
    get bytes() { return bytes; }, get code() { return code; }, get statusError() { return statusError; },
  };
}

try {
  // Fixture/token preconditions precede any helper success claim.
  const inert = native("--inert"); assert.equal(inert.elevated, 0); assert.equal(inert.integrity, 8192); assert.ok(inert.defaultDaclAces > 0); assert.equal(inert.inJob, 1); record("limited-inert-precondition", inert);
  const inertHelper = spawnSync(helper, ["--invalid"], { windowsHide: true, timeout: 10000, stdio: "pipe" });
  assert.equal(inertHelper.status, 72); record("same-helper-inert-launch", { exit: inertHelper.status });
  assert.equal(sha(readFileSync(age)), "2821a4ed191da07372acd302e5f6feae7a7985e285e1417765ebe74025af45f0");
  assert.equal(sha(readFileSync(keygen)), "1549c7049be32695594bedd09bbd352a94b6013a9d5c43364f3c6cd7a09ab61c");
  record("resource-identity", { helperSha256: sha(readFileSync(helper)), ageSha256: sha(readFileSync(age)), keygenSha256: sha(readFileSync(keygen)) });
  mkdirSync(data);
  const generated = spawnSync(keygen, [], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
  assert.equal(generated.status, 0); const key = generated.stdout.split(/\r?\n/).find(line => line.startsWith("AGE-SECRET-KEY-1")) + "\n";
  const recipientResult = spawnSync(keygen, ["-y"], { input: key, encoding: "utf8", timeout: 10000 }); assert.equal(recipientResult.status, 0); const recipient = recipientResult.stdout.trim();
  const source = Buffer.from("FAKE-NATIVE-WINDOWS-BACKUP Ω\n".repeat(10000));
  const encryption = spawnSync(age, ["--encrypt", "--recipient", recipient, "--output", "-"], { input: source, timeout: 15000, maxBuffer: 64 * 1024 * 1024 }); assert.equal(encryption.status, 0);
  const ciphertext = join(data, "cipher text Ω.age"); writeFileSync(ciphertext, encryption.stdout); const originalHash = sha(encryption.stdout);
  const stage = session("private-stage"); await stage.prepared();
  const acl = native("--acl", stage.directory); assert.equal(acl.protected, 1); assert.equal(acl.exactPrincipals, 1); assert.equal(acl.restrictedAccessError, 5);
  writeFileSync(join(stage.directory, "synthetic.txt"), "private synthetic data"); assert.equal(await stage.release(), "-"); record("private-stage", { ...acl, released: true });

  const roundtrip = session("decrypt", ciphertext, key); await roundtrip.prepared();
  const read = native("--mutation", "read", ciphertext); assert.equal(read.allowed, 1);
  const guardResults = {};
  for (const op of ["write", "truncate", "delete", "rename"]) { const result = native("--mutation", op, ciphertext); assert.equal(result.allowed, 0); guardResults[op] = result.error; }
  for (const op of ["write", "rename"]) { const result = native("--mutation", op, data); assert.equal(result.allowed, 0); guardResults[`ancestor-${op}`] = result.error; }
  roundtrip.start(); const plain = await roundtrip.plaintext(); assert.deepEqual(plain, source); assert.equal(await roundtrip.release(), originalHash);
  assert.equal(sha(readFileSync(ciphertext)), originalHash); record("roundtrip-and-held-guards", { plaintextBytes: plain.length, sourceUnchanged: true, guardResults });

  const held = spawn(probe, ["--hold-writer", ciphertext], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); owned.add(held);
  const heldClosed = new Promise(resolve => held.once("close", code => { owned.delete(held); resolve(code); }));
  await new Promise(resolve => held.stdout.once("data", resolve)); const refused = session("decrypt", ciphertext, key); assert.equal(await refused.closed, 72); held.stdin.end("x"); assert.equal(await heldClosed, 0); record("already-open-writer-refused", { exit: 72 });

  const hardlink = ciphertext + ".link"; linkSync(ciphertext, hardlink); const linked = session("decrypt", ciphertext, key); assert.equal(await linked.closed, 72); unlinkSync(hardlink); record("hardlink-admission-refused", { exit: 72 });
  const junction = join(root, "synthetic-junction"); symlinkSync(data, junction, "junction"); const reparsed = session("decrypt", join(junction, "cipher text Ω.age"), key); assert.equal(await reparsed.closed, 72); record("reparse-ancestor-admission-refused", { exit: 72 });

  const wrong = spawnSync(keygen, [], { encoding: "utf8", timeout: 10000 }); assert.equal(wrong.status, 0); const wrongKey = wrong.stdout.split(/\r?\n/).find(line => line.startsWith("AGE-SECRET-KEY-1")) + "\n";
  const wrongSession = session("decrypt", ciphertext, wrongKey); await wrongSession.prepared(); wrongSession.start(); assert.equal(await wrongSession.closed, 72); record("wrong-key-refused", { exit: 72, plaintextBytes: wrongSession.bytes });
  const corrupt = Buffer.from(encryption.stdout); corrupt[corrupt.length - 1] ^= 1; const tampered = join(data, "tampered.age"); writeFileSync(tampered, corrupt);
  const tamper = session("decrypt", tampered, key); await tamper.prepared(); tamper.start(); assert.equal(await tamper.closed, 72); record("tamper-refused", { exit: 72, untrustedPartialBytes: tamper.bytes });

  const cancel = session("decrypt", ciphertext, key); await cancel.prepared(); assert.equal(await cancel.cancelled(), 72); record("cancel-refused-before-start", { exit: 72 });
  const timeout = session("private-stage", "", "", { timeoutMs: 50 }); await timeout.prepared(); assert.equal(await timeout.closed, 72); record("deadline-refused", { exit: 72 });

  const large = spawnSync(age, ["--encrypt", "--recipient", recipient, "--output", "-"], { input: Buffer.alloc(32 * 1024 * 1024, 90), timeout: 30000, maxBuffer: 40 * 1024 * 1024 }); assert.equal(large.status, 0);
  const largePath = join(data, "large.age"); writeFileSync(largePath, large.stdout);
  const blocked = session("decrypt", largePath, key, { blockOutput: true, timeoutMs: 30000 }); await blocked.prepared(); blocked.start();
  let agePid = 0;
  for (let attempt = 0; attempt < 100 && !agePid; attempt++) { agePid = native("--child", String(blocked.child.pid)).pid; if (!agePid) await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(agePid > 0); await new Promise(resolve => setTimeout(resolve, 100));
  const fileHandles = native("--handles", String(agePid), largePath), ancestorHandles = native("--handles", String(agePid), data), stageHandles = native("--handles", String(agePid), blocked.directory);
  assert.ok(fileHandles.matchingHandles >= 2, "age must retain inherited ciphertext guard plus its own ciphertext read");
  assert.ok(ancestorHandles.matchingHandles >= 1, "age must retain ancestor guard"); assert.ok(stageHandles.matchingHandles >= 1, "age must retain stage guard");
  record("actual-age-inherited-guards", { agePid, fileHandles, ancestorHandles, stageHandles });
  const death = native("--death", String(blocked.child.pid), String(agePid), largePath); assert.equal(death.gapObserved, 0); assert.equal(death.helperClosed, 1); assert.equal(death.ageClosed, 1);
  await blocked.closed; record("helper-death-owned-child-closure", death);
  record("native-fixture-result", { status: "passed", genuineLimitedSession: true, ownedChildren: owned.size });
} catch (error) {
  record("native-fixture-result", { status: "failed", message: String(error?.message ?? error), ownedChildren: owned.size }); process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  for (const child of owned) { child.kill(); await new Promise(resolve => { child.once("close", resolve); setTimeout(resolve, 5000); }); }
  writeFileSync(join(root, "native-receipts.json"), JSON.stringify(receipts, null, 2) + "\n");
  // Retain only this synthetic scratch/evidence; root owns its final disposition.
  console.log(JSON.stringify({ event: "fixture-cleanup", ownedChildren: owned.size, receipts: "native-receipts.json", dataRetained: existsSync(data) }));
}
