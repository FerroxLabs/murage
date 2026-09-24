// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TASK_ALLOWANCE_TTL_MS, TaskAllowances, knownRecipients, rememberRecipients } from "./stop-line-state.ts";

describe("task allowances", () => {
  const outside = { kind: "delete" as const, place: "/Users/ada/Projects/other/build", what: "x" };

  it("cover the same kind in the same place for this task only", () => {
    let now = 1_000;
    const allowances = new TaskAllowances(() => now);
    allowances.grant("bot", "t1", "stop:delete:/Users/ada/Projects/other");
    expect(allowances.covering("bot", "t1", outside)).toBe("stop:delete:/Users/ada/Projects/other");
    expect(allowances.covering("bot", "t2", outside)).toBeUndefined();
    expect(allowances.covering("other-bot", "t1", outside)).toBeUndefined();
    expect(allowances.covering("bot", "t1", { ...outside, kind: "message" })).toBeUndefined();
    expect(allowances.covering("bot", "t1", { ...outside, place: "/Users/ada/Documents" })).toBeUndefined();
    now += TASK_ALLOWANCE_TTL_MS;
    expect(allowances.covering("bot", "t1", outside)).toBeUndefined();
  });

  it("end when the conversation is reset", () => {
    const allowances = new TaskAllowances();
    allowances.grant("bot", "t1", "stop:delete:/Users/ada/Projects/other");
    allowances.clearThread("t1");
    expect(allowances.covering("bot", "t1", outside)).toBeUndefined();
  });
});

describe("recipient record", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

  it("remembers who a bot has written to, per bot, durably", () => {
    dir = mkdtempSync(join(tmpdir(), "murage-stop-line-"));
    expect(knownRecipients(dir, "bot-1").size).toBe(0);
    rememberRecipients(dir, "bot-1", ["Boss <BOSS@example.com>", "#general"]);
    expect([...knownRecipients(dir, "bot-1")].sort()).toEqual(["#general", "boss@example.com"]);
    expect(knownRecipients(dir, "bot-2").size).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "stop-line", "recipients", "bot-1.json"), "utf8")).recipients).toHaveLength(2);
  });

  it("refuses a bot id that could name another file", () => {
    dir = mkdtempSync(join(tmpdir(), "murage-stop-line-"));
    rememberRecipients(dir, "../escape", ["a@b.c"]);
    expect(knownRecipients(dir, "../escape").size).toBe(0);
  });
});
