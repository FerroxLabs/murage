// Math and diagrams in a real chat bubble, in a real browser.
//
// The real ChatMarkdown renders in a vite fixture page that also carries a
// stand-in desktop bridge (window.muragebox), so the spec can prove a diagram
// frame cannot reach it. The diagram frame is the real /mermaid-frame.html
// built by scripts/vite-render-plugin.ts.
//
// katex, mermaid and dompurify are optional until they are installed in the
// workspace. MURAGE_RENDER_DEPS_DIR may name a folder whose node_modules holds
// them (for a lane that cannot install); without either, the tests that need
// them skip and the fallback test checks the source is shown instead.
import { test, expect, type Frame, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { murageRenderPlugins, OPTIONAL_RENDER_PACKAGES } from "../../scripts/vite-render-plugin.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const depsDir = process.env.MURAGE_RENDER_DEPS_DIR || undefined;
const resolvable = (name: string) => [repo, depsDir].some((base) => {
  if (!base) return false;
  try { createRequire(join(base, "package.json")).resolve(name); return true; } catch { return false; }
});
const haveDeps = OPTIONAL_RENDER_PACKAGES.every(resolvable);

let vite: ViteDevServer, origin: string, cache: string;

test.beforeAll(async () => {
  cache = mkdtempSync(join(tmpdir(), "murage-chat-render-"));
  vite = await createServer({
    configFile: false, root: repo, envFile: false, cacheDir: join(cache, "vite-cache"),
    resolve: { alias: { "@": join(repo, "src") } },
    server: { host: "127.0.0.1", watch: null, hmr: false, fs: { strict: !depsDir } },
    plugins: [react(), tailwindcss(), ...murageRenderPlugins({ depsDir }), {
      name: "chat-render-fixture",
      resolveId(id) { if (id === "/__render.js") return "\0chat-render-fixture"; },
      load(id) {
        if (id !== "\0chat-render-fixture") return;
        return `import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { ChatMarkdown } from '/src/components/ChatMarkdown.tsx';
          import '/src/styles.css';
          // what the preload bridge looks like to the app: a global on the top window
          window.muragebox = { saveFile: async () => 'bridge-reached', secret: 'bridge-secret' };
          const text = new URLSearchParams(location.search).get('text') ?? '';
          createRoot(document.getElementById('root')).render(React.createElement(ChatMarkdown, { text }));`;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/__render") return next();
          res.setHeader("content-type", "text/html");
          res.end('<!doctype html><html data-skin="dark"><meta name="viewport" content="width=device-width,initial-scale=1"><body class="bg-app text-ink"><div id="root" style="max-width:720px;padding:16px"></div><script type="module" src="/__render.js"></script></body></html>');
        });
      },
    }],
  });
  await vite.listen(0);
  const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("chat render fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await vite?.close(); if (cache) safeWipeSync(cache); });

const open = (page: Page, text: string) => page.goto(`${origin}/__render?text=${encodeURIComponent(text)}`);
const diagramFrame = async (page: Page): Promise<Frame> => {
  await expect.poll(() => page.frames().some((frame) => frame.url().endsWith("/mermaid-frame.html"))).toBe(true);
  return page.frames().find((frame) => frame.url().endsWith("/mermaid-frame.html"))!;
};
const pwned = (target: Page | Frame) => target.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned);

test("prices stay text and $$…$$ is KaTeX", async ({ page }) => {
  test.skip(!haveDeps, "katex/dompurify are not installed");
  await open(page, "Buy from $5 to $10, it costs $20 and $30.\n\n$$E=mc^2$$\n\nand inline \\(a^2+b^2\\) too.");
  await expect(page.getByText("Buy from $5 to $10, it costs $20 and $30.", { exact: true })).toBeVisible();
  await expect(page.locator(".katex-display .katex")).toHaveCount(1);
  await expect(page.locator(".chat-math-inline .katex")).toHaveCount(1);
  // KaTeX's stylesheet came from the app bundle, not a CDN: its rules apply
  expect(await page.locator(".katex-display").first().evaluate((node) => getComputedStyle(node).display)).toBe("block");
  // the MathML half survives DOMPurify for screen readers
  await expect(page.locator(".katex-display .katex-mathml math")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("math.png") });
});

test("trust is off: \\href and \\url in a formula link nowhere", async ({ page }) => {
  test.skip(!haveDeps, "katex/dompurify are not installed");
  await open(page, "$$\\href{javascript:window.__pwned=1}{click}$$\n\n$$\\url{javascript:alert(1)}$$");
  await expect(page.locator("a[href^='javascript']")).toHaveCount(0);
  expect(await pwned(page)).toBeUndefined();
});

test("a diagram draws inside a sandboxed, opaque-origin frame", async ({ page }) => {
  test.skip(!haveDeps, "mermaid/dompurify are not installed");
  await open(page, "Flow:\n\n```mermaid\nflowchart TD\n  A[Start] --> B{Is it?}\n  B -->|Yes| C[OK]\n```");
  const iframe = page.locator("iframe[title='Diagram']");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  expect(await iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
  const frame = await diagramFrame(page);
  await expect(page.frameLocator("iframe[title='Diagram']").locator("svg").first()).toBeVisible();
  await expect(page.locator("[data-mermaid-state='drawn']")).toHaveCount(1);
  expect((await iframe.boundingBox())!.height).toBeGreaterThan(40);
  // the frame is an opaque origin with no network
  expect(await frame.evaluate(() => self.origin)).toBe("null");
  expect(await frame.evaluate(() => fetch("/__render").then(() => "fetched", () => "blocked"))).toBe("blocked");
  // and it follows the skin
  expect(await frame.evaluate(() => document.documentElement.style.colorScheme)).toBe("dark");
  await page.evaluate(() => { document.documentElement.dataset.skin = "light"; });
  await expect.poll(() => frame.evaluate(() => document.documentElement.style.colorScheme)).toBe("light");
  await page.waitForTimeout(300);
  await page.screenshot({ path: test.info().outputPath("diagram-light.png") });
});

test("a hostile diagram runs nothing and cannot reach the app or its bridge", async ({ page }) => {
  test.skip(!haveDeps, "mermaid/dompurify are not installed");
  const attack = [
    "flowchart TD",
    '  A["<img src=x onerror=window.__pwned=1>"] --> B["<script>window.__pwned=2</script>"]',
    '  B --> C["<iframe src=javascript:parent.__pwned=3></iframe>"]',
    '  C --> D["<a href=javascript:window.__pwned=4>go</a>"]',
    '  click A href "javascript:window.__pwned=5"',
    "  click B call alert(6)",
    '  click C "javascript:window.__pwned=7"',
  ].join("\n");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "```mermaid\n" + attack + "\n```");
  const frame = await diagramFrame(page);
  const drawn = page.locator("[data-mermaid-state='drawn']");
  // strict mode may draw it (labels as text) or refuse it (source shown);
  // either way nothing runs
  await expect.poll(async () => (await drawn.count()) + (await page.getByText(/so here is its source/).count())).toBe(1);
  test.info().annotations.push({ type: "outcome", description: (await drawn.count()) ? "drawn" : "source shown" });
  console.log("hostile diagram outcome:", (await drawn.count()) ? "drawn" : "source shown");
  if (await drawn.count()) {
    await page.screenshot({ path: test.info().outputPath("hostile.png") });
    const body = page.frameLocator("iframe[title='Diagram']");
    for (const node of await body.locator("g.node").all()) await node.click({ force: true }).catch(() => {});
    await expect(body.locator("#diagram").locator("script, foreignObject, iframe, [onerror], [onclick], a[href], a[*|href]")).toHaveCount(0);
  }
  await page.waitForTimeout(500);
  expect(await pwned(page)).toBeUndefined();
  if (!frame.isDetached()) {
    expect(await pwned(frame)).toBeUndefined();
    // the bridge, the app DOM, cookies and storage are all out of reach
    expect(await frame.evaluate(() => { try { return typeof (window.parent as unknown as { muragebox?: unknown }).muragebox; } catch { return "blocked"; } })).toBe("blocked");
    expect(await frame.evaluate(() => { try { return window.parent.document ? "reached" : "none"; } catch { return "blocked"; } })).toBe("blocked");
    expect(await frame.evaluate(() => { try { return document.cookie; } catch { return "blocked"; } })).toBe("blocked");
    expect(await frame.evaluate(() => { try { return String(localStorage.length); } catch { return "blocked"; } })).toBe("blocked");
    expect(await frame.evaluate(() => typeof (window as unknown as { muragebox?: unknown }).muragebox)).toBe("undefined");
    // a message forged from inside the frame cannot resize past the bound or inject anything
    await frame.evaluate(() => {
      window.parent.postMessage({ type: "murage-mermaid:rendered", id: 1, height: 1e9, html: "<img src=x onerror=parent.__pwned=8>" }, "*");
      window.parent.postMessage("<img src=x onerror=parent.__pwned=9>", "*");
    });
    await page.waitForTimeout(300);
    expect(await pwned(page)).toBeUndefined();
    const box = await page.locator("iframe[title='Diagram']").boundingBox().catch(() => null);
    if (box) expect(box.height).toBeLessThanOrEqual(4000);
  }
  expect(await page.evaluate(() => (window as unknown as { muragebox: { secret: string } }).muragebox.secret)).toBe("bridge-secret");
  expect(errors.filter((message) => /pwned/.test(message))).toEqual([]);
});

test("the frame page refuses to work unless it is sandboxed", async ({ page }) => {
  const response = await page.goto(`${origin}/mermaid-frame.html`);
  expect(response!.headers()["content-security-policy"]).toBe("sandbox allow-scripts");
  const meta = await page.locator("meta[http-equiv='Content-Security-Policy']").getAttribute("content");
  expect(meta).toContain("default-src 'none'");
  expect(meta).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
  expect(meta).toContain("img-src data:");
  expect(meta).not.toMatch(/https?:|unsafe-eval|connect-src/);
  // opened directly, the header still makes it an opaque origin
  expect(await page.evaluate(() => self.origin)).toBe("null");
});

test("a diagram that cannot be drawn shows its source with a note", async ({ page }) => {
  await open(page, "```mermaid\nflowchart TD\n  A --> \n  this is not mermaid ((((\n```\n\nand $5 to $10 stays text");
  await expect(page.getByText(haveDeps ? "This diagram could not be drawn, so here is its source." : "Diagrams are not available in this version, so here is the source.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("this is not mermaid ((((")).toBeVisible();
  await expect(page.locator("iframe[title='Diagram']")).toHaveCount(0);
  await expect(page.getByText("and $5 to $10 stays text", { exact: true })).toBeVisible();
});
