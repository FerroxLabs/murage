// SPDX-License-Identifier: AGPL-3.0-or-later
// Design CLOUD-SIGNIN-UNKNOWN (d): an unknown sign-in read never moves a bot, in the re-pick or the Chief's setup move. These drive
// the real passes from engine-repick.ts with a fake store, registry and launcher read, and the real default pick.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineReading } from "../default-engine.ts";
import { moveChiefToShippedEngine, repickAutoPickedBotsOnce, type RepickBot, type RepickDeps } from "./engine-repick.ts";
import type { BotSignInSource } from "./engine-signins.ts";

type Read = "in" | "out" | "unknown" | "throw";
const described: EngineReading[] = [
  { instanceId: "fuigo", driverKind: "fuigoAgent", snapshot: { state: "available", authenticated: true }, models: { default: "flux-auto", options: [{ id: "flux-auto" }] } },
  { instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true }, models: { default: "sonnet", options: [{ id: "sonnet" }] } },
  // The driver's own answer on a home is "not signed in" (it cannot see the launcher's stores): it must not survive an unanswered read.
  { instanceId: "codex", driverKind: "codex", snapshot: { state: "available", authenticated: false }, models: { default: "gpt", options: [{ id: "gpt" }] } },
];
const kinds: Record<string, string> = { fuigo: "fuigoAgent", claude: "claudeAgent", codex: "codex" };

function world(reads: Record<string, Read>) {
  const bots: RepickBot[] = [{ id: "ember", name: "Ember", engineAutoPicked: true, modelSelection: { instanceId: "codex", model: "gpt" } }];
  const patches: Array<{ id: string; patch: unknown }> = [];
  const source: Pick<BotSignInSource, "signIn"> = {
    signIn: async (kind) => {
      const read = reads[kind] ?? "out";
      if (read === "throw") throw new Error("launcher down");
      return read === "unknown" ? undefined : { signedIn: read === "in", source: read === "in" ? "home" : null };
    },
  };
  const deps: RepickDeps = {
    store: {
      bot: (id) => bots.find(bot => bot.id === id) ?? null,
      get bots() { return bots; },
      patchBot: (id, patch) => { patches.push({ id, patch }); const bot = bots.find(b => b.id === id)!; Object.assign(bot, patch); return bot; },
    },
    registry: { get: (instanceId) => (kinds[instanceId] ? { driverKind: kinds[instanceId] } : undefined) },
    described: async () => described,
    source,
    sleep: async () => {},
  };
  return { bots, patches, deps, reads };
}
const chiefView = { fluxReady: true, chiefBotId: "ember", conversationLive: () => false };

describe("an unknown sign-in read never moves a bot onto Fuigo (d)", () => {
  beforeEach(() => { process.env.MURAGE_CLOUD_ROLE = "home"; });
  afterEach(() => { delete process.env.MURAGE_CLOUD_ROLE; });

  it("re-pick: Ember auto-picked on signed-out Codex, the Claude read throws: no move; the next pass with Claude signed out moves it", async () => {
    const w = world({ codex: "out", claudeAgent: "throw" });
    await repickAutoPickedBotsOnce(w.deps, [0]);
    expect(w.patches).toEqual([]);
    expect(w.bots[0]!.modelSelection).toEqual({ instanceId: "codex", model: "gpt" });
    w.reads.claudeAgent = "out";
    await repickAutoPickedBotsOnce(w.deps, [0]);
    expect(w.patches).toEqual([{ id: "ember", patch: { modelSelection: { instanceId: "fuigo", model: "flux-auto" }, engineAutoPicked: true } }]);
  });

  it("re-pick: an unanswered (undefined) Claude read skips too, over every delay of the pass", async () => {
    const w = world({ codex: "out", claudeAgent: "unknown" });
    await repickAutoPickedBotsOnce(w.deps, [0, 2000, 6000]);
    expect(w.patches).toEqual([]);
  });

  it("Chief move: the same reads leave the Chief's selection as it was; the next setup read with Claude signed out moves it", async () => {
    const w = world({ codex: "out", claudeAgent: "throw" });
    await moveChiefToShippedEngine(chiefView, w.deps);
    expect(w.patches).toEqual([]);
    expect(w.bots[0]!.modelSelection).toEqual({ instanceId: "codex", model: "gpt" });
    w.reads.claudeAgent = "unknown";
    await moveChiefToShippedEngine(chiefView, w.deps);
    expect(w.patches).toEqual([]);
    w.reads.claudeAgent = "out";
    await moveChiefToShippedEngine(chiefView, w.deps);
    expect(w.patches).toEqual([{ id: "ember", patch: { modelSelection: { instanceId: "fuigo", model: "flux-auto" } } }]);
  });

  it("no regression: a definite signed-out read on every engine still moves, in both passes", async () => {
    const a = world({ codex: "out", claudeAgent: "out" });
    await repickAutoPickedBotsOnce(a.deps, [0]);
    expect(a.bots[0]!.modelSelection.instanceId).toBe("fuigo");
    const b = world({ codex: "out", claudeAgent: "out" });
    await moveChiefToShippedEngine(chiefView, b.deps);
    expect(b.bots[0]!.modelSelection.instanceId).toBe("fuigo");
  });

  it("a signed-in Claude read moves the bot nowhere near Fuigo (the pick is Claude, not the meter)", async () => {
    const w = world({ codex: "out", claudeAgent: "in" });
    await repickAutoPickedBotsOnce(w.deps, [0]);
    await moveChiefToShippedEngine(chiefView, w.deps);
    expect(w.patches).toEqual([]);
  });

  it("an owner's pick (the mark clear) is never moved, whatever the reads", async () => {
    const w = world({ codex: "out", claudeAgent: "out" });
    w.bots[0]!.engineAutoPicked = false;
    await repickAutoPickedBotsOnce(w.deps, [0]);
    await moveChiefToShippedEngine(chiefView, w.deps);
    expect(w.patches).toEqual([]);
  });
});
