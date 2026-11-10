// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// NOTIFY-EVERYWHERE-1019 S3R rev 3.0 R10: S1, S2 (renderer session, the A14 extension).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { createAppReadiness } from "./app-readiness.mjs";
import { createRendererSessions } from "./renderer-session.mjs";
import { createAttentionMain } from "./attention-main.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://127.0.0.1:8799";
const TOP = { top: true, url: `${ORIGIN}/` };
let ids = 100;
const fakeContents = () => Object.assign(new EventEmitter(), { id: ++ids, isCrashed: () => false, isDestroyed: () => false, isLoadingMainFrame: () => false });
const nonce = (n) => `n${n}`.padEnd(25, "a");
const start = (wc, url, extra = {}) => wc.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false, ...extra });
const commit = (wc, url = `${ORIGIN}/`, code = 200) => wc.emit("did-navigate", {}, url, code, "");

function rig() {
  const ended = [];
  const sessions = createRendererSessions({ origin: () => ORIGIN, onEnd: (id, session) => ended.push([id, session]) });
  const wc = fakeContents();
  sessions.track(wc);
  return { sessions, wc, ended };
}
const bind = (r, n = 1, home = "local") => {
  const res = r.sessions.hello(r.wc, { session: nonce(n), home, ...TOP });
  assert.equal(res.ok, true);
  return res;
};

test("S1 a cross-document commit, a crash, destroy and a new-nonce hello each end the session exactly once", () => {
  for (const [label, cause] of [
    ["did-navigate", (wc) => commit(wc, `${ORIGIN}/other`)],
    ["render-process-gone", (wc) => wc.emit("render-process-gone", {}, { reason: "crashed" })],
    ["destroyed", (wc) => wc.emit("destroyed")],
  ]) {
    const r = rig();
    bind(r);
    cause(r.wc);
    cause(r.wc); // the second report of the same death changes nothing
    assert.deepEqual(r.ended, [[r.wc.id, nonce(1)]], label);
    assert.equal(r.sessions.current(r.wc), null, label);
    assert.equal(r.sessions.isLive(nonce(1)), false, label);
  }
  const r = rig();
  bind(r, 1);
  const second = r.sessions.hello(r.wc, { session: nonce(2), home: "local", ...TOP });
  assert.equal(second.ok, true);
  assert.equal(second.started, true);
  assert.deepEqual(r.ended, [[r.wc.id, nonce(1)]], "the old session ends, then the new one binds");
  assert.equal(r.sessions.current(r.wc).session, nonce(2));
});

test("S1 same-document and uncommitted navigation, a probe ack and a same-nonce hello do not end the session", () => {
  const r = rig();
  let token;
  const readiness = createAppReadiness({ origin: () => ORIGIN, probe: (_c, t) => { token = t; } });
  readiness.track(r.wc);
  commit(r.wc);
  bind(r);
  r.wc.emit("did-navigate-in-page", {}, `${ORIGIN}/#/x`, true);
  start(r.wc, "https://example.com/", { navigationId: 5 });
  r.wc.emit("did-fail-load", { navigationId: 5 }, -3, "", "https://example.com/", true);
  r.wc.emit("did-stop-loading");
  assert.equal(readiness.alive(r.wc, token, TOP), true, "A14 grants the app back through its own ack");
  r.wc.emit("did-stop-loading");
  const again = r.sessions.hello(r.wc, { session: nonce(1), home: "local", ...TOP });
  assert.deepEqual({ ok: again.ok, started: again.started }, { ok: true, started: false });
  assert.deepEqual(r.ended, []);
  assert.equal(r.sessions.current(r.wc).session, nonce(1));
  assert.equal(again.record, r.sessions.current(r.wc), "the ledger lives on the same record");
});

test("S1 hello trust: only the top frame on the app origin, a well-formed nonce, one home, nonces never shared", () => {
  const r = rig();
  const h = (extra) => r.sessions.hello(r.wc, { session: nonce(1), home: "local", ...TOP, ...extra }).ok;
  assert.equal(h({ top: false }), false, "a sub-frame");
  assert.equal(h({ url: "https://evil.example/" }), false, "another origin");
  assert.equal(h({ url: "data:text/html,x" }), false, "an opaque origin");
  assert.equal(h({ session: "short" }), false, "a malformed nonce");
  assert.equal(h({ session: 42 }), false);
  assert.equal(h({ home: "" }), false);
  assert.equal(r.sessions.current(r.wc), null);
  assert.equal(h({}), true);
  assert.equal(h({ home: "cloud:other" }), false, "a re-hello cannot move the session to another home");
  assert.equal(r.sessions.hello(fakeContents(), { session: nonce(1), home: "local", ...TOP }).ok, false, "an untracked webContents");
  const other = fakeContents();
  r.sessions.track(other);
  assert.equal(r.sessions.hello(other, { session: nonce(1), home: "local", ...TOP }).ok, false, "a nonce a live window already holds");
  commit(r.wc, `${ORIGIN}/reloaded`);
  assert.equal(r.sessions.hello(r.wc, { session: nonce(1), home: "local", ...TOP }).ok, false, "an ended nonce cannot come back");
});

test("S1 check: a renderer call is accepted only with the bound session from the trusted top frame", () => {
  const r = rig();
  bind(r, 1);
  assert.ok(r.sessions.check(r.wc, nonce(1), TOP));
  assert.equal(r.sessions.check(r.wc, nonce(2), TOP), null, "another session");
  assert.equal(r.sessions.check(r.wc, nonce(1), { top: false, url: TOP.url }), null, "a sub-frame");
  assert.equal(r.sessions.check(fakeContents(), nonce(1), TOP), null, "another webContents");
  commit(r.wc, `${ORIGIN}/reloaded`);
  assert.equal(r.sessions.check(r.wc, nonce(1), TOP), null, "after the session ended");
});

test("S1 main wires the session tracker next to A14's tracker for every window it tracks", () => {
  const main = readFileSync(path.join(here, "main.mjs"), "utf8");
  const tracked = [...main.matchAll(/appReadiness\.track\(([^)]+)\);/g)].map((m) => m[1]);
  assert.ok(tracked.length >= 1);
  for (const arg of tracked) assert.ok(main.includes(`rendererSessions.track(${arg});`), `rendererSessions.track(${arg}) is wired`);
  assert.match(main, /createRendererSessions\(\{\s*origin: \(\) => trustedRendererOrigin\(\)/);
});

test("S1 production tracking and onEnd wiring orphan and present an admitted card once", async () => {
  const source = readFileSync(path.join(here, "main.mjs"), "utf8");
  const start = source.indexOf("const rendererSessions = createRendererSessions({");
  const end = source.indexOf("\n});", start) + 4;
  const trackStart = source.indexOf("  appReadiness.track(win.webContents);");
  const trackEnd = source.indexOf("  win.webContents.on", trackStart);
  assert.ok(start > 0 && end > start && trackStart > 0 && trackEnd > trackStart);
  for (const event of ["did-navigate", "render-process-gone", "destroyed"]) {
    const notices = []; let ended = 0;
    const main = createAttentionMain({
      prefs: () => ({ origin: "upgrade", surfaces: { notify: true } }),
      presence: { rev: 0, refresh: async () => ({ rev: 0 }), watch: () => () => {} },
      sendToSession: () => true, setTimer: () => ({}), clearTimer() {},
      createNotice() { const notice = Object.assign(new EventEmitter(), { shown: 0, show() { this.shown++; }, close() {} }); notices.push(notice); return notice; },
    });
    const attentionMain = { sessionEnded(...args) { ended++; main.sessionEnded(...args); } };
    const wc = fakeContents(), appReadiness = createAppReadiness({ origin: () => ORIGIN });
    const sessions = runInNewContext(source.slice(start, end) + "\n" + source.slice(trackStart, trackEnd) + "\nrendererSessions;",
      { createRendererSessions, trustedRendererOrigin: () => ORIGIN, attentionMain, appReadiness, win: { webContents: wc } });
    const s = sessions.hello(wc, { session: nonce(1), home: "local", ...TOP }).record;
    assert.ok(s);
    await main.offer(s, { session: s.session, ref: "ref", kind: "approval", botId: "bot", threadId: "thread", requestId: "request", messageId: "message" });
    const rec = [...main.records.values()][0]; assert.equal(rec.state, "SENT");
    wc.emit(event, {}, `${ORIGIN}/next`, 200); wc.emit(event, {}, `${ORIGIN}/next`, 200);
    assert.equal(rec.state, "ORPHAN"); assert.equal(ended, 1); assert.equal(s.alive, false); assert.equal(s.ledger.size, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rec.state, "SHOWN"); assert.equal(notices.length, 1); assert.equal(notices[0].shown, 1);
    main.dispose();
  }
});

test("S2 an uncommitted navigation while a record is SENT never ends the session and never touches A14's defer queue", () => {
  const r = rig();
  let token;
  const readiness = createAppReadiness({ origin: () => ORIGIN, probe: (_c, t) => { token = t; } });
  readiness.track(r.wc);
  commit(r.wc);
  bind(r);
  const ran = [];
  for (let i = 0; i < 32; i += 1) readiness.defer(r.wc, () => ran.push(i));
  // start, ERR_ABORTED, stop, PROBING, ack
  start(r.wc, "https://example.com/dl", { navigationId: 9 });
  assert.equal(readiness.ready(r.wc), false, "A14 is NAVIGATING");
  assert.equal(r.sessions.check(r.wc, nonce(1), TOP) !== null, true, "S3R is unmoved while A14 is not ready");
  r.wc.emit("did-fail-load", { navigationId: 9 }, -3, "", "https://example.com/dl", true);
  r.wc.emit("did-stop-loading");
  assert.deepEqual(ran, [], "nothing ran: S3R never drains A14's queue");
  assert.equal(readiness.alive(r.wc, token, TOP), true, "A14 restores on its own ack");
  assert.equal(readiness.flush(r.wc), 32, "A14's queue still holds exactly its 32 callbacks, none added and none dropped by S3R");
  assert.deepEqual(r.ended, []);
  assert.ok(r.sessions.check(r.wc, nonce(1), TOP));
});
