// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Cloud home under its real page policy. A production build is served through the home's own secureHomeHtml
// (server/cloud-home/b1b-policy.ts), so every HTML response carries the exact header a Cloud home sends, including
// `require-trusted-types-for 'script'; trusted-types murage dompurify`, and the diagram frame gets the header the
// home's static route gives it. Two pages:
//   - a fixture built from src/e2e/fixtures/cloud-trusted-types: chat markdown, a highlighted code block, maths, a
//     mermaid diagram, the animated and still mascot, and an artifact preview frame;
//   - the whole app's own build, booted with no backend.
// Each must draw with no Trusted Types refusal and never reach the "stopped drawing" screen.
//
// Run: pnpm exec playwright test -c src/e2e/cloud-trusted-types.config.ts
import { test, expect, type Page } from "@playwright/test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { murageRenderPlugins } from "../../scripts/vite-render-plugin.ts";
import { HOME_PAGE_CSP, mermaidFrameCsp, secureHomeHtml } from "../../server/cloud-home/b1b-policy.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = "src/e2e/fixtures/cloud-trusted-types/index.html";
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm" };

let scratch: string;
const servers: Server[] = [];

/** Serves `dir` the way a Cloud home does: every response through secureHomeHtml, the diagram frame with its own header. */
async function serve(dir: string, indexFile: string): Promise<string> {
  const server = createServer((req, res) => {
    secureHomeHtml(res);
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    if (path.startsWith("/api/")) { res.writeHead(503, { "content-type": "application/json" }); return res.end("{}"); }
    const file = path === "/" ? join(dir, indexFile) : normalize(join(dir, path));
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      if (extname(path)) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
      res.writeHead(200, { "content-type": MIME[".html"] }); return res.end(readFileSync(join(dir, indexFile)));
    }
    const data = readFileSync(file);
    const headers: Record<string, string> = { "content-type": MIME[extname(file)] ?? "application/octet-stream" };
    if (/^\/mermaid-frame(?:-[0-9a-f]{16})?\.html$/.test(path)) headers["content-security-policy"] = mermaidFrameCsp(data);
    res.writeHead(200, headers); res.end(data);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Everything the page and its frames say went wrong: Trusted Types refusals above all. */
function watch(page: Page) {
  const problems: string[] = [];
  const violations: string[] = [];
  page.on("pageerror", error => problems.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (message.type() === "error") problems.push(`console: ${message.text()}`); });
  void page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", event => {
      (window as unknown as { __violations: string[] }).__violations ??= [];
      (window as unknown as { __violations: string[] }).__violations.push(`${event.effectiveDirective} ${event.blockedURI} ${event.sample}`);
    });
  });
  return {
    problems, violations,
    async trustedTypesRefusals() {
      const fromPage = await page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? []);
      violations.splice(0, violations.length, ...fromPage);
      return [...problems, ...fromPage].filter(line => /trusted ?types|TrustedHTML|TrustedScript|require-trusted-types-for/i.test(line));
    },
  };
}

test.beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "murage-trusted-types-")); });
test.afterAll(async () => {
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
  if (scratch) safeWipeSync(scratch);
});

test("the fixture's chat, maths, diagram, mascot and preview draw under the Cloud home's policy", async ({ page }) => {
  const out = join(scratch, "fixture");
  await build({
    configFile: false, root: repo, envFile: false, logLevel: "warn",
    resolve: { alias: { "@": join(repo, "src") } },
    define: { __MURAGE_COMMIT__: "null" },
    plugins: [react(), tailwindcss(), ...murageRenderPlugins()],
    build: { outDir: out, emptyOutDir: true, rollupOptions: { input: join(repo, FIXTURE) } },
  });
  expect(readdirSync(out).some(name => /^mermaid-frame-[0-9a-f]{16}\.html$/.test(name))).toBe(true);
  const origin = await serve(out, FIXTURE);
  const seen = watch(page);
  const response = await page.goto(origin);
  expect(response!.headers()["content-security-policy"]).toBe(HOME_PAGE_CSP);
  expect(HOME_PAGE_CSP).toContain("require-trusted-types-for 'script'; trusted-types murage dompurify");

  const chat = page.getByTestId("chat");
  try { await expect(chat.getByText("Weekly notes")).toBeVisible(); } catch (error) {
    await seen.trustedTypesRefusals();
    console.log([...seen.problems, ...seen.violations, await page.locator("body").innerText()].join("\n"));
    throw error;
  }
  await expect(chat.locator("strong", { hasText: "Bold" })).toBeVisible();
  await expect(chat.locator(".katex-display .katex")).toHaveCount(1);
  await expect(chat.locator(".chat-math-inline .katex")).toHaveCount(1);
  await expect(chat.locator(".katex-display .katex-mathml math")).toHaveCount(1);
  // the code block: highlighted where the highlighter can run, else the plain source; never a refusal
  await expect(chat.getByText("const total", { exact: false }).first()).toBeVisible();
  // the diagram draws in its sandboxed frame, under the frame header the home sends
  await expect(page.locator("[data-mermaid-state='drawn']")).toHaveCount(1, { timeout: 20_000 });
  await expect(page.frameLocator("iframe[title='Diagram']").locator("svg").first()).toBeVisible();
  // the mascot: its sanitized SVG body and clip still carry their shapes
  for (const id of ["avatar-animated", "avatar-still"]) {
    const svg = page.getByTestId(id).locator("svg").first();
    await expect(svg).toBeVisible();
    expect(await svg.evaluate(node => node.querySelectorAll("path, circle, ellipse, rect, polygon").length), id).toBeGreaterThan(0);
    expect(await svg.evaluate(node => node.querySelector("clipPath")?.childElementCount ?? 0), id).toBeGreaterThan(0);
  }
  // the preview frame: drawn, with its scripts, handlers and links gone
  const preview = page.frameLocator("[data-testid='preview']");
  await expect(preview.locator("#preview-title")).toHaveText("Report");
  await expect(preview.locator("script")).toHaveCount(0);
  await expect(preview.locator("[onclick]")).toHaveCount(0);
  await expect(preview.locator("a[href]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();

  await page.waitForTimeout(1500); // the mascot's animation and the service worker attempt run after load
  await expect(page.getByText("stopped drawing")).toHaveCount(0);
  expect(await seen.trustedTypesRefusals(), [...seen.problems, ...seen.violations].join("\n")).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("fixture.png"), fullPage: true });
});

test("the app's own build boots under the Cloud home's policy without a Trusted Types refusal", async ({ page }) => {
  test.setTimeout(240_000);
  const out = join(scratch, "app");
  await build({ configFile: join(repo, "vite.config.ts"), root: repo, logLevel: "warn", build: { outDir: out, emptyOutDir: true } });
  const origin = await serve(out, "index.html");
  const seen = watch(page);
  const response = await page.goto(origin);
  expect(response!.headers()["content-security-policy"]).toBe(HOME_PAGE_CSP);
  await expect(page.locator("#root > *").first()).toBeAttached({ timeout: 20_000 });
  await page.waitForTimeout(3000);
  await expect(page.getByText("stopped drawing")).toHaveCount(0);
  expect(await seen.trustedTypesRefusals(), [...seen.problems, ...seen.violations].join("\n")).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("app.png") });
});
