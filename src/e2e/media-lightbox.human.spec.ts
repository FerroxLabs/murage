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
import { test, expect, type Page } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

/** A solid-colour RGB PNG, so each fixture image has known dimensions. */
function png(width: number, height: number, [r, g, b]: [number, number, number], bad = false): Buffer {
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
  if (bad) row[0] = 9;
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
  "Private: ![secret](/Users/alex/private/secret.png)",
].join("\n");

let server: ViteDevServer, origin: string, cache: string;
let harness: VerificationServer, workspaceScope: { botId: string; threadId: string }, workspaceMarkdown: string, workspaceRoot: string;
let desktopHeaders: Record<string, string>, markdownArtifact: any, callerBot: any;
const workspaceReferences: any[] = [], workspaceResolves: any[] = [];
const workspaceRequests: string[] = [];
const served: string[] = [];
/** The window's per-launch proof: an <img> cannot send headers, so the
 *  window trades it (in a POST header) for a single-use ticket per image. */
const FIXTURE_PROOF = "media-fixture-proof";
/** The desktop loads an /api image through a single-use ticket, never with the proof in the URL. */
const proofed = (path: string) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?surfaceTicket=fixture-ticket-\\d+$`);
let fixtureTickets = 0;

test.beforeAll(async () => {
  harness = await launchVerificationServer();
  const proof = await (await fetch(`${harness.info.url}/api/desktop-secret`)).json();
  desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret, "content-type": "application/json" };
  const created = await (await fetch(`${harness.info.url}/api/bots`, { method: "POST", headers: desktopHeaders, body: JSON.stringify({ name: "Workspace image proof" }) })).json();
  callerBot = created.bot;
  workspaceScope = { botId: created.bot.id, threadId: created.bot.threadId };
  workspaceRoot = join(harness.info.dataDir, "workspaces", workspaceScope.botId, "threads", workspaceScope.threadId);
  mkdirSync(join(workspaceRoot, "outputs"), { recursive: true });
  writeFileSync(join(workspaceRoot, "outputs", "plot.png"), png(320, 180, [40, 110, 220]));
  writeFileSync(join(workspaceRoot, "outputs", "cut.png"), png(320, 180, [40, 110, 220]).subarray(0, 33));
  writeFileSync(join(workspaceRoot, "outputs", "swap.png"), png(320, 180, [40, 110, 220]));
  const homeImage = join(harness.info.dataDir, "home.png"); writeFileSync(homeImage, png(320, 180, [40, 110, 220]));
  symlinkSync(homeImage, join(workspaceRoot, "outputs", "link.png"));
  workspaceMarkdown = `![Workspace plot](outputs/plot.png)\n\n![HOME picture](${homeImage})\n\n![Listed link](outputs/link.png)\n\n![Stopped picture](outputs/cut.png)\n\n![Swapped link](outputs/swap.png)`;
  writeFileSync(join(workspaceRoot, "outputs", "bad.jpg"), Buffer.from('ffd8ffc7000b080001000101011100ffda0008010100003f0011ff00ffd011ffd9', 'hex'));
  const flood = png(2000, 1999, [40, 110, 220]);
  for (let i = 0; i < 500; i++) writeFileSync(join(workspaceRoot, "outputs", `flood${i}.png`), flood);
  const wave = Buffer.alloc(44 + 16000); wave.write("RIFF", 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(16000, 40);
  writeFileSync(join(workspaceRoot, "tone.wav"), wave);
  writeFileSync(join(workspaceRoot, "note.md"), "![Pane plot](outputs/plot.png)");
  const other = await (await fetch(`${harness.info.url}/api/bots`, { method: "POST", headers: desktopHeaders, body: JSON.stringify({ name: "Artifact image proof" }) })).json();
  const artifactRoot = join(harness.info.dataDir, "workspaces", other.bot.id, "threads", other.bot.threadId);
  mkdirSync(join(artifactRoot, "outputs"), { recursive: true });
  for (const name of ["artifact.png", "expanded.png"]) writeFileSync(join(artifactRoot, "outputs", name), png(80, 60, [80, 160, 40]));
  writeFileSync(join(artifactRoot, "report.md"), "![Artifact plot](outputs/artifact.png)\n\n" + "Saved text. ".repeat(240) + "\n\n![Expanded plot](outputs/expanded.png)");
  const registered = await (await fetch(`${harness.info.url}/api/artifacts/register`, { method: "POST", headers: desktopHeaders, body: JSON.stringify({ botId: other.bot.id, threadId: other.bot.threadId, relativePath: "report.md", name: "Markdown scope proof" }) })).json();
  markdownArtifact = registered.artifact;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-media-lightbox-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", hmr: false, watch: null },
    plugins: [react(), tailwindcss(), { name: "media-lightbox-fixture",
      transform(code, id) {
        if (!id.endsWith('/src/state/store.tsx')) return;
        for (const name of ['useStore', 'useStoreActions', 'useStoreIfAny']) code = code.replace(`export function ${name}() {`, `export function ${name}() { if (globalThis.__callerStore) return globalThis.__callerStore;`);
        return code;
      },
      resolveId(id) { if (id === "/__media.js") return "\0media-lightbox"; },
      load(id) {
        if (id !== "\0media-lightbox") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';
import {AttachedImageGallery} from '/src/components/AttachmentPreview.tsx';
import {ChatMarkdown} from '/src/components/ChatMarkdown.tsx';
import {ScreenFrameMedia} from '/src/components/ImageMedia.tsx';
import {Files} from '/src/components/Files.tsx';
import {ChatView} from '/src/components/ChatView.tsx';
import {initialState} from '/src/state/store.tsx';
import {LocalMedia} from '/src/components/MediaPlayer.tsx';
import {InlineArtifactCard} from '/src/components/ArtifactCards.tsx';
import {WorkspacePaneSurface} from '/src/components/WorkspacePane.tsx';
import {initialWorkspacePaneState,workspacePaneReducer} from '/src/lib/workspace-pane.ts';
import {registerComposerReferenceTarget} from '/src/lib/image-reference.ts';
if(location.search.includes('workspace'))registerComposerReferenceTarget({...${JSON.stringify(workspaceScope)},draftId:'workspace-proof'});
import '/src/styles.css';
const h=React.createElement;
const callerBot=${JSON.stringify(callerBot)};
if(location.search.includes('callers'))globalThis.__callerStore={state:{...initialState,bots:[callerBot],hydrated:true},dispatch:()=>{},flushBotPatches:async()=>{},refreshInstances:async()=>{}};
function CallerProof(){const [phase,setPhase]=React.useState(0);const message={id:'stored',role:'bot',kind:'text',text:'![Stored chat](outputs/plot.png)',at:1};
const messages=phase===0?[message]:phase===1?[message,{id:'human',role:'user',kind:'text',text:'Next picture',at:2}]:[message,{id:'human',role:'user',kind:'text',text:'Next picture',at:2},{...message,id:'popping',text:'![Popping chat](outputs/plot.png)',at:3}];
return h('section',{'data-testid':'caller-chat',style:{height:800}},h('button',{onClick:()=>setPhase(1)},'Start fixture turn'),h('button',{onClick:()=>setPhase(2)},'Finish fixture turn'),h(ChatView,{bot:{...callerBot,messages,busy:phase===1,activity:phase===1?'thinking':'idle',activeLeafId:null}}));}

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
  location.search.includes('callers')&&h(CallerProof),
  location.search.includes('workspace')&&h('section',{'data-testid':'workspace-images'},h(ChatMarkdown,{text:${JSON.stringify(workspaceMarkdown)},scope:${JSON.stringify(workspaceScope)}})),
  location.search.includes('workspace')&&h('section',{'data-testid':'artifact-markdown'},h(InlineArtifactCard,{artifact:${JSON.stringify(markdownArtifact)},busy:false,onDownload:()=>{},onOpenHere:()=>{}})),
  location.search.includes('workspace')&&h('section',{'data-testid':'pane-markdown',style:{height:600,width:900}},h(WorkspacePaneSurface,{scope:${JSON.stringify(workspaceScope)},pane:workspacePaneReducer(initialWorkspacePaneState,{type:'open',scope:${JSON.stringify(workspaceScope)},relativePath:'note.md',mode:'preview'}),dispatch:()=>{},labelForScope:()=> 'Pane scope',narrow:false})),
  location.search.includes('bad')&&h('section',{'data-testid':'bad-picture'},h(ChatMarkdown,{text:'![Bad picture](outputs/bad.jpg)',scope:${JSON.stringify(workspaceScope)}})),
  location.search.includes('flood')&&h('section',{'data-testid':'flood-pictures'},h(ChatMarkdown,{text:Array.from({length:500},(_,i)=>'![Flood '+i+'](outputs/flood'+i+'.png)').join('\\n\\n'),scope:${JSON.stringify(workspaceScope)}})),
  location.search.includes('player')&&h('section',{'data-testid':'local-player'},h(LocalMedia,{scope:${JSON.stringify(workspaceScope)},path:${JSON.stringify(join(workspaceRoot,'tone.wav'))},fallback:h('span',{},'Audio fallback')})),
  h('section',{'data-testid':'gallery'},h(AttachedImageGallery,{paths:['/Users/x/attachments/portrait-1.png','/Users/x/attachments/missing-9.png','/Users/x/attachments/wide-2.png'],className:'justify-start'})),
  h('section',{'data-testid':'markdown'},h(ChatMarkdown,{text:${JSON.stringify(MARKDOWN)}})),
  h('section',{'data-testid':'screen'},h(ScreenFrameMedia,{png:${JSON.stringify(SCREEN)},mime:'image/png',className:'block w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-2xl border border-hairline/40'})),
  h('section',{'data-testid':'files'},h(FilesModal)))));`;
      },
      configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://fixture");
        if (url.pathname === "/__media") {
          res.setHeader("content-type", "text/html");
          res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__media.js"></script>');
          return;
        }
        if (url.pathname.startsWith("/api/workspace-files/") || url.pathname.startsWith("/api/media/") || url.pathname === `/api/artifacts/${markdownArtifact?.id}/preview`) {
          workspaceRequests.push(url.pathname);
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks);
          if (url.pathname === "/api/media/resolve") workspaceResolves.push(JSON.parse(body.toString()).ref);
          if (url.pathname === "/api/media/reference") workspaceReferences.push(JSON.parse(body.toString()));
          if (url.pathname === "/api/media/resolve" && body.toString().includes('"outputs/swap.png"')) {
            const path = join(workspaceRoot, "outputs", "swap.png"); unlinkSync(path); symlinkSync(join(harness.info.dataDir, "home.png"), path);
          }
          const answer = await fetch(`${harness.info.url}${url.pathname}${url.search}`, { method: req.method, headers: desktopHeaders, ...(body.length ? { body } : {}) });
          res.statusCode = answer.status; answer.headers.forEach((value, key) => res.setHeader(key, value)); res.end(Buffer.from(await answer.arrayBuffer())); return;
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
        if (url.pathname === "/api/config" && /workspace|flood|bad|callers/.test(req.headers.referer ?? "")) return json({ surface: "desktop", computer: true });
        if (url.pathname === "/api/desktop-secret") return json({ secret: FIXTURE_PROOF });
        if (url.pathname === "/api/desktop/resource-ticket") return json({ ticket: `fixture-ticket-${++fixtureTickets}`, expiresInMs: 15000 });
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
test.afterAll(async () => { await server?.close(); await harness?.close(); if (cache) safeWipeSync(cache); });

const lightbox = (page: Page) => page.getByTestId("image-lightbox");
const lightboxImage = (page: Page) => page.getByTestId("image-lightbox-image");
let trackerRequests: { url: string; referer?: string }[] = [];

async function open(page: Page, skin = "dark", workspace = false) {
  trackerRequests = [];
  await page.route("https://tracker.example/**", async (route) => {
    trackerRequests.push({ url: route.request().url(), referer: route.request().headers().referer });
    await route.fulfill({ status: 200, contentType: "image/png", body: ATTACHMENTS["wide-2.png"] });
  });
  await page.goto(origin + "/__media" + (workspace ? "?workspace=1" : ""));
  await page.evaluate((value) => { document.documentElement.dataset.skin = value; }, skin);
  await expect(page.getByTestId("gallery").getByRole("button").first()).toBeVisible();
}

/** Opens a thumbnail from the keyboard and checks the dialog shows the same
 * bytes: same attachment URL, fully decoded, one dialog, labelled. The desktop
 * mints a single-use ticket per image load (1.0.3), so the dialog's own load
 * carries its own ticket: everything but the ticket value is the same string. */
async function openFromKeyboard(page: Page, thumb: ReturnType<Page["getByRole"]>, name: string) {
  await thumb.focus();
  await page.keyboard.press("Enter");
  await expect(lightbox(page)).toBeVisible();
  await expect(page.locator("dialog[data-testid=image-lightbox]")).toHaveCount(1);
  await expect(lightbox(page)).toHaveAccessibleName(`Preview ${name}`);
  const inline = await thumb.locator("img").getAttribute("src");
  const withoutTicket = (src: string) => src.replace(/([?&])surfaceTicket=[^&]+&?/, "$1").replace(/[?&]$/, "");
  const ticketed = /surfaceTicket=fixture-ticket-\d+/;
  await expect.poll(async () => { const shown = (await lightboxImage(page).getAttribute("src")) ?? ""; return ticketed.test(shown) === ticketed.test(inline!) && withoutTicket(shown) === withoutTicket(inline!); }).toBe(true);
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
  await expect(lightboxImage(page)).toHaveAttribute("src", proofed("/api/attachments/wide-2.png"));
  await page.getByRole("button", { name: "Next image" }).click();
  await expect(dialog).toContainText("Image 1 of 3");
  await page.getByRole("button", { name: "Previous image" }).click();
  await expect(dialog).toContainText("Image 3 of 3");
  await page.keyboard.press("Home");
  await expect(lightboxImage(page)).toHaveAttribute("src", proofed("/api/attachments/portrait-1.png"));
  // a single image has no set to walk
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Enlarge image Weekly chart" }).click();
  await expect(page.getByRole("button", { name: "Next image" })).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(lightboxImage(page)).toHaveAttribute("src", proofed("/api/attachments/tall-3.png"));
});

for (const skin of ["light", "dark"]) for (const [width, height] of [[390, 844], [1440, 900]] as const) {
  test(`portrait, wide and tall images fit the lightbox at ${width}px ${skin}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await open(page, skin);
    await page.getByRole("button", { name: "Preview attached image portrait-1.png" }).click();
    for (const src of ["/api/attachments/portrait-1.png", "/api/attachments/wide-2.png"]) {
      if (src.includes("wide")) await page.keyboard.press("End");
      await expect(lightboxImage(page)).toHaveAttribute("src", proofed(src));
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
  // Polled, and read from the <img> on screen each time: a phone first asks
  // for a ?w= thumbnail and swaps in a fresh <img> for the original once it
  // learns the original was served (ImageThumb's smallOriginal), and a
  // detached element has no computed style to read.
  await expect.poll(() => thumb.locator("img").evaluate((img) => img.isConnected ? parseFloat(getComputedStyle(img).transitionDuration) : NaN))
    .toBeLessThanOrEqual(0.00001);
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
  await expect(markdown.getByText("Only pictures in this conversation's folder load here.")).toBeVisible();
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

test("E1 scoped workspace pictures use real resolve, enlarge and Save verified browser bytes", async ({ page }) => {
  await open(page, "dark", true);
  const section = page.getByTestId("workspace-images");
  const image = section.getByRole("img", { name: "Workspace plot", exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 320)).toBe(true);
  await expect(section.getByText("Only pictures in this conversation's folder load here.")).toBeVisible();
  await expect(section.getByText("That picture is not in this conversation's folder right now.")).toBeVisible();
  await expect(section.getByText("Murage can't show this file as a picture.")).toBeVisible();
  await expect(section.getByText("That file is not available from this conversation.")).toBeVisible();
  await page.screenshot({ path: join(process.env.MURAGE_E2E_DATA_DIR!, "workspace-inline.png"), fullPage: true });
  await image.click(); await expect(lightbox(page)).toBeVisible();
  await expect.poll(() => lightboxImage(page).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 320)).toBe(true);
  await page.screenshot({ path: join(process.env.MURAGE_E2E_DATA_DIR!, "workspace-lightbox.png") });
  expect(workspaceReferences).toHaveLength(0);
  const reference = lightbox(page).getByRole("button", { name: "Use plot.png as a reference image in your next message" });
  await reference.click(); await expect(lightbox(page).getByRole("button", { name: "plot.png was added to your next message as a reference image" })).toBeVisible();
  expect(workspaceReferences[0]).toMatchObject({ ...workspaceScope, source: { kind: "workspace", relativePath: "outputs/plot.png", revision: expect.stringMatching(/^r1\./) } });
  expect(workspaceResolves.some(ref => ref.relativePath === "outputs/link.png")).toBe(false);
  const pending = page.waitForEvent("download"); await lightbox(page).getByRole("link", { name: /Download/ }).click();
  const downloaded = await pending; await downloaded.saveAs(join(process.env.MURAGE_E2E_DATA_DIR!, "workspace-saved.png"));
  expect((await import("node:fs")).readFileSync(join(process.env.MURAGE_E2E_DATA_DIR!, "workspace-saved.png"))).toEqual(png(320, 180, [40, 110, 220]));
  expect(workspaceRequests).toContain("/api/media/resolve");
});

test("B8/B10/R2-G6 actual pane and collapsed/expanded artifact Markdown preserve separate scopes", async ({ page }) => {
  await open(page, "dark", true);
  const artifact = page.getByTestId("artifact-markdown");
  await artifact.scrollIntoViewIfNeeded();
  await expect(artifact.getByRole("img", { name: "Artifact plot", exact: true })).toBeVisible();
  await artifact.getByRole("button", { name: /Show more/ }).click();
  // The picture loads when its place scrolls near; the caption label is there before it does, so scroll to that.
  await artifact.getByText("Expanded plot", { exact: true }).scrollIntoViewIfNeeded();
  await expect(artifact.getByRole("img", { name: "Expanded plot", exact: true })).toBeVisible();
  const pane = page.getByTestId("pane-markdown"); await pane.scrollIntoViewIfNeeded();
  await expect(pane.getByRole("img", { name: "Pane plot", exact: true })).toBeVisible();
  for (const name of ["outputs/artifact.png", "outputs/expanded.png"]) expect(workspaceResolves.find(ref => ref.relativePath === name)?.scope).toEqual({ botId: markdownArtifact.botId, threadId: markdownArtifact.threadId });
  expect(workspaceResolves.find(ref => ref.relativePath === "outputs/plot.png")?.scope).toEqual(workspaceScope);
  expect(markdownArtifact.threadId).not.toBe(workspaceScope.threadId);
  await page.screenshot({ path: join(process.env.MURAGE_E2E_DATA_DIR!, "workspace-pane.png"), fullPage: true });
});

test("R32-PLAYER actual playback re-arms twice and later downloads each renew once", async ({ page }) => {
  await page.goto(origin + "/__media?workspace=1&player=1");
  const section = page.getByTestId("local-player"), audio = section.locator("audio");
  await section.scrollIntoViewIfNeeded(); await expect(audio).toBeVisible();
  const failed = new Set<string>();
  await page.route("**/api/media/bytes/**", route => failed.has(route.request().url()) ? route.fulfill({ status: 403, body: "Expired fixture capability" }) : route.continue());
  await page.evaluate(() => { const now = Date.now.bind(Date); Date.now = () => now() + 700000; });
  for (let cycle = 0; cycle < 2; cycle++) {
    const before = workspaceResolves.filter(ref => ref.relativePath === "tone.wav").length;
    failed.add(new URL((await audio.getAttribute("src"))!, origin).href);
    await audio.evaluate((element: HTMLAudioElement) => element.load());
    await expect.poll(() => workspaceResolves.filter(ref => ref.relativePath === "tone.wav").length).toBe(before + 1);
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState >= 2)).toBe(true);
    await audio.evaluate(async (element: HTMLAudioElement) => { element.muted = true; await element.play(); element.pause(); element.currentTime = 0; });
    await expect(section.locator('[data-media-player-state="ready"]')).toBeVisible();
  }
  for (let action = 0; action < 2; action++) {
    const before = workspaceResolves.filter(ref => ref.relativePath === "tone.wav").length;
    const pending = page.waitForEvent("download"); await section.getByRole("link", { name: "Save a copy" }).click();
    const download = await pending; expect(await download.failure()).toBeNull();
    expect(workspaceResolves.filter(ref => ref.relativePath === "tone.wav")).toHaveLength(before + 1);
  }
});


test("R32-PLAYER pending download clicks join a single handoff", async ({ page }) => {
  await page.goto(origin + "/__media?workspace=1&player=1");
  const section = page.getByTestId("local-player"), audio = section.locator("audio");
  await section.scrollIntoViewIfNeeded(); await expect(audio).toBeVisible();
  await page.evaluate(() => { const now = Date.now.bind(Date); Date.now = () => now() + 700000; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/media/resolve", async route => { await held; await route.continue(); });
  let downloads = 0; page.on("download", () => downloads++);
  const save = section.getByRole("link", { name: "Save a copy" });
  await save.evaluate((link: HTMLAnchorElement) => { link.click(); link.click(); link.click(); });
  release();
  await expect.poll(() => downloads).toBe(1);
  await expect(section.getByText("Saving a copy")).toHaveCount(0);
  await page.waitForTimeout(250); expect(downloads).toBe(1);
});


test("T3/R2-G3 a structurally complete decoder failure refreshes once then stays K4", async ({ page }) => {
  const before = workspaceResolves.filter(ref => ref.relativePath === "outputs/bad.jpg").length;
  await page.goto(origin + "/__media?bad=1");
  const section = page.getByTestId("bad-picture");
  await expect(section.getByText("That picture changed or could not be loaded.")).toBeVisible();
  expect(workspaceResolves.filter(ref => ref.relativePath === "outputs/bad.jpg")).toHaveLength(before + 2);
  await expect(section.locator("img")).toHaveCount(0);
  await page.screenshot({ path: join(process.env.MURAGE_E2E_DATA_DIR!, "workspace-decode-failed.png") });
  await section.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => workspaceResolves.filter(ref => ref.relativePath === "outputs/bad.jpg").length).toBe(before + 4);
  await expect(section.getByText("That picture changed or could not be loaded.")).toBeVisible();
});

test("A13/E1 500 visible candidates bound discovery, chains and actual decoded surfaces", async ({ page }) => {
  await page.addInitScript(() => {
    window.IntersectionObserver = class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) { queueMicrotask(() => this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as any)); }
      disconnect() {} unobserve() {} takeRecords() { return []; }
      root = null; rootMargin = ''; thresholds = [];
    } as any;
  });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let roots = 0;
  await page.route("**/api/workspace-files/root?**", async route => { roots++; await held; await route.continue(); });
  await page.goto(origin + "/__media?flood=1");
  const budget = () => page.evaluate(async () => { const path = '/src/lib/local-image-budget.ts'; return (await import(path)).localImageBudget(); });
  await expect.poll(async () => (await budget()).discoveries).toBe(32);
  expect(roots).toBe(1); expect((await budget()).waiting).toBe(468);
  release();
  await expect.poll(async () => (await budget()).count).toBe(12);
  const value = await budget(); expect(value.bytes).toBe(191904000); expect(value.count).toBeLessThanOrEqual(32);
  await expect(page.getByTestId("flood-pictures").locator("img")).toHaveCount(12);
  await page.screenshot({ path: join(process.env.MURAGE_E2E_DATA_DIR!, "workspace-flood.png") });
});


test("H2 actual ChatView stored and popping messages keep the conversation identity", async ({ page }) => {
  await page.goto(origin + '/__media?callers=1');
  const section = page.getByTestId('caller-chat');
  await expect(section.getByRole('img', { name: 'Stored chat', exact: true })).toBeVisible();
  await section.getByRole('button', { name: 'Start fixture turn' }).click();
  await expect(section.getByTestId('chat-scroll').getByText('Next picture', { exact: true })).toBeVisible();
  await section.getByRole('button', { name: 'Finish fixture turn' }).click();
  await expect(section.getByRole('img', { name: 'Popping chat', exact: true })).toBeVisible();
  expect(await section.getByRole('img', { name: 'Popping chat', exact: true }).evaluate(el => !!el.closest('[data-testid="msg-bubble"]'))).toBe(false);
  await page.screenshot({ path: join(process.env.MURAGE_E2E_DATA_DIR!, 'workspace-chat-popping.png') });
  expect(workspaceResolves.filter(ref => ref.relativePath === 'outputs/plot.png').every(ref => JSON.stringify(ref.scope) === JSON.stringify(workspaceScope))).toBe(true);
});

test('F8 player keeps same revision state and resets state for replacement bytes', async ({ page }) => {
  await page.goto(origin + '/__media?workspace=1&player=1');
  const section = page.getByTestId('local-player'), audio = section.locator('audio');
  await expect(audio).toBeVisible();
  await audio.evaluate(element => { (window as any).originalPlayer = element; });
  await page.evaluate(() => { const now = Date.now.bind(Date); Date.now = () => now() + 700000; });
  await audio.evaluate(element => element.dispatchEvent(new Event('error')));
  await expect.poll(() => workspaceResolves.filter(ref => ref.relativePath === 'tone.wav').length).toBeGreaterThan(1);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  expect(await audio.evaluate(element => element === (window as any).originalPlayer)).toBe(true);
  await audio.evaluate(element => element.dispatchEvent(new Event('playing')));
  await page.route('**/api/media/resolve', async route => {
    const response = await route.fetch(), body = await response.json();
    body.asset = { ...body.asset, id: 'ma1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', revision: 'r1.replacement', kind: 'video', mime: 'video/x-fixture-unsupported', durationSeconds: 123 };
    await route.fulfill({ response, json: body });
  });
  await audio.evaluate(element => element.dispatchEvent(new Event('error')));
  await expect(section.locator('[data-media-player-state="unplayable"]')).toBeVisible();
  await expect(section.getByText(/cannot play this format/)).toBeVisible();
  await expect(section.locator('audio,video')).toHaveCount(0);
});
