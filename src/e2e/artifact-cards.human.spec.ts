// INLINE1 browser proof: a "Saved file" card in the chat shows the thing.
//
// A real fake-engine harness (launchVerificationServer) owns a bot, its
// workspace and six registered saved versions — a PNG, a WAV, a Markdown
// report, a JSON file, an HTML report and a PDF. A Vite fixture renders the
// real ArtifactCards inside the real StoreProvider against that harness, so
// the image and the player read their bytes through the real capability
// route (F5-T1, U-03) and the documents through the real preview route.
// Nothing here touches ~/.murage, a provider or the network.
//
// Proves, in a real browser at phone and desktop widths in both skins: the
// image is in the card and opens the shared lightbox in place; the WAV is a
// player that does not autoplay; the Markdown report is rendered, bounded,
// and Show more reveals the rest; the JSON is a code block; the HTML report
// is a protected frame; the PDF keeps today's buttons; no card has a Preview
// button; every byte request carries a capability and none goes to the
// download route; and nothing ever navigates to the Files section.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import type { Artifact } from "../../shared/artifacts.ts";

interface Fixture { info: { url: string; dataDir: string; logPath: string }; close(): Promise<void> }
type Launcher = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<Fixture>;

/** A solid-colour RGB PNG, so the fixture image has known dimensions. */
function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** 16-bit mono PCM at 8 kHz: a real, decodable WAV. */
function wav(seconds: number, hz: number): Buffer {
  const rate = 8000, samples = rate * seconds, data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * index) / rate) * 8000), index * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const REPORT_TAIL = "INLINE1_TAIL_SENTENCE: this line is only reachable after Show more.";
const REPORT = ["# Weekly report", "", "INLINE1_HEAD_SENTENCE: three verified findings.", "",
  ...Array.from({ length: 160 }, (_, index) => `- Finding ${index + 1}: ${"detail ".repeat(6)}`), "", REPORT_TAIL, ""].join("\n");
const DATA = JSON.stringify({ inline1Key: "INLINE1_JSON_VALUE", rows: [1, 2, 3] }, null, 2);
const HTML = "<!doctype html><style>body{font:18px system-ui;padding:24px;color:#173047}</style><h1>Nightly report</h1><p>INLINE1_HTML_RESULT: rendered inside the card.</p>";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

let fixture: Fixture, vite: ViteDevServer, origin: string, headers: Record<string, string>;
const saved: Record<string, Artifact> = {};

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
  return await response.json() as any;
}

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as { launchVerificationServer: Launcher };
  fixture = await launchVerificationServer(process.env);
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const bot = (await api("/api/bots", "POST", { name: "Inline cards bot", modelSelection: { instanceId: "verification", model: "sonnet" } })).bot as { id: string; threadId: string };
    // The default workspace root for a bot; the harness resolves it itself.
    mkdirSync(join(fixture.info.dataDir, "workspaces", bot.id, "outputs"), { recursive: true });
    const workspace = (await api(`/api/artifacts/workspace?botId=${bot.id}&threadId=${bot.threadId}`)).path as string;
    const files: Record<string, [string, Buffer | string]> = {
      image: ["outputs/chart.png", png(900, 600, [200, 60, 160])],
      audio: ["outputs/narration.wav", wav(2, 440)],
      markdown: ["outputs/weekly-report.md", REPORT],
      code: ["outputs/data.json", DATA],
      html: ["outputs/nightly.html", HTML],
      pdf: ["outputs/deck.pdf", PDF],
    };
    for (const [key, [relativePath, bytes]] of Object.entries(files)) {
      writeFileSync(join(workspace, relativePath), bytes);
      saved[key] = (await api("/api/artifacts/register", "POST", { botId: bot.id, threadId: bot.threadId, relativePath, name: `Saved ${key}` })).artifact as Artifact;
    }
    const ids = Object.values(saved).map(artifact => artifact.id);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "artifact-cards-vite-cache"), resolve: { alias: { "@": join(root, "src") } },
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } }, plugins: [react(), tailwindcss(), {
        name: "artifact-cards-fixture", resolveId(id) { if (id === "/__cards.js") return "\0artifact-cards"; },
        load(id) { if (id !== "\0artifact-cards") return; return `
          import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider} from '/src/state/store.tsx';import {ArtifactCards} from '/src/components/ArtifactCards.tsx';import '/src/styles.css';
          window.__openFiles=0;window.addEventListener('murage:open-files',()=>{window.__openFiles++;});
          createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(StoreProvider,null,React.createElement('section',{'aria-label':'Chat bubble',className:'rounded-2xl border border-hairline/40 bg-panel p-4 text-ink'},React.createElement('p',{className:'text-[14px]'},'I saved the files you asked for.'),React.createElement(ArtifactCards,{ids:${JSON.stringify(ids)}})))));`; },
        // The app pins the document and scrolls the transcript inside its pane;
        // the fixture lets the document scroll so one full-page screenshot is
        // the whole set of cards.
        configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/__cards") return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:auto!important;overflow:visible!important}</style><body style="margin:0;background:var(--color-app);color:var(--color-ink)"><main id="root" style="max-width:760px;margin:0 auto;padding:16px"></main><script type="module" src="/__cards.js"></script>'); }); },
      }] });
    await vite.listen(Number(process.env.MURAGE_E2E_UI_PORT) || 0);
    const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("No artifact-cards fixture port");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

const card = (page: Page, key: string) => page.locator(`[data-artifact-id="${saved[key]!.id}"]`);

async function open(page: Page, width: number, skin: string) {
  await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); });
  await page.goto(origin + "/__cards");
  await page.evaluate(value => { document.documentElement.dataset.skin = value; }, skin);
  await expect(page.locator("[data-artifact-id]")).toHaveCount(6);
  await expect(page.locator('[data-artifact-inline="loading"]')).toHaveCount(0, { timeout: 15_000 });
}

for (const width of [390, 1200]) for (const skin of ["light", "dark"]) test(`every saved file shows the thing in its card at ${width}px ${skin}`, async ({ page }, testInfo) => {
  const byteRequests: string[] = [], downloadRequests: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/media/bytes/")) byteRequests.push(url.pathname + url.search);
    if (/\/api\/artifacts\/[^/]+\/download$/.test(url.pathname)) downloadRequests.push(url.pathname);
  });
  await open(page, width, skin);

  // The image is in the card and reads the capability route the harness issued.
  const image = card(page, "image");
  const thumb = image.getByRole("button", { name: "Enlarge image Saved image" });
  await expect(thumb).toBeVisible();
  const src = await thumb.locator("img").getAttribute("src");
  expect(src).toMatch(/^\/api\/media\/bytes\/ma1_[A-Za-z0-9_-]{32}\?cap=mc1\./);
  await expect.poll(() => thumb.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(900);
  await expect(image.locator('[data-artifact-inline="image"]')).toBeVisible();

  // The WAV is a player, silent until asked; the "unavailable" note is gone.
  const audio = card(page, "audio");
  await expect(audio.locator("[data-media-player=audio]")).toBeVisible();
  const element = audio.locator("audio");
  await expect(element).toHaveAttribute("preload", "metadata");
  expect(await element.evaluate((node: HTMLMediaElement) => node.paused)).toBe(true);
  expect(await element.evaluate((node: HTMLMediaElement) => node.getAttribute("src"))).toMatch(/^\/api\/media\/bytes\/ma1_[A-Za-z0-9_-]{32}\?cap=mc1\./);
  await expect(audio).not.toContainText("Preview is unavailable");

  // The Markdown report is rendered, bounded, and Show more reveals the rest.
  const markdown = card(page, "markdown");
  await expect(markdown.locator('[data-artifact-inline="markdown"]')).toContainText("INLINE1_HEAD_SENTENCE: three verified findings.");
  await expect(markdown.locator('[data-artifact-inline="markdown"]').getByText("Weekly report", { exact: true })).toBeVisible();
  await expect(markdown).not.toContainText(REPORT_TAIL);
  await expect(markdown).toContainText(/Showing the first \d+ KB of \d+ KB/);
  await expect(markdown.getByRole("button", { name: "Show more", exact: true })).toBeVisible();

  // The JSON is a code block; the HTML report is a protected frame in the card.
  await expect(card(page, "code").locator('[data-artifact-inline="code"] pre')).toContainText("INLINE1_JSON_VALUE");
  await expect(page.frameLocator('iframe[title="Preview Saved html"]').getByText("INLINE1_HTML_RESULT: rendered inside the card.", { exact: true })).toBeVisible();
  await expect(card(page, "html")).toContainText("Protected preview: scripts, external resources and app access are blocked.");

  // The PDF keeps exactly today's buttons and note.
  const pdf = card(page, "pdf");
  await expect(pdf.locator("[data-artifact-inline]")).toHaveCount(0);
  await expect(pdf).toContainText("Preview is unavailable for this format. Download to review it.");
  await expect(pdf.getByRole("button", { name: "Download", exact: true })).toBeVisible();

  // No card offers a Preview that leaves the chat; every card keeps Download and Open here.
  await expect(page.getByRole("button", { name: "Preview", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download", exact: true })).toHaveCount(6);
  await expect(page.getByRole("button", { name: /^Open the working file / })).toHaveCount(6);

  await page.screenshot({ path: testInfo.outputPath(`cards-${width}-${skin}.png`), fullPage: true });
  // A full-page capture does not always paint a sandboxed frame below the
  // fold; the card's own capture shows the rendered report.
  await card(page, "html").scrollIntoViewIfNeeded();
  await card(page, "html").screenshot({ path: testInfo.outputPath(`html-card-${width}-${skin}.png`) });

  // Every byte request carried a capability; none went to the download route;
  // nothing asked the Files section to open.
  expect(byteRequests.length).toBeGreaterThanOrEqual(2);
  for (const request of byteRequests) expect(request).toMatch(/\?cap=mc1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{43}$/);
  expect(downloadRequests).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __openFiles: number }).__openFiles)).toBe(0);
  // The chat never scrolls sideways at this width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("the image opens the shared lightbox in place, and Show more expands the report in place", async ({ page }, testInfo) => {
  await open(page, 1200, "dark");
  const thumb = card(page, "image").getByRole("button", { name: "Enlarge image Saved image" });
  const inline = await thumb.locator("img").getAttribute("src");
  await thumb.click();
  const lightbox = page.getByTestId("image-lightbox");
  await expect(lightbox).toBeVisible();
  await expect(lightbox).toHaveAccessibleName("Preview Saved image");
  await expect(page.getByTestId("image-lightbox-image")).toHaveAttribute("src", inline!);
  await expect(lightbox.getByRole("link", { name: "Download Saved image" })).toHaveAttribute("href", inline!);
  await page.screenshot({ path: testInfo.outputPath("lightbox-1200-dark.png") });
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
  await expect(thumb).toBeFocused();

  const markdown = card(page, "markdown");
  const more = markdown.getByRole("button", { name: "Show more", exact: true });
  await more.scrollIntoViewIfNeeded();
  await more.click();
  await expect(markdown.locator('[data-artifact-inline="markdown"]')).toHaveAttribute("data-artifact-inline-expanded", "true");
  await expect(markdown).toContainText(REPORT_TAIL);
  await expect(markdown).not.toContainText(/Showing the first/);
  await markdown.screenshot({ path: testInfo.outputPath("report-expanded-1200-dark.png") });
  const less = markdown.getByRole("button", { name: "Show less", exact: true });
  await less.scrollIntoViewIfNeeded();
  await less.click();
  await expect(markdown).not.toContainText(REPORT_TAIL);
  expect(await page.evaluate(() => (window as unknown as { __openFiles: number }).__openFiles)).toBe(0);
});

test("a byte request without its capability is refused by the harness", async () => {
  const resolve = await api("/api/media/resolve", "POST", { ref: { source: "artifact", artifactId: saved.image!.id } });
  expect(resolve.url).toMatch(/^\/api\/media\/bytes\/ma1_[A-Za-z0-9_-]{32}\?cap=mc1\./);
  const bare = resolve.url.split("?")[0] as string;
  expect((await fetch(fixture.info.url + bare)).status).not.toBe(200);
  expect((await fetch(fixture.info.url + bare + "?cap=mc1.forged.token")).status).not.toBe(200);
  const real = await fetch(fixture.info.url + resolve.url);
  expect(real.status).toBe(200);
  expect(real.headers.get("content-type")).toBe("image/png");
});
