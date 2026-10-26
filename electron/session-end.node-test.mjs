// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionEndHandler, FLUSH_REQUEST_TYPE, NOTICE_SETTLE_MS } from "./session-end.mjs";

/** A harness that answers: it writes its answer file when asked (as server/index.ts flushRequested does, from its own process). */
const answering = () => ({ sent: [], post(message) { this.sent.push(message); if (message.ack) fs.writeFileSync(message.ack, "1", { flag: "wx" }); return true; } });
const silent = () => ({ sent: [], post(message) { this.sent.push(message); return true; } });

function fixture(children, waitMs = 1_500, { now } = {}) {
  const ackDir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-session-end-"));
  const calls = [], lines = [];
  let clock = 0;
  const handler = createSessionEndHandler({
    children: () => children, ackDir, waitMs,
    beginQuit: () => calls.push("beginQuit"), quit: () => calls.push("quit"), log: line => lines.push(line),
    // default: a clock that moves 200 ms per read, so the bounded wait ends after a read or two; `now` "real" uses performance.now
    ...(now === "real" ? {} : { now: now ?? (() => (clock += 200)) }),
  });
  return { handler, calls, lines, ackDir, done: () => fs.rmSync(ackDir, { recursive: true, force: true }) };
}

test("a session that may end (Windows query-session-end): the harness writes its saves before the callback returns; Murage keeps running", () => {
  const child = answering();
  const f = fixture([child]);
  f.handler.query();
  assert.equal(child.sent.length, 1);
  assert.equal(child.sent[0].type, FLUSH_REQUEST_TYPE);
  assert.equal(path.dirname(child.sent[0].ack), f.ackDir);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(fs.readdirSync(f.ackDir), [], "answer files are removed");
  assert.match(f.lines[0], /1 of 1 harness process\(es\) wrote their deferred saves$/);
  f.done();
});

test("a session that is ending (Windows session-end) or a system shutdown: flush first, then quit once", () => {
  for (const event of ["end", "shutdown"]) {
    const child = answering();
    const f = fixture([child]);
    f.handler[event]();
    f.handler[event]();
    assert.equal(child.sent.length, 2, event);
    assert.deepEqual(f.calls, ["beginQuit", "quit", "beginQuit"], event);
    f.done();
  }
});

test("a harness that does not answer holds the callback for the bound only; an exited one is skipped", () => {
  const f = fixture([silent(), { post() { return false; } }, { post() { throw new Error("port closed"); } }], 300);
  const started = Date.now();
  f.handler.end();
  const took = Date.now() - started;
  assert.ok(took < 5_000, `held ${took} ms`);
  assert.deepEqual(f.calls, ["beginQuit", "quit"]);
  assert.match(f.lines[0], /0 of 1 harness process\(es\).*1 did not answer within 300 ms/);
  f.done();
  const none = fixture([]);
  none.handler.shutdown();
  assert.deepEqual(none.calls, ["beginQuit", "quit"]);
  none.done();
});

test("main wires every window's session events, the system shutdown and every owned harness to the handler", () => {
  const main = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /app\.on\("browser-window-created", \(_event, win\) => \{\n  win\.on\("query-session-end", \(\) => sessionEnd\.query\(\)\);\n  win\.on\("session-end", \(\) => sessionEnd\.end\(\)\);/);
  assert.match(main, /powerMonitor\.on\("shutdown",\(\)=>sessionEnd\.shutdown\(\)\);/);
  assert.match(main, /children: \(\) => \[\.\.\.ownedServerChildren\]\.filter\(\(child\) => !child\.exited\)/);
  assert.doesNotMatch(main, /win\.on\("query-session-end",\(\)=>backgroundLifecycle/);
});

test("a query and the end that follows at once each flush: a change made between them is never skipped", () => {
  const child = answering();
  const f = fixture([child]);
  f.handler.query();
  f.handler.end();
  assert.equal(child.sent.length, 2);
  assert.deepEqual(f.calls, ["beginQuit", "quit"]);
  f.done();
});

test("a harness that answers that it could not write is reported, not counted as saved", () => {
  const child = { sent: [], post(message) { this.sent.push(message); fs.writeFileSync(message.ack, "0", { flag: "wx" }); return true; } };
  const f = fixture([child]);
  f.handler.end();
  assert.match(f.lines[0], /0 of 1 harness process\(es\) wrote their deferred saves \(1 could not write\)$/);
  f.done();
});

test("one session-end reaching four windows at once (Electron 43.5: one WM_ENDSESSION handler) holds the OS 1.5 s in total, not 1.5 s per window", () => {
  const children = [silent(), silent()];
  const f = fixture(children, 1_500, { now: "real" });
  const started = performance.now();
  for (let window = 0; window < 4; window++) f.handler.end();
  const took = performance.now() - started;
  assert.ok(took >= 1_400 && took <= 1_750, `four windows held the callback ${Math.round(took)} ms`);
  for (const child of children) {
    // every window still asked every harness: nothing merged or skipped; only the first could still wait
    assert.equal(child.sent.length, 4);
    assert.ok(child.sent[0].ack);
    assert.ok(child.sent.slice(1).every(message => message.type === FLUSH_REQUEST_TYPE && message.ack === undefined));
  }
  assert.deepEqual(f.calls, ["beginQuit", "quit", "beginQuit", "beginQuit", "beginQuit"]);
  assert.match(f.lines[3], /0 of 2 .* \(2 asked after this notice's 1500 ms, not waited for\)$/);
  f.done();
});

test("a query delivered to four windows one after another also shares one deadline", () => {
  const child = silent();
  const f = fixture([child], 300, { now: "real" });
  const started = performance.now();
  for (let window = 0; window < 4; window++) f.handler.query();
  const took = performance.now() - started;
  assert.ok(took >= 250 && took <= 550, `four windows held the query ${Math.round(took)} ms`);
  assert.equal(child.sent.length, 4);
  f.done();
});

test("every window of one notice asks afresh while the deadline holds: a new nonce each time, every answer counted", () => {
  const child = answering();
  let t = 0;
  const f = fixture([child], 1_500, { now: () => t });
  for (let window = 0; window < 3; window++) { f.handler.end(); t += 10; }
  assert.equal(new Set(child.sent.map(message => message.ack)).size, 3);
  assert.ok(f.lines.every(line => /1 of 1 harness process\(es\) wrote their deferred saves$/.test(line)), f.lines.join("\n"));
  f.done();
});

test("the end after a query is a new notice with its own full wait", () => {
  const child = silent();
  const f = fixture([child], 300, { now: "real" });
  f.handler.query();
  const started = performance.now();
  f.handler.end();
  const took = performance.now() - started;
  assert.ok(took >= 250, `the end waited ${Math.round(took)} ms`);
  assert.ok(child.sent[1].ack, "the end names its own answer file");
  assert.notEqual(child.sent[0].ack, child.sent[1].ack);
  f.done();
});

test("the same kind again after the notice settled is a new notice: it names an answer file and waits again", () => {
  const child = silent();
  let t = 0;
  // the clock moves 100 ms per read, so each wait ends; then jump past the settle window
  const f = fixture([child], 300, { now: () => (t += 100) });
  f.handler.query();
  t += NOTICE_SETTLE_MS + 1_000;
  f.handler.query();
  assert.ok(child.sent[0].ack && child.sent[1].ack);
  f.done();
});

test("an answer file that exists but cannot be read is not counted as saved", () => {
  const child = { sent: [], post(message) { this.sent.push(message); fs.mkdirSync(message.ack); return true; } };
  const f = fixture([child]);
  f.handler.end();
  assert.match(f.lines[0], /0 of 1 harness process\(es\) wrote their deferred saves \(1 answer\(s\) could not be read\)$/);
  f.done();
});

test("main hears the session end before any window: powerMonitor and a hidden Windows stand-in at app ready, gone with the first window", () => {
  const main = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /app\.whenReady\(\)\.then\(\(\) => \{\n  powerMonitor\.on\("shutdown",\(\)=>sessionEnd\.shutdown\(\)\);\n  listenForSessionEndWithoutWindows\(\);/);
  assert.match(main, /if \(process\.platform !== "win32" \|\| sessionStandIn \|\| BrowserWindow\.getAllWindows\(\)\.length\) return;\n  sessionStandIn = new BaseWindow\(\{ show: false,/);
  assert.match(main, /sessionStandIn\.on\("query-session-end", \(\) => sessionEnd\.query\(\)\);\n  sessionStandIn\.on\("session-end", \(\) => sessionEnd\.end\(\)\);/);
  assert.match(main, /const standIn = sessionStandIn;\n  sessionStandIn = null;\n  if \(standIn\) setImmediate\(\(\) => \{ if \(!standIn\.isDestroyed\(\)\) standIn\.destroy\(\); \}\);/);
  assert.equal(main.match(/powerMonitor\.on\("shutdown"/g)?.length, 1);
});
