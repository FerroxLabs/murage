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

// THE ENGINE ID THAT ENDED UP IN THE CHIEF'S MOUTH.
//
// Reported by the owner: running a local Qwen through llama.cpp, the opening
// line was "You already had OpenAI-compatible (OpenRouter / Groq) on this
// computer." Three things wrong with one sentence. It is an engine id, not a
// product anybody has heard of. It names two cloud vendors at somebody whose
// model is on their own hard disk. And it is the connection type, which is
// Murage's business and not theirs.
//
// Nothing new had to be detected. A local pick is already `host::model`, so
// the model's own name was sitting right there in the field being ignored.
describe("the model already running on this computer", () => {
  const ollama = instance({
    instanceId: "openai-compat",
    // The exact string from drivers/openai-compat.ts that used to be read out.
    displayName: "OpenAI-compatible (OpenRouter / Groq)",
    driverKind: "openaiCompat",
    models: { default: "ollama::qwen3:8b" },
  });

  it("is named by its model and its server, never by the connection", () => {
    const [agent] = setupAgentsReading([ollama]);
    expect(agent.localModel).toEqual({ model: "qwen3:8b", host: "Ollama" });
  });

  it("leaves a cloud connection alone", () => {
    // Same driver, same display name, a plain model id: this really IS a
    // remote OpenAI-style endpoint and calling it local would be the same
    // class of lie in the other direction.
    const remote = instance({
      instanceId: "openai-compat",
      displayName: "OpenAI-compatible (OpenRouter / Groq)",
      driverKind: "openaiCompat",
      models: { default: "meta-llama/llama-4-70b" },
    });
    expect(setupAgentsReading([remote])[0]).not.toHaveProperty("localModel");
  });

  it("says nothing when the host is not one Murage knows", () => {
    // `decodeInjectId` validates the host against the real list, so a model
    // id that merely CONTAINS "::" cannot invent a local server.
    const imposter = instance({ instanceId: "codex", driverKind: "codex", models: { default: "flux::flux-auto" } });
    expect(setupAgentsReading([imposter])[0]).not.toHaveProperty("localModel");
  });
});

// THE ENGINE WE SHIP IS NEVER "SIGNED OUT".
//
// Caught on a real machine, not in a fixture. Fuigo answers
// `authenticated: false` whenever nobody has logged into Flux, and it says
// that while sitting on a working local model:
//
//   fuigo | state=available | auth=False | default=[ollama::qwen:latest]
//
// The first version of the split believed it. The engine that was actually
// doing the thinking dropped out of `agents`, so the agents step stopped
// counting the one thing that worked, and on a machine with nothing else the
// Chief would have offered a sign-in command for it. Wrong twice: Fuigo is a
// client, its missing credential is a key rather than a login, and there is
// already a card that says exactly that.
describe("the engine that came in the box", () => {
  const bundledNoFluxLogin = instance({
    instanceId: "fuigo",
    displayName: "Fuigo",
    driverKind: "fuigoAgent",
    snapshot: { state: "available", authenticated: false },
    models: { default: "ollama::qwen:latest" },
  });

  it("still counts as an agent when it can think", () => {
    expect(setupAgentsReading([bundledNoFluxLogin]).map((agent) => agent.id)).toEqual(["fuigo"]);
  });

  it("is never offered a sign-in, because a key is what it is missing", () => {
    expect(setupSignedOutReading([bundledNoFluxLogin])).toEqual([]);
  });

  // The catalogue check is what still holds it honest. A Fuigo with nothing
  // to think with is not an agent, and this clause must not have quietly
  // bought it a pass.
  it("is still not an agent when it has nothing to think with", () => {
    const brainless = instance({
      instanceId: "fuigo",
      driverKind: "fuigoAgent",
      snapshot: { state: "available", authenticated: false },
      models: { default: "" },
    });
    expect(setupAgentsReading([brainless])).toEqual([]);
    expect(setupSignedOutReading([brainless])).toEqual([]);
  });

  // ...and the exemption is for the engine we ship, not for everybody.
  it("does not excuse an engine the person installed", () => {
    const codex = instance({
      instanceId: "codex",
      displayName: "Codex",
      driverKind: "codex",
      snapshot: { state: "available", authenticated: false },
    });
    expect(setupSignedOutReading([codex]).map((agent) => agent.id)).toEqual(["codex"]);
  });
});
