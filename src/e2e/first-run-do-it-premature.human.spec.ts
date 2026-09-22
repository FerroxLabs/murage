// THE CHIEF MUST NOT SAY "ON IT" BEFORE ANYTHING HAS BEEN PICKED.
//
// THE REPORT. On a clean Windows install the owner reached "What can I take
// off your plate?", pressed nothing, and about nineteen seconds later a
// second card appeared underneath it: "On it". Because no job had been
// chosen, that card rendered its empty state — "Nothing picked yet. The list
// is just above this one" — and stayed that way for the rest of the session.
// Two cards, one of them telling him he had failed to do the thing he was
// still being asked to do.
//
// WHY IT SHOULD BE IMPOSSIBLE, WHICH IS EXACTLY WHY IT NEEDS A TEST.
// `setupConversationPlan` appends `flow:do-it` only when `view.next` is
// `flow` (server/setup-conversation.ts), and `nextSetupStep` returns the
// first step that is neither done nor skipped (shared/setup.ts). So `flow`
// can only be next once `chat` is done or skipped. `chat` is done only when
// `setupStepAnswered` finds a recorded note, the single writer of that note
// is `POST /api/setup/answer`, and the only caller in the renderer that
// names `chat` is the job row's own press handler. Nothing anywhere skips
// `chat`.
//
// Reading that path says the bug cannot happen. The owner watched it happen.
// One of those two things is wrong, and a spec is the only thing that can
// say which — so this holds the flow at the question, presses nothing, and
// watches.
//
// THE CONTROL IS IN THE SAME TEST, DELIBERATELY.
// A spec that waits for a card and does not find it passes just as happily
// when it is watching the wrong key, when the Chief never spoke at all, or
// when the transcript it reads is empty for a reason that has nothing to do
// with the defect. Three checks written in this harness went green that way
// and none of them could ever have failed. So after the quiet hold this
// answers `chat` for real and requires the very same probe to FIND the card
// within seconds. If the second half does not go off, the first half proved
// nothing and the run says so.
import { expect, test } from "./fixtures";
import { HARNESS_URL, desktopHeaders } from "./rig";

/** The card this is about, as the server keys it (`shared/setup-card.ts`). */
const DO_IT = "flow:do-it";

/** What the card says when it is drawn with no job behind it
 *  (`noJob`, src/lib/first-run-copy.ts). The half sentence is enough and
 *  survives the copy being re-worded around it. */
const NOTHING_PICKED = /Nothing picked yet/i;

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

const stepOf = (view: any, id: string) => view.steps.find((entry: { id: string }) => entry.id === id);

/** Every setup card the Chief has actually said, newest last.
 *
 *  Read from the thread rather than from the screen. A card can be appended
 *  to the transcript and be off-screen below the fold, and "the owner has
 *  been sent a card he did not earn" is true the moment it is appended. */
async function cardsSaid(): Promise<string[]> {
  const { bots } = await harness("GET", "/api/bots");
  const chief = bots.find((bot: any) => bot.messages?.some((m: any) => m.card?.setup));
  return (chief?.messages ?? [])
    .filter((m: any) => m.card?.setup)
    .map((m: any) => String(m.card.setup.key));
}

/** Walk the checklist to the Chief's question the way a person does. */
async function reachTheJobs(): Promise<void> {
  await harness("POST", "/api/setup/answer", { step: "hello", answer: "E2E Owner, e2e@example.invalid" });
  for (const step of ["detect", "flux"]) {
    const view = await harness("GET", "/api/setup");
    if (!stepOf(view, step)?.done) await harness("POST", "/api/setup/skip", { step });
  }
  const view = await harness("GET", "/api/setup");
  expect(stepOf(view, "chat").done, "chat must still be the open question").toBe(false);
}

// Listeners go on before the first navigation. The `app` fixture navigates
// during FIXTURE SETUP, so a spec that attaches `pageerror` in its own body
// is listening from the second page onwards and is structurally blind to a
// crash on mount. That trap cost four diagnostic runs in this harness.
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

// The hold is the test. Three minutes of headroom around it.
test.setTimeout(180_000);

/** Longer than the owner's nineteen seconds, with room for a slow lane. */
const HOLD_MS = 45_000;

test("the Chief waits at the question instead of answering it himself", async ({ app }) => {
  // The Chief bot is created by the RENDERER's first `GET /api/setup`. A spec
  // that posts answers in the moment after `goto` returns beats that poll,
  // the checklist advances against a workspace with no Chief in it, and not
  // one card is ever said. The transcript is then empty for ever and this
  // whole file would pass while measuring nothing.
  await expect(
    app.getByText(/who am I working for/i),
    "the Chief must have asked before the checklist is driven",
  ).toBeVisible();

  await reachTheJobs();
  await app.reload();

  // The question is on screen and pressable. If this is not true, the hold
  // below is watching a flow that never arrived.
  const brief = app.getByRole("button", { name: /Brief me every morning/i });
  await expect(brief, "the jobs list must arrive pressable").toBeEnabled();
  expect(await cardsSaid(), "the jobs card must have been said").toContain("chat:jobs");

  // ── THE MEASUREMENT ───────────────────────────────────────────────────
  // Press nothing. Watch. Poll rather than sleep, so a card that appears and
  // is then settled or replaced is still caught red-handed.
  const deadline = Date.now() + HOLD_MS;
  let sightings = 0;
  let firstSightingMs: number | null = null;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    const said = await cardsSaid();
    if (said.includes(DO_IT)) {
      sightings += 1;
      firstSightingMs ??= Date.now() - startedAt;
    }
    await app.waitForTimeout(1_000);
  }

  const view = await harness("GET", "/api/setup");
  console.info(
    `AFTER ${HOLD_MS / 1000}s OF SILENCE: next=${view.next} `
    + view.steps.map((s: any) => `${s.id}:${s.done ? "done" : s.skipped ? "skipped" : "open"}`).join(" "),
  );
  console.info(`CARDS SAID: ${(await cardsSaid()).join(" | ") || "NONE"}`);

  expect(
    stepOf(view, "chat").done,
    "nobody pressed anything, so the question must still be open",
  ).toBe(false);
  expect(
    sightings,
    firstSightingMs === null
      ? '"On it" must not arrive on its own'
      : `"On it" arrived ${Math.round(firstSightingMs / 1000)}s into a hold where nothing was pressed`,
  ).toBe(0);
  await expect(
    app.getByText(NOTHING_PICKED),
    "the owner must never be told he picked nothing while he is still being asked to pick",
  ).toHaveCount(0);

  // ── THE CONTROL ───────────────────────────────────────────────────────
  // Same probe, same keys, same transcript read — now handed the thing it
  // exists to catch. If `flow:do-it` does not turn up here, every assertion
  // above was blind and its green means nothing.
  await harness("POST", "/api/setup/answer", { step: "chat", answer: "brief" });
  await expect
    .poll(cardsSaid, {
      message: "CONTROL FAILED: the probe cannot see flow:do-it even after a job was chosen, so its silence above proved nothing",
      timeout: 30_000,
    })
    .toContain(DO_IT);
});
