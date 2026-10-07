// The push hooks in index.ts, pinned by their position the way
// index.test.ts pins buildNotification("turn-failed"): the outbox must see
// only what the preference filter passed, and every rating, resolution and
// route must be where the plan put it. Below the source pins: the revision
// the outbox rates is the revision respond checks (H9 re-review Concern 1),
// and a harness booted with push off starts, serves presence, and refuses
// enrolment with push_off.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { PushOutbox, type OutboxWorld } from "./mobile-push-outbox.ts";
import { respondFromPush } from "./mobile-push-respond.ts";
import { AnsweredWhere, createPushWarn } from "./mobile-push-hooks.ts";
import { pushRiskFor, ratePushRevision } from "./mobile-push-risk.ts";
import { PushStore, initializeMobilePush } from "./mobile-push-store.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const notifyBody = source.slice(source.indexOf("function notify(notification"), source.indexOf("/** Delivery is best-effort and only for an approval"));

describe("push wiring in the harness", () => {
  it("enqueues after applyNotificationPreferences, inside notify, and never lets push fail chat", () => {
    expect(notifyBody.indexOf("applyNotificationPreferences")).toBeGreaterThan(-1);
    expect(notifyBody.indexOf("pushOutbox.enqueue(selected)")).toBeGreaterThan(notifyBody.indexOf("applyNotificationPreferences"));
    // enqueue, the none-queued diagnostic and flush all sit inside one try whose catch only warns
    expect(notifyBody).toMatch(/try \{\s*const queued = pushOutbox\.enqueue\(selected\);[\s\S]*?\} catch \(error\) \{ pushWarn\("notify", error\); \}/);
  });
  it("rates every engine permission it could push, from the stop line and the credential check", () => {
    // the engine's own tool input and the workspace go in too (device finding 2026-09-27)
    expect(source).toContain("pushStore.rateRisk(event.threadId, event.requestId, pushRiskFor(stopHit, event.tool, event.summary, { input: event.toolCall?.input, name: event.toolCall?.name, filePaths: event.filePaths, inside: pushWriteInside(asker.id, event.threadId, event), truncated: inputCut, ...(event.approvalScope ? { scope: event.approvalScope } : {}) }), Date.now())");
    expect(source.indexOf("pushStore.rateRisk(")).toBeGreaterThan(source.indexOf("const stopHit = permission && asker"));
    expect(source).toMatch(/try \{ pushStore\.rateRisk\(event\.threadId[^\n]*\} catch \(error\) \{ pushWarn\("rate-permission", error\); \}/);
  });
  it("a cut tool input rates the live card risky too", () => {
    const live = source.slice(source.indexOf("function pushLiveContent("), source.indexOf("function pushBadge("));
    expect(live).toContain("card.toolInputTruncated");
  });
  it("re-rates a revision's card with the same workspace check (fix round 1)", () => {
    const live = source.slice(source.indexOf("function pushLiveContent("), source.indexOf("function pushBadge("));
    expect(live).toContain("inside: pushWriteInside(botId, threadId, {})");
    expect(source).toContain("inside = workspaceInside(stopLinePlace(botId, threadId, commandCwd), temp);");
  });
  it("rates each push revision from the live card, and reads the rating for that same revision", () => {
    expect(source).toContain("rate: (threadId, requestId, revision) => { ratePushRevision(pushStore, threadId, requestId, revision, pushLiveContent(threadId, requestId), Date.now()); }");
    expect(source).toContain("risk: (threadId, requestId, revision) => pushStore.risk(threadId, requestId, revision)");
  });
  it("a question notification carries its request and card ids", () => {
    expect(source).toContain('permission && !questionAsk ? "approval" : "question",');
    expect(source).toMatch(/event\.summary,\s*\n\s*event\.requestId \? \{ requestId: event\.requestId, messageId: message\.id \} : undefined,/);
  });
  it("resolves on a card patch and records where the answer came from, neither able to fail the patch or the answer", () => {
    const patch = source.slice(source.indexOf('case "message.patch":'), source.indexOf('case "thread":'));
    expect(patch).toContain("pushOutbox.resolve(change.threadId, card.requestId");
    // Everything that touches push state sits inside the try: at startup the
    // outbox and answeredWhere do not exist yet (temporal dead zone).
    const guarded = patch.slice(patch.indexOf("try {"), patch.indexOf("} catch"));
    expect(guarded).toContain("pushOutbox.resolve(");
    expect(guarded).toContain("answeredWhere.take(key)");
    expect(patch.indexOf("broadcast({ kind: \"message.patch\"")).toBeLessThan(patch.indexOf("try {"));
    expect(source).toMatch(/try \{ answeredWhere\.attempt\(`\$\{threadId\}:\$\{requestId\}`, requestSurface\(req\.headers, url\.searchParams\) === "desktop" \? "desktop" : "elsewhere", res\); \} catch \(error\) \{ pushWarn\("respond-route", error\); \}/);
  });
  it("serves presence and the push routes, on the path without its query", () => {
    expect(source).toContain('if (method === "POST" && path === "/api/presence")');
    expect(source).toContain('if (path.startsWith("/api/mobile/push/"))');
    expect(source).toContain("const path = url.pathname;");
    expect(source).toContain("mobilePushRoute({ method, path, headers: req.headers,");
  });
  it("flushes the outbox and sweeps relay removals on one tick that nothing can stop", () => {
    expect(source).toContain('const sweepPushRemovals = relayRemovalSweeper(pushStore, pushRelay, Date.now, pushFailed("sweep"));');
    const tick = source.slice(source.indexOf("const pushTimer = setInterval("), source.indexOf("pushTimer.unref();"));
    expect(tick).toMatch(/try \{ void pushOutbox\.flush\(\)\.catch\(pushFailed\("flush"\)\); \} catch \(error\) \{ pushWarn\("flush", error\); \}/);
    expect(tick).toContain("void sweepPushRemovals();");
  });
  it("keeps the push routes out of the desktop-only inventory", async () => {
    const { requiresDesktopAuthority } = await import("./desktop-policy.ts");
    for (const [method, path] of [["GET", "/api/mobile/push/pending"], ["POST", "/api/mobile/push/respond"], ["POST", "/api/presence"]]) {
      expect(requiresDesktopAuthority(method!, path!), `${method} ${path}`).toBe(false);
    }
  });
});

// ── one revision per request, shared by every phone (H9 re-review Concern 1) ──
const BA = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
const BB = "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d";
function harnessLike() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  initializeMobilePush(db);
  const store = new PushStore(db);
  store.putBinding({ bindingId: BA, deviceId: "dA", publisherToken: "murage_pt_a", createdAt: 1 });
  // What the card says now; the harness reads it off the live card.
  const live = { stopHit: null as unknown, tool: "Bash", summary: "echo hi" };
  let refs = 0;
  const riskReads: number[] = [];
  const world: OutboxWorld = {
    visible: () => true, present: () => false, badge: () => 1, latestMessageId: () => "m1", stillPending: () => true,
    timeSensitive: () => true, actionable: () => true,
    // Exactly the index.ts wiring.
    rate: (threadId, requestId, revision) => { ratePushRevision(store, threadId, requestId, revision, live, 10); },
    risk: (threadId, requestId, revision) => { riskReads.push(revision); return store.risk(threadId, requestId, revision); },
  };
  const outbox = new PushOutbox({ store, world, sender: { publish: async () => "accepted" }, now: () => 1_000, randomRef: () => (++refs).toString(16).padStart(64, "0") });
  const answer = vi.fn(async (_t: string, _r: string, d: "allow" | "deny") => (d === "allow" ? "allowed-once" : "rejected"));
  const respond = (bindingId: string, deviceId: string, decision: "allow" | "deny", revision: number) =>
    respondFromPush({ deviceId, bindingId, body: { requestId: "req-1", decision, revision } }, { store, now: () => 2_000, visible: () => true, liveRating: () => "low", card: () => ({ pending: true }), answer, log: () => {} });
  // The engine-permission path's rating (no revision): what makes a request rateable.
  store.rateRisk("t1", "req-1", "low", 5);
  return { store, outbox, live, riskReads, respond, answer };
}
const approval = { kind: "approval" as const, botId: "scout", threadId: "t1", requestId: "req-1", messageId: "m1" };

// Device finding 2026-09-27: on the isolated host (HOME under /tmp, a stop
// line root) Bash `rm -rf ~/Documents` had no stop hit, was rated low, and the
// lock screen offered Approve. The whole chain, from the engine-path rating
// exactly as index.ts computes it to the push category and respond's answer.
describe("a destructive permission the stop line let through", () => {
  async function chain(event: { tool: string; summary: string; toolCall?: { name: string; input: unknown }; filePaths?: string[] }, inside: (path: string) => boolean, liveInside: ((path: string) => boolean) | null = inside) {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeMobilePush(db);
    const store = new PushStore(db);
    store.putBinding({ bindingId: BA, deviceId: "dA", publisherToken: "murage_pt_a", createdAt: 1 });
    const stopHit = null;
    // exactly the index.ts expression
    store.rateRisk("t1", "req-1", pushRiskFor(stopHit, event.tool, event.summary, { input: event.toolCall?.input, name: event.toolCall?.name, filePaths: event.filePaths, inside }), 5);
    // and the revision, re-rated from the live card as pushLiveContent gives it
    const live = { stopHit, tool: event.tool, summary: event.summary, ...(liveInside ? { inside: liveInside } : {}) };
    const world: OutboxWorld = {
      visible: () => true, present: () => false, badge: () => 1, latestMessageId: () => "m1", stillPending: () => true,
      timeSensitive: () => true, actionable: () => true,
      rate: (threadId, requestId, revision) => { ratePushRevision(store, threadId, requestId, revision, live, 10); },
      risk: (threadId, requestId, revision) => store.risk(threadId, requestId, revision),
    };
    const published: Array<{ category?: string }> = [];
    let refs = 0;
    const outbox = new PushOutbox({
      store, world, now: () => 1_000, randomRef: () => (++refs).toString(16).padStart(64, "0"),
      sender: { publish: async (_binding, pushed) => { published.push(pushed as { category?: string }); return "accepted"; } },
    });
    outbox.enqueue(approval);
    await outbox.flush();
    const answer = vi.fn(async () => "allowed-once" as const);
    const allow = await respondFromPush({ deviceId: "dA", bindingId: BA, body: { requestId: "req-1", decision: "allow", revision: 1 } }, { store, now: () => 2_000, visible: () => true, liveRating: () => "low", card: () => ({ pending: true }), answer, log: () => {} });
    return { store, published, allow, answer };
  }
  const workspace = (path: string) => path.startsWith("/w/") || (!path.startsWith("/") && !path.startsWith("~"));

  it("Bash rm -rf ~/Documents pushes approval-open, and a lock-screen Allow is refused with step_up", async () => {
    const input = { command: "rm -rf ~/Documents" };
    // what the fake engine asks, as the claude driver files it: summary is the command
    const h = await chain({ tool: "Bash", summary: "rm -rf ~/Documents", toolCall: { name: "Bash", input } }, () => true);
    expect(h.store.risk("t1", "req-1")).toBe("risky");
    expect(h.store.latestForRequest(BA, "req-1")).toMatchObject({ revision: 1, category: "approval-open", state: "sent" });
    expect(h.published.map((p) => p.category)).toEqual(["approval-open"]);
    expect(h.allow).toMatchObject({ status: 403, body: { code: "step_up" } });
    expect(h.answer).not.toHaveBeenCalled();
  });

  it("a Codex edit approval (no tool call, no paths) pushes approval-open (fix round 1, C1)", async () => {
    const h = await chain({ tool: "edit", summary: "edit" }, workspace);
    expect(h.published.map((p) => p.category)).toEqual(["approval-open"]);
    expect(h.allow).toMatchObject({ status: 403, body: { code: "step_up" } });
  });

  it("a Write whose revision is re-rated with no known workspace (a group thread) pushes approval-open (fix round 2)", async () => {
    const event = { tool: "Write", summary: "{\"file_path\":\"/w/a.md\"}", toolCall: { name: "Write", input: { file_path: "/w/a.md", content: "x" } } };
    const h = await chain(event, workspace, null);
    // the engine path rated it low (inside); the card-only re-rate cannot show that, so risky
    expect(h.store.risk("t1", "req-1", 1)).toBe("risky");
    expect(h.published.map((p) => p.category)).toEqual(["approval-open"]);
    expect(h.allow).toMatchObject({ status: 403, body: { code: "step_up" } });
  });

  it("a Write inside the workspace, and a read-only command, keep lock-screen Approve through every revision", async () => {
    for (const event of [
      { tool: "Write", summary: "{\"file_path\":\"/w/a.md\"}", toolCall: { name: "Write", input: { file_path: "/w/a.md", content: "x" } } },
      { tool: "Bash", summary: "ls | tail", toolCall: { name: "Bash", input: { command: "ls | tail" } } },
    ]) {
      const h = await chain(event, workspace);
      expect(h.published.map((p) => p.category)).toEqual(["approval"]);
      expect(h.allow).toEqual({ status: 200, body: { ok: true, outcome: "allowed-once" } });
    }
  });
});

describe("push revisions are per request, and rated before any send", () => {
  it("a phone enrolled after the content changed cannot Allow on the old low rating", async () => {
    const h = harnessLike();
    h.outbox.enqueue(approval);
    await h.outbox.flush();
    expect(h.store.latestForRequest(BA, "req-1")).toMatchObject({ revision: 1, category: "approval", state: "sent" });
    // The request now reads a credential; a second phone enrols; the harness
    // notifies again.
    h.live.summary = "cat ~/.ssh/id_ed25519";
    h.store.putBinding({ bindingId: BB, deviceId: "dB", publisherToken: "murage_pt_b", createdAt: 2 });
    h.outbox.enqueue(approval);
    await h.outbox.flush();
    // Both phones hold the same revision for the same content, never B at 1.
    expect(h.store.latestForRequest(BB, "req-1")).toMatchObject({ revision: 2, category: "approval-open", state: "sent" });
    expect(h.store.latestForRequest(BA, "req-1")).toMatchObject({ revision: 2, category: "approval-open" });
    expect(await h.respond(BB, "dB", "allow", 2)).toMatchObject({ status: 403, body: { code: "step_up" } });
    expect(await h.respond(BB, "dB", "allow", 1)).toMatchObject({ status: 409, body: { code: "stale" } });
    expect(await h.respond(BA, "dA", "allow", 1)).toMatchObject({ status: 409, body: { code: "stale" } });
    expect(h.answer).not.toHaveBeenCalled();
  });

  it("the outbox's approval choice and respond's check read the rating for the same revision", async () => {
    const h = harnessLike();
    h.store.putBinding({ bindingId: BB, deviceId: "dB", publisherToken: "murage_pt_b", createdAt: 2 });
    h.outbox.enqueue(approval);
    await h.outbox.flush();
    expect(h.riskReads).toEqual([1]);
    for (const binding of [BA, BB]) expect(h.store.latestForRequest(binding, "req-1")).toMatchObject({ revision: 1, category: "approval" });
    expect(h.store.risk("t1", "req-1", 1)).toBe("low");
    expect(await h.respond(BB, "dB", "allow", 1)).toEqual({ status: 200, body: { ok: true, outcome: "allowed-once" } });
  });

  it("a resolution takes the next shared revision too", async () => {
    const h = harnessLike();
    h.outbox.enqueue(approval);
    await h.outbox.flush();
    h.store.putBinding({ bindingId: BB, deviceId: "dB", publisherToken: "murage_pt_b", createdAt: 2 });
    h.outbox.enqueue(approval);
    await h.outbox.flush();
    expect(h.outbox.resolve("t1", "req-1", "desktop")).toBe(2);
    for (const binding of [BA, BB]) expect(h.store.latestForRequest(binding, "req-1")).toMatchObject({ revision: 3, category: "resolved" });
  });

  it("a rating that fails leaves that revision unrated, and still pushes (Open only)", async () => {
    const h = harnessLike();
    const outbox = new PushOutbox({
      store: h.store, sender: { publish: async () => "accepted" }, now: () => 1_000,
      world: { visible: () => true, present: () => false, badge: () => 1, latestMessageId: () => "m1", stillPending: () => true, timeSensitive: () => true,
        actionable: () => true, rate: () => { throw new Error("disk"); }, risk: (t, r, revision) => h.store.risk(t, r, revision) },
    });
    expect(outbox.enqueue(approval)).toBe(1);
    await outbox.flush();
    expect(h.store.latestForRequest(BA, "req-1")).toMatchObject({ revision: 1, category: "approval-open" });
    expect(await h.respond(BA, "dA", "allow", 1)).toMatchObject({ status: 403 });
  });
});

describe("a rated revision number is never issued again (H10 fix round 1)", () => {
  function world(store: PushStore, live: { stopHit: unknown; tool: string; summary: string }, failRate: { on: boolean }): OutboxWorld {
    return {
      visible: () => true, present: () => false, badge: () => 1, latestMessageId: () => "m1", stillPending: () => true,
      timeSensitive: () => true, actionable: () => true,
      rate: (t, r, rev) => { if (failRate.on) throw new Error("x"); ratePushRevision(store, t, r, rev, live, 10); },
      risk: (t, r, rev) => store.risk(t, r, rev),
    };
  }
  const allow = (store: PushStore, bindingId: string, deviceId: string, revision: number) =>
    respondFromPush({ deviceId, bindingId, body: { requestId: "req-1", decision: "allow", revision } },
      { store, now: () => 2_000, visible: () => true, liveRating: () => "low", card: () => ({ pending: true }), answer: vi.fn(async () => "allowed-once"), log: () => {} });
  function fresh() {
    const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON"); initializeMobilePush(db);
    const store = new PushStore(db);
    const live = { stopHit: null as unknown, tool: "Bash", summary: "echo hi" };
    const failRate = { on: false };
    let refs = 0;
    const outbox = new PushOutbox({ store, world: world(store, live, failRate), sender: { publish: async () => "accepted" }, now: () => 1_000,
      randomRef: () => (++refs).toString(16).padStart(64, "0"), warn: () => {} });
    store.rateRisk("t1", "req-1", "low", 5);
    return { store, live, failRate, outbox };
  }

  it("rated with no phone, then risky content, then a phone enrols and the re-rate fails: Allow is step_up (reviewer's probe)", async () => {
    const h = fresh();
    expect(h.outbox.enqueue(approval)).toBe(0);
    expect(h.store.risk("t1", "req-1", 1)).toBe("low");
    h.live.summary = "cat ~/.ssh/id_ed25519";
    h.store.putBinding({ bindingId: BB, deviceId: "dB", publisherToken: "murage_pt_b", createdAt: 2 });
    h.failRate.on = true;
    expect(h.outbox.enqueue(approval)).toBe(1);
    await h.outbox.flush();
    const event = h.store.latestForRequest(BB, "req-1")!;
    expect(event).toMatchObject({ revision: 2, category: "approval-open" });
    expect(await allow(h.store, BB, "dB", event.revision)).toMatchObject({ status: 403, body: { code: "step_up" } });
  });

  it("the same when the phone that held the rated revision was removed, and its events with it", async () => {
    const h = fresh();
    h.store.putBinding({ bindingId: BA, deviceId: "dA", publisherToken: "murage_pt_a", createdAt: 1 });
    expect(h.outbox.enqueue(approval)).toBe(1);
    await h.outbox.flush();
    expect(h.store.risk("t1", "req-1", 1)).toBe("low");
    h.store.removeBinding(BA, { atRelay: false });
    expect(h.store.requestRevision("req-1")).toBe(0);
    h.live.summary = "cat ~/.ssh/id_ed25519";
    h.store.putBinding({ bindingId: BB, deviceId: "dB", publisherToken: "murage_pt_b", createdAt: 2 });
    h.failRate.on = true;
    h.outbox.enqueue(approval);
    await h.outbox.flush();
    const event = h.store.latestForRequest(BB, "req-1")!;
    expect(event.revision).toBe(2);
    expect(await allow(h.store, BB, "dB", event.revision)).toMatchObject({ status: 403, body: { code: "step_up" } });
  });

  it("a failed rating is traced, content-free", () => {
    const h = fresh();
    const warn = vi.fn();
    const outbox = new PushOutbox({ store: h.store, world: world(h.store, h.live, { on: true }), sender: { publish: async () => "accepted" }, warn });
    outbox.enqueue(approval);
    expect(warn).toHaveBeenCalledWith("rate", expect.any(Error));
  });
});

describe("where an answer came from", () => {
  const finished = (statusCode: number) => {
    const listeners: Array<() => void> = [];
    return { statusCode, once: (_event: "finish", listener: () => void) => { listeners.push(listener); }, finish() { for (const l of listeners) l(); } };
  };
  it("a desktop answer counts only once the route accepted it", () => {
    const where = new AnsweredWhere();
    const refused = finished(409);
    where.attempt("t1:r1", "desktop", refused);
    refused.finish();
    expect(where.take("t1:r1")).toBe("elsewhere");
    const accepted = finished(200);
    where.attempt("t1:r2", "desktop", accepted);
    accepted.finish();
    // Kept past the answer: the card is often marked answered by the
    // engine's own event, after the route has already replied.
    expect(where.take("t1:r2")).toBe("desktop");
    expect(where.take("t1:r2")).toBe("elsewhere");
    where.note("t1:r4", "desktop");
    where.forget("t1:r4");
    expect(where.take("t1:r4")).toBe("elsewhere");
  });
  it("is bounded, and a later answer for the same key moves it to the back", () => {
    const where = new AnsweredWhere(3);
    for (const key of ["a", "b", "c"]) where.note(key, "desktop");
    where.note("a", "desktop");
    where.note("d", "desktop");
    expect(where.take("b")).toBe("elsewhere");
    expect(where.take("a")).toBe("desktop");
    expect(where.size).toBeLessThanOrEqual(3);
  });
});

describe("push failures leave a trace", () => {
  it("one content-free line per hook per minute, with the error class only", () => {
    let now = 0;
    const lines: string[] = [];
    const warn = createPushWarn((line) => lines.push(line), () => now);
    warn("notify", new TypeError("thread t-secret req-secret"));
    warn("notify", new TypeError("again"));
    warn("patch", new RangeError("x"));
    warn("patch", "not an error");
    now = 60_000;
    warn("notify", Object.assign(new Error("y"), { constructor: { name: "bad name\n" } }));
    expect(lines).toEqual([
      "mobile push: notify failed (TypeError)",
      "mobile push: patch failed (RangeError)",
      "mobile push: notify failed (unknown)",
    ]);
    expect(lines.join(" ")).not.toMatch(/secret|again/);
  });
  it("never throws, even when logging does", () => {
    const warn = createPushWarn(() => { throw new Error("stdout closed"); });
    expect(() => warn("timer", new Error("x"))).not.toThrow();
  });
});

describe("ratePushRevision", () => {
  const fresh = () => { const db = new DatabaseSync(":memory:"); initializeMobilePush(db); return new PushStore(db); };
  it("rates only what the engine-permission path rated, from the live card, for exactly that revision", () => {
    const store = fresh();
    expect(ratePushRevision(store, "t1", "r1", 1, { stopHit: null, tool: "Bash", summary: "echo hi" }, 1)).toBe("unrated");
    expect(store.risk("t1", "r1")).toBe("unrated");
    store.rateRisk("t1", "r1", "low", 1);
    expect(ratePushRevision(store, "t1", "r1", 3, { stopHit: null, tool: "Bash", summary: "echo hi" }, 2)).toBe("low");
    expect(store.risk("t1", "r1", 3)).toBe("low");
    expect(store.risk("t1", "r1", 2)).toBe("unrated");
    expect(ratePushRevision(store, "t1", "r1", 4, { stopHit: { kind: "delete" }, tool: "Bash", summary: "echo hi" }, 3)).toBe("risky");
    expect(store.risk("t1", "r1", 4)).toBe("risky");
  });
  it("only climbs: risky once stays risky, even when the stop line hit is no longer in memory", () => {
    const store = fresh();
    store.rateRisk("t1", "r1", "risky", 1);
    expect(ratePushRevision(store, "t1", "r1", 1, { stopHit: null, tool: "Bash", summary: "echo hi" }, 2)).toBe("risky");
    expect(store.risk("t1", "r1", 1)).toBe("risky");
  });
  it("a card that is gone rates nothing for the new revision", () => {
    const store = fresh();
    store.rateRisk("t1", "r1", "low", 1, 1);
    expect(ratePushRevision(store, "t1", "r1", 2, null, 2)).toBe("unrated");
    expect(store.risk("t1", "r1", 2)).toBe("unrated");
  });
});

// ── a real harness with push off (MURAGE_PUSH_RELAY_URL=off) ─────────────
const COMPANION = "c".repeat(64);
describe("a harness started with push off", () => {
  let fixture: VerificationServer;
  let desktop: Record<string, string>;
  beforeAll(async () => {
    // Set before index.ts (and companion-authority.ts) read the environment.
    const instrumentation = `process.env.MURAGE_PUSH_RELAY_URL = "off"; process.env.MURAGE_COMPANION_TOKEN = ${JSON.stringify(COMPANION)};`;
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: instrumentation });
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown }) =>
    fetch(fixture.info.url + path, { method: init.method ?? "POST", headers: { "content-type": "application/json", ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const door = { "x-murage-companion": "1", "x-murage-companion-token": COMPANION, "x-murage-push-device": "dev_1" };

  it("starts, and refuses enrolment with 503 push_off, query string or not", async () => {
    for (const path of ["/api/mobile/push/enrol", "/api/mobile/push/enrol?via=door"]) {
      const res = await call(path, { headers: door, body: { grant: `murage_pg_${"C".repeat(43)}` } });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "push_off" });
    }
  });
  it("hides the push routes from anything without the launch proof", async () => {
    const res = await call("/api/mobile/push/enrol", { headers: { ...desktop, "x-murage-push-device": "dev_1" }, body: { grant: "x" } });
    expect(res.status).toBe(404);
  });
  it("still answers the rest of the push routes", async () => {
    // With push off the lookup says so (503 push_off), so the door never reads it as "not enrolled".
    const binding = await call("/api/mobile/push/binding", { method: "GET", headers: door });
    expect(binding.status).toBe(503);
    expect(await binding.json()).toMatchObject({ code: "push_off" });
    expect(await (await call("/api/mobile/push/revoke-device", { headers: door, body: {} })).json()).toEqual({ ok: true });
    expect((await call("/api/mobile/push/pending", { method: "GET", headers: door })).status).toBe(401);
  });
  it("takes presence from the desktop, and only well-formed", async () => {
    expect((await call("/api/presence", { headers: desktop, body: { clientId: "desk-tab-1", visible: true } })).status).toBe(204);
    const bad = await call("/api/presence", { headers: desktop, body: { clientId: "desk-tab-1" } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "That presence report could not be read." });
    // A browser tab through the door reports with the door's launch proof.
    expect((await call("/api/presence", { headers: door, body: { clientId: "door-tab-1", visible: true } })).status).toBe(204);
    // Anything else on the loopback port is turned away by the route policy's
    // gate (companion class) with the 404 that confirms nothing; the route's
    // own 403 stays behind it as the second layer.
    const stray = await call("/api/presence", { body: { clientId: "desk-tab-1", visible: true } });
    expect(stray.status).toBe(404);
    expect(await stray.json()).toEqual({ error: "no such route" });
  });
});

describe("summary-only cut gate wiring", () => {
  it("index.ts works out one cut flag with approvalIsCut and passes it to rateRisk", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(src).toContain("approvalIsCut(event.toolInput, event.summary)");
    expect(src).not.toContain("toolInputIsTruncated(event.toolInput)");
  });
});
