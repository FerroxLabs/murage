// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The learning send gate (designs/MEM-LEARNING-FENCE-R8.md §1, §3, §6): the counter, the transaction protocol, release accounting and the
// lock hold time. The transport tests (T1-T4, T6, T9, T10) drive real adapters through this gate in learning-send-fence.test.ts and
// text-only-fence.test.ts.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { currentBusy, DEFAULT_BUSY_MS } from "../db-busy.ts";
import {
  OWNER, WORKSPACE_OWNER, bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanDelivery, revokeHumanConnection, shareHumanScope,
  type VerifiedHumanOrigin,
} from "../human-principals.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { bumpAuthorityHard } from "./authority-epoch.ts";
import { isMemorySendFenced } from "./learning-send-fence.ts";
import {
  LEARNING_FENCE_QUIET_BINDINGS, LEARNING_FENCE_TRIGGERS, MemorySendCommitFailed, digestOf, installLearningFence, isMemorySendBusy, learningGate, learningSendHoldSamples,
  sampleLearningFence, type LearningGate,
} from "./learning-send.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { linkPriorTurn } from "./feedback.ts";
import { feedbackClassifierGate } from "./learning-wiring.ts";
import { createGepaCallLedger } from "./gepa-ledger.ts";
import { ownerMemoryTicket, rememberMemory } from "./authority.ts";
import { admitMemoryEvolutionCorpus } from "./evolution-policy.ts";
import { forgetMemory } from "./forget.ts";
import { accountingWrite } from "./learning-send.ts";
import type { Message } from "../store.ts";
import { setMemoryMode } from "./repository.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });

const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
function ownerRecord(text: string): string {
  reconcileMemoryRoster(roster); setMemoryMode("active");
  const id = randomUUID(), scope = ensureScope("preferences", "person:" + WORKSPACE_OWNER);
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,NULL,NULL,?)").run(id, scope, text, Date.now(), Date.now());
  return id;
}
function gateOver(refs: Parameters<typeof learningGate>[2] = {}, options: Parameters<typeof learningGate>[3] = {}): LearningGate {
  database();
  return learningGate("extraction", sampleLearningFence(), refs, options);
}
const second = () => { const db = new DatabaseSync(join(DATA_DIR, "messages.db")); db.exec("PRAGMA busy_timeout=0"); return db; };
const settledCleanly = () => {
  const db = database();
  expect(db.isTransaction).toBe(false);
  expect(currentBusy(db)).toBe(DEFAULT_BUSY_MS);
};

describe("learning send gate: an unchanged call (T5b)", () => {
  it("releases once, leaves no transaction, and lets another connection commit right after", () => {
    const id = ownerRecord("zqgatea");
    const gate = gateOver({ records: [{ id, version: 1, digest: digestOf("zqgatea") }] });
    const sent: string[] = [];
    expect(gate.send(() => { sent.push("zqgatea"); return 7; })).toBe(7);
    expect(sent).toEqual(["zqgatea"]);
    expect(gate.released).toBe(1);
    settledCleanly();
    const other = second();
    try { other.exec("BEGIN IMMEDIATE; COMMIT"); } finally { other.close(); }
  });
  it("returns a Promise from emit without holding the lock across it", async () => {
    const gate = gateOver();
    const out = gate.send(() => Promise.resolve("reply"));
    settledCleanly();
    expect(await out).toBe("reply");
  });
});

describe("the counter moves on every withdrawal (T1d, T1e, T1g, T13)", () => {
  it("a meta bump with no tombstone drops the call", () => {
    const gate = gateOver();
    database().prepare("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1").run();
    const emit = vi.fn();
    expect(() => gate.send(emit)).toThrow(/MEMORY_SEND_FENCED/);
    expect(emit).not.toHaveBeenCalled();
    expect(gate.released).toBe(0);
    expect(gate.refused).toBe(true);
    settledCleanly();
  });
  it("a roster withdrawal moves the counter even with the authority triggers absent", () => {
    const gate = gateOver();
    const db = database();
    for (const row of db.prepare("SELECT name FROM temp.sqlite_master WHERE type='trigger' AND name LIKE 'authority_%'").all()) db.exec(`DROP TRIGGER temp.${String(row.name)}`);
    bumpAuthorityHard(db);
    expect(() => gate.check()).toThrow(/MEMORY_SEND_FENCED/);
  });
  it("memory mode off drops the call (T1f)", () => {
    ownerRecord("zqmode");
    const gate = gateOver();
    setMemoryMode("off");
    expect(() => gate.send(() => undefined)).toThrow(/MEMORY_SEND_FENCED/);
  });
  it("a non-quiet binding moves the counter", () => {
    reconcileMemoryRoster(roster);
    const gate = gateOver();
    const scope = ensureScope("preferences", "person:" + WORKSPACE_OWNER);
    database().prepare("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES(?,?,'thread','t9',0,'granted','{}')").run(randomUUID(), scope);
    expect(() => gate.send(() => undefined)).toThrow(/MEMORY_SEND_FENCED/);
  });
  it("a quiet binding (procedure-evaluation-charges) does not move the counter (T9c)", () => {
    reconcileMemoryRoster(roster);
    const gate = gateOver();
    const scope = ensureScope("preferences", "person:" + WORKSPACE_OWNER);
    database().prepare("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES(?,?,'system','procedure-evaluation-charges',0,'granted','{}')").run(randomUUID(), scope);
    expect(() => gate.send(() => undefined)).not.toThrow();
  });
});

describe("held records carry a digest (T2e, T14)", () => {
  it("an in-place rewrite at the same version drops the call", () => {
    const id = ownerRecord("zqscrub one");
    const gate = gateOver({ records: [{ id, version: 1, digest: digestOf("zqscrub one") }] });
    database().prepare("UPDATE memory_records SET text='[scrubbed]' WHERE id=? AND version=1").run(id);
    expect(() => gate.send(() => undefined)).toThrow(/MEMORY_SEND_FENCED/);
  });
  it("an archive drops the held record", () => {
    const id = ownerRecord("zqarchive");
    const gate = gateOver({ records: [{ id, version: 1, digest: digestOf("zqarchive") }] });
    database().prepare("UPDATE memory_records SET state='archived' WHERE id=?").run(id);
    expect(() => gate.check()).toThrow(/MEMORY_SEND_FENCED/);
  });
});

describe("counter installation fails closed (T16)", () => {
  it("a missing trigger, a dropped table or a reinstalled token each fence the call", () => {
    let gate = gateOver();
    database().exec(`DROP TRIGGER temp.${LEARNING_FENCE_TRIGGERS[0]}`);
    expect(() => gate.check()).toThrow(/MEMORY_SEND_FENCED/);
    expect(installLearningFence()).toBe(true);
    gate = gateOver();
    database().exec("DROP TABLE temp.memory_learning_fence");
    expect(() => gate.check()).toThrow(/MEMORY_SEND_FENCED/);
    gate = gateOver();
    database().exec("DROP TABLE temp.memory_learning_fence");
    expect(installLearningFence()).toBe(true);
    expect(() => gate.check()).toThrow(/MEMORY_SEND_FENCED/);
  });
  it("a gate with no sample refuses", () => {
    database();
    expect(() => learningGate("grounding", undefined).send(() => undefined)).toThrow(/MEMORY_SEND_FENCED/);
  });
});

describe("other connections (T18b)", () => {
  it("a commit from a second connection during the wait drops the call", () => {
    const gate = gateOver();
    const other = second();
    try { other.exec("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread','t2',1,1)"); } finally { other.close(); }
    expect(() => gate.send(() => undefined)).toThrow(/MEMORY_SEND_FENCED/);
  });
  it("a second connection cannot commit during emit, and a held lock is MemorySendBusy with nothing released", () => {
    const gate = gateOver();
    let blocked = false;
    gate.send(() => {
      const other = second();
      try { other.exec("BEGIN IMMEDIATE"); } catch { blocked = true; } finally { other.close(); }
    });
    expect(blocked).toBe(true);
    const holder = second();
    try {
      const busy = gateOver();
      holder.exec("BEGIN IMMEDIATE");
      let error: unknown;
      try { busy.send(() => undefined); } catch (e) { error = e; }
      expect(isMemorySendBusy(error)).toBe(true);
      expect(busy.released).toBe(0);
      expect(busy.refused).toBe(false);
      settledCleanly();
      holder.exec("ROLLBACK");
    } finally { holder.close(); }
  });
});

describe("transaction protocol (T18c, T18d)", () => {
  it("refuses inside a caller's transaction, before BEGIN, and leaves that transaction untouched", () => {
    const gate = gateOver();
    transaction(db => {
      expect(() => gate.send(() => undefined)).toThrow(/MEMORY_SEND_FENCED/);
      expect(() => gate.admit()).toThrow(/MEMORY_SEND_FENCED/);
      expect(db.isTransaction).toBe(true);
    });
    expect(gate.released).toBe(0);
  });
  it("an emit that throws after the release still commits and counts as released", () => {
    const gate = gateOver();
    expect(() => gate.send(() => { throw new Error("engine went away"); })).toThrow(/engine went away/);
    expect(gate.released).toBe(1);
    settledCleanly();
  });
  it("a COMMIT failure after the release rolls back, keeps released, and is never unsent", () => {
    const gate = gateOver();
    const db = database(), exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql: string) => { if (sql === "COMMIT") throw new Error("disk I/O error"); return exec(sql); });
    expect(() => gate.send(() => undefined)).toThrow(MemorySendCommitFailed);
    vi.restoreAllMocks();
    expect(gate.released).toBe(1);
    settledCleanly();
  });
  it("a refusal in onAdmit rolls back its own writes and releases nothing", () => {
    const gate = gateOver({}, { onAdmit: () => { transaction(db => db.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('scope','charged',1,1)").run()); throw new Error("over budget"); } });
    expect(() => gate.send(() => undefined)).toThrow();
    expect(gate.released).toBe(0);
    expect(database().prepare("SELECT 1 FROM memory_deny WHERE id='charged'").get()).toBeUndefined();
    settledCleanly();
  });
  it("a check() refusal ends cleanly on every path", () => {
    const gate = gateOver({}, { checks: [() => { throw new Error("stamp moved"); }] });
    expect(() => gate.send(() => undefined)).toThrow(/MEMORY_SEND_FENCED/);
    settledCleanly();
  });
});

describe("release accounting (T3b, T6b, T6c)", () => {
  it("a pin then a fallback on one gate is two releases", () => {
    const gate = gateOver();
    gate.send(() => undefined); gate.send(() => undefined);
    expect(gate.released).toBe(2);
  });
  it("a busy fallback after a sent pin keeps released at 1", () => {
    const gate = gateOver();
    gate.send(() => undefined);
    const holder = second();
    try {
      holder.exec("BEGIN IMMEDIATE");
      expect(() => gate.send(() => undefined)).toThrow(/MEMORY_SEND_BUSY/);
      holder.exec("ROLLBACK");
    } finally { holder.close(); }
    expect(gate.released).toBe(1);
  });
  it("notWritten withdraws only an open, unwritten admission, once", () => {
    const gate = gateOver();
    gate.notWritten();                    // before any admit: no-op
    expect(gate.released).toBe(0);
    gate.admit(); gate.wrote();           // earlier attempt written
    gate.admit(); gate.notWritten();      // later admission withdrawn
    gate.notWritten();                    // a second withdrawal: no-op
    expect(gate.released).toBe(1);
    const fresh = gateOver();
    fresh.admit(); fresh.notWritten();
    expect(fresh.released).toBe(0);
  });
});

describe("lock hold time (T18e)", () => {
  it("the BEGIN to COMMIT hold stays under 50 ms", () => {
    const gate = gateOver();
    for (let i = 0; i < 50; i++) gate.send(() => undefined);
    const samples = [...learningSendHoldSamples()].slice(-50).sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99) - 1] ?? samples.at(-1)!;
    console.info(`[learning-send-hold] transport=gate-only n=${samples.length} p50=${samples[25]!.toFixed(3)}ms p99=${p99.toFixed(3)}ms`);
    expect(p99).toBeLessThan(50);
  });
});

it("a refused call's error carries fixed words only", () => {
  const gate = gateOver();
  database().prepare("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1 WHERE id=1").run();
  let error: unknown;
  try { gate.send(() => undefined); } catch (e) { error = e; }
  expect(isMemorySendFenced(error)).toBe(true);
  expect(String((error as Error).message)).toBe("MEMORY_SEND_FENCED");
});

// Astra code r1 H2: the classifier is shown every same-turn bot text row joined into the turn text; the gate holds each one, by digest and
// branch membership, not only the target and activity rows.
describe("the feedback classifier gate holds every same-turn bot text row (H2)", () => {
  const rows = (): Message[] => [
    { id: "n1", at: 1, role: "bot", kind: "text", text: "zqfirst part of the answer", turnId: "T" },
    { id: "a1", at: 2, role: "bot", kind: "activity", tool: { name: "send_email", ok: true }, turnId: "T" } as Message,
    { id: "n2", at: 3, role: "bot", kind: "text", text: "zqfinal words", turnId: "T", turnTerminal: true },
    { id: "u1", at: 4, role: "user", kind: "text", text: "no, shorter", origin: "desktop" },
  ];
  const setup = () => {
    database();
    const thread = rows(), byId = new Map(thread.map(m => [m.id, m])), onBranch = new Set(thread.map(m => m.id));
    const turn = linkPriorTurn(thread[3]!, thread)!;
    const gate = feedbackClassifierGate(sampleLearningFence(), "th", { turn, message: "no, shorter" },
      { messageById: (_t, id) => byId.get(id), branchMembership: () => id => onBranch.has(id), stillCurrent: () => true });
    return { turn, gate, byId, onBranch };
  };
  it("the turn lists both text rows, and an unchanged turn sends once", () => {
    const { turn, gate } = setup();
    expect(turn.textMessageIds).toEqual(["n1", "n2"]);
    expect(turn.text).toContain("zqfirst part");
    gate.send(() => undefined);
    expect(gate.released).toBe(1);
  });
  it("an in-place rewrite of a non-target text row (no delete, no counter move) drops the call", () => {
    const { gate, byId } = setup();
    byId.set("n1", { ...byId.get("n1")!, text: "rewritten" });
    expect(() => gate.send(() => undefined)).toThrow(/source-changed|MEMORY_SEND_FENCED/);
    expect(gate.released).toBe(0);
  });
  it("a contributing row that left the visible branch drops the call", () => {
    const { gate, onBranch } = setup();
    onBranch.delete("n1");
    expect(() => gate.send(() => undefined)).toThrow(/source-changed|MEMORY_SEND_FENCED/);
    expect(gate.released).toBe(0);
  });
});

// r9 (designs/MEM-LEARNING-FENCE-R9.md, Astra code r1 H3): GEPA's own accounting writes are quiet by exact statement name; a real Forget
// and every withdrawal still fence.
describe("GEPA accounting writes do not fence their own calls; a Forget still does (T20)", () => {
  const H = (n: number) => n.toString(16).padStart(64, "0");
  const ledgerRun = () => {
    reconcileMemoryRoster(roster); setMemoryMode("active");
    const scopeId = ensureScope("preferences", "person:" + WORKSPACE_OWNER);
    const ledger = createGepaCallLedger({ scopeId, jobId: "gepa:t20", snapshotDigest: H(1), evidence: [], maxMetricCalls: 24, maxReflections: 2, assertCurrent: () => undefined });
    const charges = "gepa-charges:" + H(9);
    const call = (n: number) => {
      ledger.lookupOrReserve(`gepa:t20:${n}`, H(100 + n), "evaluate");
      ledger.complete(`gepa:t20:${n}`, H(100 + n), { outputs: [n], scores: [1], trajectories: null });
      const id = `gepa-charge:${H(200 + n)}`;
      accountingWrite(database(), "gepa-evaluator.charge-reserve", id, scopeId, charges, JSON.stringify({ callId: `c${n}`, ceilingUsd: null, actualUsd: null }));
      accountingWrite(database(), "gepa-evaluator.charge-settle", JSON.stringify({ callId: `c${n}`, actualUsd: 0, confirmed: true }), id, charges);
      accountingWrite(database(), "gepa-evaluator.charge-release", JSON.stringify({ callId: `c${n}`, actualUsd: 0, confirmed: true, notStarted: true }), id, charges);
    };
    return { scopeId, ledger, call, charges };
  };
  const moved = (write: () => void) => { const gate = gateOver(); write(); expect(() => gate.send(() => undefined)).toThrow(/MEMORY_SEND_FENCED/); };

  it("T20a: successive real ledger and charge writes between one sample and its calls; every gate sends", () => {
    const run = ledgerRun();
    const fenceAt = sampleLearningFence();
    for (let n = 1; n <= 4; n++) {
      run.call(n);
      const gate = learningGate("evaluation", fenceAt);
      gate.send(() => undefined);
      expect(gate.released).toBe(1);
    }
    const quiet = database().prepare("SELECT quiet FROM temp.memory_learning_fence WHERE id=1").get();
    expect(quiet?.quiet ?? null).toBeNull();
  });
  it("T20b: a real Forget of an unrelated record, and the evolution-forgetting revoke of a call row, still fence", () => {
    const run = ledgerRun();
    const other = ownerRecord("zqunrelated fact");
    const fenceAt = sampleLearningFence();
    run.call(1);
    forgetMemory(ownerMemoryTicket(), { kind: "record", id: other });
    expect(() => learningGate("evaluation", fenceAt).send(() => undefined)).toThrow(/MEMORY_SEND_FENCED/);
    const row = database().prepare("SELECT id FROM memory_scope_bindings WHERE subject_id LIKE 'gepa-job:%' LIMIT 1").get()!;
    moved(() => database().prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE id=?").run(String(row.id)));
  });
  it("T20c: under the flag nothing that withdraws is quiet; unknown and nested names throw; the flag never outlives its statement", () => {
    const run = ledgerRun();
    run.call(1);
    const db = database();
    let k = 0;
    // each change on its own fresh granted charge row, written quietly first
    const fresh = () => { const id = `gepa-charge:${H(500 + ++k)}`; accountingWrite(db, "gepa-evaluator.charge-reserve", id, run.scopeId, run.charges, "{}"); return id; };
    const flagged = (sql: string, ...p: Array<string | number>) => { db.prepare("UPDATE temp.memory_learning_fence SET quiet='gepa-evaluator.charge-settle',quiet_subject=? WHERE id=1").run(run.charges); try { db.prepare(sql).run(...p); } finally { db.prepare("UPDATE temp.memory_learning_fence SET quiet=NULL,quiet_subject=NULL WHERE id=1").run(); } };
    // control: the flag with the right subject and an intent-only change IS quiet (so every move below is the rule, not the helper)
    { const id = fresh(), gate = gateOver(); flagged("UPDATE memory_scope_bindings SET intent='{\"x\":1}' WHERE id=?", id); expect(() => gate.send(() => undefined)).not.toThrow(); }
    // GrokBuild r9 H: under the flag, an intent-only rewrite of ANOTHER system row (the owner's settings, a procedure grant) still moves it
    for (const subject of ["memory-owner-settings", "procedure-evaluation-grant"]) {
      const other = randomUUID();
      db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted','{}')").run(other, run.scopeId, subject);
      moved(() => flagged("UPDATE memory_scope_bindings SET intent='{\"revoked\":true}' WHERE id=?", other));
    }
    expect(() => accountingWrite(db, "gepa-evaluator.charge-settle", "{}", "x", "memory-owner-settings")).toThrow(/LEARNING_FENCE_ACCOUNTING_SUBJECT/);
    expect(() => accountingWrite(db, "gepa-ledger.call-save", "x", run.scopeId, run.charges, "{}")).toThrow(/LEARNING_FENCE_ACCOUNTING_SUBJECT/);
    for (const change of ["state='revoked'", "revision=revision+1", "subject_type='thread'", "subject_id='other'", "id=id||'-renamed'"]) {
      const id = fresh();
      moved(() => flagged(`UPDATE memory_scope_bindings SET ${change} WHERE id=?`, id));
    }
    const other = ensureScope("workspace", "t20-other");
    { const id = fresh(); moved(() => flagged("UPDATE memory_scope_bindings SET scope_id=? WHERE id=?", other, id)); }
    { const id = fresh(); moved(() => flagged("DELETE FROM memory_scope_bindings WHERE id=?", id)); }
    moved(() => flagged("INSERT INTO memory_scope_bindings VALUES(?,?,'thread','t20',0,'granted','{}')", randomUUID(), run.scopeId));
    const id = fresh();
    expect(() => accountingWrite(db, "no-such-write" as never, "x")).toThrow(/LEARNING_FENCE_ACCOUNTING_UNKNOWN/);
    db.prepare("UPDATE temp.memory_learning_fence SET quiet='gepa-ledger.call-save',quiet_subject='gepa-job:x' WHERE id=1").run();
    expect(() => accountingWrite(db, "gepa-evaluator.charge-settle", "{}", id, run.charges)).toThrow(/LEARNING_FENCE_ACCOUNTING_NESTED/);
    db.prepare("UPDATE temp.memory_learning_fence SET quiet=NULL,quiet_subject=NULL WHERE id=1").run();
    // a throwing statement clears the flag; the next ordinary write moves the counter
    expect(() => accountingWrite(db, "gepa-evaluator.charge-settle", "not json", id, run.charges)).toThrow();
    expect(db.prepare("SELECT quiet FROM temp.memory_learning_fence WHERE id=1").get()?.quiet ?? null).toBeNull();
    moved(() => db.prepare("UPDATE memory_scope_bindings SET intent='{}' WHERE id=?").run(id));
    // a completed call value cannot be replaced
    expect(() => run.ledger.complete("gepa:t20:1", H(101), { outputs: [99], scores: [0], trajectories: null })).toThrow(/GEPA_LEDGER_RECEIPT_CONFLICT/);
  });
  it("T20c: with the quiet column missing every check fails closed", () => {
    ledgerRun();
    const gate = gateOver();
    const db = database();
    db.exec("DROP TABLE temp.memory_learning_fence");
    db.exec("CREATE TEMP TABLE memory_learning_fence(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL, token TEXT NOT NULL)");
    db.exec("INSERT INTO temp.memory_learning_fence VALUES(1,0,'x')");
    expect(() => gate.send(() => undefined)).toThrow(/MEMORY_SEND_FENCED/);
  });
});

// r10.1 (designs/MEM-LEARNING-FENCE-R10.md): binding writes that cannot change held words are quiet by exact subject and transition; every
// identity change, share, thread bind, corpus state change and DELETE still moves the counter.
describe("binding writes that change no held words do not fence; every withdrawal still does (T21)", () => {
  const H = (n: number) => n.toString(16).padStart(64, "0");
  const origin = (n: number): VerifiedHumanOrigin => ({ platform: "slack", connectionId: "c-t21", authorityId: "team-t21", userId: `u${n}` });
  const corpus = (n: number) => ({ kind: "synthetic" as const, corpusDigest: H(n), holdoutDigest: H(1000 + n), family: "classification" as const });
  const quiet = (write: () => void) => { const gate = gateOver(); write(); expect(() => gate.send(() => undefined)).not.toThrow(); expect(gate.released).toBe(1); };
  const moved = (write: () => void) => { const gate = gateOver(); write(); expect(() => gate.send(() => undefined)).toThrow(/MEMORY_SEND_FENCED/); };
  const row = (id: string) => database().prepare("SELECT * FROM memory_scope_bindings WHERE id=?").get(id)!;
  const ofType = (type: string, subject?: string) => String(database().prepare(`SELECT id FROM memory_scope_bindings WHERE subject_type=?${subject ? " AND subject_id=?" : ""} ORDER BY rowid DESC LIMIT 1`).get(...(subject ? [type, subject] : [type]))!.id);
  const linked = (n: number) => { const id = observeVerifiedHuman(origin(n)); linkHumanBinding(ownerMemoryTicket(), { bindingId: id, expectedRevision: 1, as: "person" }); return id; };
  beforeEach(() => { reconcileMemoryRoster(roster); setMemoryMode("active"); database(); });

  it("T21a: each Q1/Q2/Q3/Q5 write by its real writer after the sample, the gate still releases", () => {
    quiet(() => rememberMemory(ownerMemoryTicket(), { actionId: "t21-a", text: "zqt21 the owner likes tea" }));
    let id = "";
    quiet(() => { id = observeVerifiedHuman(origin(1), { name: "Ana" }); });
    quiet(() => observeVerifiedHuman(origin(1), { name: "Ana B" }));
    expect(JSON.parse(String(row(id).intent)).display).toEqual({ name: "Ana B" });
    const person = linked(2);
    quiet(() => resolveHumanDelivery(person, "d-t21"));
    quiet(() => admitMemoryEvolutionCorpus(ownerMemoryTicket(), corpus(1)));
    // re-admitting the same corpus: the :49 rewrite of already-revoked rows and the :50 granted->granted same-intent rewrite
    admitMemoryEvolutionCorpus(ownerMemoryTicket(), corpus(2));
    quiet(() => admitMemoryEvolutionCorpus(ownerMemoryTicket(), corpus(2)));
  });

  it("T21b: a link, revokeHumanConnection, a share, a share withdrawal and a human-thread bind each refuse", () => {
    const id = observeVerifiedHuman(origin(3));
    let personId = "";
    moved(() => { personId = linkHumanBinding(ownerMemoryTicket(), { bindingId: id, expectedRevision: 1, as: "person" }).personId!; });
    const room = ensureScope("workspace", "t21-room");
    moved(() => shareHumanScope(ownerMemoryTicket(), { personId, scopeId: room, granted: true }));
    moved(() => shareHumanScope(ownerMemoryTicket(), { personId, scopeId: room, granted: false }));
    moved(() => bindHumanThread("t21-thread", OWNER));
    moved(() => revokeHumanConnection("slack", "c-t21"));
  });

  it("T21c: under each Q entry a DELETE, a revision/state/scope/subject change, an intent change where not allowed and another subject_type each move", () => {
    rememberMemory(ownerMemoryTicket(), { actionId: "t21-c", text: "zqt21 the owner likes coffee" });
    observeVerifiedHuman(origin(4));
    resolveHumanDelivery(linked(5), "d-t21c");
    admitMemoryEvolutionCorpus(ownerMemoryTicket(), corpus(3));
    const entries = [
      { type: "system", subject: "remember-action", intentQuiet: false },
      { type: "human-binding", intentQuiet: true },
      { type: "human-delivery", intentQuiet: false },
      { type: "system", subject: "memory-evolution-corpus", intentQuiet: false },
    ];
    const db = database(), other = ensureScope("workspace", "t21-other");
    const clone = (id: string) => { const copy = `${id}-copy-${randomUUID()}`; db.prepare("INSERT INTO memory_scope_bindings SELECT ?,scope_id,subject_type,subject_id,revision,state,intent FROM memory_scope_bindings WHERE id=?").run(copy, id); return copy; };
    for (const e of entries) {
      const base = ofType(e.type, e.subject);
      // a clone of the row is itself a granted insert of the same subject: quiet, so each change below is the rule
      let id = ""; quiet(() => { id = clone(base); });
      for (const change of ["revision=revision+1", "state='revoked'", "subject_type='thread'", "subject_id='t21-other'", "id=id||'-renamed'"]) {
        const fresh = clone(base);
        moved(() => db.prepare(`UPDATE memory_scope_bindings SET ${change} WHERE id=?`).run(fresh));
      }
      { const fresh = clone(base); moved(() => db.prepare("UPDATE memory_scope_bindings SET scope_id=? WHERE id=?").run(other, fresh)); }
      (e.intentQuiet ? quiet : moved)(() => db.prepare("UPDATE memory_scope_bindings SET intent='{\"t21\":1}' WHERE id=?").run(id));
      moved(() => db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run(id));
      // the same subject under another subject_type, and an insert not granted
      moved(() => db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'thread',?,0,'granted','{}')").run(randomUUID(), other, e.subject ?? "t21-subject"));
      moved(() => db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,?,?,0,'pending','{}')").run(randomUUID(), other, e.type, e.subject ?? "t21-subject"));
    }
    // a system row with a near-miss subject is not quiet (exact equality, no prefix)
    moved(() => db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','remember-action-x',0,'granted','{}')").run(randomUUID(), other));
    // the registry is frozen and every literal is checked
    expect(Object.isFrozen(LEARNING_FENCE_QUIET_BINDINGS)).toBe(true);
    expect(LEARNING_FENCE_QUIET_BINDINGS.map(q => q.subject ?? q.type)).toEqual(["remember-action", "human-binding", "human-delivery", "memory-evolution-corpus"]);
  });

  it("T21d: a corpus revoke after the sample refuses both evolution gates; admit A, sample, admit B, re-admit A refuses", () => {
    admitMemoryEvolutionCorpus(ownerMemoryTicket(), corpus(10));
    let fenceAt = sampleLearningFence();
    database().prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE subject_type='system' AND subject_id='memory-evolution-corpus'").run();
    for (const kind of ["evaluation", "reflection"] as const) expect(() => learningGate(kind, fenceAt).send(() => undefined)).toThrow(/MEMORY_SEND_FENCED/);
    admitMemoryEvolutionCorpus(ownerMemoryTicket(), corpus(11));
    fenceAt = sampleLearningFence();
    admitMemoryEvolutionCorpus(ownerMemoryTicket(), corpus(12));
    admitMemoryEvolutionCorpus(ownerMemoryTicket(), corpus(11));
    for (const kind of ["evaluation", "reflection"] as const) expect(() => learningGate(kind, fenceAt).send(() => undefined)).toThrow(/MEMORY_SEND_FENCED/);
  });

  it("T21e: the installed trigger bodies keep the registry exact (no LIKE, GLOB or regex) and every trigger is present", () => {
    const db = database();
    expect(installLearningFence(db)).toBe(true);
    const bodies = db.prepare("SELECT name,sql FROM temp.sqlite_master WHERE type='trigger' AND name IN ('learning_fence_bindings_i','learning_fence_bindings_u','learning_fence_bindings_d')").all().map(r => ({ name: String(r.name), sql: String(r.sql) }));
    expect(bodies.length).toBe(3);
    for (const b of bodies) expect(b.sql).not.toMatch(/\b(LIKE|GLOB|REGEXP|MATCH|substr|instr)\b/i);
    expect(bodies.find(b => b.name.endsWith("_d"))!.sql).not.toMatch(/remember-action|human-binding|human-delivery|memory-evolution-corpus/);
    const names = new Set(db.prepare("SELECT name FROM temp.sqlite_master WHERE type='trigger' AND name LIKE 'learning_fence_%'").all().map(r => String(r.name)));
    expect(LEARNING_FENCE_TRIGGERS.every(n => names.has(n))).toBe(true);
  });
});

// Retry-journal design 24/25: the real gate owns release and rollback; the charge is independently durable.
describe("durable preSend and pre-release refund",()=>{
  function paidGate(options:{check?:()=>void;onAdmit?:()=>void;preFail?:boolean;refundFail?:boolean}={}){
    const db=database();db.exec("CREATE TABLE IF NOT EXISTS retry_paid_fixture(n INTEGER); INSERT INTO retry_paid_fixture VALUES(0)");
    const other=new DatabaseSync(join(DATA_DIR,"messages.db"));
    const paid=()=>Number(other.prepare("SELECT n FROM retry_paid_fixture").get()!.n);
    const gate=learningGate("continuity",sampleLearningFence(),{}, {
      checks:options.check?[options.check]:[],onAdmit:options.onAdmit,
      preSend:()=>{
        if(options.preFail)throw new Error("charge fixture");
        transaction(db=>db.exec("UPDATE retry_paid_fixture SET n=n+1"));
        expect(paid()).toBe(1);
        return ()=>{if(options.refundFail)throw new Error("refund fixture");transaction(db=>db.exec("UPDATE retry_paid_fixture SET n=n-1"));};
      },
    });
    return {gate,other,paid};
  }
  it.each(["check","held","busy","onAdmit"])("25: %s refusal refunds after rollback",mode=>{
    const r=paidGate({check:mode==="check"||mode==="held"?()=>{throw new Error("moved");}:undefined,onAdmit:mode==="onAdmit"?()=>{throw new Error("moved");}:undefined});
    const db=database(),exec=db.exec.bind(db);
    let busyInjected=false;
    if(mode==="busy")vi.spyOn(db,"exec").mockImplementation(sql=>{if(!busyInjected&&sql==="BEGIN IMMEDIATE"&&r.paid()===1){busyInjected=true;throw Object.assign(new Error("database is locked"),{code:"SQLITE_BUSY"});}return exec(sql);});
    try{const emit=vi.fn();expect(()=>r.gate.send(emit)).toThrow();expect(emit).not.toHaveBeenCalled();expect(r.paid()).toBe(0);expect(db.isTransaction).toBe(false);}
    finally{r.other.close();}
  });
  it("25: repeated moved reads never consume calls",()=>{
    const r=paidGate({check:()=>{throw new Error("moved");}});
    try{for(let i=0;i<10;i++){expect(()=>r.gate.send(()=>{})).toThrow();expect(r.paid()).toBe(0);}}finally{r.other.close();}
  });
  it("25: a failed charge refunds nothing, and a failed refund leaves its charge",()=>{
    const a=paidGate({preFail:true});try{expect(()=>a.gate.send(()=>{})).toThrow("charge fixture");expect(a.paid()).toBe(0);}finally{a.other.close();}
    database().exec("DROP TABLE retry_paid_fixture");
    const b=paidGate({refundFail:true,check:()=>{throw new Error("moved");}});try{expect(()=>b.gate.send(()=>{})).toThrow();expect(b.paid()).toBe(1);}finally{b.other.close();}
  });
  it.each(["spawn-throws","commit-throws","after-commit"])("24, 25: %s keeps the committed charge once released",mode=>{
    const r=paidGate(),db=database(),exec=db.exec.bind(db);let released=false;
    if(mode==="commit-throws")vi.spyOn(db,"exec").mockImplementation(sql=>{if(sql==="COMMIT"&&released)throw new Error("commit fixture");return exec(sql);});
    const emit=()=>{released=true;expect(r.paid()).toBe(1);if(mode==="spawn-throws")throw new Error("spawn fixture");};
    try{if(mode==="after-commit")r.gate.send(emit);else expect(()=>r.gate.send(emit)).toThrow();expect(r.paid()).toBe(1);expect(r.gate.released).toBe(1);}finally{r.other.close();}
  });
});
