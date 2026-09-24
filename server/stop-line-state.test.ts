// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TASK_ALLOWANCE_TTL_MS, TaskAllowances, chatAllowance, knownRecipients, rememberRecipients } from "./stop-line-state.ts";

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

describe("chat allowances", () => {
  const home = "/Users/ada";
  it("records a folder the owner named, in any spelling of it", () => {
    const said = "you can delete anything in ~/Projects/site today";
    expect(chatAllowance({ kind: "delete", place: "~/Projects/site" }, said, home)).toEqual({
      ok: true, key: "stop:delete:/Users/ada/Projects/site", note: "You allowed deleting anything in ~/Projects/site for the rest of this task.",
    });
    expect(chatAllowance({ kind: "delete", place: "/Users/ada/Projects/site/" }, said, home)).toMatchObject({ ok: true, key: "stop:delete:/Users/ada/Projects/site" });
  });

  it("refuses a place the owner never said", () => {
    expect(chatAllowance({ kind: "delete", place: "~/Documents" }, "clean up ~/Projects/site", home).ok).toBe(false);
    expect(chatAllowance({ kind: "message", place: "stranger@x.com" }, "email the team", home).ok).toBe(false);
  });

  it("never allows the whole home folder or a relative or climbing path", () => {
    expect(chatAllowance({ kind: "delete", place: "~" }, "delete anything in ~", home).ok).toBe(false);
    expect(chatAllowance({ kind: "delete", place: "Projects" }, "delete in Projects", home).ok).toBe(false);
    expect(chatAllowance({ kind: "delete", place: "~/Projects/../Documents" }, "~/Projects/../Documents", home).ok).toBe(false);
  });

  it("keys a message to its recipient and a payment to its app and payee", () => {
    expect(chatAllowance({ kind: "message", place: "@newperson" }, "you can DM @newperson", home)).toMatchObject({ ok: true, key: "stop:message:@newperson" });
    expect(chatAllowance({ kind: "pay", place: "cus_1", app: "Stripe" }, "charge cus_1 again if it fails", home)).toMatchObject({ ok: true, key: "stop:pay:stripe:cus_1" });
    expect(chatAllowance({ kind: "pay", place: "cus_1" }, "charge cus_1", home).ok).toBe(false);
  });
});
