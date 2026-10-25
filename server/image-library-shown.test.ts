// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// 104 High 01-A1: a saved prompt block whose writer turn the owner forgot is not handed back by the list or the get.
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { appendMessage, closeMessageDb } from "./message-db.ts";
import type { Message } from "./store.ts";
import { getPromptBlock, listPromptBlocksForBot, savePromptBlock } from "./image-library.ts";
import { imageLibraryRef, shownPromptBlocks } from "./image-library-shown.ts";
import { closeTurnLineage, openTurnLineage } from "./memory/lineage-write.ts";
import { drainRevokeMarker } from "./memory/memory-revocation.ts";
import { recordTurnObject } from "./memory/prompt-parts.ts";
import { commitRevoke } from "./memory/revoke-commit.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at: Date.now(), ...extra });

beforeEach(() => { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

it("a block saved in a turn is withheld from the list and the get once its source line is forgotten", () => {
  const db = database();
  appendMessage("T", msg("o1", { role: "user" }));
  const turn = openTurnLineage(db, { threadId: "T", turnId: "t1" });
  try {
    appendMessage("T", msg("a1", { parentId: "o1" }));
    savePromptBlock(db, { scope: "bot", botId: "lib", name: "secret-look", text: "CANARY_BLOCK_TEXT", createdBy: "bot:b" });
    savePromptBlock(db, { scope: "workspace", botId: "", name: "house-style", text: "WORKSPACE_TEXT", createdBy: "owner" });
    recordTurnObject(db, "T", imageLibraryRef("lib", "prompt-block", "secret-look"));
  } finally { closeTurnLineage(turn); }
  const names = () => shownPromptBlocks(db, "lib", listPromptBlocksForBot(db, "lib")).map(block => block.name).sort();
  expect(names()).toEqual(["house-style", "secret-look"]);
  commitRevoke(db, { kind: "line", threadId: "T", messageIds: ["a1"], cause: "forget" });
  expect(drainRevokeMarker(db).pending).toBe(false);
  expect(names()).toEqual(["house-style"]);
  expect(shownPromptBlocks(db, "lib", [getPromptBlock(db, { kind: "bot", botId: "lib" }, "secret-look")])).toEqual([]);
});

it("the library routes pass the list and the get through the shown filter", () => {
  const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  expect(source).toContain("shownPromptBlocks(database(), actor.botId, listPromptBlocksForBot(database(), actor.botId))");
  expect(source).toContain("shownPromptBlocks(database(), actor.botId, [block]).length === 0");
});
