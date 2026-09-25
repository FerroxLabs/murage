/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { closePairing, controlPort, expiryText, openPairing, pairingLink, watchPairing } from "../lib/pair.mjs";

const TOKEN = `murage_pair_${"A".repeat(43)}`;
const DOOR = { scheme: "https", host: "box.tail1234.ts.net", port: 443 };

/** A control page that answers like `companion/src/control.ts`, and records
 * what it was sent. */
async function fakeControl(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, origin: req.headers.origin, host: req.headers.host });
    const [status, body] = handler(req);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the control port follows MURAGE_CONTROL_PORT, and falls back the way the companion does", () => {
  assert.equal(controlPort({}), 8811);
  assert.equal(controlPort({ MURAGE_CONTROL_PORT: "9911" }), 9911);
  for (const bad of ["", "0", "65536", "80.5", "eighty"]) assert.equal(controlPort({ MURAGE_CONTROL_PORT: bad }), 8811, bad);
});

test("the link is the desktop's link: /enter with the token in the fragment", () => {
  assert.equal(pairingLink(DOOR, TOKEN), `https://box.tail1234.ts.net/enter#${TOKEN}`);
  assert.equal(pairingLink({ scheme: "http", host: "box.tail1234.ts.net", port: 8813 }, TOKEN), `http://box.tail1234.ts.net:8813/enter#${TOKEN}`);
  assert.equal(pairingLink({ scheme: "http", host: "fd7a:115c::1", port: 8813 }, TOKEN), `http://[fd7a:115c::1]:8813/enter#${TOKEN}`);
});

test("no link rather than a link to somewhere else", () => {
  assert.equal(pairingLink(null, TOKEN), null);
  assert.equal(pairingLink(DOOR, "murage_pair_short"), null);
  for (const host of ["evil.example@box", "box/other", "box?x", "box#y", " "]) {
    assert.equal(pairingLink({ ...DOOR, host }, TOKEN), null, host);
  }
  assert.equal(pairingLink({ ...DOOR, scheme: "ftp" }, TOKEN), null);
  assert.equal(pairingLink({ ...DOOR, port: 0 }, TOKEN), null);
});

test("opens the window with a loopback POST that carries no Origin", async () => {
  const expiresAt = Date.now() + 600_000;
  const control = await fakeControl(() => [201, { browser: DOOR, devices: [], pairing: { code: "123456", token: TOKEN, expiresAt }, code: "123456", token: TOKEN }]);
  try {
    const opened = await openPairing({ port: control.port });
    assert.deepEqual(opened, { ok: true, token: TOKEN, code: "123456", expiresAt, door: DOOR,
      link: `https://box.tail1234.ts.net/enter#${TOKEN}`, origin: "https://box.tail1234.ts.net" });
    assert.equal(control.seen[0].method, "POST");
    assert.equal(control.seen[0].url, "/pairing");
    // The control page refuses any Origin that is not its own page's; a CLI
    // must send none at all.
    assert.equal(control.seen[0].origin, undefined);
    assert.equal(control.seen[0].host, `127.0.0.1:${control.port}`);
  } finally { await control.close(); }
});

test("passes the companion's own refusal through, word for word", async () => {
  const control = await fakeControl(() => [503, { error: "Phone pairing is paused because devices.json could not be read." }]);
  try {
    const opened = await openPairing({ port: control.port });
    assert.equal(opened.ok, false);
    assert.match(opened.reason, /Phone pairing is paused because devices\.json could not be read\./);
  } finally { await control.close(); }
});

test("says `murage start` when nothing is listening", async () => {
  const control = await fakeControl(() => [201, {}]);
  const port = control.port;
  await control.close();
  const opened = await openPairing({ port });
  assert.equal(opened.ok, false);
  assert.match(opened.reason, /murage start/);
});

test("refuses an answer that is not a pairing window, rather than printing it", async () => {
  for (const body of [
    { token: "murage_pair_short", code: "123456", pairing: { expiresAt: Date.now() + 1 }, browser: DOOR },
    { token: TOKEN, code: "12345", pairing: { expiresAt: Date.now() + 1 }, browser: DOOR },
    { token: TOKEN, code: "123456", pairing: null, browser: DOOR },
  ]) {
    const control = await fakeControl(() => [201, body]);
    try { assert.equal((await openPairing({ port: control.port })).ok, false, JSON.stringify(body)); }
    finally { await control.close(); }
  }
});

test("an open window with no door is not a link", async () => {
  const control = await fakeControl(() => [201, { browser: null, devices: [], code: "123456", token: TOKEN, pairing: { code: "123456", token: TOKEN, expiresAt: Date.now() + 600_000 } }]);
  try {
    const opened = await openPairing({ port: control.port });
    assert.equal(opened.ok, true);
    assert.equal(opened.link, null);
    assert.equal(opened.origin, null);
  } finally { await control.close(); }
});

test("closing names the window it means, so it cannot close a newer one", async () => {
  const control = await fakeControl(() => [200, {}]);
  try {
    assert.equal(await closePairing({ port: control.port, token: TOKEN }), true);
    assert.equal(control.seen[0].method, "DELETE");
    assert.equal(control.seen[0].url, `/pairing?expectedToken=${encodeURIComponent(TOKEN)}`);
  } finally { await control.close(); }
});

test("the countdown reads as minutes and seconds, and ends", () => {
  assert.equal(expiryText(600_000, 0), "Expires in 10:00.");
  assert.equal(expiryText(61_400, 0), "Expires in 1:02.");
  assert.equal(expiryText(1_000, 0), "Expires in 0:01.");
  assert.equal(expiryText(0, 0), "This code has expired.");
  assert.equal(expiryText(0, 5_000), "This code has expired.");
});

/** `watchPairing` against a scripted `/state`, a fake clock and no sleeping. */
function scripted(states, { start = 1_000 } = {}) {
  let clock = start;
  const ticks = [];
  return {
    ticks,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    onTick: (text) => ticks.push(text),
    send: async () => {
      const next = states.length > 1 ? states.shift() : states[0];
      if (next instanceof Error) throw next;
      return { status: 200, body: next };
    },
  };
}

test("reports the device that paired through this window", async () => {
  const s = scripted([
    { pairing: { token: TOKEN }, devices: [{ name: "Old", createdAt: 10 }] },
    { pairing: null, devices: [{ name: "Old", createdAt: 10 }, { name: "Sean's iPhone", createdAt: 3_500 }] },
  ]);
  const result = await watchPairing({ port: 1, token: TOKEN, expiresAt: 601_000, openedAt: 1_000, intervalMs: 2_000, ...s });
  assert.deepEqual(result, { outcome: "paired", device: "Sean's iPhone" });
  assert.equal(s.ticks[0], "Expires in 10:00.");
});

test("expires on the clock even if the companion still shows the window", async () => {
  const s = scripted([{ pairing: { token: TOKEN }, devices: [] }]);
  const result = await watchPairing({ port: 1, token: TOKEN, expiresAt: 7_000, openedAt: 1_000, intervalMs: 2_000, ...s });
  assert.deepEqual(result, { outcome: "expired" });
});

test("tells a replaced window apart from a closed one", async () => {
  const replaced = scripted([{ pairing: { token: `murage_pair_${"B".repeat(43)}` }, devices: [] }]);
  assert.deepEqual(await watchPairing({ port: 1, token: TOKEN, expiresAt: 601_000, openedAt: 1_000, ...replaced }), { outcome: "replaced" });
  const closed = scripted([{ pairing: null, devices: [] }]);
  assert.deepEqual(await watchPairing({ port: 1, token: TOKEN, expiresAt: 601_000, openedAt: 1_000, ...closed }), { outcome: "closed" });
});

test("gives up after three unanswered polls, not one", async () => {
  const s = scripted([new Error("ECONNREFUSED"), new Error("ECONNREFUSED"), { pairing: { token: TOKEN }, devices: [] }, new Error("x")]);
  // One recovered miss does not end the wait; the clock ends it instead.
  const result = await watchPairing({ port: 1, token: TOKEN, expiresAt: 9_000, openedAt: 1_000, intervalMs: 2_000, ...s });
  assert.deepEqual(result, { outcome: "expired" });
  const dead = scripted([new Error("ECONNREFUSED")]);
  assert.deepEqual(await watchPairing({ port: 1, token: TOKEN, expiresAt: 601_000, openedAt: 1_000, ...dead }), { outcome: "unreachable" });
});

test("stops when asked to", async () => {
  const controller = new AbortController();
  controller.abort();
  const s = scripted([{ pairing: { token: TOKEN }, devices: [] }]);
  assert.deepEqual(await watchPairing({ port: 1, token: TOKEN, expiresAt: 601_000, openedAt: 1_000, signal: controller.signal, ...s }), { outcome: "cancelled" });
});
