// F5-T2 browser proof: one lightbox for every image surface.
//
// A Vite fixture renders the real components (AttachedImageGallery, which both
// transcripts use; ChatMarkdown; the ScreenFrameMedia ChatView renders; and
// Files inside a modal <dialog> the way FilesDialog opens it) against a tiny
// HTTP fixture that serves generated PNGs. Nothing here touches a real app,
// data directory or network: an external image host is intercepted and counted.
//
// Proves: click and Enter open the exact bytes shown inline, one dialog at a
// time; Escape, the Close button and the backdrop close it; focus stays inside
// and returns to the thumbnail; arrows stay inside the message's set and a
// failed image never poisons the next; portrait/wide images fit at phone and
// desktop widths in both skins; reduced motion drops the animation; a remote
// image makes no request until asked (and then sends no referrer); a local
// path is never requested; opening a screen frame makes no request at all.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

/** A solid-colour RGB PNG, so each fixture image has known dimensions. */
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

const ATTACHMENTS: Record<string, Buffer> = {
  "portrait-1.png": png(400, 1600, [40, 110, 220]),
  "wide-2.png": png(1600, 300, [220, 90, 40]),
  "tall-3.png": png(300, 1200, [60, 170, 90]),
};
const SCREEN = png(1280, 800, [30, 30, 30]).toString("base64");
const SAVED = `data:image/png;base64,${png(900, 600, [200, 60, 160]).toString("base64")}`;
const ARTIFACT = {
  id: "art-chart", name: "Saved chart", filename: "chart.png", kind: "image", mime: "image/png", bytes: 1234, sha256: "f".repeat(64),
  createdAt: 1_757_000_000_000, botId: "research", botName: "Research bot", threadId: "task", relativePath: "chart.png",
  sourceState: "current", savedState: "available", sourceConversationAvailable: true,
};
const MARKDOWN = [
  "Here is the chart ![Weekly chart](/api/attachments/tall-3.png) inline.",
  "",
  "Tracked: ![pixel](https://tracker.example/pixel.png)",
  "",
  "Private: ![secret](/Users/sean/private/secret.png)",
].join("\n");

let server: ViteDevServer, origin: string, cache: string;
const served: string[] = [];

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-media-lightbox-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", hmr: false, watch: null },
    plugins: [react(), tailwindcss(), { name: "media-lightbox-fixture",
      resolveId(id) { if (id === "/__media.js") return "\0media-lightbox"; },
      load(id) {
        if (id !== "\0media-lightbox") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';
import {AttachedImageGallery} from '/src/components/AttachmentPreview.tsx';
import {ChatMarkdown} from '/src/components/ChatMarkdown.tsx';
import {ScreenFrameMedia} from '/src/components/ImageMedia.tsx';
import {Files} from '/src/components/Files.tsx';
import '/src/styles.css';
const h=React.createElement;
function FilesModal(){const ref=React.useRef(null);const [open,setOpen]=React.useState(false);
  React.useEffect(()=>{if(open&&!ref.current?.open)ref.current?.showModal();},[open]);
  return h(React.Fragment,{},h('button',{type:'button',onClick:()=>setOpen(true)},'Open Files'),
    open&&h('dialog',{ref,id:'files-dialog','aria-label':'Files',onCancel:()=>setOpen(false),onClose:()=>setOpen(false),className:'m-auto h-[80dvh] w-[min(900px,calc(100vw-24px))] rounded-2xl bg-panel p-0 text-ink'},
      h(Files,{bots:[],initialArtifactId:'art-chart',onClose:()=>setOpen(false)})));}
// the app stylesheet pins body to the viewport, as the real shell does, so the
// fixture scrolls inside main the way the transcript scrolls inside its pane.
// StrictMode as in src/main.tsx: dev and the e2e rig run every effect twice.
createRoot(document.getElementById('root')).render(h(React.StrictMode,{},h('main',{style:{background:'var(--color-app)',color:'var(--color-ink)',padding:16,height:'100dvh',overflowY:'auto'}},
  h('button',{type:'button','data-testid':'outside'},'Outside'),
  h('section',{'data-testid':'gallery'},h(AttachedImageGallery,{paths:['/Users/x/attachments/portrait-1.png','/Users/x/attachments/missing-9.png','/Users/x/attachments/wide-2.png'],className:'justify-start'})),
  h('section',{'data-testid':'markdown'},h(ChatMarkdown,{text:${JSON.stringify(MARKDOWN)}})),
  h('section',{'data-testid':'screen'},h(ScreenFrameMedia,{png:${JSON.stringify(SCREEN)},mime:'image/png',className:'block w-fit max-w-[min(42rem,78%)] rounded-2xl border border-hairline/40'})),
  h('section',{'data-testid':'files'},h(FilesModal)))));`;
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://fixture");
        if (url.pathname === "/__media") {
          res.setHeader("content-type", "text/html");
          res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__media.js"></script>');
          return;
        }
        if (url.pathname.startsWith("/Users/")) { served.push(url.pathname); res.statusCode = 404; res.end(); return; }
        const attachment = /^\/api\/attachments\/([\w.-]+)$/.exec(url.pathname);
        if (attachment) {
          served.push(url.pathname);
          const bytes = ATTACHMENTS[attachment[1]!];
          if (!bytes) { res.statusCode = 404; res.end(); return; }
          res.setHeader("content-type", "image/png"); res.end(bytes); return;
        }
        const json = (body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
        if (url.pathname === "/api/desktop-secret") return json({ secret: "media-fixture-proof" });
        if (url.pathname === "/api/artifacts/art-chart/preview") return json({ artifact: ARTIFACT, mode: "image", content: SAVED });
        if (url.pathname === "/api/artifacts") return json({ items: [ARTIFACT], total: 1, page: 0, pageSize: 25 });
        next();
      }); },
    }] });
  await server.listen(Number(process.env.MURAGE_E2E_UI_PORT) || 0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

const lightbox = (page: Page) => page.getByTestId("image-lightbox");
const lightboxImage = (page: Page) => page.getByTestId("image-lightbox-image");
let trackerRequests: { url: string; referer?: string }[] = [];

async function open(page: Page, skin = "dark") {
  trackerRequests = [];
  await page.route("https://tracker.example/**", async (route) => {
    trackerRequests.push({ url: route.request().url(), referer: route.request().headers().referer });
    await route.fulfill({ status: 200, contentType: "image/png", body: ATTACHMENTS["wide-2.png"] });
  });
  await page.goto(origin + "/__media");
  await page.evaluate((value) => { document.documentElement.dataset.skin = value; }, skin);
  await expect(page.getByTestId("gallery").getByRole("button").first()).toBeVisible();
}

/** Opens a thumbnail from the keyboard and checks the dialog shows the same
 * bytes: same src string, fully decoded, one dialog, labelled. */
async function openFromKeyboard(page: Page, thumb: ReturnType<Page["getByRole"]>, name: string) {
  await thumb.focus();
  await page.keyboard.press("Enter");
  await expect(lightbox(page)).toBeVisible();
  await expect(page.locator("dialog[data-testid=image-lightbox]")).toHaveCount(1);
  await expect(lightbox(page)).toHaveAccessibleName(`Preview ${name}`);
  const inline = await thumb.locator("img").getAttribute("src");
  await expect(lightboxImage(page)).toHaveAttribute("src", inline!);
  await expect.poll(() => lightboxImage(page).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
}

test("every surface opens its exact image in the one lightbox, and Escape hands focus back", async ({ page }) => {
  await open(page);
  const surfaces: [string, ReturnType<Page["getByRole"]>, string][] = [
    ["gallery", page.getByRole("button", { name: "Preview attached image portrait-1.png" }), "portrait-1.png"],
    ["markdown", page.getByRole("button", { name: "Enlarge image Weekly chart" }), "Weekly chart"],
    ["screen", page.getByRole("button", { name: "Enlarge the bot's screen" }), "Bot's screen"],
  ];
  for (const [, thumb, name] of surfaces) {
    await openFromKeyboard(page, thumb, name);
    await page.keyboard.press("Escape");
    await expect(lightbox(page)).toHaveCount(0);
    await expect(thumb).toBeFocused();
  }
  // a mouse opens it too, and the Close control and the backdrop both close it
  const gallery = surfaces[0][1];
  await gallery.click();
  await expect(lightbox(page)).toBeVisible();
  await page.getByRole("button", { name: "Close image preview" }).click();
  await expect(lightbox(page)).toHaveCount(0);
  await gallery.click();
  await page.mouse.click(4, 4);
  await expect(lightbox(page)).toHaveCount(0);
});

test("the Files saved-copy preview opens above the modal Files dialog and Escape closes only the lightbox", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Open Files" }).click();
  const files = page.locator("#files-dialog");
  await expect(files).toHaveAttribute("open", "");
  const thumb = files.getByRole("button", { name: "Enlarge image Saved chart" });
  await expect(thumb).toBeVisible();
  await openFromKeyboard(page, thumb, "Saved chart");
  expect(await lightboxImage(page).getAttribute("src")).toBe(SAVED);
  // it is the top-layer dialog, so it can be clicked rather than being inert
  await expect(page.getByRole("button", { name: "Close image preview" })).toBeVisible();
  await expect(lightbox(page).getByRole("link", { name: "Download Saved chart" })).toHaveAttribute("href", SAVED);
  await page.keyboard.press("Escape");
  await expect(lightbox(page)).toHaveCount(0);
  await expect(files).toHaveAttribute("open", "");
  await expect(thumb).toBeFocused();
});

test("focus stays inside, arrows stay inside the message, and a failed image does not poison the next", async ({ page }) => {
  await open(page);
  // the missing attachment stays visible as a named fallback, not a hole
  await expect(page.getByRole("img", { name: "Image unavailable: missing-9.png" })).toBeVisible();
  const first = page.getByRole("button", { name: "Preview attached image portrait-1.png" });
  await first.click();
  const dialog = lightbox(page);
  await expect(dialog).toContainText("Image 1 of 3");
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press(i % 3 === 2 ? "Shift+Tab" : "Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("ArrowRight");
  await expect(dialog).toContainText("Image 2 of 3");
  await expect(dialog.getByRole("status")).toHaveText("This image is no longer available.");
  await page.keyboard.press("ArrowRight");
  await expect(dialog).toContainText("Image 3 of 3");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect(lightboxImage(page)).toHaveAttribute("src", "/api/attachments/wide-2.png");
  await page.getByRole("button", { name: "Next image" }).click();
  await expect(dialog).toContainText("Image 1 of 3");
  await page.getByRole("button", { name: "Previous image" }).click();
  await expect(dialog).toContainText("Image 3 of 3");
  await page.keyboard.press("Home");
  await expect(lightboxImage(page)).toHaveAttribute("src", "/api/attachments/portrait-1.png");
  // a single image has no set to walk
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Enlarge image Weekly chart" }).click();
  await expect(page.getByRole("button", { name: "Next image" })).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(lightboxImage(page)).toHaveAttribute("src", "/api/attachments/tall-3.png");
});

for (const skin of ["light", "dark"]) for (const [width, height] of [[390, 844], [1440, 900]] as const) {
  test(`portrait, wide and tall images fit the lightbox at ${width}px ${skin}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await open(page, skin);
    await page.getByRole("button", { name: "Preview attached image portrait-1.png" }).click();
    for (const src of ["/api/attachments/portrait-1.png", "/api/attachments/wide-2.png"]) {
      if (src.includes("wide")) await page.keyboard.press("End");
      await expect(lightboxImage(page)).toHaveAttribute("src", src);
      await expect.poll(() => lightboxImage(page).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      const box = (await lightboxImage(page).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width); expect(box.y + box.height).toBeLessThanOrEqual(height);
      // contain, never cropped: the rendered box keeps the image's own aspect ratio
      const natural = await lightboxImage(page).evaluate((img: HTMLImageElement) => img.naturalWidth / img.naturalHeight);
      expect(Math.abs(box.width / box.height - natural) / natural).toBeLessThan(0.03);
    }
    await page.screenshot({ path: info.outputPath(`lightbox-${width}-${skin}.png`) });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Enlarge image Weekly chart" }).click();
    const box = (await lightboxImage(page).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(height);
  });
}

test("reduced motion removes the dialog animation and the thumbnail zoom", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  const thumb = page.getByRole("button", { name: "Preview attached image portrait-1.png" });
  // styles.css's global reduced-motion rule forces 0.01ms !important over the
  // component's own transition-none; either way nothing perceptibly moves
  const seconds = await thumb.locator("img").evaluate((img) => parseFloat(getComputedStyle(img).transitionDuration));
  expect(seconds).toBeLessThanOrEqual(0.00001);
  await thumb.click();
  const panel = lightbox(page).locator(":scope > div");
  expect(await panel.evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await panel.evaluate((node) => getComputedStyle(node).animationName)).not.toBe("none");
});

test("a remote image waits for a click and a local path is never requested", async ({ page }) => {
  served.length = 0;
  await open(page);
  const markdown = page.getByTestId("markdown");
  await expect(markdown.getByText("Image from tracker.example not loaded.")).toBeVisible();
  await expect(markdown.getByText("Local image paths are not loaded in chat.")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(trackerRequests).toEqual([]);
  expect(served.filter((path) => path.startsWith("/Users/"))).toEqual([]);
  expect(await markdown.locator("img[src*='tracker.example'], img[src*='/Users/']").count()).toBe(0);
  await markdown.getByRole("button", { name: "Load image" }).click();
  const loaded = markdown.getByRole("button", { name: "Enlarge image pixel" });
  await expect(loaded).toBeVisible();
  await expect.poll(() => trackerRequests.length).toBe(1);
  expect(trackerRequests[0]!.referer).toBeUndefined();
  await loaded.click();
  await expect(lightbox(page)).toContainText("External image, loaded at your request");
  await expect(lightbox(page).getByRole("link", { name: /^Download/ })).toHaveCount(0);
  expect(served.filter((path) => path.startsWith("/Users/"))).toEqual([]);
});

test("enlarging a screen frame makes no request and offers no download of the private frame", async ({ page }) => {
  await open(page);
  await page.waitForLoadState("networkidle");
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.getByRole("button", { name: "Enlarge the bot's screen" }).click();
  await expect(lightbox(page)).toContainText("Screen the bot already shared. Not saved.");
  await expect.poll(() => lightboxImage(page).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1280);
  await expect(lightbox(page).getByRole("link", { name: /^Download/ })).toHaveCount(0);
  expect(requests.filter((url) => !url.startsWith("data:"))).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(lightbox(page)).toHaveCount(0);
});
