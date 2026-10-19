// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AMEND-13 Rule 76b: a shared speaker may use a routine's remembered keys
// only where the server proves THAT speaker is executing that same active
// routine run. Another member in the same room shares the run's thread and
// ceiling but gets none of its keys, and is offered no routine grant.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { routineRunGrants } from "./routine-permissions.ts";

const KEYS = ["app-action:GMAIL_FETCH_EMAILS", "stop:message:bob@example.com"];
const run = { runId: "run-1", botId: "lead", alwaysAllow: KEYS };

describe("Rule 76b: only the bot executing the run uses its keys", () => {
  it("gives the run's executing bot the routine's keys", () => {
    expect(routineRunGrants(run, "lead", "run-1")).toEqual({ executing: true, alwaysAllow: KEYS });
  });

  it("gives another member of the same room none of them", () => {
    expect(routineRunGrants(run, "member", "run-1")).toEqual({ executing: false, alwaysAllow: [] });
  });

  it("never treats an unnamed asker as the executing bot", () => {
    expect(routineRunGrants(run, "", "run-1")).toEqual({ executing: false, alwaysAllow: [] });
  });

  it("is what the request path reads, from the server's own run and asker", () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    const level = source.slice(source.indexOf("function routineRunLevel("), source.indexOf("function routinePeerSource("));
    expect(level).toMatch(/routineRunGrants\(run, botId \?\? run\.botId, currentTurnRoutineRunId\(threadId\)\)/);
    expect(level).not.toMatch(/alwaysAllow: run\.alwaysAllow/);
    // the card offers the routine choice only to the executing bot
    expect(source).toMatch(/const routineOffered = routineLevel\?\.executing === true/);
  });
});
