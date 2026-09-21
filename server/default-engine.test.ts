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

import { describe, expect, it } from "vitest";

import { pickDefaultEngine, type EngineReading } from "./default-engine.ts";

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
