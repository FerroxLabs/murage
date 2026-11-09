// SPDX-License-Identifier: AGPL-3.0-or-later
// NOTIFY-EVERYWHERE-1019 S3R V1: real Electron main. A real Notification shown for a router ref must survive a renderer reload and a
// forced renderer crash, and settle must still close that same Notification afterwards (I2 in the real app). Real: Electron
// Notification, BrowserWindow, webContents events, createRendererSessions, createAttentionMain. Faked: presence (never quiet), prefs.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, Notification } from "electron";
import { createAttentionMain } from "../attention-main.mjs";
import { createRendererSessions } from "../renderer-session.mjs";

const root = mkdtempSync(join(tmpdir(), "murage-attention-notice-"));
app.setPath("userData", root); app.setPath("sessionData", root);
app.disableHardwareAcceleration();
const step = name => console.log(`step:${name}`);

// The OS `failed` event is reported, never hidden. MURAGE_V1_SUPPRESS_FAILED=1 stops the headless box's missing-daemon `failed` from
// reaching the router's listener; the test says so in its output.
const failedSeen = [];
const suppress = process.env.MURAGE_V1_SUPPRESS_FAILED === "1";
const realOn = Notification.prototype.on;
Notification.prototype.on = function (event, listener) {
  if (event === "failed" && suppress) return this;
  return realOn.call(this, event, listener);
};

const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>v1</title><p>v1</p>"); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  const contents = win.webContents;
  const loaded = () => new Promise(resolve => contents.once("did-finish-load", resolve));
  let first = loaded(); contents.loadURL(`${origin}/`); await first;

  const ended = [];
  const sessions = createRendererSessions({ origin: () => origin, onEnd: (id, session, record) => { ended.push(session); main.sessionEnded(id, session, record); } });
  sessions.track(contents);

  const notices = [];
  const quiet = { locked: false, sharing: false, fullscreen: false, focus: false };
  const presence = { rev: 0, quiet: () => quiet, watch: () => () => {}, markConservative() {}, async refresh() { return { ...quiet, rev: 0 }; } };
  const prefs = { origin: "new", surfaces: { notify: true, receipt: true, pill: false, bubble: false }, hideFullscreen: false, respectFocus: false, quietSummary: false, nudgeMinutes: 0 };
  const messages = [];
  const main = createAttentionMain({
    prefs: () => prefs, presence, pillAvailable: () => false,
    transportFor: () => ({ readCard: async () => ({ open: true }) }),
    readPreviews: async () => true,
    sendToSession(home, session, message) { messages.push(message); return true; },
    createNotice(options) {
      const notice = new Notification(options); // the REAL Electron Notification
      const spy = { shown: 0, closed: 0, notice };
      const show = notice.show.bind(notice), close = notice.close.bind(notice);
      notice.show = () => { spy.shown++; return show(); };
      notice.close = () => { spy.closed++; return close(); };
      realOn.call(notice, "failed", () => failedSeen.push(spy));
      notices.push(spy); return notice;
    },
  });

  const nonce = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const hello = sessions.hello(contents, { session: nonce, home: "local", top: true, url: contents.getURL() });
  assert.equal(hello.ok, true, "hello binds a session");
  const owner = hello.record;
  assert.equal(main.hello(owner).ok, true);
  step("session-bound");

  const offered = await main.offer(owner, { kind: "approval", ref: "ref1", requestId: "q1", threadId: "t1", messageId: "m1", botId: "b1", session: nonce });
  assert.equal(offered.ok, true, JSON.stringify(offered));
  const shown = messages.findLast(m => m.type === "show" && m.ref === "ref1");
  assert.ok(shown, `main asked the renderer to show: decision=${offered.decision}`);
  const presented = await main.present(owner, { title: "Ada", body: "Please review", privatePreview: false, silent: false, session: nonce, ref: "ref1", gen: shown.gen });
  assert.equal(presented.ok, true, JSON.stringify(presented));
  const record = [...main.records.values()][0];
  assert.equal(record?.state, "SHOWN"); assert.match(record.handle, /^m:/);
  assert.equal(notices.length, 1); const spy = notices[0];
  assert.equal(spy.shown, 1); assert.ok(spy.notice instanceof Notification);
  step(`notice-shown-real-notification failedSeen=${failedSeen.length} suppress=${suppress}`);
  await new Promise(resolve => setTimeout(resolve, 500)); // give a missing notification daemon time to emit `failed`
  console.log(`info:failed-events-after-show=${failedSeen.length} state=${record.state} records=${main.records.size}`);

  const stillShown = label => {
    assert.equal(main.records.size, 1, `${label}: record kept`);
    assert.equal([...main.records.values()][0], record, `${label}: same record`);
    assert.equal(record.state, "SHOWN", `${label}: still SHOWN`);
    assert.equal(record.notice, spy.notice, `${label}: same real Notification object`);
    assert.equal(spy.closed, 0, `${label}: close() not called`);
  };
  stillShown("before reload");

  // (1) reload: a new document, so the session ends.
  const reloaded = loaded(); contents.reload(); await reloaded;
  assert.equal(owner.alive, false, "reload ended the session"); assert.deepEqual(ended, [nonce]);
  stillShown("after reload"); step("survives-reload");

  // (2) crash the renderer.
  const gone = new Promise(resolve => contents.once("render-process-gone", (_e, details) => resolve(details)));
  contents.forcefullyCrashRenderer(); const details = await gone;
  console.log(`info:render-process-gone reason=${details.reason}`);
  assert.deepEqual(ended, [nonce], "the session ended exactly once");
  stillShown("after crash"); step("survives-crash");

  // (3) settle from another surface.
  assert.equal(main.settled("local", "t1", "q1"), true);
  assert.equal(spy.closed, 1, "close() called exactly once on the same Notification");
  assert.equal(main.records.size, 0, "record gone"); assert.equal(record.retired, true);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(spy.closed, 1, "still exactly once"); step("settle-closes-same-notice-once");
  console.log("attention-notice-passed");
  main.dispose(); server.close(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
