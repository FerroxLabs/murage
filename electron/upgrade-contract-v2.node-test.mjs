// The status contract every producer sends and every screen reads (shared/upgrade-contract.mjs), and the proof the shell asks of the child (shared/boot-proof.mjs).
import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { createHmac } from "node:crypto";
import {
  AWAKE_GAP_CAP_MS, COUNTED_UNITS, CONTRACT_KEYS, UPGRADE_CONTRACT_SOURCE, buildUpgradeState, contractFixtures, createAwakeMeter, parseUpgradeState, restampUpgradeState, sampleState, unknownUpgradeState,
} from "../shared/upgrade-contract.mjs";
import { CHALLENGE_PATTERN, PROOF_DATA_SOURCE, computeProof, newChallenge, proofHolds, proofKeyOf } from "../shared/boot-proof.mjs";
import { pollServerIdentity, launchOf } from "./server-boot-probe.mjs";

test("every fixture is accepted or refused exactly as the table says, and a refusal names a reason", () => {
  const fixtures = contractFixtures();
  assert.ok(fixtures.length > 60);
  for (const f of fixtures) {
    const parsed = parseUpgradeState(f.raw);
    assert.equal(parsed.ok, f.valid, f.name);
    if (!parsed.ok) assert.equal(typeof parsed.reason, "string", f.name);
    if (f.legacy) assert.equal(parsed.reason, "legacy", f.name);
    if (parsed.ok) assert.deepEqual(Object.keys(parsed.state), [...CONTRACT_KEYS], f.name);
  }
});

test("every field is required: a producer that leaves one out throws, never defaults", () => {
  for (const key of CONTRACT_KEYS) {
    const raw = { ...sampleState() }; delete raw[key];
    assert.throws(() => buildUpgradeState(raw), /not valid/, key);
  }
});

test("a counted step needs a unit the phase may count, figures, and a total that is never below what was done", () => {
  assert.deepEqual(COUNTED_UNITS, { copying: "bytes", lineage: "conversations", "message-index": "messages", storage: "sets" });
  assert.throws(() => sampleState({ phase: "shapes" }), /step-unit/);
  assert.throws(() => sampleState({ step: { awakeElapsedMs: 1, unit: "messages" } }), /step-figures/);
  const raised = sampleState({ step: { awakeElapsedMs: 1, unit: "messages", done: 1300, total: 1200 } });
  assert.equal(raised.step.total, 1300);
  assert.equal("done" in sampleState({ phase: "shapes", step: { awakeElapsedMs: 1, unit: "none" } }).step, false);
});

test("a hold cannot be capturing or complete, and its key is never prose", () => {
  assert.throws(() => sampleState({ held: true, holdKey: "memoryStrip.hold" }), /held-but-capturing/);
  assert.throws(() => sampleState({ held: true, holdKey: "memoryStrip.hold", capture: "off", recall: "off", complete: true }), /held-but-complete/);
  assert.throws(() => sampleState({ held: true, holdKey: "Earlier memory is set aside.", capture: "off", recall: "off" }), /holdKey/);
  assert.throws(() => sampleState({ held: false, holdKey: "memoryStrip.hold" }), /holdKey-vs-held/);
});

test("UPGRADE_CONTRACT_SOURCE (for eval'd workers) gives the same answers as the module", () => {
  const sandbox = {}; vm.createContext(sandbox);
  const kit = vm.runInContext(`${UPGRADE_CONTRACT_SOURCE}; ({ buildUpgradeState, parseUpgradeState, restampUpgradeState, unknownUpgradeState, createAwakeMeter })`, sandbox);
  for (const f of contractFixtures()) {
    const here = parseUpgradeState(f.raw), there = kit.parseUpgradeState(f.raw);
    assert.deepEqual(JSON.parse(JSON.stringify(there)), JSON.parse(JSON.stringify(here)), f.name);
  }
  const state = sampleState();
  assert.deepEqual(JSON.parse(JSON.stringify(kit.restampUpgradeState(state, { source: "responder", heartbeatAt: 5 }))), restampUpgradeState(state, { source: "responder", heartbeatAt: 5 }));
  assert.deepEqual(JSON.parse(JSON.stringify(kit.unknownUpgradeState({ launch: "c".repeat(64) }))), unknownUpgradeState({ launch: "c".repeat(64) }));
  assert.throws(() => kit.buildUpgradeState({}), /not valid/);
});

test("awake time: ten seconds of work and ten minutes asleep add about ten seconds", () => {
  let now = 0;
  const meter = createAwakeMeter(AWAKE_GAP_CAP_MS, () => now);
  for (let i = 0; i < 5; i++) { now += 2000; meter.tick(); }
  now += 600_000; meter.tick();
  now += 2000; meter.tick();
  assert.ok(meter.total() >= 10_000 && meter.total() <= 16_000, String(meter.total()));
});

test("old server: a body with no contract version is 'legacy' and the screens show activity only", () => {
  assert.deepEqual(parseUpgradeState({ phaseId: "migrating", overall: 0.4 }), { ok: false, reason: "legacy" });
});

// ---------------------------------------------------------------- ownership proof (R2-05)
const NONCE = "n-4242", OTHER = "n-9999";
const fields = (over = {}) => ({ status: 200, pid: 7, launch: launchOf(NONCE), isStatic: true, upgrading: false, ...over });
/** A child that answers the way the server does: proof over the probe's challenge and its own status fields. */
const child = (nonce, { pid = 7, status = 200, upgrading = false, isStatic = true } = {}) => async (_url, options) => {
  const challenge = options?.headers?.["x-murage-challenge"];
  const base = { app: "murage", pid, launch: launchOf(nonce), static: isStatic, ...(upgrading ? { upgrading: true } : {}) };
  const proof = typeof challenge === "string" && CHALLENGE_PATTERN.test(challenge) ? computeProof(proofKeyOf(nonce), challenge, { status, pid, launch: base.launch, isStatic, upgrading }) : undefined;
  return { ok: status < 300, status, json: async () => ({ ...base, ...(proof ? { proof } : {}) }) };
};
const probe = (fetchImpl) => pollServerIdentity({ port: 8799, nonce: () => NONCE, bootTimeoutMs: 1000, fetchImpl, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 50); })() });

test("R2-05: the real child (proof from the nonce) is ready", async () => { assert.equal((await probe(child(NONCE))).outcome, "ready"); });

test("R2-05: a foreign listener that copied the public launch hash and a pid is not ready", async () => {
  const copied = async () => ({ ok: true, status: 200, json: async () => ({ app: "murage", pid: 99, launch: launchOf(NONCE), static: true }) });
  assert.equal((await probe(copied)).outcome, "foreign-owner");
  const wrongKey = child(OTHER);
  const forged = async (url, options) => { const r = await wrongKey(url, options); const body = await r.json(); return { ok: true, status: 200, json: async () => ({ ...body, launch: launchOf(NONCE) }) }; };
  assert.equal((await probe(forged)).outcome, "foreign-owner");
});

test("R2-05: a replayed old answer is rejected, because its proof covers another challenge", async () => {
  const first = await child(NONCE)("x", { headers: { "x-murage-challenge": newChallenge() } });
  const recorded = await first.json();
  const replay = async () => ({ ok: true, status: 200, json: async () => recorded });
  assert.equal((await probe(replay)).outcome, "foreign-owner");
});

test("R2-05: the proof binds the status fields: a 503 proof cannot stand for a 200 'ready'", () => {
  const challenge = newChallenge(), key = proofKeyOf(NONCE);
  const upgrading = { app: "murage", pid: 7, launch: launchOf(NONCE), static: false, upgrading: true, proof: computeProof(key, challenge, fields({ status: 503, isStatic: false, upgrading: true })) };
  assert.equal(proofHolds(NONCE, challenge, upgrading, 503), true);
  assert.equal(proofHolds(NONCE, challenge, upgrading, 200), false);
  assert.equal(proofHolds(NONCE, challenge, { ...upgrading, static: true }, 503), false);
  assert.equal(proofHolds(NONCE, challenge, { ...upgrading, pid: 8 }, 503), false);
  assert.equal(proofHolds(NONCE, newChallenge(), upgrading, 503), false);
  assert.equal(proofHolds(NONCE, challenge, { ...upgrading, proof: undefined }, 503), false);
});

test("R2-05: the launch hash is a label only: the proof key is not derivable from it", () => {
  assert.notEqual(proofKeyOf(NONCE), launchOf(NONCE));
});

test("R2-05: the worker-thread source computes the same proof as the module", () => {
  const sandbox = {}; vm.createContext(sandbox);
  const proofData = vm.runInContext(`${PROOF_DATA_SOURCE}; proofData`, sandbox);
  const challenge = newChallenge(), f = fields({ status: 503, upgrading: true, isStatic: false });
  const there = createHmac("sha256", proofKeyOf(NONCE)).update(proofData(challenge, f)).digest("hex");
  assert.equal(there, computeProof(proofKeyOf(NONCE), challenge, f));
});
