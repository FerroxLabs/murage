// SPDX-License-Identifier: AGPL-3.0-or-later
// SQL writer inventory producer and witness consumer owner: new3-g5.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// Ordered per source file. An additional writer always needs its own entry.
// Metadata-only writers explicitly preserve row existence, validity and copyOf;
// they cannot change anything the replay source SELECT reads.
const writers: Record<string, readonly string[]> = {
  "server/testing/sentinel-file-fixture.ts": ["test fixture only: no ReplaySession exists on the isolated Sentinel file fixture"],
  "server/testing/internal-dispatch-fixture.ts": ["test fixture only: isolated test connection"],
  "server/testing/approval-card.ts": ["test fixture only: isolated test connection", "test fixture only: isolated test connection", "test fixture only: isolated test connection"],
  "server/testing/turn-index-child.ts": ["test fixture only: isolated test connection"],
  "server/testing/backup-fixture.ts": ["test fixture only: isolated test connection"],
  "server/testing/redact-sink-witnesses.ts": ["test fixture only: isolated test connection", "test fixture only: isolated test connection"],
  "server/testing/restored-by-meaning.ts": ["test fixture only: isolated test connection"],
  "server/testing/engine-history-fixtures.ts": ["test fixture only: isolated test connection", "test fixture only: isolated test connection", "test fixture only: isolated test connection"],
  "server/testing/search-index-r3-crash-child.ts": ["test fixture only: isolated test connection", "test fixture only: isolated test connection"],
  "server/testing/fts-copy-fixture.ts": ["test fixture only: isolated test connection", "test fixture only: isolated test connection"],
  "server/memory/testing/replay-session-corpus.ts": ["test fixture only: isolated test connection", "test fixture only: isolated test connection", "test fixture only: isolated test connection", "test fixture only: isolated test connection"],
  "server/memory/testing/writetime-fixture.ts": ["test fixture only: isolated test connection"],
  "server/memory/testing/anchor-message.ts": ["test fixture only: isolated test connection"],
  "server/memory/testing/upgrade-fast-fixture.ts": ["test fixture only: isolated test connection"],
  "server/memory/testing/legacy-history-fixture.ts": ["test fixture only: isolated test connection"],
  "server/memory/testing/root-set-fixture.ts": ["test fixture only: isolated test connection"],
  "server/memory/testing/perf-fixture.ts": ["test fixture only: isolated test connection"],
  "server/memory/testing/captured-message.ts": ["test fixture only: isolated test connection"],
  "server/transcript-backfill.ts": ["seq only; row/json/copyOf/exclusions unchanged"],
  "server/send-attempt-compat.ts": ["exportSendAttemptCompat -> bumpCompatReplayEpochs", "importSendAttemptCompat -> bumpCompatReplayEpochs"],
  "server/send-attempt-state.ts": ["setEligibility -> send_replay_epochs", "setEligibility -> send_replay_epochs", "retireThread -> send_replay_epochs"],
  "server/decision/records.ts": ["pre-serving migration, no ReplaySession can exist: initializeDecisionRecords", "pre-serving migration, no ReplaySession can exist: initializeDecisionRecords", "cancelOpenRecords changes card metadata only"],
  "server/restore-prep-core.ts": ["pre-serving migration, no ReplaySession can exist: isolated staged restore"],
  "server/memory/lineage-warm-surface.ts": ["test fixture only: lineage warm surface", "test fixture only: lineage warm surface", "test fixture only: lineage warm surface", "test fixture only: lineage warm surface"],
  "server/memory/lineage-backfill.ts": ["withheldFromBots metadata only; copyOf and validity unchanged"],
  "server/installation-database-snapshot.ts": ["pre-serving migration, no ReplaySession can exist: archive database projection"],
  "server/own-write-holds.ts": ["pre-serving migration, no ReplaySession can exist: sanitizeOwnWriteHoldsForRestore"],
  "server/message-db.ts": ["append -> afterInsert -> noteReplayAncestryChange; plain new rows protected by missing probes", "splice -> afterInsert -> noteReplayAncestryChange", "updateMessage -> afterUpdate(copyChanged) -> noteReplayAncestryChange", "deleteThread -> forgetThread -> noteReplayAncestryChange", "pre-serving migration, no ReplaySession can exist: rebaseMessageAttachmentPaths"],
};
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [join(dir, entry.name)] : []);
}
it("every messages and replay exclusion SQL writer is classified by its epoch owner", () => {
  const found: Record<string, number> = {};
  for (const path of files("server")) {
    const text = readFileSync(path, "utf8");
    const count = [...text.matchAll(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:messages|send_replay_exclusions)\b/gi)].length;
    if (count) found[path] = count;
  }
  expect(found).toEqual(Object.fromEntries(Object.entries(writers).map(([path, entries]) => [path, entries.length])));
  for (const entries of Object.values(writers)) for (const entry of entries) expect(entry.length).toBeGreaterThan(20);
  // The dynamic compatibility insert can target exclusions. It is a
  // pre-serving import; the two JSON passes still bump live-connection epochs.
  expect(readFileSync("server/send-attempt-compat.ts", "utf8")).toContain("bumpCompatReplayEpochs(db, affectedThreads)");
  expect(readFileSync("server/branch-store.ts", "utf8")).toContain("copyChanged || message.copyOf");
});
