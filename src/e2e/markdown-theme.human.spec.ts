import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-markdown-theme-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", hmr: false, watch: null },
    plugins: [tailwindcss(), { name: "markdown-theme-fixture",
      resolveId(id) { if (id === "/__markdown.js") return "\0markdown-theme"; },
      load(id) {
        if (id !== "\0markdown-theme") return;
        const text = "```markdown\n# Readable code\nWorking code. Bounded scope. Verified outcomes.\n- Preserve the user request\n```";
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {ChatMarkdown} from '/src/components/ChatMarkdown.tsx';import '/src/styles.css';const text=${JSON.stringify(text)};createRoot(document.getElementById('root')).render(React.createElement('div',{},...['light','dark'].map(skin=>React.createElement('section',{'data-skin':skin,'data-testid':skin,style:{background:'var(--color-app)',color:'var(--color-ink)',padding:24}},React.createElement('h2',{},skin),React.createElement(ChatMarkdown,{text})))));`;
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/__markdown") return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__markdown.js"></script>');
      }); },
    }] });
  await server.listen(0); const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); rmSync(cache, { recursive: true, force: true }); });
test("highlighted code and selection remain readable in both skins and cached skin changes", async ({ page }, info) => {
  await page.goto(origin + "/__markdown");
  for (const skin of ["light", "dark"]) {
    const sample = page.getByTestId(skin);
    await expect(sample.locator(".shiki")).toBeVisible();
    const result = await sample.evaluate(element => {
      const token = [...element.querySelectorAll(".shiki span")].find(node => node.textContent === "Working code. Bounded scope. Verified outcomes.")!;
      const css = getComputedStyle(token);
      const bg = getComputedStyle(element.querySelector(".bg-inset")!).backgroundColor;
      const luminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      const a = luminance(css.color), b = luminance(bg);
      return { color: css.color, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), selectionColor: getComputedStyle(token, "::selection").color, inkColor: getComputedStyle(element).color };
    });
    expect(result.ratio).toBeGreaterThanOrEqual(4.5);
    expect(result.selectionColor).toBe(result.inkColor);
  }
  const light = page.getByTestId("light"); const before = await light.locator(".shiki").innerHTML();
  await light.evaluate(element => { element.setAttribute("data-skin", "dark"); });
  await expect(light.locator(".shiki")).toHaveCSS("color-scheme", "dark");
  expect(await light.locator(".shiki").innerHTML()).toBe(before);
  await light.evaluate(element => { element.setAttribute("data-skin", "light"); });
  await page.screenshot({ path: info.outputPath("code-both-skins.png"), fullPage: true });
});
