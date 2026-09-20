// What the eight cards are allowed to say.
//
// The cases here are the ones a first run gets wrong in the field: a step
// presented as finished because a button was pressed, a spend ceiling
// presented as a bad key, a claim about how many apps there are, and a second
// key field next to the only real one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  APPS_CLAIM,
  SETUP_CARDS,
  SetupCard,
  SetupChecklistBody,
  setupCardNote,
  setupMemoryLines,
  setupProgressLabel,
  type SetupActions,
} from "./SetupChecklist";
import { setupIsFirstRun } from "./SetupPanel";
import { SETUP_STEPS, type SetupStep, type SetupStepView, type SetupView } from "../../shared/setup";

const noActions = new Proxy({}, { get: () => () => {} }) as SetupActions;

/** The server's own wording for a Flux Router key that authenticates and
 *  then cannot spend. Copied from shared/setup.ts on purpose: the card must
 *  render the server's sentence, so the test pins the server's sentence. */
const PAYMENT_BLOCK =
  "Flux Router accepted this key and then refused a turn on payment. The key is saved and there is "
  + "nothing to re-paste — this is the account's spending, not the key — but the included brain and "
  + "the connected apps cannot answer until it clears.";

function step(id: SetupStep, patch: Partial<SetupStepView> = {}): SetupStepView {
  return { id, done: false, status: "open", ...patch };
}

function view(patch: Partial<SetupView> = {}, steps: Partial<Record<SetupStep, Partial<SetupStepView>>> = {}): SetupView {
  const rendered = SETUP_STEPS.map((id) => step(id, steps[id]));
  return {
    version: 1,
    startedAt: 1,
    chiefBotId: "chief",
    engine: { ready: true },
    progress: { done: rendered.filter((entry) => entry.status === "done").length, total: rendered.length },
    blocked: rendered.filter((entry) => entry.status === "blocked").map((entry) => entry.id),
    next: rendered.find((entry) => entry.status !== "done" && !entry.skipped)?.id ?? null,
    steps: rendered,
    ...patch,
  };
}

/** Static markup, with the entities React escapes put back, so a test can
 *  quote the copy exactly as a person reads it. */
const readable = (html: string) =>
  html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

const card = (one: SetupStepView, whole = view({}, { [one.id]: one }), expanded = true) =>
  readable(renderToStaticMarkup(
    createElement(SetupCard, {
      step: one,
      view: whole,
      actions: noActions,
      brainName: "Fuigo via Flux Router",
      expanded,
      busy: false,
      onExpand: () => {},
    }),
  ));

const source = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

describe("the progress line is the server's count", () => {
  it("reads '3 of 8 done'", () => {
    expect(setupProgressLabel({ progress: { done: 3, total: 8 } })).toBe("3 of 8 done");
  });

  it("pins the same count on the progress bar for assistive tech", () => {
    const html = readable(renderToStaticMarkup(
      createElement(SetupChecklistBody, {
        view: view({ progress: { done: 3, total: 8 } }),
        actions: noActions,
        chiefName: "Ember",
        openStep: null,
        onOpenStep: () => {},
        busyStep: null,
      }),
    ));
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain('aria-valuetext="3 of 8 done"');
    expect(html).toContain("3 of 8 done");
  });
});

describe("a blocked step is not a step you got wrong", () => {
  const blocked = step("flux", {
    status: "blocked",
    block: { reason: "payment-required", message: PAYMENT_BLOCK },
  });

  it("renders the server's own sentence, word for word", () => {
    expect(setupCardNote(blocked)).toBe(PAYMENT_BLOCK);
    expect(card(blocked)).toContain("The key is saved and there is nothing to re-paste");
  });

  it("never tells the person the key is wrong or asks for it again", () => {
    const html = card(blocked);
    expect(html).not.toMatch(/paste it again/i);
    expect(html).not.toMatch(/not in a shape/i);
    expect(html).not.toMatch(/invalid key|wrong key|incorrect/i);
  });

  it("says Blocked rather than To do, so the person knows it is not on them", () => {
    expect(card(blocked)).toContain("Blocked");
  });

  it("falls back to the server's detail only when a block arrived with no message", () => {
    expect(setupCardNote(step("apps", {
      status: "blocked",
      block: { reason: "apps-unreadable", message: "   " },
      detail: "Connected apps could not be read.",
    }))).toBe("Connected apps could not be read.");
  });
});

describe("the card renders the server's status and never recomputes it", () => {
  it("shows a step blocked even when the wire's own `done` says otherwise", () => {
    // `done` and `status` can only disagree if something upstream drifts.
    // When they do, the status the server computed from live state wins —
    // the alternative is a tick over a step that does not work.
    const drifted = step("flux", {
      done: true,
      status: "blocked",
      block: { reason: "payment-required", message: PAYMENT_BLOCK },
    });
    const html = card(drifted);
    expect(html).toContain('data-setup-status="blocked"');
    // The mark, the word and the sentence all come off `status`. Pinning all
    // three is the point: a card that ticked the mark off `done` and only
    // worded the rest off `status` is the half-drift this guards.
    expect(html).toContain('data-setup-mark="blocked"');
    expect(html).toContain(PAYMENT_BLOCK);
    expect(html).not.toContain(">Done<");
    expect(html).not.toContain('data-setup-mark="done"');
  });

  it("keeps a passed-over step outstanding, and says what stays locked", () => {
    const one = step("flux", { status: "skipped", skipped: true });
    const html = card(one);
    expect(html).toContain('data-setup-mark="skipped"');
    expect(html).not.toContain(">Done<");
    // The card's own body also mentions what a key unlocks, so the note has
    // to be read on its own — otherwise this passes on the wrong sentence.
    expect(setupCardNote(one)).toContain("stay locked until a key is saved");
    expect(setupCardNote(one)).toContain("Passed over");
  });

  it("offers Change on a finished step and promises nothing is reinstalled", () => {
    const html = card(step("crew", { done: true, status: "done" }));
    expect(html).toContain("Change");
    expect(html).toContain("nothing is reinstalled");
  });
});

describe("what the cards may claim", () => {
  it("never puts a number on the connected apps", () => {
    const html = card(step("apps"));
    expect(html).toContain(APPS_CLAIM);
    expect(html).not.toContain("500+");
    expect(html).not.toMatch(/\d{3,}\+?\s*apps/i);
  });

  it("points the apps card back at the key when Flux Router was skipped", () => {
    const skipped = view({}, { flux: { status: "skipped", skipped: true } });
    expect(card(step("apps"), skipped)).toContain('data-setup-points-at="flux"');
  });

  it("stops pointing at the key once the key is in", () => {
    const keyed = view({}, { flux: { done: true, status: "done" } });
    expect(card(step("apps"), keyed)).not.toContain('data-setup-points-at="flux"');
  });

  it("carries no second key field — there is exactly one, in Settings", () => {
    const html = card(step("flux"));
    expect(html).not.toContain("<input");
    expect(html).not.toContain("password");
    expect(html).toContain("Paste your key");
  });
});

describe("the words the release settled on", () => {
  it("calls it a brain, with the engine's own name underneath", () => {
    const html = card(step("brain"));
    expect(html).toContain("Your Chief's brain");
    expect(html).toContain("Fuigo via Flux Router");
    expect(SETUP_CARDS.brain.title).toBe("Give your bots a brain");
  });

  it("says a brain is proved by answering, not by being picked", () => {
    expect(card(step("brain"))).toContain("done when your Chief actually answers");
  });

  it("never says agent, room or bulletin anywhere in the setup copy", () => {
    for (const file of ["./SetupChecklist.tsx", "./SetupPanel.tsx"]) {
      const prose = [...source(file).matchAll(/"([^"\\]{4,})"/g)].map(([, text]) => text)
        .concat([...source(file).matchAll(/>([^<>{}]{4,})</g)].map(([, text]) => text))
        .filter((text) => /\s/.test(text));
      expect(prose.filter((text) => /\bagents?\b/i.test(text))).toEqual([]);
      expect(prose.filter((text) => /\brooms?\b|\bbulletin\b/i.test(text))).toEqual([]);
    }
  });
});

describe("the wrap-up shows the exact lines before they are saved", () => {
  it("builds them from what the person actually answered", () => {
    const answered = view({}, {
      purpose: { note: "Keep my inbox under control", done: true, status: "done" },
      voice: { note: "Short and direct", done: true, status: "done" },
    });
    expect(setupMemoryLines(answered)).toBe(
      "# What I'll remember\n"
      + "- What you want taken off your plate: Keep my inbox under control\n"
      + "- How you like things written: Short and direct\n",
    );
  });

  it("still says something honest when nothing was answered", () => {
    expect(setupMemoryLines(view())).toContain("You set me up and went straight to work.");
  });

  it("puts them in an editable box, not a fixed block", () => {
    expect(card(step("wrap"))).toContain('aria-label="Lines your Chief will remember"');
  });
});

describe("who is offered the checklist", () => {
  it("offers it on a workspace that has never been through setup", () => {
    expect(setupIsFirstRun(view())).toBe(true);
  });

  it("never interrupts a workspace that has already done something", () => {
    expect(setupIsFirstRun(view({}, { flux: { done: true, status: "done" } }))).toBe(false);
    expect(setupIsFirstRun(view({}, { purpose: { note: "Email" } }))).toBe(false);
    expect(setupIsFirstRun(view({}, { voice: { skipped: true, status: "skipped" } }))).toBe(false);
  });
});
