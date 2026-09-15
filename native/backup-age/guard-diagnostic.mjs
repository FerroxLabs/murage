import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeRequest, createControlProtocol } from "./native/backup-age/protocol.mjs";
const root = dirname(fileURLToPath(import.meta.url)), directory = join(root, "guard-diagnostic-20260913-115706");
const helper = join(root, "dist-native", "backup-tools", "win32-x64", "murage-backup-age.exe"), probe = join(root, "native-probe.exe");
const receipts = []; let child, closed, childCode, protocol;
const record = (event, details) => { const receipt = { event, ...details }; receipts.push(receipt); console.log(JSON.stringify(receipt)); };
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
function native(...args) {
  const result = spawnSync(probe, args, { encoding: "utf8", timeout: 10000, windowsHide: true, maxBuffer: 1048576 });
  if (result.status !== 0) throw Error(`native probe failed: ${result.stdout}`);
  return JSON.parse(result.stdout.trim());
}
try {
  const token = native("--inert"); record("genuine-token", token); assert.equal(token.elevated, 0); assert.equal(token.integrity, 8192); assert.equal(token.inJob, 1);
  const helperSha256 = hash(helper); record("helper-identity", { helperSha256 }); assert.equal(helperSha256, "3e7147249eb0852a488518860679abd6feff6027739e07921e8490e41084ae9a");
  mkdirSync(directory); const input = join(directory, "held-synthetic.bin"); writeFileSync(input, Buffer.from("FAKE-GUARD-ONLY-DIAGNOSTIC\n".repeat(100)));
  const before = { sha256: hash(input), identity: native("--identity", input), directoryIdentity: native("--identity", directory) }; record("before", before);
  const nonce = randomUUID(); protocol = createControlProtocol(nonce, "decrypt", 16384);
  const request = encodeRequest({ nonce, operation: "decrypt", parentPid: process.pid, parentDirectory: directory, ciphertext: input, maxBytes: 16384, timeoutMs: 15000, closeTimeoutMs: 3000 }, `AGE-SECRET-KEY-1${"A".repeat(58)}\n`);
  child = spawn(helper, ["--parent", String(process.pid)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { PATH: "" } });
  closed = new Promise(resolve => child.once("close", code => { childCode = code; resolve(code); })); child.stdin.on("error", () => {});
  let prepared, controlError, stdoutBytes = 0;
  child.stdout.on("data", bytes => { stdoutBytes += bytes.length; });
  child.stderr.on("data", bytes => { try { for (const event of protocol.receive(bytes)) if (event.event === "PREPARED") prepared = event; } catch (error) { controlError = error.message; } });
  child.stdin.write(request.header); child.stdin.write(request.key, () => request.key.fill(0));
  const until = Date.now() + 20000;
  while (!prepared && childCode === undefined && !controlError && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(prepared, `PREPARED missing: ${controlError ?? childCode ?? "timeout"}`);
  assert.equal(prepared.fields[0], before.identity.volumeSerial); assert.equal(prepared.fields[1], before.identity.fileId); record("prepared", { fields: prepared.fields });
  let integrity = true;
  const probes = [["read", input], ["write", input], ["truncate", input], ["delete", input], ["rename", input], ["read", directory], ["write", directory], ["rename", directory]];
  for (const [operation, target] of probes) {
    if (!integrity) { record("skipped", { operation, targetKind: target === input ? "file" : "directory", reason: "previous probe changed original path or bytes" }); continue; }
    const result = native("--mutation", operation, target); record("guard-probe", { ...result, expectedAllowed: operation === "read" ? 1 : 0 });
    integrity = existsSync(input) && existsSync(directory) && hash(input) === before.sha256 &&
      JSON.stringify(native("--identity", input)) === JSON.stringify(before.identity) && JSON.stringify(native("--identity", directory)) === JSON.stringify(before.directoryIdentity);
    if (!integrity) record("integrity-changed", { operation, targetKind: target === input ? "file" : "directory" });
  }
  record("after", { originalIntact: integrity, stdoutBytes, helperCodeBeforeCancel: childCode ?? null });
  child.stdin.end(protocol.command("CANCEL"));
  const code = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve("timeout"), 5000))]); record("cancel-close", { code, stdoutBytes }); assert.equal(code, 72); assert.equal(stdoutBytes, 0);
  const results = receipts.filter(r => r.event === "guard-probe"); record("diagnostic-result", { unexpectedAllows: results.filter(r => r.allowed !== r.expectedAllowed), probes: results.length, originalIntact: integrity, noAgeStarted: true });
} catch (error) { record("diagnostic-error", { message: error.message }); process.exitCode = 1; }
finally {
  if (child && childCode === undefined) { child.kill(); await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5000))]); }
  record("owned-child-final", { closed: !child || childCode !== undefined, code: childCode ?? null });
  writeFileSync(join(root, "guard-diagnostic-receipts.json"), JSON.stringify(receipts, null, 2) + "\n");
}
