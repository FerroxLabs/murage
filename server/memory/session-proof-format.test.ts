// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: the trainred-b5 line owns the durable proof format and the change-log continuity checks (session-proof.ts,
// session-proof-schema.ts; DESIGN-B5-PROOF F1/F2; built on fix/1019-trainred-b5-proof); recall-s1s2g owns the proof consumers.
// MAIN 07:44Z Q4 binds F2. Two witness sets: "F1/F2 W*" prove sessions through production receipts, "W*" through the proof fixture.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import * as policy from "./policy.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { fixtureMemoryAccess as memoryAccess } from "../testing/recall-access-fixture.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { proveRetainedSession, sessionProofMeter } from "./session-proof.ts";
import { sessionKeyOf } from "./session-incarnation.ts";
import { stopRecallViewMaintenance } from "./recall-view.ts";
import { startLiveSession, storeLiveAnchor } from "./testing/live-session-fixture.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";
import { bumpDenyGeneration } from "./revoke-marker.ts";
import { denyGeneration } from "./deny-read.ts";
import { proofModule, setupProofFixture, receipts } from "./session-proof-fixture.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { sessionProofSchemaObjects } from "./session-proof-schema.ts";

beforeEach(async () => {
  closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); stopRecallViewMaintenance(); closeDatabase(); });
const empty = { search: async () => ({ hits: [], vectorRows: 0 }) };

/** Reader "a" holds a session whose one receipt cites a record in its own scope resting on evidence in the peer scope. */
async function provenSession() {
  const roster: MemoryRoster = { bots: ["a", "b", "c", "peer"].map(id => ({ id, threadId: `t-${id}`, section: "team" })), groups: [] };
  reconcileMemoryRoster(roster);
  const db = database(), fixture = new WritetimeFixture(db);
  const peer = ensureScope("bot", "peer"), own = ensureScope("bot", "a"), unrelated = ensureScope("bot", "c");
  db.prepare("INSERT INTO memory_scope_bindings VALUES('peer-grant',?,'bot','a',0,'granted','{}')").run(peer);
  storeLiveAnchor(db, "t-peer", "peer-message", "words");
  fixture.source("peer-source", peer, { thread: "t-peer", message: "peer-message" });
  fixture.record("evidence-record", 1, own, ["peer-source"], { assertion: "owner-statement" });
  // Mint after every scope and grant exists, so the access is issued over its settled view.
  const registry = new InternalCapabilities();
  const generation = registry.begin("a", "t-a");
  const token = registry.mint({ botId: "a", threadId: "t-a", generation, kind: "memory", depth: 100, skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const session = "format-session", key = sessionKeyOf("t-a", "claude", session);
  let started = false;
  const turn = async (cite: boolean) => {
    const confirmation = started ? undefined : startLiveSession(access, "claude", session);
    const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("held", access, empty, { allowance: LineageAllowance.tool() }), access, "claude");
    if (cite) receipt.noteLookup([{ id: "evidence-record", version: 1, evidence: [] }], access);
    if (started) receipt.resumes(session);
    receipt.sessionStarted(session, !started, confirmation);
    receipt.accepted();
    started = true;
  };
  await turn(true);
  const prove = () => proveRetainedSession(LineageAllowance.tool(), key, { access, disclosed: true });
  const check = () => db.prepare("SELECT footprint,log_seq FROM memory_session_checks WHERE thread_id='t-a' AND driver_instance='claude' AND native_session=?").get(session) as { footprint: string; log_seq: number } | undefined;
  expect(prove()).toEqual({ kind: "resume" });
  expect(check()?.footprint).toContain(`"~${peer}"`);
  const denyScope = (scope: string) => db.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('scope',?,0,0)").run(scope);
  const moveDenyGeneration = () => db.prepare("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
  const denyGeneration = () => Number(db.prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='deny_generation'").get()!.value);
  const epoch = () => Number(db.prepare("SELECT epoch FROM memory_recall_epoch WHERE id=1").get()?.epoch);
  return { db, access, peer, own, unrelated, prove, check, turn, denyScope, moveDenyGeneration, denyGeneration, epoch };
}

it("F1 W1: a durable proof written before evidence-scope footprints is no checkpoint, so a later deny of that evidence scope refuses", async () => {
  const s = await provenSession();
  // The persisted row as a pre-envelope build wrote it: the own scope only, no evidence-scope entry.
  s.db.prepare("UPDATE memory_session_checks SET footprint=?").run(JSON.stringify([s.own]));
  const epoch = s.epoch(), digest = s.access.view.digest;
  s.denyScope(s.peer);
  // The deny moves neither the recall epoch nor the view, so only the footprint could notice it.
  expect(s.epoch()).toBe(epoch);
  expect(s.access.view.digest).toBe(digest);
  expect(s.prove()).toMatchObject({ kind: "fresh" });
});

it("F1 W1b: a proof written after the fix round-trips: with no change it resumes on the incremental path", async () => {
  const s = await provenSession();
  await s.turn(false);
  expect(s.prove()).toEqual({ kind: "resume" });
  expect(sessionProofMeter().path).toBe("incremental");
});

it("F2 W2a: change-log rows lost after the checkpoint refuse as a gap", async () => {
  const s = await provenSession();
  const at = s.check()!.log_seq;
  s.denyScope(s.peer);
  s.db.prepare("DELETE FROM memory_session_change_log WHERE seq>?").run(at);
  expect(s.prove()).toMatchObject({ kind: "fresh", reason: "change-log-gap" });
});

it("F2 W2b: losing only the newest change-log row still refuses", async () => {
  const s = await provenSession();
  s.denyScope(s.unrelated);
  s.denyScope(s.peer);
  s.db.prepare("DELETE FROM memory_session_change_log WHERE seq=(SELECT max(seq) FROM memory_session_change_log)").run();
  expect(s.prove()).toMatchObject({ kind: "fresh" });
});

it("F2 W2c: a deny generation the change log cannot prove refuses (MAIN Q4)", async () => {
  const s = await provenSession();
  // A file from a build without the deny-generation trigger.
  s.db.exec("DROP TRIGGER IF EXISTS memory_session_proof_deny_generation");
  s.moveDenyGeneration();
  expect(s.prove()).toMatchObject({ kind: "fresh", reason: "deny-generation-unproven" });
});

it("F2 W2d: an unrelated revoke elsewhere keeps the session and the next proof records the new deny generation", async () => {
  const s = await provenSession();
  s.denyScope(s.unrelated);
  s.moveDenyGeneration();
  expect(s.prove()).toEqual({ kind: "resume" });
  await s.turn(false);
  expect(s.prove()).toEqual({ kind: "resume" });
  expect(JSON.parse(s.check()!.footprint).dg).toBe(s.denyGeneration());
});

it("F1 W1c: the production scope revoke of the evidence scope refuses a session whose durable proof is pre-envelope", async () => {
  const s = await provenSession();
  s.db.prepare("UPDATE memory_session_checks SET footprint=?").run(JSON.stringify([s.own]));
  const epoch = s.epoch(), digest = s.access.view.digest;
  commitRevoke(s.db, { kind: "scope", scopeId: s.peer, cause: "scope-deny" });
  expect(s.db.prepare("SELECT 1 FROM memory_deny WHERE kind='scope' AND id=?").get(s.peer)).toBeDefined();
  expect(s.epoch()).toBe(epoch);
  expect(s.access.view.digest).toBe(digest);
  expect(s.prove()).toMatchObject({ kind: "fresh" });
});

/** WritetimeFixture seeds its scopes with a '{}' audience; every production writer stores '[]'. A reopen validates the shape, so give the
 * fixture's rows the shape a real file has: the reopen witnesses then differ from a real pre-release file only in the proof objects. */
const fileShapedScopes = (db: ReturnType<typeof database>) => db.exec("UPDATE memory_scopes SET audience='[]' WHERE audience='{}'");

it("F1 W5: a pre-F1 1.0.19 file (proof tables without the deny-generation trigger, a pre-envelope check) reopens, gets the trigger and re-proves", async () => {
  const s = await provenSession();
  // Durable state as a pre-release 1.0.19 build left it: every proof object but the deny-generation trigger, and a v1 footprint.
  s.db.exec("DROP TRIGGER memory_session_proof_deny_generation");
  s.db.prepare("UPDATE memory_session_checks SET footprint=?").run(JSON.stringify([s.own]));
  fileShapedScopes(s.db);
  closeDatabase();
  const db = database();
  const trigger = "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='memory_session_proof_deny_generation'";
  expect(db.prepare(trigger).get()?.sql).toBe(sessionProofSchemaObjects().get("memory_session_proof_deny_generation")!.sql);
  bumpDenyGeneration(db);
  expect(String(db.prepare("SELECT id FROM memory_session_change_log ORDER BY seq DESC LIMIT 1").get()!.id)).toBe(`deny-gen:${denyGeneration(db)}`);
  commitRevoke(db, { kind: "scope", scopeId: s.peer, cause: "scope-deny" });
  expect(s.prove()).toMatchObject({ kind: "fresh" });
});

it("F1 W5b: the reopen tolerance is only the deny-generation trigger: a file missing another proof trigger still refuses", async () => {
  await provenSession();
  fileShapedScopes(database());
  database().exec("DROP TRIGGER memory_session_proof_record");
  closeDatabase();
  expect(() => database()).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
});

/** An owner reader whose one receipt cites a record in a readable scope A that rests on evidence in another scope B: proved, checkpointed. */
async function proven() {
 const f=setupProofFixture('direct'),db=database(),p=await proofModule();
 const a=policy.ensureScope('room','room'),b=policy.ensureScope('bot','helper');
 // the reader holds B too (a grant); B is only the evidence behind A's record, never cited itself
 db.prepare("INSERT INTO memory_scope_bindings VALUES('format-grant',?,'bot','reader',0,'granted','{}')").run(b);
 new WritetimeFixture(db).source('format-source',b).record('format-record',1,a,['format-source'],{assertion:'owner-statement'});
 f.access=f.issue();
 await receipts(f,1);
 db.prepare('UPDATE memory_disclosures SET record_versions=? WHERE thread_id=?').run(JSON.stringify([{id:'format-record',version:1}]),f.key.threadId);
 const prove=()=>p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true});
 expect(prove()).toEqual({kind:'resume'});
 const row=()=>db.prepare('SELECT log_seq,footprint FROM memory_session_checks WHERE thread_id=? AND driver_instance=? AND native_session=?').get(f.key.threadId,f.key.driverInstance,f.key.nativeSession) as {log_seq:number;footprint:string};
 expect(row().footprint).toContain(`~${b}`);
 return {f,db,p,a,b,prove,row,fixture:new WritetimeFixture(db)};
}

it('W1: a checkpoint in the pre-envelope format is absent, so a later deny of its evidence scope is not ignored',async()=>{
 const w=await proven();
 // durable state as a build before the v2 envelope wrote it: the scopes only, no evidence scope, no deny generation
 w.db.prepare('UPDATE memory_session_checks SET footprint=?').run(JSON.stringify([w.a]));
 const epoch=w.db.prepare('SELECT epoch FROM memory_recall_epoch WHERE id=1').get()!.epoch;
 w.fixture.deny('scope',w.b);
 expect(w.db.prepare('SELECT epoch FROM memory_recall_epoch WHERE id=1').get()!.epoch).toBe(epoch);
 expect(w.prove()).toMatchObject({kind:'fresh',reason:'memory-changed (record format-record@1 MEMORY_EVIDENCE_UNAVAILABLE)'});
 expect(w.p.sessionProofFormatUpgrades()).toBeGreaterThan(0);
});

it('W1b: a v2 checkpoint round-trips: with no change it resumes on the incremental path',async()=>{
 const w=await proven();
 for(let n=0;n<3;n++) {
  expect(w.prove()).toEqual({kind:'resume'});
  expect(w.p.sessionProofMeter().path).toBe('incremental');
 }
});

it('W2a: deny rows lost from the change log refuse (change-log-gap)',async()=>{
 const w=await proven(),at=Number(w.row().log_seq);
 w.fixture.deny('scope',w.b);bumpDenyGeneration(w.db);
 w.db.prepare('DELETE FROM memory_session_change_log WHERE seq>?').run(at);
 expect(w.prove()).toMatchObject({kind:'fresh',reason:'change-log-gap'});
});

it('W2b: losing only the newest row, the deny, refuses',async()=>{
 const w=await proven();
 bumpDenyGeneration(w.db);w.fixture.deny('scope',w.b);
 expect(String(w.db.prepare('SELECT id FROM memory_session_change_log ORDER BY seq DESC LIMIT 1').get()!.id)).toBe(`deny-scope:${w.b}`);
 w.db.exec('DELETE FROM memory_session_change_log WHERE seq=(SELECT max(seq) FROM memory_session_change_log)');
 expect(w.prove()).toMatchObject({kind:'fresh',reason:'change-log-gap'});
});

it('W2c: a deny generation that moved with no logged proof refuses (deny-generation-unproven)',async()=>{
 const w=await proven();
 // a file from a build without the generation trigger
 w.db.exec('DROP TRIGGER IF EXISTS memory_session_proof_deny_generation');
 bumpDenyGeneration(w.db);
 expect(w.prove()).toMatchObject({kind:'fresh',reason:'deny-generation-unproven'});
});

it('W2d: an unrelated revoke elsewhere keeps the session, and the next written proof records the new generation',async()=>{
 const w=await proven(),before=denyGeneration(w.db);
 w.fixture.deny('scope',policy.ensureScope('bot','elsewhere')).deny('thread','elsewhere-thread');bumpDenyGeneration(w.db);
 expect(denyGeneration(w.db)).toBeGreaterThan(before);
 expect(w.prove()).toEqual({kind:'resume'});
 const later=Date.now()+60_001;vi.spyOn(Date,'now').mockReturnValue(later);
 expect(w.prove()).toEqual({kind:'resume'});
 expect(JSON.parse(w.row().footprint)).toMatchObject({v:2,dg:denyGeneration(w.db)});
});
