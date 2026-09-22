import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The cards talk to the harness and to the store. Neither exists in a node
// test, and neither is what these tests are about: what is being checked is
// that the right card renders the right words and never renders a control
// that could not work.
// THE SETUP VIEW IS ANSWERABLE, because half of what these cards say is a
// report about the machine and a card with no view says nothing at all. The
// stub is one variable the tests set, so a card can be rendered against a
// machine with six engines on it without a server.
let setupReply: unknown = {};
vi.mock("@/state/store", () => ({
  api: async (path: string) => (path === "/api/setup" ? setupReply : {}),
  useStore: () => ({ state: {}, dispatch: () => {} }),
}));
vi.mock("@/lib/analytics", () => ({ identifyEmail: () => {}, setEmailGateDone: () => {} }));

const { FirstRunCard } = await import("./FirstRunCard");
const { helloAnswerReady } = await import("./FirstRunHelloCard");
const { FirstRunFluxConnect } = await import("./FirstRunFluxCard");
const { readSetupView, forgetSetupView } = await import("./FirstRunChrome");
const { FIRST_RUN_COPY, firstRunAddress, greetingLine, lookedAroundLine } = await import("@/lib/first-run-copy");
const { SETUP_CARD_VARIANTS, setupCardKey } = await import("../../shared/setup-card");
// The server's own list of which card asked for which step. Imported rather
// than copied: a hand-kept twin of it is how the Flux step came to open on a
// card with no controls while every list in the tree agreed with itself.
const { SETUP_ASK_VARIANTS } = await import("../../server/setup-conversation");

/** Put a machine behind the cards. `renderToStaticMarkup` runs no effects, so
 *  the view has to be in the shared cache before the render, not after it. */
async function machine(view: Record<string, unknown>): Promise<void> {
  setupReply = { steps: [], agents: [], signedOutAgents: [], ownerName: "", ...view };
  forgetSetupView();
  await readSetupView(true);
}

/** A sentence as it looks once React has put it in the document. */
const asHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

type AnyMessage = Parameters<typeof FirstRunCard>[0]["message"];

const bot = { id: "chief", threadId: "thread-1", name: "Chief of Staff" } as Parameters<typeof FirstRunCard>[0]["bot"];

/**
 * The step a PARKED card rides on.
 *
 * `apps`, `brief` and `routines` stopped being steps in W16 and the cards
 * built against them are parked, not deleted: the apps rows, the morning
 * brief, the "a couple more" offer, the closing card and the phone
 * walkthrough are all real, tested work and the owner has not decided their
 * fate. Nothing emits them today, so the only way to exercise them is to
 * render them directly, and `FirstRunCard` dispatches on the VARIANT alone.
 * The step here is therefore just a valid one for the card envelope to carry
 * (`readSetupCard` validates it), and it matches PARKED_CARD_STEP in
 * FirstRunChrome so the whole park says one thing.
 */
const PARKED = "flow";

const render = (step: string, variant: string, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(FirstRunCard, {
    bot,
    message: {
      id: `card-${variant}`,
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Setup",
        options: [],
        setup: { step, variant, key: setupCardKey(step as never, variant as never), ...extra },
      },
    } as unknown as AnyMessage,
  }));

describe("the first run card dispatch", () => {
  it("renders nothing for a message that is not a first run card", () => {
    const markup = renderToStaticMarkup(createElement(FirstRunCard, {
      bot,
      message: { id: "x", role: "bot", kind: "options", at: 1, card: { title: "t", options: [] } } as unknown as AnyMessage,
    }));
    expect(markup).toBe("");
  });

  it("renders nothing for a card from a build this one does not know", () => {
    // The defensive read, the same gate readIntakeCard applies: a restored
    // transcript must never throw its way into the message list.
    expect(render("hello", "sparkles")).toBe("");
    expect(render("not-a-step", "welcome")).toBe("");
  });
});

// A CARD THAT ASKS FOR A STEP MUST BE ANSWERABLE ON SCREEN.
//
// RELEASE BLOCK #1 IN ONE SENTENCE: the Flux step opened on `bare-needs-key`,
// which renders two paragraphs and no control, and `setupStepDone("flux")`
// wants a real saved key. The only `saveFluxKey` and the only
// `skipSetupStep("flux")` in the whole flow are on `FirstRunFluxCard`, and
// the server showed that card only when the machine was NOT blank. So a blank
// machine read "One key sorts that, and it is the next thing I will ask you
// for" and nothing ever followed. Every individual test passed.
//
// The list is not written here. `SETUP_ASK_VARIANTS` is the server's own
// answer to "which card asked for this step", and it is what the server
// settles cards by, so the two halves cannot drift apart: put a card with no
// button back into a step and this fails, and take it out of the list to
// quieten this and the server's own park test fails instead.
describe("every card that asks for a step can be answered on it", () => {
  /** The machine each ask is the LIVE question on. A card is only owed a
   *  control in the state where it is the outstanding one. */
  const WHERE: Record<string, Record<string, unknown>> = {
    welcome: { ownerName: "" },
    found: { ownerName: "Sean", agents: [{ id: "claude", name: "Claude Code", installed: true }] },
    bare: { ownerName: "Sean", agents: [], signedOutAgents: [] },
    "signed-out": {
      ownerName: "Sean",
      agents: [],
      signedOutAgents: [{ id: "codex", name: "Codex", installed: true, signInCommand: "codex login" }],
    },
    // THE ONE THAT WAS BROKEN, ON THE MACHINE IT WAS BROKEN FOR.
    key: { ownerName: "Sean", agents: [], signedOutAgents: [], nothingToThinkWith: true },
    jobs: { ownerName: "Sean", fluxReady: true, connectedJobApps: ["gmail", "googlecalendar"] },
    "do-it": {
      ownerName: "Sean",
      fluxReady: true,
      nothingToThinkWith: false,
      connectedJobApps: [],
      steps: [{ id: "chat", done: true, note: "notes", status: "done" }],
    },
  };

  it("puts a live control on every one of them", async () => {
    for (const [step, variants] of Object.entries(SETUP_ASK_VARIANTS)) {
      for (const variant of variants) {
        const where = WHERE[variant];
        expect(where, `no machine written for the ${step} step's ${variant} card`).toBeDefined();
        await machine(where!);
        const markup = render(step, variant);
        expect(markup, `${step}:${variant} rendered nothing`).not.toBe("");
        // A button that is present and disabled is not a way out, which is
        // why this reads the attribute rather than counting `<button`.
        expect.soft(markup, `${step}:${variant} asks a question nobody can answer`)
          .toMatch(/<button(?![^>]*\sdisabled="")/);
      }
    }
  });

  // The words on the blank machine's Flux card, which is the report detection
  // never got to make. They were the reason a second card existed; the card
  // says them itself, above the box that takes the key.
  it("says on the blank machine's key card what the dead end used to say", async () => {
    await machine({ ownerName: "Sean", agents: [], signedOutAgents: [], nothingToThinkWith: true });
    const flux = FIRST_RUN_COPY.flux.key;
    const markup = render("flux", "key");
    expect(markup).toContain(flux.headingBare);
    expect(markup).toContain("found nothing I can think with");
    expect(markup, "no way to enter the key the step cannot end without").toContain(flux.submit);
    expect(markup, "no way past it either").toContain(flux.dismiss);
  });
});

describe("card one: hello", () => {
  const copy = FIRST_RUN_COPY.hello.welcome;
  it("asks for two things, offers a way past, and says detection is already running", () => {
    const markup = render("hello", "welcome");
    expect(markup).toContain(copy.heading);
    expect(markup).toContain(copy.lead);
    expect(markup).toContain(`aria-label="${copy.nameLabel}"`);
    expect(markup).toContain(`aria-label="${copy.emailLabel}"`);
    expect(markup).toContain(copy.skip);
    expect(markup).toContain(copy.detecting);
  });

  it("asks the approved question and says what each field is for", () => {
    // The step that builds the owner's list, so its words are the ones that
    // were signed off rather than a paraphrase of them. Both fields say what
    // they are FOR: a field with no stated purpose is a field people skip.
    expect(copy.heading).toBe("First, who am I working for?");
    expect(copy.lead).toContain("Your name is what I call you.");
    expect(copy.lead).toContain("how Murage tells you when there is something new it can do");
    expect(copy.submit).toBe("Continue");
    expect(copy.skip).toBe("Skip for now");
  });

  /**
   * THE DEFECT: THE STATED PURPOSE OF THE EMAIL WAS FALSE.
   *
   * "Your email is how I reach you when you are away from this computer" was
   * the first promise the flow made and there is nothing behind it: no
   * `ownerEmail` consumer anywhere in `server/`, and nothing in the product
   * mails the owner. The address is saved on the profile, it identifies them
   * to analytics, and it joins the announcement list. The morning brief is
   * separately ruled never to be emailed, so it was not a feature in flight.
   *
   * The lead is checked against `server/` here rather than against itself:
   * the sentence may come back the day something really does mail the owner,
   * and not one day before.
   */
  it("promises no message it cannot send", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("../../server/", import.meta.url));
    const consumers = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test."))
      .filter((entry) => readFileSync(root + entry.name, "utf8").includes("ownerEmail"))
      .map((entry) => entry.name);
    expect(consumers, "something now reads an owner email; the lead may say so again").toEqual([]);
    expect(copy.lead).not.toMatch(/reach you|away from this computer|email you|send you/i);
  });

  it("will not save until the email is one", () => {
    // The button is the only way to save and it starts disabled, so a typo
    // never reaches /api/config.
    expect(render("hello", "welcome")).toContain("disabled=\"\"");
  });

  // THE DEFECT: Continue used to need only the email.
  //
  // So it lit up with the name box empty, and the profile that reached
  // /api/config and then the signup carried an address and nobody's name. The
  // approved flow is explicit that BOTH have to validate, and the way past an
  // unfinished form is the Skip button beside it, not a half answer.
  it("needs both a name and an email before Continue does anything", () => {
    expect(helloAnswerReady("Sean", "sean@example.com")).toBe(true);
    expect(helloAnswerReady("", "sean@example.com")).toBe(false);
    expect(helloAnswerReady("   ", "sean@example.com")).toBe(false);
    expect(helloAnswerReady("Sean", "")).toBe(false);
    expect(helloAnswerReady("Sean", "sean@example")).toBe(false);
    expect(helloAnswerReady("Sean", "not an address")).toBe(false);
    // Whitespace around a real pair is a paste, not a refusal.
    expect(helloAnswerReady("  Sean  ", "  sean@example.com  ")).toBe(true);
  });

  // SKIPPING SETS THE NAME TO "there" ON SCREEN, AND NOWHERE ELSE.
  //
  // The two sentences want opposite things from the same blank: the Chief's
  // question a step later reads "What can I take off your plate, there?", and
  // the greeting DROPS the clause rather than saying "Good to meet you,
  // there." Both are only possible while the blank stays blank, which is why
  // nothing writes a word the person never typed onto the owner profile.
  it("calls a skipped person there, and still greets them without a name", () => {
    expect(firstRunAddress("")).toBe("there");
    expect(firstRunAddress("   ")).toBe("there");
    expect(firstRunAddress(null)).toBe("there");
    expect(firstRunAddress(undefined)).toBe("there");
    expect(firstRunAddress("Sean")).toBe("Sean");
    expect(firstRunAddress("  Sean  ")).toBe("Sean");
    expect(greetingLine("")).toBe("Good to meet you. Right then.");
    expect(greetingLine("")).not.toContain("there");
  });
});

describe("card two: what is already here", () => {
  const copy = FIRST_RUN_COPY.agents.detect;

  it("draws a row for every runnable engine and collapses the rest", async () => {
    await machine({
      ownerName: "Sean",
      agents: [
        { id: "ollama", name: "generic", installed: true, localModel: { model: "qwen3:8b", host: "Ollama" } },
        { id: "claude", name: "Claude Code", installed: true },
      ],
      signedOutAgents: [
        { id: "codex", name: "Codex", installed: true },
        { id: "gemini", name: "Gemini CLI", installed: true },
      ],
    });
    const markup = render("detect", "found");
    expect(markup).toContain(lookedAroundLine("Sean"));
    expect(markup).toContain(copy.heading);
    // Every runnable engine, named the way its owner names it.
    expect(markup).toContain("qwen3:8b on Ollama");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain(copy.localDetail);
    // The signed-out pair is BEHIND the button, not on the page.
    expect(markup).toContain("and 2 more on this computer");
    expect(markup).not.toContain("Codex");
    expect(markup).toContain(copy.closing);
  });

  // The wall this collapse exists to prevent is the owner's own machine, which
  // has eighteen engines on it. What must never happen is the opposite
  // mistake: hiding something that CAN think behind a button, so the person
  // cannot see what is about to answer them.
  it("never hides a runnable engine behind the button", async () => {
    await machine({
      agents: Array.from({ length: 6 }, (_, index) => ({ id: `e${index}`, name: `Engine ${index}`, installed: true })),
    });
    const markup = render("detect", "found");
    for (let index = 0; index < 6; index += 1) expect.soft(markup).toContain(`Engine ${index}`);
    expect(markup).not.toContain("more on this computer");
  });

  // THE FLOW STOPPED HERE FOR EVERYBODY WITH AN ENGINE, WHICH IS MOST OF THEM.
  //
  // `detect` is settled by `nothingToThinkWith(live) || setupStepAnswered`.
  // On any machine that has something, the first half is false, so the only
  // road out is a recorded answer, and nothing in the renderer ever recorded
  // one: `nextSetupStep` returned `detect` for ever and the Flux screen, the
  // one the company makes its money on, was never shown to anybody. The words
  // for the button existed and were sitting unused in the copy file.
  //
  // All three detection variants, because all three are the same step and any
  // of them can be the last card a person is looking at.
  it("gives every detection card a way on to the next step", async () => {
    await machine({
      ownerName: "Sean",
      agents: [{ id: "claude", name: "Claude Code", installed: true }],
      signedOutAgents: [],
    });
    expect(render("detect", "found"), "found").toContain(copy.action);

    await machine({ ownerName: "Sean", agents: [], signedOutAgents: [] });
    expect(render("detect", "bare"), "bare").toContain(copy.action);

    await machine({
      ownerName: "Sean",
      agents: [],
      signedOutAgents: [{ id: "codex", name: "Codex", installed: true, signInCommand: "codex login" }],
    });
    expect(render("detect", "signed-out"), "signed-out").toContain(copy.action);

    // ...including the one where they went and signed in, which empties the
    // list and settles nothing on its own.
    await machine({ ownerName: "Sean", agents: [], signedOutAgents: [] });
    expect(render("detect", "signed-out"), "signed in already").toContain(copy.action);
  });

  /**
   * THE DEFECT: "WHAT IS ALREADY RUNNING CARRIES ON" SAID TO A MACHINE WHERE
   * NOTHING IS RUNNING.
   *
   * `agents["signed-out"].third` was rendered unconditionally. It is written
   * for somebody whose signed-out Codex sits BESIDE a working engine, where
   * leaving it really does cost them nothing. On a machine whose only engine
   * is the signed-out one, `view.agents` is empty, nothing can answer, and
   * the card told that person their assistant was working while the next
   * thing they asked it for was going to fail. Same shape as the claim this
   * card was built to end.
   *
   * `agents` is already filtered by `runnable()` on the server, so an empty
   * list IS "nothing is running" and no second reading is needed. The guard
   * is `view.agents.length > 0`, which is what `canCarryOn` in
   * FirstRunFluxCard.tsx and `bare` in `FirstRunNoKeyCard` already read.
   */
  const signedOut = FIRST_RUN_COPY.agents["signed-out"];

  it("never tells a machine with nothing running that something carries on", async () => {
    await machine({
      ownerName: "Sean",
      nothingToThinkWith: false,
      agents: [],
      signedOutAgents: [{ id: "codex", name: "Codex", installed: true, signInCommand: "codex login" }],
    });
    const markup = render("detect", "signed-out");
    expect(markup, "nothing is running here and the card said something was")
      .not.toContain(asHtml(signedOut.third));
    // AND IT STILL SAYS SOMETHING. Deleting the line would pass the assertion
    // above and leave the card two sentences long with no answer to "what
    // happens if I leave it", so the replacement is required, not optional.
    expect(markup, "the false line was removed and nothing took its place")
      .toContain(asHtml(signedOut.thirdBare));
    // The rest of the card is untouched: this is one sentence, not a variant.
    expect(markup).toContain(asHtml(signedOut.second));
    expect(markup).toContain(copy.action);
  });

  it("still tells a machine that has an engine that it carries on", async () => {
    await machine({
      ownerName: "Sean",
      nothingToThinkWith: false,
      agents: [{ id: "claude", name: "Claude Code", installed: true }],
      signedOutAgents: [{ id: "codex", name: "Codex", installed: true, signInCommand: "codex login" }],
    });
    const markup = render("detect", "signed-out");
    expect(markup, "a machine that really does carry on lost the line").toContain(asHtml(signedOut.third));
    expect(markup).not.toContain(asHtml(signedOut.thirdBare));
  });

  // THE CARD THAT USED TO BE THE FLUX STEP'S OPENING ON A BLANK MACHINE.
  //
  // This test used to say "puts no detection control on the Flux step's own
  // opening" and pass, and it was enshrining release block #1: the card has
  // no control of ANY kind, and it was what the server sent the one machine
  // that cannot leave the Flux step without a key. The comment claimed "the
  // key card is below it". No key card was below it. `variantForCurrentStep`
  // returned one variant per step, and on that machine it returned this one.
  //
  // It is parked now, and what is checked is what makes parking safe: it is
  // still readable, and there is nothing on it to press.
  it("keeps the parked brain card readable, with nothing on it to press", async () => {
    await machine({ ownerName: "Sean", agents: [], signedOutAgents: [], nothingToThinkWith: true });
    const markup = render("flux", "bare-needs-key");
    expect(markup, "the parked card vanished instead of becoming history")
      .toContain(asHtml(FIRST_RUN_COPY.agents["bare-needs-key"].body));
    expect(markup).not.toContain(copy.action);
    // AND THIS IS THE BLOCK. A card with no button is a card nobody can leave,
    // which is exactly why this variant stopped being what a step opens with.
    expect(markup, "a parked card grew a control").not.toMatch(/<button/);
  });

  it("stops offering it once the step has been settled", async () => {
    await machine({ ownerName: "Sean", agents: [{ id: "claude", name: "Claude Code", installed: true }] });
    expect(render("detect", "found", { settled: true })).not.toContain(copy.action);
  });

  it("says nothing about a machine it cannot see", async () => {
    // No view is not an empty machine, and a report built from a guess is a
    // report that is wrong on half the machines it ships to.
    setupReply = {};
    forgetSetupView();
    await readSetupView(true);
    expect(render("detect", "found")).not.toContain(copy.heading);
  });
});

describe("card three: the key", () => {
  const copy = FIRST_RUN_COPY.flux.key;
  it("leads with routing, then the apps, then the models and the media", async () => {
    await machine({ agents: [{ id: "claude", name: "Claude Code", installed: true }] });
    const markup = render("flux", "key");
    expect(markup).toContain(copy.heading);
    expect(markup).toContain(copy.lead);
    // The order the rows are argued in is the order they appear in.
    const at = (text: string) => markup.indexOf(text);
    const places = copy.features.map((row) => at(row.title));
    for (const place of places) expect.soft(place).toBeGreaterThan(-1);
    expect([...places]).toEqual([...places].sort((a, b) => a - b));
    expect(markup).toContain(copy.recommendationBonus);
  });

  // NO PRICE, NO FIGURE, NO PLAN COMPARISON. It is a ruling, and this is the
  // rendered screen rather than the copy file: a number that arrived through a
  // component rather than through FIRST_RUN_COPY would sail past the copy gate
  // and land on the one screen it is banned from.
  it("puts no money on the screen the company makes its money on", () => {
    const markup = render("flux", "key");
    expect(markup).not.toMatch(/[$£€]\s?\d/);
    expect(markup).not.toMatch(/\b(per month|a month|free|cheap|pricing|plan)\b/i);
  });

  // THE COMING-SOON ROW CARRIES ITS PILL ON SCREEN.
  //
  // This is the other half of the narrowed speech test. That test lets a row
  // mention speaking out loud only when the row declares `coming-soon`, and
  // the declaration is only worth anything if the person READS it. A row that
  // bought the exemption in the data and rendered as though it worked today
  // would be the shipped false claim arriving through the exemption door.
  it("shows the coming soon row as coming soon", () => {
    const markup = render("flux", "key");
    const soon = copy.features.filter((row) => row.state === "coming-soon");
    expect(soon.length).toBeGreaterThan(0);
    for (const row of soon) {
      expect.soft(markup, `${row.title} is not marked`).toContain(row.title);
      expect.soft(markup).toContain(copy.comingSoon);
      // The pill is beside the row it belongs to, not somewhere on the page.
      expect.soft(markup.indexOf(copy.comingSoon)).toBeGreaterThan(markup.indexOf(row.title));
    }
  });

  it("asks for the key only after it has opened the page that issues one", () => {
    // The paste box is the SECOND screen. Asking somebody who has never heard
    // of Flux Router to paste something they do not have, with the way to get
    // one third in a row of three buttons, is the shape this replaces.
    const markup = render("flux", "key");
    expect(markup).toContain(copy.submit);
    // React escapes the apostrophe in "computer's keychain" on its way into
    // the markup, which is a fact about HTML rather than about the copy.
    expect(markup).toContain(asHtml(copy.keyCaveat));
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain(copy.connectHeading);
  });

  it("offers a blank machine nothing to carry on with, because it has nothing", async () => {
    await machine({ nothingToThinkWith: true, ownerName: "Sean" });
    const markup = render("flux", "key");
    expect(markup).toContain(copy.headingBare);
    expect(markup).toContain(lookedAroundLine("Sean").slice(0, 22));
    expect(markup).toContain("found nothing I can think with");
    expect(markup).toContain(copy.dismiss);
    expect(markup).not.toContain(copy.dismissLocal);
    expect(markup).not.toContain(copy.heading);
  });

  /**
   * THE DEFECT: A LOCAL MODEL OFFERED TO SOMEBODY WHO HAS NONE.
   *
   * The dismissal was `noBrain ? copy.dismiss : copy.dismissLocal`, and
   * `nothingToThinkWith` is FALSE on a machine whose only engine is signed
   * out: that machine is not blank, which is exactly why it gets the
   * `signed-out` variant. So the one audience that variant was built for was
   * offered "Not yet, start me on the local model" while `view.agents` was
   * empty and there was nothing to start.
   */
  it("offers no local model to a machine whose only engine is signed out", async () => {
    await machine({
      ownerName: "Sean",
      nothingToThinkWith: false,
      agents: [],
      signedOutAgents: [{ id: "codex", name: "Codex", installed: true, signInCommand: "codex login" }],
    });
    const markup = render("flux", "key");
    expect(markup, "a local model was offered to a machine with none").not.toContain(copy.dismissLocal);
    expect(markup).toContain(copy.dismiss);
    // Still not the blank machine's report: something IS here, and detection
    // ran on it. Only the dismissal changes.
    expect(markup).toContain(copy.heading);
    expect(markup).not.toContain(copy.headingBare);
  });

  it("offers a machine with an engine the local model it already has", async () => {
    await machine({
      nothingToThinkWith: false,
      agents: [{ id: "ollama", name: "generic", installed: true, localModel: { model: "qwen3:8b", host: "Ollama" } }],
    });
    const markup = render("flux", "key");
    expect(markup).toContain(copy.heading);
    expect(markup).toContain(copy.dismissLocal);
    expect(markup).not.toContain(copy.headingBare);
  });

  it("takes the key on its own screen, with a way back that saves nothing", () => {
    const markup = renderToStaticMarkup(createElement(FirstRunFluxConnect, {
      value: "",
      busy: false,
      failure: "",
      onChange: () => {},
      onSubmit: () => {},
      onAgain: () => {},
      onCancel: () => {},
    }));
    expect(markup).toContain(copy.connectHeading);
    expect(markup).toContain(copy.connectLead);
    // A key is a secret even on the way in, and it is never re-displayed.
    expect(markup).toContain('type="password"');
    expect(markup).toContain(`aria-label="${copy.fieldLabel}"`);
    expect(markup).toContain(`placeholder="${copy.placeholder}"`);
    expect(markup).toContain(asHtml(copy.connectCaveat));
    expect(markup).toContain(copy.connectAgain);
    expect(markup).toContain(copy.connectCancel);
    // Connect is dead until there is something to connect with, so an empty
    // box can never reach the keychain.
    expect(markup).toMatch(/disabled=""[^>]*>Connect</);
  });

  it("says the not now card without a nudge to reconsider", () => {
    const markup = render("flux", "no-key");
    expect(markup).toContain(FIRST_RUN_COPY.flux["no-key"].body);
    expect(markup).toContain(FIRST_RUN_COPY.flux["no-key"].second);
    expect(markup).not.toContain(copy.submit);
  });
});

// STEPS FOUR AND FIVE, THROUGH THE DISPATCH THAT SHIPS.
//
// THE DEFECT: `firstRunCardBody` had no case for `jobs` or `do-it`. Both fell
// to `default: return null`, and `FirstRunCard` returns null on a null body,
// so the server planned both cards, appended both to the transcript, and the
// last two steps of the first run drew LITERALLY NOTHING. Not a blank card:
// nothing. The behaviour was all there, built and tested, in
// src/lib/first-run-jobs.ts and src/lib/first-run-flow.ts, and nothing
// rendered a line of it.
//
// These go through `render`, which is the real dispatch on the real variant,
// so the case coming back out of the switch is what is being checked.
describe("step four: what can I take off your plate", () => {
  const copy = FIRST_RUN_COPY.chat.jobs;

  it("draws the question and all five jobs rather than nothing at all", async () => {
    await machine({ ownerName: "Sean", fluxReady: true, connectedJobApps: ["gmail", "googlecalendar"] });
    const markup = render("chat", "jobs");
    expect(markup, "the jobs card rendered nothing").not.toBe("");
    expect(markup).toContain(asHtml(`${copy.question}, Sean?`));
    for (const row of copy.rows) {
      expect.soft(markup, row.id).toContain(asHtml(row.title));
      expect.soft(markup, row.id).toContain(asHtml(row.sub));
    }
    expect(markup).toContain(copy.escape);
  });

  /**
   * THE DEFECT: SKIPPING HELLO LEFT THE NAME EMPTY ON SCREEN.
   *
   * The approved flow gives a skipped person the word "there" for exactly
   * one sentence, this one, and `firstRunAddress` was written for it and
   * called by nothing: the card passed `view.ownerName` straight through, so
   * a skip produced the bare "What can I take off your plate?".
   *
   * It is a RENDER fallback. Nothing writes "there" to the owner profile,
   * because the greeting wants the opposite thing from the same blank, and
   * that is asserted here on the same machine rather than left to a comment.
   */
  it("calls a skipped person there, and still stores no name for them", async () => {
    await machine({ ownerName: "", fluxReady: true, connectedJobApps: ["gmail", "googlecalendar"] });
    const markup = render("chat", "jobs");
    expect(markup, "a skipped hello left a bare question").toContain(asHtml(`${copy.question}, there?`));
    expect(markup).not.toContain(asHtml(`${copy.question}?`));
    // The blank stays blank: the greeting drops the clause rather than
    // saying "Good to meet you, there."
    expect(greetingLine("")).not.toContain("there");
    expect(lookedAroundLine("")).not.toContain("there");
  });

  it("tags each job with what it is still waiting on, live", async () => {
    await machine({ ownerName: "Sean", fluxReady: false, nothingToThinkWith: false, connectedJobApps: [] });
    const missing = render("chat", "jobs");
    // Nothing connected and no key: the brief wants both accounts and the
    // key, and the jobs that reach for nothing are ready on this machine.
    expect(missing).toContain(copy.tags.ready);
    expect(missing).toContain("3 " + copy.tags.countTail);

    await machine({ ownerName: "Sean", fluxReady: true, connectedJobApps: ["gmail", "googlecalendar"] });
    expect(render("chat", "jobs")).toContain(copy.status.connected);
  });

  // A machine nobody has looked at yet must not be told anything is ready.
  it("offers no tag and nothing to press while the machine is unknown", async () => {
    setupReply = {};
    forgetSetupView();
    await readSetupView(true);
    const markup = render("chat", "jobs");
    expect(markup).toContain(asHtml(copy.rows[0].title));
    expect(markup, "claimed a job was ready on a machine it cannot see").not.toContain(copy.tags.ready);
  });
});

describe("step five: the job, done", () => {
  it("draws the job's own screen rather than nothing at all", async () => {
    // Nothing connected and no key, so the brief opens on what it needs.
    await machine({
      ownerName: "Sean",
      fluxReady: false,
      nothingToThinkWith: false,
      connectedJobApps: [],
      steps: [{ id: "chat", done: true, note: "brief", status: "done" }],
    });
    const markup = render("flow", "do-it");
    expect(markup, "the do-it card rendered nothing").not.toBe("");
    const connect = FIRST_RUN_COPY.flow["do-it"].connect;
    expect(markup).toContain(asHtml(connect.lead));
    expect(markup).toContain(asHtml(connect.reasons.flux));
    expect(markup).toContain(asHtml(connect.reasons.gmail));
    expect(markup).toContain(connect.elsewhere);
  });

  it("opens the box straight away when the job needs nothing", async () => {
    await machine({
      ownerName: "Sean",
      fluxReady: true,
      nothingToThinkWith: false,
      connectedJobApps: [],
      steps: [{ id: "chat", done: true, note: "notes", status: "done" }],
    });
    const box = FIRST_RUN_COPY.flow["do-it"].input.notes;
    const markup = render("flow", "do-it");
    expect(markup).toContain(asHtml(box.heading));
    expect(markup).toContain(`placeholder="${asHtml(box.placeholder)}"`);
    // The box is the person's. An earlier version pre-filled it.
    expect(markup).not.toMatch(/<textarea[^>]*>[^<]/);
  });

  // RELEASE BLOCK #2, SECOND HALF, AND THE TEST THAT USED TO SAY IT WAS FINE.
  //
  // This read `expect(render("flow", "do-it")).toBe("")` and passed, and what
  // it was describing is the card rendering THE EMPTY STRING. That was
  // defensible while a job nobody chose was impossible: the server only plans
  // this card once `chat` is settled, and `chat` is settled by a recorded job
  // id. Then "Something else" made it the normal case. It calls
  // `reopenSetupStep("chat")`, `SetupChecklist.reopen` replaces the step with
  // `{ done: false }` and DROPS the note, so `chosenJob` returns null and
  // everybody who finished their first job and pressed the only control on
  // the screen landed on blank space.
  //
  // A card with no body is not a smaller card, it is a hole in a transcript.
  it("says where the question went rather than rendering nothing", async () => {
    const copy = FIRST_RUN_COPY.flow["do-it"];
    await machine({ ownerName: "Sean", steps: [{ id: "chat", done: false, status: "open" }] });
    const reopened = render("flow", "do-it");
    expect(reopened, "the do-it card rendered nothing after the step reopened").not.toBe("");
    expect(reopened).toContain(asHtml(copy.noJob));

    // ...including a note from a build that had other jobs in it, which is
    // the same fact arriving down a different road.
    await machine({ ownerName: "Sean", steps: [{ id: "chat", done: true, note: "phone", status: "done" }] });
    expect(render("flow", "do-it")).toContain(asHtml(copy.noJob));

    // And a machine nobody has read yet is a different sentence, because it
    // is a different fact: nothing has been chosen is not nothing is known.
    setupReply = {};
    forgetSetupView();
    await readSetupView(true);
    const unknown = render("flow", "do-it");
    expect(unknown, "the do-it card rendered nothing while the view was in flight").not.toBe("");
    expect(unknown).toContain(asHtml(copy.waiting));
  });
});

// NOT ONE CARD IN THE FLOW MAY RENDER NOTHING.
//
// Two shipped that did. `jobs` and `do-it` had no case in `firstRunCardBody`
// at all and drew literally nothing, and then `do-it` drew nothing again for
// everybody who pressed "Something else". Both were single cards found one at
// a time, after they shipped, which is what a sweep is for: the states below
// are the ones a card can actually be in, and every variant is put through
// all of them.
describe("no card in this flow can be reached and render nothing", () => {
  const STATES: Array<[string, Record<string, unknown>]> = [
    ["nothing known about the machine", {}],
    ["a blank machine, mid flow", { ownerName: "Sean", agents: [], signedOutAgents: [], nothingToThinkWith: true }],
    ["an engine, a key and two apps", {
      ownerName: "Sean",
      fluxReady: true,
      agents: [{ id: "claude", name: "Claude Code", installed: true }],
      connectedJobApps: ["gmail", "googlecalendar"],
      steps: [{ id: "chat", done: true, note: "brief", status: "done" }],
    }],
    ["the job chosen, then handed back", {
      ownerName: "Sean",
      fluxReady: true,
      connectedJobApps: [],
      steps: [{ id: "chat", done: false, status: "open" }],
    }],
  ];

  it("gives every variant a body in every state a person can be in", async () => {
    for (const [label, where] of STATES) {
      await machine(where);
      for (const variant of SETUP_CARD_VARIANTS) {
        for (const settled of [false, true]) {
          const markup = render(PARKED, variant, settled ? { settled: true } : {});
          // The words, not the elements: an empty body is still a div, and
          // that is exactly the shape the audit found.
          const words = markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
          expect.soft(words.length, `${variant} rendered nothing a person can read: ${label}, settled=${settled}`)
            .toBeGreaterThan(20);
        }
      }
    }
  });
});

describe("card four: the accounts", () => {
  const copy = FIRST_RUN_COPY.apps.apps;
  it("says why on every row", () => {
    const markup = render(PARKED, "apps");
    for (const row of copy.rows) {
      expect(markup).toContain(row.label);
      expect(markup).toContain(row.why);
    }
  });

  it("offers no Connect button until the surface is known to be the desktop", () => {
    // Undecided is not permission. A phone that showed a Connect button for
    // one frame has already shipped the bug.
    const markup = render(PARKED, "apps");
    expect(markup).toContain(copy.desktopOnly);
    expect(markup).not.toContain(`>${copy.connect}</button>`);
  });

  // The rendered half of the rule in first-run-copy.test.ts. This card is
  // where the person is actually asked for their mail account, so this is
  // where a promise about what happens to it lands on screen.
  //
  // It used to require, on screen, "Once you trust me with a kind of email,
  // I can send those myself". No such grant can exist: a remembered approval
  // is keyed by the whole tool name (`approvalKey`, server/auto-approve.ts)
  // and every connected-app call arrives through one wrapper tool, so
  // reading mail and sending it share one key. Asserting the sentence made
  // the sentence unfixable, so the assertion is the property: approval comes
  // before sending, and nothing narrower than one key is offered.
  it("puts email on graduated trust, and offers no grant the system cannot key", () => {
    const markup = render(PARKED, "apps");
    expect(markup).toContain(copy.trust);
    expect(markup).toMatch(/\byou approve\b/i);
    expect(markup).not.toMatch(/\b(?:kind|kinds|type|types|sort|sorts|categor\w+)\s+of\s+e-?mail/i);
    expect(markup).not.toMatch(/\bi (?:can|will|could) send (?:those|them|these)\b/i);
  });
});

describe("cards five and six: the brief", () => {
  const copy = FIRST_RUN_COPY.brief.brief;
  it("asks for one time and says it back on the button", async () => {
    // Rendered directly, because through the dispatch this card is PARKED and
    // arrives settled. The form is still real, tested work: it is held for
    // the owner's decision about where the morning brief goes, not deleted.
    const { FirstRunBriefCard } = await import("./FirstRunBriefCard");
    const markup = renderToStaticMarkup(createElement(FirstRunBriefCard, { settled: false }));
    expect(markup).toContain('type="time"');
    expect(markup).toContain('value="07:00"');
    expect(markup).toContain("Set my brief for 7:00 am");
    expect(markup).toContain(copy.weekdays);
  });

  it("points at the brief it has already run rather than promising one", () => {
    const markup = render(PARKED, "brief-ran");
    expect(markup).toContain(FIRST_RUN_COPY.brief["brief-ran"].body);
    expect(markup).toContain("From tomorrow it arrives on its own at 7:00 am.");
  });
});

describe("card seven: two more", () => {
  const copy = FIRST_RUN_COPY.routines["more-routines"];
  it("proposes exactly two and lets the watch one be aimed at something", () => {
    const markup = render(PARKED, "more-routines");
    for (const row of copy.rows) expect(markup).toContain(row.label);
    expect(markup).toContain("For example: anything from my accountant");
  });
});

describe("card eight: what shall we do", () => {
  const copy = FIRST_RUN_COPY.routines.next;
  it("offers work, a project, a job and the phone", () => {
    const markup = render(PARKED, "next");
    for (const offer of [...copy.work, ...copy.more]) expect(markup).toContain(offer.label);
    expect(markup).toContain("Hire your first teammate");
  });

  // The card used to assert that backups were "already running quietly in the
  // background". Nothing in the first run had turned them on, and nothing
  // could have: choosing a folder and writing a recovery key are things
  // Murage asks about. So the row reads the real schedule, and with no
  // desktop bridge, which is what a test has, it says NOTHING rather than
  // guessing. A claim about somebody's backups is the last claim to get wrong.
  it("says nothing about backups when it cannot see the schedule", () => {
    const markup = render(PARKED, "next");
    expect(markup).not.toContain(FIRST_RUN_COPY.backups.on);
    expect(markup).not.toContain(FIRST_RUN_COPY.backups.turnOn);
  });
});

// WHAT A 0.1.57 INSTALL CAUGHT MID-FIRST-RUN SEES.
//
// THE DEFECT: W16 cut six steps to five, so `SETUP_STATE_VERSION` went 2 to 3
// and the checklist resets. The OLD CARDS ARE STILL IN THAT PERSON'S
// TRANSCRIPT, and every one of them was built against a step that no longer
// exists. Their controls write through `PARKED_CARD_STEP`, which is `flow`:
// pressing "Not now" on last week's Gmail card would have settled the new
// flow's final step, and the brief card would have attached a routine to a
// step about something else entirely.
//
// The decision is that a parked card is HISTORY. The words stay exactly as
// they were, because that is what a transcript is for, and nothing on one can
// be pressed into a step it was never about.
describe("an upgrade that arrives mid-flow, with the old cards still in the thread", () => {
  /** Every control on these cards that writes to the checklist. */
  const WRITERS: Array<[string, string[]]> = [
    ["apps", [FIRST_RUN_COPY.apps.apps.connect, FIRST_RUN_COPY.apps.apps.dismiss]],
    ["brief", ["Set my brief for 7:00 am", FIRST_RUN_COPY.brief.brief.dismiss]],
    ["more-routines", [FIRST_RUN_COPY.routines["more-routines"].add, FIRST_RUN_COPY.routines["more-routines"].dismiss]],
    ["phone", [FIRST_RUN_COPY.phone.phone.dismiss]],
    ["phone-needs-tailscale", [FIRST_RUN_COPY.phone.phone.dismiss]],
  ];

  it("keeps every word and offers nothing that would settle a step", () => {
    for (const [variant, controls] of WRITERS) {
      const markup = render(PARKED, variant);
      expect(markup, `${variant} vanished instead of becoming history`).not.toBe("");
      for (const control of controls) {
        // Present but disabled is fine; a live button is not. The attribute,
        // not the word: every one of these carries `disabled:opacity-60` in
        // its class list, and a check that matched THAT would pass on a fully
        // live button and prove nothing.
        const live = new RegExp(`<button(?![^>]*\\sdisabled="")[^>]*>(?:<[^>]*>)*${control.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
        expect.soft(markup, `${variant} still offers "${control}"`).not.toMatch(live);
      }
    }
  });

  it("still says what it said at the time", () => {
    // The apps card's reasons, and the brief's own explanation, are the
    // record of what the person was told. Settling a card must not blank it.
    const apps = render(PARKED, "apps");
    for (const row of FIRST_RUN_COPY.apps.apps.rows) expect.soft(apps).toContain(row.why);
    expect(render(PARKED, "brief")).toContain(FIRST_RUN_COPY.brief.brief.body);
  });
});

describe("card nine: the phone", () => {
  it("never draws a QR code on a surface that cannot pair one", () => {
    // No desktop bridge in a test, which is exactly the shape of a machine
    // without Tailscale: words, and no dead button.
    for (const variant of ["phone", "phone-needs-tailscale"]) {
      const markup = render(PARKED, variant);
      expect.soft(markup, `${variant} drew a QR`).not.toContain("<svg");
      expect.soft(markup).toContain(FIRST_RUN_COPY.phone.phone.title);
    }
  });
});
