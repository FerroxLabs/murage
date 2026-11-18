// SPDX-License-Identifier: AGPL-3.0-or-later
// Work gate producer and fixture consumer owner: new3-g5.
import { mkdirSync } from "node:fs";
import { StatementSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { updateMessage } from "../message-db.ts";
import type { Message } from "../store.ts";
import { SEND_ATTEMPT_SCHEMA_SQL, SendAttemptStore } from "../send-attempt-state.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { captureSendReplayProof, confirmFreshReplaySession, lastReplaySessionConservativeForTest, sendReplaySessionCurrent, replaySessionStateForTest, currentSendReplaySessionProof } from "./replay-lineage.ts";
import { replayWalkWorkForTest, setReplayShadowForTest, walkOf } from "./replay-walk.ts";
import { FreshReplaySessionConfirmation, withCurrentReplaySessionChange } from "./fresh-replay-session.ts";
import { updateReceiptReplayProof } from "./receipt-replay-proof.ts";
import { takeReplayShadowDivergencesForTest } from "./replay-shadow.ts";
import { proofJson } from "./testing/replay-session-corpus.ts";

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  database().exec(SEND_ATTEMPT_SCHEMA_SQL); setReplayShadowForTest(false);
});
afterEach(() => { setReplayShadowForTest(false); closeDatabase(); });
function row(id: string, thread = "conversation", copyOf?: { threadId: string; messageIds: string[] }, kind = "text") {
  const message = { id, at: 1, role: "user", kind, text: "Fixture", ...(copyOf ? { copyOf } : {}) };
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,1,'user',?,'Fixture',?)").run(thread, id, kind, JSON.stringify(message));
  return message as Message;
}
const current = (session = "session") => sendReplaySessionCurrent("conversation", "engine", session);
function retain(ids: string[], session = "session") {
  const proof = captureSendReplayProof("conversation", ids);
  confirmFreshReplaySession("conversation", "engine", session, proof); return proof;
}
function seed(n: number, copies = false) {
  const ids: string[] = [];
  const db = database(); db.exec("BEGIN");
  for (let i = 0; i < n; i++) {
    const id = `h${String(i).padStart(6, "0")}`; ids.push(id);
    if (copies && i % 10 === 0) { row(id, "source"); row(id, "conversation", { threadId: "source", messageIds: [id] }); }
    else row(id);
  }
  db.exec("COMMIT"); retain(ids); return ids;
}
function cycle(id: string, thread = "conversation", insert = true) {
  const db = database(), store = new SendAttemptStore(db); if (insert) row(id, thread);
  const a = store.create({ ownerId: "owner", botId: "fixture", threadId: thread, sendId: id, fingerprint: "fixture" });
  store.link(a.attemptId, id);
  let key = store.bind([a.attemptId], { generation: id, providerInstanceId: "engine" })[0]!;
  store.releaseWrite(key, store.byId(a.attemptId)!.revision, 1);
  key = store.allocateProvider(key, store.byId(a.attemptId)!.revision, id);
  store.acknowledge(key, store.byId(a.attemptId)!.revision);
}
// Install before opening the connection: io-budget binds native methods when
// preparing a statement. Per-window prototype patches miss those bound reads.
let counting = false, executions = 0;
const statementPrototype = StatementSync.prototype as any;
const nativeMethods = new Map<string, any>();
for (const name of ["get", "all", "run", "iterate"]) {
  const original = statementPrototype[name]; nativeMethods.set(name, original);
  statementPrototype[name] = function (...args: unknown[]) { if (counting) executions++; return original.apply(this, args); };
}
afterAll(() => { for (const [name, method] of nativeMethods) statementPrototype[name] = method; });
function measure<T>(work: () => T) {
  executions = 0; const before = replayWalkWorkForTest(); counting = true;
  try {
    const value = work(), after = replayWalkWorkForTest();
    return { value, statements: executions, work: Object.fromEntries(Object.entries(after).map(([key, count]) => [key, count - before[key as keyof typeof before]])) };
  } finally { counting = false; }
}
function reset() { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database().exec(SEND_ATTEMPT_SCHEMA_SQL); }

it.each([false, true])("T1/T1b equal every SQL execution and walk work at 50 and 5000 (copies=%s)", copies => {
  const results = [50, 5000].map(n => {
    reset(); seed(n, copies);
    const result = measure(() => { cycle("next"); return current(); });
    expect(result.value).toBe(true); expect(result.work.fallbacks).toBe(0);
    expect(replaySessionStateForTest("conversation", "engine", "session")!.candidates).toContain("next");
    database().exec("INSERT INTO send_replay_exclusions VALUES('conversation','next',NULL,'uncertain',1); UPDATE send_replay_epochs SET revision=revision+1 WHERE thread_id='conversation'");
    expect(current()).toBe(false);
    return result;
  });
  console.log("REPLAY_EQUAL_WORK", JSON.stringify({ copies, results }));
  expect(results[1]).toEqual(results[0]);
});
it("T1c cycle 20 costs exactly cycle 1 at 5000 retained inputs", () => {
  seed(5000);
  const results = Array.from({ length: 20 }, (_, i) => measure(() => { cycle(`next${String(i).padStart(2, "0")}`); return current(); }));
  for (const result of results) { expect(result.value).toBe(true); expect(result.work.fallbacks).toBe(0); expect(result).toEqual(results[0]); }
  console.log("REPLAY_20_CYCLES", JSON.stringify([results[0], results[19]]));
});
it("T2 unread receipts credit; touched ancestors conservatively drop with R1", () => {
  setReplayShadowForTest(true);
  row("original", "source"); row("copy", "conversation", { threadId: "source", messageIds: ["original"] }); retain(["copy"]);
  cycle("unvisited"); expect(current()).toBe(true);
  cycle("original", "source", false); expect(current()).toBe(false);
  expect(lastReplaySessionConservativeForTest()).toBe("R1");
});
it("M3 acknowledged copy of an excluded original stays excluded and invalid", () => {
  setReplayShadowForTest(true); row("history"); retain(["history"]);
  row("excluded", "source"); database().exec("INSERT INTO send_replay_exclusions VALUES('source','excluded',NULL,'uncertain',1)");
  row("next", "conversation", { threadId: "source", messageIds: ["excluded"] });
  cycle("next", "conversation", false);
  expect(current()).toBe(false);
  expect(captureSendReplayProof("conversation", ["next"]).excludedIds.has("next")).toBe(true);
});
it("M8 refuses a second unwitnessed epoch increase inside the receipt transaction", () => {
  setReplayShadowForTest(true); row("history"); retain(["history"]);
  const store = new SendAttemptStore(database());
  store.transaction(() => {
    row("next");
    const a = store.create({ ownerId: "owner", botId: "fixture", threadId: "conversation", sendId: "next", fingerprint: "fixture" });
    store.link(a.attemptId, "next");
    const key = store.bind([a.attemptId], { generation: "next", providerInstanceId: "engine" })[0]!;
    // Inject the other writer's bump between the observer's witness and the
    // eligibility epoch write, using the actual SQL writer as the seam.
    const proto = StatementSync.prototype as any, run = proto.run;
    proto.run = function (...args: unknown[]) {
      const result = run.apply(this, args);
      if (String(this.sourceSQL).startsWith("INSERT INTO send_replay_exclusions") && args[3] === "uncertain") database().exec("UPDATE send_replay_epochs SET revision=revision+1 WHERE thread_id='conversation'");
      return result;
    };
    try { store.releaseWrite(key, store.byId(a.attemptId)!.revision, 1); } finally { proto.run = run; }
    const allocated = store.allocateProvider(key, store.byId(a.attemptId)!.revision, "next");
    store.acknowledge(allocated, store.byId(a.attemptId)!.revision);
  });
  expect(current()).toBe(false);
});
it("T3 probes a missing original even when its plain INSERT bumps no epoch", () => {
  setReplayShadowForTest(true);
  row("copy", "conversation", { threadId: "source", messageIds: ["missing"] });
  const proof = retain(["copy"]); expect(proof.excludedIds.has("copy")).toBe(true); expect(current()).toBe(true);
  row("missing", "source");
  expect(walkOf(proof)!.witnessCurrent(database())).toBe("changed");
  expect(current()).toBe(false);
});
it.each(["image", "activity"])("T4 updateMessage bumps for non-text %s copy removal and prior invalid JSON", kind => {
  setReplayShadowForTest(true); row("original", "source");
  const image = row("copy", "conversation", { threadId: "source", messageIds: ["original"] }, kind);
  const proof = retain(["copy"]); const before = new Map(proof.epochs).get("conversation")!;
  delete image.copyOf; updateMessage("conversation", image);
  expect(Number(database().prepare("SELECT revision FROM send_replay_epochs WHERE thread_id='conversation'").get()!.revision)).toBe(before + 1);
  expect(current()).toBe(false);
  database().exec("UPDATE messages SET json='invalid' WHERE id='copy'");
  const invalid = retain(["copy"]); updateMessage("conversation", image);
  expect(Number(database().prepare("SELECT revision FROM send_replay_epochs WHERE thread_id='conversation'").get()!.revision)).toBe(new Map(invalid.epochs).get("conversation")! + 1);
  expect(current()).toBe(false);
});
it("T5 rolls back acknowledgement, memo, touched nodes, candidates, epochs and pending together", () => {
  setReplayShadowForTest(true); row("history"); retain(["history"]);
  const before = replaySessionStateForTest("conversation", "engine", "session");
  const store = new SendAttemptStore(database());
  expect(() => store.transaction(() => { cycle("next"); expect(current()).toBe(true); throw new Error("fixture rollback"); })).toThrow("fixture rollback");
  expect(replaySessionStateForTest("conversation", "engine", "session")).toEqual(before);
  expect(current()).toBe(true);
  cycle("next"); const rolled = replaySessionStateForTest("conversation", "engine", "session");
  reset(); row("history"); retain(["history"]); cycle("next");
  expect(replaySessionStateForTest("conversation", "engine", "session")).toEqual(rolled);
});
it("T8 impure shared 200-node chain and over-budget roots take exact full fallback", () => {
  setReplayShadowForTest(true);
  for (let i = 0; i < 200; i++) row(`chain${i}`, "source", i < 199 ? { threadId: "source", messageIds: [`chain${i + 1}`] } : undefined);
  row("first", "conversation", { threadId: "source", messageIds: ["chain0"] });
  row("second");
  const roots = new Map([["second", Array.from({ length: 256 }, (_, i) => ({ threadId: "source", messageId: `chain${i % 200}` }))]]);
  const state = { proof: captureSendReplayProof("conversation", ["first", "second"], roots) };
  expect(walkOf(state.proof)!.impure.has("second")).toBe(true);
  const store = new SendAttemptStore(database()), prior = replayWalkWorkForTest();
  store.transaction(() => updateReceiptReplayProof(database(), state, ["second"], () => {
    database().exec("INSERT INTO send_replay_exclusions VALUES('conversation','second',NULL,'uncertain',1); INSERT INTO send_replay_epochs VALUES('conversation',1)");
  }));
  expect(replayWalkWorkForTest().fallbacks - prior.fallbacks).toBe(1);
  expect(proofJson(state.proof)).toEqual(proofJson(captureSendReplayProof("conversation", ["first", "second"], roots)));
});
it("T9 turn receipt proof costs the same SQL at 50 and 5000 with no fallback", () => {
  const results = [50, 5000].map(n => {
    reset(); const ids = seed(n); row("current");
    const store = new SendAttemptStore(database()), a = store.create({ ownerId: "owner", botId: "fixture", threadId: "conversation", sendId: "current", fingerprint: "fixture" });
    store.link(a.attemptId, "current");
    let key = store.bind([a.attemptId], { generation: "current", providerInstanceId: "engine" })[0]!;
    const state = { proof: captureSendReplayProof("conversation", [...ids, "current"]) };
    const measured = measure(() => store.transaction(() => {
      updateReceiptReplayProof(database(), state, ["current"], () => store.releaseWrite(key, store.byId(a.attemptId)!.revision, 1));
      updateReceiptReplayProof(database(), state, ["current"], () => {
        key = store.allocateProvider(key, store.byId(a.attemptId)!.revision, "current"); store.acknowledge(key, store.byId(a.attemptId)!.revision);
      });
    }));
    expect(measured.work.fallbacks).toBe(0);
    setReplayShadowForTest(true);
    expect(proofJson(state.proof)).toEqual(proofJson(captureSendReplayProof("conversation", [...ids, "current"])));
    setReplayShadowForTest(false); return measured;
  });
  console.log("REPLAY_TURN_WORK", JSON.stringify(results)); expect(results[1]).toEqual(results[0]);
});
it("R2 caps threads and missing witnesses and refuses retention without widening exclusions", () => {
  setReplayShadowForTest(true);
  row("copy", "conversation", { threadId: "source", messageIds: Array.from({ length: 17 }, (_, i) => `missing${i}`) });
  // Visit all missing roots, rather than short circuiting at the first one.
  const roots = new Map([["copy", Array.from({ length: 17 }, (_, i) => ({ threadId: "source", messageId: `missing${i}` }))]]);
  const proof = captureSendReplayProof("conversation", ["copy"], roots);
  confirmFreshReplaySession("conversation", "engine", "session", proof);
  expect(current()).toBe(false); expect(lastReplaySessionConservativeForTest()).toBe("R2");
  expect(proof.excludedIds.has("copy")).toBe(true);
  const manyThreads = new Map([["copy", Array.from({ length: 65 }, (_, i) => { row("original", `source${i}`); return { threadId: `source${i}`, messageId: "original" }; })]]);
  confirmFreshReplaySession("conversation", "engine", "threads", captureSendReplayProof("conversation", ["copy"], manyThreads));
  expect(current("threads")).toBe(false); expect(lastReplaySessionConservativeForTest()).toBe("R2");
});

it("T8b single-consumer malformed input also requires the purity fallback", () => {
  setReplayShadowForTest(true); row("invalid"); database().exec("UPDATE messages SET json='invalid' WHERE id='invalid'");
  const state = { proof: captureSendReplayProof("conversation", ["invalid"]) };
  const store = new SendAttemptStore(database()), before = replayWalkWorkForTest();
  store.transaction(() => updateReceiptReplayProof(database(), state, ["invalid"], () => {
    database().exec("INSERT INTO send_replay_exclusions VALUES('conversation','invalid',NULL,'uncertain',1); INSERT INTO send_replay_epochs VALUES('conversation',1)");
  }));
  expect(replayWalkWorkForTest().fallbacks - before.fallbacks).toBe(1);
  expect(proofJson(state.proof)).toEqual(proofJson(captureSendReplayProof("conversation", ["invalid"])));
});

it("M1 epoch witness refuses an unwitnessed change without relying on the shadow", () => {
  row("history"); retain(["history"]);
  database().exec("INSERT INTO send_replay_epochs VALUES('conversation',1)");
  expect(current()).toBe(false);
});

it("T1d durable native caller keeps equal SQL work and exact dependencies after reopening", () => {
  const results = [50, 5000].map(n => {
    reset(); const ids = seed(n), proof = captureSendReplayProof("conversation", ids);
    confirmFreshReplaySession("conversation", "engine", "session", proof, { generation: "initial", turnId: "initial" });
    const measured = measure(() => {
      const store = new SendAttemptStore(database()); row("current");
      const attempt = store.create({ ownerId: "owner", botId: "fixture", threadId: "conversation", sendId: "current", fingerprint: "fixture" });
      withCurrentReplaySessionChange("conversation", "engine", "session", ["current"], () => store.link(attempt.attemptId, "current"));
      let key = store.bind([attempt.attemptId], { generation: "current", providerInstanceId: "engine" })[0]!;
      const next = new FreshReplaySessionConfirmation(captureSendReplayProof("conversation", ["current"]), "engine", () => {}, { ownMessageIds: ["current"], retainedSession: "session", generation: "current" });
      next.ownEligibilityChange(() => store.releaseWrite(key, store.byId(attempt.attemptId)!.revision, 1));
      next.ownEligibilityChange(() => { key = store.allocateProvider(key, store.byId(attempt.attemptId)!.revision, "current"); store.acknowledge(key, store.byId(attempt.attemptId)!.revision); });
      next.engineWritten(); next.accepted("current");
      return current();
    });
    expect(measured.value).toBe(true); expect(measured.work.fallbacks).toBe(0);
    closeDatabase(); database(); expect(current()).toBe(true);
    database().exec("INSERT INTO send_replay_exclusions VALUES('conversation','current',NULL,'uncertain',1); UPDATE send_replay_epochs SET revision=revision+1 WHERE thread_id='conversation'");
    expect(current()).toBe(false);
    return measured;
  });
  console.log("REPLAY_DURABLE_WORK", JSON.stringify(results)); expect(results[1]).toEqual(results[0]);
});

it("T8c a single-consumer over-budget copy walk cannot bypass the purity fallback", () => {
  setReplayShadowForTest(true);
  for (let i = 0; i < 200; i++) row(`budget${i}`, "source", i < 199 ? { threadId: "source", messageIds: [`budget${i + 1}`] } : undefined);
  row("current");
  const roots = new Map([["current", Array.from({ length: 256 }, (_, i) => ({ threadId: "source", messageId: `budget${i % 200}` }))]]);
  const state = { proof: captureSendReplayProof("conversation", ["current"], roots) };
  expect(walkOf(state.proof)!.impure.has("current")).toBe(true);
  const before = replayWalkWorkForTest(), store = new SendAttemptStore(database());
  store.transaction(() => updateReceiptReplayProof(database(), state, ["current"], () => {
    database().exec("INSERT INTO send_replay_exclusions VALUES('conversation','current',NULL,'uncertain',1); INSERT INTO send_replay_epochs VALUES('conversation',1)");
  }));
  expect(replayWalkWorkForTest().fallbacks - before.fallbacks).toBe(1);
  expect(proofJson(state.proof)).toEqual(proofJson(captureSendReplayProof("conversation", ["current"], roots)));
});

it("T8d shared 200-node ancestry changes the second candidate's budget outcome when the impure first input is excluded", () => {
  setReplayShadowForTest(true);
  const leaves = Array.from({ length: 200 }, (_, i) => `leaf${i}`);
  const prefix = Array.from({ length: 160 }, (_, i) => `prefix${i}`);
  for (const id of [...leaves, ...prefix]) row(id, "source");
  row("shared", "source", { threadId: "source", messageIds: leaves });
  row("first", "conversation", { threadId: "source", messageIds: [...prefix, "shared"] });
  row("second", "conversation", { threadId: "source", messageIds: ["shared"] });
  const state = { proof: captureSendReplayProof("conversation", ["first", "second"]) }, before = state.proof;
  expect(walkOf(before)!.impure.has("first")).toBe(true);
  expect([...before.excludedIds]).toEqual(["first", "second"]);
  // With a fresh budget the second input's shared 200 leaves fit. The first
  // candidate's earlier budget failure supplied the old true memo instead.
  expect([...captureSendReplayProof("conversation", ["second"]).excludedIds]).toEqual([]);
  const work = replayWalkWorkForTest(), store = new SendAttemptStore(database());
  expect(() => store.transaction(() => updateReceiptReplayProof(database(), state, ["first"], () => {
    database().exec("INSERT INTO send_replay_exclusions VALUES('conversation','first',NULL,'uncertain',1); INSERT INTO send_replay_epochs VALUES('conversation',1)");
    const full = captureSendReplayProof("conversation", ["first", "second"]);
    expect([...full.excludedIds]).toEqual(["first"]);
  }))).toThrow("SEND_REPLAY_CHANGED"); // today's unowned second-input change refuses
  expect(replayWalkWorkForTest().fallbacks - work.fallbacks).toBe(1);
  expect(state.proof).toBe(before);
  expect(database().prepare("SELECT 1 FROM send_replay_exclusions WHERE message_id='first'").get()).toBeUndefined();
});


it.each([50, 5000])("H1 successful missing-candidate fallback refreshes repeated checks (history=%s)", n => {
  seed(n);
  const ids = [...replaySessionStateForTest("conversation", "engine", "session")!.candidates, "absent"];
  retain(ids); row("absent"); // Plain insertion deliberately leaves the replay epoch unchanged.
  const first = measure(() => current());
  expect(first.value).toBe(true); expect(first.work.nodeReads).toBe(n + 1);
  for (let i = 0; i < 3; i++) {
    const repeated = measure(() => current());
    expect(repeated.value).toBe(true); expect(repeated.work.nodeReads).toBe(0); expect(repeated.work.missingProbes).toBe(0);
  }
  expect(replaySessionStateForTest("conversation", "engine", "session")!.missing).toEqual([]);
  cycle("next"); expect(current()).toBe(true);
});

it("H1 refresh rollback restores the retained witness and reverse index", () => {
  seed(50); const ids = [...replaySessionStateForTest("conversation", "engine", "session")!.candidates, "absent"];
  retain(ids); const before = replaySessionStateForTest("conversation", "engine", "session");
  const store = new SendAttemptStore(database());
  expect(() => store.transaction(() => {
    row("absent"); expect(current()).toBe(true);
    expect(replaySessionStateForTest("conversation", "engine", "session")!.missing).toEqual([]);
    cycle("rolled-back"); expect(current()).toBe(true); throw new Error("fixture rollback");
  })).toThrow("fixture rollback");
  expect(replaySessionStateForTest("conversation", "engine", "session")).toEqual(before);
  expect(current()).toBe(true); cycle("committed"); expect(current()).toBe(true);
});

it.each(["currency", "proof", "observer"])("M-shadow divergence escapes the %s catch", consumer => {
  row("history"); retain(["history"]); setReplayShadowForTest(true);
  database().prepare("UPDATE messages SET json=? WHERE id='history'").run(JSON.stringify({ copyOf: { threadId: "source", messageIds: ["missing"] } }));
  // Deliberately broken writer skips its epoch bump: this must be fatal.
  const read = consumer === "currency" ? () => current()
    : consumer === "proof" ? () => currentSendReplaySessionProof("conversation", "engine", "session") : () => cycle("next");
  expect(read).toThrow("REPLAY_SHADOW_DIVERGED");
  expect(takeReplayShadowDivergencesForTest()).toBe(1);
});
