import { releaseProbe } from "../testing/baseline-contract.ts";
import { writeClaudePrompt } from "../testing/claude-release-fixture.ts";
import { afterEach, expect, it, vi } from "vitest";
import { fencedTurnInput } from "../drivers/engine-input.ts";
import { openTurnLineage, closeTurnLineage } from "./lineage-write.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import { CONTENT, MEMBER, OWNER, WritetimeFixture } from "./testing/writetime-fixture.ts";
import type { LineageReader, TurnLineage } from "./lineage-types.ts";
import * as sendFence from "./send-fence.ts";

const fixtures: WritetimeFixture[] = [], turns: TurnLineage[] = [];
afterEach(() => { vi.restoreAllMocks(); turns.splice(0).forEach(closeTurnLineage); fixtures.splice(0).forEach(f => f.close()); releaseProbe.writes = 0; releaseProbe.atWrite = undefined; });
const mutations = {
  "record-denied": (f: WritetimeFixture) => f.denyMemory("record", "record", 1),
  "source-deleted": (f: WritetimeFixture) => f.tombstone("source", "source", 1),
  "source-revised": (f: WritetimeFixture) => f.db.exec("UPDATE memory_sources SET revision=2 WHERE id='source'"),
  "owner-line-edited": (f: WritetimeFixture) => f.denyLine("S", 1),
  "relevant-pending": (f: WritetimeFixture) => f.pendingScope("s-room", 0),
  "thread-denied": (f: WritetimeFixture) => f.deny("thread", "S"),
  "thread-deleted": (f: WritetimeFixture) => f.db.exec("DELETE FROM messages WHERE thread_id='S'"),
  "receipt-revoked": (f: WritetimeFixture) => f.db.exec("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='receipt'"),
  "missing-anchor": (f: WritetimeFixture) => f.db.prepare("UPDATE memory_disclosures SET source_versions=? WHERE bundle_id='receipt'").run('[{"id":"missing","revision":1}]'),
  "read-failure": (f: WritetimeFixture) => vi.spyOn(f.db, "prepare").mockImplementation(() => { throw new Error("fixture read failure"); }),
};
const readers = { content: CONTENT, owner: OWNER, member: MEMBER };
const rows = Object.entries(readers).flatMap(([name, audience]) => [false, true].flatMap(moved => Object.keys(mutations).map(change => ({ name, audience, moved, change: change as keyof typeof mutations }))));
it.each(rows)("T-A-RECEIPT actual stdin $name/$moved/$change", async ({ audience, moved, change }) => {
  const f = new WritetimeFixture().owner("S", "source-line", 1).source("source", "s-room", { thread: "S", message: "source-line" }).record("record", 1, "s-room", ["source"]).receipt("receipt", "T", "driver", "session"); fixtures.push(f);
  f.db.prepare("UPDATE memory_disclosures SET record_versions=?,source_versions=? WHERE bundle_id='receipt'")
    .run('[{"id":"record","version":1}]', '[{"id":"source","revision":1}]');
  const turn = openTurnLineage(f.db, { threadId: "T", turnId: "receipt-probe" }); turns.push(turn);
  const api = sendFence as typeof sendFence & { prepareRetainedFence?: (turn: TurnLineage, reader: LineageReader, stop: () => void, db: typeof f.db) => LineageReader };
  const reader = api.prepareRetainedFence?.(turn, audience, vi.fn(), f.db) ?? audience;
  const prompt = buildPrompt(turn, [promptPart(releaseProbe.marker, [{ kind: "receipt", bundleId: "receipt", lsn: turn.turnLsn, scopeIds: ["s-room"] }])]);
  const input = fencedTurnInput({ threadId: "T", prompt }, { reader, db: f.db, ...{ retained: turn } });
  await writeClaudePrompt(input); expect(releaseProbe.writes, "positive control at actual stdin").toBe(1);
  if (moved) f.meta("deny_generation", turn.denyGeneration + 1);
  mutations[change](f);
  await writeClaudePrompt(input).catch(() => undefined);
  vi.restoreAllMocks();
  expect(releaseProbe.writes, "receipt content denial prevents the next actual enqueue").toBe(1);
}, 30_000);
