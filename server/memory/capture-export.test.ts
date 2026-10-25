// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// PASTE-CAPTURE-FIX section 8, C1 to C4: what memory keeps of a chat message
// with a number in it, and of an export from another assistant pasted into
// chat. Written through the message store's own append (message-db.ts), the
// path every chat line takes, so the capture and the chat's mark are the ones
// the app writes.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import * as messages from "../message-db.ts";
import type { Message } from "../store.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import type { MemorySearchBridge } from "./search.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] };
const keywordOnly: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0, degradedReason: "keyword-only" }) };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); });

function access() {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(), generation = registry.begin("bot", "thread");
  const token = registry.mint({ botId: "bot", threadId: "thread", generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
let at = 1;
function append(id: string, role: "user" | "bot", text: string, parentId: string | null, extra: Partial<Message> = {}): Message {
  const message = { id, role, kind: "text", text, parentId, at: at++, ...(role === "user" ? { origin: "desktop" } : { from: { botId: "bot", name: "Bot" } }), ...extra } as Message;
  messages.appendMessage("thread", message);
  return message;
}
const source = (id: string) => database().prepare("SELECT s.state AS state, v.payload AS payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=?").get(`message:thread:${id}`) as { state: string; payload: string } | undefined;
const payload = (id: string) => JSON.parse(source(id)!.payload) as { text: string; excluded?: string };
const stored = (id: string) => JSON.parse(String(database().prepare("SELECT json FROM messages WHERE thread_id='thread' AND id=?").get(id)!.json)) as Message;
function drain() { for (let work = claimMemoryJob("fixture"); work; work = claimMemoryJob("fixture")) publishMemoryWork(work, "fixture", captureWork(work)); }

const EXPORT = [
  "INSTRUCTIONS", "undated Keep answers short.", "IDENTITY", "2024-03-01 My name is Sam Rivera.", "2024-05-02 I live in Austin.",
  "undated My checking account ending 4471 is at Frost Bank.", "CAREER", "2023 I run a bakery on South Lamar.", "PROJECTS",
  "2025-01-10 Opening a second storefront.", "PREFERENCES", "undated Plain words.", "undated No emoji.",
].join("\n");

it("C1: a message with an account number is kept masked, so is the bot's echo, and a later bundle carries no digit of it", async () => {
  const user = append("u1", "user", "Bank: Frost Bank, deposits go to the account ending 4471", null);
  append("b1", "bot", "Noted, account ending 4471 at Frost Bank.", "u1");
  expect(payload("u1").text).toBe("Bank: Frost Bank, deposits go to the account ending ****");
  expect(payload("b1").text).toBe("Noted, account ending **** at Frost Bank.");
  // an ordinary message carries no mark, and the chat keeps the words as typed
  expect(user.memoryNote).toBeUndefined();
  expect(stored("u1").text).toContain("4471");
  drain();
  const bundle = await buildMemoryBundle("Frost Bank deposits", access(), keywordOnly, { allowance: LineageAllowance.tool() });
  expect(bundle.text).not.toMatch(/4471/);
});

it("C2: an export pasted into chat is left out of memory, so is the reply, and the chat marks the paste", async () => {
  const user = append("u1", "user", EXPORT, null);
  append("b1", "bot", "Thanks Sam, I have your account ending 4471 and the bakery.", "u1");
  expect(source("u1")!.state).toBe("retired");
  expect(payload("u1")).toMatchObject({ text: "", excluded: "export-paste" });
  expect(payload("b1")).toMatchObject({ text: "", excluded: "export-paste-reply" });
  // no capture job is left to cut chunks from either row
  expect(database().prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE status IN ('pending','leased')").get()!.n).toBe(0);
  // the mark is on the stored row and on the message the store sends out; no Murage row follows, so the paste stays the head
  expect(user.memoryNote).toBe("export-paste");
  expect(stored("u1").memoryNote).toBe("export-paste");
  expect(database().prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id='thread'").get()!.n).toBe(2);
  drain();
  const bundle = await buildMemoryBundle("Sam bakery Frost Bank storefront", access(), keywordOnly, { allowance: LineageAllowance.tool() });
  expect(bundle.text).not.toMatch(/4471|bakery|storefront|Rivera/);
});

it("C2: the reply of a turn in several pieces is left out by its prompt, read on the turn's own links", () => {
  append("u1", "user", EXPORT, null);
  append("p1", "bot", "Reading your notes.", "u1", { turnId: "T1" });
  append("p2", "bot", "Saved nothing yet, account ending 4471.", "p1", { turnId: "T1", turnTerminal: true });
  expect(payload("p2")).toMatchObject({ text: "", excluded: "export-paste-reply" });
  // the next ordinary message and its answer are captured as usual
  append("u2", "user", "What should I bake on Friday?", "p2");
  append("b2", "bot", "Sourdough.", "u2");
  expect(payload("u2").excluded).toBeUndefined();
  expect(payload("b2")).toMatchObject({ text: "Sourdough." });
});

it("C2: a mark sent in with a message is never kept", () => {
  const user = append("u1", "user", "Just a short note.", null, { memoryNote: "export-paste" });
  expect(user.memoryNote).toBeUndefined();
  expect(stored("u1").memoryNote).toBeUndefined();
});

it("C3: a 60-line log paste with timestamps is captured as any other message", () => {
  const log = Array.from({ length: 60 }, (_, i) => `2026-10-23 10:15:${String(i % 60).padStart(2, "0")} INFO worker ${i} started`).join("\n");
  const user = append("u1", "user", log, null);
  expect(source("u1")!.state).toBe("active");
  expect(payload("u1").excluded).toBeUndefined();
  expect(payload("u1").text).toContain("worker 59 started");
  expect(user.memoryNote).toBeUndefined();
});

it("C4: with memory off nothing is captured and the paste carries no mark", () => {
  setMemoryMode("off");
  const user = append("u1", "user", EXPORT, null);
  expect(source("u1")).toBeUndefined();
  expect(user.memoryNote).toBeUndefined();
});
