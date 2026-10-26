// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The Flux Memory number hold (PASTE-CAPTURE-FIX r2.2, X2 to X5): written with
// the row that holds the number, in both append paths, whatever the memory
// mode; read when the next turn is built.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { fluxCaptureHeld } from "./flux-capture-hold.ts";
import { fluxMemoryContextForTurn, fluxMemoryDecision } from "./flux-memory-headers.ts";
import { closeMessageDb, insertMessage, updateMessage } from "./message-db.ts";
import { setMemoryMode } from "./memory/repository.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text, at: Date.now(), ...extra });
const owner = { botId: "b", audience: "owner" as const, decidedOwner: true };
const BASE = { killSwitch: false, inject: "on" as const, ownerMemory: "on" as const, spaces: false };
const holdRow = (threadId: string) => database().prepare("SELECT message_id FROM flux_capture_hold WHERE thread_id=?").get(threadId);

beforeEach(() => { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

it("X2: a user row with an account ending holds the thread, and the next owner turn sends capture off", () => {
  insertMessage("thread-a", msg("u1", "Bank: Frost Bank, deposits go to the account ending 4471"));
  expect(holdRow("thread-a")).toEqual({ message_id: "u1" });
  const context = fluxMemoryContextForTurn({ warmIdentity: owner, fluxCaptureHold: fluxCaptureHeld(database(), "thread-a") });
  expect(context.numberHold).toBe(true);
  const decision = fluxMemoryDecision(context, { settings: BASE });
  expect([decision.capture, decision.inject, decision.reason]).toEqual(["off", "on", "number-hold"]);
});

it("X3: a bot reply piece that holds a card holds the thread, through the update path too", () => {
  insertMessage("thread-b", msg("r1", "Checking.", { role: "bot", turnId: "t1" }));
  expect(holdRow("thread-b")).toBeUndefined();
  updateMessage("thread-b", msg("r1", "The card on file is 4111 1111 1111 1111.", { role: "bot", turnId: "t1", turnTerminal: true }));
  expect(holdRow("thread-b")).toEqual({ message_id: "r1" });
});

it("X4: memory off still writes the hold", () => {
  setMemoryMode("off");
  insertMessage("thread-c", msg("u1", "SSN 123-45-6789"));
  expect(holdRow("thread-c")).toEqual({ message_id: "u1" });
});

it("X5: another thread of the same bot has no hold, and a year or a date never sets one", () => {
  insertMessage("thread-d", msg("u1", "account ending 4471"));
  insertMessage("thread-e", msg("u1", "The 2026 budget is due 2026-10-23."));
  expect(fluxCaptureHeld(database(), "thread-e")).toBe(false);
  expect(fluxCaptureHeld(database(), "thread-f")).toBe(false);
  // the turn's own text counts before it is stored as a row
  expect(fluxCaptureHeld(database(), "thread-f", "my card is 4111 1111 1111 1111")).toBe(true);
});
