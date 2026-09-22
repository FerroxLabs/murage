// THE JOBS LIST MUST SURVIVE BEING ASKED AGAIN.
//
// Release block #2 was a one-way `settled` latch: the driver set it and
// nothing set it back, so "Something else" reopened `chat` on the checklist
// while the jobs card above it stayed greyed out. That was fixed on the
// SERVER, by giving the plan an `unsettle` list.
//
// The identical latch was left in the renderer, one layer below where that
// fix can reach: `FirstRunJobsCard` keeps `acted` in component state, writes
// it true when a job is chosen, and never writes it false. `done` is
// `acted || settled`, and every row is `disabled={done || ...}`. So a person
// who picks one job and is then asked again — by the escape hatch, by
// "Something else", or by the server reopening the step after a failed
// connect — is left with five dead rows and no way to pick anything.
//
// The owner hit this on a clean Windows install: the jobs card said
// `settled: false`, the checklist said `chat.done: false`, and the rows still
// did nothing, because neither of those two facts can see React state.
// `server.log` was silent because no request was ever made.
//
// This drives the REAL server through the REAL routes. Nothing here is
// stubbed: the reopen is the same `POST /api/setup/reopen` the do-it card's
// own back buttons call.
import { expect, test } from "./fixtures";
import { HARNESS_URL, desktopHeaders } from "./rig";

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

/** Walk the checklist to the Chief's question the same way a person does. */
async function reachTheJobs(): Promise<void> {
  await harness("POST", "/api/setup/answer", { step: "hello", answer: "E2E Owner, e2e@example.invalid" });
  for (const step of ["detect", "flux"]) {
    const view = await harness("GET", "/api/setup");
    if (!stepOf(view, step)?.done) await harness("POST", "/api/setup/skip", { step });
  }
  const view = await harness("GET", "/api/setup");
  expect(stepOf(view, "chat").done, "chat must still be the open question").toBe(false);
}

// THE LISTENERS GO ON BEFORE THE FIRST NAVIGATION, NOT AFTER.
//
// The `app` fixture navigates during fixture setup, so a spec that attaches
// `pageerror` in its own body is listening from the second page onwards and
// is structurally blind to a crash on mount — which is the failure it most
// needs to see. This cost a whole diagnostic cycle: a renderer that never
// polls `GET /api/setup` leaves no Chief and therefore no cards, and that is
// indistinguishable on screen from a flow that never arrived.
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

test("a job row is still pressable after the step is reopened", async ({ app }) => {
  // WAIT FOR THE CHIEF TO EXIST BEFORE DRIVING HIM.
  //
  // The Chief bot is created by the RENDERER's first `GET /api/setup`, and
  // `driveSetup` is what appends each card. A spec that posts answers in the
  // tenth of a second after `goto` returns beats the first poll, so the
  // checklist advances against a workspace with no Chief in it and not one
  // card is ever said. The transcript is then empty for ever, because the
  // driver is keyed on card identity and does nothing when nothing changed.
  //
  // That is a race in this file, not a defect in the app — a person cannot
  // answer a card that has not been drawn. It cost four diagnostic runs, and
  // it is why the first two attempts looked like the flow never arrived.
  await expect(
    app.getByText(/who am I working for/i),
    "the Chief must have asked before the checklist is driven",
  ).toBeVisible();

  await reachTheJobs();
  const reached = await harness("GET", "/api/setup");
  console.info(`CHECKLIST: next=${reached.next} ${reached.steps.map((s: any) => `${s.id}:${s.done ? "done" : s.skipped ? "skipped" : "open"}`).join(" ")}`);
  // Which cards the Chief has actually said. A step can be the live one on
  // the checklist while the card that ASKS it was never appended, and those
  // two states are indistinguishable from the screen.
  const { bots } = await harness("GET", "/api/bots");
  const chief = bots.find((bot: any) => bot.messages?.some((m: any) => m.card?.setup));
  const cards = (chief?.messages ?? [])
    .filter((m: any) => m.card?.setup)
    .map((m: any) => `${m.card.setup.key}${m.card.setup.settled ? "(settled)" : ""}`);
  console.info(`CARDS SAID: ${cards.join(" | ") || "NONE"}`);
  // `app` already skipped the email gate and landed on "/"; the checklist was
  // walked before the page loaded, so the Chief opens on his own question.
  await app.reload();

  // The five rows are the Chief's own question. Any one of them proves it.
  const brief = app.getByRole("button", { name: /Brief me every morning/i });
  await expect(brief, "the jobs list must arrive pressable").toBeEnabled();

  await brief.click();
  await expect
    .poll(async () => stepOf(await harness("GET", "/api/setup"), "chat").done, {
      message: "choosing a job must record it on the checklist",
    })
    .toBe(true);

  // Exactly what "Something else" and "take something else off my plate" do,
  // and what the server does by itself when a connect falls over.
  await harness("POST", "/api/setup/reopen", { step: "chat" });
  await expect
    .poll(async () => stepOf(await harness("GET", "/api/setup"), "chat").done)
    .toBe(false);

  // THE ASSERTION. The checklist says the question is live again, so the card
  // that asks it must be answerable again. A latch in component state is
  // still a latch.
  await expect(brief, "reopening the step must bring the rows back to life").toBeEnabled();

  await brief.click();
  await expect
    .poll(async () => stepOf(await harness("GET", "/api/setup"), "chat").done, {
      message: "the second choice must reach the server, not die in the renderer",
    })
    .toBe(true);
});
