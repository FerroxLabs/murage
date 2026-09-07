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
