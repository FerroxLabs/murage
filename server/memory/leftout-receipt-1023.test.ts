// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1023-leftout W-RECEIPT (MAIN-RULING 2026-11-26T23:34:31Z; owner of both sides: q1023-leftout, rulings: MAIN).
// Banner run 12d08fbe19 t2/t3, read again with codes only (q1023-leftout-r2/diag, run A3): the turn's bundle kept the conversation's
// checkpoint with the owner-hidden line left out (1.0.23 fencebundle), and the send fence then refused the turn's own memory receipt
// withheld:deny-memory: the receipt's one record was that checkpoint (active, 4 evidence sources, 3 cited and shown, 1 left out, no mark
// of its own), judged whole by contentReceiptVerdict through the deny rule. The send was refused, rebuilt, refused again, and the reply
// went out from the message alone.
// ENTRY POINT: the retained send fence itself, as a dispatch reaches it. MemoryDispatchReceipt (dispatch.ts, what index.ts builds for every
// turn that carries a bundle) joins the turn's receipt to the open turn; the join is validated by the fence prepareRetainedFence bound
// (send-fence.ts checkRetainedFence -> deny-read.ts refsLookup -> contentReceiptVerdict), and assertRetainedFence is the check every
// later release of that turn runs. This is the banner run's own refusal stack (send-fence.ts retainedRefusal <- checkRetainedFence <-
// the bound validate <- lineage-write.ts proposeTurnParents). Not the HTTP route: a store made by this release rolls the checkpoint
// before the next turn's bundle is built, so the state does not arise there.
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
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { openTurnLineage, writeLineage } from "./lineage-write.ts";
import { assertRetainedFence, prepareRetainedFence } from "./send-fence.ts";
import { memoryLookup } from "./deny-read.ts";
import { memoryRefKey } from "./lineage-types.ts";

const threadId = "6c2e7b1f-3d5a-4f9b-8e4c-8b2d1f3a5c7e";
const roster = { bots: [{ id: "bot", threadId }], groups: [] };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); setMemoryMode("capture"); });
// the same real steps fencebundle-1023.test.ts takes: a stored owner line with its lineage row, captured by a real capture job
function complete(text: string) {
  const id = `message:${threadId}:${randomUUID()}`, messageId = randomUUID();
  storeAnchorMessage(database(), threadId, messageId, text, "user");
  writeLineage(database(), { threadId, messageId, author: "owner" }, {});
  captureSource(database(), { id, threadId, messageId, origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text });
  const work = claimMemoryJob("leftout-worker");
  if (!work) throw new Error("fixture did not claim a real capture job");
  publishMemoryWork(work, "leftout-worker", captureWork(work));
  return { id, jobId: work.id, messageId };
}
function access() { const registry = new InternalCapabilities(), generation = registry.begin("bot", threadId), token = registry.mint({ botId: "bot", threadId, generation, depth: 0, kind: "memory", skillAuthoring: false }); return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster); }
/** The owner hides one chat line: the transcript hide's two steps, the walk run to the end (settled). */
function hide(messageId: string) {
  database().prepare("UPDATE messages SET json=json_set(json,'$.withheldFromBots',json('true')) WHERE thread_id=? AND id=?").run(threadId, messageId);
  commitRevoke(database(), { kind: "line", threadId, messageIds: [messageId], cause: "hide" }); drainRevokeMarker(database());
}
const ownVerdict = (id: string, version: number) => memoryLookup(database(), [{ kind: "record", id, version }], { audience: null }).get(memoryRefKey({ kind: "record", id, version }));
const bundleOf = (reader = access()) => buildMemoryBundle("what are we doing", reader, { search: async () => ({ hits: [], vectorRows: 0 }) }, { allowance: LineageAllowance.tool() });
type Reader = ReturnType<typeof access>; type Bundle = Awaited<ReturnType<typeof bundleOf>>;
/** One owner direct turn up to its send: the open turn with its retained fence bound for the owner's content reader (index.ts
 * finalizeDirectReader), then the turn's memory receipt joined as dispatch joins it. "sent" when the fence let it through; otherwise the
 * refusal the turn would be rebuilt for. `again` is the fence's check at a later release of the same turn. */
function sendTurn(bundle: Bundle, reader: Reader) {
  const db = database(), turn = openTurnLineage(db, { threadId, turnId: randomUUID() });
  const told: string[] = [];
  const outcome = (work: () => void): string => {
    try { work(); return "sent"; }
    catch (error) { const fence = (error as { fence?: { state?: string; reason?: string } }).fence; return `${(error as Error).message}:${fence?.state}:${fence?.reason}`; }
  };
  prepareRetainedFence(turn, { audience: null }, verdict => { told.push(`${verdict.state}:${"reason" in verdict ? verdict.reason : ""}`); }, db);
  return { first: outcome(() => { new MemoryDispatchReceipt(bundle, reader, "fixture-driver", turn); assertRetainedFence(turn, db); }), again: () => outcome(() => assertRetainedFence(turn, db)), told };
}

it("W-RECEIPT-1: a turn whose bundle kept a checkpoint without its hidden line passes the retained send fence with its receipt", async () => {
  const one = complete("LO_KEEP_ALPHA the release notes go out on Monday."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("LO_HIDDEN_BRAVO my locker code is behind the clock."); refreshMemoryCheckpoint(two.jobId);
  const three = complete("LO_KEEP_CHARLIE the demo uses the staging bot."); const head = refreshMemoryCheckpoint(three.jobId);
  hide(two.messageId);
  const reader = access(), bundle = await bundleOf(reader);
  const text = bundle.checkpoint.map(record => record.text).join("\n");
  // setup proof (not the witness): the banner run's state. The checkpoint record itself reads withheld deny-memory, the bundle kept it
  // without the hidden line, and the receipt cites the shown lines' sources only
  expect({ own: ownVerdict(head.checkpointId!, head.version!), kept: text.includes("LO_KEEP_ALPHA") && text.includes("LO_KEEP_CHARLIE"), hidden: bundle.text.includes("LO_HIDDEN_BRAVO"), citesHidden: bundle.sourceVersions.some(version => version.id === two.id) })
    .toEqual({ own: { state: "withheld", reason: "deny-memory" }, kept: true, hidden: false, citesHidden: false });
  const turn = sendTurn(bundle, reader);
  // THE WITNESS: the send fence lets the turn's receipt through, and nothing is told as refused (RED on base:
  // MEMORY_CONTEXT_REVOKED withheld deny-memory, the refusal the banner run rebuilt twice and then sent from the message alone)
  expect({ first: turn.first, told: turn.told }).toEqual({ first: "sent", told: [] });
});

it("W-RECEIPT-2: a turn whose receipt showed the line is refused at its next release once the owner hides it (only lines not shown are excused)", async () => {
  const one = complete("LO_KEEP_ALPHA the release notes go out on Monday."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("LO_HIDDEN_BRAVO my locker code is behind the clock."); refreshMemoryCheckpoint(two.jobId);
  const reader = access(), bundle = await bundleOf(reader);
  expect(bundle.text).toContain("LO_HIDDEN_BRAVO");
  const turn = sendTurn(bundle, reader);
  expect(turn.first).toBe("sent");
  hide(two.messageId);
  // the cited line itself is denied: the turn's next release is refused on that line, whatever the checkpoint rule says
  expect(turn.again()).toBe("MEMORY_CONTEXT_REVOKED:withheld:deny-line");
});

it("W-RECEIPT-3: a mark on the checkpoint that no left-out line explains still refuses the turn (the owner forgot the record itself)", async () => {
  const one = complete("LO_KEEP_ALPHA the release notes go out on Monday."); refreshMemoryCheckpoint(one.jobId);
  const two = complete("LO_HIDDEN_BRAVO my locker code is behind the clock."); refreshMemoryCheckpoint(two.jobId);
  const three = complete("LO_KEEP_CHARLIE the demo uses the staging bot."); const head = refreshMemoryCheckpoint(three.jobId);
  hide(two.messageId);
  const reader = access(), bundle = await bundleOf(reader);
  const turn = sendTurn(bundle, reader);
  expect(turn.first).toBe("sent");
  // a revoke of its own on the record (another revoke id than the hidden line's): the same row fencebundle-1023.test.ts W-FENCE-4 writes
  const table = database().prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_deny_object'").get() ? "memory_deny_object" : "memory_deny_memory";
  database().prepare(`INSERT INTO ${table}(kind,id,version,revoke_id) VALUES('record',?,?,?)`).run(head.checkpointId!, head.version!, 987654);
  expect(turn.again()).toBe("MEMORY_CONTEXT_REVOKED:withheld:deny-memory");
});
