// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, type Locator } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Jimp, intToRGBA } from "jimp";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

// These pixel checks use a fine pointer and CSS-pixel screenshots in both projects.
test.use({ hasTouch: false, deviceScaleFactor: 1, launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

// Renderer-only fixture: the real stylesheet, compiled by Tailwind, with
// ordinary scrollers, the opt-in class and native textareas in both skins.
// No harness, provider or user data is involved.
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  cache = mkdtempSync(join(tmpdir(), "murage-scrollbars-"));
  const rows = Array.from({ length: 40 }, (_, i) => `<button style="display:block;width:100%;height:32px;text-align:left">Skill ${i + 1}</button>`).join("");
  const skins = ["dark", "light"].map(skin => `<section data-skin="${skin}" style="padding:16px;background:var(--color-panel);color:var(--color-ink);min-width:0;border-radius:12px">
    <h1>${skin}</h1>
    <div aria-label="${skin} topics" tabindex="0" style="overflow:auto;height:120px;margin:12px 0">${rows}</div>
    <div class="thin-scroll" aria-label="${skin} skills" tabindex="0" style="overflow:auto;height:120px;margin:12px 0">${rows}</div>
    <textarea aria-label="${skin} instructions" style="display:block;resize:none;overflow:auto;width:100%;height:120px;background:var(--color-inset);color:var(--color-ink)">${"Instructions\n".repeat(40)}</textarea>
    <pre aria-label="${skin} files" tabindex="0" style="overflow:auto;height:60px;margin-top:12px"><code>${"File content ".repeat(70)}</code></pre>
  </section>`).join("");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  server = await createServer({ configFile: false, envFile: false, cacheDir: cache, root,
    resolve: { alias: { "@": join(root, "src") } },
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: { host: "127.0.0.1", hmr: false, watch: null },
    plugins: [tailwindcss(), { name: "scrollbar-fixture", configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url !== "/__scrollbars") return next();
        res.setHeader("content-type", "text/html");
        res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><script type="module">import '/src/styles.css';</script><main style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px">${skins}</main>`);
      });
    } }],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No scrollbar fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); if (cache) safeWipeSync(cache); });

const metrics = (el: Locator) => el.evaluate(element => {
  const style = (pseudo: string) => getComputedStyle(element, pseudo);
  const thumb = style("::-webkit-scrollbar-thumb");
  const bar = style("::-webkit-scrollbar");
  return {
    standardWidth: getComputedStyle(element).scrollbarWidth,
    standardColor: getComputedStyle(element).scrollbarColor,
    width: bar.width, height: bar.height,
    thumbColor: thumb.backgroundColor, border: thumb.borderTopWidth,
    borderColor: thumb.borderTopColor, clip: thumb.backgroundClip, radius: thumb.borderTopLeftRadius,
    track: style("::-webkit-scrollbar-track").backgroundColor,
    corner: style("::-webkit-scrollbar-corner").backgroundColor,
    arrows: style("::-webkit-scrollbar-button").display,
  };
});

for (const [width, height] of [[1040, 780], [700, 520]]) {
  test(`4px token-colored pills on every scroller at ${width}x${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/__scrollbars`);
    await page.mouse.move(0, 0);
    for (const skin of ["dark", "light"]) {
      const token = skin === "dark" ? "rgb(92, 92, 92)" : "rgb(179, 179, 179)";
      for (const name of ["topics", "skills", "instructions", "files"]) {
        const scroller = page.getByLabel(`${skin} ${name}`, { exact: true });
        await expect.poll(() => metrics(scroller)).toEqual({
          standardWidth: "auto", standardColor: "auto", width: "10px", height: "10px",
          thumbColor: token, border: "3px", borderColor: "rgba(0, 0, 0, 0)", clip: "content-box", radius: "999px",
          track: "rgba(0, 0, 0, 0)", corner: "rgba(0, 0, 0, 0)", arrows: "none",
        });
        const gutter = await scroller.evaluate((element, horizontal) => {
          const box = element.getBoundingClientRect();
          return horizontal ? box.height - element.clientHeight : box.width - element.clientWidth;
        }, name === "files");
        expect(gutter, `${skin} ${name}: the scrollbar is actually drawn`).toBe(10);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`scrollbars-${width}x${height}.png`), fullPage: true });
  });
}

test("hover brightens the thumb in both skins and keyboard scrolling keeps a visible focus", async ({ page }, info) => {
  await page.goto(`${origin}/__scrollbars`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  for (const skin of ["dark", "light"]) {
    const scroller = page.getByLabel(`${skin} skills`, { exact: true });
    await page.mouse.move(0, 0);
    const idle = (await metrics(scroller)).thumbColor;
    await scroller.hover({ position: { x: 20, y: 20 } });
    // Pin the CSS state directly: headless Chromium may leave host :hover
    // unset for a scrollbar-only rule. The thumb below uses real mouse input.
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[aria-label="${skin} skills"]` });
    await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
    await expect.poll(async () => (await metrics(scroller)).thumbColor).not.toBe(idle);
    // Point at the thumb itself, inside the transparent grab area.
    const box = (await scroller.boundingBox())!;
    const pixel = async () => {
      const screenshot = await Jimp.read(await page.screenshot());
      const { r, g, b } = intToRGBA(screenshot.getPixelColor(Math.floor(box.x + box.width - 5), Math.floor(box.y + 12)));
      const strip = Array.from({ length: 10 }, (_, i) => intToRGBA(screenshot.getPixelColor(Math.floor(box.x + box.width - 10) + i, Math.floor(box.y + 12))));
      return { color: [r, g, b], width: strip.filter(color => color.r === r && color.g === g && color.b === b).length };
    };
    const base = skin === "dark" ? 92 : 179;
    const mix = (white: number) => Array(3).fill(Math.round(base * (1 - white) + 255 * white));
    await expect.poll(pixel).toEqual({ color: mix(.15), width: 4 });
    await page.mouse.move(box.x + box.width - 5, box.y + 12);
    // Native scrollbar pseudo-states are painted but aren't exposed by
    // getComputedStyle, so check the actual thumb pixel instead.
    await expect.poll(pixel).toEqual({ color: mix(.30), width: 4 });
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 5, box.y + 70, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    await page.keyboard.press("Tab"); // switch focus-visible to keyboard modality
    await scroller.focus();
    await expect(scroller).toBeFocused();
    await expect(scroller).toHaveCSS("outline-style", "solid");
    await expect(scroller).toHaveCSS("outline-width", "2px");
    await page.keyboard.press("End");
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const files = page.getByLabel(`${skin} files`, { exact: true });
    await files.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => files.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  }
  await cdp.detach();
  await page.screenshot({ path: info.outputPath("scrollbar-focus.png"), fullPage: true });
});

test("coarse primary pointers retain native scrollbars", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 700, height: 520 } });
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/__scrollbars`);
    for (const skin of ["dark", "light"]) {
      const scroller = page.getByLabel(`${skin} skills`, { exact: true });
      await expect.poll(async () => (await metrics(scroller)).standardWidth).toBe("auto");
      expect((await metrics(scroller)).width).toBe("auto");
    }
  } finally { await context.close(); }
});
