import { describe, expect, it } from "vitest";

import { SETUP_CARD_VARIANTS, setupCardKey } from "../shared/setup-card.ts";
import {
  type SetupLiveState,
  type SetupState,
  type SetupStep,
  deriveSetupState,
  emptySetupState,
  setupView,
} from "../shared/setup.ts";
import { setupCardCopy, setupConversationPlan } from "./setup-conversation.ts";

// Shape only, never a credential: the connection card's own gate is what a
// real key passes, and this fixture only has to be key-shaped.
const FLUX_SAVED = { configured: true, conflict: false, looksValid: true };

/** The engine Murage ships, with something to think with. Present on a bare
 *  machine, and reported as NOT installed by the person, because they did not
 *  put it there. */
const BUNDLED = { id: "fuigo", name: "Fuigo", installed: false };

/** Installed, ready, and nobody signed in. The card must never claim it. */
const CLAUDE_SIGNED_OUT = { id: "claude", name: "Claude Code", installed: true, signInCommand: "claude auth login" };

const live = (patch: Partial<SetupLiveState> = {}): SetupLiveState => ({
  ownerName: "",
  agents: [BUNDLED],
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

/** A recorded checklist, built in memory. No file, no server: this module is
 *  pure and its test is too. */
function state(patch: Partial<Record<SetupStep, { skipped?: boolean; note?: string }>> = {}): SetupState {
  const base = emptySetupState(1_000);
  const steps = { ...base.steps };
  for (const [step, recorded] of Object.entries(patch)) {
    steps[step as SetupStep] = { done: false, ...recorded };
  }
  return { ...base, steps };
}

/** Detection is settled by being SHOWN, so most of these fixtures have to say
 *  it was. One place, so the reason is stated once. */
const DETECTED = { note: "Fuigo" };

// The server hands `setupView` the DERIVED state (`SetupChecklist.read`), so
// the test does the same. A raw checklist would report every step outstanding
// and the flow would never move.
const view = (liveState: SetupLiveState, recorded: SetupState = state()) =>
  setupView(deriveSetupState(recorded, liveState, 2_000), liveState);
const plan = (liveState: SetupLiveState, present: string[] = [], recorded?: SetupState) =>
  setupConversationPlan(view(liveState, recorded), new Set(present));
const keys = (cards: { key: string }[]) => cards.map((card) => card.key);

describe("what the Chief says on a machine with the engine in the box", () => {
  it("opens with the welcome card and nothing else", () => {
    const opening = plan(live());
    expect(keys(opening.append)).toEqual([setupCardKey("hello", "welcome")]);
    expect(opening.settle).toEqual([]);
  });

  it("says the engine came in the box once the greeting is behind us", () => {
    // A machine with nothing of its own on it, but with a working engine in
    // the box: the only thing available is the one Murage ships.
    const answered = plan(live({ ownerName: "Sean" }), [setupCardKey("hello", "welcome")]);
    expect(keys(answered.append)).toEqual([setupCardKey("detect", "bare")]);
    // The card that asked for the name is answered, so it stops being live.
    expect(answered.settle).toEqual([setupCardKey("hello", "welcome")]);
  });

  it("asks for the key once detection has been read", () => {
    const after = plan(
      live({ ownerName: "Sean" }),
      [setupCardKey("hello", "welcome"), setupCardKey("detect", "bare")],
      state({ detect: DETECTED }),
    );
    expect(keys(after.append)).toEqual([setupCardKey("flux", "key")]);
    expect(after.settle).toContain(setupCardKey("detect", "bare"));
  });

  it("leads the key card with the answer, not with the apps", () => {
    const card = plan(
      live({ ownerName: "Sean" }),
      [setupCardKey("hello", "welcome"), setupCardKey("detect", "bare")],
      state({ detect: DETECTED }),
    ).append.find((entry) => entry.variant === "key")!;
    expect(card.subtitle.indexOf("picks for you")).toBeLessThan(card.subtitle.indexOf("500+ apps"));
  });
});

// THE SKIP, IN CARD FORM.
//
// A machine with nothing to think with never sees a detection card, because
// there is no honest one to write, and the Flux card does detection's job of
// saying what was looked for.
describe("what the Chief says on a machine with nothing to think with", () => {
  const blank = live({ ownerName: "Sean", agents: [], signedOutAgents: [] });

  it("shows no detection card at all and goes straight to the key", () => {
    const cards = plan(blank, [setupCardKey("hello", "welcome")]);
    expect(keys(cards.append)).toEqual([setupCardKey("flux", "bare-needs-key")]);
    for (const variant of ["found", "bare", "signed-out"] as const) {
      expect(keys(cards.append), variant).not.toContain(setupCardKey("detect", variant));
    }
  });

  it("uses the brain framing rather than the ordinary offer", () => {
    const card = plan(blank, [setupCardKey("hello", "welcome")]).append[0]!;
    expect(card.variant).toBe("bare-needs-key");
    expect(card.title).toBe("Your bots need a brain first");
    // "you are ready without installing anything" is false on this machine,
    // and it is what the `bare` card says.
    expect(card.subtitle).not.toMatch(/you are ready/i);
  });

  it("goes back to the ordinary offer the moment something can think", () => {
    const card = plan(live({ ownerName: "Sean" }), [setupCardKey("hello", "welcome")], state({ detect: DETECTED }))
      .append.find((entry) => entry.step === "flux")!;
    expect(card.variant).toBe("key");
  });
});

describe("what the Chief says on a machine that already had help on it", () => {
  const installed = live({
    ownerName: "Sean",
    agents: [BUNDLED, { id: "claude", name: "Claude Code", installed: true }],
  });

  it("says it found them rather than claiming it brought them", () => {
    const cards = plan(installed, [setupCardKey("hello", "welcome")]).append;
    expect(keys(cards)).toContain(setupCardKey("detect", "found"));
    expect(keys(cards)).not.toContain(setupCardKey("detect", "bare"));
  });

  it("tells the two machines apart on detection alone", () => {
    const bare = plan(live({ ownerName: "Sean" }), [setupCardKey("hello", "welcome")]);
    expect(keys(bare.append)).toContain(setupCardKey("detect", "bare"));
    expect(keys(bare.append)).not.toContain(setupCardKey("detect", "found"));
  });
});

describe("what the Chief says when an engine is here and nobody is signed in", () => {
  const opened = [setupCardKey("hello", "welcome")];

  it("does not claim it, and does not pretend the machine is empty", () => {
    const cards = plan(
      live({ ownerName: "Sean", agents: [], signedOutAgents: [CLAUDE_SIGNED_OUT] }),
      opened,
    ).append;
    expect(keys(cards)).toContain(setupCardKey("detect", "signed-out"));
    // "found" is the lie this whole card exists to stop.
    expect(keys(cards)).not.toContain(setupCardKey("detect", "found"));
    // ...and the brain card would send somebody to buy a key when what is
    // actually missing is a sign-in they can do for nothing. A signed-out
    // engine is exactly why `nothingToThinkWith` reads both lists.
    expect(keys(cards)).not.toContain(setupCardKey("flux", "bare-needs-key"));
  });

  // THE ECONOMIC ONE, and the reason this variant outranks plain `bare`.
  //
  // A keyed Fuigo IS usable, so nothing here is broken and `bare` would not
  // be a lie. But this person has a subscription sitting one command away on
  // their own computer, and saying nothing quietly leaves them on a metered
  // router while they pay a flat rate elsewhere. That is exactly the mistake
  // 3c9770f1 reverted in `pickDefaultEngine`, arriving through another door.
  it("speaks up even when something in the box already works", () => {
    const cards = plan(
      live({ ownerName: "Sean", agents: [BUNDLED], signedOutAgents: [CLAUDE_SIGNED_OUT] }),
      opened,
    ).append;
    expect(keys(cards)).toContain(setupCardKey("detect", "signed-out"));
    expect(keys(cards)).not.toContain(setupCardKey("detect", "bare"));
  });

  // ...but it stays quiet when something they installed is genuinely working.
  // A second engine nobody signed into is noise, and the first run has no
  // room for noise.
  it("says nothing when an engine they installed is already working", () => {
    const cards = plan(
      live({
        ownerName: "Sean",
        agents: [BUNDLED, { id: "codex", name: "Codex", installed: true }],
        signedOutAgents: [CLAUDE_SIGNED_OUT],
      }),
      opened,
    ).append;
    expect(keys(cards)).toContain(setupCardKey("detect", "found"));
    expect(keys(cards)).not.toContain(setupCardKey("detect", "signed-out"));
  });

  it("settles once the step is satisfied, like every other card that asked", () => {
    const signedIn = plan(
      live({ ownerName: "Sean", agents: [BUNDLED], signedOutAgents: [] }),
      [...opened, setupCardKey("detect", "signed-out")],
      state({ detect: DETECTED }),
    );
    expect(signedIn.settle).toContain(setupCardKey("detect", "signed-out"));
  });
});

describe("the not-now branch on the key", () => {
  const opened = [
    setupCardKey("hello", "welcome"),
    setupCardKey("detect", "bare"),
    setupCardKey("flux", "key"),
  ];

  it("records the decision once and carries straight on to the chat", () => {
    const passedOver = plan(
      live({ ownerName: "Sean" }),
      opened,
      state({ detect: DETECTED, flux: { skipped: true } }),
    );
    expect(keys(passedOver.append)).toEqual([
      setupCardKey("flux", "no-key"),
      setupCardKey("chat", "jobs"),
    ]);
    // Passed over is not done, and the card that asked stops being live either
    // way: the checklist still says plainly that the step is outstanding.
    expect(passedOver.settle).toEqual([
      setupCardKey("hello", "welcome"),
      setupCardKey("detect", "bare"),
      setupCardKey("flux", "key"),
    ]);
  });

  it("does not say it twice", () => {
    const again = plan(
      live({ ownerName: "Sean" }),
      [...opened, setupCardKey("flux", "no-key"), setupCardKey("chat", "jobs")],
      state({ detect: DETECTED, flux: { skipped: true } }),
    );
    expect(again.append).toEqual([]);
  });
});

describe("the two steps that end the flow", () => {
  const opened = [
    setupCardKey("hello", "welcome"),
    setupCardKey("detect", "bare"),
    setupCardKey("flux", "key"),
  ];
  const keyed = live({ ownerName: "Sean", flux: FLUX_SAVED });

  it("asks what to take off their plate once there is something to think with", () => {
    const asked = plan(keyed, opened, state({ detect: DETECTED }));
    expect(keys(asked.append)).toEqual([setupCardKey("chat", "jobs")]);
    expect(asked.settle).toContain(setupCardKey("flux", "key"));
  });

  it("moves to the job once one has been chosen", () => {
    const chosen = plan(
      keyed,
      [...opened, setupCardKey("chat", "jobs")],
      state({ detect: DETECTED, chat: { note: "brief" } }),
    );
    expect(keys(chosen.append)).toEqual([setupCardKey("flow", "do-it")]);
    expect(chosen.settle).toContain(setupCardKey("chat", "jobs"));
  });

  it("says nothing more once the job has produced a result", () => {
    const finished = plan(
      keyed,
      [...opened, setupCardKey("chat", "jobs"), setupCardKey("flow", "do-it")],
      state({ detect: DETECTED, chat: { note: "brief" }, flow: { note: "tomorrow morning" } }),
    );
    // The result card carries "take something else off my plate" itself, so a
    // separate closing card would be a second ending to one scene.
    expect(finished.append).toEqual([]);
    expect(finished.settle).toContain(setupCardKey("flow", "do-it"));
  });
});

describe("called on every read, so it must be idempotent", () => {
  it("returns nothing new when the same state is asked twice", () => {
    const machine = live({ ownerName: "Sean", flux: FLUX_SAVED });
    const present = new Set<string>();
    for (let round = 0; round < 2; round++) {
      for (const card of setupConversationPlan(view(machine), present).append) present.add(card.key);
    }
    const before = [...present];
    expect(setupConversationPlan(view(machine), present).append).toEqual([]);
    expect([...present]).toEqual(before);
  });

  it("walks the whole flow without ever repeating a card", () => {
    const seen: string[] = [];
    const present = new Set<string>();
    const steps: Array<[SetupLiveState, SetupState]> = [
      [live(), state()],
      [live({ ownerName: "Sean" }), state()],
      [live({ ownerName: "Sean" }), state({ detect: DETECTED })],
      [live({ ownerName: "Sean", flux: FLUX_SAVED }), state({ detect: DETECTED })],
      [live({ ownerName: "Sean", flux: FLUX_SAVED }), state({ detect: DETECTED, chat: { note: "brief" } })],
      [
        live({ ownerName: "Sean", flux: FLUX_SAVED, connectedAppIds: ["gmail", "googlecalendar"], connectedApps: 2 }),
        state({ detect: DETECTED, chat: { note: "brief" }, flow: { note: "tomorrow morning" } }),
      ],
    ];
    for (const [machine, recorded] of steps) {
      for (const card of setupConversationPlan(view(machine, recorded), present).append) {
        seen.push(card.key);
        present.add(card.key);
      }
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([
      setupCardKey("hello", "welcome"),
      setupCardKey("detect", "bare"),
      setupCardKey("flux", "key"),
      setupCardKey("chat", "jobs"),
      setupCardKey("flow", "do-it"),
    ]);
  });

  it("walks the blank machine's four cards, with no detection card among them", () => {
    const seen: string[] = [];
    const present = new Set<string>();
    const blank = (patch: Partial<SetupLiveState> = {}) => live({ agents: [], signedOutAgents: [], ...patch });
    const steps: Array<[SetupLiveState, SetupState]> = [
      [blank(), state()],
      [blank({ ownerName: "Sean" }), state()],
      [blank({ ownerName: "Sean", flux: FLUX_SAVED }), state()],
      [blank({ ownerName: "Sean", flux: FLUX_SAVED }), state({ chat: { note: "notes" } })],
    ];
    for (const [machine, recorded] of steps) {
      for (const card of setupConversationPlan(view(machine, recorded), present).append) {
        seen.push(card.key);
        present.add(card.key);
      }
    }
    expect(seen).toEqual([
      setupCardKey("hello", "welcome"),
      setupCardKey("flux", "bare-needs-key"),
      setupCardKey("chat", "jobs"),
      setupCardKey("flow", "do-it"),
    ]);
  });
});

describe("an install that has already been used", () => {
  // A restored backup trips every one of these: answered turns, a saved key,
  // connected apps and routines. Interrupting it with a welcome card is the
  // worst bug this flow has.
  const restored = live({
    ownerName: "Sean",
    flux: FLUX_SAVED,
    connectedApps: 4,
    connectedAppIds: ["gmail", "googlecalendar", "slack", "notion"],
    crewSize: 3,
    botReplyExists: true,
    routines: { total: 5, briefId: null, briefRan: false },
  });

  it("is shown nothing at all", () => {
    expect(view(restored).firstRun).toBe(false);
    expect(setupConversationPlan(view(restored), new Set())).toEqual({ append: [], settle: [] });
  });

  it("is still shown nothing when the checklist has open steps", () => {
    const partly = live({ ownerName: "Sean", botReplyExists: true, crewSize: 2, routines: { total: 3, briefId: null, briefRan: false } });
    expect(view(partly).firstRun).toBe(false);
    expect(setupConversationPlan(view(partly), new Set()).append).toEqual([]);
  });

  it("carries on for a thread the flow demonstrably started in", () => {
    // The first run's own first step makes `firstRun` false: a saved name is
    // one of the traces that says a workspace has been used. The opening card
    // in the thread is what tells "started here" from "restored".
    const midFlow = live({ ownerName: "Sean" });
    expect(view(midFlow).firstRun).toBe(false);
    expect(keys(setupConversationPlan(view(midFlow), new Set([setupCardKey("hello", "welcome")])).append))
      .toContain(setupCardKey("detect", "bare"));
  });
});

// THE HOLE THAT SHIPPED ONCE, AND THE TEST THAT EXECUTES RATHER THAN SCANS.
//
// `plan()` built its block with `...CARD_COPY[variant]`, and spreading
// `undefined` is a silent no-op in JS. A machine with no agents therefore
// produced a real card in a real transcript with no title and no subtitle at
// all. Only the server typecheck saw it, and the server typecheck was not
// being run at the time.
//
// This calls the lookup for EVERY variant in the union, including the parked
// ones, so a variant added without copy fails here whether or not anybody
// remembered to run tsc.
describe("every card has words, including the parked ones", () => {
  it("answers title and subtitle for every variant that exists", () => {
    for (const variant of SETUP_CARD_VARIANTS) {
      const copy = setupCardCopy(variant);
      expect(copy.title.trim().length, variant).toBeGreaterThan(0);
      expect(copy.subtitle.trim().length, variant).toBeGreaterThan(0);
    }
  });

  it("throws rather than producing a card with nothing on it", () => {
    // The old failure mode was silence. Whatever else goes wrong, a variant
    // with no copy must be impossible to put in front of a person.
    expect(() => setupCardCopy("not-a-card" as never)).toThrow(/no copy/i);
  });
});

describe("the words on the cards", () => {
  it("never uses an em dash, never mentions what anything costs, and never counts models", () => {
    const everyCard = SETUP_CARD_VARIANTS.map((variant) => ({ key: variant, ...setupCardCopy(variant) }));
    expect(everyCard.length).toBeGreaterThan(4);
    for (const card of everyCard) {
      const words = `${card.title} ${card.subtitle}`;
      expect(words, card.key).not.toMatch(/—/);
      expect(words, card.key).not.toMatch(/composio/i);
      expect(words, card.key).not.toMatch(/\bcheap|discount|afford|budget|free trial|per month|\$\d/i);
      expect(words, card.key).not.toMatch(/\d+\+?\s*models/i);
      expect(words, card.key).not.toMatch(/\blesson|exercise|quiz|assignment|homework\b/i);
      expect(card.subtitle.split(/(?<=\.)\s/).length, card.key).toBeLessThanOrEqual(3);
    }
  });

  it("does not sell speech on the Flux Router cards, which is a key that cannot synthesise it", () => {
    // server/voice/flux-voice.ts says in its own words that there is NO
    // synthesis endpoint on this key: no /v1/audio/speech, no passthrough, no
    // voice ids. Transcription is real and is sold on the renderer's card
    // under "talk instead of type"; a claim of speech is not, and one has
    // shipped before.
    //
    // THE FLUX CARDS ONLY, and the narrowness is the point. The same regex
    // over every card fails on "speak up when it changes", which is a routine
    // telling somebody something and has nothing to do with a key. A copy
    // test that catches the wrong sentence is how a test ends up enforcing
    // the thing it was written to prevent.
    for (const variant of ["key", "bare-needs-key", "no-key"] as const) {
      const copy = setupCardCopy(variant);
      expect(`${copy.title} ${copy.subtitle}`, variant)
        .not.toMatch(/\b(voice|speaks?|spoken|read (?:it )?aloud|out loud|text to speech)\b/i);
    }
  });
});
