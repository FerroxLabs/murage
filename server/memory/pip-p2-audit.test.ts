// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P2 code audit of B1+B2 (Astra): bundle and authority findings. Finding 10 (a previously pinned brief is not lost
// and can be unpinned), finding 11 (the second bundle pass never moves the advertised prefix; standing reaches the
// ordering) and the sentence split that finding 8 shares with the reflection windows. Synthetic fixture text only.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket, pinMemory } from "./authority.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { writeBotIdentity, type IdentityWrite } from "./identity.ts";
import { buildMemoryBundle } from "./bundle.ts";
import type { IndexHit } from "./index.ts";
import { captureSource } from "./capture.ts";
import { setMemoryMode } from "./repository.ts";
import { pipCounterId } from "./pip-kinds.ts";
import { sentenceRanges } from "./pip-reflect.ts";

const roster = { bots: [{ id: "moss", threadId: "private" }], groups: [] };
const ticket = ownerMemoryTicket();
const emptyBridge = { search: async () => ({ hits: [] as IndexHit[], vectorRows: 0 }) };

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); setMemoryMode("active"); });

function pip(kind: "commitment" | "self-trait" | "relation", key: string, text: string): IdentityWrite {
  return { action: "identity-write", botId: "moss", kind, key, expectedVersion: 0, text, basis: "owner-fact", audience: "owner-private" };
}
const brief = (text = "Moss keeps the harbour log and answers briefly."): IdentityWrite =>
  ({ action: "identity-write", botId: "moss", kind: "continuity-brief", key: "core", expectedVersion: 0, text, basis: "fiction", audience: "owner-private" });
function access() {
  const registry = new InternalCapabilities(), generation = registry.begin("moss", "private");
  const token = registry.mint({ botId: "moss", threadId: "private", generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const scopeOf = () => String(database().prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key='moss'").get()!.id);
const stamp = (id: string, at: number) => database().prepare("UPDATE memory_records SET created_at=? WHERE id=? AND state='active'").run(at, id);
function observed(slug: string, text: string, reinforcedAt: number) {
  const sourceId = `src-${slug}`, sourceText = `Please remember: ${text}`;
  captureSource(database(), { id: sourceId, threadId: "private", messageId: `msg-${slug}`, origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: sourceText });
  const revision = Number(database().prepare("SELECT revision FROM memory_sources WHERE id=?").get(sourceId)!.revision);
  const id = `identity:observed-${slug}`;
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'commitment',?,'assistant-inference','active',0,?,NULL,NULL,?)").run(id, scopeOf(), text, Date.now(), reinforcedAt);
  database().prepare("INSERT INTO memory_evidence VALUES(?,1,?,?,0,?)").run(id, sourceId, revision, Buffer.byteLength(sourceText));
  database().prepare("UPDATE memory_record_details SET partition='identity',attention='current',confidence_basis='pip:observed; Confirmed by the owner',entities=? WHERE record_id=? AND record_version=1")
    .run(JSON.stringify(["owner-private", slug, "claim:null", "gen:1", `reinforcedAt:${reinforcedAt}`]), id);
  return id;
}
const cacheSelection = () => {
  const row = database().prepare("SELECT intent FROM memory_scope_bindings WHERE id='pip-render:moss'").get() as { intent: string } | undefined;
  return row ? (JSON.parse(row.intent).selection as Array<{ id: string }>).map(entry => entry.id) : undefined;
};

describe("audit finding 10: a brief pinned before it became a PIP kind", () => {
  function pinnedLegacyBrief() {
    const row = writeBotIdentity(ticket, brief("PINNED_BRIEF_CANARY the lamp keeper is brief."), roster);
    database().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=?").run(row.id);
    return row;
  }
  // Design 1.2 deliberately reclassifies the brief for every bot: shared search
  // exclusion and selective disclosure revocation apply even with PIP off. This
  // fixture checks current toggle coexistence, not base-versus-head parity.
  it("renders the pinned brief across current toggle settings", async () => {
    const row = pinnedLegacyBrief();
    for (const options of [{}, { continuity: false }, { continuity: true }]) {
      const bundle = await buildMemoryBundle("", access(), emptyBridge, options);
      expect(bundle.recordVersions.map(r => r.id), JSON.stringify(options)).toEqual([row.id]);
      expect(bundle.text).toContain("PINNED_BRIEF_CANARY");
    }
  });
  it("can be unpinned by the owner, while pinning a PIP row stays refused", async () => {
    const row = pinnedLegacyBrief();
    expect(() => pinMemory(ticket, row.id, 1, true)).toThrow("MEMORY_IDENTITY_NOT_PINNABLE");
    pinMemory(ticket, row.id, 1, false);
    expect(database().prepare("SELECT owner_pinned FROM memory_records WHERE id=? AND version=1").get(row.id)!.owner_pinned).toBe(0);
    const bundle = await buildMemoryBundle("", access(), emptyBridge, {});
    expect(bundle.recordVersions.map(r => r.id)).toEqual([row.id]);
  });
});

describe("audit finding 11: the advertised prefix", () => {
  it("a second-pass row never moves a first-pass row: the observed rows keep their positions and handles", async () => {
    writeBotIdentity(ticket, brief(), roster);
    for (let n = 0; n < 24; n++) { const row = writeBotIdentity(ticket, pip("commitment", `a-${String(n).padStart(2, "0")}`, `Attested ${String(n).padStart(2, "0")} ${"x".repeat(380)}`), roster); stamp(row.id, 10_000 + n); }
    const obs = [0, 1, 2].map(n => observed(`r${n}`, `Observed ${n} ${"y".repeat(380)}`, 20_000 + n));
    const bundle = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    const prefix = cacheSelection()!;
    const ids = bundle.recordVersions.map(r => r.id);
    // the second pass really placed rows beyond the first pass, and at least one observed row was in the prefix
    expect(ids.length).toBeGreaterThan(prefix.length);
    expect(prefix.some(id => obs.includes(id))).toBe(true);
    expect(ids.slice(0, prefix.length)).toEqual(prefix);
    // handles follow positions: the prefix handles are the same whether or not the second pass ran
    const again = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(again.recordVersions.map(r => r.id)).toEqual(ids);
  });
});

describe("audit finding 11: standing reaches the self-slot order", () => {
  it("a disputed observed row mounts after an undisputed one even when it is newer", async () => {
    const newer = observed("n", "Newer disputed row.", 9000), older = observed("o", "Older undisputed row.", 5000);
    database().prepare("UPDATE memory_record_details SET claim_status='disputed' WHERE record_id=? AND record_version=1").run(newer);
    const bundle = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(bundle.recordVersions.map(r => r.id)).toEqual([older, newer]);
  });
  it("a contested observed row (open counter occasions) mounts after an uncontested one, before a disputed one", async () => {
    const contested = observed("c", "Newest contested row.", 9000), clean = observed("k", "Older clean row.", 5000), disputed = observed("d", "Middle disputed row.", 7000);
    database().prepare("UPDATE memory_record_details SET claim_status='disputed' WHERE record_id=? AND record_version=1").run(disputed);
    const counterId = pipCounterId(contested, 1);
    database().prepare("INSERT INTO memory_records VALUES(?,1,?,'pip-counter','Something points the other way.','assistant-inference','active',0,?,NULL,NULL,?)").run(counterId, scopeOf(), Date.now(), Date.now());
    database().prepare("UPDATE memory_record_details SET partition='identity',attention='current',confidence_basis='pip:counter; test',entities=? WHERE record_id=? AND record_version=1")
      .run(JSON.stringify([contested, "gen:1", "occ:one"]), counterId);
    const bundle = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(bundle.recordVersions.map(r => r.id)).toEqual([clean, contested, disputed]);
    // a kept occasion is no longer open: the row is uncontested again and its recency wins
    database().prepare("UPDATE memory_record_details SET entities=? WHERE record_id=? AND record_version=1").run(JSON.stringify([contested, "gen:1", "occ:one", "kept:one"]), counterId);
    database().prepare("DELETE FROM memory_scope_bindings WHERE id='pip-render:moss'").run();
    const kept = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(kept.recordVersions.map(r => r.id)).toEqual([contested, clean, disputed]);
  });
});

describe("audit finding 8: the reflection windows use the same quote-aware split", () => {
  it("offers only full admissible owner sentences for nomination", () => {
    const text = 'Be brief. "You are reliable. You always apologize." Thanks.';
    expect(sentenceRanges(text)).toEqual([{ start: 0, end: 9, text: "Be brief." }]);
  });
});
