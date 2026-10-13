// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { createGuardedCompletion } from "./guarded-completion.ts";
import { resolveCardResult, eligibleResultMessage, sharedAskReplyText, gatedReceiptReplay, resolveReceiptBinding } from "./card-result-source.ts";

type Row = { id: string; text: string };

it("reads the result again on every attempt: BUSY, then the source is deleted, then the retry writes nothing", () => {
  const desk = new Map<string, Row>([["r1", { id: "r1", text: "secret answer" }]]);
  const room: string[] = [];
  let attempts = 0;
  const deliver = () => {
    attempts++;
    const source = resolveCardResult("r1", id => desk.get(id), () => true);
    if (source.drop) return;
    if (attempts === 1) { const busy = new Error("database is locked"); (busy as any).code = "ERR_SQLITE_ERROR"; throw busy; }
    room.push(source.message!.text);
  };
  const timers: Array<() => void> = [];
  const guarded = createGuardedCompletion<true, true>({ write: () => true, follow: deliver, unsubscribe: () => {}, release: () => {}, isBusy: () => true, onError: () => {}, schedule: run => { timers.push(run); } });
  guarded.attempt();
  expect(attempts).toBe(1);
  expect(timers).toHaveLength(1);
  desk.delete("r1"); // forgotten while the delivery waited
  timers.shift()!();
  expect(attempts).toBe(2);
  expect(room).toEqual([]);
});
it("drops a gone result, withholds a withdrawn one, and passes a run that recorded none", () => {
  const rows = new Map<string, Row>([["a", { id: "a", text: "x" }]]);
  expect(resolveCardResult("gone", id => rows.get(id), () => true)).toEqual({ drop: true });
  expect(resolveCardResult("a", id => rows.get(id), () => false)).toMatchObject({ drop: false, allowed: false });
  expect(resolveCardResult("a", id => rows.get(id), () => true)).toMatchObject({ drop: false, allowed: true });
  expect(resolveCardResult(undefined, id => rows.get(id), () => true)).toEqual({ drop: false, message: undefined, allowed: false });
});
it("one gate for every result copy: an ineligible source hands no plaintext to the copy, the mirror or the receipt", () => {
  const rows = new Map<string, Row>([["a", { id: "a", text: "cross-partition plaintext" }]]);
  const read = (id: string) => rows.get(id);
  const paths = { copy: [] as string[], mirror: [] as string[], receipt: [] as string[] };
  const deliver = (eligible: boolean) => {
    const result = eligibleResultMessage("a", read, () => eligible);
    paths.copy.push(result?.text ?? ""); paths.mirror.push(result?.text ?? ""); paths.receipt.push(result?.text ?? "The request finished.");
  };
  deliver(false);
  expect(JSON.stringify(paths)).not.toContain("plaintext");
  deliver(true);
  expect(paths.copy[1]).toBe("cross-partition plaintext");
  rows.delete("a");
  expect(eligibleResultMessage("a", read, () => true)).toBeUndefined();
  expect(eligibleResultMessage(undefined, read, () => true)).toBeUndefined();
});
it("a shared reply is gated on both branches: a delivered copy never returns text once the original is ineligible or the edge is unauthorized", () => {
  const target = new Map<string, Row>([["a", { id: "a", text: "stored plaintext" }]]);
  const ask = (authorized: boolean, eligible: boolean) => sharedAskReplyText({ authorized, resultId: "a", read: id => target.get(id), eligible: () => eligible, outcomeNote: "done" });
  expect(ask(true, true)).toBe("stored plaintext");
  expect(ask(true, false)).toBe("done");
  expect(ask(false, true)).toBe("done");
  target.delete("a");
  expect(ask(true, true)).toBe("done");
});
it("a receipt replay re-asks the delivery authorization: sharing removed after delivery returns the status and the reason, no text", () => {
  let sharing = true;
  const authorize = (_id: string) => sharing ? { ok: true as const } : { ok: false as const, code: "sharing_removed", line: "Helper is no longer shared with this team." };
  const replay = () => gatedReceiptReplay({ requestId: "req-1", authorize, withheld: false, withheldLine: "[withheld]", text: "stored plaintext" });
  expect(replay()).toEqual({ result: "stored plaintext" });
  sharing = false;
  const denied = replay();
  expect(denied).toEqual({ result: "Helper is no longer shared with this team.", reason: "sharing_removed" });
  expect(JSON.stringify(denied)).not.toContain("plaintext");
  // lineage withholding still applies to an authorized replay, and an unbound receipt keeps only that rule
  expect(gatedReceiptReplay({ requestId: "req-1", authorize: () => ({ ok: true }), withheld: true, withheldLine: "[withheld]", text: "stored plaintext" })).toEqual({ result: "[withheld]" });
  expect(gatedReceiptReplay({ requestId: undefined, ownUnsharedWork: () => true, authorize: () => { throw new Error("not asked"); }, withheld: false, withheldLine: "[withheld]", text: "plain" })).toEqual({ result: "plain" });
});
const legacy = { id: "req-9", sourceThreadId: "t-src", toBotId: "b-peer" };
const rows: Record<string, { id: string; toBotId: string | null; rootThreadId: string }> = { "req-9": { id: "req-9", toBotId: "b-peer", rootThreadId: "t-src" } };
const find = { byId: (id: string) => rows[id] ?? null, byKey: (_key: string) => null };
it("a legacy shared-ask receipt (no requestId, request id exposed as the task id) is bound by that id and denied once sharing is removed", () => {
  const binding = resolveReceiptBinding(legacy, find);
  expect(binding).toEqual({ kind: "bound", requestId: "req-9" });
  const replay = gatedReceiptReplay({ requestId: binding.kind === "bound" ? binding.requestId : undefined, ownUnsharedWork: () => true, authorize: () => ({ ok: false, code: "sharing_removed", line: "no longer shared" }), withheld: false, withheldLine: "[w]", text: "stored plaintext" });
  expect(replay).toEqual({ result: "no longer shared", reason: "sharing_removed" });
});
it("a found request that is a different worker or conversation is a mismatch and never yields text", () => {
  const other = { byId: () => ({ id: "req-9", toBotId: "b-other", rootThreadId: "t-src" }), byKey: () => null };
  expect(resolveReceiptBinding(legacy, other)).toEqual({ kind: "mismatch" });
  const replay = gatedReceiptReplay({ requestId: undefined, binding: "mismatch", ownUnsharedWork: () => true, authorize: () => ({ ok: true }), withheld: false, withheldLine: "[w]", text: "stored plaintext" });
  expect(replay.reason).toBe("origin_unconfirmed");
  expect(JSON.stringify(replay)).not.toContain("plaintext");
});
it("an unbound receipt returns text only when its work is positively the owner's own unshared work", () => {
  expect(resolveReceiptBinding(legacy, { byId: () => null, byKey: () => null })).toEqual({ kind: "unbound" });
  const unknown = gatedReceiptReplay({ requestId: undefined, ownUnsharedWork: () => false, authorize: () => ({ ok: true }), withheld: false, withheldLine: "[w]", text: "stored plaintext" });
  expect(unknown.reason).toBe("origin_unconfirmed");
  expect(JSON.stringify(unknown)).not.toContain("plaintext");
  const noProbe = gatedReceiptReplay({ requestId: undefined, authorize: () => ({ ok: true }), withheld: false, withheldLine: "[w]", text: "stored plaintext" });
  expect(noProbe.reason).toBe("origin_unconfirmed");
  expect(gatedReceiptReplay({ requestId: undefined, ownUnsharedWork: () => true, authorize: () => ({ ok: true }), withheld: false, withheldLine: "[w]", text: "stored plaintext" })).toEqual({ result: "stored plaintext" });
});
