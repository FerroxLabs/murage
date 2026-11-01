// WHICH ENGINE A BRAND NEW BOT LANDS ON, AND WHO PAYS FOR IT.
//
// Two rules pull against each other here and both matter.
//
// Fuigo is the engine Murage ships and the one the zero-terminal promise
// rests on. On the machine this product is actually for, nothing else
// installed, it is the only usable engine in the list and it wins.
//
// But "signed in" is the signal that says the person ALREADY PAYS FOR THIS.
// A flat-rate Claude Code subscription costs them nothing more per sentence;
// our router is metered. This ordering was briefly inverted, to put our
// engine above everything, and the result was that a machine with Claude
// signed in moved onto our meter the moment a Flux key landed. That is
// charging somebody twice for the same reply and letting them find out on a
// bill.
//
// So the sign-in ranking comes first and Fuigo wins inside it. Both rules
// hold, because an engine nobody signed into is not a subscription, it is a
// dead end, and it ranks below ours.
//
// Scope: this is the INTERACTIVE assistant. Where SCHEDULED work runs is a
// separate question, because a subscription is flat-rate but rate-limited
// and draining it with background routines would make Murage the thing that
// broke the tool they bought for their day job.

import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { chiefMoveToShippedEngine, pickDefaultEngine, repickSeededChief, type EngineReading } from "./default-engine.ts";

const engine = (over: Partial<EngineReading> & { instanceId: string }): EngineReading => ({
  snapshot: { state: "available" },
  models: { default: "a-model" },
  ...over,
});

const FUIGO = engine({ instanceId: "fuigo", driverKind: "fuigoAgent", models: { default: "flux/auto" } });
const CLAUDE_SIGNED_IN = engine({
  instanceId: "claude",
  driverKind: "claudeAgent",
  snapshot: { state: "available", authenticated: true },
  models: { default: "claude-sonnet-5" },
});

describe("which engine a brand new bot lands on", () => {
  it("does not move somebody off a subscription they already pay for", () => {
    // THE ONE THAT COSTS REAL MONEY IF IT IS WRONG.
    //
    // "Signed in" is the signal that says they already pay for this. A
    // flat-rate Claude Code subscription costs them nothing more per
    // sentence; our router is metered. Preferring ours here charges somebody
    // twice for the same reply and they find out on a bill.
    //
    // This was briefly inverted, to put the engine we ship above everything,
    // and this assertion is the one that would have caught it.
    expect(pickDefaultEngine([CLAUDE_SIGNED_IN, FUIGO]).instanceId).toBe("claude");
    expect(pickDefaultEngine([FUIGO, CLAUDE_SIGNED_IN]).instanceId).toBe("claude");
  });

  it("a Flux-keyed Fuigo (authenticated:true) still does not outrank a signed-in CLI", () => {
    const fuigoKeyed = engine({ instanceId: "fuigo", driverKind: "fuigoAgent", snapshot: { state: "available", authenticated: true }, models: { default: "flux/auto" } });
    expect(pickDefaultEngine([fuigoKeyed, CLAUDE_SIGNED_IN]).instanceId).toBe("claude");
    expect(pickDefaultEngine([CLAUDE_SIGNED_IN, fuigoKeyed]).instanceId).toBe("claude");
    expect(pickDefaultEngine([fuigoKeyed]).instanceId).toBe("fuigo");
  });

  it("picks the one we ship on the machine this product is actually for", () => {
    // Nothing else installed: the only usable engine is ours, which is the
    // common case and the one the zero-terminal promise is about.
    expect(pickDefaultEngine([FUIGO])).toEqual({ instanceId: "fuigo", model: "flux/auto" });

    // ...and an engine sitting there signed OUT is not a subscription, it is
    // a dead end. Ours wins over that.
    const codexSignedOut = engine({
      instanceId: "codex",
      driverKind: "codex",
      snapshot: { state: "available", authenticated: false },
      models: { default: "gpt-5.6" },
    });
    expect(pickDefaultEngine([codexSignedOut, FUIGO]).instanceId).toBe("fuigo");
  });

  it("does not pick it when it cannot actually answer", () => {
    // The catalogue check is what keeps the preference honest. A Fuigo with
    // no key and no login merges its catalogue down to nothing, and handing
    // somebody a bot that looks configured and cannot answer is the failure
    // this whole function exists to avoid.
    const empty = engine({ instanceId: "fuigo", driverKind: "fuigoAgent", models: {} });
    expect(pickDefaultEngine([empty, CLAUDE_SIGNED_IN]).instanceId).toBe("claude");

    // Same when the binary is not on this machine at all.
    const missing = engine({
      instanceId: "fuigo",
      driverKind: "fuigoAgent",
      snapshot: { state: "unavailable" },
      models: { default: "flux/auto" },
    });
    expect(pickDefaultEngine([missing, CLAUDE_SIGNED_IN]).instanceId).toBe("claude");
  });

  it("still prefers a signed-in engine over one that says it is not, among the rest", () => {
    // The sign-in ranking keeps its job everywhere Fuigo is not in play. This
    // is the F2 regression: a new bot used to be handed codex on a machine
    // where codex had never been signed in.
    const codexSignedOut = engine({
      instanceId: "codex",
      driverKind: "codex",
      snapshot: { state: "available", authenticated: false },
      models: { default: "gpt-5.6" },
    });
    expect(pickDefaultEngine([codexSignedOut, CLAUDE_SIGNED_IN]).instanceId).toBe("claude");

    // ...and an engine that does not answer keeps the benefit of the doubt
    // over one that says no.
    const quiet = engine({ instanceId: "kimi", driverKind: "kimiAgent", models: { default: "k3" } });
    expect(pickDefaultEngine([codexSignedOut, quiet]).instanceId).toBe("kimi");
  });

  it("answers nothing rather than something that cannot run", () => {
    // Deliberately no fallback to the first described engine: handing a bot a
    // CLI that is not installed makes it look ready and then fail on send
    // with a raw spawn error.
    expect(pickDefaultEngine([])).toEqual({ instanceId: "", model: "" });
    expect(pickDefaultEngine([engine({ instanceId: "grok", snapshot: { state: "unavailable" } })]))
      .toEqual({ instanceId: "", model: "" });
  });
});

// 1.0.4 SL-K K5 (168): an engine that lists models but names no default still gives a new bot a model.
describe("an engine with models but no default model", () => {
  it("lands a new bot on the first listed model", () => {
    const listed = engine({ instanceId: "local", models: { default: "", options: [{ id: "a" }, { id: "b" }] } });
    expect(pickDefaultEngine([listed])).toEqual({ instanceId: "local", model: "a" });
  });
  it("still skips an engine that lists nothing (Fuigo with no key)", () => {
    const empty = engine({ instanceId: "fuigo", driverKind: "fuigoAgent", models: { default: "", options: [] } });
    expect(pickDefaultEngine([empty])).toEqual({ instanceId: "", model: "" });
  });
  it("keeps the ranking for engines that name a default", () => {
    const listed = engine({ instanceId: "local", models: { default: "", options: [{ id: "a" }] } });
    expect(pickDefaultEngine([listed, CLAUDE_SIGNED_IN]).instanceId).toBe("claude");
    expect(pickDefaultEngine([CLAUDE_SIGNED_IN]).model).toBe("claude-sonnet-5");
  });
});

// A Flux key saved after the first run (skipped step, or added later from
// Settings) must move a Chief that Murage seeded onto unsigned Claude over to
// Fuigo, and must never touch an engine the owner picked.
describe("the seeded Chief follows a key saved later", () => {
  afterEach(() => { closeMessageDb(); removeTempDirSync(DATA_DIR); });

  const CLAUDE_UNSIGNED = engine({
    instanceId: "claude",
    driverKind: "claudeAgent",
    snapshot: { state: "available", authenticated: false },
    models: { default: "claude-sonnet-5" },
  });
  const unsignedClaude = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

  it("marks the bot Murage seeds, and drops the mark when anyone sets its engine", () => {
    const store = new Store(unsignedClaude);
    store.seedIfEmpty();
    const [seeded] = store.bots;
    expect(seeded.engineSeeded).toBe(true);
    store.patchBot(seeded.id, { modelSelection: unsignedClaude() });
    expect(store.bot(seeded.id)!.engineSeeded).toBeUndefined();
  });

  it("moves a seeded Chief from unsigned Claude to Fuigo once the key makes Fuigo pickable", () => {
    const store = new Store(unsignedClaude);
    store.seedIfEmpty();
    const chief = store.bots[0];
    expect(chief.modelSelection.instanceId).toBe("claude");
    const keyless = engine({ instanceId: "fuigo", driverKind: "fuigoAgent", models: { default: "", options: [] } });
    expect(repickSeededChief(chief, [keyless, CLAUDE_UNSIGNED])).toBeNull();
    expect(repickSeededChief(chief, [FUIGO, CLAUDE_UNSIGNED])).toEqual({ instanceId: "fuigo", model: "flux/auto" });
  });

  it("leaves an engine the owner chose alone, even when it is Claude", () => {
    const store = new Store(unsignedClaude);
    store.seedIfEmpty();
    const chief = store.bots[0];
    store.patchBot(chief.id, { modelSelection: unsignedClaude() });
    expect(repickSeededChief(store.bot(chief.id)!, [FUIGO, CLAUDE_UNSIGNED])).toBeNull();
  });

  it("leaves a seeded Chief on a Claude whose sign-in state is unknown", () => {
    const store = new Store(unsignedClaude);
    store.seedIfEmpty();
    const chief = store.bots[0];
    const claudeUnknown = engine({ instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available" }, models: { default: "claude-sonnet-5" } });
    expect(repickSeededChief(chief, [FUIGO, claudeUnknown])).toBeNull();
    expect(repickSeededChief(chief, [FUIGO, CLAUDE_UNSIGNED])).toEqual({ instanceId: "fuigo", model: "flux/auto" });
  });

  it("an owner's chat-header pick on a bot with no engine yet also ends the seeded mark", () => {
    const store = new Store(unsignedClaude);
    store.seedIfEmpty();
    const chief = store.bots[0];
    store.bot(chief.id)!.modelSelection = { instanceId: "", model: "" };
    const thread = chief.threadId!;
    store.patchTask(chief.id, thread, { modelSelection: unsignedClaude() });
    const after = store.bot(chief.id)!;
    expect(after.modelSelection.instanceId).toBe("claude");
    expect(after.engineSeeded).toBeUndefined();
    expect(repickSeededChief(after, [FUIGO, CLAUDE_UNSIGNED])).toBeNull();
  });

  it("moves a seeded Chief with an empty selection once the key makes Fuigo pickable", () => {
    const chief = { engineSeeded: true, modelSelection: { instanceId: "", model: "" } };
    const keyless = engine({ instanceId: "fuigo", driverKind: "fuigoAgent", models: { default: "", options: [] } });
    expect(repickSeededChief(chief, [keyless])).toBeNull();
    expect(repickSeededChief(chief, [FUIGO])).toEqual({ instanceId: "fuigo", model: "flux/auto" });
    expect(repickSeededChief({ ...chief, engineSeeded: false }, [FUIGO])).toBeNull();
  });

  it("keeps a signed-in Claude winning, and does nothing when already on the pick", () => {
    const store = new Store(unsignedClaude);
    store.seedIfEmpty();
    const chief = store.bots[0];
    expect(repickSeededChief(chief, [FUIGO, CLAUDE_SIGNED_IN])).toBeNull();
    expect(repickSeededChief({ ...chief, modelSelection: { instanceId: "fuigo", model: "flux/auto" } }, [FUIGO, CLAUDE_UNSIGNED])).toBeNull();
  });
});

// The guided first run's setup read (moveChiefToShippedEngine in index.ts) uses the same rule as the later key save.
describe("the setup read moves the Chief only off an engine that is not signed in", () => {
  const claude = (authenticated?: boolean) => engine({
    instanceId: "claude", driverKind: "claudeAgent",
    snapshot: authenticated === undefined ? { state: "available" } : { state: "available", authenticated },
    models: { default: "claude-sonnet-5" },
  });
  const onClaude = { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } };
  const TO_FUIGO = { instanceId: "fuigo", model: "flux/auto" };

  it("leaves a Chief on a Claude whose sign-in is unknown", () => {
    expect(chiefMoveToShippedEngine(onClaude, [FUIGO, claude(undefined)])).toBeNull();
  });
  it("moves a Chief off a Claude confirmed signed out", () => {
    expect(chiefMoveToShippedEngine(onClaude, [FUIGO, claude(false)])).toEqual(TO_FUIGO);
  });
  it("moves a Chief with an empty selection", () => {
    expect(chiefMoveToShippedEngine({ modelSelection: { instanceId: "", model: "" } }, [FUIGO, claude(undefined)])).toEqual(TO_FUIGO);
  });
  it("still updates a Chief already on Fuigo with a stale model", () => {
    expect(chiefMoveToShippedEngine({ modelSelection: { instanceId: "fuigo", model: "old-local" } }, [FUIGO, claude(undefined)])).toEqual(TO_FUIGO);
    expect(chiefMoveToShippedEngine({ modelSelection: TO_FUIGO }, [FUIGO])).toBeNull();
  });
});
