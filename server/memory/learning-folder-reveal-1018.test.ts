// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two bot-specific learning entry points outside consolidate launch a CLI or ACP engine in the folder of the bot the words came from
// (learning-folder.ts), never the host default and never another bot's. Reveal grounding runs through captureBotReveals, feedback
// through classifierInBotFolder (the wrapper wireBotLearning puts around the leased classifier).
import { mkdirSync } from "node:fs";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { writeBotIdentity } from "./identity.ts";
import { captureBotReveals } from "./reveal-capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { learningFolderScope, setLearningBotFolder } from "./learning-folder.ts";
import { classifierInBotFolder } from "./learning-wiring.ts";
import type { TextOnlyExtractor } from "./extract.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "moss", threadId: "private" }], groups: [] };
const ticket = ownerMemoryTicket(), text = "Moss once tended a fictional lighthouse.", signal = () => new AbortController().signal;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); });
afterEach(() => setLearningBotFolder(undefined));
function canon() { return writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "character-canon", key: "lighthouse", expectedVersion: 0, text, basis: "fiction", audience: "owner-private" }, roster); }
function message(value: string) {
  appendMessage("private", { id: "reply", at: 1, role: "bot", kind: "text", text: value, turnId: "turn", turnTerminal: true });
  let work; while ((work = claimMemoryJob("fixture"))) publishMemoryWork(work, "fixture", captureWork(work));
  return String(database().prepare("SELECT id FROM memory_jobs WHERE source_id=?").get("message:private:reply")?.id ?? "");
}

describe("reveal grounding runs in the revealing bot's folder", () => {
  it("scope carries that bot's folder when it has one, and an explicit none when it has not", async () => {
    for (const folder of ["/bots/moss", undefined]) {
      canon(); setLearningBotFolder(id => id === "moss" ? folder : "/another/bots/folder");
      const seen: Array<{ cwd: string | undefined } | undefined> = [];
      const extract = Object.assign(async () => "[]", { ground: async () => { seen.push(learningFolderScope()); return JSON.stringify({ supported: true }); } }) as TextOnlyExtractor;
      await captureBotReveals(message("In my fictional past, I looked after a beacon by the sea."), () => roster, extract, signal());
      expect(seen).toEqual([{ cwd: folder }]);
      closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster);
    }
  });
});

describe("feedback classification runs in the folder of the bot the message talks to", () => {
  const input = (botId?: string) => ({ turn: botId ? { botId } : null, message: "no, not like that" }) as never;
  const classify = async (resolve: (turn: never) => string | null, botId?: string) => {
    const seen: Array<{ cwd: string | undefined } | undefined> = [];
    const inner = { classify: async () => { seen.push(learningFolderScope()); return "{}"; } };
    await classifierInBotFolder(inner as never, resolve as never).classify(input(botId), signal());
    return seen;
  };
  it("a room's prior speaker wins over the thread bot, and a speaker without a folder is an explicit none", async () => {
    setLearningBotFolder(id => id === "speaker" ? "/bots/speaker" : id === "bare" ? undefined : "/bots/thread");
    const resolve = (turn: { botId?: string } | null) => turn?.botId ?? "threadbot";
    expect(await classify(resolve as never, "speaker")).toEqual([{ cwd: "/bots/speaker" }]);
    expect(await classify(resolve as never, "bare")).toEqual([{ cwd: undefined }]);
    expect(await classify(resolve as never)).toEqual([{ cwd: "/bots/thread" }]);
  });
  it("no resolvable bot keeps the host default (no scope)", async () => {
    setLearningBotFolder(() => "/bots/any");
    expect(await classify(() => null as never)).toEqual([undefined]);
  });
});
