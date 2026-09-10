import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { captureRecoveryCopy } from "./installation-recovery-snapshot.mjs";

const id = { volumeSerial: "12", fileId: "1".repeat(32) };
function fake(mode = "success") {
  let calls = 0;
  const spawn = (_helper, args) => {
    calls++; assert.deepEqual(args, ["--bridge", "123"]);
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let nonce, closed = false;
    const close = () => { if (!closed) { closed = true; child.stdout.end(); child.emit("close", 0); } };
    child.kill = () => { queueMicrotask(close); return true; };
    child.stdin.on("finish", () => queueMicrotask(close));
    const send = object => child.stdout.write(JSON.stringify(object) + "\n");
    const success = () => send({ event: "result", nonce, status: 0, copyComplete: true, snapshotReleased: true, snapshotId: "12345678-1234-1234-1234-123456789abc", sourceIdentity: id });
    child.stdin.on("data", data => {
      const text = String(data);
      if (text.startsWith("MURAGE_RECOVERY_1")) {
        nonce = text.split("\n")[1];
        queueMicrotask(() => {
          if (mode === "oversized") { child.stdout.write("x".repeat(65537)); return; }
          send({ event: "prepared", nonce: mode === "nonce" ? "wrong" : nonce, sourceIdentity: id, destinationParentIdentity: id, sid: "S-1-5-21-123" });
          if (mode === "premature") success();
        });
      } else if (text === `CONFIRM ${nonce}\n`) queueMicrotask(() => { success(); close(); });
    });
    return child;
  };
  return { spawn, get calls() { return calls; } };
}
const parameters = { helper: "C:\\App\\resources\\murage-recovery.exe", source: "C:\\Users\\fixture\\source", destination: "C:\\Users\\fixture\\clone", restoreJournalLeaf: `.murage-data-owner-${"a".repeat(64)}.lease.restore.json`, parentPid: 123 };
test("requires native identity preview and exact confirmation before returning a private clone", async () => {
  const host = fake(); let confirms = 0;
  const result = await captureRecoveryCopy({ ...parameters, spawn: host.spawn, confirm: async preview => { confirms++; assert.deepEqual(preview.sourceIdentity, id); return true; } });
  assert.equal(confirms, 1); assert.equal(host.calls, 1); assert.equal(result.directory, parameters.destination); assert.equal(result.activationAvailable, false);
});
test("declined confirmation closes only its bridge without capturing", async () => {
  const host = fake(); await assert.rejects(captureRecoveryCopy({ ...parameters, spawn: host.spawn, confirm: async () => false }), { code: "RECOVERY_CAPTURE_CANCELLED" });
});
for (const mode of ["nonce", "oversized", "premature"]) test(`rejects ${mode} native output`, async () => {
  const host = fake(mode); await assert.rejects(captureRecoveryCopy({ ...parameters, spawn: host.spawn, confirm: async () => true }), { code: "INVALID_RECOVERY_CAPTURE_RESULT" });
});
test("rejects injected path framing before starting a bridge", async () => {
  const host = fake(); await assert.rejects(captureRecoveryCopy({ ...parameters, source: "C:\\source\nCONFIRM", spawn: host.spawn, confirm: async () => true }), { code: "INVALID_RECOVERY_CAPTURE" }); assert.equal(host.calls, 0);
});
