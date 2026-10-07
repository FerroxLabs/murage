// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 T2 round 3, R3-7 (lane M): with memory not active, a direct chat's
// replay showed a reply (or a copy of one) that used something the owner has
// since forgotten, because no receipt was read at all. The direct replay now
// follows the same content rule as a room: the withheld line for the owner's
// turn, left out for a turn that is not the owner's.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./memory/authority.ts";
import { captureSource } from "./memory/capture.ts";
import { forgetMemory } from "./memory/forget.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { roomTranscriptWithoutMemory } from "./room-transcript.ts";
import type { Message } from "./store.ts";
import { transcriptText } from "./replies.ts";

const roster: MemoryRoster = { bots: [{ id: "dax", threadId: "dax-direct", tasks: [{ threadId: "dax-older" }] }], groups: [] };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); reconcileMemoryRoster(roster); });

it("a direct reply made with memory the owner then forgot is withheld from the replay while memory is off", () => {
  const text = "The vault code is 7788.";
  captureSource(database(), { id: "message:dax-older:m0", threadId: "dax-older", messageId: "m0", kind: "text", speaker: "owner", outcome: "recorded", text });
  const registry = new InternalCapabilities(); registry.begin("dax", "dax-direct", "g");
  const access = memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "dax", threadId: "dax-direct", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
  const record = saveMemoryCandidate(text, [{ sourceId: "message:dax-older:m0", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", access);
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  database().prepare(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    VALUES('b1','dax-direct','engine',NULL,?,'[]','["m-reply"]',0,0,1,'delivered',1)`).run(JSON.stringify([{ id: record, version: 1 }]));
  const lines = [{ id: "m-ask", role: "user", kind: "text", text: "code?", at: 1 } as Message, { id: "m-reply", role: "bot", kind: "text", text: "It is 7788.", at: 2 } as Message];
  setMemoryMode("off");
  expect(roomTranscriptWithoutMemory("dax-direct", lines, true)?.withheld.size).toBe(0);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  const owner = roomTranscriptWithoutMemory("dax-direct", lines, true)!;
  expect(owner.messages.find(m => m.id === "m-reply")?.text).toContain("Reply withheld");
  expect(roomTranscriptWithoutMemory("dax-direct", lines, false)!.messages.map(m => m.id)).toEqual(["m-ask"]);
  // and the direct turn replays through it when memory is not active
  const index = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  expect(index).toContain(`const replayFloor = memoryState().mode === "active" ? undefined`);
  const replayDeclaration = index.split("\n").find(line => line.includes("const replayableMessages ="));
  expect(replayDeclaration).toContain("(replayFloor?.messages ?? activeMessages)");
  expect(replayDeclaration).toContain("opts?.projectCardRun ? [] : (replayFloor?.messages ?? activeMessages)");
  // Astra r1 #5: an owner line answering the withheld reply quotes the withheld line
  expect(index).toContain("const quoteTargets: ReadonlyMap<string, Message> = replayFloor ? new Map(replayFloor.messages.map((message) => [message.id, message])) : messagesById;");
  const answer = { id: "m-thanks", role: "user", kind: "text", text: "thanks", replyToId: "m-reply", at: 3 } as Message;
  const floor = roomTranscriptWithoutMemory("dax-direct", [...lines, answer], true)!;
  const quoted = transcriptText(answer, new Map(floor.messages.map(m => [m.id, m])));
  expect(quoted).not.toContain("7788");
  expect(quoted).toContain("Reply withheld");
});
