// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The draft-only choke point (DRAFT-ONLY-ALLOWLIST-104 section 3): every engine call for a draft-only bot passes through
// decorateDraftOnlyInstance, which refuses the turn before the engine is called on any engine mode that does not qualify,
// whether or not the caller marked the turn, and cuts a qualifying turn down to its one read surface.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderAdapter, ProviderInstance, SendTurnInput } from "../contracts.ts";
import { decorateDraftOnlyInstance, setDraftOnlyResolver } from "./draft-only-adapter.ts";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..");
// DRAFT-ONLY-ALLOWLIST-104 section 6, written out so the test runs its real assertions on a tree without it.
const OWNER_LINE = "This bot writes drafts for you to review and send, and it drafts on Claude or a connected chat model. Choose one of those in this bot's settings and it picks up from here.";
const REFUSED_DRIVERS = ["fuigoAgent", "grokAgent", "grok", "geminiAgent", "kimiAgent", "droidAgent", "cursorAgent", "opencodeGo", "qwenAgent",
  "hermesAgent", "openclawAgent", "clineAgent", "customAcp", "piAgent", "pi", "codex", "antigravityAgent", "antigravity", "boxAgent", "someNewEngine"];
const MOUNTS = {
  composio: { command: "node", args: ["connector"], env: {} },
  agents: { command: "node", args: ["agents"], env: {} },
  memory: { command: "node", args: ["memory"], env: {} },
  phone: { command: "node", args: ["phone"], env: {} },
  computer: { url: "http://box" },
  browser: {},
  dweb: { url: "http://dweb" },
  custom: { mailer: { command: "node", args: ["mailer"], env: {} } },
} as unknown as SendTurnInput["integrations"];

function fakeInstance(driverKind: string) {
  const turns: SendTurnInput[] = [];
  const steers: string[] = [];
  const prewarms: string[] = [];
  const adapter = {
    capabilities: {},
    sendTurn: async (input: SendTurnInput) => { turns.push(input); return { turnId: "t1" }; },
    steer: async (threadId: string) => { steers.push(threadId); return true; },
    prewarm: async (threadId: string) => { prewarms.push(threadId); return true; },
    onEvent: () => () => undefined,
  } as unknown as ProviderAdapter;
  const live = { instanceId: `i-${driverKind}`, driverKind, displayName: driverKind, adapter, dispose: async () => undefined } as unknown as ProviderInstance;
  return { decorated: decorateDraftOnlyInstance(live), turns, steers, prewarms };
}

afterEach(() => setDraftOnlyResolver(() => false));

describe("every draft-only turn passes the one gate", () => {
  it.each(REFUSED_DRIVERS)("a draft-only turn on %s is refused with the owner line before the engine is called", async (driverKind) => {
    const { decorated, turns } = fakeInstance(driverKind);
    await expect(decorated.adapter.sendTurn({ threadId: "t", text: "reply to ticket 812 and send it", draftOnly: true })).rejects.toMatchObject({ message: OWNER_LINE, status: 409, code: "draft_only_engine" });
    expect(turns).toEqual([]);
  });

  // Grok r2/r4: room, phone and mention turns reached the engine without the flag.
  it("a room or phone turn that does not say draft-only is still refused when a draft-only bot is behind it", async () => {
    setDraftOnlyResolver((threadId, botId) => threadId === "room-thread" || botId === "draft-bot");
    for (const turn of [{ threadId: "room-thread", text: "hi" }, { threadId: "phone-thread", text: "hi", warmIdentity: { botId: "draft-bot", audience: "owner" as const } }]) {
      const { decorated, turns } = fakeInstance("hermesAgent");
      await expect(decorated.adapter.sendTurn(turn)).rejects.toMatchObject({ message: OWNER_LINE });
      expect(turns).toEqual([]);
    }
  });

  it("a Claude turn reaches the engine with only the connected-app relay, no folders, the draft-only note, and the mark", async () => {
    setDraftOnlyResolver((threadId) => threadId === "room-thread");
    const { decorated, turns } = fakeInstance("claudeAgent");
    await decorated.adapter.sendTurn({ threadId: "room-thread", text: "draft", cwd: "/work/repo", addDirs: ["/work/other"], integrations: MOUNTS, system: "You are Sorrel." });
    expect(turns).toHaveLength(1);
    expect(turns[0]!.draftOnly).toBe(true);
    expect(Object.keys(turns[0]!.integrations ?? {})).toEqual(["composio"]);
    expect(turns[0]!.cwd).toBeUndefined();
    expect(turns[0]!.addDirs).toBeUndefined();
    expect(turns[0]!.system).toMatch(/^You are Sorrel\.\n\n\[Murage: this bot writes drafts/);
    expect(turns[0]!.system).toContain("I write drafts for you to review and send.");
  });

  it.each(["openai-compat", "minimax"])("a %s turn reaches the engine with no integrations at all", async (driverKind) => {
    const { decorated, turns } = fakeInstance(driverKind);
    await decorated.adapter.sendTurn({ threadId: "t", text: "draft", draftOnly: true, integrations: MOUNTS, cwd: "/work", addDirs: ["/x"] });
    expect(turns[0]!.integrations).toBeUndefined();
    expect(turns[0]!.cwd).toBeUndefined();
    expect(turns[0]!.draftOnly).toBe(true);
  });

  it("refuses Claude on a Cloud home", async () => {
    const before = process.env.MURAGE_CLOUD_ROLE;
    process.env.MURAGE_CLOUD_ROLE = "home";
    try {
      const { decorated, turns } = fakeInstance("claudeAgent");
      await expect(decorated.adapter.sendTurn({ threadId: "t", text: "draft", draftOnly: true })).rejects.toMatchObject({ message: OWNER_LINE });
      expect(turns).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.MURAGE_CLOUD_ROLE; else process.env.MURAGE_CLOUD_ROLE = before;
    }
  });

  it("a steer or a prewarm into a draft-only thread on an engine that does not qualify is not delivered", async () => {
    setDraftOnlyResolver((threadId) => threadId === "draft-thread");
    const { decorated, steers, prewarms } = fakeInstance("codex");
    expect(await decorated.adapter.steer!("draft-thread", "now send it")).toBe(false);
    expect(await decorated.adapter.prewarm!("draft-thread")).toBe(false);
    expect(steers).toEqual([]);
    expect(prewarms).toEqual([]);
    // an ordinary thread is untouched
    expect(await decorated.adapter.steer!("plain-thread", "go on")).toBe(true);
    expect(steers).toEqual(["plain-thread"]);
  });

  it("an ordinary turn passes through exactly as it was sent", async () => {
    const { decorated, turns } = fakeInstance("codex");
    const turn = { threadId: "t", text: "hi", cwd: "/work", integrations: MOUNTS };
    await decorated.adapter.sendTurn(turn);
    expect(turns[0]).toBe(turn);
  });
});

describe("no caller reaches an engine around the gate", () => {
  it("the registry wraps every live instance with the draft-only decorator, outermost", () => {
    const registry = readFileSync(join(SERVER, "harness", "registry.ts"), "utf8");
    expect(registry).toMatch(/const decorated = decorateDraftOnlyInstance\(decorateHoldInstance\(decorateMemoryInstance\(live\), this\.holds\)\);/);
    expect(registry.match(/driver\.create\(/g)).toHaveLength(1);
  });

  // Every place outside the drivers that calls an engine. Each takes its adapter from a registry instance (decorated), or is a
  // wrapper inside the decorator; the one-shot proposeProject is never offered for a draft-only Chief (index.ts proposal route).
  // A new site fails here until it is reviewed and added.
  const REVIEWED: Record<string, number> = {
    "index.ts": 7,
    "project-card-executor.ts": 1,
    "harness/memory-adapter.ts": 1,
    "harness/instance-holds.ts": 1,
  };
  it("every sendTurn, steer, prewarm and one-shot call site outside the drivers is on the reviewed list", () => {
    const sites: Record<string, number> = {};
    const pattern = /(?<!LineageAllowance)\.(?:sendTurn|steer|prewarm|proposeProject)(?:!|\?\.)?\(|\b(?:sendBuiltTurn|steerBuilt|builtEngineInput|fencedTurnInput)\(/g;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const rel = relative(SERVER, path).split("\\").join("/");
        if (statSync(path).isDirectory()) {
          if (rel === "drivers" || rel === "testing" || name === "node_modules") continue;
          walk(path);
        } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.startsWith("._") && rel !== "harness/draft-only-adapter.ts") {
          const count = (readFileSync(path, "utf8").match(pattern) ?? []).length;
          if (count) sites[rel] = count;
        }
      }
    };
    walk(SERVER);
    expect(sites).toEqual(REVIEWED);
  });
});
