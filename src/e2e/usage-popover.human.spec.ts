// The usage popover, MEASURED rather than asserted to fit.
//
// The three things about this control that no source contract and no pure
// function can see:
//
//   1. THAT IT OPENS ON HOVER AT ALL, and stays open while the pointer walks
//      into it. The thing it replaces was a `title` attribute, which needs
//      about a second of motionless hover and vanishes the moment you move
//      toward it — the user remembered it as a fly-out that had been deleted.
//   2. WHERE ITS BOX ACTUALLY LANDS. The chip sits in a cluster hard against
//      the right edge of the header, so "does it overflow the viewport" is a
//      question about a rectangle, not about a class name. This file reads the
//      rectangle at 1440x900, at a width where the header has had to give
//      the chip up to its More menu, and at 390x844.
//   3. THAT ESCAPE AND AN OUTSIDE CLICK CLOSE IT.
//
// The workspace has no engine and therefore no settled turn, so no seeded bot
// has any usage and the chip is correctly absent. `GET /api/bots` is
// intercepted to bank a turn onto the trader fixture's open task — the numbers
// are the ones measured live on a Claude bot, so the report under test is the
// five-line one.
import type { Page } from "@playwright/test";

import { FIXTURES } from "./rig";
import { expect, openSidebar, test } from "./fixtures";

/** Measured live: 4 turns, 313k in of which 300k was context re-read. */
const USAGE = { input: 313_000, output: 1_300, cachedInput: 300_000, costUsd: 0.42, turns: 4 };

/** Bank a settled turn onto the trader fixture's open task, in the answer the
 *  renderer reads, so the chip has something to say. */
const withBankedUsage = async (page: Page) => {
  await page.route("**/api/bots", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body?.bots)) return route.fulfill({ response });
    for (const bot of body.bots) {
      if (bot.name !== FIXTURES.smartTrader.name) continue;
      const tasks = Array.isArray(bot.tasks) && bot.tasks.length
        ? bot.tasks
        : [{ threadId: bot.threadId, title: "Task", createdAt: Date.now() }];
      bot.tasks = tasks.map((task: { threadId: string }) =>
        task.threadId === bot.threadId ? { ...task, usage: USAGE } : task,
      );
    }
    await route.fulfill({ json: body });
  });
  await page.reload();
};

const chip = (page: Page) => page.getByRole("button", { name: /^Usage: / });
const panel = (page: Page) => page.getByRole("group", { name: "Usage detail" });

const openTrader = async (page: Page) => {
  const sidebar = await openSidebar(page);
  await sidebar.getByText(FIXTURES.smartTrader.name, { exact: true }).click();
};

/** The measurement, printed into the report so a number is on the record
 *  rather than only a boolean. */
const measure = async (page: Page, label: string) => {
  const viewport = page.viewportSize()!;
  const box = await panel(page).boundingBox();
  expect(box, `${label}: the popover is not on screen at all`).not.toBeNull();
  const { x, y, width, height } = box!;
  // eslint-disable-next-line no-console
  console.log(
    `[usage popover] ${label} viewport ${viewport.width}x${viewport.height} → panel ${Math.round(width)}x${Math.round(height)} at (${Math.round(x)}, ${Math.round(y)}); right edge ${Math.round(x + width)}, bottom ${Math.round(y + height)}`,
  );
  expect(x, `${label}: left edge off screen`).toBeGreaterThanOrEqual(0);
  expect(y, `${label}: top edge off screen`).toBeGreaterThanOrEqual(0);
  expect(x + width, `${label}: ${Math.round(x + width)}px past a ${viewport.width}px viewport`).toBeLessThanOrEqual(
    viewport.width + 1,
  );
  expect(y + height, `${label}: taller than a ${viewport.height}px viewport`).toBeLessThanOrEqual(viewport.height + 1);
  // The page itself must not have grown a horizontal scrollbar either.
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, `${label}: the document scrolls sideways`).toBeLessThanOrEqual(viewport.width + 1);
  return box!;
};

test.describe("the token chip's popover", () => {
  test.beforeEach(async ({ app }, testInfo) => {
    // The mobile project's own viewport folds the chip out of the header
    // entirely; that case is measured explicitly below at 390x844 from the
    // desktop project, so running it twice proves nothing.
    test.skip(testInfo.project.name !== "desktop", "measured from the desktop project, at three widths");
    await withBankedUsage(app);
    await openTrader(app);
    await expect(chip(app)).toBeVisible({ timeout: 30_000 });
  });

  test("opens on hover, holds while the pointer is inside it, and closes on Escape", async ({ app }) => {
    await expect(panel(app)).toHaveCount(0);

    await chip(app).hover();
    await expect(panel(app)).toBeVisible();

    // THE `title` FAILURE, made impossible: move the pointer off the chip and
    // into the panel. A native tooltip is gone by now.
    await panel(app).getByText("All bots →").hover();
    await expect(panel(app)).toBeVisible();

    await app.keyboard.press("Escape");
    await expect(panel(app)).toHaveCount(0);
  });

  test("opens from the keyboard, with no pointer involved", async ({ app }) => {
    await chip(app).focus();
    await expect(panel(app)).toBeVisible();
    // The chip names the open panel, so a screen reader reads the breakdown.
    const described = await chip(app).getAttribute("aria-describedby");
    expect(described, "the chip does not name the panel").toBeTruthy();
    expect(await panel(app).getAttribute("id")).toBe(described);
  });

  test("closes on an outside click", async ({ app }) => {
    await chip(app).hover();
    await expect(panel(app)).toBeVisible();
    await app.mouse.move(20, 400);
    await app.mouse.click(20, 400);
    await expect(panel(app)).toHaveCount(0);
  });

  test("says all five lines, including the arithmetic and the cache caveat", async ({ app }) => {
    await chip(app).hover();
    const lines = await panel(app).locator("li").allInnerTexts();
    // eslint-disable-next-line no-console
    console.log(`[usage popover] report lines → ${JSON.stringify(lines)}`);
    expect(lines).toEqual([
      "4 turns",
      "313k in (300k cached) · 1.3k out",
      "14.3k tok new: the figure on the chip",
      "cached = context re-read each turn, not new text",
      expect.stringContaining("$0.42"),
    ]);
  });

  test("the chip's own click still opens the agent profile", async ({ app }) => {
    await chip(app).click();
    await expect(app.getByText("Skills", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  });

  test("fits the viewport at 1440x900, folded, and at 390x844", async ({ app }) => {
    // 1. The full chip, at the desktop viewport this project runs.
    await chip(app).hover();
    const wide = await measure(app, "1440x900, full chip");
    expect(wide.width).toBeGreaterThan(200);

    // 2. A narrower column. The header measures itself (U0-T1) and, before
    //    it would let the conversation name lose its track, moves the usage
    //    figure into its More menu — the chip is RELOCATED, not folded and not
    //    dropped. Where exactly that happens is a measurement, so this reads
    //    the header's own record of it rather than assuming a width: if the
    //    chip is still inline it must still open its popover inside the
    //    viewport; if it has moved, the same figure must be in the menu.
    await app.setViewportSize({ width: 760, height: 900 });
    await app.mouse.move(0, 0);
    await expect(panel(app)).toHaveCount(0);
    if (await chip(app).isVisible()) {
      await chip(app).hover();
      await measure(app, "760x900, chip still inline");
    } else {
      await app.getByRole("button", { name: "More actions", exact: true }).click();
      const item = app.getByRole("menu", { name: "More header actions" }).getByRole("menuitem", { name: /^Usage: / });
      await expect(item).toBeVisible();
      const text = await item.textContent();
      // eslint-disable-next-line no-console
      console.log(`[usage popover] 760x900 → chip relocated into the More menu as "${text?.trim()}"`);
      expect(text).toContain("14.3k tok");
      await app.keyboard.press("Escape");
    }

    // 3. A phone. The header gives the chip up to its menu long before this
    //    width, because the conversation's own name has no pixels to spare.
    //    Nothing left in the row to overflow.
    await app.setViewportSize({ width: 390, height: 844 });
    await app.mouse.move(0, 0);
    await expect(chip(app)).toHaveCount(0);
    await expect(panel(app)).toHaveCount(0);
    const scrollWidth = await app.evaluate(() => document.documentElement.scrollWidth);
    // eslint-disable-next-line no-console
    console.log(`[usage popover] 390x844 → chip relocated out of the header; document scrollWidth ${scrollWidth}`);
    expect(scrollWidth).toBeLessThanOrEqual(391);
  });
});

test.describe("a bot that is mid-turn", () => {
  test("says the figures are the last settled turn's", async ({ app }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "one width is enough for a copy assertion");
    await app.route("**/api/bots", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = await response.json().catch(() => null);
      if (!Array.isArray(body?.bots)) return route.fulfill({ response });
      for (const bot of body.bots) {
        if (bot.name !== FIXTURES.smartTrader.name) continue;
        // `usage` is banked once per SETTLED turn. A bot with a turn in flight
        // therefore shows the PREVIOUS turn's figures, and used to do so with
        // nothing at all marking them as previous.
        bot.busy = true;
        bot.activity = "working";
        const tasks = Array.isArray(bot.tasks) && bot.tasks.length
          ? bot.tasks
          : [{ threadId: bot.threadId, title: "Task", createdAt: Date.now() }];
        bot.tasks = tasks.map((task: { threadId: string }) =>
          task.threadId === bot.threadId ? { ...task, usage: USAGE } : task,
        );
      }
      await route.fulfill({ json: body });
    });
    await app.reload();
    await openTrader(app);
    await expect(chip(app)).toBeVisible({ timeout: 30_000 });
    await chip(app).hover();
    await expect(panel(app).getByText(/last settled turn/)).toBeVisible();
  });
});

test.describe("an engine that reports neither a cache nor a cost", () => {
  test("says so, instead of rendering a two-line stub", async ({ app }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "one width is enough for a copy assertion");
    await app.route("**/api/bots", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = await response.json().catch(() => null);
      if (!Array.isArray(body?.bots)) return route.fulfill({ response });
      for (const bot of body.bots) {
        if (bot.name !== FIXTURES.smartTrader.name) continue;
        const tasks = Array.isArray(bot.tasks) && bot.tasks.length
          ? bot.tasks
          : [{ threadId: bot.threadId, title: "Task", createdAt: Date.now() }];
        // Exactly what was measured live: "4 turns / 313k in · 1.3k out" and
        // nothing else — three of the five lines simply gone.
        bot.tasks = tasks.map((task: { threadId: string }) =>
          task.threadId === bot.threadId
            ? { ...task, usage: { input: 313_000, output: 1_300, costUsd: null, turns: 4 } }
            : task,
        );
      }
      await route.fulfill({ json: body });
    });
    await app.reload();
    await openTrader(app);
    await expect(chip(app)).toBeVisible({ timeout: 30_000 });
    await chip(app).hover();
    const lines = await panel(app).locator("li").allInnerTexts();
    // eslint-disable-next-line no-console
    console.log(`[usage popover] no-cache/no-cost report → ${JSON.stringify(lines)}`);
    expect(lines.length, "the report shrank back to a stub").toBe(4);
    await expect(panel(app).getByText(/no cached input reported/)).toBeVisible();
    await expect(panel(app).getByText(/no cost reported/)).toBeVisible();
  });
});
