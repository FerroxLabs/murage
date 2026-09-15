import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureScope } from "./policy.ts";
import { createGepaCallLedger } from "./gepa-ledger.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function options(assertCurrent = () => {}) {
  return { scopeId: ensureScope("bot", "ledger-bot"), jobId: "job-one", snapshotDigest: "a".repeat(64), evidence: [], maxMetricCalls: 24, maxReflections: 2, assertCurrent };
}
const inputHash = "b".repeat(64), callId = "job-one:reflect:1", reply = "```\nKeep the verified method.\n```";
it("replays a validated completed reply after restart without reserving another external call", () => {
  const identity = options(), ledger = createGepaCallLedger(identity);
  expect(ledger.lookupOrReserve(callId, inputHash, "reflect")).toEqual({ state: "new" });
  ledger.complete(callId, inputHash, reply);
  closeDatabase();
  const restored = createGepaCallLedger(identity);
  expect(restored.lookupOrReserve(callId, inputHash, "reflect")).toEqual({ state: "complete", value: reply });
  expect(database().prepare("SELECT COUNT(*) AS count FROM memory_scope_bindings WHERE id LIKE 'gepa-call:%'").get()!.count).toBe(1);
  expect(() => createGepaCallLedger({ ...identity, snapshotDigest: "c".repeat(64) })).toThrow("GEPA_LEDGER_IDENTITY_CONFLICT");
  expect(() => restored.lookupOrReserve(callId, "d".repeat(64), "reflect")).toThrow("GEPA_LEDGER_INPUT_CONFLICT");
});
it("refuses an uncertain reserved call instead of repeating it after a crash", () => {
  const identity = options(); createGepaCallLedger(identity).lookupOrReserve(callId, inputHash, "reflect");
  closeDatabase();
  expect(() => createGepaCallLedger(identity).lookupOrReserve(callId, inputHash, "reflect")).toThrow("GEPA_CALL_OUTCOME_UNCERTAIN");
});
it("can reserve again only after an explicit host-proven not-started release", () => {
  const identity = { ...options(), maxReflections: 1 }, ledger = createGepaCallLedger(identity);
  ledger.lookupOrReserve(callId, inputHash, "reflect"); ledger.releaseNotStarted(callId, inputHash);
  closeDatabase();
  const resumed = createGepaCallLedger(identity);
  expect(resumed.lookupOrReserve(callId, inputHash, "reflect")).toEqual({ state: "new" });
  resumed.complete(callId, inputHash, reply);
  expect(() => resumed.releaseNotStarted(callId, inputHash)).toThrow("GEPA_LEDGER_RELEASE_INVALID");
});
it("retains only a response hash when source authority is revoked during an external call", () => {
  let revoked = false;
  const identity = options(() => { if (revoked) throw Error("SOURCE_REVOKED"); }), ledger = createGepaCallLedger(identity);
  ledger.lookupOrReserve(callId, inputHash, "reflect"); revoked = true;
  expect(() => ledger.complete(callId, inputHash, "```\nprivate instruction\n```")).toThrow("GEPA_LEDGER_REVOKED");
  const raw = String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'gepa-call:%'").get()!.intent);
  expect(raw).not.toContain("private instruction");
  expect(JSON.parse(raw)).toMatchObject({ state: "revoked", valueHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  revoked = false;
  expect(() => ledger.lookupOrReserve(callId, inputHash, "reflect")).toThrow("GEPA_LEDGER_REVOKED");
});
it("enforces persisted call caps and never accepts a receipt belonging to another call", () => {
  const ledger = createGepaCallLedger({ ...options(), maxReflections: 1 });
  ledger.lookupOrReserve(callId, inputHash, "reflect"); ledger.complete(callId, inputHash, reply);
  expect(() => ledger.lookupOrReserve("job-one:reflect:2", "c".repeat(64), "reflect")).toThrow("GEPA_LEDGER_CALL_LIMIT");
  expect(() => ledger.lookupOrReserve("other-job:reflect:1", inputHash, "reflect")).toThrow("GEPA_LEDGER_CALL_INVALID");
  expect(() => ledger.complete(callId, inputHash, "```\nDifferent reply\n```")).toThrow("GEPA_LEDGER_RECEIPT_CONFLICT");
});
