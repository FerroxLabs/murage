import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The cards talk to the harness and to the store. Neither exists in a node
// test, and neither is what these tests are about: what is being checked is
// that the right card renders the right words and never renders a control
// that could not work.
vi.mock("@/state/store", () => ({
  api: async () => ({}),
  useStore: () => ({ state: {}, dispatch: () => {} }),
}));
vi.mock("@/lib/analytics", () => ({ identifyEmail: () => {}, setEmailGateDone: () => {} }));

const { FirstRunCard } = await import("./FirstRunCard");
const { FIRST_RUN_COPY } = await import("@/lib/first-run-copy");
const { setupCardKey } = await import("../../shared/setup-card");

type AnyMessage = Parameters<typeof FirstRunCard>[0]["message"];

const bot = { id: "chief", threadId: "thread-1", name: "Chief of Staff" } as Parameters<typeof FirstRunCard>[0]["bot"];

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
    expect(markup).toContain(copy.body);
    expect(markup).toContain(`aria-label="${copy.nameLabel}"`);
    expect(markup).toContain(`aria-label="${copy.emailLabel}"`);
    expect(markup).toContain(copy.skip);
    expect(markup).toContain(copy.detecting);
  });

  it("will not save until the email is one", () => {
    // The button is the only way to save and it starts disabled, so a typo
    // never reaches /api/config.
    expect(render("hello", "welcome")).toContain("disabled=\"\"");
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
    const markup = render("apps", "apps");
    for (const row of copy.rows) {
      expect(markup).toContain(row.label);
      expect(markup).toContain(row.why);
    }
  });

  it("offers no Connect button until the surface is known to be the desktop", () => {
    // Undecided is not permission. A phone that showed a Connect button for
    // one frame has already shipped the bug.
    const markup = render("apps", "apps");
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
    const markup = render("apps", "apps");
    expect(markup).toContain(copy.trust);
    expect(markup).toMatch(/\byou approve\b/i);
    expect(markup).not.toMatch(/\b(?:kind|kinds|type|types|sort|sorts|categor\w+)\s+of\s+e-?mail/i);
    expect(markup).not.toMatch(/\bi (?:can|will|could) send (?:those|them|these)\b/i);
  });
});

describe("cards five and six: the brief", () => {
  const copy = FIRST_RUN_COPY.brief.brief;
  it("asks for one time and says it back on the button", () => {
    const markup = render("brief", "brief");
    expect(markup).toContain('type="time"');
    expect(markup).toContain('value="07:00"');
    expect(markup).toContain("Set my brief for 7:00 am");
    expect(markup).toContain(copy.weekdays);
  });

  it("points at the brief it has already run rather than promising one", () => {
    const markup = render("brief", "brief-ran");
    expect(markup).toContain(FIRST_RUN_COPY.brief["brief-ran"].body);
    expect(markup).toContain("From tomorrow it arrives on its own at 7:00 am.");
  });
});

describe("card seven: two more", () => {
  const copy = FIRST_RUN_COPY.routines["more-routines"];
  it("proposes exactly two and lets the watch one be aimed at something", () => {
    const markup = render("routines", "more-routines");
    for (const row of copy.rows) expect(markup).toContain(row.label);
    expect(markup).toContain("For example: anything from my accountant");
  });
});

describe("card eight: what shall we do", () => {
  const copy = FIRST_RUN_COPY.routines.next;
  it("offers work, a project, a job and the phone", () => {
    const markup = render("routines", "next");
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
    const markup = render("routines", "next");
    expect(markup).not.toContain(FIRST_RUN_COPY.backups.on);
    expect(markup).not.toContain(FIRST_RUN_COPY.backups.turnOn);
  });
});

describe("card nine: the phone", () => {
  it("never draws a QR code on a surface that cannot pair one", () => {
    // No desktop bridge in a test, which is exactly the shape of a machine
    // without Tailscale: words, and no dead button.
    for (const variant of ["phone", "phone-needs-tailscale"]) {
      const markup = render("routines", variant);
      expect.soft(markup, `${variant} drew a QR`).not.toContain("<svg");
      expect.soft(markup).toContain(FIRST_RUN_COPY.phone.phone.title);
    }
  });
});
