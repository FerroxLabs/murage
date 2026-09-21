import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SETUP_STEPS,
  type SetupLiveState,
  connectedAppsBlock,
  fluxKeyLooksValid,
  jobAppConnected,
  nextSetupStep,
  nothingToThinkWith,
  setupIsFirstRun,
  setupProgress,
  setupStepBlock,
  setupStepDetail,
  setupStepStatus,
  setupView,
} from "../shared/setup.ts";
import {
  SetupChecklist,
  type SetupBotReading,
  type SetupInstanceReading,
  type SetupMessageReading,
  chiefDecision,
  readWorkspace,
  setupAgentsReading,
  setupSignedOutReading,
  threadAnswered,
} from "./setup.ts";

// The same shape every Flux fixture in this suite uses. Not a credential:
// `sk-flux-` plus filler, chosen so the shape check has something real to
// reject the alternatives against.
const FLUX_KEY = "sk-flux-Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
/** A Flux Router connection as the credential card reports a healthy one. */
const FLUX_SAVED = { configured: true, conflict: false, looksValid: true };
/** The engine Murage ships. It is on every machine, which is why `agents` is
 *  normally done before anybody has typed anything. */
const BUNDLED = { id: "fuigo", name: "Fuigo", installed: false };

const live = (patch: Partial<SetupLiveState> = {}): SetupLiveState => ({
  ownerName: "",
  agents: [BUNDLED],
  // Required, and its absence here was the whole of the type error: spreading
  // a Partial over a base that never mentions the field leaves it possibly
  // undefined. The default is the honest one, since a machine whose engines
  // are all signed in has nothing to offer on this list.
  signedOutAgents: [],
  flux: { configured: false, conflict: false, looksValid: false },
  bundledEngine: { ready: true },
  chiefInstanceId: "",
  chiefAnsweredBy: [],
  chiefRefusal: null,
  chiefUsesFlux: false,
  crewSize: 0,
  connectedApps: 0,
  connectedAppIds: [],
  botReplyExists: false,
  routines: { total: 0, briefId: null, briefRan: false },
  ...patch,
});

let directory: string;
let file: string;
const checklist = () => new SetupChecklist(file);

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "murage-setup-state-"));
  file = join(directory, "setup.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("the setup checklist the server owns", () => {
  it("opens on the five steps in the order the person experiences them", () => {
    const state = checklist().read(live());
    expect(Object.keys(state.steps)).toEqual([...SETUP_STEPS]);
    expect([...SETUP_STEPS]).toEqual(["hello", "detect", "flux", "chat", "flow"]);
    // Nothing is true yet on a machine that found something. The engine in
    // the box no longer ticks a step on its own: `detect` is a report, and
    // nobody has been shown it.
    expect(setupProgress(state)).toEqual({ done: 0, total: 5 });
    expect(nextSetupStep(state)).toBe("hello");
  });

  it("never lets an answer alone mark a step that live state decides", () => {
    const setup = checklist();
    const state = setup.answer("flux", "I have one", live());
    expect(state.steps.flux).toMatchObject({ done: false, note: "I have one" });
  });

  it("does settle the two steps that are events rather than facts", () => {
    // `chat` and `flow` are "they chose a job" and "that job produced a
    // result". Neither is a fact about the machine and there is nothing on
    // disk to re-measure them from, so they are recorded. The honesty they
    // owe is a narrower one: the SERVER writes them, and a re-derivation on
    // the next read must not quietly undo them.
    const setup = checklist();
    let state = setup.answer("chat", "brief", live({ ownerName: "Sean" }));
    expect(state.steps.chat.done).toBe(true);
    state = setup.answer("flow", "three things, one has a time on it", live({ ownerName: "Sean" }));
    expect(state.steps.flow.done).toBe(true);
    // And they survive a reload, which is the whole reason they are recorded
    // rather than held in the renderer.
    expect(new SetupChecklist(file).read(live({ ownerName: "Sean" })).steps.flow.done).toBe(true);
  });

  it("does not let a skip pass for a result on either of them", () => {
    const setup = checklist();
    const state = setup.skip("flow", live({ ownerName: "Sean" }));
    expect(state.steps.flow).toMatchObject({ done: false, skipped: true });
  });

  it("settles hello on a saved profile name, with no answer at all", () => {
    // Half an exception, and only half: a saved name is a LIVE fact read back
    // from config. The recorded answer only covers the person who gave a name
    // and then cleared it.
    const named = checklist().read(live({ ownerName: "Sean" }));
    expect(named.steps.hello.done).toBe(true);
    expect(named.steps.hello.note).toBeUndefined();
    expect(checklist().answer("hello", "Sean", live()).steps.hello.done).toBe(true);
  });

  it("ticks the three derived steps from live state alone", () => {
    const state = checklist().read(live({ ownerName: "Sean", flux: FLUX_SAVED, agents: [] }));
    // hello from the profile name, detect because there is nothing to think
    // with, flux from the saved key. Nobody has chosen a job, so the flow
    // stops on `chat` rather than claiming to be finished.
    expect(state.steps.hello.done).toBe(true);
    expect(state.steps.detect.done).toBe(true);
    expect(state.steps.flux.done).toBe(true);
    expect(nextSetupStep(state)).toBe("chat");
    expect(setupProgress(state)).toEqual({ done: 3, total: 5 });
  });

  it("un-ticks a step the moment the live state behind it goes away", () => {
    const setup = checklist();
    expect(setup.read(live({ flux: FLUX_SAVED })).steps.flux).toMatchObject({ done: true });
    const state = setup.read(live());
    expect(state.steps.flux.done).toBe(false);
    expect(state.steps.flux.at).toBeUndefined();
  });

  it("refuses a saved Flux value that is not shaped like a key", () => {
    for (const saved of ["yes I have one", "flux", "sk-ant-Aaaaaaaaaaaaaaaaaaaa", "xai-Aaaaaaaaaaaaaaaaaaaa"]) {
      expect(fluxKeyLooksValid(saved), saved).toBe(false);
    }
    expect(fluxKeyLooksValid(`  ${FLUX_KEY}  `)).toBe(true);
    expect(checklist().read(live({ flux: { configured: true, conflict: false, looksValid: false } })).steps.flux.done).toBe(false);
  });

  it("does not call Flux done while several saved keys are waiting for a choice", () => {
    const conflicted = live({ flux: { configured: true, conflict: true, looksValid: true } });
    const state = checklist().read(conflicted);
    expect(state.steps.flux.done).toBe(false);
    expect(setupStepStatus("flux", state.steps.flux, conflicted)).toBe("blocked");
    expect(setupStepBlock("flux", state.steps.flux, conflicted)).toMatchObject({ reason: "flux-choice-needed" });
  });

  it("asks a connect row to wait for the key rather than blaming the person", () => {
    // The `apps` step is gone; this is the same hard block, exported for the
    // per-job connect rows to call. It is why `flux` sorts to the front of a
    // job's missing list: a Gmail row without a key is a row that cannot be
    // acted on, and the person finds that out by pressing it.
    expect(connectedAppsBlock(live({ ownerName: "Sean" }))).toMatchObject({ reason: "flux-key-needed" });
    expect(connectedAppsBlock(live({ ownerName: "Sean", flux: FLUX_SAVED }))).toBeUndefined();
  });

  it("records a skip without marking the step done, and keeps moving", () => {
    const setup = checklist();
    const state = setup.skip("flux", live({ ownerName: "Sean" }));
    expect(state.steps.flux).toMatchObject({ done: false, skipped: true });
    // Detection is still owed on this machine, because it found something
    // and nobody has been shown it. Skipping a LATER step does not drag the
    // flow past an earlier one.
    expect(nextSetupStep(state)).toBe("detect");
    expect(setupProgress(state).done).toBe(1);

    const shown = setup.answer("detect", "Fuigo", live({ ownerName: "Sean" }));
    expect(nextSetupStep(shown)).toBe("chat");
  });

  it("clears an earlier skip when the step is answered after all", () => {
    const setup = checklist();
    setup.skip("hello", live());
    const state = setup.answer("hello", "Sean", live());
    expect(state.steps.hello).toMatchObject({ done: true, note: "Sean" });
    expect(state.steps.hello.skipped).toBeUndefined();
  });

  it("re-derives on reopen: an answered step reopens, a step live state still backs comes straight back", () => {
    const setup = checklist();
    setup.answer("hello", "Sean", live());
    setup.answer("flux", "pasted it", live({ flux: FLUX_SAVED }));

    const reopened = setup.reopen("hello", live({ flux: FLUX_SAVED }));
    expect(reopened.steps.hello).toEqual({ done: false });
    expect(nextSetupStep(reopened)).toBe("hello");

    const stillDone = setup.reopen("flux", live({ flux: FLUX_SAVED }));
    expect(stillDone.steps.flux.done).toBe(true);
    expect(stillDone.steps.flux.note).toBeUndefined();
  });

  it("re-reads the recorded answers from disk and re-derives done against today's live state", () => {
    const first = checklist();
    first.answer("hello", "Sean", live());
    first.answer("flux", "pasted it", live({ flux: FLUX_SAVED }));
    first.recordChief("bot-chief");
    first.recordBriefRoutine("routine-brief");

    const reopenedApp = checklist();
    const state = reopenedApp.read(live());
    expect(state.chiefBotId).toBe("bot-chief");
    expect(state.briefRoutineId).toBe("routine-brief");
    expect(state.steps.hello).toMatchObject({ done: true, note: "Sean" });
    expect(state.steps.flux.done).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).steps.flux.done).toBe(false);
  });

  it("starts clean when the saved checklist is damaged, because every step re-derives anyway", () => {
    writeFileSync(file, "{ not json");
    const state = checklist().read(live({ flux: FLUX_SAVED }));
    expect(state.steps.flux.done).toBe(true);
    expect(state.steps.hello.note).toBeUndefined();
  });
});

// THE SKIP PREDICATE, AND IT IS THE HEART OF THIS RELEASE.
//
// A machine with nothing to think with skips `detect` ENTIRELY and the Flux
// screen carries the "your bots need a brain first" framing instead, because
// there is no honest "here is what I found" to write for that machine.
//
// The trap it has to survive: MURAGE SHIPS THE FUIGO BINARY. `fuigo --version`
// answers on a machine with nothing else on it at all, and the instance
// reports `state: "available"`. A predicate over availability therefore calls
// a bare machine "found something", shows it an empty detection card, and
// sends it to the ordinary Flux screen with the wrong framing. That is the
// same trap the c0e4eb13 gate fix closed, arriving through a new door.
//
// So these tests go through `setupAgentsReading`, which is where `runnable()`
// lives, on real instance readings rather than on a hand-written agent list.
describe("a machine with nothing to think with", () => {
  const instance = (over: Partial<SetupInstanceReading> & { instanceId: string }): SetupInstanceReading => ({
    snapshot: { state: "available" },
    models: { default: "a-model" },
    ...over,
  });

  /** The bare machine, exactly as the fleet reports it: the shipped engine,
   *  present and answering, with an EMPTY catalogue. */
  const SHIPPED_BUT_EMPTY = instance({ instanceId: "fuigo", displayName: "Fuigo", driverKind: "fuigoAgent", models: {} });

  const bareMachine = () => live({
    ownerName: "Sean",
    agents: setupAgentsReading([SHIPPED_BUT_EMPTY]),
    signedOutAgents: setupSignedOutReading([SHIPPED_BUT_EMPTY]),
  });

  it("skips detection and lands on flux, although the shipped engine reports itself available", () => {
    // The reading the whole thing turns on: available, and not an agent.
    expect(SHIPPED_BUT_EMPTY.snapshot.state).toBe("available");
    const bare = bareMachine();
    expect(bare.agents, "an engine with an empty catalogue was counted as an agent").toEqual([]);
    expect(bare.signedOutAgents, "the shipped engine was offered a sign-in it does not have").toEqual([]);

    expect(nothingToThinkWith(bare)).toBe(true);
    const state = checklist().read(bare);
    expect(state.steps.detect.done, "detection was not skipped on a machine with nothing to show").toBe(true);
    expect(nextSetupStep(state)).toBe("flux");
    const view = setupView(state, bare);
    expect(view.nothingToThinkWith).toBe(true);
    // Four rows, not five, is what the person is counting.
    expect(view.progress).toEqual({ done: 2, total: 5 });
  });

  it("is not blank when a signed-out engine is sitting there", () => {
    // A machine with a signed-out Claude Code and nothing else is NOT blank.
    // It has something worth telling the person about, and sending them off
    // to buy a key while a subscription sits one command away on their own
    // computer would be wrong twice over.
    const signedOut = instance({ instanceId: "claude", displayName: "Claude Code", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: false } });
    const machine = live({
      ownerName: "Sean",
      agents: setupAgentsReading([SHIPPED_BUT_EMPTY, signedOut]),
      signedOutAgents: setupSignedOutReading([SHIPPED_BUT_EMPTY, signedOut]),
    });
    expect(machine.agents).toEqual([]);
    expect(machine.signedOutAgents.map((agent) => agent.name)).toEqual(["Claude Code"]);
    expect(nothingToThinkWith(machine)).toBe(false);
    const state = checklist().read(machine);
    expect(state.steps.detect.done).toBe(false);
    expect(nextSetupStep(state)).toBe("detect");
  });

  it("is not blank when the shipped engine has something to think with", () => {
    const keyed = instance({ instanceId: "fuigo", displayName: "Fuigo", driverKind: "fuigoAgent", models: { default: "flux/auto" } });
    const machine = live({ ownerName: "Sean", agents: setupAgentsReading([keyed]), signedOutAgents: setupSignedOutReading([keyed]) });
    expect(nothingToThinkWith(machine)).toBe(false);
    expect(setupView(checklist().read(machine), machine).nothingToThinkWith).toBe(false);
  });

  it("says the chief has nothing to think with, and stops saying it once a key arrives", () => {
    const bare = bareMachine();
    const state = checklist().read(bare);
    expect(setupStepBlock("chat", state.steps.chat, bare)).toMatchObject({ reason: "engine-needs-model" });
    const keyed = live({ ...bare, flux: FLUX_SAVED });
    expect(setupStepBlock("chat", checklist().read(keyed).steps.chat, keyed)).toBeUndefined();
  });

  it("still says so plainly when the engine in the box cannot run here at all", () => {
    const stranded = live({ ownerName: "Sean", agents: [], signedOutAgents: [{ id: "codex", name: "Codex", installed: true }], bundledEngine: { ready: false, reason: "fuigo is unavailable" } });
    const state = checklist().read(stranded);
    expect(setupStepBlock("detect", state.steps.detect, stranded)?.message).toContain("fuigo is unavailable");
  });
});

describe("which of the first run's apps are connected", () => {
  it("answers per app, not as a count, because a job names the one it is missing", () => {
    const partly = live({ ownerName: "Sean", flux: FLUX_SAVED, connectedApps: 1, connectedAppIds: ["gmail"] });
    expect(jobAppConnected(partly, "gmail")).toBe(true);
    expect(jobAppConnected(partly, "googlecalendar")).toBe(false);
    expect(setupView(checklist().read(partly), partly).connectedJobApps).toEqual(["gmail"]);
  });

  it("reports the whole first-run set when both are connected, and ignores everything else", () => {
    const both = live({ ownerName: "Sean", flux: FLUX_SAVED, connectedApps: 4, connectedAppIds: ["gmail", "googlecalendar", "slack", "notion"] });
    // Slack and Notion are connected and are deliberately NOT offered during
    // the first run: fewer doors out of the flow. They are simply not part of
    // what this view answers.
    expect(setupView(checklist().read(both), both).connectedJobApps).toEqual(["gmail", "googlecalendar"]);
  });

  it("never claims a connection it could not read", () => {
    const unknown = live({ ownerName: "Sean", flux: FLUX_SAVED, connectedApps: null, connectedAppIds: null });
    expect(jobAppConnected(unknown, "gmail")).toBe(false);
    expect(setupView(checklist().read(unknown), unknown).connectedJobApps).toBeNull();
    expect(connectedAppsBlock(unknown)).toMatchObject({ reason: "apps-unreadable" });
  });
});

describe("whether this install has ever been set up", () => {
  it("says yes to a machine that has done nothing at all", () => {
    const fresh = checklist().read(live());
    expect(setupIsFirstRun(fresh, live())).toBe(true);
    expect(setupView(fresh, live()).firstRun).toBe(true);
  });

  it("says no to a restored workspace, which is the bug that matters most", () => {
    // A restored backup trips every one of these at once: answered turns, a
    // saved key, connected apps, routines and a crew. Interrupting it with a
    // welcome screen is the worst thing this flow could do.
    const restored = live({
      ownerName: "Sean",
      flux: FLUX_SAVED,
      connectedApps: 6,
      crewSize: 4,
      botReplyExists: true,
      routines: { total: 5, briefId: null, briefRan: false },
    });
    const state = checklist().read(restored);
    expect(setupIsFirstRun(state, restored)).toBe(false);
    expect(setupView(state, restored).firstRun).toBe(false);
  });

  it("says no on any ONE trace of a workspace that has been used", () => {
    const traces: Array<[string, Partial<SetupLiveState>]> = [
      ["a name on the profile", { ownerName: "Sean" }],
      ["a reply an engine actually produced", { botReplyExists: true }],
      ["a saved key", { flux: FLUX_SAVED }],
      ["a connected account", { connectedApps: 1 }],
      ["a routine", { routines: { total: 1, briefId: null, briefRan: false } }],
      ["a crew", { crewSize: 1 }],
    ];
    for (const [why, patch] of traces) {
      const used = live(patch);
      expect(setupIsFirstRun(checklist().read(used), used), why).toBe(false);
    }
  });

  it("is not fooled by a step that settles itself before anybody has typed", () => {
    // `detect` is done on a machine with nothing to think with, before a word
    // has been typed, because there is nothing to show. Counting done steps
    // would call that install "already set up".
    const bare = live({ agents: [], signedOutAgents: [] });
    const state = checklist().read(bare);
    expect(state.steps.detect.done).toBe(true);
    expect(setupIsFirstRun(state, bare)).toBe(true);
  });

  it("says no once the person has passed a step over or answered one", () => {
    const setup = checklist();
    expect(setupIsFirstRun(setup.skip("flux", live()), live())).toBe(false);
    expect(setupIsFirstRun(checklist().answer("hello", "Sean", live()), live())).toBe(false);
  });
});

describe("a key that authenticates but cannot spend", () => {
  // A monthly spend ceiling is a plain 402, and `classifyProviderError`
  // deliberately withholds the `flux-router` tag from a plain 402 — so the
  // attribution has to come from the engine the turn went to.
  const spendCeiling = {
    flux: FLUX_SAVED,
    chiefInstanceId: "fuigo",
    chiefUsesFlux: true,
    chiefRefusal: { httpStatus: 402 },
  } satisfies Partial<SetupLiveState>;

  it("does not call the Flux step done just because the key is real", () => {
    const state = checklist().read(live(spendCeiling));
    expect(state.steps.flux.done).toBe(false);
    expect(setupStepStatus("flux", state.steps.flux, live(spendCeiling))).toBe("blocked");
  });

  it("keeps the key, and says the account's spending is the problem, not the key", () => {
    const state = checklist().answer("flux", "pasted it", live(spendCeiling));
    const block = setupStepBlock("flux", state.steps.flux, live(spendCeiling));
    expect(block?.reason).toBe("payment-required");
    expect(block?.message).toMatch(/nothing to paste again/);
    expect(state.steps.flux.note).toBe("pasted it");
    // "blocked" is its own outcome: not wrong, not missing, not skipped.
    expect(setupStepDetail("flux", state.steps.flux, live(spendCeiling))).toBeUndefined();
  });

  it("blocks the chat and the job on the same refusal, whoever the provider was", () => {
    const ownSubscription = live({ flux: FLUX_SAVED, chiefInstanceId: "claude", chiefRefusal: { httpStatus: 402 } });
    const state = checklist().read(ownSubscription);
    expect(setupStepStatus("chat", state.steps.chat, ownSubscription)).toBe("blocked");
    expect(setupStepBlock("chat", state.steps.chat, ownSubscription)?.message).toMatch(/refused on payment/);
    expect(setupStepStatus("flow", state.steps.flow, ownSubscription)).toBe("blocked");
    // The Chief is not on Flux, so this says nothing about the Flux key and
    // that step is left alone rather than blamed for somebody else's bill.
    expect(state.steps.flux.done).toBe(true);
  });

  it("still blames Flux when the error itself names it, even off a Flux model", () => {
    const tagged = live({ flux: FLUX_SAVED, chiefInstanceId: "claude", chiefRefusal: { httpStatus: 402, provider: "flux-router" } });
    const state = checklist().read(tagged);
    expect(state.steps.flux.done).toBe(false);
    expect(setupStepBlock("flux", state.steps.flux, tagged)?.reason).toBe("payment-required");
  });

  it("does not block on a rejection that is not about payment", () => {
    const rateLimited = live({ flux: FLUX_SAVED, chiefInstanceId: "fuigo", chiefRefusal: { httpStatus: 429, provider: "flux-router" } });
    const state = checklist().read(rateLimited);
    expect(state.steps.flux.done).toBe(true);
    expect(setupStepStatus("chat", state.steps.chat, rateLimited)).toBe("open");
  });

  it("lists every blocked step on the view, separately from what is merely outstanding", () => {
    const blocked = live({ ...spendCeiling, connectedApps: null, connectedAppIds: null });
    const view = setupView(checklist().read(blocked), blocked);
    expect(view.blocked.sort()).toEqual(["chat", "flow", "flux"]);
    expect(view.steps.find((entry) => entry.id === "hello")?.status).toBe("open");
  });

  it("treats an unreadable connector store as unknown rather than as nothing connected", () => {
    const unknown = live({ connectedApps: null, connectedAppIds: null });
    const state = checklist().read(unknown);
    expect(setupStepBlock("flow", state.steps.flow, unknown)).toMatchObject({ reason: "apps-unreadable" });
    // And a store that reads fine but has nothing in it is NOT the same
    // thing: nothing connected is an answer, not a failure to read.
    const empty = live({ connectedApps: 0, connectedAppIds: [] });
    expect(setupStepBlock("flow", checklist().read(empty).steps.flow, empty)).toBeUndefined();
  });

  it("lets the person's own decision to skip outrank a blockage", () => {
    const unknown = live({ connectedApps: null, connectedAppIds: null });
    const state = checklist().skip("flow", unknown);
    expect(setupStepStatus("flow", state.steps.flow, unknown)).toBe("skipped");
  });
});

describe("what this machine can already run", () => {
  // An engine with something to think with, which is the ordinary case. The
  // empty-catalogue case has its own describe block at the end of this file,
  // because it is the bare machine and it is the one we are selling to.
  const instance = (patch: Partial<SetupInstanceReading> & { instanceId: string }): SetupInstanceReading => ({
    snapshot: { state: "available" },
    models: { default: "a-model" },
    ...patch,
  });

  it("reports only engines that are available and switched on", () => {
    const reading = setupAgentsReading([
      instance({ instanceId: "fuigo", displayName: "Fuigo", driverKind: "fuigoAgent" }),
      instance({ instanceId: "claude", displayName: "Claude Code", driverKind: "claudeAgent" }),
      instance({ instanceId: "off", displayName: "Off", driverKind: "claudeAgent", enabled: false }),
      instance({ instanceId: "missing", displayName: "Missing", driverKind: "claudeAgent", snapshot: { state: "missing" } }),
    ]);
    expect(reading.map((agent) => agent.id)).toEqual(["fuigo", "claude"]);
  });

  it("never claims the person installed the engine that came in the box", () => {
    const [bundled, found] = setupAgentsReading([
      instance({ instanceId: "fuigo", displayName: "Fuigo", driverKind: "fuigoAgent" }),
      instance({ instanceId: "codex", displayName: "Codex", driverKind: "codexAgent" }),
    ]);
    expect(bundled.installed).toBe(false);
    expect(found).toMatchObject({ name: "Codex", installed: true });
  });

  it("falls back to the instance id when an engine has no display name", () => {
    expect(setupAgentsReading([instance({ instanceId: "codex", displayName: "  " })])[0].name).toBe("codex");
  });
});

describe("what the checklist reads off the workspace", () => {
  const greeting: SetupMessageReading[] = [
    { role: "bot", kind: "text", text: "Hi, I'm Ember.", at: 1 },
    { role: "bot", kind: "options", at: 2 },
    { role: "user", kind: "text", text: "hello", at: 3 },
  ];
  const answered: SetupMessageReading[] = [
    ...greeting,
    { role: "bot", kind: "text", text: "Here you go.", turnTerminal: true, at: 4 },
  ];

  it("does not mistake a newly seeded bot's greeting for an engine reply", () => {
    expect(threadAnswered(greeting)).toBe(false);
    expect(threadAnswered([{ role: "bot", kind: "text", text: "   ", turnTerminal: true }])).toBe(false);
    expect(threadAnswered(answered)).toBe(true);
  });

  // The app's own `isFluxModel`, in miniature: a Flux id carries the prefix.
  const workspace = { bots: [], messagesFor: () => [], routesThroughFlux: (model: string) => model.startsWith("flux-") };

  const bot = (patch: Partial<SetupBotReading> & { id: string }): SetupBotReading => ({
    threadId: `${patch.id}-thread`,
    modelSelection: { instanceId: "", model: "" },
    ...patch,
  });

  it("attributes the Chief's settled reply to the engine that dispatched it", () => {
    const chief = bot({
      id: "chief",
      modelSelection: { instanceId: "fuigo", model: "flux-auto" },
      tasks: [{ threadId: "chief-a", lastInstanceId: "fuigo" }, { threadId: "chief-b", lastInstanceId: "claude" }],
    });
    const reading = readWorkspace(
      { ...workspace, bots: [chief], messagesFor: (threadId) => (threadId === "chief-b" ? answered : greeting) },
      "chief",
    );
    expect(reading.chiefInstanceId).toBe("fuigo");
    expect(reading.chiefAnsweredBy).toEqual(["claude"]);
    expect(reading.botReplyExists).toBe(true);
  });

  it("counts visible bots beyond the Chief, and ignores hidden ones", () => {
    const reading = readWorkspace(
      {
        ...workspace,
        bots: [bot({ id: "chief" }), bot({ id: "mate" }), bot({ id: "ghost", hidden: true })],
        messagesFor: () => greeting,
      },
      "chief",
    );
    expect(reading.crewSize).toBe(1);
    expect(reading.botReplyExists).toBe(false);
  });

  it("reports the Chief's payment refusal, with only the structured provider facts", () => {
    const refused: SetupMessageReading[] = [
      ...greeting,
      { role: "bot", kind: "activity", at: 5, tool: { providerError: { httpStatus: 402, provider: "flux-router" } } },
    ];
    const reading = readWorkspace(
      { ...workspace, bots: [bot({ id: "chief", modelSelection: { instanceId: "fuigo", model: "flux-auto" } })], messagesFor: () => refused },
      "chief",
    );
    expect(reading.chiefRefusal).toEqual({ httpStatus: 402, provider: "flux-router" });
    // The attribution the plain-402 case depends on: the Chief's own model
    // is a Flux one, so its bill is Flux's.
    expect(reading.chiefUsesFlux).toBe(true);
  });

  it("does not claim a Flux route for a Chief on its own subscription", () => {
    const reading = readWorkspace(
      { ...workspace, bots: [bot({ id: "chief", modelSelection: { instanceId: "claude", model: "claude-opus-5" } })], messagesFor: () => greeting },
      "chief",
    );
    expect(reading.chiefUsesFlux).toBe(false);
  });

  it("drops a refusal the engine has since recovered from, so a step cannot stay blocked for good", () => {
    const recovered: SetupMessageReading[] = [
      { role: "bot", kind: "activity", at: 5, tool: { providerError: { httpStatus: 402, provider: "flux-router" } } },
      { role: "bot", kind: "text", text: "Back in business.", turnTerminal: true, at: 6 },
    ];
    const reading = readWorkspace(
      { ...workspace, bots: [bot({ id: "chief", modelSelection: { instanceId: "fuigo", model: "flux-auto" } })], messagesFor: () => recovered },
      "chief",
    );
    expect(reading.chiefRefusal).toBeNull();
  });
});

describe("who hosts setup", () => {
  const candidate = (id: string, createdAt: number, patch: Record<string, unknown> = {}) =>
    ({ id, createdAt, ...patch }) as Parameters<typeof chiefDecision>[1][number];

  it("elects the first bot a fresh install created", () => {
    expect(chiefDecision(undefined, [candidate("second", 200), candidate("first", 100)]))
      .toEqual({ kind: "elect", botId: "first", section: null });
  });

  it("keeps the Chief already met when a crew is installed later", () => {
    const bots = [candidate("crew-lead", 300, { chiefOfStaff: true }), candidate("chief", 100)];
    expect(chiefDecision("chief", bots)).toEqual({ kind: "keep", botId: "chief" });
  });

  it("adopts a workspace Chief that already exists rather than electing another", () => {
    const bots = [candidate("elected", 300, { chiefOfStaff: true, chiefScope: "workspace" }), candidate("older", 100)];
    expect(chiefDecision(undefined, bots)).toEqual({ kind: "adopt", botId: "elected" });
  });

  it("does not rewire an upgraded workspace that already has team leaders", () => {
    const bots = [candidate("lead", 300, { chiefOfStaff: true }), candidate("older", 100)];
    expect(chiefDecision(undefined, bots)).toEqual({ kind: "adopt", botId: "older" });
  });

  it("has nobody to host setup on an empty workspace", () => {
    expect(chiefDecision(undefined, [])).toEqual({ kind: "none" });
    expect(chiefDecision("gone", [candidate("ghost", 100, { hidden: true })])).toEqual({ kind: "none" });
  });
});

describe("the view the panel receives", () => {
  it("drops every detail and block from a step that is done", () => {
    const configured = live({ ownerName: "Sean", flux: FLUX_SAVED });
    const view = setupView(checklist().read(configured), configured);
    expect(view.steps.map((entry) => entry.id)).toEqual([...SETUP_STEPS]);
    const flux = view.steps.find((entry) => entry.id === "flux");
    expect(flux?.status).toBe("done");
    expect(flux?.detail).toBeUndefined();
    expect(flux?.block).toBeUndefined();
    expect(view.progress).toEqual({ done: 2, total: 5 });
    // This machine found something, so detection is still owed.
    expect(view.next).toBe("detect");
  });

  it("reports what the Chief can open with, rather than what it should ask", () => {
    const machine = live({ ownerName: "Sean", agents: [BUNDLED, { id: "claude", name: "Claude Code", installed: true }] });
    const view = setupView(checklist().read(machine), machine);
    expect(view.agents.filter((agent) => agent.installed).map((agent) => agent.name)).toEqual(["Claude Code"]);
    expect(view.engine.ready).toBe(true);
    expect(view.fluxReady).toBe(false);
  });

  it("carries the Chief and the brief's own state to the panel", () => {
    const setup = checklist();
    setup.recordChief("bot-chief");
    const ran = live({ routines: { total: 2, briefId: "routine-brief", briefRan: true } });
    const view = setupView(setup.read(ran), ran);
    expect(view.chiefBotId).toBe("bot-chief");
    expect(view.routines).toEqual({ total: 2, briefId: "routine-brief", briefRan: true });
  });
});

// THE BARE MACHINE, WHICH IS THE ONE WE ARE SELLING TO.
//
// Murage ships Fuigo's binary, so on a machine with nothing else on it the
// CLI answers --version and reports itself available. That is NOT the same as
// being able to think: Fuigo is a client, and with no key, no login and no
// local runtime to reach, its catalogue merges down to nothing.
//
// Reading availability alone said "you have an engine" about a person who had
// no brain at all, ticked the step, and let the card tell them the one in the
// box was "already running. It is what is talking to you now." Nothing was
// talking to them. `pickDefaultEngine` has always required a non-empty
// catalogue for exactly this reason; this reading has to agree with it.
describe("what counts as an agent this machine can actually use", () => {
  const instance = (over: Partial<SetupInstanceReading> & { instanceId: string }): SetupInstanceReading => ({
    snapshot: { state: "available" },
    models: { default: "a-model" },
    ...over,
  });

  it("does not count an engine that has nothing to think with", () => {
    const hollow = instance({ instanceId: "fuigo", driverKind: "fuigoAgent", models: {} });
    expect(setupAgentsReading([hollow]), "a catalogue-less engine was reported as an agent").toEqual([]);
  });

  it("counts the one in the box once it has something to think with", () => {
    const ready = instance({ instanceId: "fuigo", driverKind: "fuigoAgent", models: { default: "flux/auto" } });
    expect(setupAgentsReading([ready])).toEqual([{ id: "fuigo", name: "fuigo", installed: false }]);
  });

  it("still ignores an engine that is not there and one that is switched off", () => {
    expect(setupAgentsReading([instance({ instanceId: "codex", snapshot: { state: "unavailable" } })])).toEqual([]);
    expect(setupAgentsReading([instance({ instanceId: "codex", enabled: false })])).toEqual([]);
  });
});
