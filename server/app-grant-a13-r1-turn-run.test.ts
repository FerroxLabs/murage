// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AMEND-13 build review (Astra a13 r1) item 2, Rule 76b: a routine's keys
// reach only the turn the server started FOR that run; an ordinary turn on
// the same thread, another run and another member get none.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { routineRunGrants } from "./routine-permissions.ts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("item 2, Rule 76b: keys reach only the turn the server started for that run", () => {
  const run = { runId: "run-1", botId: "lead", alwaysAllow: ["app-action:GMAIL_FETCH_EMAILS"] };

  it("gives the run's own turn its keys", () => {
    expect(routineRunGrants(run, "lead", "run-1")).toEqual({ executing: true, alwaysAllow: run.alwaysAllow });
  });

  it("gives an ordinary turn on the same thread, a waiting run's later chat and another run none", () => {
    expect(routineRunGrants(run, "lead", undefined)).toEqual({ executing: false, alwaysAllow: [] });
    expect(routineRunGrants(run, "lead", "run-2")).toEqual({ executing: false, alwaysAllow: [] });
    expect(routineRunGrants(run, "member", "run-1")).toEqual({ executing: false, alwaysAllow: [] });
  });

  it("reads the current turn's run from the server's own record, bound where the run's turn starts", () => {
    const source = read("./index.ts");
    const level = source.slice(source.indexOf("function routineRunLevel("), source.indexOf("function routinePeerSource("));
    expect(level).toMatch(/routineRunGrants\(run, botId \?\? run\.botId, currentTurnRoutineRunId\(threadId\)\)/);
    const current = source.slice(source.indexOf("function currentTurnRoutineRunId("), source.indexOf("function currentTurnRoutineRunId(") + 1200);
    // a direct turn by its own generation; a room goal by its live operation
    expect(current).toContain("routineRunByTurn.get(direct.generation)");
    expect(current).toContain("goalRun");
    // bound only when the server starts the run's turn or carries the same run on
    expect(source).toMatch(/routineRunByTurn\.set\(run\.generation, boundRunId\)/);
    expect(source).toMatch(/routineRunId: run\.id/);
  });
});
