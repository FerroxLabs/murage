import test from "node:test";
import assert from "node:assert/strict";
import { createAttentionRouter, MAX_TRACKED } from "./attention-router.mjs";

function rig(over = {}) {
  let t = 1_000_000; const timers = []; const shown = [], closed = [], counts = [], summaries = [], invalid = [];
  let prefs = { origin: "new", notify: true, receipt: true, pill: false, bubble: false, hideFullscreen: true, respectFocus: true, quietSummary: true, nudgeMinutes: 5, ...over.prefs };
  let avail = { pill: false, notify: true, pinnedBotId: null, ...over.available };
  let quiet = { fullscreen: false, sharing: false, focus: false, locked: false, ...over.quiet };
  let open = new Set(); let nextId = 0; const gates = [];
  const router = createAttentionRouter({
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, live: true }; timers.push(h); return h; },
    clearTimer: h => { if (h) h.live = false; },
    prefs: () => prefs, available: () => avail, quiet: () => quiet,
    surfaces: {
      show: async (rung, entry, generation) => { shown.push([rung, entry.frame.requestId ?? entry.frame.deliveryId ?? entry.frame.kind, generation]); if (over.gate) await new Promise(r => gates.push(r)); return [`s${++nextId}`]; },
      close: (ids, entry) => closed.push([ids, entry.key]),
      counts: c => counts.push(c), summary: s => summaries.push(s),
    },
    readCard: async (_home, entry) => ({ open: open.has(entry.frame.requestId) }),
    invalidateTokens: e => invalid.push(e.key),
  });
  const tick = async ms => { t += ms; for (const h of timers) if (h.live && h.at <= t) { h.live = false; await h.fn(); } };
  const card = (id, extra = {}) => { open.add(id); return { kind: "approval", botId: "b1", threadId: "t1", requestId: id, requestTurnId: "turn1", messageId: "m" + id, ...extra }; };
  return { router, shown, closed, counts, summaries, invalid, tick, card, open, gates, set: (p, a, q) => { if (p) prefs = { ...prefs, ...p }; if (a) avail = { ...avail, ...a }; if (q) quiet = { ...quiet, ...q }; } };
}

test("rule 3: an approval takes the highest rung that is on; one surface only", async () => {
  const r = rig({ prefs: { pill: true, bubble: true }, available: { pill: true, pinnedBotId: "b1" } });
  assert.equal((await r.router.offer(r.card("r1"))).decision, "pill");
  r.set({ pill: false });
  assert.equal((await r.router.offer(r.card("r2"))).decision, "notify");
  r.set({ notify: false });
  assert.equal((await r.router.offer(r.card("r3"))).decision, "bubble");
  r.set({ bubble: false });
  assert.equal((await r.router.offer(r.card("r4"))).decision, "counts");
  assert.equal(r.shown.length, 3);
});

test("rule 3: the bubble rung is only for the pinned bot", async () => {
  const r = rig({ prefs: { notify: false, bubble: true }, available: { pinnedBotId: "other" } });
  assert.equal((await r.router.offer(r.card("r1"))).decision, "counts");
});

test("rule 1: on screen is nothing outside for new installs (approvals too); focused upgrades keep approvals in app", async () => {
  const n = rig(); n.router.visible("t1", true);
  assert.equal((await n.router.offer(n.card("r1"))).decision, "on-screen");
  const u = rig({ prefs: { origin: "upgrade" } }); u.router.visible("t1", true);
  assert.equal((await u.router.offer(u.card("r1"))).decision, "counts");
  assert.equal((await u.router.offer(u.card("r2", { kind: "question" }))).decision, "on-screen");
  const nf = rig(); nf.router.visible("t1", false);
  assert.equal((await nf.router.offer(nf.card("r1"))).decision, "notify");
});

test("rule 2: quiet holds, release posts ONE summary, a settled card drops out first", async () => {
  const r = rig({ quiet: { sharing: true } });
  for (const id of ["r1", "r2", "r3"]) assert.equal((await r.router.offer(r.card(id))).decision, "held");
  assert.equal(r.shown.length, 0);
  r.open.delete("r2");
  r.set(null, null, { sharing: false }); await r.router.quietChanged();
  assert.equal(r.summaries.length, 1); assert.equal(r.summaries[0].total, 2);
  assert.equal(r.shown.length, 0, "a summary never carries a card of its own");
});

test("rule 2: N = 1 shows that event itself", async () => {
  const r = rig({ quiet: { locked: true } });
  await r.router.offer(r.card("r1"));
  r.set(null, null, { locked: false }); await r.router.quietChanged();
  assert.deepEqual(r.shown.map(s => s.slice(0, 2)), [["notify", "r1"]]);
  assert.equal(r.summaries.length, 0);
});

test("rule 2 (upgrade, summary off): a release gives ONE banner for the newest, the rest stay in the counts", async () => {
  const r = rig({ prefs: { origin: "upgrade", quietSummary: false }, quiet: { fullscreen: true } });
  for (const id of ["r1", "r2", "r3"]) await r.router.offer(r.card(id));
  r.set(null, null, { fullscreen: false }); await r.router.quietChanged();
  assert.equal(r.shown.length, 1); assert.equal(r.shown[0][1], "r3");
  assert.equal(r.router.snapshot().needsYou, 3);
});

test("quiet source only counts when its preference is on", async () => {
  const r = rig({ prefs: { hideFullscreen: false }, quiet: { fullscreen: true } });
  assert.equal((await r.router.offer(r.card("r1"))).decision, "notify");
  const s = rig({ prefs: { hideFullscreen: false }, quiet: { sharing: true } });
  assert.equal((await s.router.offer(s.card("r1"))).decision, "held", "sharing always holds");
});

test("rule 4: settle closes every surface, is idempotent, and cancels a pending show", async () => {
  const r = rig();
  await r.router.offer(r.card("r1"));
  assert.equal(r.router.settled("t1", "r1"), true);
  assert.equal(r.router.settled("t1", "r1"), false);
  assert.equal(r.closed.length, 1); assert.equal(r.router.size(), 0);
  const p = rig({ gate: true });
  const pending = p.router.offer(p.card("r1"));
  await new Promise(r2 => setImmediate(r2));
  p.router.settled("t1", "r1"); p.gates.forEach(g => g()); await pending;
  assert.equal(p.closed.length, 1, "the surface opened after the settle is closed at once");
});

test("identical ids across two homes never collide", async () => {
  const r = rig();
  await r.router.offer(r.card("r1"), "local"); await r.router.offer(r.card("r1"), "cloud-a");
  assert.equal(r.router.size(), 2);
  r.router.settled("t1", "r1", "cloud-a");
  assert.equal(r.router.size(), 1);
  r.router.homeGone("local"); assert.equal(r.router.size(), 0);
});

test("rule 5: one nudge on the next rung down, never a second, spent by a hold", async () => {
  const r = rig({ prefs: { pill: true, bubble: true }, available: { pill: true, pinnedBotId: "b1" } });
  await r.router.offer(r.card("r1"));
  assert.equal(r.shown.at(-1)[0], "pill");
  await r.tick(5 * 60_000);
  assert.equal(r.shown.at(-1)[0], "notify");
  await r.tick(60 * 60_000);
  assert.equal(r.shown.length, 2, "exactly one nudge");
  const h = rig({ prefs: { pill: true }, available: { pill: true } });
  await h.router.offer(h.card("r1"));
  h.set(null, null, { locked: true }); await h.tick(5 * 60_000);
  assert.equal(h.shown.length, 1, "a nudge due during a hold does not show");
  h.set(null, null, { locked: false }); await h.router.quietChanged();
  assert.equal(h.shown.length, 1, "the release itself shows nothing (the one rung is already the pill; spent nudge)");
  await h.tick(60 * 60_000);
  assert.equal(h.shown.length, 1, "no second nudge after a hold");
});

test("rule 6: one receipt per delivery; none without the receipt preference; no deliveryId is today's plain banner", async () => {
  const r = rig();
  const done = { kind: "done", botId: "b1", threadId: "t1", deliveryId: "d1" };
  assert.equal((await r.router.offer(done)).decision, "receipt-notify");
  assert.equal((await r.router.offer(done)).decision, "duplicate");
  assert.equal((await r.router.offer({ kind: "done", botId: "b1", threadId: "t1" })).decision, "plain");
  const off = rig({ prefs: { receipt: false } });
  assert.equal((await off.router.offer(done)).decision, "counts");
  const pill = rig({ prefs: { pill: true }, available: { pill: true } });
  assert.equal((await pill.router.offer(done)).decision, "receipt-pill");
  const noNotify = rig({ prefs: { notify: false } });
  assert.equal((await noNotify.router.offer(done)).decision, "receipt-notify", "receipt works with notify off");
});

test("every other kind is one plain Open-only notification; an unknown kind is never dropped", async () => {
  const r = rig();
  assert.equal((await r.router.offer({ kind: "turn-failed", botId: "b1", threadId: "t1" })).decision, "plain");
  assert.equal((await r.router.offer({ kind: "something-new", botId: "b1" })).decision, "plain");
  const off = rig({ prefs: { notify: false } });
  assert.equal((await off.router.offer({ kind: "backup-waiting" })).decision, "counts");
  const up = rig({ prefs: { notify: false, origin: "upgrade" } });
  assert.equal((await up.router.offer({ kind: "backup-waiting" })).decision, "plain", "always on for upgrades");
});

test("rule 7: a previews change closes every surface and invalidates every token", async () => {
  const r = rig();
  await r.router.offer(r.card("r1")); await r.router.offer(r.card("r2"));
  r.router.previewsChanged();
  assert.equal(r.closed.length, 2); assert.equal(r.invalid.length, 2);
});

test("reconcile checks each tracked card individually; 60 cards, no page limit", async () => {
  const r = rig();
  for (let i = 0; i < 60; i += 1) await r.router.offer(r.card("r" + i));
  r.open.delete("r59"); r.open.delete("r0");
  await r.router.reconcile("local");
  assert.equal(r.router.size(), 58);
});

test("bounded at 1024: the oldest is evicted with its surfaces closed and its tokens invalidated first", async () => {
  const r = rig();
  for (let i = 0; i < MAX_TRACKED + 3; i += 1) await r.router.offer(r.card("r" + i));
  assert.equal(r.router.size(), MAX_TRACKED);
  assert.equal(r.invalid.length, 3); assert.equal(r.closed.length, 3);
});

test("a repeated frame for the same card is a duplicate, and a restart replays nothing (state is memory only)", async () => {
  const r = rig();
  const c = r.card("r1");
  assert.equal((await r.router.offer(c)).decision, "notify");
  assert.equal((await r.router.offer(c)).decision, "duplicate");
  const fresh = rig(); assert.equal(fresh.router.size(), 0);
});

// ---- Astra round 1 (S3): release serialization, bounded held set, cancel for never-shown events, per-home previews ----
function mini({ readGate = null } = {}) {
  const shown = [], cancelled = [], closed = [], invalid = [];
  const quiet = { fullscreen: false, sharing: false, focus: false, locked: false };
  let seq = 0;
  const router = createAttentionRouter({
    now: () => 1_000_000, setTimer: () => ({}), clearTimer() {},
    prefs: () => ({ origin: "upgrade", notify: true, receipt: true, pill: false, bubble: false, hideFullscreen: true, respectFocus: true, quietSummary: false, nudgeMinutes: 0 }),
    available: () => ({ pill: false, notify: true, pinnedBotId: null }), quiet: () => quiet,
    surfaces: { show: async (rung, entry) => { shown.push(entry.frame.requestId ?? entry.frame.kind); return [`s${++seq}`]; }, close: (ids, entry) => closed.push([ids, entry.home]), cancel: entry => cancelled.push(entry.key), counts() {} },
    readCard: async () => { if (readGate) await readGate.wait(); return { open: true }; },
    invalidateTokens: entry => invalid.push(entry.home),
  });
  const card = (id, home = "local") => router.offer({ kind: "approval", botId: "b1", threadId: "t1", requestId: id, messageId: "m" + id, requestTurnId: "turn" }, home, "e");
  return { router, shown, cancelled, closed, invalid, quiet, card };
}
const gate = () => { let opened = false; const waiting = []; return { wait: () => (opened ? Promise.resolve() : new Promise(resolve => { waiting.push(resolve); })), release: () => { opened = true; for (const resolve of waiting.splice(0)) resolve(); } }; };

test("a settle that lands while a release is reading the cards is not undone", async () => {
  const g = gate(); const m = mini({ readGate: g });
  m.quiet.locked = true;
  await m.card("r1"); await m.card("r2");
  assert.equal(m.router.heldSize(), 2);
  m.quiet.locked = false;
  const release = m.router.quietChanged();
  await new Promise(resolve => setImmediate(resolve));
  m.router.settled("t1", "r2", "local"); // the newest card settles while its read is outstanding
  g.release(); await new Promise(resolve => setImmediate(resolve)); g.release();
  await release;
  assert.deepEqual(m.shown, ["r1"], "the settled card is not resurrected or shown");
  assert.equal(m.router.size(), 1);
});

test("quiet coming back while a release is reading keeps every event held for the next release", async () => {
  const g = gate(); const m = mini({ readGate: g });
  m.quiet.locked = true;
  await m.card("r1"); await m.card("r2");
  m.quiet.locked = false;
  const release = m.router.quietChanged();
  await new Promise(resolve => setImmediate(resolve));
  m.quiet.locked = true; // locked again before the reads finished
  g.release(); await new Promise(resolve => setImmediate(resolve)); g.release();
  await release;
  assert.deepEqual(m.shown, [], "no banner while quiet again");
  assert.equal(m.router.heldSize(), 2, "nothing was spent");
  m.quiet.locked = false;
  await m.router.quietChanged();
  assert.deepEqual(m.shown, ["r2"], "the next release shows the newest once");
});

test("a change that lands mid-release runs exactly one more pass", async () => {
  const g = gate(); const m = mini({ readGate: g });
  m.quiet.locked = true;
  await m.card("r1");
  m.quiet.locked = false;
  const first = m.router.quietChanged();
  await new Promise(resolve => setImmediate(resolve));
  const second = m.router.quietChanged(); // returns at once: serialized
  await second;
  g.release(); await new Promise(resolve => setImmediate(resolve)); g.release();
  await first;
  assert.deepEqual(m.shown, ["r1"], "one banner, never two passes over the same event");
});

test("the held set is bounded with the tracked set: the oldest is dropped and its window told to forget it", async () => {
  const m = mini();
  m.quiet.locked = true;
  for (let i = 0; i < MAX_TRACKED + 30; i += 1) await m.router.offer({ kind: "turn-failed", threadId: "t" + i, at: i, ref: "r" + i }, "local", "e");
  assert.equal(m.router.heldSize(), MAX_TRACKED);
  assert.ok(m.cancelled.length >= 30, `evicted events are cancelled, got ${m.cancelled.length}`);
  for (let i = 0; i < MAX_TRACKED + 30; i += 1) await m.router.offer({ kind: "done", threadId: "t" + i, deliveryId: "d" + i }, "local", "e");
  assert.ok(m.router.heldSize() <= MAX_TRACKED, "receipts held while quiet are bounded too");
});

test("a held card that settles is cancelled (its window still waits on the ref); a shown one is closed", async () => {
  const m = mini();
  m.quiet.locked = true;
  await m.card("r1");
  m.router.settled("t1", "r1", "local");
  assert.equal(m.cancelled.length, 1, "never reached a surface: cancel");
  m.quiet.locked = false;
  await m.card("r2");
  m.router.settled("t1", "r2", "local");
  assert.equal(m.closed.length, 1, "shown: close the surface");
});

test("previewsChanged(home) closes and invalidates only that home", async () => {
  const m = mini();
  await m.card("r1", "local"); await m.card("r1", "h-cloud");
  m.router.previewsChanged("h-cloud");
  assert.deepEqual(m.invalid, ["h-cloud"]);
  assert.deepEqual(m.closed.map(c => c[1]), ["h-cloud"]);
  m.router.previewsChanged();
  assert.deepEqual(m.invalid.slice(1).sort(), ["h-cloud", "local"]);
});

for (const origin of ["new", "upgrade"]) {
  test(`GH24 ${origin}: Murage focus keeps other conversations in app without OS banners`, async () => {
    for (const kind of ["approval", "question", "done", "turn-failed", "future-kind"]) {
      const r = rig({ prefs: { origin } });
      r.router.visible("another-thread", true, "another-home");
      const frame = r.card("focused", { kind, deliveryId: "delivery" });
      const entry = r.router.register(frame, "local", "e", { session: "test" });
      assert.equal(r.router.decide(entry, {}), "counts", `${kind}: S3R decision`);
      const direct = rig({ prefs: { origin } }); direct.router.visible("another-thread", true);
      assert.equal((await direct.router.offer(frame)).decision, "counts", `${kind}: direct decision`);
      assert.equal(direct.shown.length, 0);
      if (kind === "approval" || kind === "question") assert.equal(direct.router.snapshot().needsYou, 1);
      r.router.visible(null, false, "another-home");
      assert.notEqual(r.router.decide(entry, {}), "counts", `${kind}: blur restores delivery`);
    }
  });
}
test("GH24 focused Murage keeps pill and pinned bubble available without escalating to a banner", async () => {
  const r = rig({ prefs: { pill: true, bubble: true }, available: { pill: true, pinnedBotId: "b1" } });
  r.router.visible("another", true);
  assert.equal((await r.router.offer(r.card("r1"))).decision, "pill");
  await r.tick(5 * 60_000);
  assert.deepEqual(r.shown.map(row => row[0]), ["pill", "bubble"]);
});
test("GH24 quiet release while Murage is focused stays in app", async () => {
  const r = rig({ quiet: { locked: true } });
  await r.router.offer(r.card("r1")); await r.router.offer(r.card("r2"));
  r.router.visible("another", true); r.set(null, null, { locked: false });
  await r.router.quietChanged();
  assert.equal(r.shown.length, 0); assert.equal(r.summaries.length, 0);
  assert.equal(r.router.snapshot().needsYou, 2);
});

test("connector incidents respect chosen banners, deduplicate and close on recovery without changing approval routing", async () => {
  const incident = { kind: "connector-reconnect", botId: "b1", threadId: "t1", requestId: "incident", deliveryId: "incident" };
  const r = rig();
  assert.equal((await r.router.offer(incident)).decision, "plain");
  assert.equal((await r.router.offer(incident)).decision, "duplicate");
  assert.equal(r.router.settled("t1", "incident"), true);
  assert.equal(r.closed.length, 1);
  const muted = rig({ prefs: { origin: "upgrade", notify: false } });
  assert.equal((await muted.router.offer(incident)).decision, "counts");
  assert.equal(muted.shown.length, 0);
  const quiet = rig({ quiet: { focus: true } });
  assert.equal((await quiet.router.offer(incident)).decision, "held");
  assert.equal(quiet.shown.length, 0);
});
