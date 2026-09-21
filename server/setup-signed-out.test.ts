// AN ENGINE NOBODY IS SIGNED IN TO IS NOT A CONNECTED ENGINE.
//
// Reported by the owner, and it was three failures wearing one coat.
//
// Every driver ships a STATIC model list that does not depend on whether
// anyone is signed in. So an installed, signed-OUT Claude Code answers
// `--version`, reports itself available, and hands over a full catalogue. It
// satisfied every condition the agents reading used to have, and so:
//
//   1. the Chief said, in writing, "you already had Claude Code on this
//      computer, so I have connected them", which was not true;
//   2. the agents step ticked, because the step counts that list; and
//   3. on a machine with no Flux key, Fuigo's catalogue merges down to
//      nothing, so the signed-out engine was the ONLY candidate the selector
//      had. Worst of one still wins.
//
// The first thing that person ever asked their assistant to do failed, after
// being told in writing that it was ready.
//
// The fix is not to hide it. Somebody who installed Codex knows what Codex
// is, and the distance between them and a working engine is one command. So
// it is reported separately and offered.

import { describe, expect, it } from "vitest";

import { setupAgentsReading, setupSignedOutReading, type SetupInstanceReading } from "./setup.ts";

const instance = (over: Partial<SetupInstanceReading> & { instanceId: string }): SetupInstanceReading => ({
  snapshot: { state: "available" },
  models: { default: "a-model" },
  ...over,
});

/** Installed, ready, catalogue and all, and nobody is signed in. The exact
 *  shape that used to read as a working agent. */
const CLAUDE_SIGNED_OUT = instance({
  instanceId: "claude",
  displayName: "Claude Code",
  driverKind: "claudeAgent",
  snapshot: { state: "available", authenticated: false },
  models: { default: "claude-sonnet-5" },
  install: { signInCommand: "claude auth login" },
});

const FUIGO = instance({
  instanceId: "fuigo",
  displayName: "Fuigo",
  driverKind: "fuigoAgent",
  models: { default: "flux/auto" },
});

describe("the engine that is here and signed out", () => {
  it("is not counted as an agent", () => {
    // THE ONE THAT MADE THE CHIEF LIE. If this list contains it, the card
    // says it was connected and `setupStepDone("agents")` ticks the step,
    // because that step is `live.agents.length >= 1` and nothing more.
    expect(setupAgentsReading([CLAUDE_SIGNED_OUT])).toEqual([]);
  });

  it("is offered instead, by name, with the command that fixes it", () => {
    expect(setupSignedOutReading([CLAUDE_SIGNED_OUT])).toEqual([
      { id: "claude", name: "Claude Code", installed: true, signInCommand: "claude auth login" },
    ]);
  });

  it("keeps the engines that DO work", () => {
    const view = setupAgentsReading([CLAUDE_SIGNED_OUT, FUIGO]);
    expect(view.map((agent) => agent.id)).toEqual(["fuigo"]);
  });

  // THE MISTAKE THIS CODEBASE HAS ALREADY MADE ONCE.
  //
  // `authenticated` is tri-state, and `undefined` is most of the fleet: a
  // driver that does not probe never answers the question. server/default-engine.ts
  // records what happened when that was read as a no. It emptied the engine
  // list on installs where engines work perfectly well, and a delegated
  // teammate ended up with no engine at all and its turn never ran
  // (server/unattended.test.ts caught it, by bisection rather than by guess).
  //
  // So the test is `=== false` and this assertion is what holds it there. A
  // change to `!== true` fails here and nowhere else.
  it("does not touch an engine whose driver never answers the question", () => {
    const quiet = instance({ instanceId: "kimi", displayName: "Kimi", driverKind: "kimiAgent" });
    expect(quiet.snapshot).not.toHaveProperty("authenticated");

    expect(setupAgentsReading([quiet]).map((agent) => agent.id)).toEqual(["kimi"]);
    expect(setupSignedOutReading([quiet])).toEqual([]);
  });

  it("does not touch an engine that says it IS signed in", () => {
    const codex = instance({
      instanceId: "codex",
      displayName: "Codex",
      driverKind: "codex",
      snapshot: { state: "available", authenticated: true },
    });
    expect(setupAgentsReading([codex]).map((agent) => agent.id)).toEqual(["codex"]);
    expect(setupSignedOutReading([codex])).toEqual([]);
  });

  // The two readings are complementary by construction, and this is the
  // assertion that keeps them that way. An engine in BOTH would be claimed
  // and offered in the same breath; an engine in NEITHER, having passed every
  // check that is not about sign-in, would have gone silently missing.
  it("puts every runnable engine in exactly one of the two lists", () => {
    const fleet = [CLAUDE_SIGNED_OUT, FUIGO, instance({ instanceId: "kimi", driverKind: "kimiAgent" })];
    const agents = setupAgentsReading(fleet).map((agent) => agent.id);
    const out = setupSignedOutReading(fleet).map((agent) => agent.id);

    expect(agents.filter((id) => out.includes(id))).toEqual([]);
    expect([...agents, ...out].sort()).toEqual(["claude", "fuigo", "kimi"]);
  });

  // Sign-in is the LAST question asked, never the first. An engine that is
  // disabled, missing or unable to think is not "signed out", it is one of
  // those other things, and offering a sign-in for a CLI that is not on the
  // machine would be a dead button.
  it("says nothing about an engine that fails an earlier check", () => {
    const gone = instance({
      instanceId: "codex",
      driverKind: "codex",
      snapshot: { state: "unavailable", authenticated: false },
    });
    const off = instance({
      instanceId: "grok",
      driverKind: "grok",
      enabled: false,
      snapshot: { state: "available", authenticated: false },
    });
    const brainless = instance({
      instanceId: "fuigo",
      driverKind: "fuigoAgent",
      snapshot: { state: "available", authenticated: false },
      models: { default: "  " },
    });

    for (const engine of [gone, off, brainless]) {
      expect.soft(setupAgentsReading([engine]), engine.instanceId).toEqual([]);
      expect.soft(setupSignedOutReading([engine]), engine.instanceId).toEqual([]);
    }
  });

  it("leaves out a command the driver does not declare", () => {
    const bare = instance({
      instanceId: "cursor",
      displayName: "Cursor",
      driverKind: "cursorAgent",
      snapshot: { state: "available", authenticated: false },
    });
    // Absent, not empty: the card renders on presence, and "" would draw a
    // button with no words on it.
    expect(setupSignedOutReading([bare])[0]).not.toHaveProperty("signInCommand");
  });
});
