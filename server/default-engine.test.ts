// THE ENGINE WE SHIP HAS TO BE THE ONE PEOPLE MEET.
//
// Reported from a real first run: the flow asked for a Flux Router key, which
// is the thing that turns Fuigo on, and the person came out the other side
// running on Claude. Two separate causes, and this file pins the first.
//
// The Fuigo preference used to be applied INSIDE the sign-in ranking. Claude
// Code signed in scored 0, Fuigo scored 1 for not answering the question, and
// the ranking cut Fuigo before the preference was ever consulted. So on any
// machine with Claude signed in, which is every developer's machine and a
// great many customers', the engine Murage ships lost by default.
//
// The second cause, that nothing moved the Chief onto Fuigo once the key
// populated its catalogue, is covered in server/setup-api.test.ts.

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
  it("picks the one we ship, even against a signed-in Claude", () => {
    // THE REGRESSION. Fuigo does not answer the signed-in question, so under
    // the old order it ranked below Claude and never reached the preference.
    expect(pickDefaultEngine([CLAUDE_SIGNED_IN, FUIGO]))
      .toEqual({ instanceId: "fuigo", model: "flux/auto" });
    // Order of discovery must not decide it either.
    expect(pickDefaultEngine([FUIGO, CLAUDE_SIGNED_IN]).instanceId).toBe("fuigo");
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
