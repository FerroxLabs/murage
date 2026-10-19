// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 lineage-cold, r3 review: every new test here fails on 96d7ed0f2.
//
// - root capture takes the renderer's decision: a line the prompt carried in words keeps its roots when the allowance ran out after
//   it was rendered, so a reply built on it is withheld when its source goes (Astra P1-1, Fable P1-1: the exact reproduction);
// - a root read the allowance cannot pay for is never written as the permanent marker (Fable P2-1);
// - every history read is paid for BEFORE it is made: a session's expansion in the receipt listing, the evidence of a record, and a
//   structural rule that a reader on the turn path spends what it is given (Astra P1-2);
// - a receipt group appended to thousands of times is read from `judgedUpTo` without walking the chunks before it (Astra P1-3).
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { afterEach as thawAfterEach, beforeEach as thawBeforeEach } from "vitest";
import { thawRootSetWritesForTest } from "./memory/replay-lineage.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
// 1.0.2: this test models a 1.0.1 file (legacy root-set rows) for the read-time judge, which still decides legacy data until S6.
thawBeforeEach(() => thawRootSetWritesForTest(true));
thawAfterEach(() => thawRootSetWritesForTest(false));
import { DATA_DIR, ensureDirs } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { saveMemoryCandidate } from "./memory/authority.ts";
import { buildMemoryBundle } from "./memory/bundle.ts";
import { captureBranchChange, captureSource } from "./memory/capture.ts";
import { MemoryDispatchReceipt } from "./memory/dispatch.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { readableMemoryRecord } from "./memory/readable.ts";
import {
  BundleList, capturedMessageVerdict, capturedMessageWithheld, foreignLineageWrite, forgetKeptLineageForTest, keptVerdictCount, prepareLineageCache, recordOutputRoots,
  replayChunkVisits, replayExclusions, resetReplayChunkVisits, type ReplayAudience,
} from "./memory/replay-lineage.ts";
import { collectRootSets } from "./memory/root-set-compaction.ts";
import { continuationMemoryRevoked, resetSessionHolds } from "./memory/disclosures.ts";
import { setLineageTimeBudgetForTest } from "./memory/lineage-allowance.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { bumpLineageWarm, guaranteeLineageWarmSlice, lineageWarmStep, onLineageThreadWarmed, resetLineageWarmForTest } from "./memory/lineage-warm.ts";
import { chainStore } from "./memory/schema.ts";
import { shownLinesRoots } from "./steer-lineage.ts";
import { stampFreshSession } from "./memory/testing/writetime-fixture.ts";
import { storeAnchorMessage } from "./memory/testing/anchor-message.ts";

const here = dirname(fileURLToPath(import.meta.url));
const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
const registry = new InternalCapabilities();
const empty = { async search() { return { hits: [], vectorRows: 0, coverageComplete: false }; } };
const big = () => LineageAllowance.tool(1_000_000_000);

function access() {
  registry.begin("bot", "chat", "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}

beforeEach(() => {
  closeDatabase();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  ensureDirs();
  setMemoryMode("active");
  reconcileMemoryRoster(roster);
});

/** reply-1 (thread "chat") made under a receipt whose record rests on thread "older"'s message m1: "secret from doc". */
async function replyFromDoc(): Promise<void> {
  const text = "secret from doc";
  storeAnchorMessage(database(), "older", "m1", text); captureSource(database(), { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  const turn = access();
  const record = saveMemoryCandidate(text, [{ sourceId: "message:older:m1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", turn);
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty, { allowance: LineageAllowance.tool() }), turn, "engine");
  receipt.sessionStarted("s1");
  receipt.noteLookup([{ id: record, version: 1, evidence: [{ sourceId: "message:older:m1", revision: 1 }] }], turn);
  receipt.accepted();
  receipt.output("reply-1");
  expect(capturedMessageWithheld(big(), "chat", "reply-1")).toBe(false);
}

it("P1-1 reproduction: the replay shows reply-1 in words and spends the allowance; the reply built on it is recorded with reply-1's roots and is withheld once the doc goes", async () => {
  await replyFromDoc();
  forgetKeptLineageForTest();
  const turn = LineageAllowance.turn();
  // the render: the replay check allows reply-1, so its words are in the prompt
  const excluded = replayExclusions(turn, "chat", [{ id: "reply-1", role: "bot" }], null, { failClosed: true });
  expect(excluded.has("reply-1"), "rendered in words").toBe(false);
  // the rest of preparation spends what is left (recall, continuation, working context)
  turn.spendNodes("chat", turn.room());
  expect(turn.spentOut()).toBe(true);
  // the roots step: a recheck now could only answer "unproven"; the renderer's decision is what counts
  const roots = shownLinesRoots(turn, [{ threadId: "chat", id: "reply-1", role: "bot" }], { threadId: "chat", ids: excluded });
  expect(roots.over || roots.roots.size > 0, "text already in the prompt is never recorded as having no roots").toBe(true);
  recordOutputRoots("chat", "reply-2", roots);
  expect(database().prepare("SELECT set_id FROM memory_output_roots WHERE thread_id='chat' AND message_id='reply-2'").get(), "reply-2 has a roots row").toBeTruthy();
  // the doc goes; kept verdicts are dropped, as after a restart
  captureBranchChange(database(), "older", null);
  forgetKeptLineageForTest();
  expect(capturedMessageWithheld(big(), "chat", "reply-1"), "the original reply").toBe(true);
  expect(capturedMessageWithheld(big(), "chat", "reply-2"), "the reply derived from its words").toBe(true);
});

it("P1-1: a line the renderer showed as its withheld line brings no roots, and the same line shown in words does, whatever a recheck says", async () => {
  await replyFromDoc();
  const closed = LineageAllowance.turn();
  closed.close();
  const line = { threadId: "chat", id: "reply-1", role: "bot" };
  expect(shownLinesRoots(closed, [line], { threadId: "chat", ids: new Set(["reply-1"]) }).roots.size).toBe(0);
  const inWords = shownLinesRoots(closed, [line], { threadId: "chat", ids: new Set() });
  expect([...inWords.roots]).toContain("chat\u0000reply-1");
  // a working-context quote was judged on its own and shown in words: a replay that withheld the same id does not take it away
  const quoted = shownLinesRoots(closed, [{ ...line, quoted: true }], { threadId: "chat", ids: new Set(["reply-1"]) });
  expect([...quoted.roots]).toContain("chat\u0000reply-1");
});

it("P2-1: a shown line whose stored root chain the allowance cannot read is kept as the line itself, never the permanent marker, and the reply's verdict follows the line's", () => {
  const thread = "chat";
  const db = database(), scope = ensureScope("conversation", thread), write = chainStore(db);
  db.exec("BEGIN");
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:bot','settled',NULL,'active')").run(`message:${thread}:r0`, scope, thread, "r0");
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(thread, "r0", 0, "bot", "text", "reply", "{}");
  let parent: string | null = null;
  for (let index = 0; index < 12_000; index++) parent = write(parent, index, [`${thread}\u0000x${index}`]);
  db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run(thread, "r0", parent);
  db.exec("COMMIT");
  closeDatabase(); forgetKeptLineageForTest(); database();
  const one = LineageAllowance.turn(1);
  const roots = shownLinesRoots(one, [{ threadId: thread, id: "r0", role: "bot" }]);
  expect(roots.over, "not the permanent marker").toBe(false);
  expect([...roots.roots]).toContain(`${thread}\u0000r0`);
  recordOutputRoots(thread, "r1", roots);
  const row = database().prepare("SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id='r1'").get(thread);
  expect(row, "r1 has a roots row").toBeTruthy();
  expect(String(row!.set_id), "and it is a set, not ''").not.toBe("");
  forgetKeptLineageForTest();
  expect(capturedMessageWithheld(big(), thread, "r1")).toBe(capturedMessageWithheld(big(), thread, "r0"));
}, 120_000);

// ---- P1-2: paid before it is read ------------------------------------------------------------------------------------------------------------

const tally = { sql: [] as string[], expanded: 0 };
const realPrepare = DatabaseSync.prototype.prepare;
beforeAll(() => {
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = realPrepare.call(this, sql);
    const own = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    const get = statement.get.bind(statement), all = statement.all.bind(statement);
    own.get = (...args) => { tally.sql.push(sql); return (get as (...a: unknown[]) => unknown)(...args); };
    own.all = (...args) => {
      tally.sql.push(sql);
      const rows = (all as (...a: unknown[]) => Array<Record<string, unknown>>)(...args);
      // receipt ids a listing expanded into its groups
      for (const row of rows) if (typeof row?.bundles === "string") tally.expanded += (JSON.parse(row.bundles) as unknown[]).length;
      return rows;
    };
    return statement;
  } as typeof realPrepare;
});
afterAll(() => { DatabaseSync.prototype.prepare = realPrepare; });

for (const receipts of [60_000, 120_000]) it(`P1-2: a reader's listing of one reply in a session of ${receipts} receipts expands none of them past what the allowance pays for (r3: all ${receipts})`, () => {
  const thread = "chat", driver = "drv", session = "sess";
  const db = database(), scope = ensureScope("conversation", thread);
  db.exec("BEGIN");
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:bot','settled',NULL,'active')").run(`message:${thread}:r0`, scope, thread, "r0");
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(thread, "r0", 0, "bot", "text", "reply", "{}");
  const add = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]','[]',?,0,0,0,'delivered',9)");
  for (let index = 0; index < receipts; index++) add.run(`rc${index}`, thread, driver, session, index === receipts - 1 ? '["r0"]' : "[]");
  db.exec("COMMIT");
  closeDatabase(); forgetKeptLineageForTest(); database();
  const audience: ReplayAudience = { policyRevision: 0, deletionEpoch: 0, revoked: () => false };
  const turn = LineageAllowance.turn();
  tally.expanded = 0;
  const withheld = replayExclusions(turn, thread, [{ id: "r0", role: "bot" }], audience, { failClosed: true });
  console.log(`SESSION-EXPANSION ${receipts}: ${tally.expanded} receipt ids expanded, ${turn.spent} nodes`);
  expect(withheld.has("r0"), "not proven within the allowance: withheld").toBe(true);
  expect(tally.expanded, "no receipt is expanded past what was paid for").toBeLessThanOrEqual(turn.spent * 16);
  expect(turn.spent).toBeLessThanOrEqual(3_000);
}, 300_000);

it("P1-2: a record's evidence is paid for before it is read: with nothing left no source is looked up, and with a little, no more than it pays for (r3: 12,000 lookups at zero)", async () => {
  const text = "x".repeat(4_000);
  storeAnchorMessage(database(), "older", "m1", text); captureSource(database(), { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  const turn = access();
  const record = saveMemoryCandidate("a fact", [{ sourceId: "message:older:m1", revision: 1, startByte: 0, endByte: 1 }], "k", turn);
  const db = database();
  db.prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  const addEvidence = db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,'message:older:m1',1,?,?)");
  db.exec("BEGIN");
  for (let at = 1; at < 3_000; at++) addEvidence.run(record, at, at + 1);
  db.exec("COMMIT");
  const lookups = () => tally.sql.filter(sql => sql.includes("FROM memory_sources s JOIN memory_source_versions v")).length;
  expect(typeof readableMemoryRecord(record, 1, turn, { allowance: big() })).toBe("object");
  let before = lookups();
  const none = LineageAllowance.turn(0);
  expect(() => readableMemoryRecord(record, 1, turn, { allowance: none }), "not readable now: withheld, never a definite refusal").toThrow("MEMORY_REPLAY_LIMIT");
  expect(lookups() - before, "no source looked up with nothing left").toBe(0);
  expect(none.hit).toBe(true);
  before = lookups();
  const little = LineageAllowance.turn(20);
  expect(() => readableMemoryRecord(record, 1, turn, { allowance: little })).toThrow("MEMORY_REPLAY_LIMIT");
  expect(lookups() - before, "lookups never outrun what was paid").toBeLessThanOrEqual(20 * 16);
}, 120_000);

/** Every function declaration of a file, with its parameters (name and type text) and its body text. */
function declarations(file: string): Array<{ name: string; params: Array<{ name: string; type: string }>; body: string }> {
  const source = ts.createSourceFile(file, readFileSync(join(here, file), "utf8"), ts.ScriptTarget.Latest, true);
  const found: Array<{ name: string; params: Array<{ name: string; type: string }>; body: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      found.push({ name: node.name.text, params: node.parameters.map(param => ({ name: param.name.getText(source), type: param.type?.getText(source) ?? "" })), body: node.body.getText(source) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

it("P1-2 structural: every reader on the turn path that reads history itself takes an allowance and reserves or pays before it reads, and no reader takes one it never uses", () => {
  // the readers that issue history reads of their own (the rest pass their allowance to these)
  const ownReaders: Array<[string, string]> = [
    ["memory/readable.ts", "readRecord"],
    ["memory/replay-lineage.ts", "derivationAncestryCurrentWork"],
    ["memory/replay-lineage.ts", "recordRestsOnWithheldMessageWork"],
    ["memory/replay-lineage.ts", "flatRootsBad"],
    ["memory/replay-lineage.ts", "contentRevoked"],
    ["memory/replay-lineage.ts", "addSetMembers"],
  ];
  const spends = /\.(reserveRows|spendRows|spendNodes|rowRoom|meter)\(/;
  for (const [file, name] of ownReaders) {
    const found = declarations(file).find(fn => fn.name === name);
    expect(found, `${file} ${name} exists`).toBeTruthy();
    expect(found!.params.some(param => /^(LineageAllowance|MemoryReadOptions)$/.test(param.type)), `${name} takes an allowance`).toBe(true);
    expect(found!.body, `${name} pays before it reads`).toMatch(spends);
  }
  // no function on the turn path takes an allowance it never spends or passes on
  const files = [...readdirSync(join(here, "memory")).filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts")).map(file => `memory/${file}`),
    "steer-lineage.ts", "working-context.ts", "room-transcript.ts"];
  const idle: string[] = [];
  for (const file of files) for (const fn of declarations(file)) {
    for (const param of fn.params) if (param.type === "LineageAllowance" && !new RegExp(`\\b${param.name}\\b`).test(fn.body)) idle.push(`${file} ${fn.name}`);
  }
  expect(idle, "readers that take an allowance and never use it").toEqual([]);
});

// ---- P1-3: indexed receipt chunks ------------------------------------------------------------------------------------------------------------

it("P1-3: reading a receipt group from its judged position visits the same number of chunks after 1,000 or 100,000 appends", () => {
  const visits: Record<number, number> = {};
  for (const appends of [1_000, 100_000]) {
    const list = new BundleList(["rc0"]);
    for (let index = 1; index <= appends; index++) list.append([`rc${index}`]);
    resetReplayChunkVisits();
    expect(list.filter(() => true, appends)).toEqual([`rc${appends}`]);
    expect(list.some(id => id === `rc${appends}`, appends)).toBe(true);
    visits[appends] = replayChunkVisits();
    // the order and the ids are unchanged
    expect(list.length).toBe(appends + 1);
    expect([...list.tail(appends - 1)]).toEqual([`rc${appends - 1}`, `rc${appends}`]);
  }
  console.log(`CHUNK-VISITS 1k=${visits[1_000]} 100k=${visits[100_000]}`);
  expect(visits[100_000]).toBe(visits[1_000]);
  expect(visits[1_000]).toBeLessThanOrEqual(2);
});

it("P1-3: a group grown one receipt at a time through the reader's own path is checked without walking its earlier chunks (r3: 1,906 / 7,906 / 19,906 visits)", () => {
  const thread = "chat", driver = "drv";
  const db = database(), scope = ensureScope("conversation", thread);
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:bot','settled',NULL,'active')").run(`message:${thread}:r0`, scope, thread, "r0");
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(thread, "r0", 0, "bot", "text", "reply", "{}");
  const add = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]','[]','[\"r0\"]',0,0,0,'delivered',9)");
  const ask = () => replayExclusions(LineageAllowance.turn(1_000_000), thread, [{ id: "r0", role: "bot" }], null, { failClosed: true });
  const visits: Record<number, number> = {};
  let made = 0;
  for (const target of [300, 1_500]) {
    // receipts of no native session: one group of the thread, grown by one receipt per turn
    for (; made < target; made++) { add.run(`rc${made}`, thread, driver, null); ask(); }
    ask();
    resetReplayChunkVisits();
    expect(ask().size).toBe(0);
    visits[target] = replayChunkVisits();
  }
  console.log(`GROUP-CHUNK-VISITS 300=${visits[300]} 1500=${visits[1_500]}`);
  expect(visits[1_500]).toBeLessThanOrEqual(Math.max(4, visits[300]!));
}, 300_000);

// ---- Fable P3-2: a "still being checked" note is brought up to date when the warmer has finished the thread -----------------------------------

it("P3-2: the warmer says when it has finished a thread, so its \"still being checked\" notes are settled then, not at the owner's next message", async () => {
  await replyFromDoc();
  forgetKeptLineageForTest();
  const warmed: string[] = [];
  onLineageThreadWarmed(thread => warmed.push(thread));
  try {
    resetLineageWarmForTest();
    bumpLineageWarm("chat");
    for (let guard = 0; guard < 200 && lineageWarmStep(1_000); guard++) { /* until idle */ }
    expect(warmed).toContain("chat");
  } finally { onLineageThreadWarmed(null); resetLineageWarmForTest(); }
});

// ---- the 48 GB rig (int102-gate perfdiag STALLS rank 1/4, TURNPREP) ----------------------------------------------------------------------------

const tombstone = (id: string, type: "source" | "record", target: string) => database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES(?,?,?,NULL,NULL,0,'test',0)").run(id, type, target);

it("rig 1: unrelated root-set deletes, an unrelated tombstone and an accounted commit by another connection leave the kept verdicts in place; a related tombstone still withholds", async () => {
  await replyFromDoc();
  const kept = () => { prepareLineageCache(); return keptVerdictCount(); };
  const before = kept();
  expect(before, "reply-1's verdict is kept").toBeGreaterThan(0);
  // (a) a set nothing points at is collected (the idle sweep's deletes)
  const db = database();
  chainStore(db)(null, 0, ["elsewhere\u0000x1", "elsewhere\u0000x2"]);
  expect(collectRootSets(db)).toBeGreaterThan(0);
  expect(kept(), "a root-set delete").toBe(before);
  // (b) a tombstone on a record and on a source nothing kept read
  tombstone("t-unrelated-r", "record", "no-such-record");
  tombstone("t-unrelated-s", "source", "message:elsewhere:m9");
  expect(kept(), "an unrelated tombstone").toBe(before);
  // (c) a commit by another connection of this process, made through foreignLineageWrite
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    foreignLineageWrite(other, () => other.exec("UPDATE memory_meta SET data_revision=data_revision+1"));
    expect(kept(), "another connection's accounted commit").toBe(before);
    // one nothing accounted for still drops the cache (fail closed)
    other.exec("UPDATE memory_meta SET data_revision=data_revision+1");
    expect(kept(), "an unaccounted commit by another connection").toBe(0);
  } finally { other.close(); }
  // and the keys still reach what they should: the doc's own source tombstoned, reply-1 is withheld, with nothing flushed by hand
  expect(capturedMessageWithheld(big(), "chat", "reply-1")).toBe(false);
  tombstone("t-doc", "source", "message:older:m1");
  expect(capturedMessageWithheld(big(), "chat", "reply-1")).toBe(true);
});

it("rig 2: the allowance bounds wall-clock time as well as nodes: past its time a check stops as checking (withheld), never as allowed", async () => {
  await replyFromDoc();
  forgetKeptLineageForTest();
  try {
    setLineageTimeBudgetForTest(0);
    const turn = LineageAllowance.turn();
    expect(turn.overTime() || turn.timed(() => turn.overTime())).toBe(true);
    const verdict = turn.timed(() => capturedMessageVerdict(turn, "chat", "reply-1"));
    expect(verdict).toEqual({ withheld: true, unproven: true });
    expect(turn.hit).toBe(true);
    // with time to spare the same check proves it
    setLineageTimeBudgetForTest(60_000);
    forgetKeptLineageForTest();
    expect(capturedMessageVerdict(LineageAllowance.turn(), "chat", "reply-1")).toEqual({ withheld: false, unproven: false });
  } finally { setLineageTimeBudgetForTest(undefined); }
});

it("rig 3: a continuation check that runs out writes nothing down as revoked, so the next turn does not reset again on 'receipt-already-revoked'", async () => {
  await replyFromDoc();
  // session s2 rests on reply-1 (a record whose evidence is reply-1's own words)
  const words = "secret from doc";
  storeAnchorMessage(database(), "chat", "reply-1", words); captureSource(database(), { id: "message:chat:reply-1", threadId: "chat", messageId: "reply-1", kind: "text", speaker: "bot:bot", outcome: "recorded", text: words });
  const turn = access();
  const record = saveMemoryCandidate(words, [{ sourceId: "message:chat:reply-1", revision: 1, startByte: 0, endByte: Buffer.byteLength(words) }], "k2", turn);
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty, { allowance: LineageAllowance.tool() }), turn, "engine");
  receipt.sessionStarted("s2");
  stampFreshSession(database(), "chat", "engine", "s2"); // a 1.0.3 fresh start (S6 rule 26)
  receipt.noteLookup([{ id: record, version: 1, evidence: [{ sourceId: "message:chat:reply-1", revision: 1 }] }], turn);
  receipt.accepted();
  receipt.output("reply-2");
  const states = () => database().prepare("SELECT bundle_id,state FROM memory_disclosures ORDER BY bundle_id").all().map(row => `${row.bundle_id}=${row.state}`);
  const start = states();
  let warming = 0;
  for (let nodes = 1; nodes <= 80; nodes++) {
    forgetKeptLineageForTest(); resetSessionHolds();
    const why: { reason?: string } = {};
    continuationMemoryRevoked(LineageAllowance.turn(nodes), "chat", "engine", "s2", access(), why);
    if (why.reason === "lineage-warming") warming++;
    expect(states(), `${nodes} nodes (${why.reason ?? "held"}): nothing written down`).toEqual(start);
  }
  expect(warming, "some allowances ran out inside the check").toBeGreaterThan(0);
  // with room the session holds: nothing was revoked by the turns that could not finish
  forgetKeptLineageForTest(); resetSessionHolds();
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.tool(1_000_000_000), "chat", "engine", "s2", access(), why), why.reason).toBe(false);
}, 120_000);

it("rig 4: a turn whose checks ran out gives the warmer a guaranteed slice, even while owner turns keep the idle sweep from running", async () => {
  await replyFromDoc();
  forgetKeptLineageForTest();
  const warmed: string[] = [];
  onLineageThreadWarmed(thread => warmed.push(thread));
  try {
    resetLineageWarmForTest();
    // a turn ran out on "chat": it is wanted, and no idle sweep runs
    const turn = LineageAllowance.turn(0);
    expect(capturedMessageWithheld(turn, "chat", "reply-1")).toBe(true);
    for (let at = 0; at < 200 && !warmed.includes("chat"); at++) {
      guaranteeLineageWarmSlice(at * 1_000);
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(warmed, "the warmer finished the thread on guaranteed slices alone").toContain("chat");
    expect(capturedMessageVerdict(LineageAllowance.turn(5), "chat", "reply-1")).toEqual({ withheld: false, unproven: false });
  } finally { onLineageThreadWarmed(null); resetLineageWarmForTest(); }
});
