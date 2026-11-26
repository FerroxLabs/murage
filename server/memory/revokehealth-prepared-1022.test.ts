// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-revokehealth-opus (deny-read.ts memoryScopeVerdict, quarantined windows). Consumer owner: the send fence (send-fence.ts), which
// judges a retained turn's refs with refsLookup(file, refs, reader, true, open.preparedWindow).
// Astra precheck bba372e201 (privacy High): a ref the turn prepared under a window took the prepared exception before the quarantined-window
// check, so a memory object whose only denial is a quarantined job's scope window read shown at the send. The prepared exception covers the
// live pending window only; a quarantined window reads withheld for every reader.
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { emitConsumingTurnResponse, registerConsumingDescriptor } from "../consuming-turn-response.ts";
import { bindFixtureTurn } from "../testing/consuming-fixture.ts";
import { closeTurnLineage, openTurnLineage } from "./lineage-write.ts";
import { denyGeneration, preparedWindowIdentity, refsLookup } from "./deny-read.ts";
import { memoryRefKey, type LineageRef, type LineageVerdict, type PreparedWindow } from "./lineage-types.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function seeded(state: "active" | "quarantined", extraRows = 0) {
  const f = new WritetimeFixture(); fixtures.push(f);
  f.source("src", "s-bot").record("rec", 1, "s-bot", ["src"]).job(7, 1);
  // the scope's pending window from lsn 0 (before the record), owned by job 7: live, or quarantined after its failures
  f.db.prepare("INSERT INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('s-bot',0,7)").run();
  f.db.prepare("UPDATE memory_revoke_jobs SET state=? WHERE revoke_id=7").run(state);
  // past PENDING_READ_LIMIT (256) rows on the scope its windows come from the summary path; the whole file stays under the 512-row identity bound
  const insert = f.db.prepare("INSERT INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('s-bot',?,?)");
  for (let i = 0; i < extraRows; i++) insert.run(50 + i, 100 + i);
  const ref = { kind: "record" as const, id: "rec", version: 1 };
  const refs: LineageRef[] = [{ kind: "memory", ref }];
  const window: PreparedWindow = { reader: CONTENT, generation: denyGeneration(f.db), identity: preparedWindowIdentity(f.db), memoryKeys: new Set([memoryRefKey(ref)]), open: true };
  return { f, refs, window };
}

it("control: a ref prepared under a LIVE pending window keeps its prepared exception at the send", () => {
  const { f, refs, window } = seeded("active");
  expect(refsLookup(f.db, refs, CONTENT, true, window)).toMatchObject({ state: "shown" });
});

it("W-PREPARED-QUARANTINE a ref prepared under a QUARANTINED job's window reads withheld at the send, as it does unprepared", () => {
  const { f, refs, window } = seeded("quarantined");
  expect(refsLookup(f.db, refs, CONTENT, true)).toMatchObject({ state: "withheld", reason: "scope-deny" });
  // pre-fix bba372e201: { state: "shown" } (the prepared exception returned before the quarantined-window check)
  expect(refsLookup(f.db, refs, CONTENT, true, window)).toMatchObject({ state: "withheld", reason: "scope-deny" });
});

it("W-PREPARED-QUARANTINE-OVERFLOW past 256 pending rows on the scope, a prepared ref under a quarantined job's window still reads withheld", () => {
  const { f, refs, window } = seeded("quarantined", 256);
  expect(typeof window.identity).toBe("string");
  // pre-fix 2ba412a2a9: { state: "shown" } (the overflow summary dropped the quarantine flag)
  expect(refsLookup(f.db, refs, CONTENT, true, window)).toMatchObject({ state: "withheld", reason: "scope-deny" });
});

// Astra d2e7ff4df4 (High): the witnesses above call refsLookup as send-fence.ts does; these two go through the retained turn's release door
// itself. A tool reply carrying the memory ref is emitted on a real bound turn (consuming-turn-response.ts emitConsumingTurnResponse:
// proposeTurnParents, then assertRetainedFence with the turn's prepared window, send-fence.ts prepareRetainedFence). Under a quarantined
// job's window the reply is never written and the turn is refused withheld; under a live window the prepared exception still releases it.
function released(state: "active" | "quarantined", extraRows = 0) {
  const { f, refs } = seeded(state, extraRows);
  const turn = openTurnLineage(f.db, { threadId: "T", turnId: randomUUID() });
  // bindFixtureTurn prepares the turn's retained fence (prepareRetainedFence: its prepared window) and binds it as index.ts does
  const bound = bindFixtureTurn(f.db, turn, "B", turn.turnId, CONTENT);
  const written: string[] = [];
  let error: unknown;
  try {
    emitConsumingTurnResponse(bound.binding, registerConsumingDescriptor("POST /api/internal/memory/get:body", "body"),
      { bytes: 6, refs, write: () => { written.push("rec v1"); } });
  } catch (caught) { error = caught; }
  const verdict = (error as { fence?: LineageVerdict } | undefined)?.fence;
  closeTurnLineage(turn);
  return { written, refusals: bound.refusals, verdict, code: (error as { code?: string } | undefined)?.code ?? (error as Error | undefined)?.message };
}

it("control: at the release door a reply prepared under a LIVE pending window is written", () => {
  expect(released("active")).toMatchObject({ written: ["rec v1"], refusals: 0, code: undefined });
});

it("W-PREPARED-QUARANTINE-SEND at the release door a reply carrying a ref under a QUARANTINED job's window is not written and the turn is refused withheld", () => {
  // pre-fix bba372e201: written ["rec v1"] (the prepared exception released it)
  expect(released("quarantined")).toMatchObject({ written: [], code: "MEMORY_CONTEXT_REVOKED", refusals: 1, verdict: { state: "withheld", reason: "scope-deny" } });
});

it("W-PREPARED-QUARANTINE-OVERFLOW-SEND past 256 pending rows on the scope, the release door still refuses that reply", () => {
  // pre-fix 2ba412a2a9: written ["rec v1"] (the overflow summary dropped the quarantine)
  expect(released("quarantined", 256)).toMatchObject({ written: [], code: "MEMORY_CONTEXT_REVOKED", refusals: 1, verdict: { state: "withheld", reason: "scope-deny" } });
});
