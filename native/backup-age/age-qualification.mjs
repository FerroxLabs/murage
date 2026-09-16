import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, linkSync, unlinkSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeRequest, createControlProtocol } from "./native/backup-age/protocol.mjs";
import { runWindowsBackupTransport } from "./server/windows-client.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const probe = join(root, "native-probe.exe"), helper = join(root, "resources", "backup-tools", "x64", "murage-backup-age.exe");
const age = join(dirname(helper), "age.exe"), keygen = join(dirname(helper), "age-keygen.exe");
const data = join(root, `overnight-age-${randomUUID()} Ω`);
const receipts = [], owned = new Set();
const record = (event, detail) => { const receipt = { event, ...detail }; receipts.push(receipt); console.log(JSON.stringify(receipt)); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function native(...args) {
  const result = spawnSync(probe, args, { encoding: "utf8", timeout: 15000, maxBuffer: 1048576, windowsHide: true });
  assert.equal(result.status, 0, `fixture probe failed: status=${result.status} error=${result.error?.code ?? "none"} stdout=${result.stdout} stderr=${result.stderr}`);
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

const helperHash = "ef3c7037e7c0619dfb1b50449c651b6cdff069b9e6600c0723fac0b5f23e0c90";
const selected = new Set(JSON.parse(readFileSync(join(root, "age-selected-cases.json"), "utf8")));
async function cleanupOwned() {
  for (const child of [...owned]) {
    const terminal = new Promise(resolve => child.once("close", resolve)); child.kill();
    await Promise.race([terminal, new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  assert.equal(owned.size, 0, "owned helper processes must close");
}
async function testCase(name, run) {
  if (!selected.has(name)) return;
  record("case-start", { name });
  try { const detail = await run(); record("case-result", { name, status: "passed", ...detail }); }
  catch (error) { record("case-result", { name, status: "failed", message: error.message, stack: error.stack }); process.exitCode = 1; }
  finally { await cleanupOwned(); }
}
async function ageChild(session) {
  let pid = 0;
  for (let attempt = 0; attempt < 100 && !pid; attempt++) { pid = native("--child", String(session.child.pid)).pid; if (!pid) await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(pid > 0, "actual age process must be observed"); return pid;
}
async function observedPidClose(pid) {
  const until = Date.now() + 3000;
  for (;;) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return true; throw error; }
    assert.ok(Date.now() < until, "owned age process must actually close"); await new Promise(resolve => setTimeout(resolve, 10));
  }
}
try {
  const token = native("--inert"); record("token-precondition", token); assert.equal(token.elevated, 0); assert.equal(token.integrity, 8192); assert.equal(token.inJob, 1);
  assert.equal(sha(readFileSync(helper)), helperHash);
  assert.equal(sha(readFileSync(age)), "2821a4ed191da07372acd302e5f6feae7a7985e285e1417765ebe74025af45f0");
  assert.equal(sha(readFileSync(keygen)), "1549c7049be32695594bedd09bbd352a94b6013a9d5c43364f3c6cd7a09ab61c");
  record("resource-identity", { helperSha256: helperHash, ageSha256: sha(readFileSync(age)), clientSha256: sha(readFileSync(join(root, "server", "windows-client.mjs"))), selected: [...selected] });
  mkdirSync(data);
  function newKey() {
    const result = spawnSync(keygen, [], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }); assert.equal(result.status, 0, "synthetic keygen exit");
    return result.stdout.split(/\r?\n/).find(line => line.startsWith("AGE-SECRET-KEY-1")) + "\n";
  }
  const key = newKey(), wrongKey = newKey();
  const publicKey = spawnSync(keygen, ["-y"], { input: key, encoding: "utf8", timeout: 10000 }); assert.equal(publicKey.status, 0, "synthetic recipient exit");
  function encrypt(bytes, name) {
    const result = spawnSync(age, ["--encrypt", "--recipient", publicKey.stdout.trim(), "--output", "-"], { input: bytes, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, "fixture encryption exit"); const path = join(data, name); writeFileSync(path, result.stdout); return path;
  }
  const source = Buffer.from("FAKE-WINDOWS-NATIVE-QUALIFICATION Ω\n".repeat(10000));
  const ciphertext = encrypt(source, "cipher text Ω.age"), sourceHash = sha(readFileSync(ciphertext));
  const largePath = encrypt(Buffer.alloc(32 * 1024 * 1024, 90), "large.age");
  await testCase("native-decrypt", async () => {
    const s = session("decrypt", ciphertext, key); await s.prepared(); s.start(); const result = await s.plaintext();
    assert.deepEqual(result, source, "complete plaintext must equal fixture source"); assert.equal(await s.release(), sourceHash, "held native hash receipt");
    assert.equal(sha(readFileSync(ciphertext)), sourceHash); return { bytes: result.length, exit: s.code, originalUnchanged: true };
  });
  await testCase("wrong-key", async () => {
    const s = session("decrypt", ciphertext, wrongKey); await s.prepared(); s.start(); assert.equal(await s.closed, 72, "wrong-key helper exit");
    assert.equal(s.protocol.plaintextComplete, false); return { untrustedBytes: s.bytes, validationReached: false, exit: s.code };
  });
  await testCase("tamper", async () => {
    const bytes = Buffer.from(readFileSync(ciphertext)); bytes[bytes.length - 1] ^= 1; const path = join(data, "tampered.age"); writeFileSync(path, bytes);
    const s = session("decrypt", path, key); await s.prepared(); s.start(); assert.equal(await s.closed, 72, "tamper helper exit");
    assert.equal(s.protocol.plaintextComplete, false); return { untrustedBytes: s.bytes, validationReached: false, exit: s.code };
  });
  await testCase("already-open-writer", async () => {
    const writer = spawn(probe, ["--hold-writer", ciphertext], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); owned.add(writer);
    const writerClosed = new Promise(resolve => writer.once("close", code => { owned.delete(writer); resolve(code); }));
    await new Promise(resolve => writer.stdout.once("data", resolve));
    const s = session("decrypt", ciphertext, key); assert.equal(await s.closed, 72, "existing writer must refuse admission");
    writer.stdin.end("x"); assert.equal(await writerClosed, 0); return { exit: s.code };
  });
  await testCase("hardlink-admission", async () => {
    const path = ciphertext + ".link"; linkSync(ciphertext, path);
    try { const s = session("decrypt", ciphertext, key); assert.equal(await s.closed, 72); return { exit: s.code }; }
    finally { unlinkSync(path); }
  });
  await testCase("reparse-admission", async () => {
    const junction = join(root, `synthetic-junction-${randomUUID()}`); symlinkSync(data, junction, "junction");
    const s = session("decrypt", join(junction, "cipher text Ω.age"), key); assert.equal(await s.closed, 72); return { exit: s.code };
  });
  await testCase("active-cancel", async () => {
    const s = session("decrypt", largePath, key); await s.prepared(); const first = new Promise(resolve => s.child.stdout.once("data", resolve)); s.start();
    await Promise.race([first, s.closed.then(code => { throw Error(`helper closed before active output: ${code}`); })]);
    const atCancel = s.protocol.state; assert.equal(atCancel, "running", "cancellation must target active output"); assert.equal(await s.cancelled(), 72);
    return { atCancel, partialBytes: s.bytes, exit: s.code };
  });
  await testCase("native-deadline", async () => {
    const s = session("decrypt", largePath, key, { blockOutput: true, timeoutMs: 1000 }); await s.prepared(); s.start(); const pid = await ageChild(s);
    assert.equal(await s.closed, 72, "native watchdog closes blocked helper"); const ageClosed = await observedPidClose(pid); return { observedAgePid: pid, exit: s.code, ageClosed };
  });
  await testCase("age-inherited-handles", async () => {
    const s = session("decrypt", largePath, key, { blockOutput: true, timeoutMs: 15000 }); await s.prepared(); s.start(); const pid = await ageChild(s);
    await new Promise(resolve => setTimeout(resolve, 100));
    const file = native("--handles", String(pid), largePath), ancestor = native("--handles", String(pid), data), stage = native("--handles", String(pid), s.directory);
    record("actual-age-handles", { pid, file, ancestor, stage });
    assert.ok(file.matchingHandles >= 2, "age must retain inherited ciphertext guard and its own read handle");
    assert.ok(ancestor.matchingHandles >= 1, "age must retain ancestor guard"); assert.ok(stage.matchingHandles >= 1, "age must retain stage guard");
    const death = native("--death", String(s.child.pid), String(pid), largePath); await s.closed; assert.equal(death.ageClosed, 1); return { pid, file, ancestor, stage, cleanup: death };
  });
  await testCase("helper-death", async () => {
    const s = session("decrypt", largePath, key, { blockOutput: true, timeoutMs: 15000 }); await s.prepared(); s.start(); const pid = await ageChild(s);
    await new Promise(resolve => setTimeout(resolve, 100)); const result = native("--death", String(s.child.pid), String(pid), largePath);
    await s.closed; record("helper-death-observation", result); assert.equal(result.gapObserved, 0, "no observed guard-loss window with live age"); assert.equal(result.helperClosed, 1); assert.equal(result.ageClosed, 1); return result;
  });
  function clientDependencies(capture) {
    return { verifyHelper: async () => { assert.equal(sha(readFileSync(helper)), helperHash); return { executable: helper }; },
      spawn: (...args) => { const child = spawn(...args); owned.add(child); child.once("close", () => owned.delete(child)); capture(child); return child; } };
  }
  await testCase("native-client-success", async () => {
    let child, validated = false;
    const result = await runWindowsBackupTransport({ operation: "decrypt", parentDirectory: data, ciphertext, identity: key, maxBytes: 64 * 1024 * 1024, timeoutMs: 15000, closeTimeoutMs: 3000,
      validate: async context => {
        assert.deepEqual(readFileSync(context.plaintext), source, "actual exclusive plaintext output"); assert.equal(child.stdout.readableEnded, false, "validate before helper stdout EOF");
        const held = native("--mutation", "write", ciphertext); assert.equal(held.allowed, 0, "source guard remains during caller validation"); validated = true;
        return { value: source.length, ciphertextSha256: sha(readFileSync(ciphertext)) };
      } }, clientDependencies(value => { child = value; }));
    assert.equal(validated, true); assert.equal(result.guardsClosed, true); assert.equal(result.helperClosed, true); assert.equal(result.ciphertextSha256, sourceHash);
    return { bytes: result.value, guardsClosed: result.guardsClosed, helperClosed: result.helperClosed };
  });
  await testCase("native-client-wrong-key", async () => {
    let validated = false, caught;
    try { await runWindowsBackupTransport({ operation: "decrypt", parentDirectory: data, ciphertext, identity: wrongKey, maxBytes: 64 * 1024 * 1024, timeoutMs: 15000, closeTimeoutMs: 3000,
      validate: async () => { validated = true; return { value: 0, ciphertextSha256: sourceHash }; } }, clientDependencies(() => {})); }
    catch (error) { caught = error; }
    assert.equal(validated, false); assert.equal(caught?.code, "AGE_PROCESS_FAILED"); assert.equal(caught.helperClosed, true); assert.ok(existsSync(caught.retainedDirectory));
    return { validated, code: caught.code, helperClosed: caught.helperClosed, retained: true };
  });
  record("qualification-summary", { cases: receipts.filter(r => r.event === "case-result").map(r => ({ name: r.name, status: r.status })), ownedChildren: owned.size });
} catch (error) { record("fixture-error", { message: error.message, stack: error.stack }); process.exitCode = 1; }
finally {
  clearTimeout(deadline); await cleanupOwned();
  writeFileSync(join(root, "age-diagnostics-2-receipts.json"), JSON.stringify(receipts, null, 2) + "\n");
  console.log(JSON.stringify({ event: "fixture-cleanup", ownedChildren: owned.size, dataRetained: existsSync(data) }));
}
