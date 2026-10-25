// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// READER-PRIVACY-104 U14 (room deny-line, the "cache" half): "What I've been working on" is built for the turn's fence reader, and a
// quoted reply that reader may not see is left out of the block at the build (working-context.ts readerShown). Nothing that decides
// whether a line may be shown is kept between builds: the kept discovery holds thread ids and reply ids only, so a refusal committed
// after one build is honoured by the very next build with no cache to clear, and the same kept discovery is judged afresh for each reader.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

/** The fence reader's verdicts, decided here: a room reader sees every quoted line except the ones a committed revoke refuses. */
const fence = vi.hoisted(() => ({ refused: new Set<string>() }));
vi.mock("./memory/deny-read.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./memory/deny-read.ts")>();
  const denyLookup: typeof real.denyLookup = (db, page, reader, options) => {
    if (reader.audience === null) return real.denyLookup(db, page, reader, options);
    return new Map(page.lines.map(line => [line.messageId, fence.refused.has(line.messageId) ? { state: "withheld", reason: "deny-line" } as const : { state: "shown" } as const]));
  };
  return { ...real, denyLookup };
});

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { appendMessage } from "./message-db.ts";
import type { Message } from "./store.ts";
import { workingContextBlock, type WorkingContextInput } from "./working-context.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import type { LineageReader } from "./memory/lineage-types.ts";

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const HOUR = 3_600_000;
const ROOM: LineageReader = { audience: { owner: false, scopeIds: ["room:ops"] } };
let input: WorkingContextInput;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  fence.refused.clear();
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
const build = (reader: LineageReader | undefined, now: number) => workingContextBlock(LineageAllowance.tool(), true, { ...input, now }, database(), reader);

it("T5: a room reader's quote the fence refuses after a revoke is left out of the very next build; no verdict was kept", () => {
  const message = reply("ops-chat", "ROOM_QUOTE_CANARY for the ops room.", NOW - HOUR);
  const first = build(ROOM, NOW);
  expect(first.text).toContain("ROOM_QUOTE_CANARY");
  expect(first.quoted.map(quote => quote.messageId)).toContain(message.id);
  // a receipt revoke commits between two builds: the fence now refuses the line for this reader. Same inputs, well inside
  // TURN_CACHE_MS, so the kept discovery is reused as it is; the line is judged again all the same
  fence.refused.add(message.id);
  const next = build(ROOM, NOW + 1_000);
  expect(next.text).not.toContain("ROOM_QUOTE_CANARY");
  expect(next.quoted.map(quote => quote.messageId)).not.toContain(message.id);
  // the same kept discovery, read for a content reader (no fence audience): the line is theirs to see
  expect(build(undefined, NOW + 2_000).text).toContain("ROOM_QUOTE_CANARY");
  // and back for the room once the refusal is lifted: nothing about the verdict was kept
  fence.refused.delete(message.id);
  expect(build(ROOM, NOW + 3_000).text).toContain("ROOM_QUOTE_CANARY");
});
