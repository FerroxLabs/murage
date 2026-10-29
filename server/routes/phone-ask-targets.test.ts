// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { Store } from "../store.ts";
import { teamIdFor } from "../team-identities.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { DatabaseSync } from "node:sqlite";
import { targetsAnswerSchema } from "../../shared/phone-ask-contract.ts";
import { AskRevocations } from "../phones/ask-revocations.ts";
import { isDirectOwnerThread } from "../phones/direct-thread.ts";
import { phoneAskTargets } from "./phone-ask.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const CALLER = { deviceId: "dev-1", generation: 3 };
const SECRET = "the-seeded-message-text-7731";

function world(over: { offered?: boolean } = {}) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const db = database();
  const revocations = new AskRevocations(new DatabaseSync(":memory:"));
  const deps = {
    offered: () => over.offered ?? true, revocations,
    bots: () => store.bots, bot: (id: string) => store.bot(id) ?? null,
    direct: (botId: string, threadId: string) => isDirectOwnerThread(store, db, botId, threadId),
    lastActivityAt: (threadId: string) => store.lastActivityAt(threadId),
    workspace: () => "Studio",
  };
  return { store, revocations, deps };
}

describe("phoneAskTargets (S34)", () => {
  it("lists visible bots with their main thread and no avatar as null", () => {
    const w = world();
    const iris = w.store.createBot();
    const out = phoneAskTargets(CALLER, w.deps);
    expect(out.status).toBe(200);
    const body = targetsAnswerSchema.parse(out.body);
    expect(body.workspace).toBe("Studio");
    expect(body.bots).toEqual([{ id: iris.id, name: iris.name, avatar: null, mainThreadId: iris.threadId }]);
  });

  it("never lists a hidden bot, and a hidden bot's tasks are not recent", () => {
    const w = world();
    const iris = w.store.createBot(), carl = w.store.createBot();
    w.store.createTask(carl.id, "Carl task", false);
    w.store.bot(carl.id)!.sidebarHidden = true;
    const body = targetsAnswerSchema.parse(phoneAskTargets(CALLER, w.deps).body);
    expect(body.bots.map((b) => b.id)).toEqual([iris.id]);
    expect(body.recent.every((r) => r.botId === iris.id)).toBe(true);
  });

  it("never lists a room, a shared work task or a channel desk task", () => {
    const w = world();
    const iris = w.store.createBot(), carl = w.store.createBot();
    const room = w.store.createGroup("room", [iris.id, carl.id], false, "");
    const work = w.store.createSharedWorkTask(iris.id, teamIdFor("Sales"))!;
    const desk = w.store.createTask(iris.id, "Desk", false, { groupId: "some-room" })!;
    const plain = w.store.createTask(iris.id, "Plain chat", false)!;
    const body = targetsAnswerSchema.parse(phoneAskTargets(CALLER, w.deps).body);
    const threads = body.recent.map((r) => r.threadId);
    expect(threads).toContain(plain.threadId);
    for (const gone of [room.threadId, work.threadId, desk.threadId]) expect(threads).not.toContain(gone);
    expect(body.bots.map((b) => b.id)).not.toContain(room.id);
  });

  it("recent is at most 8, newest activity first, with the task title", () => {
    const w = world();
    const iris = w.store.createBot();
    const made = Array.from({ length: 11 }, (_, i) => w.store.createTask(iris.id, `Task ${i}`, false)!);
    w.store.appendMessage(made[2]!.threadId, { role: "bot", kind: "text", text: "x" } as never);
    const body = targetsAnswerSchema.parse(phoneAskTargets(CALLER, w.deps).body);
    expect(body.recent.length).toBe(8);
    expect(body.recent[0]!.threadId).toBe(made[2]!.threadId);
    expect(body.recent[0]!.title).toBe("Task 2");
    const ats = body.recent.map((r) => r.at);
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
  });

  it("carries no message text, previews or counts", () => {
    const w = world();
    const iris = w.store.createBot();
    w.store.appendMessage(iris.threadId, { role: "bot", kind: "text", text: SECRET } as never);
    const raw = JSON.stringify(phoneAskTargets(CALLER, w.deps).body);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toMatch(/"text"|"preview"|"count"|"unread"/);
  });

  it("is 404 when the ask family is not offered, 403 with no ask caller, 403 revoked for a revoked generation", () => {
    const off = world({ offered: false });
    expect(phoneAskTargets(CALLER, off.deps).status).toBe(404);
    const w = world();
    expect(phoneAskTargets(null, w.deps).status).toBe(403);
    w.revocations.apply("dev-1", 3);
    expect(phoneAskTargets(CALLER, w.deps)).toEqual({ status: 403, body: { error: "revoked", code: "revoked" } });
    expect(phoneAskTargets({ deviceId: "dev-1", generation: 4 }, w.deps).status).toBe(200);
  });
});
