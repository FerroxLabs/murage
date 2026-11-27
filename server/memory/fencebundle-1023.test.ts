// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 fencebundle (MAIN-RULING (C), BGDIAG DIAG.md): the thread's own active checkpoint was refused WHOLE at bundle.ts (the checkpoint
// loop's catch) once one line it quotes was hidden by the owner: the revoke walk marks the line's source AND every record citing it
// (revoke-marker.ts sourceNode/recordNode), so readable.ts read the checkpoint record as withheld deny-memory and the reply said
// "left remembered details out". The checkpoint is now used with only the denied lines omitted; the denied words never reach the bundle.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureSource } from "./capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { fixtureMemoryAccess as memoryAccess } from "../testing/recall-access-fixture.ts";
import { setMemoryMode } from "./repository.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { assertMemoryBundle, buildMemoryBundle, bundleFenceOmissionCount } from "./bundle.ts";
import { bindMemoryDisclosureSession, deliverMemoryDisclosure, prepareMemoryDisclosure, revokedReason } from "./disclosures.ts";
import { initializeFreshSessionProof, proveRetainedSession } from "./session-proof.ts";
import { noteSessionFrame } from "./session-proof-schema.ts";
import { FreshReplaySessionConfirmation } from "./fresh-replay-session.ts";
import { captureSendReplayProof } from "./replay-lineage.ts";
import { assertMemoryAccess } from "./policy.ts";
import { stampFreshSession } from "./testing/writetime-fixture.ts";
import type { Disclosure } from "./replay-lineage.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
import { commitRevoke, inheritEdge } from "./revoke-commit.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { writeLineage } from "./lineage-write.ts";
import { ensureCheckpointSchema } from "./checkpoint-schema.ts";
import { insertMemoryRecord } from "./record-write.ts";
import { memoryLookup } from "./deny-read.ts";
import { memoryRefKey } from "./lineage-types.ts";

const threadId = "5b1d6a0e-2c4f-4e8a-9d3b-7a1c0e2f4b6d";
const roster = { bots: [{ id: "bot", threadId }], groups: [] };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); setMemoryMode("capture"); });
function complete(text: string) {
  const id = `message:${threadId}:${randomUUID()}`, messageId = randomUUID();
  storeAnchorMessage(database(), threadId, messageId, text, "user");
  // the owner line's lineage row, as the message write makes it (lineage-write.ts): a hide then denies this line alone, not the whole thread
  writeLineage(database(), { threadId, messageId, author: "owner" }, {});
  captureSource(database(), { id, threadId, messageId, origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text });
  const work = claimMemoryJob("fencebundle-worker");
  if (!work) throw new Error("fixture did not claim a real capture job");
  publishMemoryWork(work, "fencebundle-worker", captureWork(work));
  return { id, jobId: work.id, revision: work.revision, messageId };
}
function access() { const registry = new InternalCapabilities(), generation = registry.begin("bot", threadId), token = registry.mint({ botId: "bot", threadId, generation, depth: 0, kind: "memory", skillAuthoring: false }); return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster); }
/** The owner hides one chat line: the same two steps the transcript hide takes (p09.test.ts hideCases), the walk run to the end (settled). */
function hide(messageId: string) {
  database().prepare("UPDATE messages SET json=json_set(json,'$.withheldFromBots',json('true')) WHERE thread_id=? AND id=?").run(threadId, messageId);
  commitRevoke(database(), { kind: "line", threadId, messageIds: [messageId], cause: "hide" }); drainRevokeMarker(database());
}
/** The store's explicit record/source mark table: schema 14 (1.0.23 deny rule, deny-rule-schema.ts) keeps them in memory_deny_object and
 * drops memory_deny_memory; an older schema still has memory_deny_memory. */
const markTable = () => database().prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_deny_object'").get() ? "memory_deny_object" : "memory_deny_memory";
/** The checkpoint record's own verdict as every reader reads it (by a stored mark, or on schema 14 by the rule through a hidden line). */
const ownVerdict = (id: string, version: number) => memoryLookup(database(), [{ kind: "record", id, version }], { audience: null }).get(memoryRefKey({ kind: "record", id, version }))?.state;
// `rule`: the reader's transcript rule the chat turn always passes (index.ts memoryOptions.withheldMessage); here it withholds nothing itself
const bundleOf = (reader = access(), rule?: (thread: string, message: string) => boolean) => buildMemoryBundle("what are we doing", reader, { search: async () => ({ hits: [], vectorRows: 0 }) }, { allowance: LineageAllowance.tool(), ...rule ? { withheldMessage: rule } : {} });

it("W-FENCE-1: a checkpoint with one owner-hidden line keeps the other lines, and the hidden line is absent", async () => {
  const one = complete("FB_KEEP_ALPHA the release notes go out on Monday."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("FB_HIDDEN_BRAVO my locker code is behind the clock."); refreshMemoryCheckpoint(two.jobId);
  const three = complete("FB_KEEP_CHARLIE the demo uses the staging bot."); const head = refreshMemoryCheckpoint(three.jobId);
  const stored = String(database().prepare("SELECT text FROM memory_records WHERE id=? AND version=?").get(head.checkpointId!, head.version!)?.text);
  // setup: the active checkpoint quotes all three lines before the hide, and the hide settles a mark on the checkpoint record itself
  expect(stored).toContain("FB_HIDDEN_BRAVO"); expect(stored).toContain("FB_KEEP_ALPHA"); expect(stored).toContain("FB_KEEP_CHARLIE");
  hide(two.messageId);
  expect(ownVerdict(head.checkpointId!, head.version!)).toBe("withheld");
  const bundle = await bundleOf();
  const text = bundle.checkpoint.map(record => record.text).join("\n");
  expect(text).toContain("FB_KEEP_ALPHA"); // RED on base: the whole checkpoint was refused
  expect(text).toContain("FB_KEEP_CHARLIE");
  expect(text).not.toContain("FB_HIDDEN_BRAVO");
  expect(bundle.text).not.toContain("FB_HIDDEN_BRAVO");
  // the checkpoint cites only the lines it shows: the hidden line's source is not in its evidence nor in the bundle's source versions
  expect(bundle.checkpoint.flatMap(record => record.evidence.map(handle => handle.sourceId))).not.toContain(two.id);
  expect(bundle.sourceVersions.map(version => version.id)).not.toContain(two.id);
  expect(bundle.sourceVersions.map(version => version.id)).toEqual(expect.arrayContaining([one.id, three.id]));
});

it("W-FENCE-2: a checkpoint whose every line is hidden is left out whole (nothing denied is shown), untold like a settled line", async () => {
  const one = complete("FB_GONE_DELTA first private line."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("FB_GONE_ECHO second private line."); refreshMemoryCheckpoint(two.jobId);
  hide(one.messageId); hide(two.messageId);
  const bundle = await bundleOf(access(), () => false);
  expect(bundle.checkpoint).toEqual([]);
  expect(bundle.text).not.toMatch(/FB_GONE_(DELTA|ECHO)/);
  // r3 (the owner's real store, t1): the owner denied every line and nothing is pending, so the reply's left-out note does not count it
  // (index.ts fenceOmissionCause reads this count as bundle-fence); RED on base: the refusal was counted as a left-out record
  expect(bundleFenceOmissionCount(bundle)).toBe(0);
  expect(bundle.degradedReason).toBeUndefined();
});

it("W-FENCE-3: a deny mark on the checkpoint record that no hidden line explains still refuses it whole (fail closed)", async () => {
  const one = complete("FB_SOLO_FOXTROT a line nobody hid."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("FB_SOLO_GOLF a line the owner hid."); refreshMemoryCheckpoint(two.jobId);
  hide(two.messageId);
  const active = database().prepare("SELECT record_id,record_version FROM memory_checkpoint_heads WHERE state='active'").get()!;
  // besides the mark the hidden line explains, a revoke that names the checkpoint record itself (not reached through one of its lines)
  database().prepare(`INSERT INTO ${markTable()}(kind,id,version,revoke_id) VALUES('record',?,?,?)`).run(String(active.record_id), Number(active.record_version), 987654);
  const bundle = await bundleOf();
  expect(bundle.checkpoint).toEqual([]);
  expect(bundle.text).not.toMatch(/FB_SOLO_(FOXTROT|GOLF)/);
  // a refusal no hidden line explains is told as left out (only a settled, fully denied checkpoint is untold: W-FENCE-2)
  expect(bundleFenceOmissionCount(bundle)).toBe(1);
});

it("W-FENCE-4: the partial checkpoint passes the dispatch re-check and its own receipt stands; a receipt that showed the hidden line does not", async () => {
  const one = complete("FB_KEEP_HOTEL the backup runs at noon."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("FB_HIDDEN_INDIA the spare key is under the mat."); refreshMemoryCheckpoint(two.jobId);
  const reader = access();
  const before = await bundleOf(reader);
  expect(before.checkpoint.map(record => record.text).join("\n")).toContain("FB_HIDDEN_INDIA");
  const receipt = (bundleId: string) => database().prepare("SELECT * FROM memory_disclosures WHERE bundle_id=?").get(bundleId) as unknown as Disclosure;
  prepareMemoryDisclosure(before, reader, "fixture-driver");
  hide(two.messageId);
  const after = await bundleOf(reader);
  expect(after.checkpoint.map(record => record.text).join("\n")).toContain("FB_KEEP_HOTEL"); // RED on base: refused whole
  expect(after.text).not.toContain("FB_HIDDEN_INDIA");
  // dispatch re-proves the frame it carries (bundle.ts assertMemoryBundle): the partial checkpoint reads the same, so the turn is not revoked
  expect(() => assertMemoryBundle(after, reader)).not.toThrow();
  prepareMemoryDisclosure(after, reader, "fixture-driver");
  // continuation (disclosures.ts revokedReason): the receipt that showed the hidden line is revoked (that session saw the words) ...
  expect(revokedReason(LineageAllowance.tool(), receipt(before.bundleId), reader)).not.toBeNull();
  // ... and the receipt of the partial checkpoint stands, so the next turn does not reset the session again
  expect(revokedReason(LineageAllowance.tool(), receipt(after.bundleId), reader)).toBeNull();
});

it("W-FENCE-5: on the chat path (a reader rule is passed) the checkpoint keeps its other lines through build, dispatch and the rule", async () => {
  const one = complete("FB_KEEP_JULIET the invoice is due Friday."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("FB_HIDDEN_KILO my bank pin hint is the dog."); refreshMemoryCheckpoint(two.jobId);
  hide(two.messageId);
  const reader = access(), asked: string[] = [];
  const bundle = await bundleOf(reader, (_thread, message) => { asked.push(message); return false; });
  const text = bundle.checkpoint.map(record => record.text).join("\n");
  expect(text).toContain("FB_KEEP_JULIET"); // RED on base and before the per-line rule: the whole-record rule read the record's mark
  expect(bundle.text).not.toContain("FB_HIDDEN_KILO");
  expect(asked).toContain(one.messageId); // the rule was asked about the line shown
  expect(() => assertMemoryBundle(bundle, reader)).not.toThrow();
});

/** The thread's checkpoint as a build before the family schema left it, then upgraded by the real upgrade (checkpoint-schema.ts
 * ensureCheckpointSchema): one record whose id is the family id (the owner's real store: every busy thread's checkpoint), its lines in
 * source-id order rotated by one so no line follows the handle the upgrade seeds at its position. `edit` changes a line's words (a line no longer
 * quoting its source as written). */
function legacyCheckpoint(edit: (line: string) => string = line => line) {
  const db = database();
  const head = db.prepare("SELECT family_id,record_id,record_version FROM memory_checkpoint_heads WHERE state='active'").get()!;
  const family = String(head.family_id), from = { id: String(head.record_id), version: Number(head.record_version) };
  const row = db.prepare("SELECT scope_id,text FROM memory_records WHERE id=? AND version=?").get(from.id, from.version)!;
  const written = JSON.parse(String(db.prepare("SELECT handles FROM memory_checkpoint_members WHERE record_id=? AND record_version=?").get(from.id, from.version)!.handles)) as Array<{ sourceId: string; revision: number; startByte: number; endByte: number }>;
  const [heading, ...lines] = String(row.text).split("\n");
  // source-id order rotated by one: no line sits where the upgrade's seeded order puts its handle
  const sorted = written.map((handle, index) => ({ handle, line: edit(lines[index]!) })).sort((x, y) => x.handle.sourceId < y.handle.sourceId ? -1 : 1);
  const pairs = [...sorted.slice(1), sorted[0]!];
  db.prepare("UPDATE memory_records SET state='archived' WHERE kind='checkpoint'").run();
  insertMemoryRecord(db, { id: family, version: 1, scopeId: String(row.scope_id), kind: "checkpoint", text: [heading, ...pairs.map(pair => pair.line)].join("\n"), assertion: "assistant-inference", state: "active", validFrom: Date.now(), createdAt: Date.now() });
  for (const { handle } of pairs) {
    db.prepare("INSERT INTO memory_evidence VALUES(?,?,?,?,?,?)").run(family, 1, handle.sourceId, handle.revision, handle.startByte, handle.endByte);
    inheritEdge(db, { kind: "record", id: family, version: 1 }, { kind: "source", id: handle.sourceId });
  }
  db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL)").run(family, 1);
  db.exec("PRAGMA foreign_keys=OFF; DROP TABLE memory_checkpoint_exclusions; DROP TABLE memory_checkpoint_publications; DROP TABLE memory_checkpoint_members; DROP TABLE memory_checkpoint_heads; PRAGMA foreign_keys=ON");
  ensureCheckpointSchema(db);
  // setup: the upgrade seeded it (family id = record id, handles by source id) and its lines do not follow that order
  const seeded = db.prepare("SELECT handles FROM memory_checkpoint_members WHERE family_id=? AND record_id=? AND record_version=1").get(family, family);
  expect(JSON.parse(String(seeded?.handles)).map((handle: { sourceId: string }) => handle.sourceId)).toEqual(sorted.map(pair => pair.handle.sourceId));
  return family;
}

it("W-FENCE-6: a legacy checkpoint (seeded by the schema upgrade, lines not in handle order) keeps its other lines when one is hidden", async () => {
  const one = complete("FB_LEGACY_LIMA the shop opens at ten."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("FB_LEGACY_MIKE my door code is on the fridge."); refreshMemoryCheckpoint(two.jobId);
  const three = complete("FB_LEGACY_NINER the courier comes on Tuesday."); refreshMemoryCheckpoint(three.jobId);
  const family = legacyCheckpoint();
  hide(two.messageId);
  expect(ownVerdict(family, 1)).toBe("withheld");
  const reader = access();
  const bundle = await bundleOf(reader, () => false);
  const text = bundle.checkpoint.map(record => record.text).join("\n");
  // RED on base (a legacy seeded row was refused whole: [false,false,false]) and when lines follow the seeded order (the wrong line goes)
  expect(["FB_LEGACY_LIMA", "FB_LEGACY_MIKE", "FB_LEGACY_NINER"].map(word => text.includes(word))).toEqual([true, false, true]);
  expect(bundle.text).not.toContain("FB_LEGACY_MIKE");
  expect(bundle.checkpoint.flatMap(record => record.evidence.map(handle => handle.sourceId)).sort()).toEqual([one.id, three.id].sort());
  expect(() => assertMemoryBundle(bundle, reader)).not.toThrow();
});

it("W-FENCE-8: a legacy checkpoint whose hidden line no longer quotes its source as written is refused whole (no line told apart)", async () => {
  const one = complete("FB_LEGACY_OSCAR the plants need water."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("FB_LEGACY_PAPA my alarm code is four digits."); refreshMemoryCheckpoint(two.jobId);
  legacyCheckpoint(line => line.replace("FB_LEGACY_PAPA my alarm", "FB_LEGACY_PAPA the alarm"));
  hide(two.messageId);
  const bundle = await bundleOf(access(), () => false);
  expect(bundle.checkpoint).toEqual([]);
  expect(bundle.text).not.toMatch(/FB_LEGACY_(OSCAR|PAPA)/);
});

it("W-FENCE-9: a legacy checkpoint whose owner said the same words twice keeps both lines when another line is hidden", async () => {
  const one = complete("FB_TWICE_QUEBEC call the plumber tomorrow."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("FB_TWICE_QUEBEC call the plumber tomorrow."); refreshMemoryCheckpoint(two.jobId);
  const three = complete("FB_LEGACY_ROMEO my pin is the year we met."); refreshMemoryCheckpoint(three.jobId);
  const family = legacyCheckpoint();
  hide(three.messageId);
  expect(ownVerdict(family, 1)).toBe("withheld");
  const reader = access();
  const bundle = await bundleOf(reader, () => false);
  const text = bundle.checkpoint.map(record => record.text).join("\n");
  // RED on base and with one handle per line required: two handles quote the same words, so the read could not tell their lines apart
  expect([text.split("FB_TWICE_QUEBEC").length - 1, text.includes("FB_LEGACY_ROMEO")]).toEqual([2, false]);
  expect(bundle.text).not.toContain("FB_LEGACY_ROMEO");
  expect(() => assertMemoryBundle(bundle, reader)).not.toThrow();
});

it("W-FENCE-10: a legacy checkpoint whose same-words lines differ (one line's label changed) is refused whole (lines not interchangeable)", async () => {
  const one = complete("FB_TWICE_SIERRA water the garden."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("FB_TWICE_SIERRA water the garden."); refreshMemoryCheckpoint(two.jobId);
  const three = complete("FB_LEGACY_TANGO my safe opens left twice."); refreshMemoryCheckpoint(three.jobId);
  let changed = false;
  legacyCheckpoint(line => { if (changed || !line.includes("FB_TWICE_SIERRA")) return line; changed = true; return line.replace(/^[^(]*/, "Assistant hypothesis "); });
  hide(three.messageId);
  const bundle = await bundleOf(access(), () => false);
  expect(bundle.checkpoint).toEqual([]);
  expect(bundle.text).not.toMatch(/FB_(TWICE_SIERRA|LEGACY_TANGO)/);
});

it("W-FENCE-7: a line only the reader rule leaves out (no deny mark) is omitted, and the build and dispatch re-proofs keep the rest", async () => {
  const one = complete("FB_KEEP_NOVEMBER the train leaves at nine."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("FB_RULED_OSCAR held back from this reader."); refreshMemoryCheckpoint(two.jobId);
  const reader = access();
  const bundle = await bundleOf(reader, (_thread, message) => message === two.messageId);
  const text = bundle.checkpoint.map(record => record.text).join("\n");
  expect(text).toContain("FB_KEEP_NOVEMBER"); // RED on base (the whole-record rule refused it) and without the re-proof by lines
  expect(bundle.text).not.toContain("FB_RULED_OSCAR");
  expect(() => assertMemoryBundle(bundle, reader)).not.toThrow();
});

it("W-FENCE-11: a session that was shown the partial checkpoint resumes: the retained-session proof does not re-read the line left out", async () => {
  const one = complete("FB_KEEP_UNIFORM the boiler is serviced in May."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("FB_HIDDEN_VICTOR my passport is in the blue box."); refreshMemoryCheckpoint(two.jobId);
  hide(two.messageId);
  const reader = access(), key = { threadId, driverInstance: "fixture-driver", nativeSession: "fb-session" }, db = database();
  stampFreshSession(db, threadId, key.driverInstance, key.nativeSession);
  // the session's live birth and first frame, as a fresh engine session makes them (session-proof-fixture.ts receipts)
  const confirmation = new FreshReplaySessionConfirmation(captureSendReplayProof(threadId, []), key.driverInstance, () => assertMemoryAccess(reader), { generation: reader.generation });
  confirmation.sessionStarted("fixture-live-turn", key, true);
  noteSessionFrame(db, key, false);
  initializeFreshSessionProof(key, reader, undefined, { fresh: true, confirmation });
  const after = await bundleOf(reader);
  expect(after.checkpoint.map(record => record.text).join("\n")).toContain("FB_KEEP_UNIFORM");
  prepareMemoryDisclosure(after, reader, key.driverInstance);
  initializeFreshSessionProof(key, reader, () => { bindMemoryDisclosureSession(after.bundleId, key.nativeSession); deliverMemoryDisclosure(after.bundleId, reader); }, { fresh: true, confirmation });
  db.prepare("UPDATE memory_session_checks SET up_to=0 WHERE thread_id=? AND driver_instance=? AND native_session=?").run(key.threadId, key.driverInstance, key.nativeSession);
  // the real continuation entry (index.ts resume path): RED on base, the proof re-read every source of the checkpoint record, met the
  // hidden line's withheldFromBots and reset the session (fresh changed:line, session-proof.ts) though this session never saw that line
  expect(proveRetainedSession(LineageAllowance.tool(), key, { access: reader, disclosed: true })).toEqual({ kind: "resume" });
});

it("W-FENCE-12: a checkpoint whose every line the reader rule leaves out as still checking is told as left out, never taken as settled", async () => {
  const one = complete("FB_PENDING_WHISKEY first line."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("FB_PENDING_XRAY second line."); refreshMemoryCheckpoint(two.jobId);
  // the reader's rule answers "checking" (not known now) for every line: nothing is settled, so the omission is told
  const bundle = await bundleOf(access(), (_thread: string, _message: string, _allowance?: unknown, verdict?: { checking?: boolean }) => { if (verdict) verdict.checking = true; return true; });
  expect(bundle.checkpoint).toEqual([]);
  expect(bundle.text).not.toMatch(/FB_PENDING_(WHISKEY|XRAY)/);
  // the record itself is told as left out (degraded), not passed over as settled; RED before r3's checking hand-off (replay-lineage.ts
  // checkpointLinesOnWithheldMessage dropped the rule's checking and the record was taken as settledEmpty). The rule's own held lines are
  // counted by bundle.ts's rule wrapper either way, so the count is the two lines plus the record.
  expect(bundle.degradedReason).toBe("MEMORY_OPTIONAL_EVIDENCE_UNAVAILABLE");
  expect(bundleFenceOmissionCount(bundle)).toBe(3);
});

it("W-FENCE-13 (guard): a checkpoint read whose allowance ran out while lines were left out is told as left out (not known now, never settled)", async () => {
  const one = complete("FB_SPENT_YANKEE first line."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("FB_SPENT_ZULU second line."); refreshMemoryCheckpoint(two.jobId);
  hide(one.messageId);
  // the reader's rule leaves the other line out while spending the turn's whole allowance (a lineage walk not paid for): every line is
  // left out, but the read's answer is the limit error ("not known now")
  const bundle = await bundleOf(access(), (_thread: string, _message: string, allowance?: unknown) => { (allowance as LineageAllowance).spendRows("", 1_000_000); return true; });
  expect(bundle.checkpoint).toEqual([]);
  expect(bundle.text).not.toMatch(/FB_SPENT_(YANKEE|ZULU)/);
  // guard (green on fc667b8b10 too: here the spend throws the limit error inside the walk, before settledEmpty is set); the bundle.ts
  // limit check covers a read that returns a refusal after its allowance ran out, which this fixture does not reach (declared gap)
  expect(bundle.degradedReason).toBe("MEMORY_OPTIONAL_EVIDENCE_UNAVAILABLE");
});

