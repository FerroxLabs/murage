// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P1 (owner-authored Continuity), server side, in-process: the identity
// writer and deleter, the pre-rank projection, the identity slot (order, labels,
// budget, omission count), pin refusal, no global reset from one bot's edits,
// rooms and project desks, and restore. Synthetic fixture text only.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket, pinMemory } from "./authority.ts";
import { memoryAccess, reconcileMemoryRoster, assertMemoryAccess } from "./policy.ts";
import { botIdentityRecordId, deleteBotIdentity, readContinuity, recordContinuityCoverage, writeBotIdentity, type IdentityWrite } from "./identity.ts";
import { buildMemoryBundle, MEMORY_FRAME_TOKENS } from "./bundle.ts";
import { MemoryEligibility } from "./eligibility.ts";
import { searchMemory } from "./search.ts";
import { recentMemoryHits } from "./recent.ts";
import { memoryAgentRoute } from "./routes.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { MemoryDispatchReceipt, memoryContinuationChanged } from "./dispatch.ts";
import { setMemoryMode } from "./repository.ts";
import { pauseRestoredMemory } from "./restore.ts";
import type { IndexHit } from "./index.ts";

const roster = {
  bots: [
    { id: "moss", threadId: "private", tasks: [{ threadId: "new-task" }, { threadId: "desk", channelProjectDesk: { groupId: "proj" } }] },
    { id: "neutral", threadId: "neutral-thread" },
  ],
  groups: [
    { id: "room", threadId: "room-thread", memberIds: ["moss", "neutral"] },
    { id: "proj", threadId: "proj-thread", memberIds: ["moss"], channelProject: {} },
  ],
};
const ticket = ownerMemoryTicket();
const emptyBridge = { search: async () => ({ hits: [] as IndexHit[], vectorRows: 0 }) };
let eligibility: MemoryEligibility | undefined;

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); });
afterEach(() => { eligibility?.close(); eligibility = undefined; });

function pip(kind: "commitment" | "self-trait" | "relation", key: string, text: string, patch: Partial<IdentityWrite> = {}): IdentityWrite {
  return { action: "identity-write", botId: "moss", kind, key, expectedVersion: 0, text, basis: "owner-fact", audience: "owner-private", ...patch };
}
function brief(text = "Moss keeps the harbour log and answers briefly.", botId = "moss", expectedVersion = 0): IdentityWrite {
  // An edit names the record id it saw (the brief re-created after a delete is a new generation); generation 0 here.
  return { action: "identity-write", botId, kind: "continuity-brief", key: "core", expectedVersion, ...(expectedVersion > 0 ? { expectedId: botIdentityRecordId(botId, "continuity-brief", "core") } : {}), text, basis: "fiction", audience: "owner-private" };
}
function access(botId = "moss", threadId = "private") {
  const registry = new InternalCapabilities(), generation = registry.begin(botId, threadId);
  const token = registry.mint({ botId, threadId, generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const meta = () => database().prepare("SELECT policy_revision,deletion_epoch,data_revision FROM memory_meta WHERE id=1").get() as { policy_revision: number; deletion_epoch: number; data_revision: number };
/** Distinct, ordered edit times so "most recently edited first" is testable. */
function stamp(id: string, at: number) { database().prepare("UPDATE memory_records SET created_at=? WHERE id=? AND state='active'").run(at, id); }
function botScope() { return String(database().prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key='moss'").get()!.id); }
let factSeq = 0;
/** An ordinary current fact in moss's scope (no sources; owner statement). */
function fact(text: string) {
  const id = `fixture-fact-${++factSeq}`;
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,NULL,NULL,?)").run(id, botScope(), text, Date.now(), Date.now());
  return id;
}
/** A lexical ranker over the real eligibility predicate, so exclusion that
 * happens before ranking is observable as a top-k that is unchanged. */
function rankedBridge() {
  eligibility = new MemoryEligibility(join(DATA_DIR, "messages.db"));
  return {
    async search(input: { query: string; scopeIds: string[]; policyRevision: number; deletionEpoch: number; historical: boolean; cursor: string; limit: number }) {
      const { allowed } = eligibility!.read(input);
      const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = allowed.map(row => {
        const text = String(database().prepare("SELECT text FROM memory_records WHERE id=? AND version=?").get(row.id, row.version)!.text).toLowerCase();
        return { id: row.id, version: row.version, score: terms.reduce((sum, term) => sum + text.split(term).length - 1, 0), lexical: true };
      }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return { hits: scored.slice(0, input.limit) as IndexHit[], vectorRows: 0 };
    },
  };
}
const kinds = (bundle: { identity: Array<{ kind: string }> }) => bundle.identity.map(record => record.kind);

describe("PIP P1 writes", () => {
  it("is owner-only, validates keys and sizes, and refuses fiction basis, canon and reveal fields", () => {
    expect(() => writeBotIdentity({}, pip("commitment", "ship-it", "x"), roster)).toThrow("MEMORY_OWNER_REQUIRED");
    for (const bad of ["Ship", "ship_it", "ship it", "", "x".repeat(49), "é"]) expect(() => writeBotIdentity(ticket, pip("commitment", bad, "x"), roster), bad).toThrow(/MEMORY_IDENTITY_PIP_KEY_INVALID|INVALID|regex|string/i);
    expect(() => writeBotIdentity(ticket, pip("relation", "other", "x"), roster)).toThrow("MEMORY_IDENTITY_PIP_KEY_INVALID");
    expect(() => writeBotIdentity(ticket, pip("self-trait", "calm", "x", { basis: "fiction" }), roster)).toThrow("MEMORY_IDENTITY_PIP_BASIS_INVALID");
    expect(() => writeBotIdentity(ticket, pip("self-trait", "calm", "x", { canon: { id: "a", version: 1 } }), roster)).toThrow("MEMORY_IDENTITY_REVEAL_INVALID");
    expect(() => writeBotIdentity(ticket, pip("self-trait", "calm", "é".repeat(2049)), roster)).toThrow("MEMORY_IDENTITY_TEXT_LIMIT");
    expect(() => writeBotIdentity(ticket, pip("self-trait", "calm", "   "), roster)).toThrow("MEMORY_IDENTITY_TEXT_LIMIT");
    expect(() => writeBotIdentity(ticket, pip("self-trait", "calm", "x", { botId: "nobody" }), roster)).toThrow("MEMORY_SUBJECT_UNKNOWN");
    expect(writeBotIdentity(ticket, pip("self-trait", "calm", "é".repeat(2048)), roster)).toMatchObject({ version: 1 });
    expect(writeBotIdentity(ticket, pip("relation", "owner", "We plan on Mondays."), roster)).toMatchObject({ version: 1 });
  });

  it("sets the identity partition and the attested basis in the same transaction, and supersedes to one active version", () => {
    // A failure after the insert rolls the whole row back: nothing ever sat
    // readable with the trigger's default 'semantic' partition.
    database().exec("CREATE TRIGGER pip_fail BEFORE UPDATE ON memory_record_details WHEN NEW.partition='identity' AND NEW.record_id LIKE 'identity:%' BEGIN SELECT RAISE(ABORT,'pip-test-abort'); END;");
    expect(() => writeBotIdentity(ticket, pip("commitment", "call-back", "Call back on Friday."), roster)).toThrow("pip-test-abort");
    expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE kind='commitment'").get()!.n).toBe(0);
    expect(database().prepare("SELECT count(*) AS n FROM memory_record_details d JOIN memory_records r ON r.id=d.record_id AND r.version=d.record_version WHERE r.kind='commitment'").get()!.n).toBe(0);
    database().exec("DROP TRIGGER pip_fail");
    const first = writeBotIdentity(ticket, pip("commitment", "call-back", "Call back on Friday."), roster);
    writeBotIdentity(ticket, pip("commitment", "call-back", "Call back on Saturday.", { expectedVersion: 1 }), roster);
    writeBotIdentity(ticket, pip("commitment", "call-back", "Call back on Sunday.", { expectedVersion: 2 }), roster);
    expect(() => writeBotIdentity(ticket, pip("commitment", "call-back", "stale", { expectedVersion: 1 }), roster)).toThrow("MEMORY_VERSION_CONFLICT");
    expect(database().prepare("SELECT version,state FROM memory_records WHERE id=? ORDER BY version").all(first.id)).toEqual([{ version: 1, state: "superseded" }, { version: 2, state: "superseded" }, { version: 3, state: "active" }]);
    const details = database().prepare("SELECT partition,confidence_basis,entities FROM memory_record_details WHERE record_id=? AND record_version=3").get(first.id)!;
    expect(details).toMatchObject({ partition: "identity", confidence_basis: "pip:attested; Owner-authored continuity; not independently verified" });
    // P2 §1.2: edits retain the parsed claim and advance its generation;
    // the third owner edit reinforces that generation at its write time.
    const editedAt = database().prepare("SELECT created_at FROM memory_records WHERE id=? AND version=3").get(first.id)!.created_at;
    expect(JSON.parse(String(details.entities))).toEqual(["owner-private", "call-back", "claim:null", "gen:3", `reinforcedAt:${editedAt}`]);
    expect(database().prepare("SELECT count(*) AS n FROM memory_evidence WHERE record_id=?").get(first.id)!.n).toBe(0);
  });

  it("caps ACTIVE keys per kind at 24, refuses the 25th, frees a slot on delete, and counts kinds separately", () => {
    for (let n = 0; n < 24; n++) writeBotIdentity(ticket, pip("commitment", `c-${n}`, `Commitment ${n}.`), roster);
    expect(() => writeBotIdentity(ticket, pip("commitment", "c-24", "One too many."), roster)).toThrow("MEMORY_IDENTITY_PIP_CAP");
    // an edit of an existing key is not a new key
    expect(writeBotIdentity(ticket, pip("commitment", "c-3", "Edited.", { expectedVersion: 1 }), roster)).toMatchObject({ version: 2 });
    // traits count on their own
    expect(writeBotIdentity(ticket, pip("self-trait", "t-0", "A trait."), roster)).toMatchObject({ version: 1 });
    deleteBotIdentity(ticket, { action: "identity-delete", botId: "moss", kind: "commitment", key: "c-0", expectedVersion: 1 }, roster);
    expect(writeBotIdentity(ticket, pip("commitment", "c-24", "Now it fits."), roster)).toMatchObject({ version: 1 });
    expect(() => writeBotIdentity(ticket, pip("commitment", "c-25", "Full again."), roster)).toThrow("MEMORY_IDENTITY_PIP_CAP");
  });
});

describe("PIP P1 singleton relation survives delete", () => {
  it("create, delete, create again: the new text is read and delivered; the old tombstone stays; slugs stay retired", async () => {
    writeBotIdentity(ticket, brief(), roster);
    const first = writeBotIdentity(ticket, pip("relation", "owner", "We plan on Mondays."), roster);
    expect(first.id).toBe(botIdentityRecordId("moss", "relation", "owner"));
    deleteBotIdentity(ticket, { action: "identity-delete", botId: "moss", kind: "relation", key: "owner", expectedVersion: 1, expectedId: first.id }, roster);
    // repeating the delete: the id it names is no longer the live generation, so it is fenced off
    expect(() => deleteBotIdentity(ticket, { action: "identity-delete", botId: "moss", kind: "relation", key: "owner", expectedVersion: 1, expectedId: first.id }, roster)).toThrow("MEMORY_VERSION_CONFLICT");
    const second = writeBotIdentity(ticket, pip("relation", "owner", "We plan on Tuesdays."), roster);
    expect(second.id).not.toBe(first.id);
    expect(second.version).toBe(1);
    expect(database().prepare("SELECT count(*) AS n FROM memory_tombstones WHERE target_type='record' AND target_id=?").get(first.id)!.n).toBe(1);
    expect(database().prepare("SELECT state FROM memory_records WHERE id=?").all(first.id).every(row => row.state === "deleted")).toBe(true);
    const read = readContinuity(ticket, "moss", roster).records.filter(row => row.kind === "relation");
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ id: second.id, key: "owner", text: "We plan on Tuesdays." });
    const bundle = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(bundle.text).toContain("We plan on Tuesdays.");
    expect(bundle.text).not.toContain("We plan on Mondays.");
    expect(bundle.recordVersions.map(row => row.id)).toContain(second.id);
    // edit, delete and re-create again: a third generation, both earlier tombstones kept
    writeBotIdentity(ticket, pip("relation", "owner", "We plan on Wednesdays.", { expectedVersion: 1, expectedId: second.id }), roster);
    deleteBotIdentity(ticket, { action: "identity-delete", botId: "moss", kind: "relation", key: "owner", expectedVersion: 2, expectedId: second.id }, roster);
    const third = writeBotIdentity(ticket, pip("relation", "owner", "We plan on Thursdays."), roster);
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(database().prepare("SELECT count(*) AS n FROM memory_tombstones WHERE target_type='record'").get()!.n).toBe(2);
    // a deleted self-trait slug stays retired
    writeBotIdentity(ticket, pip("self-trait", "calm", "Stays calm."), roster);
    deleteBotIdentity(ticket, { action: "identity-delete", botId: "moss", kind: "self-trait", key: "calm", expectedVersion: 1 }, roster);
    expect(() => writeBotIdentity(ticket, pip("self-trait", "calm", "Again."), roster)).toThrow("MEMORY_RECORD_UNAVAILABLE");
  });
});

describe("PIP P1 delete", () => {
  it("deletes every version with one record tombstone, retires the slug, and leaves the installation epochs alone", async () => {
    writeBotIdentity(ticket, brief(), roster);
    const first = writeBotIdentity(ticket, pip("self-trait", "dry-humour", "Dry humour, never sarcasm."), roster);
    writeBotIdentity(ticket, pip("self-trait", "dry-humour", "Dry humour, rarely.", { expectedVersion: 1 }), roster);
    const before = meta();
    expect(() => deleteBotIdentity({}, { action: "identity-delete", botId: "moss", kind: "self-trait", key: "dry-humour", expectedVersion: 2 }, roster)).toThrow("MEMORY_OWNER_REQUIRED");
    expect(() => deleteBotIdentity(ticket, { action: "identity-delete", botId: "moss", kind: "self-trait", key: "missing", expectedVersion: 1 }, roster)).toThrow("MEMORY_NOT_FOUND");
    expect(deleteBotIdentity(ticket, { action: "identity-delete", botId: "moss", kind: "self-trait", key: "dry-humour", expectedVersion: 2 }, roster)).toEqual({ id: first.id, deleted: true });
    expect(meta()).toEqual(before);
    expect(database().prepare("SELECT version,state FROM memory_records WHERE id=? ORDER BY version").all(first.id)).toEqual([{ version: 1, state: "deleted" }, { version: 2, state: "deleted" }]);
    expect(database().prepare("SELECT target_type,revision FROM memory_tombstones WHERE target_id=?").all(first.id)).toEqual([{ target_type: "record", revision: null }]);
    expect(database().prepare("SELECT count(*) AS n FROM memory_tombstones WHERE target_type='source'").get()!.n).toBe(0);
    // continuity rows never had a projection receipt: nothing of them is queued for the shared index
    expect(database().prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE record_id=?").get(first.id)!.n).toBe(0);
    // historical eligibility and historical search exclude every version, superseded included
    const bridge = rankedBridge();
    for (const historical of [false, true]) {
      const ids = eligibility!.read({ scopeIds: [botScope()], policyRevision: meta().policy_revision, deletionEpoch: meta().deletion_epoch, historical, cursor: "" }).allowed.map(row => row.id);
      expect(ids).not.toContain(first.id);
    }
    expect((await searchMemory("dry humour", access(), bridge, { historical: true })).hits).toEqual([]);
    // even with the kind filter out of the picture, the state filter alone drops every version
    expect(database().prepare("SELECT count(*) AS n FROM memory_records r WHERE r.id=? AND r.state IN ('active','archived','superseded')").get(first.id)!.n).toBe(0);
    // the slug stays retired; the brief rebuilds without the trait
    expect(() => writeBotIdentity(ticket, pip("self-trait", "dry-humour", "Again.", { expectedVersion: 2 }), roster)).toThrow("MEMORY_RECORD_UNAVAILABLE");
    const bundle = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(bundle.text).not.toContain("Dry humour");
    expect(kinds(bundle)).toEqual(["continuity-brief"]);
  });

  it("is reachable through the owner route and the continuity listing", async () => {
    await memoryOwnerRoute("/api/memory/action", pip("commitment", "water-plants", "Water the plants on Tuesday."), ticket, roster);
    await memoryOwnerRoute("/api/memory/action", brief(), ticket, roster);
    const listed = await memoryOwnerRoute("/api/memory/action", { action: "continuity-read", botId: "moss" }, ticket, roster) as ReturnType<typeof readContinuity>;
    expect(listed.records.map(row => [row.kind, row.key])).toEqual([["commitment", "water-plants"], ["continuity-brief", "core"]]);
    expect(listed.records[0]).toMatchObject({ version: 1, text: "Water the plants on Tuesday." });
    expect(listed.limits).toEqual({ perKind: 24, bytes: 4096, briefBytes: 768 });
    expect(listed.coverage).toBeNull();
    await expect(memoryOwnerRoute("/api/memory/action", { action: "continuity-read", botId: "moss" }, {}, roster)).rejects.toThrow("MEMORY_OWNER_REQUIRED");
    // the brief is a PIP kind with the same version-fenced delete (P2)
    await expect(memoryOwnerRoute("/api/memory/action", { action: "identity-delete", botId: "moss", kind: "continuity-brief", key: "core", expectedVersion: 5, expectedId: botIdentityRecordId("moss", "continuity-brief", "core") }, ticket, roster)).rejects.toThrow("MEMORY_VERSION_CONFLICT");
    await expect(memoryOwnerRoute("/api/memory/action", { action: "identity-delete", botId: "moss", kind: "commitment", key: "water-plants", expectedVersion: 1 }, {}, roster)).rejects.toThrow("MEMORY_OWNER_REQUIRED");
    expect(await memoryOwnerRoute("/api/memory/action", { action: "identity-delete", botId: "moss", kind: "commitment", key: "water-plants", expectedVersion: 1 }, ticket, roster)).toMatchObject({ deleted: true });
    expect((await memoryOwnerRoute("/api/memory/action", { action: "continuity-read", botId: "moss" }, ticket, roster) as ReturnType<typeof readContinuity>).records).toHaveLength(1);
  });
});

describe("PIP P1 identity slot", () => {
  function seed(withBrief = true) {
    const ids: Record<string, string> = {};
    ids.brief = withBrief ? writeBotIdentity(ticket, brief(), roster).id : botIdentityRecordId("moss", "continuity-brief", "core");
    const canon = writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "character-canon", key: "lamp", expectedVersion: 0, text: "CANON_HIDDEN the keeper hid a brass key.", basis: "fiction", audience: "owner-private" }, roster);
    ids.reveal = writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "reveal-state", key: "lamp", expectedVersion: 0, text: "REVEAL_NOTE the owner heard about the key.", basis: "fiction", audience: "owner-private", canon: { id: canon.id, version: 1 }, revealed: true }, roster).id;
    ids.relation = writeBotIdentity(ticket, pip("relation", "owner", "We plan on Mondays and review on Fridays."), roster).id;
    ids.c1 = writeBotIdentity(ticket, pip("commitment", "first", "Send the weekly summary."), roster).id;
    ids.c2 = writeBotIdentity(ticket, pip("commitment", "second", "Never book travel without asking."), roster).id;
    ids.t1 = writeBotIdentity(ticket, pip("self-trait", "plain", "Prefers plain words."), roster).id;
    ids.t2 = writeBotIdentity(ticket, pip("self-trait", "brief", "Keeps answers short."), roster).id;
    stamp(ids.c1, 1000); stamp(ids.c2, 2000); stamp(ids.t1, 3000); stamp(ids.t2, 4000);
    return ids;
  }

  it("off: PIP rows in the store leave the direct-turn bundle byte-identical to the same scenario without them", async () => {
    writeBotIdentity(ticket, brief(), roster);
    const baseline = await buildMemoryBundle("harbour log", access(), emptyBridge);
    seed(false);
    // P2 also stores proposals, counters, concerns and episodes in identity.
    // None joins the base identity slot when Continuity is absent or false.
    for (const kind of ["pip-proposal", "pip-counter", "concern", "episode"]) {
      const id = `fixture-${kind}`;
      database().prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,'assistant-inference','active',0,?,NULL,NULL,?)")
        .run(id, botScope(), kind, `P2_ONLY_${kind}`, Date.now(), Date.now());
      database().prepare("UPDATE memory_record_details SET partition='identity' WHERE record_id=?").run(id);
    }
    for (const options of [{}, { continuity: false }]) {
      const withRows = await buildMemoryBundle("harbour log", access(), emptyBridge, options);
      expect(kinds(withRows)).toEqual(["continuity-brief", "reveal-state"]);
      expect(withRows.text).toContain("REVEAL_NOTE");
      expect(withRows.continuity).toBeUndefined();
      expect(withRows.text).not.toMatch(/Prefers plain|weekly summary|Mondays|You said|you said|P2_ONLY_/);
    }
    // the exact baseline is the brief alone
    database().prepare("UPDATE memory_records SET state='archived' WHERE kind='reveal-state'").run();
    const again = await buildMemoryBundle("harbour log", access(), emptyBridge);
    expect(again.text).toBe(baseline.text);
    expect(again.tokenCount).toBe(baseline.tokenCount);
    expect(again.recordVersions).toEqual(baseline.recordVersions);
  });

  it("on: brief, reveal state, how we work together, commitments, then traits, newest edit first, with labels; canon stays out", async () => {
    const ids = seed();
    const bundle = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    // P2 order (design 2.1, 2.2): the brief, the self slot newest edit first (the relation was written after the stamped rows), then reveal state
    expect(bundle.recordVersions.map(row => row.id)).toEqual([ids.brief, ids.relation, ids.t2, ids.t1, ids.c2, ids.c1, ids.reveal]);
    expect(kinds(bundle)).toEqual(["continuity-brief", "relation", "self-trait", "self-trait", "commitment", "commitment", "reveal-state"]);
    expect(bundle.text).toContain("How we work together");
    expect(bundle.text).toContain("Commitments (you said)");
    expect(bundle.text).toContain("About me (you said)");
    expect(bundle.text).not.toContain("CANON_HIDDEN");
    // today's brief and reveal lines keep their old kind tokens
    expect(bundle.text).toMatch(/- m1 \(owner-authored fictional continuity; not world truth; continuity-brief\)/);
    expect(bundle.text).toMatch(/- m7 \(owner-authored fictional continuity; not world truth; reveal-state\)/);
    expect(bundle.text).toMatch(/- m2 \(you wrote this; How we work together\)/);
    expect(bundle.text).not.toMatch(/\b(Brought|brought)\b/);
    expect(bundle.continuity).toEqual({ brought: 5, total: 5 });
    // an edit moves a commitment to the front of its kind
    writeBotIdentity(ticket, pip("commitment", "first", "Send the weekly summary by noon.", { expectedVersion: 1 }), roster);
    const edited = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(edited.identity.filter(record => record.kind === "commitment").map(record => record.text)[0]).toContain("by noon");
  });

  it("omits whole rows past the bundle budget in priority order, keeps the brief first, and reports the count to the owner only", async () => {
    writeBotIdentity(ticket, brief(), roster);
    const rows: string[] = [];
    rows.push(writeBotIdentity(ticket, pip("relation", "owner", "R".repeat(380)), roster).id);
    for (let n = 0; n < 3; n++) rows.push(writeBotIdentity(ticket, pip("commitment", `c-${n}`, `${String.fromCharCode(65 + n)}`.repeat(380)), roster).id);
    for (let n = 0; n < 3; n++) rows.push(writeBotIdentity(ticket, pip("self-trait", `t-${n}`, `${String.fromCharCode(88 + n)}`.repeat(380)), roster).id);
    rows.forEach((id, index) => stamp(id, 10000 - index));
    const wide = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    const narrow = await buildMemoryBundle("", access(), emptyBridge, { continuity: true, availableContextTokens: 8000 });
    // ceiling = fixed frame + min(2048, tenth of the window), measured on the rendered bundle
    expect(wide.tokenCount - MEMORY_FRAME_TOKENS).toBeLessThanOrEqual(2048);
    expect(narrow.tokenCount - MEMORY_FRAME_TOKENS).toBeLessThanOrEqual(800);
    expect(wide.continuity!.total).toBe(7);
    expect(narrow.continuity!.total).toBe(7);
    expect(wide.continuity!.brought).toBeGreaterThan(narrow.continuity!.brought);
    expect(narrow.continuity!.brought).toBeLessThan(7);
    expect(kinds(narrow)[0]).toBe("continuity-brief");
    // a prefix of the priority order, whole rows only
    const order = [rows[0], rows[1], rows[2], rows[3], rows[4], rows[5], rows[6]];
    expect(narrow.identity.filter(r => order.includes(r.id)).map(r => r.id)).toEqual(order.slice(0, narrow.continuity!.brought));
    for (const record of narrow.identity) if (order.includes(record.id)) expect(narrow.text).toContain(JSON.stringify(record.text));
    // never in the text
    for (const bundle of [wide, narrow]) expect(bundle.text).not.toMatch(new RegExp(`\\b${bundle.continuity!.brought} of ${bundle.continuity!.total}\\b`));
    // owner API: survives a restart
    recordContinuityCoverage("moss", narrow.continuity);
    closeDatabase();
    expect(readContinuity(ticket, "moss", roster).coverage).toMatchObject({ brought: narrow.continuity!.brought, total: 7 });
  });

  it("gives the same identity-slot bytes to two reads of the same window (engine parity) and different bytes only by window", async () => {
    seed();
    const a = await buildMemoryBundle("", access("moss", "private"), emptyBridge, { continuity: true, availableContextTokens: 32000 });
    const b = await buildMemoryBundle("", access("moss", "new-task"), emptyBridge, { continuity: true, availableContextTokens: 32000 });
    expect(b.text).toBe(a.text);
    expect(b.recordVersions).toEqual(a.recordVersions);
  });

  it("never reaches a room, a project desk, another bot, or a pin", async () => {
    const ids = seed();
    for (const [bot, thread] of [["moss", "room-thread"], ["moss", "desk"], ["neutral", "neutral-thread"]] as const) {
      const bundle = await buildMemoryBundle("", access(bot, thread), emptyBridge, { continuity: true });
      expect(bundle.text, thread).not.toMatch(/Prefers plain|weekly summary|Mondays|How we work|you said/);
      expect(bundle.recordVersions.filter(row => Object.values(ids).includes(row.id)), thread).toEqual([]);
      // a room or desk turn reports nothing; another bot's direct turn has nothing of its own
      if (thread === "neutral-thread") expect(bundle.continuity).toEqual({ brought: 0, total: 0 });
      else expect(bundle.continuity).toBeUndefined();
    }
    // even a row forced to owner_pinned in the table is not delivered as a pin
    database().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=?").run(ids.c1);
    const off = await buildMemoryBundle("", access(), emptyBridge);
    expect(off.pinned).toEqual([]);
    expect(off.text).not.toContain("weekly summary");
  });
});

describe("PIP P1 readers, pins and the projection", () => {
  it("excludes PIP kinds before ranking: the non-PIP hits and the prefixed turn text are unchanged", async () => {
    const f1 = fact("harbour lantern schedule is posted on the door");
    const f2 = fact("harbour lantern oil is bought on Tuesdays");
    const f3 = fact("harbour lantern glass was replaced last spring");
    writeBotIdentity(ticket, brief(), roster);
    const query = "harbour lantern";
    const run = async (bridge: ReturnType<typeof rankedBridge>) => ({
      hits: (await searchMemory(query, access(), bridge, { limit: 3 })).hits.map(hit => hit.id).sort(),
      historical: (await searchMemory(query, access(), bridge, { limit: 3, historical: true })).hits.map(hit => hit.id).sort(),
      recent: recentMemoryHits(query, access()).map(hit => hit.id).sort(),
      turn: (await buildMemoryBundle(query, access(), bridge)).text,
      turnOn: (await buildMemoryBundle(query, access(), bridge, { continuity: false })).text,
    });
    // the baseline warms its own eligibility cache BEFORE any PIP row exists
    const baseline = await run(rankedBridge());
    expect(baseline.hits).toEqual([f1, f2, f3].sort());
    // PIP rows that would outrank every fixture fact for this query
    writeBotIdentity(ticket, pip("commitment", "lantern-a", "harbour lantern harbour lantern harbour lantern"), roster);
    writeBotIdentity(ticket, pip("commitment", "lantern-b", "harbour lantern harbour lantern harbour lantern harbour lantern"), roster);
    writeBotIdentity(ticket, pip("self-trait", "lantern-c", "harbour lantern harbour lantern"), roster);
    writeBotIdentity(ticket, pip("relation", "owner", "harbour lantern harbour lantern harbour lantern harbour lantern harbour lantern"), roster);
    // cold: a fresh eligibility after insertion, then warm: the same one read again
    const cold = rankedBridge();
    expect(await run(cold)).toEqual(baseline);
    expect(await run(cold)).toEqual(baseline);
    // the eligibility sets carry none of them, current or historical
    const ids = new Set(database().prepare("SELECT id FROM memory_records WHERE kind IN ('commitment','self-trait','relation')").all().map(row => String(row.id)));
    expect(ids.size).toBe(4);
    for (const historical of [false, true]) {
      const allowed = eligibility!.read({ scopeIds: [botScope()], policyRevision: meta().policy_revision, deletionEpoch: meta().deletion_epoch, historical, cursor: "" }).allowed;
      expect(allowed.filter(row => ids.has(row.id))).toEqual([]);
      expect(allowed.some(row => row.id === f1)).toBe(true);
    }
    // search's own map guard holds even if a bridge hands one back
    const leaky = { search: async () => ({ hits: [...ids].map(id => ({ id, version: 1, score: 9 })) as IndexHit[], vectorRows: 0 }) };
    expect((await searchMemory(query, access(), leaky, { limit: 20 })).hits.filter(hit => ids.has(hit.id))).toEqual([]);
  });

  it("does not hand a PIP row to the agent get route, on or off", async () => {
    setMemoryMode("active");
    const row = writeBotIdentity(ticket, pip("commitment", "private-one", "Do the thing."), roster);
    const briefRow = writeBotIdentity(ticket, brief(), roster);
    const ctx = access();
    await expect(memoryAgentRoute("/api/internal/memory/get", { handles: [{ id: row.id, version: 1 }] }, ctx, emptyBridge)).rejects.toThrow("MEMORY_RECORD_UNAVAILABLE");
    // the brief is a PIP kind too (P2): it reaches the bot only through the frame
    await expect(memoryAgentRoute("/api/internal/memory/get", { handles: [{ id: briefRow.id, version: 1 }] }, ctx, emptyBridge)).rejects.toThrow("MEMORY_RECORD_UNAVAILABLE");
    const found = await memoryAgentRoute("/api/internal/memory/search", { query: "Do the thing" }, ctx, emptyBridge) as { hits: unknown[] };
    expect(found.hits).toEqual([]);
  });

  it("refuses to pin a PIP kind from the authority function and from the owner pin action", async () => {
    const row = writeBotIdentity(ticket, pip("commitment", "pinned-try", "Do the thing."), roster);
    expect(() => pinMemory(ticket, row.id, 1, true)).toThrow("MEMORY_IDENTITY_NOT_PINNABLE");
    await expect(memoryOwnerRoute("/api/memory/action", { action: "pin", id: row.id, version: 1, pinned: true }, ticket, roster)).rejects.toThrow("MEMORY_IDENTITY_NOT_PINNABLE");
    expect(database().prepare("SELECT owner_pinned FROM memory_records WHERE id=?").get(row.id)!.owner_pinned).toBe(0);
    const fine = fact("an ordinary note");
    expect(() => pinMemory(ticket, fine, 1, true)).not.toThrow();
  });
});

describe("PIP P1 does not reset anything outside its own bot", () => {
  it("leaves another bot's disclosure, resume cursor, prompt and authority untouched across save, edit and delete", async () => {
    writeBotIdentity(ticket, brief("Neutral keeps the dock notes.", "neutral"), roster);
    writeBotIdentity(ticket, brief(), roster);
    const neutral = access("neutral", "neutral-thread");
    const bundle = await buildMemoryBundle("", neutral, emptyBridge);
    const receipt = new MemoryDispatchReceipt(bundle, neutral, "driver-one");
    receipt.sessionStarted("session-one"); receipt.accepted();
    const disclosure = () => database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)!.state;
    expect(disclosure()).toBe("delivered");
    const before = meta();

    const mossAccess = access();
    const mossBundle = await buildMemoryBundle("", mossAccess, emptyBridge, { continuity: true });
    const mossReceipt = new MemoryDispatchReceipt(mossBundle, mossAccess, "driver-one");
    mossReceipt.sessionStarted("session-moss"); mossReceipt.accepted();

    writeBotIdentity(ticket, pip("self-trait", "calm", "Stays calm under pressure."), roster);
    writeBotIdentity(ticket, pip("self-trait", "calm", "Stays calm and plain.", { expectedVersion: 1 }), roster);
    const laterAccess = access();
    const mossLater = await buildMemoryBundle("", laterAccess, emptyBridge, { continuity: true });
    const mossReceipt2 = new MemoryDispatchReceipt(mossLater, laterAccess, "driver-one");
    mossReceipt2.sessionStarted("session-moss-2"); mossReceipt2.accepted();
    deleteBotIdentity(ticket, { action: "identity-delete", botId: "moss", kind: "self-trait", key: "calm", expectedVersion: 2 }, roster);

    expect(meta()).toEqual(before);
    expect(disclosure()).toBe("delivered");
    const again = await buildMemoryBundle("", access("neutral", "neutral-thread"), emptyBridge);
    expect(again.text).toBe(bundle.text);
    expect(memoryContinuationChanged(again, "neutral-thread", "driver-one", "session-one")).toBe(false);
    expect(() => assertMemoryAccess(neutral)).not.toThrow();
    // only the disclosure that carried the changed record is revoked
    expect(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(mossLater.bundleId)!.state).toBe("revoked");
    // a brief edit is a PIP write since P2: no installation-wide reset, only the disclosures that carried it
    writeBotIdentity(ticket, brief("Moss keeps the harbour log.", "moss", 1), roster);
    expect(meta().policy_revision).toBe(before.policy_revision);
    expect(disclosure()).toBe("delivered");
  });
});

describe("PIP P1 restore", () => {
  it("leaves restored memory paused with the continuity rows kept", async () => {
    setMemoryMode("active");
    const row = writeBotIdentity(ticket, pip("commitment", "kept", "Kept across a restore."), roster);
    expect(pauseRestoredMemory(database())).toBe(true);
    expect(database().prepare("SELECT mode FROM memory_meta WHERE id=1").get()!.mode).toBe("paused");
    expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(row.id)!.state).toBe("active");
    expect(readContinuity(ticket, "moss", roster).records.map(r => r.key)).toEqual(["kept"]);
  });
});
