// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory screen B2 (designs/MEMORY-UI-BUILD-SPEC.md r3, section 2): Forget is immediate and the owner's next turn goes on. A pinned fact
// resting on more evidence than a forget's commit takes (its job's affect step, which unpins it, is left to the runner) never stops a turn;
// a second tap makes one forget; nothing writes to a forgotten record; the owner saying a forgotten fact again makes a new record; the
// screen's Forget for a continuity row is version-fenced; Copy to goes only to another audience the status lists.
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { afterEach as thawAfterEach, beforeEach as thawBeforeEach } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { forgetMemory, FORGET_INLINE_ROWS } from "./forget.ts";
import { captureSource } from "./capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource } from "./consolidate.ts";
import type { TextOnlyExtractor } from "./extract.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { drainRevokeMarker, INLINE_REVOCATION, stopMemoryRevocation } from "./memory-revocation.ts";
import type { MemorySearchBridge } from "./search.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

// 1.0.2: a receipt binds its session through the legacy session-root row here (as dispatch-preparation.test.ts does).
thawBeforeEach(() => thawRootSetWritesForTest(true));
thawAfterEach(() => thawRootSetWritesForTest(false));
const THREAD = "5b1f6c2e-9d43-4a0b-8e61-2f7c3a9d1e05";
const roster = { bots: [{ id: "bot", threadId: THREAD }], groups: [{ id: "room", threadId: "room-thread", memberIds: ["bot"] }] } as unknown as MemoryRoster;
const ticket = ownerMemoryTicket();
const inline = { ...INLINE_REVOCATION };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); setMemoryMode("active");
  // Every forget here leaves its job to the runner, as a record on more than FORGET_INLINE_ROWS evidence rows always does on a slow machine.
  Object.assign(INLINE_REVOCATION, { rows: 0, ms: 0 });
});
afterEach(() => { stopMemoryRevocation(); Object.assign(INLINE_REVOCATION, inline); });

function access() {
  const registry = new InternalCapabilities(), generation = registry.begin("bot", THREAD);
  const token = registry.mint({ botId: "bot", threadId: THREAD, generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const scope = () => ensureScope("bot", "bot");
const act = (body: Record<string, unknown>) => memoryOwnerRoute("/api/memory/action", body, ticket, roster) as Promise<any>;
const quiet: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
const build = (bridge: MemorySearchBridge = quiet) => buildMemoryBundle("What should I do next?", access(), bridge, { allowance: LineageAllowance.tool(), availableContextTokens: 20480 });
const row = (id: string, version = 1) => database().prepare("SELECT state,owner_pinned,text FROM memory_records WHERE id=? AND version=?").get(id, version) as { state: string; owner_pinned: number; text: string };
const tombstones = (id: string) => Number(database().prepare("SELECT count(*) AS n FROM memory_tombstones WHERE target_type='record' AND target_id=?").get(id)!.n);
const carries = (bundle: { recordVersions: Array<{ id: string }> }, id: string) => bundle.recordVersions.some(record => record.id === id);

/** An owner line of the bot's chat, captured and settled as a turn leaves it (dispatch-preparation.test.ts capture). */
function captured(text: string, attended = false) {
  const sourceId = `message:${THREAD}:${randomUUID()}`, anchorId = randomUUID();
  storeAnchorMessage(database(), THREAD, anchorId, text);
  captureSource(database(), { id: sourceId, threadId: THREAD, messageId: anchorId, kind: "text", speaker: "owner", outcome: "recorded", text, ...(attended ? { origin: { kind: "attended" } } : {}) });
  const work = claimMemoryJob("forget-pin-fixture");
  if (!work) throw Error("No actual capture job");
  publishMemoryWork(work, "forget-pin-fixture", captureWork(work));
  return { sourceId, jobId: work.id };
}
/** An active owner fact in the bot's scope, optionally pinned, resting on `evidence` captured owner lines of the bot's chat. */
function fact(text: string, options: { pinned?: boolean; evidence?: number; scopeId?: string; kind?: string } = {}) {
  const db = database(), id = randomUUID(), sources: string[] = [];
  for (let index = 0; index < (options.evidence ?? 0); index++) sources.push(captured(`line ${index} ${text}`).sourceId);
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,'owner-statement','active',?,?,NULL,NULL,?)").run(id, options.scopeId ?? scope(), options.kind ?? "fact", text, options.pinned ? 1 : 0, Date.now(), Date.now());
  for (const source of sources) db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,4)").run(id, source);
  return id;
}

describe("a forgotten pin never stops a turn (2.3)", () => {
  it("a pinned fact on 65 evidence rows is forgotten; its job is still pending and the next turn goes on without it", async () => {
    const id = fact("Always sign off as Sean.", { pinned: true, evidence: FORGET_INLINE_ROWS + 1 });
    const before = await build();
    expect(carries(before, id)).toBe(true);
    const result = forgetMemory(ticket, { kind: "record", id });
    // the job's affect step (state deleted) has not run: only the forget's own commit has, and it took the pin
    expect(result.derivedCleanup).toBe("pending");
    expect(row(id)).toMatchObject({ state: "active", owner_pinned: 0, text: "" });
    const after = await build();
    expect(carries(after, id)).toBe(false);
    expect(after.withheldPins ?? []).toEqual([]);
  });

  it("a forget committed while the turn is built refuses that build; the rebuilt turn completes without the pin and tells nothing withheld", async () => {
    const id = fact("Reply in British English.", { pinned: true, evidence: FORGET_INLINE_ROWS + 1 });
    // recall runs after pin selection and before the final recheck: the forget lands in between
    const forgetting: MemorySearchBridge = { search: async () => { forgetMemory(ticket, { kind: "record", id }); return { hits: [], vectorRows: 0 }; } };
    await expect(build(forgetting)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
    expect(row(id).state).toBe("active");
    // dispatch rebuilds a revoked build with fresh access (server/index.ts isMemoryContextRevoked)
    const rebuilt = await build();
    expect(carries(rebuilt, id)).toBe(false);
    expect(rebuilt.withheldPins ?? []).toEqual([]);
  });

  it("a pin still set on a record forgotten before this build (as 1.0.15 left it) is dropped, not a refused turn", async () => {
    const id = fact("Never book before 07:00.", { pinned: true });
    const kept = fact("Meetings are 25 minutes.", { pinned: true });
    forgetMemory(ticket, { kind: "record", id });
    // the revoke's marker walk (write-time privacy) holds what may rest on the forget as checking until it ends; it ends here, as the
    // runner ends it in the background
    expect(drainRevokeMarker(database()).pending).toBe(false);
    database().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=?").run(id);
    const bundle = await build();
    expect(carries(bundle, id)).toBe(false);
    expect(carries(bundle, kept)).toBe(true);
    expect(bundle.withheldPins ?? []).toEqual([]);
  });

  it("a pin that turns out forgotten at the final recheck is dropped from every list and the turn goes on", async () => {
    const id = fact("Quote times in UTC.", { pinned: true });
    const kept = fact("Use plain words.", { pinned: true });
    // the owner tombstone alone, with no policy change, so the build reaches its final recheck with this access
    const tombstoneOnly: MemorySearchBridge = { search: async () => {
      database().prepare("INSERT INTO memory_tombstones VALUES(?,'record',?,NULL,NULL,0,'owner-forget',?)").run(randomUUID(), id, Date.now());
      return { hits: [], vectorRows: 0 };
    } };
    const bundle = await build(tombstoneOnly);
    expect(carries(bundle, id)).toBe(false);
    expect(carries(bundle, kept)).toBe(true);
    expect(bundle.withheldPins ?? []).toEqual([]);
    expect(bundle.text).not.toContain("Quote times in UTC.");
  });

  it("a pin refused for another reason still stops the turn", async () => {
    fact("Keep it short.", { pinned: true, evidence: 1 });
    database().prepare("UPDATE memory_sources SET state='deleted'").run();
    await expect(build()).rejects.toThrow("MEMORY_PIN_UNAVAILABLE");
  });
});

describe("Forget from the screen (2.1, 2.5)", () => {
  it("a double tap makes one forget", async () => {
    const id = fact("The deploy window is Tuesday.");
    const first = await act({ action: "forget", kind: "record", id });
    expect(first.status).toBe("excluded");
    const epoch = Number(database().prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch);
    expect(await act({ action: "forget", kind: "record", id })).toEqual({ status: "excluded", already: true });
    expect(tombstones(id)).toBe(1);
    expect(Number(database().prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch)).toBe(epoch);
  });

  it("correct, pin, restore-archive and promote on a forgotten record answer MEMORY_NOT_FOUND", async () => {
    const id = fact("Reports go out Monday."), archived = fact("Old address is on file.");
    await act({ action: "archive", id: archived, version: 1 });
    await act({ action: "forget", kind: "record", id });
    await act({ action: "forget", kind: "record", id: archived });
    expect(row(id).state).toBe("active");
    await expect(act({ action: "correct", id, version: 1, text: "Reports go out Friday." })).rejects.toThrow("MEMORY_NOT_FOUND");
    await expect(act({ action: "pin", id, version: 1, pinned: true })).rejects.toThrow("MEMORY_NOT_FOUND");
    await expect(act({ action: "restore-archive", id: archived, version: 1 })).rejects.toThrow("MEMORY_NOT_FOUND");
    await expect(act({ action: "promote", id, version: 1, scopeId: ensureScope("room", "room") })).rejects.toThrow("MEMORY_NOT_FOUND");
    expect(row(id)).toMatchObject({ owner_pinned: 0, text: "" });
    expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE id=?").get(id)!.n).toBe(1);
    expect(row(archived).state).toBe("archived");
    // unpinning stays open
    await expect(act({ action: "pin", id, version: 1, pinned: false })).resolves.toBeTruthy();
    // after the job ends (archived row deleted) restore still says it was forgotten
    database().prepare("UPDATE memory_records SET state='deleted' WHERE id=?").run(archived);
    await expect(act({ action: "restore-archive", id: archived, version: 1 })).rejects.toThrow("MEMORY_NOT_FOUND");
  });

  it("a waiting memory forgotten from another window is never kept, edited or approved", async () => {
    const id = randomUUID();
    database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','Maybe the owner likes tea.','assistant-inference','candidate',0,1,NULL,NULL,1)").run(id, scope());
    await act({ action: "forget", kind: "record", id });
    database().prepare("UPDATE memory_records SET state='candidate' WHERE id=?").run(id); // its job window
    await expect(act({ action: "review-edit", actionId: randomUUID(), id, version: 1, text: "The owner likes tea." })).rejects.toThrow("MEMORY_NOT_FOUND");
    await expect(act({ action: "review-keep", actionId: randomUUID(), id, version: 1 })).rejects.toThrow("MEMORY_NOT_FOUND");
    await expect(act({ action: "approve", id, version: 1 })).rejects.toThrow("MEMORY_NOT_FOUND");
    // batch Keep: this fixture has no evidence, so eligibility already answers it as gone; either way it is not made current
    await act({ action: "review-keep-all", actionId: randomUUID(), items: [{ id, version: 1 }] }).catch(() => undefined);
    expect(row(id).state).toBe("candidate");
    expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE id=?").get(id)!.n).toBe(1);
  });

  it("the owner saying a forgotten fact again writes a new record, not a correction of the forgotten id", async () => {
    const capture = (text: string) => captured(text, true).jobId;
    let grounded = 0;
    const extractor = (quote: string, update = false): TextOnlyExtractor => {
      const fn: TextOnlyExtractor = async () => JSON.stringify([{ text: quote, quote, claimType: "owner-statement", subject: "owner", predicate: "answer-length", update, startByte: 0, endByte: Buffer.byteLength(quote) }]);
      fn.ground = async () => { grounded++; return '{"supported":true}'; };
      return fn;
    };
    const first = "I prefer long answers.", second = "Correction: I now prefer short answers.";
    await consolidateMemorySource(capture(first), extractor(first), new AbortController().signal);
    const learned = database().prepare("SELECT id,state FROM memory_records WHERE id LIKE 'candidate:%'").all() as Array<{ id: string; state: string }>;
    expect(learned.map(record => record.state)).toEqual(["active"]);
    const old = learned[0]!.id;
    await act({ action: "forget", kind: "record", id: old });
    expect(drainRevokeMarker(database()).pending).toBe(false);
    // the window a record on many evidence rows stays in until its job's affect step: tombstoned, no words, still active
    database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(old);
    expect(row(old)).toMatchObject({ state: "active", text: "" });
    await consolidateMemorySource(capture(second), extractor(second, true), new AbortController().signal);
    expect(grounded).toBe(0);
    expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE id=?").get(old)!.n).toBe(1);
    expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE supersedes_id=?").get(old)!.n).toBe(0);
    const restated = database().prepare("SELECT id,state FROM memory_records WHERE id<>? AND text=?").get(old, second) as { id: string; state: string };
    expect(restated.state).toBe("active");
    // the forgotten claim is not a conflict either
    expect(database().prepare("SELECT claim_status FROM memory_record_details WHERE record_id=?").get(restated.id)).not.toMatchObject({ claim_status: "disputed" });
  });
});

describe("forget-pip (2.2)", () => {
  const commitment = (version = 1) => {
    const id = randomUUID();
    database().prepare("INSERT INTO memory_records VALUES(?,?,?,'commitment','I will check in every Friday.','owner-statement','active',0,1,NULL,NULL,1)").run(id, version, scope());
    return id;
  };
  it("deletes a continuity row at the version the screen saw", async () => {
    const id = commitment();
    expect(await act({ action: "forget-pip", id, expectedVersion: 1 })).toEqual({ id, deleted: true });
    expect(row(id).state).toBe("deleted");
    expect(tombstones(id)).toBe(1);
  });
  it("a stale version answers MEMORY_VERSION_CONFLICT and deletes nothing", async () => {
    const id = commitment(2);
    await expect(act({ action: "forget-pip", id, expectedVersion: 1 })).rejects.toThrow("MEMORY_VERSION_CONFLICT");
    expect(row(id, 2).state).toBe("active");
    expect(tombstones(id)).toBe(0);
  });
  it("a row that is not continuity, or no row, answers MEMORY_NOT_FOUND; the generic forget still refuses continuity", async () => {
    const plain = fact("Plain fact.");
    await expect(act({ action: "forget-pip", id: plain, expectedVersion: 1 })).rejects.toThrow("MEMORY_NOT_FOUND");
    await expect(act({ action: "forget-pip", id: "nothing", expectedVersion: 1 })).rejects.toThrow("MEMORY_NOT_FOUND");
    expect(row(plain).state).toBe("active");
    await expect(act({ action: "forget", kind: "record", id: commitment() })).rejects.toThrow("MEMORY_IDENTITY_PIP_USE_CONTINUITY");
  });
});

describe("Copy to (3)", () => {
  it("copies an active fact to another listed audience as something the owner said", async () => {
    const id = fact("The launch review is on the 9th.");
    const copied = await act({ action: "promote", id, version: 1, scopeId: ensureScope("room", "room") });
    expect(copied.record).toMatchObject({ scopeId: ensureScope("room", "room"), assertion: "owner-statement", state: "active", text: "The launch review is on the 9th." });
  });
  it("refuses continuity, identity, an unknown scope, the original's own scope and a row that is not active", async () => {
    const room = ensureScope("room", "room");
    const pip = randomUUID();
    database().prepare("INSERT INTO memory_records VALUES(?,1,?,'commitment','I will check in.','owner-statement','active',0,1,NULL,NULL,1)").run(pip, scope());
    await expect(act({ action: "promote", id: pip, version: 1, scopeId: room })).rejects.toThrow("MEMORY_IDENTITY_WRITE_REQUIRED");
    const identity = fact("Identity line.");
    database().prepare("INSERT INTO memory_record_details(record_id,record_version,partition,attention,claim_status) VALUES(?,1,'identity','current','current') ON CONFLICT(record_id,record_version) DO UPDATE SET partition='identity'").run(identity);
    await expect(act({ action: "promote", id: identity, version: 1, scopeId: room })).rejects.toThrow("MEMORY_IDENTITY_WRITE_REQUIRED");
    const id = fact("Shared fact.");
    await expect(act({ action: "promote", id, version: 1, scopeId: "no-such-scope" })).rejects.toThrow("MEMORY_SCOPE_DENIED");
    await expect(act({ action: "promote", id, version: 1, scopeId: scope() })).rejects.toThrow("MEMORY_SCOPE_DENIED");
    const candidate = randomUUID();
    database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','Maybe.','assistant-inference','candidate',0,1,NULL,NULL,1)").run(candidate, scope());
    await expect(act({ action: "promote", id: candidate, version: 1, scopeId: room })).rejects.toThrow("MEMORY_VERSION_CONFLICT");
    expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE scope_id=?").get(room)!.n).toBe(0);
  });
});
