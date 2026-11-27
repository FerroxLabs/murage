// Owner: rig-realsize lane. The real-size rig's verdict (verdict.mjs) is the release gate's pass/fail: each 1.0.21 field symptom
// must turn it RED on its own, and a busy but healthy run (load-shape lines only) must stay GREEN.
import { expect, it } from "vitest";
import { judge } from "./verdict.mjs";

const healthy = [
  "[io-budget] ERROR AdmissionLockTimeout at timer: the admission ledger lock stayed held past its deadline (1 so far, 0 lines suppressed)",
  "memory receipts revoked scope=records cause=import count=0",
  "[io-budget] writing 541.3 MB/min (budget 50); source: sqlite-temp",
  "turn dispatch recall=withheld thread=t-1",
  "claude close thread=t-1 reason=mounted-single-use",
].join("\n");

const symptoms = {
  contextRevoked: "[memory] line lineage not recorded (MEMORY_CONTEXT_REVOKED); the line reads \"checking\"",
  retainedBudget: "[memory] ledger refusal cause=checking:retained-budget",
  ledgerRefusal: "[memory] ledger refusal cause=consuming-http-denied",
  emitRefused: "[consuming] swallowed error site=response.emit n=1 class=Error code=X",
  dispatchRevoked: "[memory] context revoked during dispatch on thread t-2; re-preparing (1 of 2)",
  dispatchFailed: "Delegated turn could not start: Murage could not set up its turn. Its conversation has the details",
  retainedFenceRefused: "[memory] retained fence refused { refs: { receipt: 2 }, refusedMembers: 1 }",
  stoppedNoContext: "I stopped this turn because some of its context is no longer available.",
  replyWithheld: "(no answer yet: the bot finished, but the reply is still being checked against earlier memory)",
  ownerMountLost: "[mount-relay] mount unavailable mount=\"ops_metrics\" cause=ipc reason=transport-lost",
};

it("a busy run with only load-shape lines is GREEN and still reports its shape", () => {
  const result = judge(healthy);
  expect(result.verdict).toBe("GREEN");
  expect(result.shape).toMatchObject({ admissionLockTimeout: 1, importRevoke: 1, ioBudget: 1, recallWithheld: 1 });
});

for (const [name, line] of Object.entries(symptoms)) {
  it(`the field symptom ${name} alone turns the rig RED`, () => {
    const result = judge(`${healthy}\n${line}`);
    expect(result.verdict).toBe("RED");
    expect(result.red).toContain(name);
    expect(result.gate[name]).toBe(1);
  });
}
