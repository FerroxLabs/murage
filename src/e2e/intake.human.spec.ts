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
import { DESKTOP_HEADERS, FIXTURES, HARNESS_URL } from "./rig";
import { expect, openSidebar, test } from "./fixtures";
import type { Page } from "@playwright/test";

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${HARNESS_URL}${path}`, {
    method,
    headers: { ...DESKTOP_HEADERS, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

const QUESTION = "What do you mostly want help with?";

const openBot = async (page: Page, name: string) => {
  const sidebar = await openSidebar(page);
  await sidebar.getByText(name, { exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true }).or(page.getByText(name).first())).toBeVisible();
};

const card = (page: Page) => page.getByTestId("bot-intake-card");

/** Type an answer and wait for the suggestion to settle. */
const ask = async (page: Page, answer: string) => {
  const input = page.getByRole("textbox", { name: QUESTION });
  await input.fill(answer);
  await page.getByRole("button", { name: "Find it" }).click();
  await expect(page.getByRole("button", { name: "Looking…" })).toHaveCount(0, { timeout: 15_000 });
};

/** THE C2 ASSERTION, in the only place it can honestly be made. */
const fitsTheViewport = async (page: Page) => {
  const viewport = page.viewportSize()!;
  const box = await card(page).boundingBox();
  expect(box, "the card is not on screen at all").not.toBeNull();
  expect(box!.height, `card ${box!.height}px on a ${viewport.height}px viewport`).toBeLessThan(viewport.height);
  expect(box!.y, "the top of the card is above the top of the screen").toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  // The question and the way out are both still reachable, whatever came back.
  await expect(card(page).getByText(QUESTION)).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide this question" })).toBeVisible();
};

test.describe("a brand new bot", () => {
  test.beforeEach(async ({ app }) => {
    await openBot(app, FIXTURES.blank.name);
    await expect(card(app)).toBeVisible();
  });

  test('"hi" is answered with nothing, honestly, inside the viewport', async ({ app }) => {
    await ask(app, "hi");
    await fitsTheViewport(app);
    // THE HEADLINE BUG: eight pre-ticked skills. Now: none, of either kind.
    await expect(card(app).locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(card(app).getByText(/Nothing in the library clearly matches/)).toBeVisible();
    // One action, and it is not a dead end.
    await expect(card(app).getByRole("button", { name: "Browse the library" })).toBeVisible();
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

  // FIXME — blocked on a defect OUTSIDE this behaviour, reported rather than
  // worked around. Driven by hand and by this spec, the "Remove <skill>"
  // control inside the profile panel issues NO `DELETE /api/bots/:id/skills/:name`
  // at all on a freshly opened panel (a network log over the whole click shows
  // only the `GET .../skills` re-reads). The same route removes every skill
  // instantly when called directly, so the route is fine and the row's own
  // handler is not. Everything this test needs on the intake side is in place —
  // `invalidateSkillCount(botId)` now fires on removal (M1), which is what lets
  // the composer card return with no reload — and this test is the thing that
  // will prove it the moment the row is fixed.
  test.fixme("the card comes back when the last skill is removed, WITHOUT A RELOAD", async ({ app }) => {
    // Its own fixture, so the seeded ones stay intact. Deliberately a BLANK
    // bot given one loose skill rather than a whole profile: applying a
    // profile also writes a title and a description, and a bot with those is
    // configured — the composer correctly stays quiet for it forever, and
    // setup moves to its profile panel. The only agent whose card can come
    // back is one whose ONLY configuration was the skill.
    const created = await api("POST", "/api/bots", { name: "E2E Intake Returns" });
    const botId: string = created.bot.id;
    try {
      const added = await api("POST", `/api/bots/${botId}/skills/library`, { ids: ["chart-analysis"] });
      expect(added.installed.length).toBe(1);
      await app.reload();
      await openBot(app, "E2E Intake Returns");
      // One skill: nothing to ask.
      await expect(card(app)).toHaveCount(0);

      // Removed through the UI on purpose. That is the moment that has to
      // invalidate the renderer's cached count (M1); doing it over HTTP would
      // leave the cache untouched and prove nothing.
      await app.getByRole("button", { name: "Open E2E Intake Returns's profile" }).first().click();
      const remove = app.getByRole("button", { name: "Remove chart-analysis" });
      await expect(remove).toBeVisible({ timeout: 15_000 });
      await remove.click();
      await expect(remove).toHaveCount(0, { timeout: 15_000 });

      // Back to the conversation. No reload since the skill was installed.
      await app.keyboard.press("Escape");
      await expect(card(app)).toBeVisible({ timeout: 20_000 });
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

    await openBot(app, FIXTURES.blank.name);
    await expect(card(app)).toBeVisible();
    await ask(app, "trading");
    await fitsTheViewport(app);
    await expect(card(app).getByText("Add this on your desktop")).toBeVisible();
    await expect(card(app).getByRole("button", { name: /^Set up .* as / })).toHaveCount(0);
  });
});
