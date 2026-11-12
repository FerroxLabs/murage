// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { webcrypto } from "node:crypto";
import { createTrayPanel } from "./tray-panel.mjs";
import { createAttentionMain } from "./attention-main.mjs";
import * as attentionMainModule from "./attention-main.mjs";
import { createAppReadiness } from "./app-readiness.mjs";
import { createApprovalNotifications } from "./approval-notification.mjs";
import { createPresenceGuard } from "./presence-guard.mjs";
import { wirePresence } from "./presence-wiring.mjs";
import { cloudHomeSenderId } from "./main-trust.mjs";

// cc2f has no session module. This adapter only binds test identities; it does
// not recover cards or simulate an onEnd, so the lifecycle assertions fail there.
let createRendererSessions;
try { ({ createRendererSessions } = await import("./renderer-session.mjs")); }
catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  createRendererSessions = () => {
    const bound = new WeakMap();
    return { track() {}, current: wc => bound.get(wc), hello(wc, { home, session }) {
      const record = { home, session, webContentsId: wc.id, alive: true, ledger: new Set() };
      bound.set(wc, record); return { ok: true, record };
    } };
  };
}

const LEDGER_MAX = attentionMainModule.LEDGER_MAX ?? 288;
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const card = (i, extra = {}) => ({ kind: "approval", ref: `r${i}`, requestId: `q${i}`, threadId: "t", messageId: `m${i}`, botId: `b${i}`, ...extra });
const plain = (i, extra = {}) => ({ kind: "turn-failed", ref: `r${i}`, botId: `b${i}`, threadId: `t${i}`, at: i, ...extra });
const words = { title: "Ada", body: "Please review", privatePreview: false, silent: false };

// The legacy adapter maps calls to the closest pre-S3R operation. It never simulates delivery.
// Thus these tests fail on missing behaviour on the base, rather than missing exports.
function rig(options = {}) {
  let time = 0, nextSession = 0, reads = 0, preview = true, throws = options.throws ?? 0;
  const messages = [], notices = [], timers = [], slots = [], nativeClosed = [];
  const quiet = { locked: false, sharing: false, fullscreen: false, focus: false };
  const prefs = { origin: "upgrade", surfaces: { notify: true, receipt: true, pill: false, bubble: false }, hideFullscreen: true, respectFocus: true, quietSummary: false, nudgeMinutes: 0 };
  // Callable only for cc2f's presence() shape; S3R uses the guard methods.
  const presence = options.presence ?? Object.assign(() => quiet, { rev: 0, recheck: false, quiet: () => quiet, watch: () => () => {}, markConservative() { this.recheck = true; }, async refresh() { reads++; return options.refresh ? options.refresh(presence, quiet) : { ...quiet, rev: presence.rev }; } });
  const native = Object.assign(() => {}, {
    async prepare(input, { key, onSlot }) {
      const gate = deferred(); const slot = { key, input, cancelled: false, cancel() { this.cancelled = true; }, resolve: gate.resolve };
      slots.push(slot); onSlot(slot);
      if (options.nativeGate) await gate.promise;
      return slot.cancelled || options.nativeRefuse ? { ok: false } : { ok: true, prepared: { words: { title: input.requestId, body: `server ${input.requestId}` } } };
    },
    present(prepared, { key, onFailed, canShow, stillClear }) { options.onNativePresent?.({ canShow, stillClear }); const notice = makeNotice(prepared.words); notice.native = true; notice.key = key; notice.on("failed", () => onFailed(key)); notice.show(); return { accepted: true, handle: `n:${key}` }; },
    close(key) { nativeClosed.push(key); const n = notices.find(n => n.key === key); n?.close(); return Boolean(n); },
    setOnEvict(fn) { this.evict = fn; },
  });
  function makeNotice(input) {
    if (throws-- > 0) throw new Error("constructor refused");
    const n = new EventEmitter(); Object.assign(n, { input, closed: 0, shown: 0, show() { this.shown++; if (options.failedOnShow) this.emit("failed"); }, close() { this.closed++; if (options.reentrant) { this.emit("close"); this.emit("failed"); } } });
    notices.push(n); return n;
  }
  const nativeReads = [], opened = [], legacyOpened = [];
  const realNative = options.nativePlatform && createApprovalNotifications({
    platform: options.nativePlatform, authorize: options.authorize ?? (async () => true),
    revalidate: async input => { nativeReads.push(input); return options.revalidate ? options.revalidate(input) : { ...input, title: input.requestId, body: `server ${input.requestId}` }; },
    Notification: class { static isSupported() { return true; } static handleActivation() {} constructor(input) { return makeNotice(input); } },
    onOpen: target => legacyOpened.push(target),
  });
  const main = createAttentionMain({ prefs: () => prefs, presence, nativeApprovals: realNative || (options.native ? native : null),
    isAppFocused: options.isAppFocused,
    connectorReceipts: options.connectorReceipts,
    onOpen: target => opened.push(target),
    sendToSession(home, session, message) { messages.push({ home, ...message }); options.onMessage?.(message); return true; },
    sendShow(home, ref) { messages.push({ home, type: "show", ref, gen: 0 }); return true; },
    sendClose(home, ref) { messages.push({ home, type: "close", ref }); return true; },
    beforeDecision: () => presence.refresh(), createNotice: makeNotice,
    transportFor: () => ({ readCard: options.readCard ?? (async () => ({ open: true })) }),
    readPreviews: async () => preview, pillAvailable: () => options.pill === true,
    now: () => time, setTimer(fn, ms) { const timer = { fn, at: time + ms, live: true }; timers.push(timer); return timer; }, clearTimer(timer) { if (timer) timer.live = false; },
  });
  const modern = typeof main.present === "function";
  const session = (home = "local") => ({ home, session: (++nextSession).toString(36).padStart(25, "s"), webContentsId: nextSession, ledger: new Set(), alive: true });
  const offer = (s, f) => main.offer(modern ? s : s.home, { ...f, session: s.session });
  const show = (s, ref) => messages.findLast(m => m.type === "show" && m.ref === ref && (!modern || m.session === s.session));
  const present = (s, ref, extra = {}) => modern ? main.present(s, { ...words, session: s.session, ref, gen: show(s, ref)?.gen ?? 0, ...extra }) : Promise.resolve({ ok: true, kept: false });
  const end = async s => { s.alive = false; main.sessionEnded?.(s.webContentsId, s.session, s); await turn(); };
  const records = () => [...(main.records?.values() ?? [])];
  const record = (s, ref) => records().find(r => r.session === s.session && r.ref === ref);
  const tick = async ms => { time += ms; for (const t of [...timers]) if (t.live && t.at <= time) { t.live = false; t.fn(); } await turn(); };
  return { main, presence, quiet, prefs, messages, notices, timers, slots, nativeClosed, nativeReads, opened, legacyOpened, session, offer, show, present, end, records, record, tick,
    reads: () => reads, preview: async value => { preview = value; await main.previewsCheck(); },
    gone: (s, ref) => main.gone?.(s, { session: s.session, ref, gen: show(s, ref)?.gen ?? 0 }) ?? { ok: false },
    freed: (s, refs) => main.freed?.(s, refs), hello: s => main.hello?.(s) ?? { ok: true, retired: [] },
  };
}
async function started(options) { const r = rig(options); await r.preview(true); return r; }

test("D1: SENT session end presents the orphan exactly once", async () => {
  const r = await started(); const s = r.session(); await r.offer(s, card(1)); await r.end(s);
  assert.equal(r.notices.length, 1); assert.equal(r.record(s, "r1")?.state, "SHOWN");
});
test("D2: ended session and old generation cannot present again", async () => {
  const r = await started(); const s = r.session(); await r.offer(s, card(1)); await r.end(s);
  assert.equal((await r.present(s, "r1")).stale, true); assert.equal(r.notices.length, 1);
  const live = r.session(); await r.offer(live, card(2));
  const oldGen = r.show(live, "r2").gen;
  r.quiet.locked = true; assert.equal((await r.present(live, "r2")).kept, true);
  r.quiet.locked = false; await r.main.quietChanged();
  const rec = r.record(live, "r2"), deadline = rec.deadline;
  assert.equal(live.alive, true); assert.equal(rec.state, "SENT"); assert.ok(rec.gen > oldGen);
  assert.equal((await r.present(live, "r2", { gen: oldGen })).stale, true);
  assert.equal(rec.state, "SENT"); assert.equal(rec.deadline, deadline); assert.equal(rec.attempt, null);
  assert.equal(r.notices.length, 1);
  await r.present(live, "r2"); assert.equal(r.notices.length, 2);
});
test("D3: new nonce hello recovers the previous document's SENT card", async () => {
  const r = await started(); const wc = new EventEmitter(); wc.id = 7;
  const sessions = createRendererSessions({ origin: () => "http://localhost:5199", onEnd: (...args) => r.main.sessionEnded?.(...args) }); sessions.track(wc);
  const bind = session => sessions.hello(wc, { session, home: "local", top: true, url: "http://localhost:5199/" }).record;
  const s = bind("a".repeat(25)); await r.offer(s, card(1)); bind("b".repeat(25)); await turn();
  assert.equal(r.notices.length, 1);
});
test("D4: constructor failure retries a card with main words and previews closes it", async () => {
  const r = await started({ throws: 1 }); const s = r.session(); await r.offer(s, card(1)); await r.present(s, "r1"); await turn();
  assert.equal(r.notices.length, 1); assert.equal(r.notices[0].input.title, "Murage");
  await r.preview(false); assert.equal(r.notices[0].closed, 1);
});
test("D5: gone rolls a receipt back so a fresh ref can be admitted", async () => {
  const r = await started(); const s = r.session(); const f = plain(1, { kind: "done", deliveryId: "d" });
  await r.offer(s, f); r.gone(s, f.ref); const result = await r.offer(s, { ...f, ref: "again" });
  assert.equal(result.decision, "receipt-notify");
});
test("D6: reservation precedes the read, including settle during that read", async () => {
  for (const settle of [false, true]) {
    const gate = deferred(); const r = await started({ refresh: async p => { await gate.promise; return { rev: p.rev }; } });
    const a = r.session(), b = r.session(); const first = r.offer(a, card(1)); const second = r.offer(b, card(1, { ref: "other" }));
    if (settle) r.main.settled("local", "t", "q1"); gate.resolve();
    const reply = await second; assert.equal(reply.decision, "duplicate"); assert.ok(reply.retired?.includes("other")); await first;
    if (!settle) await r.present(a, "r1"); assert.equal(r.notices.length, settle ? 0 : 1);
  }
});
test("D7: all SENT or OFFERED records refuse overflow", async () => {
  for (const pending of [false, true]) {
    const gate = deferred(); const r = await started(pending ? { refresh: async p => { await gate.promise; return { rev: p.rev }; } } : {}); const s = r.session();
    const offers = Array.from({ length: 256 }, (_, i) => r.offer(s, plain(i)));
    if (!pending) await Promise.all(offers);
    const extra = r.offer(s, plain(256)); gate.resolve();
    const reply = await extra; await Promise.all(offers);
    assert.equal(reply.decision, "overflow"); assert.ok(reply.retired.includes("r256")); assert.equal(r.records().length, 256);
  }
});
test("D8: held approval survives 256 plain offers and can hand over its payload", async () => {
  const r = await started(); const s = r.session(); r.quiet.locked = true; await r.offer(s, card("approval"));
  for (let i = 0; i < 256; i++) await r.offer(s, plain(i));
  assert.ok(r.messages.some(m => m.type === "close" && m.ref === "r0"));
  r.quiet.locked = false; await r.main.quietChanged(); await r.present(s, "rapproval"); assert.equal(r.notices.length, 1);
});
test("D9: the oldest shown non-card closes before admission 257", async () => {
  const r = await started(); const s = r.session();
  for (let i = 0; i < 256; i++) { await r.offer(s, plain(i)); await r.present(s, `r${i}`); r.freed(s, [`r${i}`]); }
  await r.offer(s, plain(256)); assert.equal(r.notices[0]?.closed, 1); assert.equal(r.notices.length, 256);
});
test("D10: settle cancels native preparation; an uninterrupted attempt registers n:", async () => {
  const r = await started({ native: true, nativeGate: true }); const s = r.session();
  await r.offer(s, card(1)); const pending = r.present(s, "r1"); await turn();
  r.main.settled("local", "t", "q1"); r.slots[0]?.resolve(); await pending; assert.equal(r.notices.length, 0);
  await r.offer(s, card(2)); const other = r.present(s, "r2"); await turn(); r.slots.at(-1)?.resolve(); await other;
  assert.equal(r.notices.length, 1); assert.match(r.record(s, "r2")?.handle ?? "", /^n:/);
});
test("D11: previews off rewords SENT and closes every SHOWN handle of that home", async () => {
  const r = await started(); const s = r.session(); await r.offer(s, card(1)); await r.preview(false); await r.present(s, "r1");
  assert.equal(r.notices[0]?.input.title, "Murage"); assert.equal(r.notices[0]?.input.body, "Your attention is needed.");
  await r.preview(true); await r.offer(s, plain(2)); await r.present(s, "r2"); await r.preview(false);
  assert.ok(r.notices.every(n => n.closed === 1));
});
test("D12: quiet SENT session end holds an orphan until a committed release", async () => {
  const r = await started(); const s = r.session(); await r.offer(s, card(1)); r.quiet.locked = true; await r.end(s);
  assert.equal(r.record(s, "r1")?.state, "ORPHAN"); assert.equal(r.notices.length, 0);
  r.quiet.locked = false; await r.main.quietChanged(); assert.equal(r.notices.length, 1);
});
test("D13: dead sessions share the home cap and are evicted before live peers", async () => {
  const r = await started(); r.quiet.locked = true; const live = r.session(); await r.offer(live, card("live"));
  for (let j = 0; j < 3; j++) { const s = r.session(); for (let i = 0; i < 128; i++) await r.offer(s, card(`${j}-${i}`)); await r.end(s); }
  assert.equal(r.records().length, 256); assert.equal(r.record(live, "rlive")?.state, "HELD");
});
test("D14: repeated session/ref is idempotent", async () => {
  const r = await started(); const s = r.session(); const first = await r.offer(s, card(1)); const second = await r.offer(s, card(1));
  assert.equal(second.decision, first.decision); assert.equal(r.messages.filter(m => m.type === "show").length, 1);
});
test("D15: moved revision retries before committing a notice", async () => {
  let calls = 0; const gates = [deferred(), deferred()];
  const r = await started({ refresh: async p => { const n = calls++; if (n > 0 && n < 3) return gates[n - 1].promise; return { rev: p.rev }; } });
  const s = r.session(); await r.offer(s, plain(1)); const pending = r.present(s, "r1"); await turn(); r.presence.rev++;
  gates[0].resolve({ rev: 0 }); await turn(); assert.equal(r.notices.length, 0);
  gates[1].resolve({ rev: 1 }); await pending; assert.equal(r.notices.length, 1);
});
test("D16: quiet present keeps the plain payload until a later show", async () => {
  const r = await started(); const s = r.session(); await r.offer(s, plain(1)); r.quiet.locked = true;
  assert.equal((await r.present(s, "r1")).kept, true); assert.equal(r.record(s, "r1")?.state, "HELD");
  r.quiet.locked = false; await r.main.quietChanged(); await r.present(s, "r1"); assert.equal(r.notices[0]?.input.title, "Ada");
});
test("D17: equal refs in different sessions have independent handles and retired replies", async () => {
  const r = await started(); const a = r.session(), b = r.session();
  await r.offer(a, card(1)); await r.offer(b, card(2, { ref: "r1" })); await r.present(a, "r1"); await r.present(b, "r1");
  r.freed(b, ["r1"]); r.main.settled("local", "t", "q1");
  assert.equal(r.notices[0]?.closed, 1); assert.equal(r.notices[1]?.closed, 0); assert.deepEqual(r.hello(a).retired, ["r1"]); assert.deepEqual(r.hello(b).retired, []);
});
test("D18: concurrent orphan releases claim one attempt", async () => {
  const r = await started(); const s = r.session(); r.quiet.locked = true; await r.offer(s, card(1)); await r.end(s);
  r.quiet.locked = false; await Promise.all([r.main.quietChanged(), r.main.quietChanged()]); assert.equal(r.notices.length, 1);
});
test("D19: reentrant OS callbacks cannot change a settled outcome", async () => {
  const r = await started({ reentrant: true }); const s = r.session(); await r.offer(s, card(1)); await r.present(s, "r1");
  r.main.settled("local", "t", "q1"); assert.equal(r.notices[0]?.closed, 1); assert.equal(r.main.router.snapshot().needsYou, 0);
});
test("D20: deadline presents once and rejects the late hand-off", async () => {
  const r = await started(); const s = r.session(); await r.offer(s, card(1)); await r.tick(9999); assert.equal(r.notices.length, 0);
  await r.tick(1); assert.equal(r.notices.length, 1); assert.equal((await r.present(s, "r1")).stale, true);
});
for (const variant of ["b", "c", "d"]) test(`D20${variant}: expired native await cannot mutate the replacement attempt`, async () => {
  const r = await started({ native: true, nativeGate: true }); const s = r.session(); await r.offer(s, card(1)); await r.tick(9900);
  const old = r.present(s, "r1"); await turn(); await r.tick(100);
  assert.equal(r.slots[0]?.cancelled, true); assert.equal(r.slots.length, 2);
  const rec = r.record(s, "r1"), token = rec.attempt.token;
  if (variant === "c") rec.entry.generation++;
  if (variant === "d") { r.slots[1].resolve(); await turn(); }
  const handle = rec.handle;
  r.slots[0].resolve(); assert.equal((await old).stale, true);
  if (variant === "d") { assert.equal(rec.state, "SHOWN"); assert.equal(rec.handle, handle); }
  else {
    assert.equal(r.record(s, "r1"), rec); assert.equal(rec.retired, false);
    assert.equal(rec.state, "ORPHAN"); assert.equal(rec.attempt.token, token);
    if (variant === "c") rec.entry.generation = rec.entryGeneration;
    r.slots[1].resolve(); await turn();
  }
  assert.equal(r.notices.length, 1); assert.match(rec.handle, /^n:/);
});
test("D21: a full global table cannot bypass an unretirable home cap", async () => {
  const r = await started(); const sessions = Array.from({ length: 4 }, (_, i) => r.session(`home${i}`));
  for (const s of sessions) for (let i = 0; i < 256; i++) await r.offer(s, plain(i));
  await r.present(sessions[1], "r0");
  const other = r.record(sessions[1], "r0"), handle = other.handle;
  const result = await r.offer(sessions[0], plain(256)); assert.equal(result.decision, "overflow"); assert.equal(r.records().length, 1024);
  assert.equal(r.records().filter(rec => rec.home === sessions[0].home).length, 256);
  assert.equal(r.record(sessions[1], "r0"), other); assert.equal(other.handle, handle);
  assert.equal(other.state, "SHOWN"); assert.equal(r.notices[0].closed, 0);
});
test("D22: close pushes, replay, freed and ledger cap bound lost present replies", async () => {
  // Execute the production controller, with only its environment import replaced.
  // The appended observers expose sizes, without substituting payload ownership.
  const source = readFileSync(new URL("../src/lib/attention-offer.ts", import.meta.url), "utf8");
  const controller = () => runInNewContext(stripTypeScriptTypes(source)
    .replace(/import \{ notificationBridge \} from "\.\/cloud-workspace";/, "const notificationBridge = () => undefined;")
    .replace(/export /g, "") + `
      // cc2f's two actual tables remain observable without simulating delivery.
      const observedRefs = () => typeof payloads !== "undefined" ? [...payloads.keys()]
        : [...(typeof pending !== "undefined" ? pending.keys() : []), ...(typeof shown !== "undefined" ? shown.keys() : [])];
      ({routeNotification, reportAttentionVisible, size: () => observedRefs().length, refs: observedRefs})`,
  { crypto: webcrypto, queueMicrotask, console });
  for (const ack of [true, false]) {
    const renderer = controller(), shows = [], acks = [], committed = [];
    let receive, overflows = 0, rejected = 0, heldAcks = !ack, maxPayloads = 0, maxLedger = 0;
    // Assertions thrown inside the transport are swallowed as rejected replies, so
    // every bound violation is recorded here and asserted outside the transport.
    const violations = [], replies = [];
    const bound = () => {
      maxPayloads = Math.max(maxPayloads, renderer.size()); maxLedger = Math.max(maxLedger, s.ledger.size);
      if (renderer.size() > (ack ? 32 : LEDGER_MAX + 32)) violations.push(`renderer payloads ${renderer.size()}`);
      if (s.ledger.size > LEDGER_MAX) violations.push(`ledger ${s.ledger.size}`);
    };
    const r = await started({ onMessage: message => {
      if (message.type === "show") shows.push(message);
      else if (ack) receive?.(message);
      bound();
    } });
    const s = r.session();
    const bridge = {
      onShow(fn) { receive = fn; return () => {}; },
      async hello({ session }) { s.session = session; return r.hello(s); },
      async offer(payload) { const result = await r.offer(s, payload); if (result.decision === "overflow") overflows++; bound(); return result; },
      async present(payload) {
        const rec = r.record(s, payload.ref);
        const reply = await r.present(s, payload.ref, payload);
        replies.push(reply);
        // A later commit may already have retired this record, so commitment is the
        // main reply, not the live state. Every commit is counted before the loss.
        if (reply.ok === true && reply.stale !== true && reply.kept !== true) committed.push(rec);
        rejected++; bound(); throw new Error("present reply lost after commit");
      },
      async gone(payload) { return r.gone(s, payload.ref); },
      async visible(payload) { return r.main.visible(r.main.present ? s : s.home, payload); },
      freed({ refs }) { if (heldAcks) acks.push(...refs); else r.freed(s, refs); },
    };
    for (let start = 0; start < 300; start += 32) {
      for (let i = start; i < Math.min(start + 32, 300); i++) {
        renderer.routeNotification(plain(i, { botId: "one" }), () => ({ ...words, botId: "one", threadId: `t${i}` }), bridge);
        bound();
      }
      await turn(); // Offers succeed before the renderer answers their pushes.
      for (const message of shows.splice(0)) receive(message);
      await turn(); bound();
      assert.deepEqual(violations, [], "payload and ledger bounds hold at every observed step");
      assert.equal(r.timers.filter(t => t.live).length, 0, "no lingering hand-off or replay timer");
    }
    const expected = ack ? 300 : LEDGER_MAX;
    assert.equal(replies.length, expected, "every offered notice that was shown had its present reply rejected");
    assert.ok(replies.every(reply => reply.ok === true && reply.kept !== true && reply.stale !== true), "each rejected reply followed a real commit");
    assert.equal(committed.length, expected); assert.equal(new Set(committed.map(rec => rec.ref)).size, expected);
    assert.equal(r.notices.length, expected); assert.equal(overflows, 300 - expected);
    assert.equal(rejected, committed.length);
    // The ledger is bounded exactly: it reaches LEDGER_MAX when acks are withheld and never exceeds it.
    assert.equal(maxLedger, ack ? maxLedger : LEDGER_MAX); assert.ok(maxLedger <= LEDGER_MAX);
    assert.equal(s.ledger.size, ack ? 0 : LEDGER_MAX);
    assert.equal(committed.filter(rec => rec.retired).length, committed.length - 1);
    for (const rec of committed) {
      const closes = r.messages.filter(m => m.type === "close" && m.ref === rec.ref).length;
      assert.ok(closes >= 1, `commit closes ${rec.ref}`);
      // Withheld acks keep every coalesced payload in the ledger, requiring
      // another close at retirement. Acked payloads need no second push.
      if (!ack) assert.equal(closes, rec.retired ? 2 : 1, `coalescing closes ${rec.ref}`);
    }
    if (ack) { assert.equal(renderer.size(), 0); assert.ok(maxPayloads <= 32); }
    else {
      assert.ok(renderer.size() > 0, "lost closes and rejected presents retain real renderer payloads");
      // The real preload bounds each freed() call at LEDGER_MAX refs and main now bounds it too (F1), so the withheld acks arrive in bounded calls.
      heldAcks = false; for (let i = 0; i < acks.length; i += LEDGER_MAX) r.freed(s, acks.slice(i, i + LEDGER_MAX));
      const remaining = Array.from(renderer.refs());
      assert.ok(remaining.every(ref => s.ledger.has(ref)));
      renderer.reportAttentionVisible(null, false, bridge); await turn();
      assert.equal(renderer.size(), 0, "visibility reply replays and removes the retained payloads");
      assert.equal(s.ledger.size, 0, "controller acknowledges replayed retirements");
    }
  }
});
test("D23: tombstones use ledger capacity without consuming record slots, home and global", async () => {
  for (const homes of [1, 4]) {
    const r = await started(); r.quiet.locked = true; const sessions = Array.from({ length: homes }, (_, i) => r.session(`h${i}`));
    for (const s of sessions) for (let i = 0; i < 256; i++) await r.offer(s, plain(i));
    for (let i = 256; i < 296; i++) {
      const result = await r.offer(sessions[0], plain(i)); assert.equal(result.decision, i < 288 ? "held" : "overflow");
      assert.equal(r.records().length, 256 * homes);
    }
    assert.equal(sessions[0].ledger.size, 288);
  }
});
test("D24: twenty native presenters without events never overtake", async () => {
  const r = await started({ native: true }); const s = r.session();
  await Promise.all(Array.from({ length: 20 }, (_, i) => r.offer(s, card(i)))); await Promise.all(Array.from({ length: 20 }, (_, i) => r.present(s, `r${i}`)));
  assert.equal(r.notices.length, 20); assert.ok(r.records().every(rec => rec.state === "SHOWN" && rec.handle.startsWith("n:"))); assert.ok(r.reads() <= 60); assert.equal(r.presence.recheck, false);
});
test("D25: receipt never coalesces a card; next card coalesces the bot's m notices", async () => {
  const r = await started(); const s = r.session(); await r.offer(s, card(1, { botId: "bot" })); await r.present(s, "r1");
  await r.offer(s, plain(2, { kind: "done", deliveryId: "d", botId: "bot" })); await r.present(s, "r2");
  assert.equal(r.notices[0]?.closed, 0); assert.equal(r.record(s, "r1")?.state, "SHOWN");
  assert.equal(r.record(s, "r2")?.state, "SHOWN"); assert.equal(r.notices[1]?.shown, 1);
  const first = r.record(s, "r1"), identity = first.entry;
  await r.offer(s, card(3, { botId: "bot" })); await r.present(s, "r3"); assert.equal(r.notices[0].closed, 1);
  assert.equal(first.outcome, "counted"); assert.equal(r.record(s, "r1"), undefined);
  assert.equal(r.main.router.current(identity), true); assert.equal(identity.record, null);
  assert.equal(r.main.router.snapshot().needsYou, 2);
  assert.equal((await r.offer(s, card(1, { botId: "bot", ref: "repeat" }))).decision, "duplicate");
});
test("D26: an OFFERED orphan reruns the rung decision with the dead session invisible", async () => {
  for (const pill of [true, false]) {
    const gate = deferred(); let first = true; const r = await started({ pill, refresh: async p => { if (first) { first = false; await gate.promise; } return { rev: p.rev }; } });
    r.prefs.origin = "new"; r.prefs.surfaces.pill = pill;
    const s = r.session(); assert.equal(r.main.visible(s, { threadId: "t", focused: true }).ok, true);
    const pending = r.offer(s, card(1));
    const rec = r.record(s, "r1"); assert.equal(rec.state, "OFFERED");
    assert.equal(r.main.router.decide(rec.entry, { rev: 0 }), "on-screen", "live session would suppress this card");
    await r.end(s); gate.resolve(); await pending; await turn();
    assert.equal(r.notices.length, pill ? 0 : 1); assert.equal(r.record(s, "r1")?.state ?? "counted", pill ? "counted" : "SHOWN");
    assert.equal(r.main.router.snapshot().needsYou, 1);
    assert.equal(rec.decision, pill ? "pill" : "notify");
  }
});
test("D27: native orphan preparation uses its own request ids", async () => {
  for (const nativePlatform of ["win32", "darwin"]) {
    const r = await started({ nativePlatform }); const a = r.session(), b = r.session(); await r.offer(a, card("X")); await r.offer(b, card("Y"));
    await r.end(a); await r.present(b, "rY");
    assert.deepEqual(r.nativeReads.map(p => [p.requestId, p.threadId]), [["qX", "t"], ["qY", "t"]]);
    assert.equal(r.notices.length, 2);
    for (const [index, request] of ["qX", "qY"].entries()) {
      const options = r.notices[index].input;
      if (nativePlatform === "win32") assert.ok(options.toastXml.includes(`<text>${request}</text><text>server ${request}</text>`));
      else assert.deepEqual([options.title, options.body], [request, `server ${request}`]);
      assert.equal(r.notices[index].shown, 1);
    }
  }
});
test("N5: previews off closes all native handles of the home", async () => {
  const r = await started({ native: true }); const s = r.session(); for (let i = 0; i < 2; i++) { await r.offer(s, card(i)); await r.present(s, `r${i}`); }
  await r.preview(false); assert.equal(r.nativeClosed.length, 2); assert.ok(r.notices.every(n => n.closed === 1));
});
test("N7: OS close changes nothing and settle withdraws once", async () => {
  for (const native of [false, true]) { const r = await started({ native }); const s = r.session(); await r.offer(s, card(1)); await r.present(s, "r1");
    assert.equal(r.notices.length, 1); const handle = r.record(s, "r1").handle; r.notices[0].emit("close");
    assert.equal(r.record(s, "r1").handle, handle); assert.equal(r.record(s, "r1").state, "SHOWN");
    r.main.settled("local", "t", "q1"); assert.equal(r.notices[0].closed, 1); assert.equal(r.main.router.snapshot().needsYou, 0);
  }
});
test("P5: three revision overtakes hold conservatively; the guard commit automatically releases", async t => {
  const reads = [], powerMonitor = new EventEmitter(); let manual = true, autoPresent = false, passes = 0;
  const lock = { state: () => "unlocked", refresh: async () => {}, onChange: () => () => {} };
  const presence = createPresenceGuard({ platform: "darwin", lock,
    addon: { read() { if (!manual) return {}; const gate = deferred(); reads.push(gate); return gate.promise; } },
    setTimer: () => ({}), clearTimer() {},
  });
  const r = await started({ presence, onMessage(message) { if (autoPresent && message.type === "show") void r.present(s, message.ref); } });
  const s = r.session();
  const off = wirePresence({ lock, powerMonitor, presenceGuard: presence, attentionMain: r.main });
  presence.onChange(() => { passes++; });
  t.after(() => { off(); r.main.dispose(); presence.dispose(); });
  const offer = r.offer(s, plain(1)); await turn(); reads[0].resolve({}); await offer;
  const pending = r.present(s, "r1"); await turn();
  for (let i = 1; i <= 5; i += 2) {
    assert.equal(reads.length, i + 1);
    powerMonitor.emit("lock-screen"); // Evidence overtakes this unlocked read.
    reads[i].resolve({}); await turn();
    assert.equal(r.notices.length, 0);
    if (i < 5) { reads[i + 1].resolve({}); await turn(); }
  }
  assert.equal((await pending).kept, true); assert.equal(r.record(s, "r1").state, "HELD");
  assert.equal(presence.recheck, true); assert.equal(passes, 0);
  manual = false; autoPresent = true;
  reads[6].resolve({}); // The queued production read commits unchanged values.
  await turn(); await turn();
  assert.equal(presence.recheck, false); assert.equal(passes, 1);
  assert.equal(r.record(s, "r1").state, "SHOWN"); assert.equal(r.notices.length, 1);
  await presence.refresh(); await turn(); assert.equal(passes, 1); assert.equal(r.notices.length, 1);
});
test("P6: quiet in the second release read spends nothing", async () => {
  let release = false, reads = 0; const r = await started({ refresh: async p => ({ rev: p.rev, locked: release ? ++reads === 2 : true }) });
  const s = r.session(); await r.offer(s, card(1)); release = true; await r.main.quietChanged();
  assert.equal(r.record(s, "r1")?.state, "HELD"); assert.equal(r.messages.filter(m => m.type === "show").length, 0);
});
test("P7: decisions use the returned locked snapshot, not a live unlocked cache", async () => {
  const r = await started({ refresh: async p => ({ rev: p.rev, locked: true }) }); const s = r.session();
  assert.equal((await r.offer(s, card(1))).decision, "held"); assert.equal(r.record(s, "r1")?.state, "HELD");
});
test("P8: overlapping presenters on the real presence guard use their returned snapshots without overtakes", async t => {
  // The production guard, wired to lock and power events; only its addon, lock
  // source and timers are injected. Reads are held open to control completion order.
  const gates = [], powerMonitor = new EventEmitter(), lockListeners = new Set();
  let auto = true, fullscreen = false, locked = false;
  const lock = { state: () => locked ? "locked" : "unlocked", refresh: async () => {},
    onChange: fn => { lockListeners.add(fn); return () => lockListeners.delete(fn); } };
  const setLock = value => { locked = value; for (const fn of [...lockListeners]) fn(value); };
  const presence = createPresenceGuard({ platform: "darwin", lock, setTimer: () => ({}), clearTimer() {},
    addon: { read() { if (auto) return { fullscreen }; const gate = deferred(); gates.push(gate); return gate.promise; } } });
  const r = await started({ presence });
  const s = r.session();
  const off = wirePresence({ lock, powerMonitor, presenceGuard: presence, attentionMain: r.main });
  t.after(() => { off(); r.main.dispose(); presence.dispose(); });
  await r.offer(s, plain(1)); await r.offer(s, plain(2));
  // Lock and power events (each requests a complete read and bumps the revision), then a committed fullscreen.
  const before = presence.rev;
  setLock(true); await turn(); setLock(false); await turn();
  for (const event of ["suspend", "resume", "lock-screen", "unlock-screen"]) { powerMonitor.emit(event); await turn(); }
  assert.ok(presence.rev > before, "events advanced the guard revision");
  fullscreen = true; await presence.refresh(); await turn();
  assert.equal(presence.quiet().fullscreen, true, "the committed snapshot is fullscreen");
  const revSeeded = presence.rev, readsSeeded = presence.reads;
  // Two concurrent presentNow calls. The first joins a read, the second the one queued behind it.
  auto = false; fullscreen = false;
  // The committed fullscreen -> false change also makes the release path (quietChanged) read once; those
  // reads are not presenter reads, so presenter reads are counted by their caller.
  let presenterReads = 0; const guardRefresh = presence.refresh;
  presence.refresh = () => { if (new Error().stack.includes("presentNow")) presenterReads++; return guardRefresh(); };
  const pending = Promise.all([r.present(s, "r1"), r.present(s, "r2")]); await turn();
  assert.equal(presenterReads, 2); assert.equal(presence.reads - readsSeeded, 1); assert.equal(gates.length, 1);
  assert.equal(r.notices.length, 0, "no notice while the first read is open");
  gates[0].resolve({}); await turn();
  // The first read commits fullscreen -> false (a changed snapshot): its presenter must use that reply, not a pre-read revision.
  assert.equal(presence.rev, revSeeded + 1); assert.equal(presence.quiet().fullscreen, false);
  assert.equal(r.notices.length, 1, "the first presenter commits on its own changed snapshot");
  assert.equal(presenterReads, 2, "the first presenter did not read again after its changed snapshot");
  gates[1].resolve({}); await pending;
  assert.equal(r.notices.length, 2); assert.equal(presenterReads, 2, "zero overtakes: exactly one read per presenter");
  assert.equal(presence.recheck, false, "no conservative recheck was requested");
  assert.equal(presence.rev, revSeeded + 1);
  assert.equal(r.record(s, "r1").state, "SHOWN"); assert.equal(r.record(s, "r2").state, "SHOWN");
});
test("S2: uncommitted navigation keeps SENT and present creates one main notice", async () => {
  const r = await started(); const wc = new EventEmitter(); wc.id = 1;
  const probes = [], drained = [];
  const readiness = createAppReadiness({ origin: () => "http://localhost:5199", probe: (_wc, token) => probes.push(token) });
  readiness.track(wc); wc.emit("did-navigate", {}, "http://localhost:5199/", 200);
  for (let i = 0; i < 32; i++) readiness.defer(wc, () => drained.push(i));
  const sessions = createRendererSessions({ origin: () => "http://localhost:5199", onEnd: (...args) => r.main.sessionEnded?.(...args) }); sessions.track(wc);
  const s = sessions.hello(wc, { session: "x".repeat(25), home: "local", top: true, url: "http://localhost:5199/" }).record;
  await r.offer(s, card(1)); wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: "http://localhost:5199/next" });
  wc.emit("did-fail-load", {}, -3, "ERR_ABORTED"); wc.emit("did-stop-loading");
  assert.equal(readiness.ready(wc), false); assert.equal(probes.length, 1);
  assert.equal(readiness.alive(wc, probes[0], { top: true, url: "http://localhost:5199/", frameOrigin: "http://localhost:5199" }), true);
  assert.equal(s.alive, true); await r.present(s, "r1"); assert.equal(r.notices.length, 1);
  assert.deepEqual(drained, []); assert.equal(readiness.flush(wc), 32); assert.deepEqual(drained, Array.from({ length: 32 }, (_, i) => i));
});

test("IPC binds the top frame nonce, derives Cloud home and refuses foreign present/freed", async () => {
  const r = await started(); const handlers = new Map(), listeners = new Map(), windows = new Map();
  const sessions = createRendererSessions({ origin: () => "http://localhost:5199", onEnd: (...args) => r.main.sessionEnded?.(...args) });
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const attentionBinder=");
  assert.ok(start > 0, "main.mjs binds every attention channel to the renderer session");
  const end = source.indexOf("// B3 WP4: the pairing UI's channels", start);
  runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) },
    rendererSessions: sessions, attentionMain: r.main, cloudHome: { senderHomeId: event => cloudHomeSenderId(event, windows) },
  });
  for (const cloud of [true, false]) {
    const wc = new EventEmitter(); wc.id = cloud ? 2 : 1; if (cloud) wc.home = "cloud-home";
    const prefix = cloud ? "cloud-attention" : "attention", session = (cloud ? "c" : "l").repeat(25);
    const event = { sender: wc, senderFrame: { parent: null, url: cloud ? "murage-home://cloud-home/" : "http://localhost:5199/" } };
    wc.mainFrame = event.senderFrame; wc.isDestroyed = () => false;
    if (cloud) windows.set(wc.home, { webContents: wc, isDestroyed: () => false });
    const invoke = (method, payload, e = event) => handlers.get(`${prefix}:${method}`)?.(e, payload) ?? { ok: false };
    assert.equal((await invoke("hello", { session })).ok, true);
    if (cloud) {
      assert.equal((await handlers.get("attention:hello")(event, { session, trusted: true })).ok, false);
      assert.equal((await handlers.get("attention:offer")(event, { ...card("local-forged"), session })).ok, false);
      const popup = new EventEmitter(); popup.id = 99; popup.mainFrame = event.senderFrame;
      assert.equal((await invoke("hello", { session: "p".repeat(25) }, { ...event, sender: popup })).ok, false);
      for (const url of ["https://foreign.example/", "murage-home://other-home/"]) {
        event.senderFrame.url = url;
        assert.equal((await invoke("hello", { session })).ok, false);
      }
      event.senderFrame.url = "murage-home://cloud-home/";
    }
    const s = sessions.current(wc); assert.equal(s.home, cloud ? "cloud-home" : "local");
    const ref = cloud ? "cloud-ref" : "local-ref";
    assert.equal((await invoke("offer", { ...card(ref, { ref }), session, home: "forged" })).decision, "notify");
    const sent = r.show(s, ref); assert.ok(sent); assert.equal(sent.home, s.home);
    const payload = { ...words, ref, gen: sent.gen, session };
    assert.equal((await invoke("present", { ...payload, session: "z".repeat(25) })).ok, false);
    assert.equal((await invoke("present", payload, { ...event, senderFrame: { ...event.senderFrame, parent: {} } })).ok, false);
    assert.equal((await invoke("present", payload, { ...event, senderFrame: { parent: null, url: "https://foreign.example/" } })).ok, false);
    assert.equal((await invoke("present", payload)).ok, true);
    const visibility = await invoke("visible", { session, threadId: null, focused: false });
    assert.equal(visibility.ok, true); assert.deepEqual(visibility.retired, [ref]);
    listeners.get(`${prefix}:freed`)(event, { session: "z".repeat(25), refs: [ref] }); assert.equal(s.ledger.has(ref), true);
    listeners.get(`${prefix}:freed`)(event, { session, refs: [ref, "unknown"] }); assert.equal(s.ledger.size, 0);
  }
  assert.equal(r.notices.length, 2);
});

test("native clicks use the originating session and fall back after its document ends", async () => {
  for (const nativePlatform of ["win32", "darwin"]) for (const dead of [false, true]) {
    const r = await started({ nativePlatform }), s = r.session("cloud-home");
    await r.main.previewsCheck(s.home); await r.offer(s, card(1)); await r.present(s, "r1");
    if (dead) await r.end(s);
    r.notices[0].emit("click"); r.notices[0].emit("click");
    assert.deepEqual(r.opened, [{ home: s.home, session: dead ? null : s.session, botId: "b1", threadId: "t", messageId: "m1" }]);
    assert.deepEqual(r.legacyOpened, []);
  }
});

test("Mac preparation refusal retries the open card with orphan words", async () => {
  let attempts = 0;
  const r = await started({ nativePlatform: "darwin", authorize: async () => ++attempts > 1 });
  const s = r.session(); await r.offer(s, card(1)); await r.present(s, "r1");
  assert.equal(attempts, 3); assert.equal(r.notices.length, 1); assert.equal(r.record(s, "r1").state, "SHOWN");
});

test("Windows orphan revalidation refuses a card that disappeared", async () => {
  const r = await started({ nativePlatform: "win32", revalidate: async () => null, readCard: async () => ({ open: false }) });
  const s = r.session(); await r.offer(s, card(1)); await r.end(s);
  assert.equal(r.nativeReads.length, 1); assert.equal(r.nativeReads[0].requestId, "q1");
  assert.equal(r.notices.length, 0); assert.equal(r.main.router.snapshot().needsYou, 0);
});

test("disposal closes all main handles and cancels pending hand-offs before late callbacks", async () => {
  const r = await started({ native: true, nativeGate: true, reentrant: true }); const s = r.session();
  await r.offer(s, plain(1)); await r.present(s, "r1"); await r.offer(s, card(2));
  const pending = r.present(s, "r2"); await turn(); r.main.dispose?.();
  assert.equal(r.notices[0]?.closed, 1); assert.equal(r.slots[0]?.cancelled, true);
  r.slots[0].resolve(); await pending; assert.equal(r.notices.length, 1); assert.equal(r.records().length, 0);
  assert.equal(r.timers.filter(t => t.live).length, 0); assert.equal((await r.offer(s, card(3))).ok, false);
});

test("malformed display fields refuse without creating a notice; private icons never leave main", async () => {
  const r = await started(); const s = r.session(); await r.offer(s, plain(1));
  for (const extra of [{ title: "x".repeat(257) }, { body: "x".repeat(1025) }, { icon: "https://foreign.example/avatar.png" }, { silent: "yes" }]) {
    assert.equal((await r.present(s, "r1", extra)).ok, false);
  }
  assert.equal(r.notices.length, 0);
  await r.present(s, "r1", { privatePreview: true, icon: "data:image/png;base64,AAAA" });
  assert.equal(r.notices.length, 1); assert.equal(r.notices[0].input.icon, undefined);
});

test("native revalidation of a gone card drops its counts identity", async () => {
  const reads = [];
  const r = await started({ native: true, nativeRefuse: true, readCard: async ids => { reads.push(ids); return { open: false }; } });
  const s = r.session(); await r.offer(s, card(1)); await r.present(s, "r1");
  assert.equal(r.notices.length, 0); assert.deepEqual(reads, [{ threadId: "t", messageId: "m1" }]);
  assert.equal(r.main.router.snapshot().needsYou, 0);
});

test("a synchronous OS failed event cannot leave a committed handle", async () => {
  for (const native of [false, true]) {
    const r = await started({ native, failedOnShow: true }); const s = r.session();
    await r.offer(s, card(1)); await r.present(s, "r1");
    assert.equal(r.notices.length, 1); assert.equal(r.records().length, 0); assert.equal(r.main.router.snapshot().needsYou, 1);
    assert.equal(r.notices[0].closed, 0, "OS failure nulls its handle before counted retirement");
  }
});

test("GH24 focus during native preparation keeps the pending request in app", async () => {
  const r = await started({ native: true, nativeGate: true }); const s = r.session();
  await r.offer(s, card(1)); const pending = r.present(s, "r1"); await turn();
  assert.equal(r.slots.length, 1);
  r.main.visible(s, { threadId: "another-thread", focused: true });
  r.slots[0].resolve(); await pending;
  assert.equal(r.notices.length, 0, "focus acquired during preparation suppresses the OS banner");
  assert.equal(r.main.router.snapshot().needsYou, 1);
});

test("GH24 native fallback rechecks focus after its presence read", async () => {
  let presentation;
  const r = await started({ native: true, onNativePresent: value => { presentation = value; } }); const s = r.session();
  await r.offer(s, card(1)); await r.present(s, "r1");
  assert.equal(await presentation.canShow(), true);
  r.main.visible(s, { threadId: "another-thread", focused: true });
  assert.equal(presentation.stillClear(), false, "focus after the read suppresses the fallback");
  assert.equal(await presentation.canShow(), false, "fallback presence check includes app focus");
});

test("GH24 a closed focused renderer releases held cards to native delivery", async () => {
  const r = await started(); const s = r.session();
  r.main.visible(s, { threadId: "another-thread", focused: true });
  r.quiet.locked = true; await r.offer(s, card(1)); await r.end(s);
  r.quiet.locked = false; await r.main.quietChanged(); await turn();
  assert.equal(r.notices.length, 1, "a dead renderer cannot suppress a released card");
});
test("GH24 closing an older session keeps the newer session focus", async () => {
  const r = await started(); const old = r.session(), fresh = r.session();
  r.main.visible(old, { threadId: "old-thread", focused: true });
  r.main.visible(fresh, { threadId: "new-thread", focused: true });
  await r.end(old);
  assert.equal((await r.offer(fresh, card(1))).decision, "counts");
  assert.equal(r.notices.length, 0);
});
test("GH24 an orphan respects a newer focused session on the same home", async () => {
  const r = await started(); const old = r.session(), fresh = r.session();
  await r.offer(old, card(1));
  r.main.visible(fresh, { threadId: "another-thread", focused: true });
  await r.end(old);
  assert.equal(r.notices.length, 0, "an orphan cannot bypass the current renderer focus");
  assert.equal(r.main.router.snapshot().needsYou, 1);
});

// Electron owns this focus state, including windows with no attention renderer.
function auxiliaryFocus(platform = "linux") {
  let focused = null;
  class Window extends EventEmitter {
    constructor() {
      super(); this.webContents = new EventEmitter(); this.webContents.id = 200;
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = () => {};
    }
    static getFocusedWindow() { return focused; }
    focus() { focused = this; }
    hide() { if (focused === this) focused = null; }
    destroy() { this.hide(); this.destroyed = true; this.emit("closed"); }
    isDestroyed() { return this.destroyed === true; }
    show() {} setBounds() {} setContentProtection() {} async loadURL() {}
  }
  const primary = new Window();
  const panel = createTrayPanel({ BrowserWindow: Window, platform,
    tray: { getBounds: () => ({ x: 0, y: 0, width: 20, height: 20 }) },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }) },
    attentionIpc: { register() {}, unregister() {} }, loadUrlFor: () => "file:///fixture/panel.html",
    setTimer: () => 1, clearTimer() {} });
  return { primary, panel, isAppFocused: () => Window.getFocusedWindow() !== null };
}

for (const platform of ["linux", "darwin", "win32"]) {
  test(`GH24 ${platform}: main-to-tray focus keeps approvals in app and releases on hide or close`, async () => {
    const f = auxiliaryFocus(platform), r = await started({ isAppFocused: f.isAppFocused });
    const s = r.session();
    f.primary.focus(); r.main.visible(s, { threadId: "another-thread", focused: true });
    assert.equal((await r.offer(s, card(1))).decision, "counts");
    await f.panel.show();
    r.main.visible(s, { threadId: "another-thread", focused: false });
    assert.equal((await r.offer(s, card(2))).decision, "counts", "focused tray suppresses OS banners after main renderer blur");
    assert.equal(r.notices.length, 0);
    assert.equal(r.main.router.snapshot().needsYou, 2, "approvals remain available in app");
    f.panel.hide();
    assert.equal((await r.offer(s, card(3))).decision, "notify");
    await r.present(s, "r3"); assert.equal(r.notices.length, 1);
    await f.panel.show();
    assert.equal((await r.offer(s, card(4))).decision, "counts");
    f.panel.destroy();
    assert.equal((await r.offer(s, card(5))).decision, "notify");
    await r.present(s, "r5"); assert.equal(r.notices.length, 2);
  });
}

test("GH24 auxiliary focus during native preparation keeps the pending approval in app", async () => {
  const f = auxiliaryFocus(), r = await started({ isAppFocused: f.isAppFocused, native: true, nativeGate: true });
  const s = r.session(); await r.offer(s, card(1));
  const pending = r.present(s, "r1"); await turn();
  assert.equal(r.slots.length, 1); await f.panel.show();
  r.slots[0].resolve(); await pending;
  assert.equal(r.notices.length, 0, "auxiliary focus acquired during preparation suppresses the OS banner");
  assert.equal(r.main.router.snapshot().needsYou, 1); f.panel.destroy();
});

test("GH24 native fallback checks auxiliary focus immediately and after a presence read", async () => {
  let presentation;
  const f = auxiliaryFocus(), r = await started({ isAppFocused: f.isAppFocused, native: true,
    onNativePresent: value => { presentation = value; } });
  const s = r.session(); await r.offer(s, card(1)); await r.present(s, "r1");
  assert.equal(await presentation.canShow(), true); await f.panel.show();
  assert.equal(presentation.stillClear(), false, "auxiliary focus suppresses the fallback");
  assert.equal(await presentation.canShow(), false);
  f.panel.destroy(); assert.equal(await presentation.canShow(), true);
});

test("GH24 desktop composition supplies Electron application focus to attention delivery", () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(source, /attentionMain\s*=\s*createAttentionMain\(\{[\s\S]*?isAppFocused:\s*\(\)\s*=>\s*BrowserWindow\.getFocusedWindow\(\)\s*!==\s*null/);
});


test("P1-4 receipt requires show confirmation and late failure permits bounded retry across restart", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { removeTempDir } = await import("../server/testing/cleanup.ts");
  const { createConnectorNoticeReceipts } = await import("./connector-notice-receipts.mjs");
  const dir = mkdtempSync(join(tmpdir(), "connector-delivery-"));
  try {
    const file = join(dir, "receipts.json");
    let receipts = createConnectorNoticeReceipts(file);
    const r = rig({ connectorReceipts: receipts }), s = r.session();
    const f = { kind: "connector-reconnect", ref: "reconnect", deliveryId: "incident", botId: "owner", at: 1 };
    await r.offer(s, f); await r.present(s, f.ref);
    assert.equal(receipts.has("local", "incident"), false, "show() is not confirmation");
    r.notices[0].emit("show");
    assert.equal(receipts.has("local", "incident"), true);
    r.notices[0].emit("failed");
    assert.equal(receipts.has("local", "incident"), false, "late failure revokes delivery");
    r.main.dispose();
    receipts = createConnectorNoticeReceipts(file);
    const retry = rig({ connectorReceipts: receipts }), next = retry.session();
    await retry.offer(next, f); await retry.present(next, f.ref);
    assert.equal(retry.notices.length, 0, "restart respects retry backoff");
    retry.main.dispose();
    assert.equal(receipts.canAttempt("local", "incident", 60001), true);
    for (let n = 0; n < 3; n++) receipts.attempt("local", "incident", 60001 + n * 60000);
    assert.equal(createConnectorNoticeReceipts(file).canAttempt("local", "incident", 999999), false, "attempt ceiling survives restart");
  } finally { await removeTempDir(dir); }
});

test("P1-4 failed delivery automatically retries once the bound allows it", async () => {
  let attempts = 0, receipt = false;
  const r = rig({ connectorReceipts: {
    has: () => receipt, canAttempt: () => attempts < 3,
    attempt: () => { attempts++; return attempts <= 3; }, delivered: () => { receipt = true; }, failed: () => { receipt = false; },
  } });
  const s = r.session(), frame = { kind: "connector-reconnect", ref: "retry", deliveryId: "incident", botId: "owner", at: 1 };
  await r.offer(s, frame); await r.present(s, frame.ref);
  r.notices[0].emit("failed");
  await r.tick(60000);
  assert.equal(r.notices.length, 2);
  assert.equal(receipt, false);
  r.notices[1].emit("show");
  assert.equal(receipt, true);
  await r.tick(60000);
  assert.equal(r.notices.length, 2);
  r.main.dispose();
});
