// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "What I've been working on" never shows a line that is no longer true (1.0.2 turnctx r1): what is kept between
// turns is only which threads and which replies to look at; whether a line may be shown, and its words, are asked
// again on every turn. Each case builds the block once (so it is kept), changes something the kept discovery does
// not see, and builds it again.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

const lineage = vi.hoisted(() => ({ withheld: new Set<string>() }));
vi.mock("./memory/replay-lineage.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./memory/replay-lineage.ts")>();
  return { ...real, capturedMessageVerdict: (allowance: never, threadId: string, messageId: string) => lineage.withheld.has(messageId) ? { withheld: true, unproven: false } : real.capturedMessageVerdict(allowance, threadId, messageId) };
});
const scope = vi.hoisted(() => ({ live: false, otherPartition: new Set<string>() }));
vi.mock("./execution-audience.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./execution-audience.ts")>();
  const liveBot = { id: "reed", threadId: "reed-direct", partitionedAt: 1 };
  return {
    ...real,
    executionStore: () => scope.live ? { bot: (id: string) => id === "reed" ? liveBot : undefined } : real.executionStore(),
    homeThread: (bot: { threadId: string }) => scope.live ? { threadId: bot.threadId } : real.homeThread(bot as never),
    threadPartition: (bot: never, threadId: string) => scope.live ? { kind: "home" } : real.threadPartition(bot, threadId),
    sameThreadPartition: (bot: never, threadId: string, other: string) => scope.live ? !scope.otherPartition.has(other) : real.sameThreadPartition(bot, threadId, other),
  };
});

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { appendMessage, updateMessage } from "./message-db.ts";
import type { Message } from "./store.ts";
import { workingContext, type WorkingContextInput } from "./working-context.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const HOUR = 3_600_000;
let input: WorkingContextInput;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  lineage.withheld.clear(); scope.live = false; scope.otherPartition.clear();
  input = {
    botId: "reed", currentThreadId: "reed-direct", now: NOW,
    bots: [{ id: "reed", threadId: "reed-direct", tasks: [{ threadId: "reed-direct", title: "Reed" }, { threadId: "reed-task", title: "RWA follow-ups" }] }],
    groups: [{ id: "ops", name: "Ops", threadId: "ops-chat", memberIds: ["reed"] }],
    routines: [],
  };
});

let n = 0;
function reply(threadId: string, text: string, at: number): Message {
  const message = { id: `w${++n}`, role: "bot", kind: "text", text, at, from: { botId: "reed", name: "Reed", color: "blue" } } as Message;
  appendMessage(threadId, message);
  return message;
}

it("P1-1: a reply patched after it was shown (new words, or withheld from bots) is shown as it is now, on the next turn", () => {
  const message = reply("reed-task", "OLD_WORDS_CANARY for Dana.", NOW - HOUR);
  expect(workingContext(LineageAllowance.tool(), input)).toContain("OLD_WORDS_CANARY");
  // a post-hoc removal rewrites the words through the store's patch path
  updateMessage("reed-task", { ...message, text: "The follow-up went to Dana." });
  const patched = workingContext(LineageAllowance.tool(), { ...input, now: NOW + 1_000 });
  expect(patched).not.toContain("OLD_WORDS_CANARY");
  expect(patched).toContain("The follow-up went to Dana.");
  updateMessage("reed-task", { ...message, text: "The follow-up went to Dana.", withheldFromBots: "forgotten" } as Message);
  expect(workingContext(LineageAllowance.tool(), { ...input, now: NOW + 2_000 })).not.toContain("follow-up went to Dana");
});

it("P1-1: the words are read from the message on every turn, whatever path changed them", () => {
  reply("reed-task", "SECRET_WORDS_CANARY in the reply.", NOW - HOUR);
  expect(workingContext(LineageAllowance.tool(), input)).toContain("SECRET_WORDS_CANARY");
  // a write that notes nothing anywhere
  database().prepare("UPDATE messages SET text=? WHERE thread_id=?").run("Redacted reply.", "reed-task");
  const text = workingContext(LineageAllowance.tool(), { ...input, now: NOW + 1_000 });
  expect(text).not.toContain("SECRET_WORDS_CANARY");
  expect(text).toContain("Redacted reply.");
});

it("P1-2: a reply the lineage judge withholds since it was shown (a source it rests on was corrected elsewhere) is not shown, with no change to its thread", () => {
  const message = reply("ops-chat", "LINEAGE_CANARY from the corrected source.", NOW - HOUR);
  expect(workingContext(LineageAllowance.tool(), input)).toContain("LINEAGE_CANARY");
  // the verdict moves (a NOTE-only invalidation: an archived record, a retired source); no message is written
  lineage.withheld.add(message.id);
  expect(workingContext(LineageAllowance.tool(), { ...input, now: NOW + 1_000 })).not.toContain("LINEAGE_CANARY");
  // and comes back when the judge lets bots see it again: nothing about the verdict was kept
  lineage.withheld.delete(message.id);
  expect(workingContext(LineageAllowance.tool(), { ...input, now: NOW + 2_000 })).toContain("LINEAGE_CANARY");
});

it("P1-3: a room moved out of this conversation's partition is not shown, nor its files, with no change to names, members or threads", () => {
  scope.live = true;
  reply("ops-chat", "SCOPE_CANARY from the home team's channel.", NOW - HOUR);
  database().prepare("INSERT INTO artifacts(id,name,kind,mime,bytes,sha256,extension,created_at,bot_id,thread_id,run_id,source_root,relative_path,source_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("a1", "plan.md", "document", "text/markdown", 10, "0".repeat(64), ".md", NOW - HOUR, "reed", "ops-chat", "run", "root", "docs/SCOPE_FILE_CANARY.md", "fp");
  const before = workingContext(LineageAllowance.tool(), input);
  expect(before).toContain("SCOPE_CANARY");
  expect(before).toContain("SCOPE_FILE_CANARY");
  // the channel moves to another section: it is now a partition of its own
  scope.otherPartition.add("ops-chat");
  const after = workingContext(LineageAllowance.tool(), { ...input, now: NOW + 1_000 });
  expect(after).not.toContain("SCOPE_CANARY");
  expect(after).not.toContain("SCOPE_FILE_CANARY");
  // past the rebuild interval too
  expect(workingContext(LineageAllowance.tool(), { ...input, now: NOW + 11 * 60_000 })).not.toContain("SCOPE_CANARY");
});

it("P1-3: a task removed from the bot is not shown, though its list kept its length and ends", () => {
  input.bots[0]!.tasks = [{ threadId: "reed-direct", title: "Reed" }, { threadId: "reed-task", title: "RWA follow-ups" }, { threadId: "reed-last", title: "Last" }];
  reply("reed-task", "REMOVED_TASK_CANARY", NOW - HOUR);
  expect(workingContext(LineageAllowance.tool(), input)).toContain("REMOVED_TASK_CANARY");
  // the middle task leaves (moved to another bot); first and last stay, the length is the same
  input.bots[0]!.tasks = [{ threadId: "reed-direct", title: "Reed" }, { threadId: "reed-other", title: "Other" }, { threadId: "reed-last", title: "Last" }];
  expect(workingContext(LineageAllowance.tool(), { ...input, now: NOW + 1_000 })).not.toContain("REMOVED_TASK_CANARY");
});
