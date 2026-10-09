// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.1 hotfix: after a memory continuation reset in the owner's own direct
// chat, the fresh engine session was replayed every owner line and none of
// the bot's own replies. A roster or settings change revokes every receipt
// across the install (revokeAllDisclosures), every reply of a resumed session
// is linked to every receipt of that session, and the direct replay judged
// replies through filterMemoryReplay, whose receipt state check then withheld
// all of them, silently. The owner's direct chat now follows the room rule:
// a reply is withheld only when content it used was forgotten, deleted or
// changed, and then it stays in place as a visible withheld line.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { continuationMemoryRevoked, filterDirectReplay } from "./disclosures.ts";
import { revokeAllDisclosures } from "./revocation.ts";
import { recordSessionRoots } from "./replay-lineage.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

const roster: MemoryRoster = { bots: [{ id: "sable", threadId: "sable-direct", section: "office" }], groups: [] };
function access(notOwnerAudience = false) {
  const registry = new InternalCapabilities();
  const generation = registry.begin("sable", "sable-direct");
  const token = registry.mint({ botId: "sable", threadId: "sable-direct", generation, kind: "memory", depth: 0, skillAuthoring: false, ...(notOwnerAudience ? { notOwnerAudience: true as const } : {}) });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
type M = { id: string; role: string; kind: string; text: string; at: number; from?: { name: string }; replyToId?: string };
const owner = (id: string, replyToId?: string): M => ({ id, role: "user", kind: "text", text: `owner ${id}`, at: 1_700_000_000_000, ...(replyToId ? { replyToId } : {}) });
const reply = (id: string): M => ({ id, role: "bot", kind: "text", text: `sable ${id}`, at: 1_700_000_000_000, from: { name: "Sable" } });
function receipt(a: { policyRevision: number; deletionEpoch: number }, id: string, records: Array<{ id: string; version: number }>, outputs: string[], at: number) {
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,0,'delivered',?)")
    .run(id, "sable-direct", "claude", "S-1", JSON.stringify(records), "[]", JSON.stringify(outputs), a.policyRevision, a.deletionEpoch, at);
}
function record(id: string) {
  const scope = ensureScope("bot", "sable");
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'source',?,'owner-statement','active',0,1,NULL,NULL,1)").run(id, scope, `fact ${id}`);
}
/** One native session: every reply is linked to every receipt before it
 * (linkMemoryDisclosureOutput), as a resumed Claude session is. */
function session(a: { policyRevision: number; deletionEpoch: number }, turns: number): M[] {
  const messages: M[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    messages.push(owner(`o${turn}`), reply(`r${turn}`));
    record(`fact-${turn}`);
    receipt(a, `R${turn}`, [{ id: `fact-${turn}`, version: 1 }], [], turn);
  }
  for (let turn = 1; turn <= turns; turn++) database().prepare("UPDATE memory_disclosures SET output_message_ids=? WHERE bundle_id=?")
    .run(JSON.stringify(Array.from({ length: turns - turn + 1 }, (_, i) => `r${turn + i}`)), `R${turn}`);
  recordSessionRoots("sable-direct", "claude", "S-1", { roots: new Set(), over: false });
  return messages;
}
/** What policy.ts does on a roster change: a new policy revision and every receipt revoked. */
function rosterChange() {
  database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
  revokeAllDisclosures(database(), "roster");
}
const marker = (message: M, forgotten: boolean) => `[withheld${forgotten ? " forgotten" : ""}] (${message.from?.name ?? "Bot"})`;

it("after a roster change resets the session, the owner's direct chat replays the bot's own replies, not only the owner's lines", () => {
  reconcileMemoryRoster(roster);
  const messages = session(access(), 5);
  rosterChange();
  const a = access();
  const why: { reason?: string } = {};
  // the live log's reset: memory-changed (receipt-already-revoked)
  expect(continuationMemoryRevoked("sable-direct", "claude", "S-1", a, why)).toBe(true);
  expect(why.reason).toBe("memory-changed (receipt-already-revoked)");
  const { replayed, withheld } = filterDirectReplay("sable-direct", messages, a, new Set(), { withheldLine: marker });
  expect(replayed.map(m => m.id)).toEqual(["o1", "r1", "o2", "r2", "o3", "r3", "o4", "r4", "o5", "r5"]);
  expect(replayed.find(m => m.id === "r5")?.text).toBe("sable r5");
  expect(withheld.size).toBe(0);
  // without a line to show, nothing is dropped either
  expect(filterDirectReplay("sable-direct", messages, a, new Set()).replayed.filter(m => m.role === "bot")).toHaveLength(5);
});

it("a reply whose content the owner forgot stays in its place as a withheld line, and a quote of it reads that line", () => {
  reconcileMemoryRoster(roster);
  const messages = session(access(), 3);
  messages.push(owner("o4", "r2"));
  rosterChange();
  // the record reply r2's own turn used (R2) is forgotten: r2 and r3 rest on it
  database().prepare("UPDATE memory_records SET state='deleted' WHERE id='fact-2'").run();
  const { replayed, allowed, withheld } = filterDirectReplay("sable-direct", messages, access(), new Set(), { withheldLine: marker });
  expect(replayed.map(m => m.id)).toEqual(["o1", "r1", "o2", "r2", "o3", "r3", "o4"]);
  expect([...withheld].sort()).toEqual(["r2", "r3"]);
  expect(replayed.find(m => m.id === "r2")?.text).toBe("[withheld] (Sable)");
  expect(replayed.find(m => m.id === "r1")?.text).toBe("sable r1");
  expect(allowed.find(m => m.id === "r2")?.text).toBe("[withheld] (Sable)");
});

it("words nobody proved are the owner's keep the receipt fence: revoked receipts withhold the replies", () => {
  reconcileMemoryRoster(roster);
  const messages = session(access(), 3);
  rosterChange();
  const { replayed } = filterDirectReplay("sable-direct", messages, access(true), new Set(), { withheldLine: marker });
  expect(replayed.map(m => m.id)).toEqual(["o1", "o2", "o3"]);
});
