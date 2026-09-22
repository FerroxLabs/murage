// THE FIRST RUN, JUDGED ON THE MACHINE IT IS ACTUALLY RUNNING ON.
//
// `first-run-every-path.human.spec.ts` walks every way THROUGH the flow on
// one machine. This file walks the same flow across the MACHINES, because the
// release block in this cycle was not on a path — it was on a state.
//
// WHAT HAPPENED. A computer with nothing installed could not leave the Flux
// screen. The step planned `bare-needs-key`, a card of two sentences and no
// control, while `FirstRunFluxCard` — the only card in the flow with a box
// that takes a key and the only `skipSetupStep("flux")` — was shown only to
// machines that did NOT need a key. 353 first-run tests were green
// throughout, because a test that checks a fix cannot see a fix that is
// unreachable: every one of them ran on a machine with a working engine.
//
// So the axis here is the MACHINE, and the three that matter are:
//
//   1. SOMETHING THAT IS HERE AND SIGNED OUT. `signedOutAgents` is non-empty
//      while `agents` is empty: `nothingToThinkWith` is FALSE, so this
//      machine goes through detection, and `nothingCanAnswer` is TRUE, so
//      nothing on it can actually reply.
//   2. SOMETHING THAT CAN ANSWER. The five-step path, with the detection
//      report actually written, and read.
//   3. NOTHING. No engine that can think, nobody signed in to anything.
//      `nothingToThinkWith` is true, `detect` settles before it is ever
//      presented, and the person sees four phases instead of five. This is
//      the machine the release was written for.
//
// THEY RUN IN THAT ORDER AND THE ORDER IS LOAD-BEARING, because one harness
// serves the whole file and `detect` is the one LATCHED step. The moment it
// is settled — by a blank machine, or by somebody pressing "Show me the
// interesting part" on the report — `deriveSetupState` stamps
// `latched: true` into setup.json and no detection report is ever owed
// again, on any machine, for the life of that workspace. So the case that
// only READS a report goes first, the case that ANSWERS one goes second, and
// the machine that settles the step by being empty goes last. Both orderings
// have already been got wrong here, and both times it looked like a product
// defect rather than a spec one.
//
// HOW THE MACHINE IS ARRANGED, AND WHY NOTHING HERE IS STUBBED.
//
// `setup-blocked.config.ts` sets the rule: nothing stubs a route, and the
// setup routes are driven exactly as the app drives them. Same here, with the
// one difference that this file may not add a config, so it arranges the
// machine through the app's OWN desktop routes instead of at boot:
//
//   · `PATCH /api/instances/:id {enabled:false}` is the Engines settings
//     toggle. It rewrites config.json, reloads the providers and re-probes,
//     so `registry.describe()` then reports exactly what it reports on a
//     computer with nothing on it: no instance that is enabled AND available
//     AND carrying a non-empty `models.default`. `runnable()` (server/setup.ts)
//     is the one predicate, `live.agents` is already filtered by it, and
//     `nothingToThinkWith` reads off that. The view a blank machine produces
//     and the view this produces are the same view, field for field, because
//     every step is re-derived from live state on every read.
//   · `PATCH /api/instances/:id {cli}` is the engine-path field in the same
//     panel, and it takes a wrapper with fixed arguments (`resolveCliSpawn`,
//     server/env-path.ts). Pointing it at a one-line wrapper that runs the
//     suite's own `fake-claude-cli.ts` with `FAKE_CLAUDE_AUTH=out` makes the
//     REAL driver run its REAL sign-in probe (`claudeSignedIn`, which parses
//     `auth status --json`) and be told no. `signedOut()` then moves that
//     engine out of `agents` and into `signedOutAgents` on the server. The
//     spec writes the wrapper and reads the answer; it does not write the
//     answer.
//
// WHAT IS NOT COVERED, SAID PLAINLY RATHER THAN FAKED. A machine whose engine
// is a LOCAL MODEL cannot be arranged from a spec on this rig. `localModelOf`
// needs an instance whose `models.default` decodes as `host::model`; a
// claudeAgent's default is its static catalogue's, `mergeLocalInject` only
// ever appends OPTIONS and returns `catalog.default` untouched, and the one
// driver that promotes a local model to default when it has no key
// (openai-compat, `withLocal`) has no instance on this rig and no route that
// could add one — instances come from `config.json`, which is the harness
// fixture and not this file's to edit. Case 2 below is therefore the
// five-step path with a cloud engine that can answer, which is what this rig
// can honestly reach, and the local-model naming of a detection row
// (`engineRowTitle`) is left to `first-run-detect`'s unit tests.
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { HARNESS_URL, REPO_ROOT, desktopHeaders } from "./rig";

async function harness(method: string, path: string, body?: unknown): Promise<any> {
  // A provider mutation that lands while another is still settling answers
  // 409 by design (`providerConfigBusy`, server/index.ts). That is the engine
  // panel's own back-pressure and not a failure, so it is waited out rather
  // than thrown — anything else is reported with its body, because "PATCH
  // failed" is not a diagnosis.
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${HARNESS_URL}${path}`, {
      method,
      headers: {
        ...(await desktopHeaders()),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (response.status === 409 && attempt < 20) {
      await new Promise((settle) => setTimeout(settle, 500));
      continue;
    }
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
}

const stepOf = (view: any, id: string) => view.steps.find((entry: { id: string }) => entry.id === id);

// ── the four customer rules ────────────────────────────────────────────
// Lifted from first-run-every-path.human.spec.ts, including the comment that
// records why `clippedText` measures TEXT RANGES. Repeated rather than
// imported on purpose: a helper shared between two human specs is a helper
// two specs can silently change for each other, and this one earned its shape
// by being wrong first. The bait controls at the foot of THIS file prove this
// copy still screams.

/**
 * Anything with a box that ends past the right edge of the document.
 *
 * MEASURE THE LINE BOXES, NOT THE ELEMENTS. The first version of this check
 * walked elements and skipped any with children, to avoid measuring a wrapper
 * instead of its prose — but ALL REAL PROSE HAS MARKUP IN IT, so every
 * sentence worth checking was skipped. A Range over a TEXT NODE reports the
 * rectangles the browser actually painted, one per wrapped line, which is
 * what a reader's eye lands on.
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

/** A live control, something to read, and nothing off the right edge. */
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
 * the moment after `goto` returns beats that first poll, the checklist
 * advances against a workspace with no Chief in it, and the transcript stays
 * empty for ever.
 */
async function chiefHasSpoken(app: Page): Promise<void> {
  await expect(
    app.getByText(/who am I working for/i),
    "the Chief must have asked before the checklist is driven",
  ).toBeVisible();
}

/** Is this sentence on screen at all? Used both ways round, and controlled
 *  both ways round in "the claim detector reads the screen". */
async function screenSays(app: Page, pattern: RegExp): Promise<boolean> {
  return (await app.locator("body").innerText()).search(pattern) >= 0;
}

/**
 * The phases a person can actually read, off the bar itself.
 *
 * Read from the DOM rather than recomputed from `view.steps`, because the
 * five-becomes-four rule lives in `firstRunPhaseRows` and a spec that applied
 * the rule itself would agree with a broken bar. The bar is `<nav
 * data-first-run-phases>` with one `<li>` per pill, mounted on a confirmed
 * desktop surface only (App.tsx).
 */
async function phaseLabels(app: Page): Promise<string[]> {
  const pills = app.locator("[data-first-run-phases] li");
  await expect(pills.first(), "the phase bar must be on screen during a first run").toBeVisible();
  // Each pill also carries its state for assistive technology, as a visually
  // hidden ", Done" / ", Now" / ", Waiting on something" after the label
  // (FirstRunPhases.tsx). That is a fact about the pill's status and not part
  // of its name, so it is cut here rather than asserted on: this helper
  // answers "which phases are on the bar", and the marks move every step.
  return (await pills.allInnerTexts()).map((label) => label.replace(/\s+/g, " ").split(",")[0]!.trim());
}

/**
 * Reload, and wait for the renderer's own instance list to land before
 * reading the screen.
 *
 * WHY THIS IS NOT A CONVENIENCE. `noEngines` in App.tsx is
 * `state.instances.length > 0 && !state.instances.some(runnable)`, and
 * `state.instances` is EMPTY on first paint. So every machine, including one
 * with nothing on it, paints the Chief's thread for a moment and only then
 * swaps to whatever it is really going to show. A spec that asserts on that
 * first paint passes or fails on a race, which is exactly what this one did
 * on its third run: the same assertion failed as expected once and then
 * "passed" for arriving early.
 */
async function reloadSettled(app: Page): Promise<void> {
  const instances = app.waitForResponse(
    (response) => response.url().includes("/api/instances") && response.request().method() === "GET",
  );
  await app.reload();
  await instances;
  // Two frames: one for React to see the new state, one for it to paint.
  await app.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

// ── arranging the machine ──────────────────────────────────────────────

interface EngineRow {
  instanceId: string;
  enabled?: boolean;
  cli?: string;
}

async function engines(): Promise<EngineRow[]> {
  return (await harness("GET", "/api/instances")).instances as EngineRow[];
}

/** What the server says this machine is, in the fields every decision in the
 *  flow is taken from. */
async function machine(): Promise<{
  runnable: string[];
  signedOut: string[];
  nothingToThinkWith: boolean;
  nothingCanAnswer: boolean;
  detectStatus: string;
}> {
  const view = await harness("GET", "/api/setup");
  return {
    runnable: view.agents.map((agent: { id: string }) => agent.id),
    signedOut: view.signedOutAgents.map((agent: { id: string }) => agent.id),
    nothingToThinkWith: view.nothingToThinkWith === true,
    nothingCanAnswer: view.nothingCanAnswer === true,
    detectStatus: String(stepOf(view, "detect")?.status ?? "missing"),
  };
}

/** A short, printable reading of the machine, so a poll that times out says
 *  which machine it was actually looking at. */
async function machineSignature(): Promise<string> {
  const reading = await machine();
  return `runnable=${reading.runnable.length} signedOut=${reading.signedOut.length} blank=${reading.nothingToThinkWith}`;
}

/** Every engine off, which is the live state of a computer with nothing on
 *  it: nothing enabled, available and carrying a model. */
async function takeEveryEngineAway(): Promise<void> {
  for (const engine of await engines()) {
    await harness("PATCH", `/api/instances/${engine.instanceId}`, { enabled: false });
  }
  await expect
    .poll(machineSignature, { message: "the server must report a machine with nothing to think with" })
    .toBe("runnable=0 signedOut=0 blank=true");
}

/** The engine is here, it answers `--version`, and its own sign-in probe says
 *  nobody is signed in. Arranged through the engine-path field, answered by
 *  the real driver. */
const SIGNED_OUT_WRAPPER = join(tmpdir(), "murage-first-run-signed-out-claude.sh");

async function signOutTheOnlyEngine(): Promise<void> {
  writeFileSync(
    SIGNED_OUT_WRAPPER,
    `#!/bin/sh\nFAKE_CLAUDE_AUTH=out exec ${JSON.stringify(process.execPath)} `
      + `${JSON.stringify(join(REPO_ROOT, "server", "testing", "fake-claude-cli.ts"))} "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(SIGNED_OUT_WRAPPER, 0o755);
  for (const engine of await engines()) {
    await harness("PATCH", `/api/instances/${engine.instanceId}`, { cli: SIGNED_OUT_WRAPPER });
  }
  await expect
    .poll(machineSignature, { message: "the engine must be reported here, ready, and signed out" })
    .toBe("runnable=0 signedOut=1 blank=false");
}

/** The rig as the harness booted it. Captured rather than assumed: `cli:""`
 *  reverts to the DRIVER default ("claude"), which does not exist on a test
 *  box, so restoring by clearing would leave every later spec on a machine
 *  with no engine at all. */
let baseline: EngineRow[] = [];

test.beforeAll(async () => {
  baseline = await engines();
  expect(baseline.length, "the first-run rig must boot with at least one engine to take away").toBeGreaterThan(0);
});

test.afterEach(async () => {
  for (const engine of baseline) {
    await harness("PATCH", `/api/instances/${engine.instanceId}`, { cli: engine.cli ?? "" });
    await harness("PATCH", `/api/instances/${engine.instanceId}`, { enabled: engine.enabled !== false });
  }
  await expect
    .poll(async () => (await machine()).runnable.length, {
      message: "the rig must be handed back with its engine working",
    })
    .toBeGreaterThan(0);
});

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

const OWNER = "E2E Owner, e2e@example.invalid";

// ── 1 · an engine that is here and signed out ──────────────────────────

test.describe("an engine nobody is signed in to", () => {
  test.skip(process.platform === "win32", "the sign-out wrapper is a /bin/sh script");

  test("is offered back, on a screen that can be acted on", async ({ app }) => {
    await chiefHasSpoken(app);
    await signOutTheOnlyEngine();

    const reading = await machine();
    expect(reading.signedOut.length, "the engine is here and nobody is signed in").toBe(1);
    expect(reading.runnable.length, "and nothing on this machine can answer").toBe(0);
    expect(
      reading.nothingToThinkWith,
      "a machine with a signed-out engine is NOT blank — it has something worth telling the person about",
    ).toBe(false);

    await harness("POST", "/api/setup/answer", { step: "hello", answer: OWNER });
    await reloadSettled(app);
    await expect(
      app.getByText(/nobody is signed in to/i),
      "the signed-out engine must be reported rather than counted as working",
    ).toBeVisible();
    await expect(
      app.getByRole("button", { name: /Help me sign in/i }),
      "and the report must come with the one thing that fixes it",
    ).toBeEnabled();
    await screenIsUsable(app, "a signed-out engine · the detection report");
  });

  // ── OPEN DEFECT, RECORDED AS ONE ───────────────────────────────────────
  //
  // `test.fail()` because this is the product, not the spec. The check below
  // is the one this case exists for, it is correct, and it does not pass
  // today; marking it expected-to-fail keeps the run honest in both
  // directions — the suite stays green on a known defect, and the moment
  // somebody fixes it this test fails for passing and has to be looked at.
  //
  // WHAT IS WRONG. `FIRST_RUN_COPY.agents["signed-out"].third` reads "Or
  // leave it. What is already running carries on either way." It is rendered
  // unconditionally (`FirstRunSignedOutAgentsCard`, src/components/FirstRunCard.tsx),
  // and it is written for somebody whose signed-out Codex sits beside a
  // working engine. On a machine whose ONLY engine is the signed-out one,
  // `view.agents` is empty, NOTHING is running, and the sentence tells that
  // person their assistant is working when the next thing they ask it to do
  // will fail. That is the same shape as the defect this card exists to end:
  // a screen claiming a capability the machine does not have.
  //
  // THE FIX IS ONE LINE AND IT IS ALREADY WRITTEN TWICE NEXT DOOR.
  // `canCarryOn` in FirstRunFluxCard.tsx and `bare` in `FirstRunNoKeyCard`
  // both read `view.agents.length > 0` for exactly this reason. The card
  // needs the same reading and a second sentence for the machine where
  // nothing is running.
  test("does not tell a person with nothing running that it carries on", async ({ app }) => {
    // Marked inside the body, which is the form that marks THIS test: a bare
    // `test.fail()` in a describe marks every test that follows it.
    test.fail();
    await chiefHasSpoken(app);
    await signOutTheOnlyEngine();
    await harness("POST", "/api/setup/answer", { step: "hello", answer: OWNER });
    await reloadSettled(app);
    await expect(app.getByText(/nobody is signed in to/i)).toBeVisible();

    expect((await machine()).runnable.length, "nothing on this machine is running").toBe(0);
    expect(
      await screenSays(app, /What is already running carries on either way/i),
      "nothing is running on this machine, so the screen must not say something is",
    ).toBe(false);
  });
});

// ── 2 · a machine with an engine that can answer ───────────────────────
// SECOND, AND BEFORE THE BLANK MACHINE. This is the case that ANSWERS the
// detection report, which latches `detect` for good; see the header.

test.describe("a machine with an engine that can answer", () => {
  test("gets five phases, is told what was found, and can change its mind", async ({ app }) => {
    await chiefHasSpoken(app);

    const reading = await machine();
    expect(reading.runnable.length, "the rig's engine must be runnable here").toBeGreaterThan(0);
    expect(reading.nothingToThinkWith, "this machine has something to think with").toBe(false);
    expect(reading.nothingCanAnswer, "and something on it can answer").toBe(false);

    const phases = await phaseLabels(app);
    expect(phases, `five phases on a machine that has an engine — saw ${JSON.stringify(phases)}`).toHaveLength(5);
    expect(
      phases.some((label) => /what is here/i.test(label)),
      "the detection phase belongs on the bar of a machine that has something to detect",
    ).toBe(true);

    await harness("POST", "/api/setup/answer", { step: "hello", answer: OWNER });
    await reloadSettled(app);
    await expect(
      app.getByText(/You already had help on this computer|There is one in the box/i),
      "a machine that HAS something must be told what was found",
    ).toBeVisible();
    await screenIsUsable(app, "an engine that can answer · the detection report");

    // A WAY ON. The detection report is the one card whose step can ONLY be
    // settled by a recorded answer on a machine that has something
    // (`setupStepDone("detect")`), so without this control `nextSetupStep`
    // returns `detect` for ever and the Flux screen is never shown to anybody
    // with an engine — which is most installs, and is why
    // `FirstRunDetectOnward` exists.
    const onward = app.getByRole("button", { name: /Show me the interesting part/i }).last();
    await expect(onward, "the detection report must carry its own way out").toBeEnabled();
    await onward.click();
    await expect(
      app.getByRole("button", { name: /Connect Flux Router/i }),
      "reading the report must lead somewhere",
    ).toBeEnabled();

    // A WAY BACK, on this machine too. Passing over the Flux step and then
    // reopening it is what the app itself does, and the card has to come back
    // live rather than greyed out.
    await harness("POST", "/api/setup/skip", { step: "flux" });
    await harness("POST", "/api/setup/reopen", { step: "flux" });
    await reloadSettled(app);
    await expect(
      app.getByRole("button", { name: /Connect Flux Router/i }),
      "a reopened Flux step must be answerable again",
    ).toBeEnabled();
    await screenIsUsable(app, "an engine that can answer · the reopened Flux step");
  });
});

// ── 3 · a machine with nothing ─────────────────────────────────────────

test.describe("a machine with nothing on it", () => {
  test("still puts a usable screen in front of the person", async ({ app }) => {
    await chiefHasSpoken(app);
    await takeEveryEngineAway();
    await reloadSettled(app);
    await screenIsUsable(app, "a machine with nothing · the screen it opens on");
  });

  test("is told four phases, and detection is settled rather than asked", async ({ app }) => {
    await chiefHasSpoken(app);
    await takeEveryEngineAway();

    expect(
      (await machine()).detectStatus,
      "detection must be settled before it is presented, or the flow stops on a step that cannot be finished",
    ).toBe("done");

    await reloadSettled(app);
    const phases = await phaseLabels(app);
    expect(phases, `four phases on a machine with nothing — saw ${JSON.stringify(phases)}`).toHaveLength(4);
    expect(
      phases.some((label) => /what is here/i.test(label)),
      "there is no honest \"here is what I found\" for a machine where nothing was found",
    ).toBe(false);
    expect(
      phases.map((label) => label.replace(/^\d+\s*·\s*/, "")),
      "and the four that are left are renumbered one to four, not one, three, four, five",
    ).toEqual(["who you are", "switch it on", "first chat", "do the thing"]);
  });

  // ── RELEASE BLOCK, RECORDED AS ONE ─────────────────────────────────────
  //
  // `test.fail()` for the same reason as above: the check is right, the
  // product is not, and a red suite teaches people to ignore red.
  //
  // WHAT IS WRONG, AND IT IS THE ORIGINAL BLOCK ONE LAYER UP. Every card in
  // the first run — the welcome, the detection report, the Flux card with the
  // only box in the flow that takes a key — lives in the CHIEF'S THREAD.
  // App.tsx renders `<NoEngines />` INSTEAD of that thread whenever no
  // instance is runnable:
  //
  //     const noEngines = state.connected && state.instances.length > 0
  //       && !state.instances.some(i => i.enabled !== false
  //          && i.snapshot.state === "available"
  //          && (i.models?.default ?? "").trim().length > 0);
  //
  // That predicate is `runnable()` copied from server/setup.ts, deliberately,
  // so the two cannot drift. Which means it is TRUE on precisely the machine
  // `nothingToThinkWith` is true on — the machine this release was written
  // for. Murage ships the Fuigo binary, so that machine HAS an instance
  // (`state.instances.length > 0`) which reports itself available with an
  // empty catalogue, and `runnable()` says no.
  //
  // So the person with nothing installed gets the phase bar telling them they
  // are on "2 · switch it on", and underneath it a screen that says "Install
  // an AI engine to get started" and "Murage doesn't ship a model of its
  // own" — which contradicts the first run's own words ("Murage brought its
  // own AI with it") — with no way to reach the card that would switch it on.
  // The dead end moved; it did not go.
  //
  // The screen ITSELF is fine, which is why the test above passes: it has
  // live controls, real prose and nothing off the right edge. What it does
  // not have is the flow.
  test("still lets the person reach the Chief's question", async ({ app }) => {
    test.fail();
    await chiefHasSpoken(app);
    await takeEveryEngineAway();
    await reloadSettled(app);
    await chiefHasSpoken(app);
  });

  test("gets a Flux screen it can answer, leave, and come back to", async ({ app }) => {
    test.fail();
    await chiefHasSpoken(app);
    await takeEveryEngineAway();
    await harness("POST", "/api/setup/answer", { step: "hello", answer: OWNER });
    await reloadSettled(app);

    // The blank machine's Flux card must carry the blank-machine framing AND
    // the controls, on the same card. That part of the fix is real — the
    // server plans `key` on every machine now and `FirstRunFluxCard` swaps
    // its own heading on `view.nothingToThinkWith`. It is unreachable.
    await expect(
      app.getByText(/Your bots need a brain first/i),
      "the blank machine's Flux screen must say what was looked for",
    ).toBeVisible();

    const connect = app.getByRole("button", { name: /Connect Flux Router/i });
    await expect(connect, "the card that frames the blank machine must be the card that takes a key").toBeEnabled();
    await expect(
      app.getByRole("button", { name: /^Not now$/ }),
      "and leaving without a key must be a real answer",
    ).toBeEnabled();

    await connect.click();
    await expect(
      app.getByPlaceholder(/Paste your key here/i),
      "pressing Connect on a blank machine must reach the box that takes the key",
    ).toBeVisible();

    await harness("POST", "/api/setup/skip", { step: "flux" });
    await reloadSettled(app);
    await expect(
      app.getByRole("button", { name: /Brief me every morning/i }),
      "leaving the Flux screen without a key must land on the jobs, not on nothing",
    ).toBeEnabled();
  });
});

// ── the controls ───────────────────────────────────────────────────────
//
// A CHECK THAT CANNOT FAIL IS NOT A CHECK. Every check above is handed, here,
// the exact thing it exists to catch.

const BAIT = "This sentence begins near the right edge and runs past it, which is what clipping actually is.";

test("the clipping check catches text that runs past the right edge", async ({ app }) => {
  await chiefHasSpoken(app);
  await app.evaluate((sentence) => {
    const bait = document.createElement("div");
    bait.textContent = sentence;
    bait.style.cssText = `position:fixed;top:0;left:${document.documentElement.clientWidth - 60}px;white-space:nowrap;z-index:99999`;
    document.body.appendChild(bait);
  }, BAIT);
  expect(
    (await clippedText(app)).length,
    "the clipping check missed text starting 60px from the right edge",
  ).toBeGreaterThan(0);
});

test("the clipping check catches clipped prose that contains markup", async ({ app }) => {
  await chiefHasSpoken(app);
  await app.evaluate((sentence) => {
    const paragraph = document.createElement("p");
    paragraph.style.cssText = `position:fixed;top:40px;left:${document.documentElement.clientWidth - 60}px;white-space:nowrap;z-index:99999`;
    paragraph.append(
      document.createTextNode(sentence),
      Object.assign(document.createElement("strong"), { textContent: " and it carries markup." }),
    );
    document.body.appendChild(paragraph);
  }, BAIT);
  expect(
    (await clippedText(app)).length,
    "the clipping check cannot see clipped prose once it contains markup — which is all real prose",
  ).toBeGreaterThan(0);
});

test("the dead-end check screams at a screen with nothing to press", async ({ app }) => {
  await chiefHasSpoken(app);
  // A screen that LOOKS answerable and is not: one button, disabled, and a
  // paragraph long enough to pass the readable rule on its own, so the only
  // rule that can fire is the one being controlled.
  await app.evaluate(() => {
    const main = document.createElement("main");
    const line = document.createElement("p");
    line.textContent = "This screen has plenty to read on it and nothing at all that a person can press.";
    const dead = document.createElement("button");
    dead.textContent = "Continue";
    dead.disabled = true;
    main.append(line, dead);
    document.body.replaceChildren(main);
  });
  expect(await liveControls(app).count(), "a disabled button is not a way on").toBe(0);
  await expect(
    screenIsUsable(app, "control"),
    "the dead-end rule passed a screen whose only control is disabled",
  ).rejects.toThrow(/no enabled control/);
});

test("the something-to-read check screams at a blank card", async ({ app }) => {
  await chiefHasSpoken(app);
  await app.evaluate(() => {
    const main = document.createElement("main");
    const button = document.createElement("button");
    button.textContent = "Go";
    main.append(button);
    document.body.replaceChildren(main);
  });
  await expect(
    screenIsUsable(app, "control"),
    "the readable rule passed a screen with a button and no words",
  ).rejects.toThrow(/under twenty readable characters/);
});

test("the claim detector reads the screen, both ways round", async ({ app }) => {
  await chiefHasSpoken(app);
  await app.evaluate(() => {
    const planted = document.createElement("p");
    planted.textContent = "Or leave it. What is already running carries on either way.";
    document.body.appendChild(planted);
  });
  expect(
    await screenSays(app, /What is already running carries on either way/i),
    "the claim detector missed the exact sentence, planted in the page",
  ).toBe(true);
  expect(
    await screenSays(app, /this sentence is on no screen in this product/i),
    "the claim detector reported a sentence that is not on the page",
  ).toBe(false);
});

test("taking the engine away is not a no-op", async ({ app }) => {
  // The control on the ARRANGEMENT, which is the part that could quietly do
  // nothing and leave every machine-state test above asserting the same
  // machine twice. Before and after must disagree, on the server AND on the
  // bar the person reads.
  await chiefHasSpoken(app);
  const before = await machine();
  expect(before.runnable.length, "the rig starts with an engine that can think").toBeGreaterThan(0);
  expect(before.nothingToThinkWith).toBe(false);
  expect(await phaseLabels(app), "five pills while the engine is on").toHaveLength(5);

  await takeEveryEngineAway();

  const after = await machine();
  expect(after.runnable, "and none once it is taken away").toEqual([]);
  expect(after.signedOut, "taken away is not the same as signed out").toEqual([]);
  expect(after.nothingToThinkWith).toBe(true);
  await reloadSettled(app);
  expect(await phaseLabels(app), "four pills once there is nothing to report").toHaveLength(4);
});

test("signing the engine out is not the same as taking it away", async () => {
  // The control on the OTHER arrangement. If the wrapper did nothing, this
  // would read exactly like the machine above and the signed-out case would
  // be testing the blank machine under another name.
  await signOutTheOnlyEngine();
  const reading = await machine();
  expect(reading.signedOut.length, "the engine is still here and still reports itself available").toBe(1);
  expect(reading.runnable, "but nothing on the machine can answer").toEqual([]);
  expect(
    reading.nothingToThinkWith,
    "and this machine is NOT the blank one — it has something on it worth saying",
  ).toBe(false);
  expect(reading.nothingCanAnswer, "which is a different question, and the answer to it is yes").toBe(true);
});
