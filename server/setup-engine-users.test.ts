// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WHICH BOTS RUN ON AN ENGINE NOBODY IS SIGNED IN TO (FUIGO-FIRST-SIGNIN-PLACEMENT, 1.0.14).
//
// Flux Router and Fuigo are front and center. An engine the owner installed
// is reported in Needs you only when a bot or a routine runs on it now, because
// those turns fail. An engine no bot uses is left to Settings.
import { describe, expect, it } from "vitest";

import { setupEngineUsers } from "./setup.ts";

const claude = { id: "claude", name: "Claude Code", installed: true, signInCommand: "claude auth login" };
const codex = { id: "codex", name: "Codex", installed: true };
const bot = (id: string, name: string, instanceId: string, over: Record<string, unknown> = {}) =>
  ({ id, name, threadId: `${id}-thread`, modelSelection: { instanceId, model: "m" }, ...over });

describe("an engine nobody is signed in to, and who runs on it", () => {
  it("names the bots whose own engine it is", () => {
    const [row] = setupEngineUsers([claude], [bot("scout", "Scout", "claude"), bot("ember", "Ember", "fuigo")], []);
    expect(row?.usedBy).toEqual([{ id: "scout", name: "Scout" }]);
  });

  it("names nobody when no bot runs on it", () => {
    const rows = setupEngineUsers([claude, codex], [bot("ember", "Ember", "fuigo")], []);
    expect(rows.map(row => row.usedBy)).toEqual([[], []]);
  });

  it("counts a chat that picked the engine for itself, and says which chat", () => {
    const scout = bot("scout", "Scout", "fuigo", { tasks: [{ threadId: "t2", modelSelection: { instanceId: "codex", model: "m" } }] });
    const [, row] = setupEngineUsers([claude, codex], [scout], []);
    expect(row?.usedBy).toEqual([{ id: "scout", name: "Scout", threadId: "t2" }]);
  });

  it("names the bot and each chat that picked the engine, so a move leaves none behind", () => {
    const scout = bot("scout", "Scout", "claude", { tasks: [{ threadId: "t1" }, { threadId: "t2", modelSelection: { instanceId: "claude", model: "m" } }] });
    expect(setupEngineUsers([claude], [scout], [])[0]?.usedBy).toEqual([{ id: "scout", name: "Scout" }, { id: "scout", name: "Scout", threadId: "t2" }]);
  });

  it("leaves out a hidden bot unless one of its routines is on", () => {
    const hidden = bot("helper", "Helper", "claude", { hidden: true });
    expect(setupEngineUsers([claude], [hidden], [])[0]?.usedBy).toEqual([]);
    expect(setupEngineUsers([claude], [hidden], [{ botId: "helper", enabled: false }])[0]?.usedBy).toEqual([]);
    expect(setupEngineUsers([claude], [hidden], [{ botId: "helper", enabled: true }])[0]?.usedBy).toEqual([{ id: "helper", name: "Helper" }]);
    // Its old chats do not count: only its routines run, on its own engine.
    const chats = bot("helper", "Helper", "fuigo", { hidden: true, tasks: [{ threadId: "old", modelSelection: { instanceId: "codex", model: "m" } }] });
    expect(setupEngineUsers([codex], [chats], [{ botId: "helper", enabled: true }])[0]?.usedBy).toEqual([]);
  });

  it("keeps the rest of the reading as it was", () => {
    const [row] = setupEngineUsers([claude], [bot("scout", "Scout", "claude")], []);
    expect(row).toMatchObject(claude);
  });
});
