// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LINEAGE-DESIGN-S6 rule 18b for project tool answers: a project page a bot reads is built from the door's BotRows (a Murage-voice row shows
// only its fixed-copy projection, never its stored words), a reading bot whose record is gone reads nothing (fail closed), and the owner's
// view goes through the door as the human viewer by an explicit owner route, the one human literal project-memory-tools.ts may hold.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedCopy } from "./bot-read.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { setExecutionStore } from "./execution-audience.ts";
import { appendMessage } from "./message-db.ts";
import { setMemoryCaptureRoster } from "./memory/capture-scope.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { OWNER_PAGE, readProjectMessages, readProjectPage } from "./project-memory-tools.ts";
import { channelToProjectRows } from "./project-settings.ts";
import type { Message, Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const NOW = 1_790_000_000_000;
type Roster = MemoryRoster & { bots: Array<MemoryRoster["bots"][number] & { name: string }> };
let roster: Roster;
let present: Set<string>;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  roster = {
    bots: [
      { id: "dax", name: "Dax", threadId: "dax-direct", section: "Sales", tasks: [{ threadId: "dax-desk", channelProjectDesk: { groupId: "launch" } }] },
      { id: "finch", name: "Finch", threadId: "finch-direct", section: "Ops" },
    ],
    groups: [{ id: "launch", threadId: "launch-chat", memberIds: ["dax", "finch"], channelProject: { goal: "Launch" } }],
  };
  present = new Set(["dax", "finch"]);
  setExecutionStore({ bot: (id: string) => present.has(id) ? roster.bots.find(bot => bot.id === id) : undefined } as unknown as Store);
  setMemoryCaptureRoster(() => roster);
  setMemoryMode("active");
  reconcileMemoryRoster(roster);
  channelToProjectRows(database(), { groupId: "launch", bulletin: "", leadBotId: "finch", now: NOW });
});
afterEach(() => { setExecutionStore(undefined as never); closeDatabase(); });

let n = 0;
let head: string | undefined;
beforeEach(() => { head = undefined; });
function say(text: string, extra: Partial<Message> = {}): Message {
  const message = { id: `p${++n}`, role: "bot", kind: "text", text, at: NOW + n, from: { botId: "finch", name: "Finch", color: "blue" }, ...(head ? { parentId: head } : {}), ...extra } as Message;
  head = message.id;
  appendMessage("launch-chat", message);
  return message;
}
const DAX = { botId: "dax", threadId: "dax-desk" };
type Page = { messages: Array<{ id: string; speaker: string; text: string }> };
const page = (result: { status: number; body: unknown }) => result.body as Page;

describe("project tool answers are built from BotRows", () => {
  it("a Murage-voice row on the page reads as its fixed-copy projection, never its stored words", () => {
    say("Card 2 is ready.");
    const chip = say("STORED_CHIP_CANARY", { murage: { kind: "failure", status: { key: "withheld" } } } as Partial<Message>);
    const read = readProjectMessages(database(), roster, "launch", {}, DAX);
    expect(read.status).toBe(200);
    const text = JSON.stringify(read.body);
    expect(text).not.toContain("STORED_CHIP_CANARY");
    expect(text).toContain("Card 2 is ready.");
    const line = page(read).messages.find(message => message.id === chip.id);
    expect(line?.text).toBe(fixedCopy(chip));
  });
  it("the speaker is the BotRow's speaker, by the roster's current name", () => {
    say("Shipped.", { from: { botId: "finch", name: "Old Finch", color: "blue" } } as Partial<Message>);
    expect(page(readProjectMessages(database(), roster, "launch", {}, DAX)).messages.map(m => m.speaker)).toEqual(["Finch"]);
  });
});

describe("fail closed: no reading bot record, no bot-visible content", () => {
  it("a reading bot whose record is gone reads no line of the page and rests on none", () => {
    say("SECRET_PAGE_CANARY");
    present.delete("dax");
    const read = readProjectPage(database(), roster, "launch", {}, DAX);
    expect(read.result.status).toBe(403);
    expect(JSON.stringify(read.result.body)).not.toContain("SECRET_PAGE_CANARY");
    expect(read.shown).toEqual([]);
  });
  it("with no execution store at all, a bot reads nothing", () => {
    say("SECRET_PAGE_CANARY");
    setExecutionStore(undefined as never);
    const read = readProjectPage(database(), roster, "launch", {}, DAX);
    expect(read.result.status).toBe(403);
    expect(JSON.stringify(read.result.body)).not.toContain("SECRET_PAGE_CANARY");
  });
});

describe("the owner's view is an explicit route through the door", () => {
  it("OWNER_PAGE reads the page as stored, with the owner's withholding of forgotten lines unchanged", () => {
    say("Owner sees this.");
    const chip = say("CHIP_WORDS", { murage: { kind: "failure", status: { key: "withheld" } } } as Partial<Message>);
    present.clear();
    const read = readProjectMessages(database(), roster, "launch", {}, OWNER_PAGE);
    expect(read.status).toBe(200);
    expect(page(read).messages.map(m => m.text)).toEqual(["Owner sees this.", chip.text]);
  });
  it("the reader is required: no call reads a page without naming a bot or the owner", () => {
    say("NOBODY_CANARY");
    // @ts-expect-error a page is read by a bot or by OWNER_PAGE, never by nobody
    expect(() => readProjectMessages(database(), roster, "launch", {})).toThrow();
    // @ts-expect-error
    expect(() => readProjectPage(database(), roster, "launch", {})).toThrow();
  });
  it("project-memory-tools.ts holds the human viewer literal once, inside ownerPageViewer", () => {
    const code = readFileSync(join(import.meta.dirname, "project-memory-tools.ts"), "utf8").split("\n");
    const hits = code.map((line, index) => ({ line, index })).filter(({ line }) => /kind:\s*["']human["']/.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*"));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toMatch(/const ownerPageViewer\b/);
  });
});
