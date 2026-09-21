import { describe, expect, it } from "vitest";

import { setupCardKey } from "../shared/setup-card.ts";
import {
  type SetupLiveState,
  type SetupState,
  type SetupStep,
  deriveSetupState,
  emptySetupState,
  setupView,
} from "../shared/setup.ts";
import { setupConversationPlan } from "./setup-conversation.ts";

// Shape only, never a credential: the connection card's own gate is what a
// real key passes, and this fixture only has to be key-shaped.
const FLUX_SAVED = { configured: true, conflict: false, looksValid: true };

/** The engine Murage ships. Present on a bare machine, and reported as NOT
 *  installed by the person, because they did not put it there. */
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

// The server hands `setupView` the DERIVED state (`SetupChecklist.read`), so
// the test does the same. A raw checklist would report every step outstanding
// and the flow would never move.
const view = (liveState: SetupLiveState, recorded: SetupState = state()) =>
  setupView(deriveSetupState(recorded, liveState, 2_000), liveState);
const plan = (liveState: SetupLiveState, present: string[] = [], recorded?: SetupState) =>
  setupConversationPlan(view(liveState, recorded), new Set(present));
const keys = (cards: { key: string }[]) => cards.map((card) => card.key);

describe("what the Chief says next on a bare machine", () => {
  it("opens with the welcome card and nothing else", () => {
    const opening = plan(live());
    expect(keys(opening.append)).toEqual([setupCardKey("hello", "welcome")]);
    expect(opening.settle).toEqual([]);
  });

  it("says the engine came in the box once the greeting is behind us", () => {
    // A machine with nothing of its own on it: the only engine available is
    // the one Murage ships, which the person did not install.
    const answered = plan(
      live({ ownerName: "Sean" }),
      [setupCardKey("hello", "welcome")],
    );
    expect(keys(answered.append)).toEqual([
      setupCardKey("agents", "bare"),
      setupCardKey("flux", "key"),
    ]);
    // The card that asked for the name is answered, so it stops being live.
    expect(answered.settle).toEqual([setupCardKey("hello", "welcome")]);
  });

  it("never promises pictures or apps without saying what routing is first", () => {
    const card = plan(live({ ownerName: "Sean" }), [setupCardKey("hello", "welcome")])
      .append.find((entry) => entry.variant === "key")!;
    expect(card.subtitle.indexOf("smart routing")).toBeLessThan(card.subtitle.indexOf("500+ apps"));
  });
});

describe("what the Chief says on a machine that already had help on it", () => {
  const installed = live({
    ownerName: "Sean",
    agents: [BUNDLED, { id: "claude", name: "Claude Code", installed: true }],
  });

  it("says it found them rather than claiming it brought them", () => {
    const cards = plan(installed, [setupCardKey("hello", "welcome")]).append;
    expect(keys(cards)).toContain(setupCardKey("agents", "found"));
    expect(keys(cards)).not.toContain(setupCardKey("agents", "bare"));
  });

  it("tells the two machines apart on detection alone", () => {
    const bare = plan(live({ ownerName: "Sean" }), [setupCardKey("hello", "welcome")]);
    expect(keys(bare.append)).toContain(setupCardKey("agents", "bare"));
    expect(keys(bare.append)).not.toContain(setupCardKey("agents", "found"));
  });
});

describe("what the Chief says when an engine is here and nobody is signed in", () => {
  const opened = [setupCardKey("hello", "welcome")];

  it("does not claim it, and does not pretend the machine is empty", () => {
    const cards = plan(
      live({ ownerName: "Sean", agents: [], signedOutAgents: [CLAUDE_SIGNED_OUT] }),
      opened,
    ).append;
    expect(keys(cards)).toContain(setupCardKey("agents", "signed-out"));
    // "found" is the lie this whole card exists to stop.
    expect(keys(cards)).not.toContain(setupCardKey("agents", "found"));
    // ...and "bare-needs-key" would send somebody to buy a key when what is
    // actually missing is a sign-in they can do for nothing.
    expect(keys(cards)).not.toContain(setupCardKey("agents", "bare-needs-key"));
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
    expect(keys(cards)).toContain(setupCardKey("agents", "signed-out"));
    expect(keys(cards)).not.toContain(setupCardKey("agents", "bare"));
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
    expect(keys(cards)).toContain(setupCardKey("agents", "found"));
    expect(keys(cards)).not.toContain(setupCardKey("agents", "signed-out"));
  });

  it("settles once the step is satisfied, like every other card that asked", () => {
    const signedIn = plan(
      live({ ownerName: "Sean", agents: [BUNDLED], signedOutAgents: [] }),
      [...opened, setupCardKey("agents", "signed-out")],
    );
    expect(signedIn.settle).toContain(setupCardKey("agents", "signed-out"));
  });
});

describe("the not-now branch on the key", () => {
  it("records the decision once and carries straight on to the accounts", () => {
    const passedOver = plan(
      live({ ownerName: "Sean" }),
      [setupCardKey("hello", "welcome"), setupCardKey("agents", "bare"), setupCardKey("flux", "key")],
      state({ flux: { skipped: true } }),
    );
    expect(keys(passedOver.append)).toEqual([
      setupCardKey("flux", "no-key"),
      setupCardKey("apps", "apps"),
    ]);
    // Passed over is not done, and the card that asked stops being live either
    // way: the checklist still says plainly that the step is outstanding.
    expect(passedOver.settle).toEqual([
      setupCardKey("hello", "welcome"),
      setupCardKey("agents", "bare"),
      setupCardKey("flux", "key"),
    ]);
  });

  it("does not say it twice", () => {
    const again = plan(
      live({ ownerName: "Sean" }),
      [
        setupCardKey("hello", "welcome"),
        setupCardKey("agents", "bare"),
        setupCardKey("flux", "key"),
        setupCardKey("flux", "no-key"),
        setupCardKey("apps", "apps"),
      ],
      state({ flux: { skipped: true } }),
    );
    expect(again.append).toEqual([]);
  });
});

describe("the brief, which is proof rather than a promise", () => {
  const scheduled = live({
    ownerName: "Sean",
    flux: FLUX_SAVED,
    connectedApps: 2,
    routines: { total: 1, briefId: "routine-brief", briefRan: false },
  });
  const present = [
    setupCardKey("hello", "welcome"),
    setupCardKey("agents", "bare"),
    setupCardKey("flux", "key"),
    setupCardKey("apps", "apps"),
    setupCardKey("brief", "brief"),
  ];

  it("says nothing about a brief that is only scheduled", () => {
    expect(keys(plan(scheduled, present).append)).not.toContain(setupCardKey("brief", "brief-ran"));
  });

  it("shows the run that proved it works, once one has completed", () => {
    const ran = live({ ...scheduled, routines: { total: 1, briefId: "routine-brief", briefRan: true } });
    const after = plan(ran, present);
    expect(keys(after.append)).toEqual([
      setupCardKey("brief", "brief-ran"),
      setupCardKey("routines", "more-routines"),
    ]);
    expect(after.settle).toContain(setupCardKey("brief", "brief"));
  });

  it("closes the flow when there is nothing left to present", () => {
    const finished = live({
      ownerName: "Sean",
      flux: FLUX_SAVED,
      connectedApps: 2,
      routines: { total: 2, briefId: "routine-brief", briefRan: true },
    });
    const closing = plan(finished, [...present, setupCardKey("brief", "brief-ran"), setupCardKey("routines", "more-routines")]);
    expect(keys(closing.append)).toEqual([setupCardKey("routines", "next")]);
    expect(closing.settle).toContain(setupCardKey("routines", "more-routines"));
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
      [live({ ownerName: "Sean", flux: FLUX_SAVED }), state()],
      [live({ ownerName: "Sean", flux: FLUX_SAVED, connectedApps: 3 }), state()],
      [live({ ownerName: "Sean", flux: FLUX_SAVED, connectedApps: 3, routines: { total: 1, briefId: "b", briefRan: true } }), state()],
      [live({ ownerName: "Sean", flux: FLUX_SAVED, connectedApps: 3, routines: { total: 2, briefId: "b", briefRan: true } }), state()],
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
      setupCardKey("agents", "bare"),
      setupCardKey("flux", "key"),
      setupCardKey("apps", "apps"),
      setupCardKey("brief", "brief"),
      setupCardKey("brief", "brief-ran"),
      setupCardKey("routines", "more-routines"),
      setupCardKey("routines", "next"),
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
      .toContain(setupCardKey("flux", "key"));
  });
});

describe("the words on the cards", () => {
  it("never uses an em dash, never mentions what anything costs, and never counts models", () => {
    const everyCard = [
      ...plan(live()).append,
      ...plan(live({ ownerName: "Sean" }), [setupCardKey("hello", "welcome")]).append,
      ...plan(
        live({ ownerName: "Sean", agents: [BUNDLED, { id: "claude", name: "Claude Code", installed: true }] }),
        [setupCardKey("hello", "welcome")],
      ).append,
      ...plan(
        live({ ownerName: "Sean", flux: FLUX_SAVED, connectedApps: 2, routines: { total: 2, briefId: "b", briefRan: true } }),
        [setupCardKey("hello", "welcome"), setupCardKey("agents", "bare")],
      ).append,
    ];
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
});
