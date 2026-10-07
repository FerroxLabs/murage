import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { PushStore, initializeMobilePush, type PushEventRow } from "./mobile-push-store.ts";
import { respondFromPush, type RespondDeps } from "./mobile-push-respond.ts";

const B = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
function setup(over: Partial<RespondDeps> = {}, row: Partial<PushEventRow> = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  initializeMobilePush(db);
  const store = new PushStore(db);
  store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
  store.insertEvent({ eventRef: "a".repeat(64), bindingId: B, kind: "approval", category: "approval", botId: "lena", threadId: "t1", requestId: "req-1",
    messageId: "m1", collapseKey: "c".repeat(32), threadGroup: "g".repeat(16), revision: 1, timeSensitive: true, resolvedBy: null,
    createdAt: 0, expiresAt: 10_000, holdUntil: 0, state: "sent", attempts: 1, nextAttemptAt: 0, ...row });
  const deps: RespondDeps = { store, now: () => 5000, visible: () => true, card: () => ({ pending: true }), liveRating: () => "low", answer: vi.fn(async (_t, _r, d) => (d === "allow" ? "allowed-once" : "rejected")), ...over };
  return { db, store, deps };
}
const body = (decision: "allow" | "deny", revision = 1) => ({ requestId: "req-1", decision, revision });
const respond = (deps: RespondDeps, b: unknown, deviceId = "d1") => respondFromPush({ deviceId, bindingId: B, body: b }, deps);

describe("respondFromPush", () => {
  it("allows a low-risk approval once", async () => {
    const { deps, store } = setup();
    store.rateRisk("t1", "req-1", "low", 1, 1);
    expect(await respond(deps, body("allow"))).toEqual({ status: 200, body: { ok: true, outcome: "allowed-once" } });
    expect(deps.answer).toHaveBeenCalledWith("t1", "req-1", "allow");
  });

  it("refuses allow when the request was never rated", async () => {
    const { deps } = setup();
    expect((await respond(deps, body("allow"))).status).toBe(403);
    expect(deps.answer).not.toHaveBeenCalled();
  });

  it("refuses allow for a risky one, and a refused allow does not use up the decision", async () => {
    const { deps, store } = setup();
    store.rateRisk("t1", "req-1", "risky", 1, 1);
    expect(await respond(deps, body("allow"))).toEqual({ status: 403, body: { code: "step_up", error: "Open Murage to allow this." } });
    expect((await respond(deps, body("deny"))).status).toBe(200);
  });

  it("refuses a push Allow when the live rating is no longer low, while Deny still works", async () => {
    for (const live of ["risky", "unrated"] as const) {
      const { deps, store } = setup({ liveRating: () => live });
      store.rateRisk("t1", "req-1", "low", 1, 1);
      expect(await respond(deps, body("allow"))).toEqual({ status: 403, body: { code: "step_up", error: "Open Murage to allow this." } });
      expect(deps.answer).not.toHaveBeenCalled();
      expect(await respond(deps, body("deny"))).toEqual({ status: 200, body: { ok: true, outcome: "rejected" } });
    }
  });

  it("a thread hidden since the push neither records nor executes the answer (B7)", async () => {
    const { deps, store } = setup({ visible: () => false });
    store.rateRisk("t1", "req-1", "low", 1, 1);
    expect(await respond(deps, body("deny"))).toMatchObject({ status: 404, body: { code: "unavailable" } });
    expect(await respond(deps, body("allow"))).toMatchObject({ status: 404, body: { code: "unavailable" } });
    expect(deps.answer).not.toHaveBeenCalled();
    // nothing was recorded: once the thread is visible again the first answer still counts
    expect(store.decide("t1", "req-1", "deny", "d1", 1, 5000)).toBe(true);
  });

  it("allows deny whatever the rating", async () => {
    const { deps } = setup();
    expect(await respond(deps, body("deny"))).toEqual({ status: 200, body: { ok: true, outcome: "rejected" } });
  });

  it("a second decision is rejected cleanly", async () => {
    const { deps } = setup();
    await respond(deps, body("deny"));
    expect(await respond(deps, body("deny"))).toEqual({ status: 409, body: { code: "already_answered", error: "This was already answered." } });
    expect(deps.answer).toHaveBeenCalledTimes(1);
  });

  it("a decision for an older revision is stale", async () => {
    const { deps } = setup({}, { revision: 2 });
    expect((await respond(deps, body("deny", 1))).body).toMatchObject({ code: "stale" });
  });

  it("answered elsewhere since the push is already answered", async () => {
    const { deps } = setup({ card: () => ({ pending: false }) });
    expect((await respond(deps, body("deny"))).body).toMatchObject({ code: "already_answered" });
  });

  it("a request never pushed to this binding, or expired, is unavailable", async () => {
    const { deps } = setup({ now: () => 20_000 });
    expect((await respond(deps, body("deny"))).status).toBe(404);
    const other = setup();
    expect((await respond(other.deps, { requestId: "req-9", decision: "deny", revision: 1 })).status).toBe(404);
  });

  it("a question is answered in the app", async () => {
    const { deps } = setup({}, { kind: "question", category: "question" });
    expect((await respond(deps, body("deny"))).body).toMatchObject({ code: "not_supported" });
  });

  it("a body with anything extra is refused before it is read further", async () => {
    const { deps } = setup();
    expect((await respond(deps, { ...body("deny"), allowForTask: true })).status).toBe(400);
  });

  // H9 fix round 1 (spec over brief): a failed answer() is never reported as
  // success. The decision stays recorded (it may have landed before the
  // throw), the phone gets 502 unavailable, and content-free lines are
  // logged: the decision itself, then the failure.
  it("an answer that throws keeps the decision, reports 502 unavailable, and logs no content", async () => {
    const log = vi.fn();
    const { deps, db } = setup({ log, answer: vi.fn(async () => { throw new TypeError("engine gone t1 req-1 murage_pr_secret"); }) });
    expect(await respond(deps, body("deny"))).toEqual({ status: 502, body: { code: "unavailable", error: "That did not finish. Try again, or open Murage to answer." } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM push_decisions").get()).toEqual({ n: 1 });
    // One line for the decision, one for the failure.
    expect(log).toHaveBeenCalledTimes(2);
    const [decisionLine, failureLine] = log.mock.calls.map((call) => String(call[0]));
    expect(decisionLine).toContain("deny");
    expect(failureLine).toContain("TypeError");
    for (const line of [decisionLine, failureLine]) {
      for (const leak of ["t1", "req-1", "d1", "murage_pr", "engine gone", "lena", B]) expect(line).not.toContain(leak);
    }
  });

  // RES-002: the decision row is the first-wins guard and stays, but a thrown
  // answer() marks it unfinished, so a retry is not told "already answered".
  it("a retry after a thrown answer runs the answer again instead of 409 already_answered", async () => {
    const answer = vi.fn(async (_t: string, _r: string, d: "allow" | "deny") => (d === "allow" ? "allowed-once" : "rejected"));
    answer.mockRejectedValueOnce(new Error("engine gone"));
    const { deps, db } = setup({ log: vi.fn(), answer });
    expect((await respond(deps, body("deny"))).status).toBe(502);
    expect(await respond(deps, body("deny"))).toEqual({ status: 200, body: { ok: true, outcome: "rejected" } });
    expect(answer).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM push_decisions").get()).toEqual({ n: 1 });
    // Once it finished, the next one is an ordinary duplicate.
    expect((await respond(deps, body("deny"))).body).toMatchObject({ code: "already_answered" });
    expect(answer).toHaveBeenCalledTimes(2);
  });

  it("an Allow retry after a thrown Allow stays low-only and re-reads the live rating", async () => {
    let rating: "low" | "risky" = "low";
    const answer = vi.fn(async () => "allowed-once");
    answer.mockRejectedValueOnce(new Error("x"));
    const { deps, store } = setup({ log: vi.fn(), answer, liveRating: () => rating });
    store.rateRisk("t1", "req-1", "low", 1, 1);
    expect((await respond(deps, body("allow"))).status).toBe(502);
    rating = "risky";
    expect(await respond(deps, body("allow"))).toMatchObject({ status: 403, body: { code: "step_up" } });
    expect(answer).toHaveBeenCalledTimes(1);
    rating = "low";
    expect((await respond(deps, body("allow"))).status).toBe(200);
  });

  it("a Deny is never held back by an unfinished Allow, but an Allow after an unfinished Deny is not run", async () => {
    const answer = vi.fn(async (_t: string, _r: string, d: "allow" | "deny") => (d === "allow" ? "allowed-once" : "rejected"));
    answer.mockRejectedValueOnce(new Error("x"));
    const a = setup({ log: vi.fn(), answer });
    a.store.rateRisk("t1", "req-1", "low", 1, 1);
    expect((await respond(a.deps, body("allow"))).status).toBe(502);
    expect(await respond(a.deps, body("deny"))).toEqual({ status: 200, body: { ok: true, outcome: "rejected" } });

    const answer2 = vi.fn(async () => "rejected");
    answer2.mockRejectedValueOnce(new Error("x"));
    const b = setup({ log: vi.fn(), answer: answer2 });
    b.store.rateRisk("t1", "req-1", "low", 1, 1);
    expect((await respond(b.deps, body("deny"))).status).toBe(502);
    expect(await respond(b.deps, body("allow"))).toMatchObject({ status: 409, body: { code: "unfinished" } });
    expect(answer2).toHaveBeenCalledTimes(1);
  });

  // RES-002 retry identity: an Allow retry belongs to the phone and the
  // notification revision that made the first attempt.
  it("an Allow retry from another device is refused and leaves the row alone", async () => {
    const answer = vi.fn(async () => "allowed-once");
    answer.mockRejectedValueOnce(new Error("x"));
    const { deps, store, db } = setup({ log: vi.fn(), answer });
    store.rateRisk("t1", "req-1", "low", 1, 1);
    expect((await respond(deps, body("allow"), "d1")).status).toBe(502);
    expect(await respond(deps, body("allow"), "d2")).toMatchObject({ status: 409, body: { code: "unfinished" } });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT device_id, revision, outcome FROM push_decisions").get()).toEqual({ device_id: "d1", revision: 1, outcome: "unknown" });
    expect((await respond(deps, body("allow"), "d1")).status).toBe(200);
  });

  it("an Allow retry on a newer notification revision is refused and leaves the row alone", async () => {
    const answer = vi.fn(async () => "allowed-once");
    answer.mockRejectedValueOnce(new Error("x"));
    const { deps, store, db } = setup({ log: vi.fn(), answer });
    store.rateRisk("t1", "req-1", "low", 1, 1);
    expect((await respond(deps, body("allow", 1))).status).toBe(502);
    store.insertEvent({ eventRef: "b".repeat(64), bindingId: B, kind: "approval", category: "approval", botId: "lena", threadId: "t1", requestId: "req-1",
      messageId: "m1", collapseKey: "c".repeat(32), threadGroup: "g".repeat(16), revision: 2, timeSensitive: true, resolvedBy: null,
      createdAt: 0, expiresAt: 10_000, holdUntil: 0, state: "sent", attempts: 1, nextAttemptAt: 0 });
    store.rateRisk("t1", "req-1", "low", 1, 2);
    expect(await respond(deps, body("allow", 2))).toMatchObject({ status: 409, body: { code: "unfinished" } });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT device_id, revision, outcome FROM push_decisions").get()).toEqual({ device_id: "d1", revision: 1, outcome: "unknown" });
  });

  it("a Deny from another device after an unfinished Allow is accepted and records that device and revision", async () => {
    const answer = vi.fn(async (_t: string, _r: string, d: "allow" | "deny") => (d === "allow" ? "allowed-once" : "rejected"));
    answer.mockRejectedValueOnce(new Error("x"));
    const { deps, store, db } = setup({ log: vi.fn(), answer });
    store.rateRisk("t1", "req-1", "low", 1, 1);
    expect((await respond(deps, body("allow", 1), "d1")).status).toBe(502);
    store.insertEvent({ eventRef: "b".repeat(64), bindingId: B, kind: "approval", category: "approval", botId: "lena", threadId: "t1", requestId: "req-1",
      messageId: "m1", collapseKey: "c".repeat(32), threadGroup: "g".repeat(16), revision: 2, timeSensitive: true, resolvedBy: null,
      createdAt: 0, expiresAt: 10_000, holdUntil: 0, state: "sent", attempts: 1, nextAttemptAt: 0 });
    expect(await respond(deps, body("deny", 2), "d2")).toEqual({ status: 200, body: { ok: true, outcome: "rejected" } });
    expect(db.prepare("SELECT decision, device_id, revision FROM push_decisions").get()).toEqual({ decision: "deny", device_id: "d2", revision: 2 });
  });

  // RES-007: an unfinished Deny answers "unfinished" before any step-up or
  // risk check, and does not consume or change the decision.
  it("an Allow after an unfinished Deny answers 409 unfinished on risky, unrated and scoped cards", async () => {
    const cases: Array<{ name: string; over: Partial<RespondDeps>; rate: "low" | "risky" | null }> = [
      { name: "risky", over: {}, rate: "risky" },
      { name: "unrated", over: {}, rate: null },
      { name: "scoped", over: { card: () => ({ pending: true, scope: "computer" }) }, rate: "low" },
      { name: "live risky", over: { liveRating: () => "risky" }, rate: "low" },
    ];
    for (const c of cases) {
      const answer = vi.fn(async () => "rejected");
      answer.mockRejectedValueOnce(new Error("x"));
      const denyCard: RespondDeps["card"] = () => ({ pending: true });
      const first = setup({ log: vi.fn(), answer, card: denyCard });
      // The Deny runs with an ordinary card, then the Allow meets the case's checks.
      if (c.rate) first.store.rateRisk("t1", "req-1", c.rate, 1, 1);
      expect((await respond(first.deps, body("deny"))).status).toBe(502);
      const allowDeps = { ...first.deps, ...c.over };
      expect(await respond(allowDeps, body("allow")), c.name).toMatchObject({ status: 409, body: { code: "unfinished" } });
      expect(first.db.prepare("SELECT decision, outcome FROM push_decisions").get(), c.name).toEqual({ decision: "deny", outcome: "unknown" });
      expect(answer).toHaveBeenCalledTimes(1);
    }
  });

  it("two retries at once run the answer once", async () => {
    const answer = vi.fn(async () => "rejected");
    answer.mockRejectedValueOnce(new Error("x"));
    const { deps } = setup({ log: vi.fn(), answer });
    await respond(deps, body("deny"));
    const results = await Promise.all([respond(deps, body("deny")), respond(deps, body("deny"))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(answer).toHaveBeenCalledTimes(2);
  });

  it("an answer that rejects with a non-Error is handled the same way", async () => {
    const log = vi.fn();
    const { deps } = setup({ log, answer: () => Promise.reject("req-1 t1") });
    expect((await respond(deps, body("deny"))).body).toEqual({ code: "unavailable", error: "That did not finish. Try again, or open Murage to answer." });
    for (const call of log.mock.calls) {
      const line = String(call[0]);
      expect(line).not.toContain("req-1");
      expect(line).not.toContain("t1");
    }
  });

  it("an answer that throws synchronously is handled the same way", async () => {
    const log = vi.fn();
    const { deps } = setup({ log, answer: () => { throw new RangeError("x"); } });
    expect((await respond(deps, body("deny"))).status).toBe(502);
    expect(String(log.mock.calls[1][0])).toContain("RangeError");
  });

  // The decision itself is logged content-free, independent of whether
  // answer() then succeeds — moss-approval-bug.md found no record anywhere
  // of which push decision took the call down.
  it("logs the decision content-free on an ordinary allow or deny", async () => {
    const log = vi.fn();
    const { deps, store } = setup({ log });
    store.rateRisk("t1", "req-1", "low", 1, 1);
    expect(await respond(deps, body("allow"))).toMatchObject({ status: 200 });
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain("allow");
    expect(line).toMatch(/thread=[0-9a-f]{12}/);
    for (const leak of ["t1", "req-1", "d1", B]) expect(line).not.toContain(leak);

    const again = setup({ log });
    expect(await respond(again.deps, body("deny"))).toMatchObject({ status: 200 });
    const denyLine = String(log.mock.calls[1][0]);
    expect(denyLine).toContain("deny");
  });

  // Controller additions: concurrency and exact wire shapes.
  it("two phones answering at once: exactly one wins, answer() runs once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const answer = vi.fn(async (_t: string, _r: string, d: "allow" | "deny") => { await gate; return d === "allow" ? "allowed-once" : "rejected"; });
    const { deps, store } = setup({ answer });
    store.rateRisk("t1", "req-1", "low", 1, 1);
    const first = respond(deps, body("allow"), "d1");
    const second = respond(deps, body("deny"), "d2");
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body).toEqual({ code: "already_answered", error: "This was already answered." });
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it("many concurrent answers still produce one decision row", async () => {
    const { deps, store, db } = setup();
    store.rateRisk("t1", "req-1", "low", 1, 1);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => respond(deps, body(i % 2 ? "allow" : "deny"), `d${i}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(deps.answer).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM push_decisions").get()).toEqual({ n: 1 });
  });

  it("the decision is recorded before answer() is called", async () => {
    let seen: unknown;
    const { db, deps } = setup({ answer: vi.fn(async () => { seen = db.prepare("SELECT decision, device_id, revision FROM push_decisions").get(); return "rejected"; }) });
    await respond(deps, body("deny"));
    expect(seen).toEqual({ decision: "deny", device_id: "d1", revision: 1 });
  });

  it("a stale revision is exactly 409 stale and records nothing", async () => {
    const { deps, store, db } = setup({}, { revision: 2 });
    store.rateRisk("t1", "req-1", "low", 1, 1);
    expect(await respond(deps, body("allow", 1))).toEqual({ status: 409, body: { code: "stale", error: "This changed since the notification. Open Murage to answer." } });
    expect(deps.answer).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM push_decisions").get()).toEqual({ n: 0 });
  });

  it("after the desk answered, even a low-risk allow is 409 already_answered and records nothing", async () => {
    const { deps, store, db } = setup({ card: () => ({ pending: false }) });
    store.rateRisk("t1", "req-1", "low", 1, 1);
    expect(await respond(deps, body("allow"))).toEqual({ status: 409, body: { code: "already_answered", error: "This was already answered." } });
    expect(deps.answer).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM push_decisions").get()).toEqual({ n: 0 });
  });

  it("a card that is gone counts as already answered", async () => {
    const { deps } = setup({ card: () => null });
    expect((await respond(deps, body("deny"))).body).toMatchObject({ code: "already_answered" });
    expect(deps.answer).not.toHaveBeenCalled();
  });

  it("an unrated allow is exactly 403 step_up and a later deny still works", async () => {
    const { deps } = setup();
    expect(await respond(deps, body("allow"))).toEqual({ status: 403, body: { code: "step_up", error: "Open Murage to allow this." } });
    expect(await respond(deps, body("deny"))).toEqual({ status: 200, body: { ok: true, outcome: "rejected" } });
  });

  it("a resolved event is already answered", async () => {
    const { deps } = setup({}, { category: "resolved" });
    expect((await respond(deps, body("deny"))).body).toMatchObject({ code: "already_answered" });
  });

  it("another binding's request is unavailable", async () => {
    const { deps } = setup();
    expect((await respondFromPush({ deviceId: "d1", bindingId: "00000000-0000-4000-8000-000000000000", body: body("deny") }, deps)).status).toBe(404);
    expect(deps.answer).not.toHaveBeenCalled();
  });

  // H9 fix round 1: only an event actually sent to this phone can be answered.
  it.each(["held", "pending", "exhausted", "dropped"] as const)("an event in state %s is unavailable and records nothing", async (state) => {
    const { deps, store, db } = setup({}, { state });
    store.rateRisk("t1", "req-1", "low", 1, 1);
    expect(await respond(deps, body("deny"))).toEqual({ status: 404, body: { code: "unavailable", error: "This request is no longer available. Open Murage to see what is waiting." } });
    expect((await respond(deps, body("allow"))).status).toBe(404);
    expect(deps.answer).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM push_decisions").get()).toEqual({ n: 0 });
  });

  // H9 fix round 1: the rating belongs to the revision it was made for.
  it("a low rating for an older revision counts as unrated for the newer one", async () => {
    const { deps, store } = setup({}, { revision: 2 });
    store.rateRisk("t1", "req-1", "low", 1, 1);
    expect(await respond(deps, body("allow", 2))).toEqual({ status: 403, body: { code: "step_up", error: "Open Murage to allow this." } });
    expect(deps.answer).not.toHaveBeenCalled();
    store.rateRisk("t1", "req-1", "low", 2, 2);
    expect((await respond(deps, body("allow", 2))).status).toBe(200);
  });

  it("a rating recorded without a revision never allows from the lock screen", async () => {
    const { deps, store } = setup();
    store.rateRisk("t1", "req-1", "low", 1);
    expect((await respond(deps, body("allow"))).status).toBe(403);
  });

  it("a risky rating for this revision is refused even though the push went out as approval", async () => {
    const { deps, store } = setup();
    store.rateRisk("t1", "req-1", "risky", 1, 1);
    expect((await respond(deps, body("allow"))).body).toMatchObject({ code: "step_up" });
    expect(deps.answer).not.toHaveBeenCalled();
  });

  it("the exact expiry moment is unavailable; one millisecond before still answers", async () => {
    const at = setup({ now: () => 10_000 });
    expect((await respond(at.deps, body("deny"))).status).toBe(404);
    expect(at.deps.answer).not.toHaveBeenCalled();
    const before = setup({ now: () => 9_999 });
    expect((await respond(before.deps, body("deny"))).status).toBe(200);
  });

  it("a low-rated approval-open can be allowed from the lock screen", async () => {
    const { deps, store } = setup({}, { category: "approval-open" });
    store.rateRisk("t1", "req-1", "low", 1, 1);
    expect(await respond(deps, body("allow"))).toEqual({ status: 200, body: { ok: true, outcome: "allowed-once" } });
  });
});
