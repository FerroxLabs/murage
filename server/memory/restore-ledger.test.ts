import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SqliteOperationJournal, type JournalRecord } from "../connected-app-journal.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { mergeOriginalMemoryDeletions } from "./restore.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });

it("a separate restore carries the original installation's unresolved connected-app guards into the new one (A2)", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-restore-ledger-"));
  roots.push(root);
  const original = join(root, "original"), candidate = join(root, "candidate");
  mkdirSync(original); mkdirSync(candidate);
  const record: JournalRecord = { handle: "op-1", scope: "bot-a|tool|hash|acct-old", key: "send-email:to-a", label: "Send email", startedAt: 1, state: "unknown", cause: "no-answer", requirements: [], requirementsComplete: true };
  const journal = new SqliteOperationJournal(join(original, "connected-app-ledger.db"));
  try { journal.put(record); } finally { journal.close(); }
  writeFileSync(join(candidate, "restore-review.json"), JSON.stringify({ version: 1, status: "review-required", policyVersion: 1, modifications: [] }));
  mergeOriginalMemoryDeletions(original, candidate);
  const restored = new SqliteOperationJournal(join(candidate, "connected-app-ledger.db"));
  try {
    const loaded = restored.load();
    expect(loaded.map(item => item.handle)).toEqual(["op-1"]);
    expect(loaded[0]!.state).toBe("unknown");
    expect(loaded[0]!.scope).toBe("bot-a|tool|hash|*");
  } finally { restored.close(); }
  const review = JSON.parse(readFileSync(join(candidate, "restore-review.json"), "utf8"));
  expect(review.modifications.map((item: { component: string }) => item.component)).toContain("connected-app-ledger.db");
});
