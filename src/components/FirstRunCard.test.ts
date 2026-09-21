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
const { readSetupView, forgetSetupView } = await import("./FirstRunChrome");
const { FIRST_RUN_COPY, firstRunAddress, greetingLine, lookedAroundLine } = await import("@/lib/first-run-copy");
const { setupCardKey } = await import("../../shared/setup-card");

/** Put a machine behind the cards. `renderToStaticMarkup` runs no effects, so
 *  the view has to be in the shared cache before the render, not after it. */
async function machine(view: Record<string, unknown>): Promise<void> {
  setupReply = { steps: [], agents: [], signedOutAgents: [], ownerName: "", ...view };
  forgetSetupView();
  await readSetupView(true);
}

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
    expect(copy.lead).toContain("how I reach you when you are away from this computer");
    expect(copy.submit).toBe("Continue");
    expect(copy.skip).toBe("Skip for now");
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

  // SKIPPING SETS THE NAME TO "there", AND IT SETS IT ON SCREEN ONLY.
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
  it("leads with routing, then the apps, then pictures and voice", () => {
    const markup = render("flux", "key");
    const routing = markup.indexOf(copy.body);
    const apps = markup.indexOf(copy.second);
    const media = markup.indexOf(copy.third);
    expect(routing).toBeGreaterThan(-1);
    expect(routing).toBeLessThan(apps);
    expect(apps).toBeLessThan(media);
    expect(markup).toContain(copy.recommendation);
  });

  it("takes the key in a password field and offers a way to get one", () => {
    const markup = render("flux", "key");
    expect(markup).toContain('type="password"');
    expect(markup).toContain(copy.signup);
    expect(markup).toContain(copy.dismiss);
  });

  it("says the not now card without a nudge to reconsider", () => {
    const markup = render("flux", "no-key");
    expect(markup).toContain(FIRST_RUN_COPY.flux["no-key"].body);
    expect(markup).toContain(FIRST_RUN_COPY.flux["no-key"].second);
    expect(markup).not.toContain(copy.submit);
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

  it("puts email on graduated trust rather than on a limit", () => {
    expect(render(PARKED, "apps")).toContain(copy.trust);
  });
});

describe("cards five and six: the brief", () => {
  const copy = FIRST_RUN_COPY.brief.brief;
  it("asks for one time and says it back on the button", () => {
    const markup = render(PARKED, "brief");
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
