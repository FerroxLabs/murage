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
import { chiefHasSpoken } from "./first-run-chief";
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
  const { bots } = await harness("GET", "/api/bots");
  if (bots.some((bot: any) => bot.messages?.some((message: any) => message.card?.setup?.key === "detect:move-grok"))) {
    await harness("POST", "/api/setup/card", { key: "detect:move-grok", action: "settle" });
  }
  for (const key of ["flux:notify", "chat:hire"]) {
    await harness("POST", "/api/setup/card", { key, action: "settle" });
  }
  if (stepOf(await harness("GET", "/api/setup"), "chat").done) {
    await harness("POST", "/api/setup/reopen", { step: "chat" });
  }
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
        window.localStorage.setItem("help.seen.chat.level-chip", "1");
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
  await chiefHasSpoken(app);

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
  const brief = app.getByRole("checkbox", { name: /Brief me every morning/i });
  await expect(brief, "the jobs list must arrive pressable").toBeEnabled();

  await brief.check();
  await app.getByRole("checkbox", { name: /Organise my day/i }).uncheck();
  await app.getByRole("checkbox", { name: /Make sense of these notes/i }).uncheck();
  await app.getByRole("button", { name: "Set up these 1", exact: true }).click();
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

  await brief.check();
  await app.getByRole("checkbox", { name: /Organise my day/i }).uncheck();
  await app.getByRole("checkbox", { name: /Make sense of these notes/i }).uncheck();
  await app.getByRole("button", { name: "Set up these 1", exact: true }).click();
  await expect
    .poll(async () => stepOf(await harness("GET", "/api/setup"), "chat").done, {
      message: "the second choice must reach the server, not die in the renderer",
    })
    .toBe(true);
});


// G4 lifecycle: a dedicated real server owns the profile so restart never touches
// the rig's shared harness. Run by the browser rig, not by the unit gate.
test("selected jobs survive reload and a process restart; Stop stays stopped", async ({ page }) => {
  test.setTimeout(120_000);
  const { launchVerificationServer } = await import("../../scripts/control-murage.ts");
  const { createServer } = await import("vite");
  const { fileURLToPath } = await import("node:url");
  const fixture = await launchVerificationServer();
  let ui: Awaited<ReturnType<typeof createServer>> | undefined;
  const headers: Record<string, string> = { "x-murage-surface": "desktop", "content-type": "application/json" };
  const refreshSecret = async () => {
    const response = await fetch(`${fixture.info.url}/api/desktop-secret`, { headers: { "x-murage-surface": "desktop" } });
    expect(response.ok).toBe(true);
    headers["x-murage-surface-secret"] = (await response.json()).secret;
  };
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    expect(response.ok, `${path}: ${JSON.stringify(data)}`).toBe(true);
    return data;
  };
  try {
    await refreshSecret();
    ui = await createServer({
      root: fileURLToPath(new URL("../../", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null, hmr: false,
        proxy: { "/api": { target: fixture.info.url, ws: true, configure(proxy) {
          const authorize = (req: { setHeader(name: string, value: string): void }) => {
            for (const [key, value] of Object.entries(headers)) req.setHeader(key, value);
          };
          proxy.on("proxyReq", authorize); proxy.on("proxyReqWs", authorize);
        } } },
      },
    });
    await ui.listen();
    await page.addInitScript(() => localStorage.setItem("murage-email-gate", "skipped"));
    await page.goto(ui.resolvedUrls!.local[0]);
    await chiefHasSpoken(page);
    await request("POST", "/api/setup/answer", { step: "hello", answer: "Queue Owner" });
    for (const step of ["detect", "flux"]) await request("POST", "/api/setup/skip", { step });
    for (const key of ["flux:notify", "chat:hire"]) await request("POST", "/api/setup/card", { key, action: "settle" });
    await page.reload();
    for (const title of ["Brief me every morning", "Organise my day", "Make sense of these notes"]) {
      await page.getByRole("checkbox", { name: new RegExp(title, "i") }).check();
    }
    await page.getByRole("button", { name: "Set up these 3", exact: true }).click();
    const queue = async () => (await request("GET", "/api/owner/first-run-jobs")).pending;
    await expect.poll(queue).toEqual(["day", "notes"]);
    const { openSidebar } = await import("./fixtures");
    const pending = page.locator('[data-today="pending-jobs"]');
    const showQueue = async () => {
      const sidebar = await openSidebar(page);
      await sidebar.getByRole("button", { name: "Today", exact: true }).click();
      await expect(pending).toContainText("Make sense of these notes");
    };
    // The first job still needs its answer, so the queue must not drain yet.
    await showQueue();
    await expect(pending).toContainText("Organise my day");
    await page.reload();
    expect(await queue()).toEqual(["day", "notes"]);
    await showQueue();
    await expect(pending).toContainText("Organise my day");
    await fixture.restart();
    await refreshSecret();
    await page.reload();
    expect(await queue()).toEqual(["day", "notes"]);
    await showQueue();
    await expect(pending).toContainText("Organise my day");
    await pending.getByRole("button", { name: "Stop Organise my day", exact: true }).click();
    await expect.poll(queue).toEqual(["notes"]);
    await expect(pending.getByRole("button", { name: "Stop Organise my day", exact: true })).toHaveCount(0);
    await fixture.restart();
    await refreshSecret();
    await page.reload();
    expect(await queue()).toEqual(["notes"]);
    await showQueue();
    await expect(page.getByRole("button", { name: "Stop Organise my day", exact: true })).toHaveCount(0);
  } finally {
    await ui?.close();
    await fixture.close();
  }
});
