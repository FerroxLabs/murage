// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX overhaul slice 8, part 1, in a real browser: the shipped stylesheet and the shared focus trap, both palettes.
// It proves what the CSS tests can only read: the ring is drawn in the palette's focus colour, Tab stays inside a
// trapped panel and focus goes home on Escape, reduced motion turns the panel slide into a fade and holds the landing
// ring still, a touch screen gets 44 px targets, and axe finds nothing serious or critical. The doors themselves (Today,
// Needs you, Routines) are part 2 (a11y-doors.human.spec.ts, 1.0.14).
//
//   pnpm exec playwright test -c src/e2e/a11y-part1.config.ts
import { test, expect, type Page } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { axeScriptPath } from "./axe";

const root = fileURLToPath(new URL("../../", import.meta.url));
let server: ViteDevServer, origin: string, cache: string;

test.beforeAll(async () => {
  cache = mkdtempSync(join(tmpdir(), "murage-a11y-part1-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@", replacement: root + "/src" }] },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "a11y-part1-fixture",
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!(req.url === "/__a11y" || req.url?.startsWith("/__a11y?"))) return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accessibility check</title><body style="margin:0"><div id="root"></div><script type="module" src="/src/e2e/a11y-part1-fixture.ts"></script></body></html>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => {
  await server?.close();
  if (cache) safeWipeSync(cache);
});

async function open(page: Page, skin: "light" | "dark") {
  await page.goto(`${origin}/__a11y?skin=${skin}`);
  await page.waitForFunction(() => (window as unknown as { __a11yReady?: boolean }).__a11yReady === true);
}

/** A colour token as the browser resolves it, rgb(...) form, for comparing with computed styles. */
async function token(page: Page, name: string) {
  return page.evaluate((property) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${property})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

const style = (page: Page, selector: string, property: string, pseudo?: string) =>
  page.evaluate(([target, prop, pseudoElement]) => getComputedStyle(document.querySelector(target!)!, pseudoElement || null).getPropertyValue(prop!), [selector, property, pseudo ?? ""] as const);

for (const skin of ["light", "dark"] as const) {
  test.describe(`${skin} palette`, () => {
    test("axe finds nothing serious or critical, with the help panel open", async ({ page }) => {
      await open(page, skin);
      await page.click("#open");
      await page.addScriptTag({ path: axeScriptPath });
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (node: Element, options: object) => Promise<{ violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: unknown }> }> }> } }).axe;
        const result = await axe.run(document.body, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
        return result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical").map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
      });
      expect(violations).toEqual([]);
    });

    test("soft chips and marks paint from the palette's soft tokens", async ({ page }) => {
      await open(page, skin);
      expect(await style(page, "#chip", "background-color")).toBe(await token(page, "--color-warning-soft"));
      expect(await style(page, "#chip", "color")).toBe(await token(page, "--color-warning"));
      expect(await style(page, "#mark", "background-color")).toBe(await token(page, "--color-success-soft"));
      expect(await style(page, "#mark", "width")).toBe("32px");
    });

    test("the keyboard ring is the palette's focus colour, on buttons and on a hidden checkbox's label", async ({ page }) => {
      await open(page, skin);
      const focus = await token(page, "--color-focus");
      await page.keyboard.press("Tab");
      await expect(page.locator("#open")).toBeFocused();
      expect(await style(page, "#open", "outline-style")).toBe("solid");
      expect(await style(page, "#open", "outline-width")).toBe("2px");
      expect(await style(page, "#open", "outline-color")).toBe(focus);
      await page.focus("#tap");
      for (let i = 0; i < 8 && !(await page.evaluate(() => document.activeElement?.id === "sr")); i++) await page.keyboard.press("Tab");
      await expect(page.locator("#sr")).toBeFocused();
      expect(await style(page, "#sr-label", "outline-style")).toBe("solid");
      expect(await style(page, "#sr-label", "outline-color")).toBe(focus);
    });
  });
}

test("Tab stays inside a trapped panel, Escape closes it and focus goes home", async ({ page }) => {
  await open(page, "dark");
  await page.focus("#open");
  await page.keyboard.press("Enter");
  await expect(page.locator("#p-first")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#p-input")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#p-close")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#p-first")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#p-close")).toBeFocused();
  // a click on the page behind does not take the keyboard out of the panel
  await page.evaluate(() => (document.querySelector("#tap") as HTMLElement).focus());
  await expect(page.locator("#p-first")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#panel")).toBeHidden();
  await expect(page.locator("#open")).toBeFocused();
});

test("full motion: the panel slides and the landing ring fades", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open(page, "dark");
  await page.click("#open");
  expect(await style(page, "#panel", "animation-name")).toBe("help-panel-in");
  expect(await style(page, "#landing", "animation-name")).toBe("landing-fade");
});

test("reduced motion: the panel fades, the landing ring holds still, loaders pulse instead of spinning", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "light");
  await page.click("#open");
  expect(await style(page, "#panel", "animation-name")).toBe("fade-in");
  expect(await style(page, "#landing", "animation-name")).toBe("none");
  expect(await style(page, "#landing", "box-shadow")).toContain(await token(page, "--color-accent"));
  expect(await style(page, "#spin", "animation-name")).toBe("reduced-loader-pulse");
});

test.describe("touch screen", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("controls get 44 px, and an inline link's hit area reaches 44 px without moving it", async ({ page }) => {
    await open(page, "dark");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const tap = (await page.locator("#tap").boundingBox())!;
    expect(tap.height).toBeGreaterThanOrEqual(44);
    expect(tap.width).toBeGreaterThanOrEqual(44);
    expect(await style(page, "#inline-link", "height", "::before")).toBe("44px");
    const link = (await page.locator("#inline-link").boundingBox())!;
    expect(link.height).toBeLessThan(44);
    // a finger 20 px under the link's middle still lands on it
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.id ?? null, [link.x + link.width / 2, link.y + link.height / 2 + 20] as const);
    expect(hit).toBe("inline-link");
  });
});
