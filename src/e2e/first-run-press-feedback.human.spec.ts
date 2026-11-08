// EVERY PRESS ON THE FIRST RUN IS ANSWERED BEFORE THE NETWORK IS.
//
// The owner walked a fresh Cloud home: Continue on the name card left a grey
// "Saving" pill sitting still for seconds, and picking "Brief me every
// morning" showed nothing at all. On Cloud each request goes through the
// tunnel and the home proxy, so this holds every one of them back and asks
// the only question that matters to the person: did the press visibly land?
//
// The clock is the page's own. The press and the first sight of the working
// line are both stamped inside the browser, so the 100 ms is what a person
// would see, not Playwright's round trips.
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { HARNESS_URL, desktopHeaders } from "./rig";

const HELD_MS = 2_500;
const WITHIN_MS = 100;

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

/**
 * Put the name question back the way a fresh home has it and bring it on
 * screen. The first-run specs share one workspace, so an earlier one may have
 * answered hello, and its card is then far up a long thread: scrolled up the
 * way a reader does, so the older messages load (first-run-chief.ts).
 */
async function askForTheNameAgain(app: Page) {
  await harness("PUT", "/api/config", { profile: { name: "" } });
  await harness("POST", "/api/setup/reopen", { step: "hello" });
  await expect.poll(async () => stepOf(await harness("GET", "/api/setup"), "hello").done).toBe(false);
  await app.reload();
  const name = app.getByRole("textbox", { name: "Your name" });
  const log = app.getByTestId("chat-scroll");
  await expect(async () => {
    await log.evaluate((el) => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect(name).toBeVisible({ timeout: 1_000 });
  }, "the Chief must have asked for a name").toPass({ timeout: 20_000 });
  return name;
}

/** Hold every write the first run makes, the way a slow tunnel does. */
async function holdTheNetwork(page: Page): Promise<void> {
  await page.route(/\/api\/(config|setup\/answer|setup\/skip)(\?|$)/, async (route) => {
    if (route.request().method() === "GET") return route.continue();
    await new Promise((resolve) => setTimeout(resolve, HELD_MS));
    await route.continue();
  });
}

/**
 * Stamp, in page time: the press; the first painted frame in which the
 * working line is on screen and visible; and the moment the first write
 * request leaves the page.
 */
async function watchForTheWorkingLine(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record = window as unknown as { __press?: number; __seen?: number; __sent?: number; __fetch?: typeof fetch };
    record.__press = undefined;
    record.__seen = undefined;
    record.__sent = undefined;
    record.__fetch ??= window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const url = String(input instanceof Request ? input.url : input);
      if (method !== "GET" && /\/api\/(config|setup\/)/.test(url)) record.__sent ??= performance.now();
      return record.__fetch!(input, init);
    };
    document.addEventListener("click", () => { record.__press ??= performance.now(); }, { capture: true, once: true });
    const visible = () => {
      const line = document.querySelector<HTMLElement>("[data-testid=first-run-working]");
      if (!line) return false;
      const box = line.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && (typeof line.checkVisibility !== "function" || line.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    };
    const frame = () => {
      if (record.__seen !== undefined) return;
      // Stamped inside a frame callback: the frame being drawn shows it.
      if (record.__press !== undefined && visible()) record.__seen = performance.now();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/** Press to painted working line, and proof the line was up before anything left. */
async function pressToWorkingMs(page: Page): Promise<number> {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __seen?: number }).__seen ?? null)).not.toBeNull();
  const { press, seen, sent } = await page.evaluate(() => {
    const record = window as unknown as { __press: number; __seen: number; __sent?: number };
    return { press: record.__press, seen: record.__seen, sent: record.__sent ?? null };
  });
  expect(sent, "the press must still reach the server").not.toBeNull();
  expect(seen, "the working line must be on screen before any request leaves").toBeLessThanOrEqual(sent!);
  return seen - press;
}

test.use({
  app: async ({ page }, use) => {
    page.on("pageerror", (error) => console.error(`PAGE ERROR: ${error.message}`));
    await page.addInitScript(() => {
      try { window.localStorage.setItem("murage-email-gate", "skipped"); } catch { /* the gate just renders */ }
    });
    await page.goto("/");
    await use(page);
  },
});

test.describe.configure({ mode: "serial" });

test("Continue on the name card shows the Chief saving the name within 100 ms, with the network held", async ({ app }) => {
  const name = await askForTheNameAgain(app);
  await name.fill("Press Owner");
  await holdTheNetwork(app);
  await watchForTheWorkingLine(app);

  await app.getByRole("button", { name: "Continue" }).click();

  const took = await pressToWorkingMs(app);
  console.info(`[press-feedback] name card: working line ${Math.round(took)} ms after the press`);
  expect(took, "the working line must be on screen within 100 ms of the press").toBeLessThan(WITHIN_MS);
  const working = app.getByTestId("first-run-working");
  await expect(working).toContainText("Saving your name");
  await expect(working).toHaveAttribute("data-motion", "animated");
  // The card itself changed state, not only a label.
  await expect(app.locator("[data-state=saving]")).toBeVisible();
  // And the save still lands once the network lets it through, and the line goes.
  await expect.poll(async () => stepOf(await harness("GET", "/api/setup"), "hello").done, { timeout: 20_000 }).toBe(true);
  await expect(working).toBeHidden({ timeout: 20_000 });
});

test("a failed name save takes the working line down and says so", async ({ app }) => {
  const name = await askForTheNameAgain(app);
  await app.route(/\/api\/config(\?|$)/, async (route) => {
    if (route.request().method() === "GET") return route.continue();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "That did not save. Try once more, or skip it and carry on." }) });
  });
  await name.fill("Press Owner");
  await name.press("Enter");
  await expect(app.getByTestId("first-run-working")).toContainText("Saving your name");
  await expect(app.getByRole("alert")).toContainText("That did not save");
  await expect(app.getByTestId("first-run-working")).toBeHidden();
  await expect(app.getByRole("button", { name: "Continue" })).toBeEnabled();
  // Leave hello answered for the jobs below.
  await harness("POST", "/api/setup/answer", { step: "hello", answer: "Press Owner" });
});

test("picking the morning brief shows the row picked and the Chief setting it up within 100 ms, with the network held", async ({ app }) => {
  for (const step of ["detect", "flux"]) {
    const view = await harness("GET", "/api/setup");
    if (!stepOf(view, step)?.done) await harness("POST", "/api/setup/skip", { step });
  }
  // An earlier spec in the shared workspace may have chosen a job already.
  if (stepOf(await harness("GET", "/api/setup"), "chat").done) await harness("POST", "/api/setup/reopen", { step: "chat" });
  await expect.poll(async () => stepOf(await harness("GET", "/api/setup"), "chat").done, { message: "chat must be the open question" }).toBe(false);
  await app.reload();
  const brief = app.getByRole("button", { name: /Brief me every morning/i });
  await expect(brief, "the jobs list must arrive pressable").toBeEnabled();
  await holdTheNetwork(app);
  await watchForTheWorkingLine(app);

  await brief.click();

  const took = await pressToWorkingMs(app);
  console.info(`[press-feedback] jobs card: working line ${Math.round(took)} ms after the press`);
  expect(took, "the working line must be on screen within 100 ms of the press").toBeLessThan(WITHIN_MS);
  await expect(app.getByTestId("first-run-working")).toContainText("Setting up your morning brief");
  await expect(brief).toHaveAttribute("data-state", "picked");
  await expect.poll(async () => stepOf(await harness("GET", "/api/setup"), "chat").done, { timeout: 20_000 }).toBe(true);
});

test("with reduced motion asked for, the working line holds still and still says what is happening", async ({ app }) => {
  await app.emulateMedia({ reducedMotion: "reduce" });
  await harness("POST", "/api/setup/reopen", { step: "chat" });
  await expect.poll(async () => stepOf(await harness("GET", "/api/setup"), "chat").done).toBe(false);
  await app.reload();
  const day = app.getByRole("button", { name: /Organise my day/i });
  await expect(day).toBeEnabled();
  await holdTheNetwork(app);
  await watchForTheWorkingLine(app);

  await day.click();

  expect(await pressToWorkingMs(app)).toBeLessThan(WITHIN_MS);
  const working = app.getByTestId("first-run-working");
  await expect(working).toHaveAttribute("data-motion", "static");
  await expect(working).toContainText("Getting your day plan ready");
});
