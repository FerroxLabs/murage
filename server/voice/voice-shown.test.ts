// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// 104 High 01-B1: a voice call's snapshot leaves out a line the owner forgot.
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, closeMessageDb } from "../message-db.ts";
import { closeTurnLineage, openTurnLineage } from "../memory/lineage-write.ts";
import { drainRevokeMarker } from "../memory/memory-revocation.ts";
import { commitRevoke } from "../memory/revoke-commit.ts";
import type { Message } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { voiceHostState } from "./voice-host-route.ts";
import { voiceRowsShown } from "./voice-shown.ts";

const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: `words of ${id}`, at: Date.now(), ...extra });

beforeEach(() => { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

it("a forgotten reply is not in the rows the voice host reads, and the snapshot built from them does not carry its words", () => {
  const db = database();
  const rows = [msg("o1", { role: "user" }), msg("a1", { parentId: "o1" }), msg("o2", { role: "user", parentId: "a1" }), msg("a2", { parentId: "o2" })];
  appendMessage("T", rows[0]!);
  const turn = openTurnLineage(db, { threadId: "T", turnId: "t1" });
  try { appendMessage("T", rows[1]!); } finally { closeTurnLineage(turn); }
  appendMessage("T", rows[2]!);
  const turn2 = openTurnLineage(db, { threadId: "T", turnId: "t2" });
  try { appendMessage("T", rows[3]!); } finally { closeTurnLineage(turn2); }
  expect(voiceRowsShown(db, "T", rows).map(row => row.id)).toEqual(["o1", "a1", "o2", "a2"]);
  commitRevoke(db, { kind: "line", threadId: "T", messageIds: ["a1"], cause: "forget" });
  expect(drainRevokeMarker(db).pending).toBe(false);
  const kept = voiceRowsShown(db, "T", rows);
  expect(kept.map(row => row.id)).not.toContain("a1");
  const state = voiceHostState({ id: "b", name: "B", threadId: "T" }, "T", { activePath: () => kept, lastActivityAt: () => undefined, needsYou: () => [] }, Date.now());
  expect(JSON.stringify(state)).not.toContain("words of a1");
  // what the owner wrote stays; a2 rested on the forgotten reply, so it is left out with it
  expect(JSON.stringify(state)).toContain("words of o2");
  expect(JSON.stringify(state)).not.toContain("words of a2");
});

it("the voice-host branch tail goes through the shown filter", () => {
  const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
  expect(source).toContain("return voiceRowsShown(database(), threadId, rows.reverse());");
});
