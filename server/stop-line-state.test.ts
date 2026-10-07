// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TASK_ALLOWANCE_TTL_MS, TaskAllowances, chatAllowance, githubRepoFromGitConfig, githubRepoOf, knownRecipients, recipientForms, rememberRecipients } from "./stop-line-state.ts";
import { classifyStopLine, stopLineKey } from "./stop-line.ts";
import { autoVerdict } from "./auto-approve.ts";

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

  it("keeps dates and quoted command bytes exact through task and routine grants", () => {
    const place = { home: "/Users/ada", cwd: "/Users/ada/work", roots: ["/Users/ada/work"], knownRecipients: new Set<string>() };
    const first = classifyStopLine("Bash", { command: 'rm -rf "$ARCHIVE/2026-09-01 09:30"' }, "", place)!;
    const key = stopLineKey(first)!;
    const allowances = new TaskAllowances();
    allowances.grant("bot", "t", key);
    expect(allowances.covering("bot", "t", first)).toBe(key);
    expect(autoVerdict({}, "Bash", "archive", { automated: true, routineLevel: true, routineAllow: [key], stopLine: first }).source).toBe("routine-allow");
    for (const command of ['rm -rf "$ARCHIVE/2026-09-02 09:30"', 'rm -rf "$ARCHIVE/2026-09-01 09:31"', 'rm -rf "$ARCHIVE/2026-09-01  09:30"', 'rm -rf "$archive/2026-09-01 09:30"']) {
      const hit = classifyStopLine("Bash", { command }, "", place)!;
      expect(allowances.covering("bot", "t", hit)).toBeUndefined();
      expect(autoVerdict({}, "Bash", "archive", { automated: true, routineLevel: true, routineAllow: [key], stopLine: hit })).toMatchObject({ approve: null, source: "stop-line" });
      expect(autoVerdict({ alwaysAllow: [key] }, "Bash", "archive", { stopLine: hit })).toMatchObject({ approve: null, source: "stop-line" });
      expect(autoVerdict({}, "Bash", "archive", { stopAllowedForTask: key, stopLine: hit })).toMatchObject({ approve: null, source: "stop-line" });
    }
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

  // On Windows the stop line keys folders as /C:/Users/…, any letter case;
  // an allowance from chat never matched before, because it wanted "/" first
  // and refused every Windows home with 400 (0.1.61 Windows VM).
  it("records a Windows folder the owner named, in the stop line's own form", () => {
    const winHome = "C:\\Users\\Ada";
    const said = "you can delete anything in ~/Projects/site today";
    expect(chatAllowance({ kind: "delete", place: "~/Projects/site" }, said, winHome)).toEqual({
      ok: true, key: "stop:delete:/C:/Users/Ada/Projects/site", note: "You allowed deleting anything in ~/Projects/site for the rest of this task.",
    });
    expect(chatAllowance({ kind: "delete", place: "~\\Projects\\site" }, said, winHome)).toMatchObject({ ok: true, key: "stop:delete:/C:/Users/Ada/Projects/site" });
    expect(chatAllowance({ kind: "delete", place: "c:\\users\\ada\\Projects\\site" }, "delete what is in C:\\Users\\Ada\\Projects\\site", winHome))
      .toMatchObject({ ok: true, key: "stop:delete:/C:/users/ada/Projects/site", note: "You allowed deleting anything in ~/Projects/site for the rest of this task." });
    expect(chatAllowance({ kind: "delete", place: "~" }, "delete anything in ~", winHome).ok).toBe(false);
    expect(chatAllowance({ kind: "delete", place: "~/Documents" }, said, winHome).ok).toBe(false);
  });

  // A folder is named only as a whole path. Naming a folder inside it never
  // names its parent, and a folder that holds the home (C:\Users, /Users) is as
  // broad as the home itself: its grant would cover every other account.
  it("never grants a parent of the named folder, or anything that holds the home", () => {
    const winHome = "C:\\Users\\Ada";
    const winSaid = "you can delete anything in C:\\Users\\Ada\\Documents\\scratch";
    expect(chatAllowance({ kind: "delete", place: "C:\\Users" }, winSaid, winHome).ok).toBe(false);
    expect(chatAllowance({ kind: "delete", place: "C:\\Users\\Ada\\Documents" }, winSaid, winHome).ok).toBe(false);
    expect(chatAllowance({ kind: "delete", place: "C:\\" }, "delete anything in C:\\", winHome).ok).toBe(false);
    expect(chatAllowance({ kind: "delete", place: "C:\\Users" }, "delete anything in C:\\Users", winHome).ok).toBe(false);
    expect(chatAllowance({ kind: "delete", place: "C:\\Users\\Ada\\Documents\\scratch" }, winSaid, winHome)).toMatchObject({ ok: true, key: "stop:delete:/C:/Users/Ada/Documents/scratch" });
    const said = "clear out /Users/ada/Projects/site/build please";
    expect(chatAllowance({ kind: "delete", place: "/Users" }, said, home).ok).toBe(false);
    expect(chatAllowance({ kind: "delete", place: "/Users/ada/Projects" }, said, home).ok).toBe(false);
    expect(chatAllowance({ kind: "delete", place: "~/Projects/site" }, said, home).ok).toBe(false);
    expect(chatAllowance({ kind: "delete", place: "/Users" }, "delete anything in /Users", home).ok).toBe(false);
    expect(chatAllowance({ kind: "delete", place: "/Users/ada/Projects/site/build" }, said, home)).toMatchObject({ ok: true, key: "stop:delete:/Users/ada/Projects/site/build" });
    // Ending a sentence, quoted or with a trailing slash still names it.
    expect(chatAllowance({ kind: "delete", place: "~/Projects/site" }, "Delete what is in \"~/Projects/site/\".", home).ok).toBe(true);
    expect(chatAllowance({ kind: "delete", place: "/tmp/scratch" }, "you can empty /private/tmp/scratch", home).ok).toBe(false);
  });

  // A backslash is an ordinary filename character on macOS and Linux: the
  // folder the owner named is the one granted, never a / spelling of it.
  it("keeps a backslash in a POSIX folder name as written", () => {
    expect(chatAllowance({ kind: "delete", place: "~/a\\b" }, "delete ~/a\\b", home)).toMatchObject({ ok: true, key: "stop:delete:/Users/ada/a\\b" });
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

describe("the owner and the thread are known recipients", () => {
  it("covers every spelling of a channel id", () => {
    expect(recipientForms(["U0OWNER", "<@D123>", ""])).toEqual(["u0owner", "@u0owner", "d123", "@d123"]);
  });

  it("so a message to the owner's account or DM never stops", () => {
    const known = new Set(recipientForms(["U0OWNER", "D0DM", "7777"]));
    const place = { cwd: "/w", roots: ["/w"], home: "/Users/ada", knownRecipients: known };
    expect(classifyStopLine("mcp__slack__send_message", { channel: "D0DM", text: "done" }, "", place)).toBeNull();
    expect(classifyStopLine("mcp__slack__send_message", { channel: "<@U0OWNER>", text: "done" }, "", place)).toBeNull();
    expect(classifyStopLine("mcp__telegram__send_message", { chat_id: 7777, text: "done" }, "", place)).toBeNull();
    expect(classifyStopLine("mcp__slack__send_message", { channel: "@someone-else" }, "", place)?.kind).toBe("message");
  });
});

describe("the repository a gh post lands in", () => {
  it("reads origin from a git config", () => {
    expect(githubRepoFromGitConfig('[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:Ada/site.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')).toBe("Ada/site");
    expect(githubRepoFromGitConfig('[remote "origin"]\n\turl = https://github.com/ada/site\n')).toBe("ada/site");
    expect(githubRepoFromGitConfig('[remote "origin"]\n\turl = https://gitlab.com/ada/site.git\n')).toBeUndefined();
  });

  it("finds it from a subfolder, and through a worktree's pointer", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-gh-repo-"));
    try {
      mkdirSync(join(dir, "main", ".git", "worktrees", "w"), { recursive: true });
      writeFileSync(join(dir, "main", ".git", "config"), '[remote "origin"]\n\turl = git@github.com:ada/site.git\n');
      mkdirSync(join(dir, "main", "src"), { recursive: true });
      expect(githubRepoOf(join(dir, "main", "src"))).toBe("ada/site");
      mkdirSync(join(dir, "wt"));
      writeFileSync(join(dir, "wt", ".git"), `gitdir: ${join(dir, "main", ".git", "worktrees", "w")}\n`);
      writeFileSync(join(dir, "main", ".git", "worktrees", "w", "commondir"), "../..\n");
      expect(githubRepoOf(join(dir, "wt"))).toBe("ada/site");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
