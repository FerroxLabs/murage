import assert from "node:assert/strict";
import test from "node:test";
import { recoveryDesktopSummary } from "./installation-recovery-protocol.mjs";

test("desktop summary bounds large manifests and drops private/unknown payloads", () => {
  const summary = recoveryDesktopSummary({ ok: true, operation: "plan-restore", sha256: "a".repeat(64), snapshotId: "12345678-1234-1234-1234-123456789abc", activationAvailable: false, omitted: Array.from({ length: 100_000 }, () => ({ path: "private-content-canary" })), credentials: "private-secret-canary" });
  assert.equal(summary.omittedCount, 100_000);
  assert.equal(JSON.stringify(summary).includes("canary"), false);
  assert.ok(JSON.stringify(summary).length < 1024);
});
test("desktop summary rejects activation, oversized fields and malformed operation results", () => {
  for (const value of [
    { ok: false, operation: "restore" },
    { ok: true, operation: "execute" },
    { ok: true, operation: "restore", activationAvailable: true },
    { ok: true, operation: "backup", path: "a".repeat(8193) },
    { ok: true, operation: "plan-restore", omitted: "invalid" },
    { ok: true, operation: "restore" },
    { ok: true, operation: "rollback", status: "rolled-back" },
  ]) assert.throws(() => recoveryDesktopSummary(value), /INVALID_RECOVERY_RESULT/);
});
test("revalidating a worker summary retains inspected counts and restore hash", () => {
  const first = recoveryDesktopSummary({ ok: true, operation: "restore", archiveSha256: "a".repeat(64), snapshotId: "12345678-1234-1234-1234-123456789abc", status: "restored-review-required", activationAvailable: false, previousDataDir: "/retained/old", receipt: "/retained/receipt", omittedCount: 12, missingCount: 3 });
  assert.deepEqual(recoveryDesktopSummary(first), first);
});
test("encrypted summaries keep coverage bounded and preserve both encrypted and projected hashes",()=>{
  const value={ok:true,operation:"restore-encrypted-new",encryptedSha256:"a".repeat(64),archiveSha256:"b".repeat(64),snapshotId:"12345678-1234-1234-1234-123456789abc",status:"restored-review-required",previousDataDir:null,receipt:"/receipt",activationAvailable:false,rawFidelityActivated:false,identity:"PRIVATE",coverage:{scope:"application-data",fullInstallation:false,components:[{path:"secret-name",status:"included"},{path:"native",status:"excluded"}]}};
  const result=recoveryDesktopSummary(value);assert.equal(JSON.stringify(result).includes("PRIVATE"),false);assert.equal(JSON.stringify(result).includes("secret-name"),false);
  assert.deepEqual(result.coverage,{scope:"application-data",fullInstallation:false,includedCount:1,excludedCount:1});assert.equal(result.archiveSha256,"b".repeat(64));assert.equal(result.encryptedSha256,"a".repeat(64));
  assert.deepEqual(recoveryDesktopSummary(result),result);
  assert.throws(()=>recoveryDesktopSummary({...value,rawFidelityActivated:true}));
});
