// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools S12: the job state machine (design 4.4). One `it` per row of the table, a fake clock, and the interruption cases (Astra AS8).
import { describe, expect, it } from "vitest";
import { PhoneJobs, REQUEST_DEADLINE_MS, type BotOutcome } from "./jobs.ts";
import type { PhoneAuthority } from "./authority.ts";
import { PHONE_ACTIONS, RESULT_MAX_BYTES, offerSchema, targetedAnswerSchema } from "../../shared/phone-jobs-contract.ts";

type Timer = { at: number; fn: () => void };
function makeRig() {
  let t = 1_000_000;
  let n = 0;
  const timers = new Map<number, Timer>();
  const parked: string[] = [];
  const withdrawn: string[] = [];
  const infos: any[] = [];
  let ids = 0;
  let tokens = 0;
  const j = new PhoneJobs({
    now: () => t,
    setTimer: (ms, fn) => { const id = ++n; timers.set(id, { at: t + ms, fn }); return () => { timers.delete(id); }; },
    push: { park: (job) => { infos.push(job); parked.push(job.operationId); }, withdraw: (job) => withdrawn.push(job.operationId) },
    ids: () => {
      const hex = (++ids).toString(16).padStart(12, "0");
      return `00000000-0000-4000-8000-${hex}`;
    },
    leaseToken: () => `lease${String(++tokens).padStart(38, "0")}`.padEnd(43, "x"),
  });
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      let next: [number, Timer] | undefined;
      for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      timers.delete(next[0]);
      t = Math.max(t, next[1].at);
      next[1].fn();
    }
    t = end;
  };
  return { j, advance, parked, withdrawn, infos, pendingTimers: () => timers.size };
}
let rig = makeRig();
const jobs = () => (rig = makeRig()).j;

const authority = (over: Partial<PhoneAuthority> = {}): PhoneAuthority => ({ threadId: "t1", turnId: "u1", generation: "g1", origin: "desktop", botId: "b1", issuedAt: 0, ...over });
const CAL_ARGS = { start: "2026-10-26T09:00:00Z", end: "2026-10-26T17:00:00Z" };
const req = (over: Record<string, unknown> = {}) => ({
  authority: authority(), deviceId: "d1", capability: "calendar" as const, action: "calendar.read", args: CAL_ARGS, say: "read your calendar for today",
  provider: { id: "claude", name: "Claude" }, phoneName: "Sean's iPhone", ...over,
}) as Parameters<PhoneJobs["request"]>[0];
const live = () => new AbortController().signal;
const OK_RESULT = { events: [], truncated: false };
const lease = (j: PhoneJobs, op: string, offerId: string, deviceId = "d1") => j.lease(deviceId, op, offerId, () => true);
const token = (a: ReturnType<PhoneJobs["lease"]>) => (a as { leaseToken: string }).leaseToken;
const first = async (j: PhoneJobs, deviceId = "d1") => (await j.poll(deviceId, live()))[0];
const settled = async (p: Promise<BotOutcome>): Promise<BotOutcome | "pending"> => Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), 5))]);

describe("revocation cutoff is the LEASED write (F6, F8)", () => {
  it("revoke one tick before the LEASED write reports did not run", async () => {
    const j = jobs(); const { operationId, outcome } = j.request(req());
    const [offer] = await j.poll("d1", new AbortController().signal);
    j.revokeFor({ deviceId: "d1" });
    expect(j.lease("d1", operationId, offer.offerId, () => true)).toEqual({ active: false });
    expect((await outcome).kind).toBe("did_not_run");
  });
  it("revoke one tick after the LEASED write reports may have run and withholds the result", async () => {
    const j = jobs(); const { operationId, outcome } = j.request(req());
    const [offer] = await j.poll("d1", new AbortController().signal);
    const lease = j.lease("d1", operationId, offer.offerId, () => true);
    expect(lease.active).toBe(true);
    j.revokeFor({ deviceId: "d1" });
    expect(j.result("d1", operationId, { leaseToken: (lease as any).leaseToken, ok: true, result: { events: [] } })).toBe(409);
    expect((await outcome).kind).toBe("may_have_run");
  });
});

describe("table 4.4, one case per row", () => {
  it("QUEUED + long poll from the phone: OFFERED, a card-shaped offer that matches the contract", async () => {
    const j = jobs(); const { operationId } = j.request(req());
    const offers = await j.poll("d1", live());
    expect(offers).toHaveLength(1);
    expect(offerSchema.safeParse(offers[0]).success).toBe(true);
    expect(offers[0]).toMatchObject({ operationId, capability: "calendar", action: "calendar.read", say: "read your calendar for today", provider: { id: "claude", name: "Claude" }, leaseMs: 45000 });
    expect(rig.parked).toEqual([]);
  });
  it("an idle long poll waits 20 s, answers empty, and a request during the wait is answered at once", async () => {
    const j = jobs();
    const idle = j.poll("d1", live());
    rig.advance(20000);
    expect(await idle).toEqual([]);
    const waiting = j.poll("d1", live());
    const { operationId } = j.request(req());
    const got = await waiting;
    expect(got.map((o) => o.operationId)).toEqual([operationId]);
    expect(rig.parked).toEqual([]);
  });
  it("an aborted poll answers empty", async () => {
    const j = jobs(); const ac = new AbortController();
    const p = j.poll("d1", ac.signal);
    ac.abort();
    expect(await p).toEqual([]);
  });
  it("QUEUED + 3 s with no poll: PARKED, one push to that one phone", async () => {
    const j = jobs(); const { operationId } = j.request(req());
    rig.advance(2999); expect(rig.parked).toEqual([]);
    rig.advance(1); expect(rig.parked).toEqual([operationId]);
    rig.advance(30000); expect(rig.parked).toEqual([operationId]);
  });
  it("the push layer sees the thread and the job deadline, and a leased job is not withdrawn", async () => {
    const j = jobs(); const { operationId } = j.request(req());
    rig.advance(3000);
    expect(rig.infos[0]).toMatchObject({ operationId, threadId: "t1", expiresAt: 1_000_000 + REQUEST_DEADLINE_MS });
    const offers = await j.poll("d1", live());
    j.lease("d1", operationId, offers[0].offerId, () => true);
    j.turnEndedAll();
    expect(rig.withdrawn).toEqual([]);
  });
  it("PARKED + app opened (poll): OFFERED", async () => {
    const j = jobs(); const { operationId } = j.request(req());
    rig.advance(3000);
    const offers = await j.poll("d1", live());
    expect(offers[0].operationId).toBe(operationId);
  });
  it("PARKED + app opened (targeted read by operationId and by eventRef): OFFERED, answered with the job", async () => {
    const j = jobs(); const { operationId } = j.request(req());
    rig.advance(3000);
    const a = j.byOperation("d1", operationId);
    expect(targetedAnswerSchema.safeParse(a).success).toBe(true);
    expect((a as any).jobs[0].operationId).toBe(operationId);
    const eventRef = (j as any).eventRefFor(operationId) as string;
    expect(eventRef).toMatch(/^[0-9a-f]{64}$/);
    expect((j.byEventRef("d1", eventRef) as any).jobs[0].operationId).toBe(operationId);
    expect(j.byEventRef("d1", "0".repeat(64))).toEqual({ handled: true, reason: "unknown" });
  });
  it("QUEUED, PARKED and OFFERED: 120 s from request is FAILED timeout, did not run, push withdrawn", async () => {
    for (const stage of ["queued", "parked", "offered"]) {
      const j = jobs(); const { operationId, outcome } = j.request(req());
      let spent = 0;
      if (stage === "parked") { rig.advance(3000); spent = 3000; }
      if (stage === "offered") await first(j);
      rig.advance(119999 - spent);
      expect(await settled(outcome)).toBe("pending");
      rig.advance(1);
      const o = await outcome;
      expect(o.kind).toBe("did_not_run");
      expect((o as any).line).toBe("Asked on your phone; it did not run. Open Murage on the phone and ask again.");
      expect(j.byOperation("d1", operationId)).toEqual({ handled: true, reason: "ended" });
      if (stage === "parked") expect(rig.withdrawn).toEqual([operationId]);
    }
  });
  it("OFFERED + Not now: FAILED declined", async () => {
    const j = jobs(); const { operationId, outcome } = j.request(req());
    const offer = await first(j);
    expect(j.decline("d1", operationId, offer.offerId)).toBe(true);
    expect(await outcome).toEqual({ kind: "declined", line: "Not allowed on the phone this time." });
    expect(j.decline("d1", operationId, offer.offerId)).toBe(false);
  });
  it("decline with a dead offerId or from another device changes nothing", async () => {
    const j = jobs(); const { operationId, outcome } = j.request(req());
    const offer = await first(j);
    expect(j.decline("d1", operationId, "00000000-0000-4000-8000-ffffffffffff")).toBe(false);
    expect(j.decline("d2", operationId, offer.offerId)).toBe(false);
    expect(await settled(outcome)).toBe("pending");
  });
  it("OFFERED + Allow, every check holds: LEASED with a lease token", async () => {
    const j = jobs(); const { operationId } = j.request(req());
    const offer = await first(j);
    const a = lease(j, operationId, offer.offerId);
    expect(a.active).toBe(true);
    expect(token(a)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const t = j.byOperation("d1", operationId);
    expect(t).toMatchObject({ leased: true });
    expect(targetedAnswerSchema.safeParse(t).success).toBe(true);
  });
  it("OFFERED + Allow, a check fails: { active: false }, nothing ran, 'The phone's access changed.'", async () => {
    const j = jobs(); const { operationId, outcome } = j.request(req());
    const offer = await first(j);
    expect(j.lease("d1", operationId, offer.offerId, () => false)).toEqual({ active: false });
    expect(await outcome).toEqual({ kind: "did_not_run", line: "The phone's access changed." });
    expect(j.byOperation("d1", operationId)).toEqual({ handled: true, reason: "revoked" });
  });
  it("a recheck that throws is a failed check", async () => {
    const j = jobs(); const { operationId, outcome } = j.request(req());
    const offer = await first(j);
    expect(j.lease("d1", operationId, offer.offerId, () => { throw new Error("x"); })).toEqual({ active: false });
    expect((await outcome).kind).toBe("did_not_run");
  });
  it("LEASED + revoke of any kind: REVOKED, a later result gets 409, the bot hears may have run", async () => {
    const j = jobs(); const { operationId, outcome } = j.request(req());
    const offer = await first(j); const a = lease(j, operationId, offer.offerId);
    expect(j.revokeFor({ botId: "b1", capabilities: ["calendar"] })).toBe(1);
    expect(await outcome).toEqual({ kind: "may_have_run", line: "May have run on the phone; read it back before repeating." });
    expect(j.result("d1", operationId, { leaseToken: token(a), ok: true, result: OK_RESULT })).toBe(409);
    expect(j.byOperation("d1", operationId)).toEqual({ handled: true, reason: "revoked" });
  });
  it("LEASED + result with the right token: DONE, the result and the phone name", async () => {
    const j = jobs(); const { operationId, outcome } = j.request(req());
    const offer = await first(j); const a = lease(j, operationId, offer.offerId);
    expect(j.result("d1", operationId, { leaseToken: token(a), ok: true, result: OK_RESULT })).toBe(200);
    expect(await outcome).toEqual({ kind: "done", result: OK_RESULT, phoneName: "Sean's iPhone" });
    expect(j.byOperation("d1", operationId)).toEqual({ handled: true, reason: "done" });
  });
  it("LEASED + wrong or missing token, unknown id, job not LEASED: 409 and discarded (F10)", async () => {
    const j = jobs(); const { operationId, outcome } = j.request(req());
    expect(j.result("d1", operationId, { leaseToken: "x".repeat(43), ok: true, result: OK_RESULT })).toBe(409); // not LEASED
    const offer = await first(j); const a = lease(j, operationId, offer.offerId);
    expect(j.result("d1", operationId, { leaseToken: "x".repeat(43), ok: true, result: OK_RESULT })).toBe(409);
    expect(j.result("d1", operationId, { ok: true, result: OK_RESULT })).toBe(409);
    expect(j.result("d1", operationId, null)).toBe(409);
    expect(j.result("d1", "00000000-0000-4000-8000-0000000000ff", { leaseToken: token(a), ok: true, result: OK_RESULT })).toBe(409);
    expect(j.result("d2", operationId, { leaseToken: token(a), ok: true, result: OK_RESULT })).toBe(409);
    expect(await settled(outcome)).toBe("pending");
    expect(j.result("d1", operationId, { leaseToken: token(a), ok: true, result: OK_RESULT })).toBe(200);
    expect(j.result("d1", operationId, { leaseToken: token(a), ok: true, result: OK_RESULT })).toBe(409); // a second result
  });
  it("LEASED + 45 s with no result: FAILED timeout, may have run (180 s for messages and calls)", async () => {
    const j = jobs(); const { operationId, outcome } = j.request(req());
    const offer = await first(j); lease(j, operationId, offer.offerId);
    rig.advance(44999); expect(await settled(outcome)).toBe("pending");
    rig.advance(1);
    expect((await outcome).kind).toBe("may_have_run");
    expect(j.byOperation("d1", operationId)).toEqual({ handled: true, reason: "ended" });
    for (const [tool, args] of [["phone_text_compose", { to: ["5550100"], body: "hi" }], ["phone_call_dial", { number: "5550100" }]] as const) {
      const k = jobs(); const spec = PHONE_ACTIONS[tool];
      const r = k.request(req({ capability: spec.capability, action: spec.action, args }));
      const o = await first(k);
      expect(o.leaseMs).toBe(180000);
      lease(k, r.operationId, o.offerId);
      rig.advance(179999); expect(await settled(r.outcome)).toBe("pending");
      rig.advance(1); expect((await r.outcome).kind).toBe("may_have_run");
    }
  });
  it("QUEUED, PARKED, OFFERED + turn ends: FAILED turn_ended, did not run, push withdrawn", async () => {
    for (const stage of ["queued", "parked", "offered"]) {
      const j = jobs(); const { operationId, outcome } = j.request(req());
      if (stage === "parked") rig.advance(3000);
      if (stage === "offered") await first(j);
      j.turnEnded("g1");
      expect((await outcome).kind).toBe("did_not_run");
      expect(j.byOperation("d1", operationId)).toEqual({ handled: true, reason: "ended" });
      if (stage === "parked") expect(rig.withdrawn).toEqual([operationId]);
    }
  });
  it("turnEnded touches only that generation", async () => {
    const j = jobs();
    const a = j.request(req()); const b = j.request(req({ authority: authority({ generation: "g2" }) }));
    j.turnEnded("g2");
    expect((await b.outcome).kind).toBe("did_not_run");
    expect(await settled(a.outcome)).toBe("pending");
  });
  it("LEASED + turn ends: FAILED turn_ended, may have run, a late result gets 409", async () => {
    const j = jobs(); const { operationId, outcome } = j.request(req());
    const offer = await first(j); const a = lease(j, operationId, offer.offerId);
    j.turnEnded("g1");
    expect((await outcome).kind).toBe("may_have_run");
    expect(j.result("d1", operationId, { leaseToken: token(a), ok: true, result: OK_RESULT })).toBe(409);
  });
  it("turnEndedForThread, turnEndedForBot and turnEndedAll end matching jobs", async () => {
    const j = jobs();
    const a = j.request(req({ deviceId: "d1" }));
    const b = j.request(req({ deviceId: "d2", authority: authority({ generation: "g2", threadId: "t2", botId: "b2" }) }));
    const c = j.request(req({ deviceId: "d3", authority: authority({ generation: "g3", threadId: "t3", botId: "b3" }) }));
    j.turnEndedForThread("t1"); expect((await a.outcome).kind).toBe("did_not_run");
    j.turnEndedForBot("b2"); expect((await b.outcome).kind).toBe("did_not_run");
    expect(await settled(c.outcome)).toBe("pending");
    j.turnEndedAll(); expect((await c.outcome).kind).toBe("did_not_run");
  });
  it("QUEUED, PARKED, OFFERED + revoke: REVOKED, the open poll answers empty, a lease in flight gets { active: false }, push withdrawn", async () => {
    for (const stage of ["queued", "parked", "offered"]) {
      const j = jobs(); const { operationId, outcome } = j.request(req());
      let offerId = "00000000-0000-4000-8000-0000000000aa";
      if (stage === "parked") rig.advance(3000);
      if (stage === "offered") offerId = (await first(j)).offerId;
      expect(j.revokeFor({ deviceId: "d1" })).toBe(1);
      expect(await outcome).toEqual({ kind: "did_not_run", line: "The phone's access changed." });
      expect(j.lease("d1", operationId, offerId, () => true)).toEqual({ active: false });
      expect(j.byOperation("d1", operationId)).toEqual({ handled: true, reason: "revoked" });
      if (stage === "parked") expect(rig.withdrawn).toEqual([operationId]);
    }
  });
  it("shutdown: every non-terminal job is FAILED offline, never re-sent; did not run if never leased, else may have run", async () => {
    const j = jobs();
    const a = j.request(req({ deviceId: "d1" })); const b = j.request(req({ deviceId: "d2" }));
    const ob = await first(j, "d2"); lease(j, b.operationId, ob.offerId, "d2");
    const waiting = j.poll("d3", live());
    j.shutdown();
    expect((await a.outcome).kind).toBe("did_not_run");
    expect((await b.outcome).kind).toBe("may_have_run");
    expect(await waiting).toEqual([]);
    const gone = new AbortController(); gone.abort();
    expect(await j.poll("d1", gone.signal)).toEqual([]);
  });
});

describe("result mapping (BotOutcome)", () => {
  const leased = async (over: Record<string, unknown> = {}) => {
    const j = jobs(); const r = j.request(req(over));
    const o = await first(j); const a = lease(j, r.operationId, o.offerId);
    return { j, ...r, tok: token(a) };
  };
  it("ok true with a result that fails actionResultSchema: 422, FAILED invalid_result, may have run", async () => {
    const { j, operationId, outcome, tok } = await leased();
    expect(j.result("d1", operationId, { leaseToken: tok, ok: true, result: { events: "nope" } })).toBe(422);
    expect((await outcome).kind).toBe("may_have_run");
  });
  it("a body that is not a result shape: 422, may have run", async () => {
    const { j, operationId, outcome, tok } = await leased();
    expect(j.result("d1", operationId, { leaseToken: tok, ok: "yes" })).toBe(422);
    expect((await outcome).kind).toBe("may_have_run");
  });
  it("ok false denied: 200, did not run", async () => {
    const { j, operationId, outcome, tok } = await leased();
    expect(j.result("d1", operationId, { leaseToken: tok, ok: false, code: "denied" })).toBe(200);
    expect((await outcome).kind).toBe("did_not_run");
  });
  it("ok false unsupported: 200, did not run", async () => {
    const { j, operationId, outcome, tok } = await leased();
    expect(j.result("d1", operationId, { leaseToken: tok, ok: false, code: "unsupported" })).toBe(200);
    expect((await outcome).kind).toBe("did_not_run");
  });
  it("ok false declined: 200, the declined outcome", async () => {
    const { j, operationId, outcome, tok } = await leased();
    expect(j.result("d1", operationId, { leaseToken: tok, ok: false, code: "declined" })).toBe(200);
    expect((await outcome).kind).toBe("declined");
  });
  it("ok false too_large and invalid_result: 200, may have run", async () => {
    for (const code of ["too_large", "invalid_result"] as const) {
      const { j, operationId, outcome, tok } = await leased();
      expect(j.result("d1", operationId, { leaseToken: tok, ok: false, code })).toBe(200);
      expect((await outcome).kind).toBe("may_have_run");
    }
  });
  it("a result over 256 KB: 413, FAILED too_large, may have run (F14)", async () => {
    const { j, operationId, outcome, tok } = await leased();
    const big = { events: [], truncated: false, pad: "x".repeat(RESULT_MAX_BYTES) };
    expect(j.result("d1", operationId, { leaseToken: tok, ok: true, result: big })).toBe(413);
    expect((await outcome).kind).toBe("may_have_run");
  });
});

describe("one job per device, device isolation, no re-offer of LEASED", () => {
  it("a job from device A is invisible to device B (F19)", async () => {
    const j = jobs(); const { operationId } = j.request(req());
    expect(await j.poll("d2", (() => { const ac = new AbortController(); setTimeout(() => ac.abort(), 1); return ac.signal; })())).toEqual([]);
    expect(j.byOperation("d2", operationId)).toEqual({ handled: true, reason: "unknown" });
    expect(j.byEventRef("d2", (j as any).eventRefFor(operationId))).toEqual({ handled: true, reason: "unknown" });
    expect(j.decline("d2", operationId, "00000000-0000-4000-8000-0000000000aa")).toBe(false);
    expect(j.lease("d2", operationId, "00000000-0000-4000-8000-0000000000aa", () => true)).toEqual({ active: false });
    expect(j.byOperation("d1", "00000000-0000-4000-8000-0000000000ee")).toEqual({ handled: true, reason: "unknown" });
  });
  it("LEASED is never re-offered, and a second job waits while one is in flight", async () => {
    const j = jobs(); const a = j.request(req()); const b = j.request(req({ action: "calendar.read" }));
    const oa = await first(j); expect(oa.operationId).toBe(a.operationId);
    lease(j, a.operationId, oa.offerId);
    const ac = new AbortController(); const p = j.poll("d1", ac.signal); ac.abort();
    expect(await p).toEqual([]);
    expect(j.byOperation("d1", b.operationId)).toEqual({ handled: true, reason: "unknown" });
    expect(j.lease("d1", a.operationId, oa.offerId, () => true)).toEqual({ active: false });
    const ta = j.byOperation("d1", a.operationId);
    expect(ta).toMatchObject({ leased: true });
  });
  it("after the first job ends the second is offered", async () => {
    const j = jobs(); const a = j.request(req()); const b = j.request(req());
    const oa = await first(j); const la = lease(j, a.operationId, oa.offerId);
    j.result("d1", a.operationId, { leaseToken: token(la), ok: true, result: OK_RESULT });
    expect((await first(j)).operationId).toBe(b.operationId);
  });
  it("requeue gives a new offerId (F23) and the old one is dead", async () => {
    const j = jobs(); const { operationId } = j.request(req());
    const a = await first(j);
    j.requeue("d1");
    const b = await first(j);
    expect(b.operationId).toBe(operationId);
    expect(b.offerId).not.toBe(a.offerId);
    expect(j.lease("d1", operationId, a.offerId, () => true)).toEqual({ active: false });
    expect(lease(j, operationId, b.offerId).active).toBe(true);
  });
  it("requeue restarts the 3 s park clock for the job it put back", async () => {
    const j = jobs(); const { operationId } = j.request(req());
    await first(j); j.requeue("d1");
    expect(rig.parked).toEqual([]);
    rig.advance(3000);
    expect(rig.parked).toEqual([operationId]);
  });
  it("revokeFor scopes by device, bot and capability", async () => {
    const j = jobs();
    j.request(req({ deviceId: "d1" }));
    j.request(req({ deviceId: "d2", capability: "reminders", action: "reminders.read", args: {} }));
    j.request(req({ deviceId: "d3", authority: authority({ generation: "g9", botId: "b9" }) }));
    expect(j.revokeFor({ botId: "b1", capabilities: ["contacts"] })).toBe(0);
    expect(j.revokeFor({ botId: "b1", capabilities: ["reminders"] })).toBe(1);
    expect(j.revokeFor({ deviceId: "d3" })).toBe(1);
    expect(j.revokeFor({ botId: "b1" })).toBe(1);
    expect(j.revokeFor({ botId: "b1" })).toBe(0);
  });
});

describe("interruptions (Astra AS8)", () => {
  it("late lease answer after backgrounding: still LEASED, a denied result gives 200 and did not run", async () => {
    const j = jobs(); const { operationId, outcome } = j.request(req());
    const o = await first(j); const a = lease(j, operationId, o.offerId);
    expect(a.active).toBe(true);
    j.requeue("d1");
    expect(j.byOperation("d1", operationId)).toMatchObject({ leased: true });
    expect(j.result("d1", operationId, { leaseToken: token(a), ok: false, code: "denied" })).toBe(200);
    expect((await outcome).kind).toBe("did_not_run");
  });
  it("late lease answer after backgrounding with no result: the 45 s timer gives may have run", async () => {
    const j = jobs(); const { operationId, outcome } = j.request(req());
    const o = await first(j); lease(j, operationId, o.offerId);
    j.requeue("d1");
    rig.advance(45000);
    expect((await outcome).kind).toBe("may_have_run");
  });
  it("lost foreground-off then reopen: a fresh poll re-offers with offerId B, lease(A) is inactive and the job stays OFFERED, lease(B) is active", async () => {
    const j = jobs(); const { operationId } = j.request(req());
    const A = await first(j);
    const B = await first(j);
    expect(B.operationId).toBe(operationId);
    expect(B.offerId).not.toBe(A.offerId);
    expect(j.lease("d1", operationId, A.offerId, () => true)).toEqual({ active: false });
    expect((j.byOperation("d1", operationId) as any).jobs[0].operationId).toBe(operationId); // still offerable
    const C = (j.byOperation("d1", operationId) as any).jobs[0];
    expect(j.lease("d1", operationId, B.offerId, () => true)).toEqual({ active: false }); // targeted read re-offered again, B is dead too
    expect(lease(j, operationId, C.offerId).active).toBe(true);
  });
  it("a targeted read while OFFERED re-offers with a new offerId", async () => {
    const j = jobs(); const { operationId } = j.request(req());
    const A = await first(j);
    const t = j.byOperation("d1", operationId) as any;
    expect(t.jobs[0].offerId).not.toBe(A.offerId);
  });
  it("requeue never touches a LEASED job", async () => {
    const j = jobs(); const { operationId } = j.request(req());
    const o = await first(j); lease(j, operationId, o.offerId);
    j.requeue("d1");
    expect(await j.poll("d1", (() => { const ac = new AbortController(); ac.abort(); return ac.signal; })())).toEqual([]);
    expect(j.byOperation("d1", operationId)).toMatchObject({ leased: true });
  });
  it("abrupt restart after LEASED: a new PhoneJobs has no job, the old one's shutdown said may have run", async () => {
    const j = jobs(); const { operationId, outcome } = j.request(req());
    const o = await first(j); const a = lease(j, operationId, o.offerId);
    j.shutdown();
    expect((await outcome).kind).toBe("may_have_run");
    const fresh = jobs();
    expect(fresh.result("d1", operationId, { leaseToken: token(a), ok: true, result: OK_RESULT })).toBe(409);
    expect(fresh.byOperation("d1", operationId)).toEqual({ handled: true, reason: "unknown" });
  });
});

describe("S14 additions", () => {
  it("revokeFor for a device answers its open long poll at once, and a revoke for another scope does not", async () => {
    const j = jobs();
    const waiting = j.poll("d1", live());
    const other = j.poll("d2", live());
    j.revokeFor({ botId: "nobody" });
    expect(await Promise.race([waiting, new Promise((r) => setTimeout(() => r("open"), 5))])).toBe("open");
    j.revokeFor({ deviceId: "d1" });
    expect(await waiting).toEqual([]);
    expect(await Promise.race([other, new Promise((r) => setTimeout(() => r("open"), 5))])).toBe("open");
  });
  it("detail names a job to its own device only", () => {
    const j = jobs(); const { operationId } = j.request(req());
    expect(j.detail("d1", operationId)).toMatchObject({ action: "calendar.read", capability: "calendar", phoneName: "Sean's iPhone", state: "QUEUED" });
    expect(j.detail("d2", operationId)).toBeNull();
    expect(j.detail("d1", "nope")).toBeNull();
  });
});
