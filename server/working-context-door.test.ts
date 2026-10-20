// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LINEAGE-DESIGN-S6 rule 16: the working context's quoted reply is read through the reader door (bot-read.ts storedRowsShown). A reply the
// door does not show as stored, here because its hand-off or copy chain fails (rule 9), is left out of the block; the same reply with a
// chain that holds is quoted.
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { appendMessage, closeMessageDb } from "./message-db.ts";
import { murageLine } from "./murage-line.ts";
import type { Message } from "./store.ts";
import { workingContext, type WorkingContextInput } from "./working-context.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const HOUR = 3_600_000;
let input: WorkingContextInput;
let n = 0;
const leaves = new Map<string, string>();
beforeEach(() => {
  closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  leaves.clear();
  input = {
    botId: "reed", currentThreadId: "reed-direct", now: NOW,
    bots: [{ id: "reed", threadId: "reed-direct", tasks: [{ threadId: "reed-task", title: "RWA follow-ups" }] }],
    groups: [{ id: "ops", name: "Ops", threadId: "ops-chat", memberIds: ["reed"] }],
    routines: [],
  };
});

/** A row chained on the thread's leaf, as the store appends. */
function say(threadId: string, text: string, at: number, extra: Partial<Message> = {}): Message {
  const parentId = leaves.get(threadId);
  const message = { id: `w${++n}`, role: "bot", kind: "text", text, at, from: { botId: "reed", name: "Reed", color: "blue" }, ...(parentId ? { parentId } : {}), ...extra } as Message;
  leaves.set(threadId, message.id);
  appendMessage(threadId, message);
  return message;
}
const block = (): string => workingContext(LineageAllowance.tool(1_000_000_000), input);

describe("16: the working context quotes a reply only when the door shows it", () => {
  it("control: a plain own reply is quoted", () => {
    say("ops-chat", "Backups checked.", NOW - HOUR);
    expect(block()).toContain(`- Channel "Ops", an hour ago: "Backups checked."`);
  });

  it("a reply whose hand-off source is gone is left out", () => {
    say("ops-chat", "HANDOFF_GONE_CANARY", NOW - HOUR, { handoffOf: { threadId: "elsewhere", messageId: "never-stored" } } as Partial<Message>);
    expect(block()).not.toContain("HANDOFF_GONE_CANARY");
  });

  it("a copy of a Murage-voice row is left out", () => {
    const voice = say("reed-task", "Murage status words", NOW - 3 * HOUR);
    const marked = murageLine({ id: "w-voice", role: "bot", kind: "text", text: "Murage status words", at: NOW - 2 * HOUR, parentId: voice.id }) as Message;
    appendMessage("reed-task", marked);
    leaves.set("reed-task", marked.id);
    say("ops-chat", "COPY_OF_MURAGE_CANARY", NOW - HOUR, { copyOf: { threadId: "reed-task", messageIds: [marked.id] } });
    expect(block()).not.toContain("COPY_OF_MURAGE_CANARY");
  });
});
