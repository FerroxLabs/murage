// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_BOT_LEARNING, ensureLearningLocalDir, learningLocalPath, nextBotLearning, readBotLearning } from "./bot-learning.ts";

describe("bot learning settings", () => {
  it("defaults: learning from the owner on, ask-first off, prospects off, revision 0", () => {
    expect(DEFAULT_BOT_LEARNING).toEqual({ enabled: true, askFirst: false, prospectLearning: false, prospectThreadIds: [], revision: 0 });
    expect(readBotLearning({})).toEqual(DEFAULT_BOT_LEARNING);
    expect(Object.isFrozen(DEFAULT_BOT_LEARNING)).toBe(true);
  });

  it("a damaged record falls back per field instead of blocking the bot", () => {
    expect(readBotLearning({ learning: "yes" })).toEqual(DEFAULT_BOT_LEARNING);
    expect(readBotLearning({ learning: { enabled: "no", askFirst: true, prospectLearning: 1, revision: -3 } })).toEqual({ enabled: true, askFirst: true, prospectLearning: false, prospectThreadIds: [], revision: 0 });
    expect(readBotLearning({ learning: { enabled: false, revision: 4.5 } })).toMatchObject({ enabled: false, revision: 0 });
  });

  it("every effective change bumps the revision by one; a no-op keeps it", () => {
    const first = nextBotLearning(readBotLearning({}), 0, { askFirst: true });
    expect(first).toMatchObject({ ok: true, changed: true, learning: { askFirst: true, enabled: true, revision: 1 } });
    const same = nextBotLearning((first as { learning: ReturnType<typeof readBotLearning> }).learning, 1, { askFirst: true });
    expect(same).toMatchObject({ ok: true, changed: false, learning: { revision: 1 } });
    const both = nextBotLearning(readBotLearning({ learning: { enabled: true, askFirst: true, prospectLearning: false, revision: 1 } }), 1, { enabled: false, prospectLearning: true });
    expect(both).toMatchObject({ ok: true, learning: { enabled: false, prospectLearning: true, revision: 2 } });
  });

  it("toggling learning, ask-first or the prospect switch PRESERVES the chosen chats; the switch defaults off with no chats", () => {
    expect(readBotLearning({}).prospectLearning).toBe(false);
    expect(readBotLearning({}).prospectThreadIds).toEqual([]);
    const scoped = readBotLearning({ learning: { enabled: true, askFirst: false, prospectLearning: true, prospectThreadIds: ["t1", "t2"], revision: 3 } });
    expect(scoped.prospectThreadIds).toEqual(["t1", "t2"]);
    for (const change of [{ enabled: false }, { askFirst: true }, { prospectLearning: false }] as const) {
      const next = nextBotLearning(scoped, 3, change);
      expect(next).toMatchObject({ ok: true, changed: true, learning: { prospectThreadIds: ["t1", "t2"], revision: 4 } });
    }
  });

  it("the prospect scope is written by the switch: de-duplicated, trimmed to real ids, capped; a same scope is a no-op", () => {
    const base = readBotLearning({});
    const set = nextBotLearning(base, 0, { prospectThreadIds: ["a", "b", "a", "", 7 as unknown as string, "x".repeat(201)] });
    expect(set).toMatchObject({ ok: true, changed: true, learning: { prospectThreadIds: ["a", "b"], revision: 1 } });
    const again = nextBotLearning((set as { learning: ReturnType<typeof readBotLearning> }).learning, 1, { prospectThreadIds: ["a", "b"] });
    expect(again).toMatchObject({ ok: true, changed: false, learning: { revision: 1 } });
    const many = nextBotLearning(base, 0, { prospectThreadIds: Array.from({ length: 600 }, (_, i) => `t${i}`) });
    expect((many as { learning: ReturnType<typeof readBotLearning> }).learning.prospectThreadIds).toHaveLength(500);
  });

  it("a damaged scope reads as empty", () => {
    expect(readBotLearning({ learning: { prospectThreadIds: "t1" } }).prospectThreadIds).toEqual([]);
    expect(readBotLearning({ learning: { prospectThreadIds: ["t1", 3, null] } }).prospectThreadIds).toEqual(["t1"]);
  });

  it("a stale revision is refused and changes nothing", () => {
    const current = readBotLearning({ learning: { enabled: true, askFirst: false, prospectLearning: false, revision: 5 } });
    expect(nextBotLearning(current, 4, { enabled: false })).toEqual({ ok: false, reason: "revision-conflict", learning: current });
  });
});

describe("learning-local folder", () => {
  it("is created owner-only under the data folder on first use", () => {
    const root = mkdtempSync(join(tmpdir(), "learning-local-"));
    try {
      const dir = ensureLearningLocalDir(root);
      expect(dir).toBe(join(root, "learning-local"));
      expect(learningLocalPath(root, "a", "b.json")).toBe(join(root, "learning-local", "a", "b.json"));
      if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(ensureLearningLocalDir(root)).toBe(dir); // idempotent
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
