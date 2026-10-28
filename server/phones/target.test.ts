// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AskRevocations } from "./ask-revocations.ts";
import { phoneTarget } from "./target.ts";

type Bot = { hidden?: boolean };
/** A world: bots by id, and the set of "bot:thread" pairs the direct-thread predicate accepts. */
function world(o: { offered?: boolean; bots?: Record<string, Bot>; direct?: string[]; through?: number } = {}) {
  const revocations = new AskRevocations(new DatabaseSync(":memory:"));
  if (o.through !== undefined) revocations.apply("dev", o.through);
  const bots = o.bots ?? { b1: {}, b2: {} };
  const direct = new Set(o.direct ?? ["b1:main", "b2:other-main"]);
  return { offered: () => o.offered ?? true, revocations, bot: (id: string) => bots[id] ?? null, direct: (botId: string, threadId: string) => direct.has(`${botId}:${threadId}`) };
}
const ask = (threadId: string, botId = "b1", generation = 1) => ({ deviceId: "dev", generation, botId, threadId });

describe("phoneTarget", () => {
  it("a new thread on a live bot is ok", () => {
    expect(phoneTarget(ask("new"), world())).toEqual({ ok: true });
  });
  it("the bot's main thread is ok", () => {
    expect(phoneTarget(ask("main"), world())).toEqual({ ok: true });
  });
  it("a hidden bot is target_gone", () => {
    expect(phoneTarget(ask("new"), world({ bots: { b1: { hidden: true } } }))).toEqual({ ok: false, code: "target_gone" });
  });
  it("a deleted bot is target_gone", () => {
    expect(phoneTarget(ask("new", "gone"), world())).toEqual({ ok: false, code: "target_gone" });
    expect(phoneTarget(ask("main", "gone"), world())).toEqual({ ok: false, code: "target_gone" });
  });
  it("a room thread, a channel project desk task, a shared work task and a thread bound to another human are target_gone (the predicate says no)", () => {
    for (const thread of ["room-thread", "desk-task", "shared-task", "bound-to-other-human"]) {
      expect(phoneTarget(ask(thread), world())).toEqual({ ok: false, code: "target_gone" });
    }
  });
  it("a thread of another bot is target_gone", () => {
    expect(phoneTarget(ask("other-main", "b1"), world())).toEqual({ ok: false, code: "target_gone" });
    expect(phoneTarget(ask("other-main", "b2"), world())).toEqual({ ok: true });
  });
  it("share and ask not offered is target_gone", () => {
    expect(phoneTarget(ask("new"), world({ offered: false }))).toEqual({ ok: false, code: "target_gone" });
  });
  it("a generation at through is revoked, above it is ok", () => {
    expect(phoneTarget(ask("new", "b1", 4), world({ through: 4 }))).toEqual({ ok: false, code: "revoked" });
    expect(phoneTarget(ask("new", "b1", 3), world({ through: 4 }))).toEqual({ ok: false, code: "revoked" });
    expect(phoneTarget(ask("new", "b1", 5), world({ through: 4 }))).toEqual({ ok: true });
  });
  it("revoked wins over every other refusal", () => {
    expect(phoneTarget(ask("main", "gone", 2), world({ through: 2, offered: false }))).toEqual({ ok: false, code: "revoked" });
  });
  it("the module has no await and no async", () => {
    const source = readFileSync(join(import.meta.dirname, "target.ts"), "utf8");
    expect(source.replace(/\/\/.*$/gm, "")).not.toMatch(/\bawait\b|\basync\b/);
  });
});
