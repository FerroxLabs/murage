// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { createGuardedCompletion } from "./guarded-completion.ts";
import { resolveCardResult, resolveReceiptBinding, RECEIPT_ORIGIN_UNCONFIRMED_LINE } from "./card-result-source.ts";
import { releaseStoredResult, type ResultEgressDeps, type StoredResultRef } from "./result-egress.ts";
import { plain } from "./testing/released.ts";
import { WorkerText } from "./released-text.ts";

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
// The one gate (server/result-egress.ts) over a small in-memory world.
const world = (rows: Map<string, Row>, over: Partial<ResultEgressDeps> = {}): ResultEgressDeps => ({
  message: (_thread, id) => rows.get(id),
  authorize: () => ({ ok: true }),
  copyOriginWithheld: () => false, capturedMessageWithheld: () => false, messageSourceForgotten: () => false, messageMadeWithMemory: () => false,
  partitionAllowed: () => true, ownUnsharedWork: () => false, withheldLine: "[withheld]", ...over,
});
const gate = (deps: ResultEgressDeps, ref: StoredResultRef, text?: string, notOwner = false) => plain(releaseStoredResult(ref, "peer", "dst", { fromBotId: "asker" }, notOwner, text === undefined ? undefined : new WorkerText(text), deps));
const stored = (id: string): StoredResultRef => ({ requestId: "req-1", origin: { threadId: "work", messageIds: [id] } });
it("one gate for every result copy: an ineligible source hands no plaintext to the copy, the mirror or the receipt", () => {
  const rows = new Map<string, Row>([["a", { id: "a", text: "cross-partition plaintext" }]]);
  const paths = { copy: [] as string[], mirror: [] as string[], receipt: [] as string[] };
  const deliver = (eligible: boolean) => {
    const released = gate(world(rows, { partitionAllowed: () => eligible }), stored("a"));
    const text = released.kind === "text" ? released.text : "";
    paths.copy.push(text); paths.mirror.push(text); paths.receipt.push(text || "The request finished.");
  };
  deliver(false);
  expect(JSON.stringify(paths)).not.toContain("plaintext");
  deliver(true);
  expect(paths.copy[1]).toBe("cross-partition plaintext");
  rows.delete("a");
  expect(gate(world(rows), stored("a")).kind).toBe("gone");
  expect(gate(world(rows), { requestId: "req-1" }).kind).toBe("gone");
});
it("a shared reply is gated on both branches: a delivered copy never returns text once the original is ineligible or the edge is unauthorized", () => {
  const target = new Map<string, Row>([["a", { id: "a", text: "stored plaintext" }]]);
  expect(gate(world(target), stored("a"))).toMatchObject({ kind: "text", text: "stored plaintext" });
  expect(gate(world(target, { partitionAllowed: () => false }), stored("a"))).toEqual({ kind: "withheld", line: "[withheld]" });
  expect(gate(world(target, { authorize: () => ({ ok: false, code: "shared_paused", line: "paused" }) }), stored("a"))).toEqual({ kind: "refused", line: "paused", code: "shared_paused" });
  target.delete("a");
  expect(gate(world(target), stored("a")).kind).toBe("gone");
});
it("a receipt replay re-asks the delivery authorization: sharing removed after delivery returns the status and the reason, no text", () => {
  let sharing = true;
  const deps = world(new Map([["a", { id: "a", text: "stored plaintext" }]]), { authorize: () => sharing ? { ok: true as const } : { ok: false as const, code: "sharing_removed", line: "Helper is no longer shared with this team." } });
  const replay = () => gate(deps, stored("a"), "stored plaintext");
  expect(replay()).toMatchObject({ kind: "text", text: "stored plaintext" });
  sharing = false;
  const denied = replay();
  expect(denied).toEqual({ kind: "refused", line: "Helper is no longer shared with this team.", code: "sharing_removed" });
  expect(JSON.stringify(denied)).not.toContain("plaintext");
  // lineage withholding still applies to an authorized replay, and an unbound receipt keeps only that rule
  expect(gate(world(new Map()), { requestId: "req-1", lineageUnknown: true }, "stored plaintext")).toEqual({ kind: "withheld", line: "[withheld]" });
  expect(gate(world(new Map(), { ownUnsharedWork: () => true, authorize: () => { throw new Error("not asked"); } }), {}, "plain")).toEqual({ kind: "withheld", line: "[withheld]" });
});
const legacy = { id: "req-9", sourceThreadId: "t-src", toBotId: "b-peer" };
const rows: Record<string, { id: string; toBotId: string | null; rootThreadId: string }> = { "req-9": { id: "req-9", toBotId: "b-peer", rootThreadId: "t-src" } };
const find = { byId: (id: string) => rows[id] ?? null, byKey: (_key: string) => null };
it("a legacy shared-ask receipt (no requestId, request id exposed as the task id) is bound by that id and denied once sharing is removed", () => {
  const binding = resolveReceiptBinding(legacy, find);
  expect(binding).toEqual({ kind: "bound", requestId: "req-9" });
  const released = gate(world(new Map(), { ownUnsharedWork: () => true, authorize: () => ({ ok: false, code: "sharing_removed", line: "no longer shared" }) }), { ...(binding.kind === "bound" ? { requestId: binding.requestId } : {}) }, "stored plaintext");
  expect(released).toEqual({ kind: "refused", line: "no longer shared", code: "sharing_removed" });
});
it("a found request that is a different worker or conversation is a mismatch and never yields text", () => {
  const other = { byId: () => ({ id: "req-9", toBotId: "b-other", rootThreadId: "t-src" }), byKey: () => null };
  expect(resolveReceiptBinding(legacy, other)).toEqual({ kind: "mismatch" });
  const released = gate(world(new Map(), { ownUnsharedWork: () => true }), { binding: "mismatch" }, "stored plaintext");
  expect(released).toEqual({ kind: "refused", line: RECEIPT_ORIGIN_UNCONFIRMED_LINE, code: "origin_unconfirmed" });
  expect(JSON.stringify(released)).not.toContain("plaintext");
});
it("r26b: the receipt's own request id is resolved first, and a key that names a different request is a conflict, never a binding", () => {
  const a = { id: "req-9", toBotId: "b-peer", rootThreadId: "t-src" }, b = { id: "req-B", toBotId: "b-peer", rootThreadId: "t-src" };
  expect(resolveReceiptBinding(legacy, { byId: () => a, byKey: () => b })).toEqual({ kind: "mismatch" });                    // A's receipt is never bound to B through the key
  expect(resolveReceiptBinding(legacy, { byId: () => a, byKey: () => a })).toEqual({ kind: "bound", requestId: "req-9" });
  expect(resolveReceiptBinding(legacy, { byId: () => a, byKey: () => null })).toEqual({ kind: "bound", requestId: "req-9" });  // id first
  expect(resolveReceiptBinding(legacy, { byId: () => null, byKey: () => a })).toEqual({ kind: "bound", requestId: "req-9" });  // the key is only a fallback
});
it("an unbound receipt returns text only when its work is positively the owner's own unshared work", () => {
  expect(resolveReceiptBinding(legacy, { byId: () => null, byKey: () => null })).toEqual({ kind: "unbound" });
  const unknown = gate(world(new Map(), { ownUnsharedWork: () => false }), {}, "stored plaintext");
  expect(unknown).toMatchObject({ kind: "refused", code: "origin_unconfirmed" });
  expect(JSON.stringify(unknown)).not.toContain("plaintext");
  // worker text that names no stored message has had no message-level rule applied: withheld even for the owner's own work
  expect(gate(world(new Map(), { ownUnsharedWork: () => true }), {}, "stored plaintext")).toEqual({ kind: "withheld", line: "[withheld]" });
  // never for words a non-owner audience asked for
  expect(gate(world(new Map(), { ownUnsharedWork: () => true }), {}, "stored plaintext", true)).toMatchObject({ kind: "refused" });
});
