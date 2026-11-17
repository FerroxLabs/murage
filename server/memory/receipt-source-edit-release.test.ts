import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { releaseProbe } from "../testing/baseline-contract.ts";
import { writeClaudePrompt } from "../testing/claude-release-fixture.ts";
import { openTurnLineage, closeTurnLineage } from "./lineage-write.ts";
import { prepareRetainedFence } from "./send-fence.ts";
import type { TurnLineage } from "./lineage-types.ts";
import { fencedTurnInput } from "../drivers/engine-input.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 7C s11 (P1, shipped-leak rows): a receipt built from a real recall hit must read withheld once the words under it change through the REAL
// product paths: captureSource with changed text (revision 1 to 2) and updateMessage on an owner line (commitRevoke kind line, cause edit,
// which writes deny marks and flips no receipt). Four audience readers; the control row proves the receipt reads shown before the change.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "../human-principals.ts";
import { updateMessage } from "../message-db.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { fixtureMemoryAccess as memoryAccess } from "../testing/recall-access-fixture.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { captureSource } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { refsLookup } from "./deny-read.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
import { runRevocationJobsNow } from "./memory-revocation.ts";

const roster = {
  bots: [{ id: "reed", threadId: "reed-direct" }, { id: "cole", threadId: "cole-direct" }],
  groups: [{ id: "launch", threadId: "launch-chat", memberIds: ["reed", "cole"] }, { id: "guest-room", threadId: "guest-chat", memberIds: ["reed"] }],
} as unknown as MemoryRoster;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryCaptureRoster(() => roster); });

function access(thread: string, options: { notOwnerAudience?: boolean; human?: ReturnType<typeof resolveHumanBinding> } = {}) {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin("reed", thread, "g", options.human);
  const token = registry.mint({ botId: "reed", threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false,
    ...(options.notOwnerAudience ? { notOwnerAudience: true } : {}), ...(options.human ? { humanPrincipal: options.human } : {}) });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
function guest() {
  reconcileMemoryRoster(roster);
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: "guest" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  const human = resolveHumanBinding(binding); bindHumanThread("guest-chat", human); return human;
}
const turns: TurnLineage[] = [];
const READERS = ["direct-owner", "direct-unproven", "channel-person", "owner-room", "non-owner-room"] as const;
const CHANGES = ["source-revision", "owner-line-edit"] as const;

it.each(READERS.flatMap(reader => CHANGES.map(change => ({ reader, change }))))("T-RECEIPT-EDIT $reader receipt reads withheld after $change", async ({ reader, change }) => {
  const thread = (reader === "direct-unproven" || reader === "direct-owner") ? "reed-direct" : reader === "channel-person" ? "guest-chat" : "launch-chat";
  const acc = reader === "direct-unproven" ? access(thread, { notOwnerAudience: true }) : reader === "channel-person" ? access(thread, { human: guest() })
    : access(thread, reader === "non-owner-room" ? { notOwnerAudience: true } : {});
  const text = "Tallyroo launches on the 14th with the annual plan.";
  storeAnchorMessage(database(), thread, "m1", text);
  captureSource(database(), { id: "s1", threadId: thread, messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  const record = saveMemoryCandidate(text, [{ sourceId: "s1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k1", acc);
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  const bundle = await buildMemoryBundle("when does Tallyroo launch", acc, { async search() { return { hits: [{ id: record, version: 1, score: 1, lexical: true }], vectorRows: 0, coverageComplete: false }; } }, { allowance: LineageAllowance.tool() });
  expect(bundle.text, "the receipt rests on a real recall hit").toContain("Tallyroo launches");
  new MemoryDispatchReceipt(bundle, acc, "driver");
  const audience = reader === "direct-owner" ? null : { owner: reader === "owner-room", scopeIds: [...acc.scopeIds] };
  const lsn = Number(database().prepare("SELECT next FROM memory_lsn WHERE id=1").get()?.next ?? 1) + 1000;
  const verdict = () => refsLookup(database(), [{ kind: "receipt", bundleId: bundle.bundleId, lsn, scopeIds: [...acc.scopeIds] }], { audience });
  expect(JSON.stringify(verdict()), "control: reads shown before the change (" + reader + " " + change + ")").toBe(JSON.stringify({ state: "shown" }));
  const turn = openTurnLineage(database(), { threadId: thread, turnId: "receipt-edit-probe" }); turns.push(turn);
  const retainedReader = prepareRetainedFence(turn, { audience }, () => {}, database());
  const prompt = buildPrompt(turn, [promptPart(releaseProbe.marker, [{ kind: "receipt", bundleId: bundle.bundleId, lsn, scopeIds: [...acc.scopeIds] }])]);
  const send = () => writeClaudePrompt(fencedTurnInput({ threadId: thread, prompt }, { reader: retainedReader, db: database(), retained: turn }));
  await send(); expect(releaseProbe.writes).toBe(1);
  if (change === "source-revision") captureSource(database(), { id: "s1", threadId: thread, messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text: text + " Changed." });
  else updateMessage(thread, { id: "m1", at: Date.now(), role: "user", kind: "text", text: "Something else entirely." } as never);
  await send().catch(() => undefined);
  expect(releaseProbe.writes, "actual stdin after real product source edit").toBe(1);
  expect(verdict().state, "withheld right after the change").not.toBe("shown");
  runRevocationJobsNow(database());
  expect(verdict().state, "withheld after every revocation job ran").not.toBe("shown");
});

afterEach(() => { turns.splice(0).forEach(closeTurnLineage); closeDatabase(); releaseProbe.writes = 0; releaseProbe.atWrite = undefined; });

useOutsideStoreFixture();
