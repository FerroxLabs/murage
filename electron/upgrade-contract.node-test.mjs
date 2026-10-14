// The status contract between the server's upgrade and the shell's boot probe (S1, S4, S6 of lanes/upgrade-ux/CONVERGED.md):
//   200 + our pid ......................... ready
//   503 + our pid + upgrading:true ......... our own child is upgrading: wait (never a foreign owner, never a port retry)
//   refused ................................ not up yet, or the responder handing the port to the server: poll again
//   anything else that answers ............. foreign
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { pollServerIdentity, launchOf } from "./signed-fetch.test.mjs";
import { statusFromHealth, watchMemoryUpgrade } from "./memory-upgrade-status.mjs";
import { sampleState } from "../shared/upgrade-contract.mjs";
import { computeProof, proofKeyOf } from "../shared/boot-proof.mjs";

/** The state a child in its blocking stage sends (shared/upgrade-contract.mjs). */
const stateOf = (nonce = "n4242", over = {}) => sampleState({ launch: launchOf(nonce), stage: "starting", phase: "migrating", overall: 0.4, complete: false, held: "unknown", capture: "unknown", recall: "unknown", counts: { exact: false }, step: { awakeElapsedMs: 3000, unit: "none" }, eta: { stable: false }, ...over });
const UPGRADING = (nonce = "n4242", extra = {}) => ({ app: "murage", pid: 7, launch: launchOf(nonce), static: false, upgrading: true, upgrade: stateOf(nonce, extra.state ?? {}), ...extra.body });
const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const clock = (start = 1_000_000) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; }, sleep: async (ms) => { t += ms; } }; };

test("S1: our own child's 503 upgrading answer is waited on, then ready", async () => {
  const c = clock();
  const seen = [];
  let calls = 0;
  const fetchImpl = async () => (++calls <= 5 ? { ok: false, status: 503, json: async () => UPGRADING() } : { ok: true, status: 200, json: async () => ({ app: "murage", launch: launchOf("n4242"), static: true }) });
  const outcome = await pollServerIdentity({ port: 8799, nonce: () => "n4242", bootTimeoutMs: 5_000, now: c.now, sleep: c.sleep, fetchImpl, onUpgrading: body => seen.push(body.upgrade.phase) });
  assert.equal(outcome.outcome, "ready");
  assert.equal(calls, 6);
  assert.deepEqual(seen, ["migrating", "migrating", "migrating", "migrating", "migrating"]);
});

test("S1: a 503 that is not our child's upgrading answer is still a foreign owner", async () => {
  for (const [name, fetchImpl, pid] of [
    ["another launch's nonce", answer(503, UPGRADING("n999")), () => "n4242"],
    ["no upgrading flag", answer(503, { app: "murage", launch: launchOf("n4242"), static: false }), () => "n4242"],
    ["another app", answer(503, { ...UPGRADING(), app: "other" }), () => "n4242"],
    ["the child has not spawned yet", answer(503, UPGRADING()), () => undefined],
    ["upgrading flag on a 200 from someone else", answer(200, { app: "murage", launch: launchOf("n7"), static: true, upgrading: true }), () => "n4242"],
  ]) {
    const outcome = await pollServerIdentity({ port: 8799, nonce: pid, bootTimeoutMs: 5_000, fetchImpl });
    assert.equal(outcome.outcome, "foreign-owner", name);
  }
});

test("S1: a responder that gives the port to the server on the same port is not a conflict, over real sockets", async () => {
  const probe = createServer(); await new Promise(r => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const respond = (status, body) => createServer((req, res) => { const challenge = req.headers["x-murage-challenge"]; const raw = JSON.stringify(challenge && body.launch === launchOf("n4242") ? { ...body, proof: computeProof(proofKeyOf("n4242"), challenge, { status, pid: body.pid, launch: body.launch, isStatic: body.static === true, upgrading: body.upgrading === true }) } : body); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(raw) }); res.end(raw); });
  const responder = respond(503, UPGRADING());
  await new Promise(r => responder.listen(port, "127.0.0.1", r));
  // after a moment the responder closes and, a beat later, the server binds the same port
  setTimeout(() => { responder.closeAllConnections?.(); responder.close(() => setTimeout(() => { const server = respond(200, { app: "murage", launch: launchOf("n4242"), static: true }); server.listen(port, "127.0.0.1"); setTimeout(() => server.close(), 3_000).unref(); }, 120)); }, 700);
  const upgrading = [];
  const outcome = await pollServerIdentity({ port, nonce: () => "n4242", bootTimeoutMs: 10_000, onUpgrading: body => upgrading.push(body) });
  assert.equal(outcome.outcome, "ready");
  assert.ok(upgrading.length >= 1, "the responder was seen");
});

test("S1: an upgrade that outlasts the boot budget keeps being waited on while the child answers upgrading", async () => {
  const c = clock();
  let calls = 0;
  const fetchImpl = async () => (++calls < 400 ? { ok: false, status: 503, json: async () => UPGRADING() } : { ok: true, status: 200, json: async () => ({ app: "murage", launch: launchOf("n4242"), static: true }) });
  const outcome = await pollServerIdentity({ port: 8799, nonce: () => "n4242", bootTimeoutMs: 5_000, now: c.now, sleep: c.sleep, fetchImpl });
  assert.equal(outcome.outcome, "ready", "400 polls x 250 ms is far past the 5 s budget");
});

test("S1: a child that stops answering upgrading is not waited on forever", async () => {
  const c = clock();
  let calls = 0;
  const fetchImpl = async () => { if (++calls <= 3) return { ok: false, status: 503, json: async () => UPGRADING() }; throw new Error("ECONNREFUSED"); };
  const outcome = await pollServerIdentity({ port: 8799, nonce: () => "n4242", bootTimeoutMs: 5_000, now: c.now, sleep: c.sleep, fetchImpl });
  assert.equal(outcome.outcome, "timeout");
});

test("S6: a machine that sleeps through the boot budget does not time the start out when it wakes", async () => {
  const c = clock();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 3) c.advance(3 * 3_600_000); // asleep for three hours inside this turn
    if (calls < 6) throw new Error("ECONNREFUSED");
    return { ok: true, status: 200, json: async () => ({ app: "murage", launch: launchOf("n4242"), static: true }) };
  };
  const outcome = await pollServerIdentity({ port: 8799, nonce: () => "n4242", bootTimeoutMs: 5_000, now: c.now, sleep: c.sleep, fetchImpl });
  assert.equal(outcome.outcome, "ready");
});

test("S6: while the shell says the system is suspended the budget does not run down", async () => {
  const c = clock();
  let calls = 0, suspended = true;
  const fetchImpl = async () => { calls++; if (calls >= 40) suspended = false; if (calls < 60) throw new Error("ECONNREFUSED"); return { ok: true, status: 200, json: async () => ({ app: "murage", launch: launchOf("n4242"), static: true }) }; };
  const outcome = await pollServerIdentity({ port: 8799, nonce: () => "n4242", bootTimeoutMs: 5_000, now: c.now, sleep: c.sleep, fetchImpl, isSuspended: () => suspended });
  assert.equal(outcome.outcome, "ready", "40 refused polls at 100 ms would otherwise pass the 5 s budget");
});

test("S6: a quit at any boundary of the upgrade ends the wait at once", async () => {
  for (const boundary of ["before the first answer", "while upgrading", "during the handoff"]) {
    const c = clock();
    let quit = false, calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (boundary === "before the first answer" && calls === 2) quit = true;
      if (boundary === "while upgrading") { if (calls === 3) quit = true; return { ok: false, status: 503, json: async () => UPGRADING() }; }
      if (boundary === "during the handoff") { if (calls === 4) quit = true; if (calls >= 3) throw new Error("ECONNREFUSED"); return { ok: false, status: 503, json: async () => UPGRADING() }; }
      throw new Error("ECONNREFUSED");
    };
    const outcome = await pollServerIdentity({ port: 8799, nonce: () => "n4242", bootTimeoutMs: 60_000, now: c.now, sleep: c.sleep, fetchImpl, isExited: () => quit });
    assert.equal(outcome.outcome, "exited", boundary);
    assert.ok(calls <= 5, boundary);
  }
});

test("S4: when the note cannot be read the shell keeps moving from the server's 503 answer, and tells the screen about every changed field", () => {
  let current = null;
  const updates = [];
  let clockNow = 1_000;
  const watch = watchMemoryUpgrade({ dataDir: "/d", read: () => current, onUpdate: (status, percent) => updates.push([status?.upgrade?.state?.phase, status?.upgrade?.state?.step?.awakeElapsedMs, percent]), setTimer: () => 0, clearTimer: () => {}, now: () => clockNow });
  const health = (over, body) => UPGRADING("n4242", { state: over, body });
  watch.feed(health({ overall: 0.25, step: { awakeElapsedMs: 3000, unit: "none" } }));
  watch.feed(health({ overall: 0.5, step: { awakeElapsedMs: 4000, unit: "none" } }));
  watch.feed(health({ overall: 0.5, step: { awakeElapsedMs: 4000, unit: "none" } }));
  assert.deepEqual(updates, [["migrating", 3000, 25], ["migrating", 4000, 50]]);
  assert.equal(watch.active(), true);
  // a note that can be read wins
  current = { state: "upgrading", startedAt: 1, updatedAt: 2, phase: "migrating", upgrade: { ok: true, state: stateOf() } };
  watch.feed(health({ overall: 0.6 }));
  assert.equal(updates.length, 2);
  // a change in any displayed field (here the estimate) reaches the screen, a heartbeat alone does not
  const note = (over) => ({ state: "upgrading", startedAt: 1, updatedAt: ++clockNow, phase: "migrating", upgrade: { ok: true, state: stateOf("n4242", { heartbeatAt: clockNow, ...over }) } });
  const seen = [];
  const w2 = watchMemoryUpgrade({ dataDir: "/d", read: () => current, progress: () => 25, onUpdate: () => seen.push(1), setTimer: () => 0, clearTimer: () => {}, now: () => clockNow });
  current = note({}); w2.tick(); current = note({}); w2.tick(); assert.equal(seen.length, 1, "a heartbeat alone is not an update");
  current = note({ eta: { stable: true, ms: 60_000 } }); w2.tick(); assert.equal(seen.length, 2, "a new estimate is");
  current = note({ eta: { stable: true, ms: 60_000 }, counts: { exact: true, messages: 11, conversations: 1, memoryRecords: 0, firstMessageAt: null } }); w2.tick(); assert.equal(seen.length, 3, "a new count is");
});

test("statusFromHealth only trusts an upgrading body", () => {
  assert.equal(statusFromHealth({ app: "murage", upgrading: false }), null);
  assert.equal(statusFromHealth(null), null);
  assert.equal(statusFromHealth(UPGRADING()).state, "upgrading");
});

test("F10: a sleep during an in-flight health request does not expire the boot: the valid own-child 200 that arrives after it is ready", async () => {
  const c = clock();
  // the response lands 60 s later by the clock (the machine slept while the request was out); the budget is 5 s
  const fetchImpl = async () => { c.advance(60_000); return { ok: true, status: 200, json: async () => ({ app: "murage", launch: launchOf("n4242"), static: true }) }; };
  const outcome = await pollServerIdentity({ port: 8799, nonce: () => "n4242", bootTimeoutMs: 5_000, now: c.now, sleep: c.sleep, fetchImpl });
  assert.equal(outcome.outcome, "ready");
});

test("F10: a slow answer that is not sleep (under the sleep threshold) still counts against the budget", async () => {
  const c = clock();
  let suspended = false;
  const fetchImpl = async () => { c.advance(20_000); return { ok: false, status: 503, json: async () => ({ app: "murage", nonce: "other", static: false }) }; };
  const outcome = await pollServerIdentity({ port: 8799, nonce: () => "n4242", bootTimeoutMs: 5_000, now: c.now, sleep: c.sleep, fetchImpl, isSuspended: () => suspended });
  assert.equal(outcome.outcome, "timeout");
});

test("F11: a foreign listener that answers with our child's public pid is a foreign owner; the child's launch nonce is what proves identity", async () => {
  const lookalike = answer(503, { app: "murage", pid: 4242, static: false, upgrading: true });
  assert.equal((await pollServerIdentity({ port: 8799, nonce: () => "launch-nonce", bootTimeoutMs: 5_000, fetchImpl: lookalike })).outcome, "foreign-owner");
  const lookalikeReady = answer(200, { app: "murage", pid: 4242, static: true });
  assert.equal((await pollServerIdentity({ port: 8799, nonce: () => "launch-nonce", bootTimeoutMs: 5_000, fetchImpl: lookalikeReady })).outcome, "foreign-owner");
  const ours = answer(200, { app: "murage", pid: 1, launch: launchOf("launch-nonce"), static: true });
  // the raw nonce on the wire is not accepted either: the child answers with its hash only
  assert.equal((await pollServerIdentity({ port: 8799, nonce: () => "launch-nonce", bootTimeoutMs: 5_000, fetchImpl: answer(200, { app: "murage", nonce: "launch-nonce", static: true }) })).outcome, "foreign-owner");
  assert.equal((await pollServerIdentity({ port: 8799, nonce: () => "launch-nonce", bootTimeoutMs: 5_000, fetchImpl: ours, signAs: "launch-nonce" })).outcome, "ready");
});

test("F11: the shell generates a per-launch nonce, hands it to the child only through its environment, and never logs it", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /const bootNonce = Array\.from\(globalThis\.crypto\.getRandomValues\(new Uint8Array\(24\)\)/);
  assert.match(main, /MURAGE_BOOT_NONCE: bootNonce,/);
  assert.match(main, /nonce: \(\) => bootNonce,/);
  assert.ok(!/slog\([^)]*bootNonce/.test(main), "the nonce is never logged");
});

test("R-a: the boot sleep hook is registered outside the boot block, so the block references nothing Electron-only", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = main.indexOf("const desktopStartup = app.whenReady().then(async () => {");
  const end = main.indexOf("  // Boot migrations above", start);
  assert.ok(start > 0 && end > start);
  assert.ok(!main.slice(start, end).includes("powerMonitor"), "the whenReady boot block does not touch powerMonitor");
  assert.match(main, /app\.whenReady\(\)\.then\(\(\) => \{\n  powerMonitor\.on\("suspend"/);
});

test("F12: a note's or a 503 body's upgrade reading goes through the contract's parser, and an older server's has none", async () => {
  const { cleanUpgrade } = await import("./memory-upgrade-status.mjs");
  assert.equal(cleanUpgrade({ upgrade: stateOf() }).ok, true);
  assert.deepEqual(cleanUpgrade({ phaseId: "checking", overall: 0.4 }), { ok: false, reason: "legacy" });
  assert.equal(cleanUpgrade({ upgrade: { ...stateOf(), counts: { messages: 5 } } }).ok, false);
});
