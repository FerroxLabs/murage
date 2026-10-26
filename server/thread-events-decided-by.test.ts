// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.5: the Inspector's request.resolved line names the automatic rule from the decision log (the engine reports `user`).
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readThreadEvents } from "./thread-events.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let dir = "";
afterEach(() => { if (dir) removeTempDirSync(dir); dir = ""; });
const line = (requestId: string, at: string) => JSON.stringify({ eventId: `e-${requestId}`, provider: "fuigoAgent", threadId: "t1", createdAt: at, type: "request.resolved", requestId, behavior: "allow", source: "user" });

it("an automatic answer is served with the rule that made it; a person's answer and the log file itself are unchanged", () => {
  dir = mkdtempSync(join(tmpdir(), "decided-by-"));
  const events = join(dir, "events"), native = join(dir, "native");
  mkdirSync(events); mkdirSync(native);
  const log = [line("auto", "2026-10-24T01:00:00.000Z"), line("clicked", "2026-10-24T01:00:01.000Z")].join("\n") + "\n";
  writeFileSync(join(events, "t1.ndjson"), log);
  const page = readThreadEvents({ eventsDir: events, nativeDir: native, threadId: "t1", decisions: [
    { threadId: "t1", requestId: "auto", decision: "auto-approved", source: "own-workspace" },
    { threadId: "t1", requestId: "clicked", decision: "user-approved", source: "user" },
    { threadId: "other", requestId: "clicked", decision: "auto-approved", source: "auto-mode" },
  ] });
  const served = page.entries.map(entry => entry.data as { requestId: string; decidedBy?: string });
  expect(served.find(row => row.requestId === "auto")?.decidedBy).toBe("own-workspace");
  expect(served.find(row => row.requestId === "clicked")?.decidedBy).toBeUndefined();
  expect(readFileSync(join(events, "t1.ndjson"), "utf8")).toBe(log);
});
