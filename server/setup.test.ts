import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SETUP_SOLO_CREW,
  SETUP_STEPS,
  type SetupLiveState,
  fluxKeyLooksValid,
  nextSetupStep,
  setupProgress,
  setupStepBlock,
  setupStepDetail,
  setupStepStatus,
  setupView,
} from "../shared/setup.ts";
import {
  SetupChecklist,
  type SetupBotReading,
  type SetupMessageReading,
  chiefDecision,
  readWorkspace,
  threadAnswered,
} from "./setup.ts";

// The same shape every Flux fixture in this suite uses. Not a credential:
// `sk-flux-` plus filler, chosen so the shape check has something real to
// reject the alternatives against.
const FLUX_KEY = "sk-flux-Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
/** A Flux Router connection as the credential card reports a healthy one. */
const FLUX_SAVED = { configured: true, conflict: false, looksValid: true };

const live = (patch: Partial<SetupLiveState> = {}): SetupLiveState => ({
  flux: { configured: false, conflict: false, looksValid: false },
  bundledEngine: { ready: true },
  chiefInstanceId: "",
  chiefAnsweredBy: [],
  chiefRefusal: null,
  chiefUsesFlux: false,
  crewSize: 0,
  connectedApps: 0,
  botReplyExists: false,
  chiefMemoryWritten: false,
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
  it("opens on the eight steps in their fixed order with nothing done", () => {
    const state = checklist().read(live());
    expect(Object.keys(state.steps)).toEqual([...SETUP_STEPS]);
    expect(SETUP_STEPS[0]).toBe("flux");
    expect(setupProgress(state)).toEqual({ done: 0, total: 8 });
    expect(nextSetupStep(state)).toBe("flux");
  });

  it("never lets an answer alone mark a derived step done", () => {
    const setup = checklist();
    let state = setup.answer("flux", "I have one", live());
    expect(state.steps.flux).toMatchObject({ done: false, note: "I have one" });
    state = setup.answer("brain", "Fuigo via Flux Router", live());
    expect(state.steps.brain.done).toBe(false);
    state = setup.answer("crew", "a researcher and a writer", live());
    expect(state.steps.crew.done).toBe(false);
    state = setup.answer("apps", "Gmail and Calendar", live());
    expect(state.steps.apps.done).toBe(false);
    state = setup.answer("first-task", "draft the launch note", live());
    expect(state.steps["first-task"].done).toBe(false);
    expect(setupProgress(state)).toEqual({ done: 0, total: 8 });
  });

  it("ticks a derived step from live state alone, with no answer at all", () => {
    const state = checklist().read(live({
      flux: FLUX_SAVED,
      chiefInstanceId: "fuigo",
      chiefAnsweredBy: ["fuigo"],
      crewSize: 2,
      connectedApps: 1,
      botReplyExists: true,
    }));
    expect(state.steps.flux).toMatchObject({ done: true });
    expect(state.steps.flux.note).toBeUndefined();
    expect(state.steps.brain.done).toBe(true);
    expect(state.steps.crew.done).toBe(true);
    expect(state.steps.apps.done).toBe(true);
    expect(state.steps["first-task"].done).toBe(true);
    expect(nextSetupStep(state)).toBe("purpose");
  });

  it("un-ticks a step the moment the live state behind it goes away", () => {
    const setup = checklist();
    expect(setup.read(live({ flux: FLUX_SAVED })).steps.flux).toMatchObject({ done: true });
    const state = setup.read(live());
    expect(state.steps.flux.done).toBe(false);
    expect(state.steps.flux.at).toBeUndefined();
  });

  it("refuses a saved Flux value that is not shaped like a key", () => {
    // An environment-supplied key never passed the connection card's gate,
    // so the shape is judged here: a sentence, a stub, or somebody else's
    // key is not a Flux credential.
    for (const saved of ["yes I have one", "flux", "sk-ant-Aaaaaaaaaaaaaaaaaaaa", "xai-Aaaaaaaaaaaaaaaaaaaa"]) {
      expect(fluxKeyLooksValid(saved), saved).toBe(false);
    }
    expect(fluxKeyLooksValid(`  ${FLUX_KEY}  `)).toBe(true);
    // Short fixture keys the rest of this suite uses must still pass.
    expect(fluxKeyLooksValid("sk-flux-FAKE_NEXT")).toBe(true);
    expect(checklist().read(live({ flux: { configured: true, conflict: false, looksValid: false } })).steps.flux.done).toBe(false);
  });

  it("does not call Flux done while several saved keys are waiting for a choice", () => {
    const conflicted = live({ flux: { configured: true, conflict: true, looksValid: true } });
    const state = checklist().read(conflicted);
    expect(state.steps.flux.done).toBe(false);
    expect(setupStepStatus("flux", state.steps.flux, conflicted)).toBe("blocked");
    expect(setupStepBlock("flux", state.steps.flux, conflicted)).toMatchObject({ reason: "flux-choice-needed" });
  });

  it("asks the Chief's OWN engine to have answered, not whichever engine a task used", () => {
    const setup = checklist();
    expect(setup.read(live({ chiefInstanceId: "fuigo", chiefAnsweredBy: ["claude"] })).steps.brain.done).toBe(false);
    expect(setup.read(live({ chiefInstanceId: "", chiefAnsweredBy: ["fuigo"] })).steps.brain.done).toBe(false);
    expect(setup.read(live({ chiefInstanceId: "fuigo", chiefAnsweredBy: ["claude", "fuigo"] })).steps.brain.done).toBe(true);
  });

  it("accepts one teammate or the deliberate solo choice as a crew", () => {
    expect(checklist().read(live({ crewSize: 1 })).steps.crew.done).toBe(true);
    expect(checklist().answer("crew", SETUP_SOLO_CREW, live()).steps.crew.done).toBe(true);
    expect(checklist().answer("crew", "just one, thanks", live()).steps.crew.done).toBe(false);
  });

  it("wraps up only when the confirmation and the Chief's lines are both there", () => {
    // Three separate checklists: they share a data file, and one that had
    // already recorded the confirmation would hide the half being tested.
    const fresh = (name: string) => new SetupChecklist(join(directory, `${name}.json`));
    expect(fresh("note-only").answer("wrap", "confirmed", live()).steps.wrap.done).toBe(false);
    expect(fresh("lines-only").read(live({ chiefMemoryWritten: true })).steps.wrap.done).toBe(false);
    expect(fresh("both").answer("wrap", "confirmed", live({ chiefMemoryWritten: true })).steps.wrap.done).toBe(true);
  });

  it("records a skip without marking the step done, and keeps moving", () => {
    const setup = checklist();
    const state = setup.skip("apps", live());
    expect(state.steps.apps).toMatchObject({ done: false, skipped: true });
    expect(nextSetupStep(state)).toBe("flux");
    expect(setupProgress(setup.skip("voice", live()))).toEqual({ done: 0, total: 8 });
  });

  it("clears an earlier skip when the step is answered after all", () => {
    const setup = checklist();
    setup.skip("purpose", live());
    const state = setup.answer("purpose", "run my inbox", live());
    expect(state.steps.purpose).toMatchObject({ done: true, note: "run my inbox" });
    expect(state.steps.purpose.skipped).toBeUndefined();
  });

  it("re-derives on reopen: an answered step reopens, a step live state still backs comes straight back", () => {
    const setup = checklist();
    setup.answer("purpose", "run my inbox", live());
    setup.answer("flux", "pasted it", live({ flux: FLUX_SAVED }));

    const reopened = setup.reopen("purpose", live({ flux: FLUX_SAVED }));
    expect(reopened.steps.purpose).toEqual({ done: false });
    expect(nextSetupStep(reopened)).toBe("purpose");

    const stillDone = setup.reopen("flux", live({ flux: FLUX_SAVED }));
    expect(stillDone.steps.flux.done).toBe(true);
    expect(stillDone.steps.flux.note).toBeUndefined();
  });

  it("re-reads the recorded answers from disk and re-derives done against today's live state", () => {
    const first = checklist();
    first.answer("purpose", "run my inbox", live());
    first.answer("flux", "pasted it", live({ flux: FLUX_SAVED }));
    first.recordChief("bot-chief");

    const reopenedApp = checklist();
    const state = reopenedApp.read(live());
    expect(state.chiefBotId).toBe("bot-chief");
    expect(state.steps.purpose).toMatchObject({ done: true, note: "run my inbox" });
    expect(state.steps.flux.done).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).steps.flux.done).toBe(false);
  });

  it("starts clean when the saved checklist is damaged, because every step re-derives anyway", () => {
    writeFileSync(file, "{ not json");
    const state = checklist().read(live({ flux: FLUX_SAVED }));
    expect(state.steps.flux.done).toBe(true);
    expect(state.steps.purpose.note).toBeUndefined();
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
    expect(block?.message).toMatch(/nothing to re-paste/);
    expect(state.steps.flux.note).toBe("pasted it");
    // "blocked" is its own outcome: not wrong, not missing, not skipped.
    expect(setupStepDetail("flux", state.steps.flux, live(spendCeiling))).toBeUndefined();
  });

  it("blocks the brain and the first task on the same refusal, whoever the provider was", () => {
    const ownSubscription = live({ flux: FLUX_SAVED, chiefInstanceId: "claude", chiefRefusal: { httpStatus: 402 } });
    const state = checklist().read(ownSubscription);
    expect(setupStepStatus("brain", state.steps.brain, ownSubscription)).toBe("blocked");
    expect(setupStepBlock("brain", state.steps.brain, ownSubscription)?.message).toMatch(/refused on payment/);
    expect(setupStepStatus("first-task", state.steps["first-task"], ownSubscription)).toBe("blocked");
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
    expect(setupStepStatus("brain", state.steps.brain, rateLimited)).toBe("open");
  });

  it("lists every blocked step on the view, separately from what is merely outstanding", () => {
    const blocked = live({ ...spendCeiling, connectedApps: null });
    const view = setupView(checklist().read(blocked), blocked);
    expect(view.blocked.sort()).toEqual(["apps", "brain", "first-task", "flux"]);
    expect(view.progress.done).toBe(0);
    expect(view.steps.find((entry) => entry.id === "crew")?.status).toBe("open");
  });

  it("treats an unreadable connector store as unknown rather than as nothing connected", () => {
    const unknown = live({ connectedApps: null });
    const state = checklist().read(unknown);
    expect(state.steps.apps.done).toBe(false);
    expect(setupStepBlock("apps", state.steps.apps, unknown)).toMatchObject({ reason: "apps-unreadable" });
  });

  it("lets the person's own decision to skip outrank a blockage", () => {
    const unknown = live({ connectedApps: null });
    const state = checklist().skip("apps", unknown);
    expect(setupStepStatus("apps", state.steps.apps, unknown)).toBe("skipped");
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

describe("what the brain step says when the included engine cannot run", () => {
  it("repeats the resolver's reason instead of offering a default that cannot answer", () => {
    const stranded = live({ bundledEngine: { ready: false, reason: "the bundled engine is missing" } });
    const state = checklist().read(stranded);
    const block = setupStepBlock("brain", state.steps.brain, stranded);
    expect(block?.reason).toBe("engine-unavailable");
    expect(block?.message).toContain("the bundled engine is missing");
    expect(setupStepStatus("brain", state.steps.brain, stranded)).toBe("blocked");
  });

  it("asks for a hello instead, when the included engine is fine but has not answered", () => {
    const chosen = live({ chiefInstanceId: "fuigo" });
    const state = checklist().read(chosen);
    expect(setupStepStatus("brain", state.steps.brain, chosen)).toBe("open");
    expect(setupStepDetail("brain", state.steps.brain, chosen)).toMatch(/has not answered yet/);
  });

  it("drops every detail and block from a step that is done", () => {
    const configured = live({ flux: FLUX_SAVED });
    const view = setupView(checklist().read(configured), configured);
    expect(view.steps.map((entry) => entry.id)).toEqual([...SETUP_STEPS]);
    const flux = view.steps.find((entry) => entry.id === "flux");
    expect(flux?.status).toBe("done");
    expect(flux?.detail).toBeUndefined();
    expect(flux?.block).toBeUndefined();
    expect(view.progress).toEqual({ done: 1, total: 8 });
    expect(view.next).toBe("purpose");
  });
});
