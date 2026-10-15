// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { holdForRestore } from "./restore-fence.ts";
import { describeHeldOutputs, describeHeldSharedResults, type HeldItemDeps } from "./restore-hold-list.ts";

const deps: HeldItemDeps = {
  botName: id => ({ b1: "Researcher" } as Record<string, string>)[id],
  threadTitle: id => ({ t1: "Quarterly plan", t2: "Launch notes" } as Record<string, string>)[id],
  sharedDestination: id => (id === "r1" ? "t2" : undefined),
  sharedRequest: id => id === "r1" ? { toBotId: "b1", targetThreadId: "t1", resultMessageId: "m1", outcomeNote: null, finishedAt: 500, createdAt: 100 } : undefined,
  messageText: (_thread, id) => id === "m1" ? "  The   summary\nis ready.  " : undefined,
};

describe("the owner's held list names each item", () => {
  it("lists held outputs with bot, conversation, preview and time, and leaves image operations to a re-ask", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE output_publications (id TEXT PRIMARY KEY, producer TEXT, bot_id TEXT, thread_id TEXT, mime TEXT, artifact_id TEXT, created_at INTEGER); CREATE TABLE artifacts (id TEXT PRIMARY KEY, name TEXT)");
    db.prepare("INSERT INTO artifacts VALUES('a1','report.md')").run();
    db.prepare("INSERT INTO output_publications VALUES('o1','shell-output','b1','t1','text/markdown','a1',42)").run();
    db.prepare("INSERT INTO output_publications VALUES('o2','image-operation','b1','t1','image/png',NULL,43)").run();
    holdForRestore(db, "output_receipt", "o1", "gen-1"); holdForRestore(db, "output_receipt", "o2", "gen-1"); holdForRestore(db, "output_receipt", "gone", "gen-1");
    expect(describeHeldOutputs(db, deps)).toEqual([{ id: "o1", generation: "gen-1", bot: "Researcher", conversation: "Quarterly plan", preview: "report.md", at: 42 }]);
  });
  it("lists held shared results with the bot, the conversation they post to and a short preview", () => {
    const db = new DatabaseSync(":memory:");
    holdForRestore(db, "shared_result", "r1", "gen-1"); holdForRestore(db, "shared_result", "r-missing", "gen-1");
    expect(describeHeldSharedResults(db, deps)).toEqual([{ id: "r1", generation: "gen-1", bot: "Researcher", conversation: "Launch notes", preview: "The summary is ready.", at: 500 }]);
  });
});
