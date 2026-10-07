// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC-P 4 [AMB-8]: rooms made by this release do not follow @mentions in
// bot replies; channels from before it keep the one-hop chain.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("the mentionChain marker", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });

  it("new rooms are created without the chain; pair rooms carry no marker", () => {
    const store = new Store(selection);
    const a = store.createBot({ section: "Ops" }), b = store.createBot({ section: "Ops" });
    expect(store.createGroup("Room", [a.id, b.id]).mentionChain).toBe(false);
    expect(store.createGroup("Pair", [a.id, b.id], true).mentionChain).toBeUndefined();
  });

  it("marks channels from before the release once, and leaves pair rooms and projects alone", () => {
    const store = new Store(selection);
    const a = store.createBot({ section: "Ops" }), b = store.createBot({ section: "Ops" });
    const old = store.createGroup("Old", [a.id, b.id]);
    const project = store.createGroup("Project", [a.id, b.id]);
    store.createGroup("Pair", [a.id, b.id], true);
    // what a pre-upgrade groups.json looks like: no field at all
    const file = join(DATA_DIR, "groups.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    for (const group of raw) delete group.mentionChain;
    raw.find((group) => group.id === project.id)!.channelProject = { goal: "Ship it", status: "active", startedAt: 1, updatedAt: 1 };
    writeFileSync(file, JSON.stringify(raw));
    const reloaded = new Store(selection);
    expect(reloaded.markPreUpgradeMentionChains()).toBe(1);
    expect(reloaded.group(old.id)?.mentionChain).toBe(true);
    expect(reloaded.group(project.id)?.mentionChain).toBeUndefined();
    expect(reloaded.groups.find((group) => group.dm)?.mentionChain).toBeUndefined();
    expect(reloaded.markPreUpgradeMentionChains()).toBe(0);
    expect(new Store(selection).group(old.id)?.mentionChain).toBe(true);
  });
});
