// THE FIRST RUN WITH FLUX ROUTER ACTUALLY CONNECTED.
//
// Everything covered so far walks the SKIP path — `detect:skipped
// flux:skipped` — and on that path `nothingCanAnswer` is doing most of the
// work: every job needs Flux first, every row is tagged for it, and every
// press lands on the same connect screen. That is one world.
//
// The owner's real session was the OTHER world. `flux: "key proved"`, and
// from there the five rows stop agreeing with each other: two of them still
// want a Google account, three are ready, and the "2 to connect" state he hit
// only exists once Flux is live. Nothing had ever rendered it.
//
// WHY THIS NEEDS NO REAL KEY, AND SPENDS NOTHING.
//
// `fluxReady` on the setup view is `fluxUsable(live)` (shared/setup.ts), which
// is `configured && looksValid && !conflict`. All three are local:
// `fluxKeyLooksValid` is a SHAPE test — at least eight characters, no
// whitespace, no other provider's prefix — and it says so in its own comment
// ("Shape only. It says the field holds a key rather than a pasted sentence,
// never that the key is live"). No route is called to decide it and no token
// is bought by it. So a fabricated, obviously-fake key of the right shape puts
// the server in exactly the state a paid key puts it in, for every question
// this file asks.
//
// The saving road is the product's own. `saveFluxKey` (src/lib/flux-key-paste.ts)
// posts `{action, revision, key}` to `POST /api/flux-connection/mutate` in a
// build with no desktop bridge, which is precisely this harness, so what runs
// below is the browser build's real save and not a back door. What this file
// deliberately does NOT do is call `POST /api/flux-connection/test`, which is
// the half of `saveAndProveFluxKey` that leaves the machine.
//
// THE FOUR CUSTOMER RULES ARE THE ONES FROM `first-run-every-path`, and so are
// `clippedText`, `chiefHasSpoken` and the `test.use` app override. They are
// copied rather than imported because that file is a spec, not a module; each
// copy that matters is re-proved by a negative control at the bottom of this
// file.
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { HARNESS_URL, desktopHeaders } from "./rig";

/** The five ways to start, by the label a person reads. */
const BRIEF = "Brief me every morning";
const DAY = "Organise my day";
const NOTES = "Make sense of these notes";
const RESEARCH = "Look into something for me";
const BUSINESS = "Help me run my business";

/**
 * A KEY THAT IS NOT A KEY, AND COULD NOT BE MISTAKEN FOR ONE.
 *
 * It satisfies both gates that decide `fluxReady` and nothing else:
 * `assertProviderKey` (eight characters or more, and not another provider's
 * prefix) and `fluxKeyLooksValid` (the same, plus no whitespace). It is
 * deliberately far SHORTER than anything Flux Router issues — the same
 * spelling the electron fixtures use, `sk-flux-FAKE_ONLY` and friends — so it
 * is not credential-shaped, does not trip the secret scan, and could not be
 * confused for a live key by anybody reading a log.
 *
 * The owner's real capped key is never read by this file, never copied to the
 * box and never needed: see the header.
 */
const FAKE_FLUX_KEY = "sk-flux-E2E-FAKE-KEY";

// ── the words the screens are made of, quoted from FIRST_RUN_COPY ──────

/** The Chief's opening when a key is routing. Only `chiefState === "connected"`
 *  is allowed to say something is running. */
const CONNECTED_STATUS = "Connected. Smart routing on, and your apps are a click away when a job needs them.";

/** The two sentences that exist ONLY on the connect screen, so "is this job
 *  asking for a connection" can be answered without scoping past the jobs card
 *  that is still sitting above it in the transcript. */
const CONNECT_HEADING_TAIL = /and then I can do it\./;
const CONNECT_LEAD = "Everything this job needs is on this screen. Nothing else gets asked, and you can stop after any of them.";
const CONNECT_SKIP = "Skip that and let me type it in instead";
const ELSEWHERE = "Something else";
const AGAIN = "Take something else off my plate";

/**
 * The reason written on each connect row, and the ONLY safe way to ask
 * whether a row is on screen.
 *
 * "Gmail" and "Flux Router" are the row's bold, and they are also words this
 * app says in a model picker, a settings pane and the Chief's own earlier
 * cards — a page-wide `getByText("Flux Router", { exact: true })` found two
 * of them on a connect screen that was asking for neither. A reason sentence
 * is written for one row of one screen and appears nowhere else, so it
 * answers the question that was actually being asked.
 */
const FLUX_REASON = "your apps run through it, and it picks the right model for this job";
const GMAIL_REASON = "so I can see what came in overnight and who is waiting.";
const CALENDAR_REASON = "so I know what is already fixed in your day.";

/** The row that carries one of those reasons, so the bold beside it can be
 *  read without leaving the connect screen. */
const connectRow = (app: Page, reason: string) => app.locator("li", { hasText: reason });

/**
 * THE TAGS THIS MACHINE MUST SHOW ONCE FLUX IS CONNECTED.
 *
 * Written out as literals rather than computed from `first-run-jobs.ts`,
 * because a test that asks the rule what the rule says proves only that the
 * rule is deterministic. These are what a person reads, and they are right for
 * a machine with a key and no Google account attached — which the test asserts
 * against the server's own view before it trusts them.
 */
const CONNECTED_TAGS: ReadonlyArray<readonly [string, string]> = [
  // Calendar and Gmail, neither connected, and Flux no longer in the list.
  [BRIEF, "2 to connect"],
  // One thing missing is NAMED. Two or more is counted; that difference is
  // the whole point of `jobTag`.
  [DAY, "connect Google Calendar"],
  [NOTES, "ready now"],
  [RESEARCH, "ready now"],
  [BUSINESS, "ready now"],
];

// ── the rig ────────────────────────────────────────────────────────────

async function harness(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${HARNESS_URL}${path}`, {
    method,
    headers: { ...(await desktopHeaders()), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const setupView = () => harness("GET", "/api/setup");
const stepOf = (view: any, id: string) => view.steps.find((entry: { id: string }) => entry.id === id);

/**
 * Anything with a box that ends past the right edge of the document.
 *
 * COPIED WHOLE FROM `first-run-every-path`, INCLUDING THE REASON IT LOOKS
 * LIKE THIS. An earlier version walked ELEMENTS and skipped any with
 * children, so every sentence containing a bolded word or a link — which is
 * all real prose — was skipped, and it went green at three widths on a
 * release with photographed clipping. A Range over a TEXT NODE reports the
 * rectangles the browser actually painted, one per wrapped line, which is
 * what a reader's eye lands on. The bait at the bottom of this file proves
 * THIS copy still sees prose with markup in it.
 *
 * ONE THING IS SKIPPED HERE THAT `first-run-every-path` DOES NOT SKIP, AND IT
 * IS A FALSE ALARM THAT FILE HAS NEVER BEEN IN A POSITION TO HIT. See the
 * comment on the parent box below.
 */
async function clippedText(app: Page): Promise<Array<{ text: string; right: number; limit: number }>> {
  return app.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const found: Array<{ text: string; right: number; limit: number }> = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      if (text.length < 12) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const style = window.getComputedStyle(parent);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
      // VISUALLY HIDDEN TEXT IS NOT CLIPPED TEXT.
      //
      // Tailwind's `sr-only` is `position:absolute;width:1px;height:1px;
      // overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap`, so the TEXT
      // inside lays out at its natural width in a one-pixel box and a Range
      // over it reports a rectangle tens of pixels wide — past the right edge
      // whenever the control it labels sits near one. NOTHING IS PAINTED
      // THERE: the browser clipped it away before anybody could read it,
      // which is the entire purpose of the idiom.
      //
      // The first thing this file hit was exactly that — PushToTalk's
      // "Hold to talk", right 1488 in a 1440 viewport. The skip-path spec has
      // never seen it because that button only renders once something can
      // answer, and on `flux:skipped` with a blank machine nothing can. So
      // this is a false alarm in the shared check that only the connected
      // world can reach, not a defect in the app.
      //
      // The test is the PARENT'S OWN PAINTED BOX, not a class name: an
      // element one pixel across is not showing anybody a sentence. Real
      // prose lives in a parent at least as wide as one line of it, so this
      // cannot hide the clipping the check exists for — the bait at the
      // bottom of this file is prose in a full-width parent and still screams.
      const box = parent.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right > limit + 1) {
          found.push({ text: text.slice(0, 80), right: Math.round(rect.right), limit });
          break;
        }
      }
    }
    return found.slice(0, 8);
  });
}

/** Controls a person can actually operate right now. */
function liveControls(app: Page) {
  return app.locator(
    "button:not([disabled]):visible, a[href]:visible, input:not([disabled]):visible, textarea:not([disabled]):visible",
  );
}

/** The four customer rules, applied to whatever is on screen. */
async function screenIsUsable(app: Page, where: string): Promise<void> {
  const live = await liveControls(app).count();
  expect(live, `${where}: no enabled control — this is a dead end`).toBeGreaterThan(0);

  const readable = ((await app.locator("main, [role=main], body").first().innerText()) ?? "").trim();
  expect(readable.length, `${where}: under twenty readable characters on screen`).toBeGreaterThan(20);

  const clipped = await clippedText(app);
  expect(clipped, `${where}: text runs past the right edge — ${JSON.stringify(clipped)}`).toEqual([]);
}

/**
 * THE CHIEF HAS TO EXIST BEFORE HE CAN BE DRIVEN.
 *
 * He is created by the RENDERER's first `GET /api/setup`. Posting answers in
 * the moment after `goto` returns beats that first poll: the checklist
 * advances against a workspace with no Chief in it, no card is ever said, and
 * the transcript stays empty for ever. A person cannot hit that — you cannot
 * answer a card that was never drawn — but a spec can, and on screen it is
 * indistinguishable from a flow that never arrived.
 */
async function chiefHasSpoken(app: Page): Promise<void> {
  await expect(
    app.getByText(/who am I working for/i),
    "the Chief must have asked before the checklist is driven",
  ).toBeVisible();
}

// ── Flux, connected and disconnected, through the product's own route ──

const fluxStatus = () => harness("GET", "/api/flux-connection");

/** Save the fabricated key the way the browser build saves a real one. */
async function connectFlux(): Promise<void> {
  const status = await fluxStatus();
  if (status.configured) return;
  await harness("POST", "/api/flux-connection/mutate", {
    action: "connect",
    revision: status.revision,
    key: FAKE_FLUX_KEY,
  });
}

/** Put the harness back as it was found. One store serves every first-run
 *  spec in this config, and a key left behind would quietly re-write the
 *  world the skip-path specs are about. */
async function disconnectFlux(): Promise<void> {
  const status = await fluxStatus();
  if (!status.configured) return;
  await harness("POST", "/api/flux-connection/mutate", { action: "disconnect", revision: status.revision });
}

/**
 * Walk the checklist to the Chief's question, with Flux either saved or not.
 *
 * `flux` is never SKIPPED on the connected road: `setupStepDone` decides that
 * step from live state, so a usable key settles it by itself, which is what
 * happens to a person who pastes one.
 */
async function reachTheJobs(flux: "connected" | "none"): Promise<void> {
  await harness("POST", "/api/setup/answer", { step: "hello", answer: "E2E Owner, e2e@example.invalid" });
  if (!stepOf(await setupView(), "detect")?.done) await harness("POST", "/api/setup/skip", { step: "detect" });
  if (flux === "connected") {
    await connectFlux();
  } else {
    await disconnectFlux();
    if (!stepOf(await setupView(), "flux")?.done) await harness("POST", "/api/setup/skip", { step: "flux" });
  }
  if (stepOf(await setupView(), "chat").done) await harness("POST", "/api/setup/reopen", { step: "chat" });
}

/**
 * The server really is in the world these expectations were written for.
 *
 * Without this the tag literals below would be a guess. With it they are a
 * statement about a machine whose state has been read: a key is routing, and
 * neither Google account is attached.
 */
async function expectConnectedWorld(): Promise<any> {
  const view = await setupView();
  expect(view.fluxReady, "the saved key must leave the server reporting Flux as ready").toBe(true);
  expect(
    view.connectedJobApps,
    "this rig has no connector broker, so the two job apps must read as attached-to-nothing rather than unknown",
  ).toEqual([]);
  expect(stepOf(view, "flux").done, "a usable key settles the flux step without anybody skipping it").toBe(true);
  return view;
}

/** The tag on one job row, read as the person reads it: the second of the
 *  row's two spans. A row with one span has no tag at all, which is the state
 *  the card is in before the view lands and is never acceptable here. */
async function tagOf(app: Page, job: string): Promise<string> {
  const row = app.getByRole("button", { name: new RegExp(job, "i") });
  const spans = row.locator(":scope > span");
  await expect(spans, `${job}: the row must carry a live tag, not arrive untagged`).toHaveCount(2);
  return (await spans.last().innerText()).trim();
}

/**
 * EVERY ROW SAYS WHAT THAT JOB IS STILL WAITING ON.
 *
 * Extracted so the negative control can hand it the SKIP world and watch it
 * scream. A checker that only ever runs against the state it was written for
 * has never been shown to be reading anything.
 */
async function assertConnectedWorldTags(app: Page): Promise<void> {
  for (const [job, expected] of CONNECTED_TAGS) {
    expect(await tagOf(app, job), `${job}: the tag must say what this job still needs, with Flux connected`).toBe(expected);
  }
}

/**
 * THIS SCREEN IS NOT ASKING FOR A CONNECTION.
 *
 * Both sentences are unique to `FirstRunConnectView`, so this is indifferent
 * to the jobs card still sitting above it in the transcript with "connect
 * Google Calendar" written on one of its rows.
 */
async function assertNoConnectAsk(app: Page, where: string): Promise<void> {
  await expect(
    app.getByText(CONNECT_HEADING_TAIL),
    `${where}: a job with nothing missing must not open the connect screen`,
  ).toHaveCount(0);
  await expect(
    app.getByText(CONNECT_LEAD),
    `${where}: a job with nothing missing must not lead with the connect screen's lead`,
  ).toHaveCount(0);
}

/** Choosing a job, and waiting for the server to have heard it. */
async function choose(app: Page, job: string): Promise<void> {
  const row = app.getByRole("button", { name: new RegExp(job, "i") });
  await expect(row, `${job}: the row must arrive pressable`).toBeEnabled();
  await row.click();
  await expect
    .poll(async () => stepOf(await setupView(), "chat").done, { message: `${job}: choosing it must reach the server` })
    .toBe(true);
}

/** Hand a check the thing it exists to catch, and prove it screams. */
async function screams(what: () => Promise<unknown>, why: string): Promise<void> {
  let threw = false;
  try {
    await what();
  } catch {
    threw = true;
  }
  expect(threw, why).toBe(true);
}

// Listeners armed BEFORE the first navigation. The `app` fixture navigates
// during fixture setup, so a spec that attaches `pageerror` in its own body is
// blind to a crash on mount — the failure it most needs to see.
test.use({
  app: async ({ page }, use) => {
    page.on("pageerror", (error) => console.error(`PAGE ERROR: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") console.error(`CONSOLE ERROR: ${message.text().slice(0, 300)}`);
    });
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("murage-email-gate", "skipped");
      } catch {
        /* storage blocked — the gate just renders */
      }
    });
    await page.goto("/");
    await use(page);
  },
});

/**
 * PUT THE HARNESS BACK THE WAY IT WAS FOUND.
 *
 * One store and one harness serve every `first-run-*` spec in this config,
 * and they run in file order in a single worker. This file is the only one
 * that saves a key, and the only one that leaves the Chief's question
 * ANSWERED at the end — `first-run-jobs-latch` walks the checklist and then
 * asserts `chat` is still open, so both of those have to be undone or the
 * next file fails on a state this one wrote. Caught by running the whole
 * config rather than this file alone, which is the only way that class of
 * damage shows up.
 */
test.afterAll(async () => {
  await disconnectFlux();
  if (stepOf(await setupView(), "chat").done) await harness("POST", "/api/setup/reopen", { step: "chat" });
});

test.describe("the first run with Flux Router connected", () => {
  test("the Chief says a key is routing, and every row is tagged for what that job still needs", async ({ app }) => {
    await chiefHasSpoken(app);
    await reachTheJobs("connected");
    const view = await expectConnectedWorld();
    // The machine these expectations ran against, in the log, because "2 to
    // connect" is only the right answer on a machine with no Google account
    // attached and `nothingCanAnswer` is what decides three of the five rows
    // on the other road.
    console.info(
      `WORLD: fluxReady=${view.fluxReady} nothingToThinkWith=${view.nothingToThinkWith}`
      + ` nothingCanAnswer=${view.nothingCanAnswer} connectedJobApps=${JSON.stringify(view.connectedJobApps)}`
      + ` steps=${view.steps.map((s: any) => `${s.id}:${s.done ? "done" : s.skipped ? "skipped" : "open"}`).join(" ")}`,
    );
    await app.reload();

    await expect(app.getByText(CONNECTED_STATUS), "the connected opening is the only one allowed to say something is running").toBeVisible();
    await assertConnectedWorldTags(app);
    await screenIsUsable(app, "Flux connected · the Chief's question");
  });

  // ── the two jobs that reach for a Google account ─────────────────────

  test(`"${BRIEF}" names both accounts it needs, and lets a customer back out`, async ({ app }) => {
    await chiefHasSpoken(app);
    await reachTheJobs("connected");
    await expectConnectedWorld();
    await app.reload();

    expect(await tagOf(app, BRIEF), "the brief still wants mail and calendar once Flux is connected").toBe("2 to connect");
    await choose(app, BRIEF);

    // TWO, AND THE HEADING COUNTS THEM. Flux is NOT among them: a key is
    // saved, so the row that would have asked for one is gone, which is the
    // whole difference this file exists to cover.
    await expect(app.getByText("2 things, and then I can do it."), "the heading must count what is really left").toBeVisible();
    await expect(app.getByText(CONNECT_LEAD)).toBeVisible();
    await expect(
      connectRow(app, GMAIL_REASON).getByText("Gmail", { exact: true }),
      "the row must name Gmail, and say why it wants the mailbox",
    ).toBeVisible();
    await expect(
      connectRow(app, CALENDAR_REASON).getByText("Google Calendar", { exact: true }),
      "and name Google Calendar, and say why it wants the calendar",
    ).toBeVisible();
    await expect(
      connectRow(app, FLUX_REASON),
      "Flux is connected, so it must not be asked for again",
    ).toHaveCount(0);
    await screenIsUsable(app, `${BRIEF}: the connect screen`);

    // ACT ON IT, OR BACK OUT. Both have to be here: the sign-in itself opens
    // a browser window this surface may not be able to open, and a screen
    // whose only offer is one it cannot make is the dead end this file's
    // first rule is about.
    await expect(app.getByRole("button", { name: CONNECT_SKIP }), "there must be a way to type it in instead").toBeEnabled();
    await app.getByRole("button", { name: ELSEWHERE }).click();
    await expect
      .poll(async () => stepOf(await setupView(), "chat").done, { message: "Something else must reopen the question" })
      .toBe(false);
    await expect(app.getByRole("button", { name: new RegExp(BRIEF, "i") }), "and the rows must come back alive").toBeEnabled();
    await screenIsUsable(app, `${BRIEF}: back at the Chief's question`);
  });

  test(`"${DAY}" asks for the calendar alone, and not for the mailbox`, async ({ app }) => {
    await chiefHasSpoken(app);
    await reachTheJobs("connected");
    await expectConnectedWorld();
    await app.reload();

    // ONE MISSING THING IS NAMED, NOT COUNTED. That is `jobTag`'s own rule
    // and it is the difference between a row a person can decide about and a
    // row they have to press to find out about.
    expect(await tagOf(app, DAY), "one missing thing is named on the row").toBe("connect Google Calendar");
    await choose(app, DAY);

    await expect(app.getByText("One thing, and then I can do it."), "one thing, said as one thing").toBeVisible();
    await expect(connectRow(app, CALENDAR_REASON).getByText("Google Calendar", { exact: true })).toBeVisible();
    await expect(
      connectRow(app, GMAIL_REASON),
      "organising a day never reaches for the mailbox, so it must not ask for it",
    ).toHaveCount(0);
    await expect(connectRow(app, FLUX_REASON), "and Flux is already connected").toHaveCount(0);
    await screenIsUsable(app, `${DAY}: the connect screen`);

    await expect(app.getByRole("button", { name: CONNECT_SKIP })).toBeEnabled();
    await app.getByRole("button", { name: ELSEWHERE }).click();
    await expect.poll(async () => stepOf(await setupView(), "chat").done).toBe(false);
    await expect(app.getByRole("button", { name: new RegExp(DAY, "i") })).toBeEnabled();
    await screenIsUsable(app, `${DAY}: back at the Chief's question`);
  });

  // ── the three whose needs are already met ────────────────────────────

  // The heading is said TWICE on these screens — once as the visible line and
  // once as the box's own `sr-only` label — so it is the LEAD that says which
  // screen this is, and the box is found by the name that labels it. That
  // also settles which textbox: the chat composer is on the page too, and a
  // bare `getByRole("textbox")` is two elements on every one of these screens.
  for (const [job, heading, lead] of [
    [NOTES, "Paste the notes.", "Anything at all. Meeting scrawl, a wall of messages, half a plan."],
    [RESEARCH, "What should I look into?", "One line is enough. I will tell you what I find and what I could not confirm."],
  ] as const) {
    test(`"${job}" opens its own box and asks for nothing it already has`, async ({ app }) => {
      await chiefHasSpoken(app);
      await reachTheJobs("connected");
      await expectConnectedWorld();
      await app.reload();

      expect(await tagOf(app, job), `${job}: nothing is missing, so the row says so`).toBe("ready now");
      await choose(app, job);

      await expect(app.getByText(lead), `${job}: it must land on its own box`).toBeVisible();
      await assertNoConnectAsk(app, job);
      await expect(app.getByRole("textbox", { name: heading }), `${job}: the box must be typeable`).toBeEditable();
      await screenIsUsable(app, `${job}: the box`);

      await app.getByRole("button", { name: ELSEWHERE }).click();
      await expect.poll(async () => stepOf(await setupView(), "chat").done).toBe(false);
      await expect(app.getByRole("button", { name: new RegExp(job, "i") })).toBeEnabled();
      await screenIsUsable(app, `${job}: back at the Chief's question`);
    });
  }

  test(`"${BUSINESS}" goes straight to the work, and the wait ends somewhere a person can act`, async ({ app }) => {
    await chiefHasSpoken(app);
    await reachTheJobs("connected");
    await expectConnectedWorld();
    await app.reload();

    expect(await tagOf(app, BUSINESS), "the one job with no box and nothing to connect is simply ready").toBe("ready now");
    await choose(app, BUSINESS);

    // THE ONE SCREEN IN THIS FLOW WITH NOTHING TO PRESS, AND IT IS ALLOWED
    // TO BE — for as long as it takes the crew to install, and no longer.
    // What is asserted is that the wait ENDS: `FirstRunWorkingView` has no
    // control in it at all, so a working stage that never resolved would be
    // the dead end rule 1 is about, dressed as progress.
    await expect(
      app.getByRole("button", { name: AGAIN }),
      "the counted lines must give way to a screen a person can leave",
    ).toBeVisible({ timeout: 45_000 });
    await assertNoConnectAsk(app, BUSINESS);
    await screenIsUsable(app, `${BUSINESS}: the screen the work lands on`);

    await app.getByRole("button", { name: AGAIN }).click();
    await expect.poll(async () => stepOf(await setupView(), "chat").done).toBe(false);
    await expect(app.getByRole("button", { name: new RegExp(BUSINESS, "i") })).toBeEnabled();
    await screenIsUsable(app, `${BUSINESS}: back at the Chief's question`);
  });
});

// ── NEGATIVE CONTROLS ──────────────────────────────────────────────────
//
// A CHECK THAT CANNOT FAIL IS WORSE THAN NO CHECK. Every checker above is
// handed the exact thing it exists to catch, and has to scream. Three of the
// four failed to scream the first time they were written, which is the only
// reason this block is trusted at all.

test.describe("the checks in this file can fail", () => {
  test("the tag reader can tell the connected world from the skip world", async ({ app }) => {
    await chiefHasSpoken(app);
    await reachTheJobs("none");
    const view = await setupView();
    expect(view.fluxReady, "the control needs Flux genuinely off").toBe(false);
    await app.reload();

    // THE SCREAM. Every literal in CONNECTED_TAGS is wrong on this machine,
    // so a reader that was quietly returning something constant — or reading
    // the wrong span, or the copy rather than the state — passes here and is
    // exposed by it.
    await screams(
      () => assertConnectedWorldTags(app),
      "the connected-world tags were accepted on a machine with no key: the tag reader is not reading state",
    );

    // And the skip world's own answers, on the two rows whose tag differs
    // between the worlds whatever engines this computer happens to have.
    // `brief` and `day` both mark Flux `required`, so they carry it in their
    // missing list here and cannot carry it once a key is saved.
    expect(await tagOf(app, BRIEF), "with no key, the brief is waiting on three things").toBe("3 to connect");
    expect(await tagOf(app, DAY), "and the day on two").toBe("2 to connect");

    // THE OTHER SCREAM. Every connected-world test asserts that the Flux
    // connect row is NOT there, and a locator that can never match anything
    // makes all of them free. Here it has to match: same locator, same page,
    // a machine with no key.
    await choose(app, BRIEF);
    const flux = connectRow(app, FLUX_REASON);
    await expect(flux, "with no key, the brief's connect screen must ask for Flux Router").toHaveCount(1);
    await expect(flux.getByText("Flux Router", { exact: true }), "and name it").toBeVisible();

    await connectFlux();
    await expectConnectedWorld();
  });

  test("the connect-screen check catches a screen that IS asking for a connection", async ({ app }) => {
    await chiefHasSpoken(app);
    await reachTheJobs("connected");
    await expectConnectedWorld();
    await app.reload();

    await choose(app, BRIEF);
    await expect(app.getByText("2 things, and then I can do it.")).toBeVisible();
    await screams(
      () => assertNoConnectAsk(app, BRIEF),
      "the connect screen was reported as not asking for a connection — the sentences it keys on have moved",
    );
  });

  test("the clipping check still sees clipped prose once it contains markup", async ({ app }) => {
    await chiefHasSpoken(app);
    // THE LESSON IN THE BAIT. Clipping is TEXT whose own painted line box
    // crosses the right edge, not a wide container, so the bait starts near
    // that edge and runs past it — and it carries a <strong>, because the
    // version of this check that skipped nodes with children was blind to
    // every sentence in the product.
    await app.evaluate((sentence) => {
      const paragraph = document.createElement("p");
      paragraph.style.cssText = `position:fixed;top:40px;left:${document.documentElement.clientWidth - 60}px;white-space:nowrap;z-index:99999`;
      paragraph.append(
        document.createTextNode(sentence),
        Object.assign(document.createElement("strong"), { textContent: " and it carries markup." }),
      );
      document.body.appendChild(paragraph);
    }, "This sentence begins near the right edge and runs past it, which is what clipping actually is.");
    const found = await clippedText(app);
    expect(found.length, "this file's copy of the clipping check cannot see clipped prose with markup in it").toBeGreaterThan(0);
    expect(
      found.map((entry) => entry.text).join(" | "),
      "the bait is what was caught, not something else that happened to be on the page",
    ).toContain("This sentence begins near the right edge");
  });

  // THE OTHER HALF OF THAT SKIP. The rule added above must be NARROW: it has
  // to drop the screen-reader label and keep the sentence, on the same page,
  // in the same call. A rule that dropped both would turn this whole file
  // green by going blind, which is the failure it was written against.
  test("the visually hidden skip drops a screen-reader label and keeps real prose", async ({ app }) => {
    await chiefHasSpoken(app);
    await app.evaluate((sentence) => {
      const left = document.documentElement.clientWidth - 60;
      // Tailwind's own sr-only declaration, written out so this control does
      // not depend on the utility surviving a build.
      const hidden = document.createElement("span");
      hidden.textContent = "a screen reader label that nobody can see";
      hidden.style.cssText = `position:fixed;top:80px;left:${left}px;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;z-index:99999`;
      const visible = document.createElement("p");
      visible.textContent = sentence;
      visible.style.cssText = `position:fixed;top:120px;left:${left}px;white-space:nowrap;z-index:99999`;
      document.body.append(hidden, visible);
    }, "This sentence begins near the right edge and runs past it, which is what clipping actually is.");
    const found = (await clippedText(app)).map((entry) => entry.text).join(" | ");
    expect(found, "the visible sentence must still be caught").toContain("This sentence begins near the right edge");
    expect(found, "a one-pixel screen-reader label is not text a customer can read past the edge").not.toContain("screen reader label");
  });

  test("the dead-end check catches a screen with nothing left to press", async ({ app }) => {
    await chiefHasSpoken(app);
    await screenIsUsable(app, "the live page, before anything is taken away");
    await app.evaluate(() => {
      for (const element of Array.from(document.querySelectorAll("button, input, textarea, select"))) {
        (element as HTMLButtonElement).disabled = true;
      }
      for (const element of Array.from(document.querySelectorAll("a[href]"))) element.removeAttribute("href");
    });
    await screams(
      () => screenIsUsable(app, "a page with every control disabled"),
      "a screen with no operable control passed the dead-end rule",
    );
  });
});
