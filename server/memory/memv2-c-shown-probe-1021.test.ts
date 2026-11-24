// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: memory V2 lane C (revoke engine). Privacy invariant P5 / V1 (MEMORY-V2-DESIGN 4.3): the import's "shown" probe
// (revocation.ts importShownProbe) is narrowed in one place only: a queued receipt flip is judged by what ITS receipt names instead of
// "any flip queued: everything is shown". V1-W: over 500 random stores the narrowed probe never leaves out a chunk the base probe withdraws.
//
// The oracle is the base probe (f6ae52c670), vendored below. A queued flip is a receipt between two states the base probe reads exactly:
// before the flip it is live in memory_disclosure_refs, after the drain it hangs a consumer edge on what it cites (or on the wildcard).
// In the gap the base probe answers null. So for every store the oracle is asked three times, and the real writer
// (revokeRecordDisclosures, cause "import") must withdraw every chunk that ANY of them calls shown:
//   pre  = the store with the to-be-flipped receipts still live;
//   post = the store after the real marker drained the flips (the real holdRevokedReceipt writes the edges);
//   and, where no flip is queued at all, the base probe on the store itself, which the new probe must equal exactly, both ways.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { objectCarryThread } from "./lineage-types.ts";
import { INLINE_REVOCATION, stopMemoryRevocation } from "./memory-revocation.ts";
import { revokeRecordDisclosures } from "./revocation.ts";
import { REF_MATCH } from "./revocation-ref-match.ts";
import { resetRevokeWriteBudget } from "./revoke-budget.ts";
import * as marker from "./revoke-marker.ts";
import { threadNo } from "./thread-no.ts";
import { testThreadNo, WritetimeFixture } from "./testing/writetime-fixture.ts";

// ---- VENDORED from f6ae52c670 server/memory/revocation.ts importShownProbe (lines 132-153), statement for statement. Do not "fix" it:
// it is the reference. The only edit: revocationIndexReady is inlined (same file, same commit, lines 174-177).
function baseShownProbe(db: DatabaseSync, sourceIds: readonly string[]): ((id: string) => boolean) | null {
  const revocationIndexReady = (): boolean => {
    try { return Number(db.prepare("SELECT ready FROM memory_revocation_index_build WHERE id=1").get()?.ready) === 1; }
    catch { return false; }
  };
  try {
    if (!revocationIndexReady()) return null;
    const carried = (kind: "record" | "source", id: string) => {
      const no = threadNo(db, objectCarryThread({ kind, id }));
      return no !== null && Boolean(db.prepare("SELECT 1 AS x FROM memory_lineage_carry WHERE parent_thread_no=? LIMIT 1").get(no));
    };
    if (carried("record", "*") || carried("source", "*")) return null;
    if (db.prepare("SELECT 1 AS x FROM memory_receipt_flips LIMIT 1").get()) return null;
    const live = db.prepare(`SELECT 1 AS x FROM memory_disclosure_refs x WHERE x.kind=?2 AND ${REF_MATCH("SELECT ?1")} LIMIT 1`);
    const sourceShown = new Map<string, boolean>();
    const source = (id: string) => {
      let v = sourceShown.get(id);
      if (v === undefined) sourceShown.set(id, v = Boolean(live.get(id, "source")) || carried("source", id));
      return v;
    };
    if (sourceIds.some(source)) return () => true;
    const evidence = db.prepare("SELECT DISTINCT source_id AS s FROM memory_evidence WHERE record_id=?");
    const derived = db.prepare("SELECT 1 AS x FROM memory_derivations WHERE parent_id=? LIMIT 1");
    return id => Boolean(live.get(id, "record")) || carried("record", id) || Boolean(derived.get(id))
      || (evidence.all(id) as Array<{ s: unknown }>).some(row => typeof row.s !== "string" || source(row.s));
  } catch { return null; }
}
// ---- end of vendored code

const STORES = Number(process.env.MEMV2_C_STORES ?? 500), SEED = 0x1021c0de;
const RECORDS = Array.from({ length: 8 }, (_, i) => `nb:chunk:${i}`), SOURCES = Array.from({ length: 6 }, (_, i) => `src-${i}`);
const THREAD = "probe-thread";
const inline = { ...INLINE_REVOCATION };
let f: WritetimeFixture;
beforeEach(() => {
  f = new WritetimeFixture().cert(true);
  f.db.prepare("UPDATE memory_lsn SET next=1000 WHERE id=1").run();
  f.db.prepare("INSERT OR REPLACE INTO memory_revocation_index_build(id,ready) VALUES(1,1)").run();
  for (const id of SOURCES) f.source(id, "s-room");
  for (const id of RECORDS) f.record(id, 1, "s-room");
  f.record("child", 1, "s-room");
  testThreadNo(f.db, THREAD);
  INLINE_REVOCATION.ms = 0; // the commits are counted, not walked
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); stopMemoryRevocation(); f.close(); Object.assign(INLINE_REVOCATION, inline); resetRevokeWriteBudget(); });

function prng(seed: number): () => number { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type Theme = "no-flip" | "flips" | "malformed-flip" | "many-flips" | "over-cap-flip" | "ghost-flip" | "wildcard-carry" | "downgraded" | "index-not-ready";
const THEMES: Array<[Theme, number]> = [["no-flip", 14], ["flips", 44], ["malformed-flip", 10], ["many-flips", 4], ["over-cap-flip", 4], ["ghost-flip", 4], ["wildcard-carry", 8], ["downgraded", 8], ["index-not-ready", 4]];
type Verdict = boolean[] | null;

interface Store { theme: Theme; affected: string[]; importSources: string[]; flips: number }
/** One random store, written into the open transaction. Receipts that will be flipped are written LIVE; `flip()` flips them. */
function build(db: DatabaseSync, rnd: () => number): Store & { flip: () => void } {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const some = <T>(list: readonly T[], max: number): T[] => { const n = Math.floor(rnd() * (max + 1)); return [...new Set(Array.from({ length: n }, () => pick(list)))]; };
  let roll = rnd() * THEMES.reduce((n, [, w]) => n + w, 0), theme: Theme = "flips";
  for (const [name, weight] of THEMES) { if (roll < weight) { theme = name; break; } roll -= weight; }
  // what the records rest on
  for (const id of RECORDS) for (const source of some(SOURCES, rnd() < 0.5 ? 0 : 2))
    db.prepare("INSERT OR IGNORE INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,?,1,0,3)").run(id, source);
  if (rnd() < 0.15) db.prepare("INSERT INTO memory_derivations(parent_id,parent_version,child_id,child_version) VALUES(?,1,'child',1)").run(pick(RECORDS));
  const affected = [...new Set([pick(RECORDS), pick(RECORDS), ...some(RECORDS, 4)])];
  const importSources = rnd() < 0.7 ? [SOURCES[0]!] : rnd() < 0.5 ? [SOURCES[0]!, SOURCES[1]!] : [];
  let n = 0;
  const toFlip: string[] = [], ghosts: Array<[number, string]> = [];
  const cites = (ids: readonly unknown[]) => JSON.stringify(ids.map(id => ({ id, version: 1 })));
  const receipt = (state: "delivered" | "revoked", records: string, sources: string, output = true): string => {
    const bundle = `b${++n}`;
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'fuigo',?,?,?,'[]',0,0,0,?,0)")
      .run(bundle, THREAD, `s${n}`, records, sources, state);
    if (output) db.prepare("INSERT INTO memory_receipt_lines(bundle_id,thread_no,first_lsn,session_no) VALUES(?,?,?,NULL)").run(bundle, testThreadNo(db, THREAD), 10 + n);
    return bundle;
  };
  const edge = (kind: "record" | "source", id: string) => db.prepare("INSERT OR IGNORE INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,0,0,0,?,?)")
    .run(testThreadNo(db, objectCarryThread({ kind, id })), String(10 + n), testThreadNo(db, THREAD));
  // a narrow citing set: most records stay unshown, so a probe that leaves one out is seen
  const someRecords = () => some(RECORDS, rnd() < 0.6 ? 1 : 2), someSources = () => some(SOURCES.slice(1), rnd() < 0.5 ? 1 : 2);
  // receipts that are not in the gap: live, revoked with their edges installed, revoked with no output (nothing was produced: no edge)
  for (let i = Math.floor(rnd() * 3); i > 0; i--) {
    const records = rnd() < 0.5 ? someRecords() : [], sources = rnd() < 0.3 ? someSources() : [], kind = rnd();
    if (kind < 0.45) receipt("delivered", cites(records), cites(sources));
    else if (kind < 0.85) { receipt("revoked", cites(records), cites(sources)); for (const id of records) edge("record", id); for (const id of sources) edge("source", id); }
    else receipt("revoked", cites(records), cites(sources), false);
  }
  const queue = (records: string, sources: string) => { toFlip.push(receipt("delivered", records, sources)); };
  const wellFormed = () => queue(cites(rnd() < 0.55 ? someRecords() : []), cites(rnd() < 0.6 ? someSources() : []));
  switch (theme) {
    case "no-flip": break;
    case "flips": for (let i = 1 + Math.floor(rnd() * 3); i > 0; i--) wellFormed(); break;
    case "malformed-flip": {
      if (rnd() < 0.5) wellFormed();
      const shape = rnd();
      if (shape < 0.34) queue("{}", cites(someSources())); // not a list
      else if (shape < 0.67) queue(cites([...someRecords(), 7]), "[]"); // an id that is not a string
      else queue(JSON.stringify([...someRecords().map(id => ({ id })), null]), "[]"); // an entry with no id at all
      break;
    }
    case "many-flips": for (let i = 0; i < 65 + Math.floor(rnd() * 4); i++) queue(cites(rnd() < 0.05 ? someRecords() : [`filler-${i}`]), "[]"); break;
    case "over-cap-flip": queue(cites([...Array.from({ length: 2049 }, (_, i) => `filler-${i}`), ...someRecords()]), "[]"); if (rnd() < 0.5) wellFormed(); break;
    case "ghost-flip": ghosts.push([10_000 + n, "ghost"]); if (rnd() < 0.5) wellFormed(); break; // a flip whose receipt row is gone
    case "wildcard-carry": n++; edge(rnd() < 0.5 ? "record" : "source", "*"); break;
    case "downgraded": n++; edge("record", "*"); edge("source", "*"); for (let i = Math.floor(rnd() * 3); i > 0; i--) wellFormed(); break; // a file back from a build that hung receipts on the wildcard pair
    case "index-not-ready": db.prepare("UPDATE memory_revocation_index_build SET ready=0 WHERE id=1").run(); if (rnd() < 0.5) wellFormed(); break;
  }
  const flip = () => {
    for (const bundle of toFlip) db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(bundle); // the real trigger queues it
    for (const [lsn, bundle] of ghosts) db.prepare("INSERT INTO memory_receipt_flips(thread_no,first_lsn,bundle_id) VALUES(?,?,?)").run(testThreadNo(db, THREAD), lsn, bundle);
  };
  return { theme, affected, importSources, flips: toFlip.length + ghosts.length, flip };
}
const flipsQueued = (db: DatabaseSync) => Number(db.prepare("SELECT count(*) AS n FROM memory_receipt_flips").get()!.n);
const ask = (db: DatabaseSync, store: Store): Verdict => { const probe = baseShownProbe(db, store.importSources); return probe && store.affected.map(id => probe(id)); };

it(`V1-W: over ${STORES} random stores the import withdraws every chunk the base probe calls shown, before the flip, after its drain, and exactly when no flip is queued`, () => {
  const rnd = prng(SEED), db = f.db;
  const tally = { narrowed: 0, sparedChunks: 0, gapStores: 0, allShownInGap: 0, exact: 0, undrained: 0, required: 0, withdrawn: 0 };
  const themes = new Map<Theme, { stores: number; narrowed: number }>();
  const failures: string[] = [];
  for (let s = 0; s < STORES; s++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const store = build(db, rnd);
      const pre = ask(db, store);
      store.flip();
      expect(flipsQueued(db)).toBe(store.flips);
      let post: Verdict = pre, drained = true;
      if (store.flips) {
        // after the drain: the REAL marker commits the flips (revoke-marker.ts head flips, revoke-commit.ts holdRevokedReceipt)
        db.exec("SAVEPOINT v1w_drain");
        for (let i = 0; i < 400 && flipsQueued(db) > 0; i++) marker.markerSlice(db, 4096);
        drained = flipsQueued(db) === 0;
        post = drained ? ask(db, store) : null; // a drain that did not finish proves nothing: every chunk is required
        db.exec("ROLLBACK TO v1w_drain"); db.exec("RELEASE v1w_drain");
        expect(flipsQueued(db)).toBe(store.flips);
      }
      if (!drained) tally.undrained++;
      const gap = ask(db, store); // the base probe on the store as the writer sees it
      const jobsBefore = Number(db.prepare("SELECT coalesce(max(revoke_id),0) AS n FROM memory_revoke_jobs").get()!.n);
      revokeRecordDisclosures(db, "import", { recordIds: store.affected, sourceIds: store.importSources, versions: Object.fromEntries(store.affected.map(id => [id, 1])), receiptsByRecordOnly: true });
      const withdrawn = new Set((db.prepare("SELECT root FROM memory_revoke_jobs WHERE kind='memory' AND revoke_id>?").all(jobsBefore) as Array<{ root: string }>).map(row => String((JSON.parse(row.root) as { ref?: { id?: unknown } }).ref?.id)));
      const theme = themes.get(store.theme) ?? { stores: 0, narrowed: 0 };
      themes.set(store.theme, theme); theme.stores++;
      let spared = 0;
      store.affected.forEach((id, i) => {
        const required = pre === null || pre[i] || post === null || post[i];
        if (required) tally.required++;
        if (withdrawn.has(id)) tally.withdrawn++; else spared++;
        if (required && !withdrawn.has(id)) failures.push(`store ${s} (${store.theme}): ${id} not withdrawn; base pre=${pre === null ? "null" : pre[i]} post=${post === null ? "null" : post[i]} gap=${gap === null ? "null" : gap[i]}`);
        // every base rule other than the flip rule is kept exactly: with no flip queued the two probes are the same function
        if (!store.flips && (gap === null || gap[i]) !== withdrawn.has(id)) failures.push(`store ${s} (${store.theme}): no flip queued, ${id} base=${gap === null ? "null" : gap[i]} new=${withdrawn.has(id)}`);
      });
      if (!store.flips) tally.exact++;
      else {
        tally.gapStores++;
        expect(gap, `store ${s}: the base probe answers null while a flip is queued`).toBeNull();
        if (spared) { tally.narrowed++; tally.sparedChunks += spared; theme.narrowed++; } else tally.allShownInGap++;
      }
    } finally { db.exec("ROLLBACK"); }
  }
  console.log(`MEMV2C V1-W stores=${STORES} seed=${SEED}: with a flip queued=${tally.gapStores} (base: every chunk withdrawn in all of them; new: narrowed in ${tally.narrowed}, ${tally.sparedChunks} chunks not withdrawn; all withdrawn in ${tally.allShownInGap}), no flip queued (exact equality)=${tally.exact}, drains unfinished=${tally.undrained}, chunks required=${tally.required} withdrawn=${tally.withdrawn}, missed=${failures.length}`);
  console.log(`MEMV2C V1-W themes: ${[...themes].map(([name, t]) => `${name}=${t.stores}/${t.narrowed}`).join(" ")} (stores/narrowed)`);
  expect(failures.slice(0, 12)).toEqual([]);
  // not vacuous: every theme was drawn, the drains ran, the narrowing happened where the design allows it and nowhere it must not
  for (const [name] of THEMES) expect(themes.get(name)?.stores ?? 0, name).toBeGreaterThan(5);
  expect(tally.undrained).toBe(0);
  expect(tally.narrowed).toBeGreaterThan(50); // V1 itself: on the base build this is 0 (any queued flip withdraws every chunk)
  for (const name of ["malformed-flip", "many-flips", "over-cap-flip", "ghost-flip", "downgraded", "index-not-ready", "wildcard-carry"] as const) expect(themes.get(name)!.narrowed, name).toBe(0);
});

// ---- P5-W (design 2, P5): no job is skipped that could reach something shown. One deterministic store per rule of the import "shown"
// probe, through the real writer (revokeRecordDisclosures, cause "import"). SHOWN is the record a session may have seen, OTHER is a chunk
// nothing reaches: where the probe may say "per record" OTHER is spared (the writer is not just withdrawing everything), where a rule
// answers "revoke everything" OTHER is withdrawn too. Each expect below is the line one mutant of the probe is held to (receipts.tsv). The mutants are source edits of revocation.ts importShownProbe, applied and
// restored by the lane runner (no test seam in product code).
it("P5-W no job is skipped that could reach something shown", () => {
  const SHOWN = RECORDS[0]!, OTHER = RECORDS[1]!, IMPORT_SRC = SOURCES[0]!, OTHER_SRC = SOURCES[3]!;
  const db = f.db;
  const cites = (ids: readonly unknown[]) => JSON.stringify(ids.map(id => ({ id, version: 1 })));
  let n = 0;
  const receipt = (records: readonly unknown[], sources: readonly unknown[], state: "delivered" | "revoked" = "delivered") => {
    const bundle = `p5-${++n}`;
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'fuigo',?,?,?,'[]',0,0,0,?,0)")
      .run(bundle, THREAD, `p5s${n}`, cites(records), cites(sources), state);
    db.prepare("INSERT INTO memory_receipt_lines(bundle_id,thread_no,first_lsn,session_no) VALUES(?,?,?,NULL)").run(bundle, testThreadNo(db, THREAD), 10 + n);
    return bundle;
  };
  const edge = (kind: "record" | "source", id: string) => db.prepare("INSERT OR IGNORE INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,0,0,0,?,?)")
    .run(testThreadNo(db, objectCarryThread({ kind, id })), String(10 + ++n), testThreadNo(db, THREAD));
  const queueFlip = (records: readonly unknown[], sources: readonly unknown[]) => { // a live receipt that goes revoked: the real trigger queues its flip
    const bundle = receipt(records, sources);
    db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(bundle);
  };
  /** Which of [SHOWN, OTHER] the writer withdraws for an import of IMPORT_SRC, on the store `setup` writes (rolled back after). */
  const withdrawn = (setup: () => void): string[] => {
    db.exec("BEGIN IMMEDIATE");
    try {
      setup();
      const jobsBefore = Number(db.prepare("SELECT coalesce(max(revoke_id),0) AS n FROM memory_revoke_jobs").get()!.n);
      revokeRecordDisclosures(db, "import", { recordIds: [SHOWN, OTHER], sourceIds: [IMPORT_SRC], versions: { [SHOWN]: 1, [OTHER]: 1 }, receiptsByRecordOnly: true });
      const ids = (db.prepare("SELECT root FROM memory_revoke_jobs WHERE kind='memory' AND revoke_id>?").all(jobsBefore) as Array<{ root: string }>)
        .map(row => String((JSON.parse(row.root) as { ref?: { id?: unknown } }).ref?.id));
      return [SHOWN, OTHER].filter(id => ids.includes(id));
    } finally { db.exec("ROLLBACK"); }
  };
  const evidence = (record: string, source: string) => db.prepare("INSERT OR IGNORE INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,?,1,0,3)").run(record, source);
  const BOTH = [SHOWN, OTHER];

  // the control: nothing reaches either chunk, so the probe is per record and no job is made (not vacuous: the rules below each change this)
  expect(withdrawn(() => { receipt([RECORDS[5]!], [OTHER_SRC]); })).toEqual([]);
  // rule 1 (mutant p5-index): the index is not ready, so the file cannot tell: every chunk
  expect(withdrawn(() => { db.prepare("UPDATE memory_revocation_index_build SET ready=0 WHERE id=1").run(); })).toEqual(BOTH);
  // rule 2 (mutants p5-wild-record, p5-wild-source): a wildcard carry (either kind): every chunk
  expect(withdrawn(() => { edge("record", "*"); })).toEqual(BOTH);
  expect(withdrawn(() => { edge("source", "*"); })).toEqual(BOTH);
  // rule 3 (mutant p5-flip-unread): a queued flip the probe cannot read (not a list / more than it may read) answers for everything; a queued flip is never ignored
  expect(withdrawn(() => { const b = receipt([], []); db.prepare("UPDATE memory_disclosures SET record_versions='{}', state='revoked' WHERE bundle_id=?").run(b); })).toEqual(BOTH);
  expect(withdrawn(() => { queueFlip(Array.from({ length: 2049 }, (_, i) => `filler-${i}`), []); })).toEqual(BOTH);
  // rule 3, the narrowed case (V1; mutant p5-flip-record): a readable flip counts for what ITS receipt cites; it cites SHOWN, so SHOWN is withdrawn and OTHER is not
  expect(withdrawn(() => { queueFlip([SHOWN], []); })).toEqual([SHOWN]);
  // rule 4 (mutants p5-source-live, p5-source-flip, p5-source-carry, one per line): a receipt that cites or carries a source of the
  // import: every chunk (live, queued flip, or a hung consumer edge)
  expect(withdrawn(() => { receipt([], [IMPORT_SRC]); })).toEqual(BOTH);
  expect(withdrawn(() => { queueFlip([], [IMPORT_SRC]); })).toEqual(BOTH);
  expect(withdrawn(() => { edge("source", IMPORT_SRC); })).toEqual(BOTH);
  // rule 5 (mutants p5-rec-live, -rec-carry, -rec-derived, -evid-live, -evid-flip, -evid-carry, one per line): per record otherwise: a live receipt, a carry edge, a derived record, an evidence source
  expect(withdrawn(() => { receipt([SHOWN], []); })).toEqual([SHOWN]);
  expect(withdrawn(() => { edge("record", SHOWN); })).toEqual([SHOWN]);
  expect(withdrawn(() => { db.prepare("INSERT INTO memory_derivations(parent_id,parent_version,child_id,child_version) VALUES(?,1,'child',1)").run(SHOWN); })).toEqual([SHOWN]);
  expect(withdrawn(() => { evidence(SHOWN, OTHER_SRC); receipt([], [OTHER_SRC]); })).toEqual([SHOWN]);
  expect(withdrawn(() => { evidence(SHOWN, OTHER_SRC); queueFlip([], [OTHER_SRC]); })).toEqual([SHOWN]);
  expect(withdrawn(() => { evidence(SHOWN, OTHER_SRC); edge("source", OTHER_SRC); })).toEqual([SHOWN]);
});
