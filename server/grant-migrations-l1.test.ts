// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 test 5 (gate tier), the migrations: a stored payment
// grant is dropped from the bot, its tasks and its routines on load; a public
// destination an older build learned is dropped from the known recipients;
// each logs a count and never the place. And 2.3.7: an allowed public post is
// not learned as a recipient; F16: a failed recipients write names the people
// the next send asks about again.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";
import { knownRecipients, recipientsNotNotedLine, recipientsToRemember, rememberRecipients, rememberStopRecipientsFor } from "./stop-line-state.ts";
import { Store, type BotRecord } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

describe("bot and task lists", () => {
  beforeEach(() => { removeTempDirSync(DATA_DIR); });

  it("drop stored payment grants on load, with one count and no payee", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new Store(selection);
    const bot = store.createBot();
    const botsFile = join(DATA_DIR, "bots.json");
    const legacy: BotRecord[] = JSON.parse(readFileSync(botsFile, "utf8"));
    const record = legacy.find((candidate) => candidate.id === bot.id)!;
    record.alwaysAllow = ["stop:pay:stripe:brightline", "Bash:git", "stop:delete:/Users/alex/site"];
    record.tasks![0]!.alwaysAllow = ["stop:pay:stripe:brightline", "Read"];
    writeFileSync(botsFile, JSON.stringify(legacy));

    const reloaded = new Store(selection);
    const saved = (JSON.parse(readFileSync(botsFile, "utf8")) as BotRecord[]).find((candidate) => candidate.id === bot.id)!;
    expect(saved.alwaysAllow).toEqual(["Bash:git", "stop:delete:/Users/alex/site"]);
    expect(saved.tasks![0]!.alwaysAllow).toEqual(["Read"]);
    expect(reloaded.bot(bot.id)?.alwaysAllow).toEqual(["Bash:git", "stop:delete:/Users/alex/site"]);
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("never kept for good"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("dropped 2");
    expect(lines[0]).not.toContain("brightline");
  });
});

describe("routine lists", () => {
  it("drop stored payment grants on load, with one count and no payee", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-l1a-routines-")); dirs.push(dir);
    const options = (file: string): RoutineManagerOptions => ({
      file, now: () => Date.UTC(2026, 9, 30, 9), emit: () => {}, botState: () => "ready", goalState: () => "ready",
      createTask: () => ({ threadId: "thread-1" }), startTurn: async () => {}, startGoal: async () => {},
    });
    const first = new RoutineManager(options(join(dir, "routines.json")));
    const routine = first.create({ botId: "bot-a", name: "Bills", prompt: "Pay", schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.UTC(2026, 9, 30, 9) } });
    // what an older build could have stored: a payment beside a delete
    const fresh = mkdtempSync(join(tmpdir(), "murage-l1a-routines-load-")); dirs.push(fresh);
    const file = join(fresh, "routines.json");
    copyFileSync(join(dir, "routines.json"), file);
    const disk = JSON.parse(readFileSync(file, "utf8")) as { routines: { id: string; alwaysAllow?: string[] }[] };
    disk.routines.find((item) => item.id === routine.id)!.alwaysAllow = ["stop:pay:stripe:brightline", "stop:delete:/Users/alex/site"];
    writeFileSync(file, JSON.stringify(disk));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = new RoutineManager(options(file));
    expect(loaded.listRoutines().find((item) => item.id === routine.id)?.alwaysAllow).toEqual(["stop:delete:/Users/alex/site"]);
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("never kept for good"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("dropped 1");
    expect(lines[0]).not.toContain("brightline");
  });
});

describe("recipients (2.3.7, F16)", () => {
  it("the loader drops public destinations an older build learned, counted once per bot", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-l1a-recipients-")); dirs.push(dir);
    mkdirSync(join(dir, "stop-line", "recipients"), { recursive: true });
    writeFileSync(join(dir, "stop-line", "recipients", "bot-r.json"), JSON.stringify({ recipients: ["dana@acme.example", "github:ferrox/murage", "github:o/r"] }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect([...knownRecipients(dir, "bot-r")]).toEqual(["dana@acme.example"]);
    expect([...knownRecipients(dir, "bot-r")]).toEqual(["dana@acme.example"]);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual(["[stop-line] dropped 2 public destinations from a bot's known recipients"]);
    // the next write leaves them out for good
    rememberRecipients(dir, "bot-r", ["eve@acme.example"]);
    expect(JSON.parse(readFileSync(join(dir, "stop-line", "recipients", "bot-r.json"), "utf8")).recipients).toEqual(["dana@acme.example", "eve@acme.example"]);
  });

  it("an allowed public post is not learned; a send to a person is", () => {
    expect(recipientsToRemember({ kind: "message", place: "public:github:ferrox/murage", recipients: ["github:ferrox/murage"], what: "Post" })).toEqual([]);
    expect(recipientsToRemember({ kind: "message", place: "dana@acme.example", recipients: ["dana@acme.example"], what: "Send" })).toEqual(["dana@acme.example"]);
    expect(recipientsToRemember({ kind: "delete", place: "/a", what: "Delete" })).toEqual([]);
  });

  it("F16: a failed write returns who was not noted, and the transcript line names them", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const hit = { kind: "message" as const, place: "dana@acme.example", recipients: ["dana@acme.example"], what: "Send" };
    expect(rememberStopRecipientsFor("/nowhere", "bot-r", hit, () => { throw new Error("disk full"); })).toEqual(["dana@acme.example"]);
    expect(rememberStopRecipientsFor("/nowhere", "bot-r", hit, () => {})).toEqual([]);
    expect(recipientsNotNotedLine(["dana@acme.example"])).toBe("Murage could not note dana@acme.example as known, so the next email to dana@acme.example asks again.");
    expect(recipientsNotNotedLine(["a@x.com", "b@x.com"])).toBe("Murage could not note a@x.com and b@x.com as known, so the next email to a@x.com and b@x.com asks again.");
  });
});
