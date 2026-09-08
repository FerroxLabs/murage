// The intake, done by a browser the way a person does it.
//
// Everything else about this feature is provable from source and from pure
// functions. Three things are not, and all three are the reason this file
// exists:
//
//   1. HOW TALL THE CARD IS. Sean typed "hi" into a new bot and got a 1,379px
//      card on a 937px viewport, with the question and the close button pushed
//      off the top and no scrollbar anywhere. No unit test can see that.
//   2. WHAT IS TICKED WHEN IT ARRIVES. Eight pre-selected strangers, one press
//      from being installed.
//   3. THAT THE CARD LEAVES WHEN IT SHOULD, AND COMES BACK WHEN IT SHOULD —
//      the second without a reload.
import { desktopHeaders, FIXTURES, HARNESS_URL } from "./rig";
import { expect, openSidebar, test } from "./fixtures";
import type { Page } from "@playwright/test";

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${HARNESS_URL}${path}`, {
    method,
    headers: { ...(await desktopHeaders()), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

const QUESTION = "What do you mostly want help with?";

test("team descriptions explain the customer outcome in cards and previews", async ({ app }, testInfo) => {
  await expect(app.getByRole("button", { name: /^Open .+'s profile$/ }).first()).toBeVisible();
  await openSidebar(app);
  await app.getByRole("button", { name: "New or share", exact: true }).click();
  await app.getByRole("button", { name: "From Template", exact: true }).click();
  const library = app.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "Teams", exact: true }).click();
  await expect(library.getByText("66 teams", { exact: true })).toBeVisible();
  await library.getByRole("textbox", { name: "Search teams", exact: true }).fill("Cold Outbound");
  const description = "For businesses starting direct outreach to prospective customers. Define your audience and offer, then prepare personalized messages and follow-ups for your review.";
  const card = library.getByRole("article").filter({ has: app.getByRole("heading", { name: "Cold Outbound", exact: true }) });
  await expect(card.getByText(description, { exact: true })).toBeVisible();
  await app.screenshot({ path: testInfo.outputPath("team-description-card.png") });
  await card.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(app.getByRole("heading", { name: "Cold Outbound", exact: true })).toBeVisible();
  await expect(app.getByText(description, { exact: true })).toBeVisible();
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await app.screenshot({ path: testInfo.outputPath("team-description-preview.png") });
});

test("plus menu separates blank bots from specialist templates", async ({ app }, testInfo) => {
  await expect(app.getByRole("button", { name: /^Open .+'s profile$/ }).first()).toBeVisible();
  const before = (await api("GET", "/api/bots")).bots.length;
  await openSidebar(app);
  const trigger = app.getByRole("button", { name: "New or share", exact: true });
  await trigger.click();
  await expect(app.getByRole("button", { name: "Blank Bot", exact: true })).toBeVisible();
  await expect(app.getByRole("button", { name: "From Template", exact: true })).toBeVisible();
  await app.screenshot({ path: testInfo.outputPath("bot-creation-options.png") });
  await app.getByRole("button", { name: "Blank Bot", exact: true }).press("Escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await app.getByRole("button", { name: "From Template", exact: true }).click();
  const library = app.getByRole("dialog", { name: "Library", exact: true });
  await expect(library).toBeVisible();
  await expect(library.getByRole("tab", { name: "Bots", exact: true })).toHaveAttribute("aria-selected", "true");
  expect((await api("GET", "/api/bots")).bots.length).toBe(before);
  await app.screenshot({ path: testInfo.outputPath("specialist-templates.png") });
  await library.getByRole("button", { name: "Close teams", exact: true }).click();
  if (await app.getByRole("button", { name: "Open bot list" }).getAttribute("aria-expanded") !== "true") {
    await openSidebar(app);
  }
  await trigger.click();
  await app.getByRole("button", { name: "Blank Bot", exact: true }).click();
  await expect.poll(async () => (await api("GET", "/api/bots")).bots.length).toBe(before + 1);
});

const openBot = async (page: Page, name: string) => {
  // Wait for hydration to establish a selected conversation before opening
  // the drawer; its normal selection effect closes the drawer on hydration.
  await expect(page.getByRole("button", { name: /^Open .+'s profile$/ }).first()).toBeVisible();
  const sidebar = await openSidebar(page);
  await sidebar.getByText(name, { exact: true }).click();
  await expect(page.getByRole("button", { name: `Open ${name}'s profile` }).last()).toBeVisible();
  const menu = page.getByRole("button", { name: "Open bot list" });
  if (await menu.isVisible()) await expect(menu).toHaveAttribute("aria-expanded", "false");
};

const card = (page: Page) => page.getByTestId("bot-intake-card");

/** Setup is deliberately opened from the profile, never inserted as a second
 * input in the chat composer. These tests exercise that approved entry point. */
const openSetup = async (page: Page, name: string) => {
  await openBot(page, name);
  await page.getByRole("button", { name: `Open ${name}'s profile` }).first().click();
  await page.getByRole("button", { name: "Set up", exact: true }).click();
  await expect(card(page)).toBeVisible();
};

/** Type an answer and wait for the suggestion to settle. */
const ask = async (page: Page, answer: string) => {
  const input = page.getByRole("textbox", { name: QUESTION });
  await input.fill(answer);
  await page.getByRole("button", { name: "Find it" }).click();
  await expect(page.getByRole("button", { name: "Looking…" })).toHaveCount(0, { timeout: 15_000 });
};

/** THE C2 ASSERTION, in the only place it can honestly be made. */
const fitsTheViewport = async (page: Page) => {
  await card(page).scrollIntoViewIfNeeded();
  const viewport = page.viewportSize()!;
  const box = await card(page).boundingBox();
  expect(box, "the card is not on screen at all").not.toBeNull();
  expect(box!.height, `card ${box!.height}px on a ${viewport.height}px viewport`).toBeLessThan(viewport.height);
  expect(box!.y, "the top of the card is above the top of the screen").toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  // The question and the way out are both still reachable, whatever came back.
  await expect(card(page).getByText(QUESTION)).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide this question" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse agent profile" })).toBeInViewport();
};

test.describe("a brand new bot's deliberate profile setup", () => {
  test.beforeEach(async ({ app }) => {
    await openSetup(app, FIXTURES.blank.name);
  });

  test('"hi" is answered with nothing, honestly, inside the viewport', async ({ app }, testInfo) => {
    await ask(app, "hi");
    await fitsTheViewport(app);
    // THE HEADLINE BUG: eight pre-ticked skills. Now: none, of either kind.
    await expect(card(app).locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(card(app).getByText(/Nothing in the library clearly matches/)).toBeVisible();
    // One action, and it is not a dead end.
    await expect(card(app).getByRole("button", { name: "Browse the library" })).toBeVisible();
    const invite = app.getByRole("complementary", { name: "Let your bots pick the right model" });
    if (await invite.isVisible()) await invite.getByRole("button", { name: "Not now", exact: true }).last().click();
    await fitsTheViewport(app);
    await app.screenshot({ path: testInfo.outputPath("intake-profile-fit.png") });
  });

  test("filler and a typo get the same honest answer", async ({ app }) => {
    for (const answer of ["help me with stuff and things", "tradng"]) {
      await ask(app, answer);
      await fitsTheViewport(app);
      await expect(card(app).locator('input[type="checkbox"]:checked'), answer).toHaveCount(0);
      await expect(card(app).getByText(/Nothing in the library clearly matches/), answer).toBeVisible();
    }
  });

  test("a real answer names a profile, keeps the name, and still fits", async ({ app }) => {
    await ask(app, "trading");
    await fitsTheViewport(app);
    await expect(card(app).getByText("Smart Trader").first()).toBeVisible();
    // H5: the rename is opt-in, never the default.
    const keep = card(app).getByRole("checkbox", { name: /^Keep the name / });
    await expect(keep).toBeChecked();
    await expect(card(app).getByText(/Keeps the name .* and switches on/)).toBeVisible();
  });

  test("a pitch deck also fits, and so does a long list of loose skills", async ({ app }) => {
    for (const answer of ["I want help building a pitch deck", "chasing invoices"]) {
      await ask(app, answer);
      await fitsTheViewport(app);
      const boxes = card(app).locator('input[type="checkbox"]');
      // At most three loose skills, and NOT ONE OF THEM TICKED. (The profile
      // path renders one checkbox — the keep-the-name one — which is checked
      // by design; `.filter` below counts only the skill list's own.)
      const list = card(app).locator('label:has(input[type="checkbox"]) >> text=/.+/');
      expect(await boxes.count()).toBeLessThanOrEqual(4);
      void list;
      const skillBoxes = card(app).locator('div.divide-y input[type="checkbox"]');
      expect(await skillBoxes.count()).toBeLessThanOrEqual(3);
      await expect(card(app).locator('div.divide-y input[type="checkbox"]:checked')).toHaveCount(0);
      // The button counts what is ticked, so with nothing ticked it is dead.
      const add = card(app).getByRole("button", { name: /^Add \d+ skills? to /});
      if (await add.count()) await expect(add).toBeDisabled();
    }
  });
});

test.describe("a bot a person has already configured", () => {
  test("is not asked anything in its composer — no card, and no chip", async ({ app }) => {
    // Sable, in miniature: a title, a description, and no library skills.
    await openBot(app, FIXTURES.titledNoSkills.name);
    await expect(card(app)).toHaveCount(0);
    // And specifically not the collapsed chip that used to stand in for it.
    await expect(app.getByRole("button", { name: `Set ${FIXTURES.titledNoSkills.name} up` })).toHaveCount(0);
    // The composer's own input is the intake's; the transcript's seeded
    // greeting says the same words and is not this feature.
    await expect(app.getByRole("textbox", { name: QUESTION })).toHaveCount(0);
  });

  test("a fully-skilled bot is not asked either", async ({ app }) => {
    await openBot(app, FIXTURES.smartTrader.name);
    await expect(card(app)).toHaveCount(0);
    await expect(app.getByRole("textbox", { name: QUESTION })).toHaveCount(0);
  });
});

test.describe("setup is somewhere you go and ask for it", () => {
  test("reselecting the current bot closes the mobile drawer while row actions remain usable", async ({ app }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile drawer does not cover the desktop");
    await openBot(app, FIXTURES.blank.name);
    let sidebar = await openSidebar(app);
    const menu = app.getByRole("button", { name: "Open bot list" });
    await sidebar.getByText(FIXTURES.blank.name, { exact: true }).click();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    sidebar = await openSidebar(app);
    await sidebar.getByRole("button", { name: `Rename ${FIXTURES.blank.name}`, exact: true }).press("Enter");
    await expect(sidebar.getByRole("textbox", { name: "Rename", exact: true })).toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await sidebar.getByRole("textbox", { name: "Rename", exact: true }).press("Enter");
    await sidebar.getByRole("button", { name: `More actions for ${FIXTURES.blank.name}`, exact: true }).click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await app.keyboard.press("Escape");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await app.getByRole("button", { name: `Open ${FIXTURES.blank.name}'s profile` }).first().click();
    await expect(app.getByRole("button", { name: "Set up", exact: true })).toBeVisible();
  });

  test("profile setup stays inside a shrinking visual viewport", async ({ app }) => {
    await openSetup(app, FIXTURES.blank.name);
    await ask(app, "trading");
    await app.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", { configurable: true, get: () => 500 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect.poll(() => app.locator("#root").evaluate((element) => element.getBoundingClientRect().height)).toBe(500);
    await fitsTheViewport(app);
    const box = await card(app).boundingBox();
    // Match the existing normal-viewport bottom-edge allowance for fractional
    // CSS-pixel scroll rounding; root scrolling is independently forbidden.
    expect(box!.y + box!.height).toBeLessThanOrEqual(500 + 1);
    expect(await app.locator("#root").evaluate((element) => element.scrollTop)).toBe(0);
  });
  test("waits for the skill inventory before offering fresh setup", async ({ app }) => {
    const created = await api("POST", "/api/bots", { name: "E2E Loading Setup" });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    await app.route(`**/api/bots/${created.bot.id}/skills`, async (route) => {
      await waiting;
      await route.fulfill({ json: { skills: [] } });
    });
    try {
      await openBot(app, "E2E Loading Setup");
      await app.getByRole("button", { name: "Open E2E Loading Setup's profile" }).first().click();
      await expect(app.getByRole("button", { name: "Checking setup…", exact: true })).toBeDisabled();
      await expect(app.getByText("E2E Loading Setup is already set up", { exact: true })).toHaveCount(0);
      release();
      await app.getByRole("button", { name: "Set up", exact: true }).click();
      await expect(card(app)).toBeVisible();
    } finally {
      release();
      await api("DELETE", `/api/bots/${created.bot.id}`).catch(() => {});
    }
  });

  test("an unavailable skill inventory offers a real retry without claiming the bot is configured", async ({ app }) => {
    const created = await api("POST", "/api/bots", { name: "E2E Retry Setup" });
    let fail = true;
    await app.route(`**/api/bots/${created.bot.id}/skills`, (route) => route.fulfill(
      fail ? { status: 503, json: { error: "Fixture inventory unavailable" } } : { json: { skills: [] } },
    ));
    try {
      await openBot(app, "E2E Retry Setup");
      await app.getByRole("button", { name: "Open E2E Retry Setup's profile" }).first().click();
      await expect(app.getByRole("button", { name: "Retry skill check" })).toBeVisible();
      await expect(app.getByText("E2E Retry Setup is already set up", { exact: true })).toHaveCount(0);
      fail = false;
      await app.getByRole("button", { name: "Retry skill check" }).click();
      await app.getByRole("button", { name: "Set up", exact: true }).click();
      await expect(card(app)).toBeVisible();
    } finally {
      await api("DELETE", `/api/bots/${created.bot.id}`).catch(() => {});
    }
  });
  test("the profile offers it on every bot, and warns before it touches one", async ({ app }) => {
    // The composer entry is gone for a configured bot, so THIS is the way in.
    // If it were not here, removing the chip would have rebuilt the one-way
    // door the whole feature exists to remove.
    await openBot(app, FIXTURES.titledNoSkills.name);
    await app.getByRole("button", { name: `Open ${FIXTURES.titledNoSkills.name}'s profile` }).first().click();
    await expect(app.getByText("Set up this bot")).toBeVisible();
    await app.getByRole("button", { name: "Set up", exact: true }).click();
    // It has a title and a description, so it must say so before anything.
    await expect(app.getByText(`${FIXTURES.titledNoSkills.name} is already set up`)).toBeVisible();
    await expect(app.getByText(/its title/)).toBeVisible();
    await expect(app.getByText(/Existing skills are not removed/)).toBeVisible();
    // Cancel changes nothing.
    await app.getByRole("button", { name: "Cancel" }).click();
    await expect(app.getByText("Set up this bot")).toBeVisible();
    await expect(app.getByRole("textbox", { name: QUESTION })).toHaveCount(0);
    // Continue reaches the question, with the same keep-the-name default.
    await app.getByRole("button", { name: "Set up", exact: true }).click();
    await app.getByRole("button", { name: "Continue anyway" }).click();
    await expect(app.getByRole("textbox", { name: QUESTION })).toBeVisible();
  });

  test("profile setup stays available after the last skill is removed, WITHOUT A RELOAD", async ({ app }) => {
    // A separate blank bot with one skill makes the before/after inventory
    // visible without changing the configured profile fixtures.
    const created = await api("POST", "/api/bots", { name: "E2E Intake Returns" });
    const botId: string = created.bot.id;
    try {
      const added = await api("POST", `/api/bots/${botId}/skills/library`, { ids: ["chart-analysis"] });
      expect(added.installed.length).toBe(1);
      await openBot(app, "E2E Intake Returns");
      // One skill: nothing to ask.
      await expect(card(app)).toHaveCount(0);

      // Removed through the UI on purpose. That is the moment that has to
      // invalidate the renderer's cached count (M1); doing it over HTTP would
      // leave the cache untouched and prove nothing.
      await app.getByRole("button", { name: "Open E2E Intake Returns's profile" }).first().click();
      await app.getByRole("button", { name: "Set up", exact: true }).click();
      await expect(app.getByText(/1 skill it already has/)).toBeVisible();
      await app.getByRole("button", { name: "Cancel", exact: true }).click();
      const remove = app.getByRole("button", { name: "Remove chart-analysis" });
      await expect(remove).toBeVisible({ timeout: 15_000 });
      await remove.click();
      await expect(remove).toHaveCount(0, { timeout: 15_000 });

      // The profile entry reflects the new count without leaving the page.
      await app.getByRole("button", { name: "Set up", exact: true }).click();
      await expect(card(app)).toBeVisible();
      await expect(app.getByText("E2E Intake Returns is already set up", { exact: true })).toHaveCount(0);
      await expect(app.getByRole("textbox", { name: QUESTION })).toBeVisible();
    } finally {
      await api("DELETE", `/api/bots/${botId}`).catch(() => {});
    }
  });
});

test.describe("the phone", () => {
  test('says "Add this on your desktop" instead of firing a request that 404s', async ({ app }, testInfo) => {
    // The desktop project runs the same file; there the copy would be wrong,
    // and asserting it would be asserting a bug.
    test.skip(testInfo.project.name !== "mobile", "the phone's copy, on the phone project");

    // A NARROW WINDOW IS NOT A PHONE, and the card is right not to guess from
    // the viewport. `src/lib/surface.ts` asks the harness which door this
    // renderer came through, and on this rig the answer is honestly "desktop"
    // — the browser is on loopback. So the door's answer is what gets faked
    // here, which is exactly the seam under test.
    await app.route("**/api/config", async (route) => {
      const response = await route.fetch();
      const body = await response.json().catch(() => ({}));
      await route.fulfill({ json: { ...body, surface: "remote" } });
    });
    await app.reload();

    const deniedWrites: string[] = [];
    app.on("request", (request) => {
      if (request.method() !== "GET" && /\/api\/bots\/[^/]+\/(assistant-profile|skills)/.test(request.url())) deniedWrites.push(request.url());
    });

    await openSetup(app, FIXTURES.blank.name);
    await ask(app, "trading");
    await fitsTheViewport(app);
    await expect(card(app).getByText("Add this on your desktop")).toBeVisible();
    await expect(card(app).getByRole("button", { name: /^Set up .* as / })).toHaveCount(0);
    expect(deniedWrites).toEqual([]);
  });
});
