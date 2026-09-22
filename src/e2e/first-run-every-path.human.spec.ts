// EVERY WAY THROUGH THE FIRST RUN, JUDGED THE WAY A CUSTOMER JUDGES IT.
//
// The release's own tests assert that strings exist. A string can exist and
// still run off the right edge of the window, sit below the fold with nothing
// visible to press, or label a button that does nothing. All three shipped.
//
// So this file asserts the four things a person actually experiences, on
// every screen the flow can put them on:
//
//   1. THERE IS ALWAYS A WAY ON. A screen with no enabled control is a dead
//      end, and two of them were release blocks in this cycle alone.
//   2. THERE IS SOMETHING TO READ. A card that renders under twenty readable
//      characters is a blank card, whatever the copy register says.
//   3. NOTHING IS CUT OFF. Text whose box ends past the viewport is text the
//      customer cannot read. The welcome card's first sentence was clipped at
//      every window size, including maximised at 1933px.
//   4. THE WAY ON IS VISIBLE. A primary control below the fold, on a screen
//      whose only purpose is to be answered, is a dead end that looks like a
//      bug in the mouse.
//
// Nothing here is stubbed. The rig's own webServers boot a real harness
// against a scratch data dir (playwright.config.ts) and every route is the
// route the app calls.
import type { Page } from "@playwright/test";

import { clippedText } from "./clipped-text";
import { expect, test } from "./fixtures";
import { HARNESS_URL, desktopHeaders } from "./rig";

/** The five ways to start, by the label a person reads. */
const JOBS = [
  "Brief me every morning",
  "Organise my day",
  "Make sense of these notes",
  "Look into something for me",
  "Help me run my business",
] as const;

/** Sizes a desktop customer actually has. The narrow one is a 13" laptop. */
const VIEWPORTS = [
  // Narrow first. The owner's clipped screenshot came from a window that was
  // ~1289 CSS px after Windows scaling, which is the 13in case below, and that
  // case is clean on Linux. So either the layout survives every width and the
  // difference is font metrics on Windows, or there is a width at which it
  // gives way. These find out rather than assume.
  { name: "800w", width: 800, height: 700 },
  { name: "1024w", width: 1024, height: 768 },
  { name: "1152w", width: 1152, height: 800 },
  { name: "13in", width: 1280, height: 800 },
  { name: "15in", width: 1440, height: 900 },
  { name: "1080p", width: 1920, height: 1080 },
] as const;

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
 * He is created by the RENDERER's first `GET /api/setup`, and `driveSetup` is
 * what appends each card. Posting answers in the moment after `goto` returns
 * beats that first poll: the checklist advances against a workspace with no
 * Chief in it, no card is ever said, and the transcript stays empty for ever
 * because the driver does nothing when nothing changed. A person cannot hit
 * that — you cannot answer a card that was never drawn — but a spec can, and
 * it reads on screen exactly like a flow that never arrived.
 */
async function chiefHasSpoken(app: Page): Promise<void> {
  await expect(
    app.getByText(/who am I working for/i),
    "the Chief must have asked before the checklist is driven",
  ).toBeVisible();
}

/**
 * One harness serves the whole file, so each test has to put the Chief's
 * question back rather than inherit whatever the last one answered. Reopening
 * is what the app itself does for "Something else", so this is a customer
 * path, not a back door.
 */
async function reachTheJobs(): Promise<void> {
  await harness("POST", "/api/setup/answer", { step: "hello", answer: "E2E Owner, e2e@example.invalid" });
  for (const step of ["detect", "flux"]) {
    const view = await harness("GET", "/api/setup");
    if (!stepOf(view, step)?.done) await harness("POST", "/api/setup/skip", { step });
  }
  if (stepOf(await harness("GET", "/api/setup"), "chat").done) {
    await harness("POST", "/api/setup/reopen", { step: "chat" });
  }
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

test.describe("every screen a customer can land on", () => {
  for (const size of VIEWPORTS) {
    test(`the flow is readable and answerable at ${size.name}`, async ({ app }) => {
      await app.setViewportSize({ width: size.width, height: size.height });
      await chiefHasSpoken(app);
      await reachTheJobs();
      await app.reload();
      await expect(app.getByRole("button", { name: new RegExp(JOBS[0], "i") })).toBeVisible();
      await screenIsUsable(app, `${size.name} · the Chief's question`);
    });
  }

  for (const job of JOBS) {
    test(`"${job}" leads somewhere, and lets a customer back out`, async ({ app }) => {
      await chiefHasSpoken(app);
      await reachTheJobs();
      await app.reload();

      const row = app.getByRole("button", { name: new RegExp(job, "i") });
      await expect(row, `${job}: the row must arrive pressable`).toBeEnabled();
      await row.click();

      // Whatever it asks for next — a connection, some typing, or the work
      // itself — the customer must be able to read it and act on it.
      await expect
        .poll(async () => stepOf(await harness("GET", "/api/setup"), "chat").done, {
          message: `${job}: choosing it must reach the server`,
        })
        .toBe(true);
      await screenIsUsable(app, `${job}: the screen after picking it`);

      // And they must be able to change their mind. This is the path that was
      // dead: the step reopens, and the rows have to come back with it.
      await harness("POST", "/api/setup/reopen", { step: "chat" });
      await expect(row, `${job}: after asking for something else, the list must be live`).toBeEnabled();
      await screenIsUsable(app, `${job}: back at the Chief's question`);
    });
  }
});

// A CHECK THAT CANNOT FAIL IS NOT A CHECK.
//
// These two controls hand `clippedText` something it MUST catch. They earned
// their keep twice: the first version of the check went green at three widths
// on a release with photographed clipping, and rewriting it to measure text
// ranges then made BOTH controls fail — which turned out to be the controls
// being wrong, not the check.
//
// THE LESSON IN THE BAIT. The old check measured an ELEMENT's box, so a
// `width:5000px` div with a short sentence in it tripped the check while the
// text inside it sat comfortably on screen. That is not clipping. Clipping is
// TEXT whose own painted line box crosses the right edge, so the bait has to
// start near that edge and run past it. Measuring the container proved
// nothing about what a reader can actually read.
const BAIT = "This sentence begins near the right edge and runs past it, which is what clipping actually is.";

test("the clipping check catches text that runs past the right edge", async ({ app }) => {
  await chiefHasSpoken(app);
  await app.evaluate((sentence) => {
    const bait = document.createElement("div");
    bait.textContent = sentence;
    bait.style.cssText = `position:fixed;top:0;left:${document.documentElement.clientWidth - 60}px;white-space:nowrap;z-index:99999`;
    document.body.appendChild(bait);
  }, BAIT);
  const found = await clippedText(app);
  expect(found.length, "the clipping check missed text starting 60px from the right edge").toBeGreaterThan(0);
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
  const found = await clippedText(app);
  expect(
    found.length,
    "the clipping check cannot see clipped prose once it contains markup — which is all real prose",
  ).toBeGreaterThan(0);
});

// THE SHIPPED CSS, NOT THE DEV CSS.
//
// Everything above this line measured a VITE DEV SERVER. The owner's clipped
// screenshot came from a PACKAGED build. Those are not the same stylesheet:
// in dev, Tailwind generates whatever a component asks for, while a
// production build scans source for class names and emits only what it finds.
// Any class assembled at runtime, or living in a path the scanner misses, is
// present in dev and silently absent from the artifact a customer installs.
// That produces exactly what we saw — perfect in every harness run, text off
// the edge on the real machine — and the same mechanism can drop any layout
// constraint anywhere in the app.
//
// The harness serves the built `dist` on its own origin, so navigating there
// runs the identical checks against the bytes that actually ship.
test.describe("the production build, which is what a customer installs", () => {
  for (const size of VIEWPORTS) {
    test(`the shipped CSS holds up at ${size.name}`, async ({ app }) => {
      await app.setViewportSize({ width: size.width, height: size.height });
      await app.goto(`${HARNESS_URL}/`);
      await chiefHasSpoken(app);
      await reachTheJobs();
      await app.goto(`${HARNESS_URL}/`);
      await expect(app.getByRole("button", { name: new RegExp(JOBS[0], "i") })).toBeVisible();
      await screenIsUsable(app, `production ${size.name} · the Chief's question`);
    });
  }
});
