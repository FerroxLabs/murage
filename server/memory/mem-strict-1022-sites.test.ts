// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 mem-strict r3 (FABLE b81b38de77 H1): the grounding/extraction leg of the 554x row ('learning call dropped before send:
// reason=memory-changed'), one row per learningGate site that holds refs, each driven through its production entry: the memory agent
// route (propose-correction -> routes.ts grounding; save of character canon -> authority.ts saveGroundedMemoryBase grounding) and the
// consolidation of a captured source (consolidate.ts extraction gate). The engine stub makes the change inside its own call, after the
// gate was sampled and before it releases its one physical write through the gate (as every driver does), so the gate judges it.
// An unrelated change (a tombstone, a real Forget, another connection's commit) never drops the call; a change to a held row or a
// withdrawal still does. Synthetic fixture text only; no process and no network.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { WORKSPACE_OWNER } from "../human-principals.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { appendMessage } from "../message-db.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { fixtureMemoryAccess as memoryAccess } from "../testing/recall-access-fixture.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { captureSource } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource } from "./consolidate.ts";
import type { TextOnlyExtractor } from "./extract.ts";
import { forgetMemory } from "./forget.ts";
import { drainRevokeMarker, INLINE_REVOCATION, memoryRevocationIdle, memoryRevocationStats, resetMemoryRevocationStats, stopMemoryRevocation, wakeMemoryRevocation } from "./memory-revocation.ts";
import { resetRevokeWriteBudget, REVOKE_PACE_COMMIT } from "./revoke-budget.ts";
import { writeBotIdentity } from "./identity.ts";
import { claimMemoryJob, publishMemoryWork, resetMemoryClaimCursor } from "./jobs.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { captureBotReveals } from "./reveal-capture.ts";
import { memoryAgentRoute } from "./routes.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetMemoryClaimCursor(); });
afterEach(() => { runnerFault = undefined; stopMemoryRevocation(); setMemoryCaptureRoster(null); vi.restoreAllMocks(); closeDatabase(); });
// the route's durable record of an owner-visible change (outside-store.ts), registered after the database reset as the fixture asks
useOutsideStoreFixture();

const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] as never[] };
const drain = () => { for (let job = claimMemoryJob("fixture"); job; job = claimMemoryJob("fixture")) publishMemoryWork(job, "fixture", captureWork(job)); };
function routeFixture() {
  setMemoryCaptureRoster(() => roster as never); reconcileMemoryRoster(roster); setMemoryMode("capture");
  appendMessage("thread", { id: "m", at: 1, role: "user", origin: "desktop", kind: "text", text: "Verified source note" } as never);
  const work = claimMemoryJob("fixture")!; publishMemoryWork(work, "fixture", captureWork(work));
  setMemoryMode("active");
  const recordId = String(database().prepare("SELECT id FROM memory_records").get()!.id);
  const registry = new InternalCapabilities(); registry.begin("bot", "thread", "generation");
  const token = registry.mint({ botId: "bot", threadId: "thread", generation: "generation", depth: 99, kind: "memory", skillAuthoring: false });
  const context = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster as never);
  return { context, recordId, bridge: { search: async () => ({ hits: [], vectorRows: 0 }) } };
}

/** One production entry per gate site: `go` runs it with the engine stub; `held` is a source the call's gate holds, `heldRecord` a
 *  record it holds; `target` is the call that site gates; `at: "ground"` makes the change inside the grounding call (after the
 *  extraction call of the same job was sent), `extracted` is the extraction reply. */
interface Site { name: string; held: string; heldRecord?: string; target: "extract" | "ground"; at?: "ground"; extracted?: string; go: (extractor: TextOnlyExtractor) => Promise<unknown> }
const SITES: Array<() => Site> = [
  () => {
    const f = routeFixture(), text = "Correction: the source note is now confirmed.";
    captureSource(database(), { id: "correction-source", threadId: "thread", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text } as never); drain();
    return { name: "routes.ts propose-correction grounding (memoryAgentRoute)", held: "correction-source", target: "ground", go: extractor => memoryAgentRoute("/api/internal/memory/propose-correction",
      { id: f.recordId, version: 1, replacement: text, evidence: [{ sourceId: "correction-source", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], idempotencyKey: "same-subject" }, f.context, f.bridge, undefined, extractor) };
  },
  () => {
    const f = routeFixture(), text = "In this fictional character, I grew up beside a lighthouse.", invitation = "Please invent a fictional childhood for your character.";
    captureSource(database(), { id: "canon-source", occurredAt: 2, threadId: "thread", kind: "text", speaker: "assistant", outcome: "recorded", text } as never);
    captureSource(database(), { id: "invitation", occurredAt: 1, threadId: "thread", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: invitation } as never); drain();
    return { name: "authority.ts save grounding (memoryAgentRoute /save, character canon)", held: "canon-source", target: "ground", go: extractor => memoryAgentRoute("/api/internal/memory/save",
      { text, evidence: [{ sourceId: "canon-source", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], ownerInvitation: { sourceId: "invitation", revision: 1, startByte: 0, endByte: Buffer.byteLength(invitation) }, claimType: "character-canon", idempotencyKey: "canon" },
      f.context, f.bridge, undefined, extractor) };
  },
  () => {
    reconcileMemoryRoster(roster as never); setMemoryMode("capture");
    const text = "I prefer green tea in the morning.";
    storeAnchorMessage(database(), "thread", "m-src", text);
    captureSource(database(), { id: "src", threadId: "thread", messageId: "m-src", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text } as never);
    const work = claimMemoryJob("w")!; publishMemoryWork(work, "w", captureWork(work));
    return { name: "consolidate.ts extraction (consolidateMemorySource)", held: "src", target: "extract", go: extractor => consolidateMemorySource(work.id, extractor, new AbortController().signal) };
  },
  () => {
    reconcileMemoryRoster(roster as never); setMemoryMode("capture");
    const text = "Correction: I now prefer short answers.";
    storeAnchorMessage(database(), "thread", "m-fix", text);
    captureSource(database(), { id: "fix-src", threadId: "thread", messageId: "m-fix", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text } as never);
    const work = claimMemoryJob("w")!; publishMemoryWork(work, "w", captureWork(work));
    const scope = String(database().prepare("SELECT scope_id FROM memory_sources WHERE id='fix-src'").get()!.scope_id);
    database().exec("PRAGMA foreign_keys=OFF");
    database().prepare("INSERT INTO memory_records VALUES('prior',1,?,'fact','I prefer long answers.','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
    database().prepare("INSERT OR REPLACE INTO memory_record_details(record_id,record_version,partition,attention,claim_status,observed_at,entities) VALUES('prior',1,'semantic','useful','current',NULL,?)").run(JSON.stringify(["owner", "answer-length"]));
    database().exec("PRAGMA foreign_keys=ON");
    const extracted = JSON.stringify([{ text, quote: text, claimType: "owner-statement", subject: "owner", predicate: "answer-length", update: true, startByte: 0, endByte: Buffer.byteLength(text) }]);
    return { name: "consolidate.ts correction grounding (consolidateMemorySource, same-subject update)", held: "fix-src", heldRecord: "prior", target: "ground", at: "ground", extracted,
      go: extractor => consolidateMemorySource(work.id, extractor, new AbortController().signal) };
  },
  // r5 (ASTRA ef63a67ecc consolidate.ts:539): the support grounding of a new claim whose text is not its quote (no prior record)
  () => {
    reconcileMemoryRoster(roster as never); setMemoryMode("capture");
    const quote = "I prefer short answers.";
    storeAnchorMessage(database(), "thread", "m-claim", quote);
    captureSource(database(), { id: "claim-src", threadId: "thread", messageId: "m-claim", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: quote } as never);
    const work = claimMemoryJob("w")!; publishMemoryWork(work, "w", captureWork(work));
    const extracted = JSON.stringify([{ text: "The owner prefers short answers.", quote, claimType: "owner-statement", subject: "owner", predicate: "answer-length", startByte: 0, endByte: Buffer.byteLength(quote) }]);
    return { name: "consolidate.ts support grounding (consolidateMemorySource, text differs from quote)", held: "claim-src", target: "ground", at: "ground", extracted,
      go: extractor => consolidateMemorySource(work.id, extractor, new AbortController().signal) };
  },
  () => {
    reconcileMemoryRoster(roster as never);
    const canon = "The character once tended a fictional lighthouse.";
    const fact = writeBotIdentity(ownerMemoryTicket(), { action: "identity-write", botId: "bot", kind: "character-canon", key: "lighthouse", expectedVersion: 0, text: canon, basis: "fiction", audience: "owner-private" } as never, roster as never);
    appendMessage("thread", { id: "reply", at: 1, role: "bot", kind: "text", text: "In my fictional past, I looked after a beacon by the sea.", turnId: "turn", turnTerminal: true } as never);
    drain();
    const job = String(database().prepare("SELECT id FROM memory_jobs WHERE source_id='message:thread:reply'").get()!.id);
    return { name: "reveal-capture.ts reveal grounding (captureBotReveals)", held: "message:thread:reply", heldRecord: String(fact.id), target: "ground",
      go: extractor => captureBotReveals(job, () => roster as never, extractor, new AbortController().signal) };
  },
];

/** The engine: makes `change` once inside its call, then releases its one write through the call's gate; `sent` holds what left. */
function engine(change: () => void | Promise<void>, site: Site) {
  const sent: string[] = [];
  let fired = false;
  const once = async () => { if (!fired) { fired = true; await change(); } };
  const extractor = (async (_text, _max, _signal, dispatch) => {
    if (site.at !== "ground") await once();
    if (!dispatch?.fence) throw new Error("no gate");
    return dispatch.fence.send(() => { sent.push("extract"); return site.extracted ?? "[]"; });
  }) as TextOnlyExtractor;
  extractor.ground = async (_input, _max, _signal, fence) => {
    await once();
    if (!fence) throw new Error("no gate");
    return fence.send(() => { sent.push("ground"); return '{"supported":true}'; });
  };
  return { extractor, sent, fired: () => fired };
}
async function across(site: Site, change: () => void | Promise<void>) {
  const { extractor, sent, fired } = engine(change, site);
  const lines: string[] = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => { lines.push(String(line)); });
  const error = await site.go(extractor).then(() => undefined, (e: unknown) => String(e));
  return { sent, fired: fired(), error, dropped: lines.filter(line => line.startsWith("[memory] learning call dropped before send")) };
}
const otherConnection = (sql: string) => { const db = new DatabaseSync(join(DATA_DIR, "messages.db")); try { db.exec(sql); } finally { db.close(); } };
function unrelatedRecord(): string {
  const id = randomUUID(), scope = ensureScope("preferences", "person:" + WORKSPACE_OWNER);
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','zq unrelated note','owner-statement','active',0,?,NULL,NULL,?)").run(id, scope, Date.now(), Date.now());
  return id;
}
/** A real Forget whose inline revocation slice has no time left (memory-revocation.ts startRevocationJob): its commit writes the job row. */
function forgetOverBudget(id: string) {
  const ms = INLINE_REVOCATION.ms;
  INLINE_REVOCATION.ms = 0;
  try { forgetMemory(ownerMemoryTicket(), { kind: "record", id }); } finally { INLINE_REVOCATION.ms = ms; }
  if (!database().prepare("SELECT 1 FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation'").get()) throw new Error("fixture: no revocation job row");
}
/** r6: the PRODUCTION runner (wakeMemoryRevocation's tick, memory-revocation.ts stepJobRow) runs every job row to its end. 100 Pip stances
 * of another bot's scope (the pip phase spends one row per stance, a slice gets at most 64) make the job outlast one slice, as a loaded machine's
 * jobs do, so the runner rewrites the row in place (stepJobRow's UPDATE) before its last slice removes it; the fixture fails unless it did. */
const STANCES = 100;
function seedOtherStances() {
  const insert = database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','pip-stance',1,'granted','{}')"), scope = ensureScope("bot", "zq-other");
  for (let i = 0; i < STANCES; i++) insert.run(`pip-stance:zq-other-${String(i).padStart(3, "0")}`, scope);
}
/** r7: a fixture fault inside the engine's await would read as "nothing sent"; it is kept here and asserted on its own, ahead of the outcome. */
let runnerFault: string | undefined;
async function runnerFinishesInSlices() {
  // the write pace (revoke-budget.ts, a per-minute ledger kept across tests in this file) starts empty, so the runner is never held a minute;
  // its per-commit row cap (REVOKE_PACE_COMMIT, "tests may change it") is 16 input rows, so every job step of a Forget (each phase spends one
  // row or more) takes several slices, as on a loaded machine, and the runner rewrites the row in place between them on every run
  resetMemoryRevocationStats(); resetRevokeWriteBudget();
  const cap = REVOKE_PACE_COMMIT.rows;
  REVOKE_PACE_COMMIT.rows = 16;
  try { wakeMemoryRevocation(() => database(), { pauseMs: 0, busyPauseMs: 0, retryMs: 1 }); await memoryRevocationIdle(); }
  finally { stopMemoryRevocation(); REVOKE_PACE_COMMIT.rows = cap; }
  const left = !!database().prepare("SELECT 1 FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation'").get();
  if (left || !(memoryRevocationStats.maxJobBytes > 0)) runnerFault = `fixture: ${left ? "job row left" : "the runner never rewrote the job row in place"} ${JSON.stringify(memoryRevocationStats)}`;
}
const tombstone = (kind: "record" | "source", id: string) => database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES(?, ?, ?, NULL, NULL, 0, 'test', 0)").run(randomUUID(), kind, id);

const UNRELATED: Array<[string, (other: string) => void | Promise<void>]> = [
  ["an unrelated record is tombstoned", other => { tombstone("record", other); }],
  // r5: drained before the send (independent of the 8 ms inline revocation budget); see the over-budget row below
  ["an unrelated record is Forgotten (forgetMemory)", other => { forgetMemory(ownerMemoryTicket(), { kind: "record", id: other }); drainRevokeMarker(database()); }],
  // r5: the Forget's inline revocation budget (INLINE_REVOCATION, 8 ms) runs out, as it does on a loaded machine, so its commit writes the
  // job row (memory_scope_bindings subject memory-revocation); the runner then finishes the job and removes the row. Neither is a withdrawal.
  ["an unrelated record is Forgotten over the inline budget and the runner finishes its job (the job row is written, then removed)", other => { forgetOverBudget(other); drainRevokeMarker(database()); }],
  // r6 (OPUS cb88b8fe82 H2): the runner finishes the job in bounded slices, so it rewrites the row in place (stepJobRow UPDATE) first
  ["an unrelated record is Forgotten over the inline budget and the runner finishes its job in bounded slices (the row is rewritten in place)", async other => { seedOtherStances(); forgetOverBudget(other); await runnerFinishesInSlices(); }],
  ["another connection commits an unrelated write (PRAGMA data_version moves)", () => otherConnection("CREATE TABLE IF NOT EXISTS zq_unrelated(x); INSERT INTO zq_unrelated VALUES(1)")],
];
const KEEP: Array<[string, (site: Site) => void]> = [
  ["the held source is tombstoned", site => { tombstone("source", site.held); }],
  ["another connection pauses memory (a withdrawal)", () => otherConnection("UPDATE memory_meta SET mode='paused' WHERE id=1")],
  ["the held record is tombstoned", site => { tombstone("record", site.heldRecord!); }],
  // r5: fail closed while an unrelated Forget's revocation is still pending (held rows read "checking" until the marker resolves it)
  ["an unrelated record is Forgotten over the inline budget and its revocation is still pending (held rows read checking)", () => { forgetOverBudget(unrelatedRecord()); }],
];
// the held-record row runs only where the gate holds a record (sites 3 and 5)
const holdsRecord = (i: number, change: string) => change !== KEEP[2]![0] || i === 3 || i === 5;

describe("learning gate sites with held refs: an unrelated memory change never drops the call (554x reason=memory-changed)", () => {
  const rows = SITES.flatMap((_site, i) => UNRELATED.map(([change, apply]) => [i, change, apply] as const));
  it.each(rows)("site %i: %s: the call is sent, nothing is logged as dropped", async (i, _change, apply) => {
    const site = SITES[i]!();
    const other = unrelatedRecord();
    const { sent, fired, error, dropped } = await across(site, () => apply(other));
    expect(runnerFault).toBeUndefined();
    // the send leg only: after a Forget the commit is still refused by the install-wide deletion fence (MEMORY_CONTEXT_REVOKED /
    // MEMORY_CONSOLIDATION_REVOKED, policy.ts), the lane's open FABLE-DESIGN item Q1, never a dropped send
    expect({ site: site.name, fired, sent: sent.includes(site.target), dropped, ...(fired ? {} : { error }) }).toEqual({ site: site.name, fired: true, sent: true, dropped: [] });
  });
  const keeps = SITES.flatMap((_site, i) => KEEP.filter(([change]) => holdsRecord(i, change)).map(([change, apply]) => [i, change, apply] as const));
  it.each(keeps)("KEEP site %i: %s: the gated call is not sent", async (i, _change, apply) => {
    const site = SITES[i]!();
    const { sent, fired, error } = await across(site, () => apply(site));
    expect({ site: site.name, fired, sent: sent.filter(call => call === site.target), ...(fired ? {} : { error }) }).toEqual({ site: site.name, fired: true, sent: [] });
  });
});
