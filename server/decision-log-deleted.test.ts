// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

import { DELETED_CONVERSATION, appendDecision, flushDecisionLog, readDecisions, redactDecisionsForThreads } from "./decision-log.ts";

const dir = mkdtempSync(join(tmpdir(), "murage-decisions-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("keeps that an approval happened but not what it said or where", async () => {
  const row = (threadId: string, summary: string) => JSON.stringify({ at: "2026-09-25T10:00:00.000Z", threadId, requestId: "r1", botId: "b1", botName: "Ember", tool: "Bash", summary, decision: "user-allowed", source: "user", rule: `Bash(${summary})` });
  writeFileSync(join(dir, "decisions.ndjson.1"), `${row("gone", "cat ~/mail/secret.txt")}\n${row("kept", "ls")}\n`);
  appendDecision(dir, { threadId: "gone", botId: "b1", botName: "Ember", tool: "Read", summary: "private notes.md", decision: "auto-approved", source: "user", rule: "Read(private notes.md)" });
  appendDecision(dir, { threadId: "kept", tool: "Read", summary: "public.md", decision: "auto-approved", source: "user" });
  await flushDecisionLog(dir);

  await redactDecisionsForThreads(dir, ["gone"]);

  const text = readFileSync(join(dir, "decisions.ndjson"), "utf8") + readFileSync(join(dir, "decisions.ndjson.1"), "utf8");
  expect(text).not.toContain("secret.txt");
  expect(text).not.toContain("private notes");
  expect(text).not.toContain("\"gone\"");
  const rows = readDecisions(dir, 100);
  expect(rows).toHaveLength(4);
  const redacted = rows.filter((item) => item.threadId === DELETED_CONVERSATION);
  expect(redacted.map((item) => [item.at.length > 0, item.botName, item.tool, item.decision])).toEqual([[true, "Ember", "Bash", "user-allowed"], [true, "Ember", "Read", "auto-approved"]]);
  for (const item of redacted) expect(item.summary ?? item.rule ?? item.requestId).toBeUndefined();
  expect(rows.filter((item) => item.threadId === "kept").map((item) => item.summary)).toEqual(["ls", "public.md"]);
});
