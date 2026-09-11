// F5-T3 browser proof: audio and video cards in chat.
//
// A Vite fixture renders the real components (AttachedFileChips, which both
// transcripts use for attached files, and ChatMarkdown's local file links)
// against a fake harness that answers exactly the three questions
// src/lib/media-resolve.ts asks, and then serves real PCM bytes with real
// byte-range semantics. Nothing here touches a real app, data directory,
// provider or network: the "workspace" is a path string the fixture invents
// and no file of that name is ever opened.
//
// Proves, in a real browser: nothing plays until a person presses play, even
// with the autoplay policy fully open; playing one card pauses the other;
// seeking asks for a later byte range and gets a 206; a file that is not this
// conversation's, and a file type with no player, never leave their existing
// chip; a path is never fetched as a URL; bytes that will not decode produce
// a truthful error and keep Save a copy; and unmounting the transcript pauses
// the element and drops its source instead of leaving audio playing.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

/** 16-bit mono PCM at 8 kHz: a real, decodable WAV of `seconds` length, big
 * enough that the browser streams it in ranges instead of one gulp. */
function wav(seconds: number, hz: number): Buffer {
  const rate = 8000, samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * index) / rate) * 8000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The fixture's pretend workspace. No directory of this name is created or
 * read: every answer below is invented by the middleware. */
const ROOT = "/tmp/murage-f5t3-fixture-desk";
const SCOPE = { botId: "research", threadId: "task-7" };
const REVISION = "r1.FixtureRevisionAAAAAAAAAAAAAAAAAAAAAAAA";

const BYTES: Record<string, Buffer> = {
  "take-a.wav": wav(30, 440),
  // long enough (4.8 MB) that a seek near the end always needs a fresh range
  // request rather than finding the bytes already buffered
  "take-b.wav": wav(300, 660),
  // a file the harness believes is a WAV whose bytes will not decode: the
  // element's own error is what the card must report
  "broken.wav": Buffer.concat([Buffer.from("RIFF____WAVEfmt "), Buffer.alloc(4096, 0x5a)]),
};
const PLAYABLE = new Set(Object.keys(BYTES));
/** Every file discovery reports in `outputs/`, playable or not. */
const LISTED = [...PLAYABLE, "notes.txt", "report.md"];

const assetFor = (name: string) => ({
  id: `ma1_${name.replace(/[^A-Za-z0-9]/g, "0").padEnd(32, "0").slice(0, 32)}`,
  scope: { serverId: "local", ...SCOPE },
  source: "workspace",
  kind: "audio",
  name,
  mime: "audio/wav",
  bytes: BYTES[name]!.length,
  revision: REVISION,
  availability: "ready",
  capabilities: { preview: true, download: true, open: false, reveal: false, imageReference: false },
});

const FILES = [
  { path: `${ROOT}/outputs/take-a.wav`, name: "take-a.wav" },
  { path: `${ROOT}/outputs/take-b.wav`, name: "take-b.wav" },
  { path: `${ROOT}/outputs/notes.txt`, name: "notes.txt" },
  // a real file of a playable type, but not this conversation's: the resolver
  // must refuse it at the first question and the chip must stay a chip
  { path: "/Users/sean/Music/private.mp3", name: "private.mp3" },
];
const MARKDOWN = [
  `The take is at [take](${ROOT}/outputs/broken.wav).`,
  "",
  `The write-up is at [report](${ROOT}/outputs/report.md).`,
].join("\n");

let server: ViteDevServer, origin: string, cache: string;
/** Every path the browser asked this origin for, with its Range header. */
let requests: { path: string; range?: string; status: number; cap?: string }[] = [];
/** Every workspace-relative path the renderer asked the media resolver about. */
let resolved: string[] = [];
/** The pretend capability issuer. A token names the generation it was issued
 * in; bumping the generation is the harness refusing every earlier token (a
 * restart, or in the real harness, the clock). `ttlMs` is what resolve tells
 * the renderer about the token's life. */
let generation = 1, ttlMs = 600_000;
const capFor = () => `mc1.gen${generation}${"a".repeat(16)}.${"b".repeat(43)}`;
const capGeneration = (cap: string | null) => Number(/^mc1\.gen(\d+)/.exec(cap ?? "")?.[1] ?? 0);

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-media-player-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", hmr: false, watch: null },
    plugins: [react(), tailwindcss(), {
      name: "media-player-fixture",
      resolveId(id) { if (id === "/__player.js") return "\0media-player"; },
      load(id) {
        if (id !== "\0media-player") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';
import {AttachedFileChips} from '/src/components/AttachmentPreview.tsx';
import {ChatMarkdown} from '/src/components/ChatMarkdown.tsx';
import '/src/styles.css';
const h=React.createElement;
const scope=${JSON.stringify(SCOPE)};
function Fixture(){
  const [open,setOpen]=React.useState(true);
  return h(React.Fragment,{},
    h('button',{type:'button','data-testid':'toggle',onClick:()=>setOpen(v=>!v)}, open?'Close the thread':'Reopen the thread'),
    open&&h('section',{'data-testid':'transcript'},
      h(AttachedFileChips,{files:${JSON.stringify(FILES)},scope,className:'justify-start'}),
      h(ChatMarkdown,{text:${JSON.stringify(MARKDOWN)},scope})));
}
createRoot(document.getElementById('root')).render(h(React.StrictMode,{},
  h('main',{style:{background:'var(--color-app)',color:'var(--color-ink)',padding:16,height:'100dvh',overflowY:'auto'}},h(Fixture))));`;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          const json = (body: unknown, status = 200) => {
            requests.push({ path: url.pathname, status });
            res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body));
          };
          if (url.pathname === "/__player") {
            res.setHeader("content-type", "text/html");
            res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__player.js"></script>');
            return;
          }
          if (url.pathname === "/api/desktop-secret") return json({ secret: "media-player-fixture-proof" });
          if (url.pathname === "/__control") {
            if (url.searchParams.has("ttl")) ttlMs = Number(url.searchParams.get("ttl"));
            if (url.searchParams.has("revoke")) generation++;
            res.statusCode = 204; res.end(); return;
          }
          if (url.pathname === "/api/workspace-files/root") {
            return json({ scope: SCOPE, state: "ready", label: "Research", displayPath: ROOT, managed: true });
          }
          if (url.pathname === "/api/workspace-files/list") {
            if (url.searchParams.get("directory") !== "outputs") return json({ scope: SCOPE, entries: [], incomplete: false });
            return json({
              scope: SCOPE, directory: "outputs", directoryRevision: "d1", incomplete: false,
              entries: LISTED.map(name => ({ name, relativePath: `outputs/${name}`, kind: "file", state: "local", bytes: 1, revision: REVISION })),
            });
          }
          if (url.pathname === "/api/media/resolve") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
              const ref = (() => { try { return JSON.parse(body).ref; } catch { return null; } })();
              const name = String(ref?.relativePath ?? "").split("/").pop() ?? "";
              resolved.push(String(ref?.relativePath ?? ""));
              if (!PLAYABLE.has(name) || ref?.revision !== REVISION) return json({ error: "unavailable" }, 404);
              const asset = assetFor(name);
              return json({ asset, url: `/api/media/bytes/${asset.id}?cap=${capFor()}`, expiresAt: Date.now() + ttlMs });
            });
            return;
          }
          const bytes = /^\/api\/media\/bytes\/ma1_([A-Za-z0-9_-]{32})$/.exec(url.pathname);
          if (bytes) {
            const name = LISTED.find(item => assetFor(item === "notes.txt" || item === "report.md" ? "take-a.wav" : item).id === url.pathname.split("/").pop() && PLAYABLE.has(item));
            const payload = name ? BYTES[name]! : undefined;
            if (!payload) { requests.push({ path: url.pathname, status: 404 }); res.statusCode = 404; res.end(); return; }
            const cap = url.searchParams.get("cap");
            if (capGeneration(cap) !== generation) {
              // What server/media-assets.ts answers for a token it no longer
              // honours: 403 and no bytes.
              requests.push({ path: url.pathname, range: req.headers.range, status: 403, cap: cap ?? "" });
              res.statusCode = 403; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "This media link expired. Open the media again.", code: "capability-expired" }));
              return;
            }
            const range = req.headers.range;
            res.setHeader("accept-ranges", "bytes");
            res.setHeader("content-type", "audio/wav");
            res.setHeader("referrer-policy", "no-referrer");
            const match = /^bytes=(\d*)-(\d*)$/.exec(String(range ?? ""));
            if (range && !match) { requests.push({ path: url.pathname, range, status: 416 }); res.statusCode = 416; res.setHeader("content-range", `bytes */${payload.length}`); res.end(); return; }
            if (match) {
              const start = match[1] ? Number(match[1]) : 0;
              const end = match[2] ? Math.min(Number(match[2]), payload.length - 1) : payload.length - 1;
              if (start > end || start >= payload.length) {
                requests.push({ path: url.pathname, range, status: 416 });
                res.statusCode = 416; res.setHeader("content-range", `bytes */${payload.length}`); res.end(); return;
              }
              requests.push({ path: url.pathname, range, status: 206, cap: cap ?? "" });
              res.statusCode = 206;
              res.setHeader("content-range", `bytes ${start}-${end}/${payload.length}`);
              res.setHeader("content-length", String(end - start + 1));
              res.end(payload.subarray(start, end + 1));
              return;
            }
            requests.push({ path: url.pathname, status: 200, cap: cap ?? "" });
            res.setHeader("content-length", String(payload.length));
            res.end(payload);
            return;
          }
          // Anything that looks like a filesystem path being fetched as a URL
          // is the bug this whole design exists to prevent: record it loudly.
          if (url.pathname.startsWith(ROOT) || url.pathname.startsWith("/Users/")) {
            requests.push({ path: url.pathname, status: 404 });
            res.statusCode = 404; res.end(); return;
          }
          next();
        });
      },
    }],
  });
  await server.listen(Number(process.env.MURAGE_E2E_UI_PORT) || 0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

const players = (page: Page) => page.getByTestId("media-player-audio");

async function open(page: Page) {
  requests = [];
  resolved = [];
  await page.goto(`${origin}/__player`);
  await expect(players(page)).toHaveCount(2);
}

/** Start a card the way a person does. A native control's play button is not
 * addressable from outside the shadow tree, so this clicks where it sits and
 * then asks the element to play — the click is the user activation the
 * autoplay policy cares about, and `play()` on an already-playing element is
 * a no-op. */
async function play(page: Page, index: number) {
  await players(page).nth(index).click({ position: { x: 12, y: 12 }, force: true });
  await players(page).nth(index).evaluate((element: HTMLAudioElement) => element.play());
  await expect.poll(() => players(page).nth(index).evaluate((element: HTMLAudioElement) => element.currentTime > 0)).toBe(true);
}

test("a player appears only for this conversation's own playable files", async ({ page }) => {
  await open(page);
  // the two workspace WAVs became players, named and sized
  await expect(page.locator('[data-media-player-state="ready"]')).toHaveCount(2);
  await expect(page.getByText("take-a.wav")).toBeVisible();
  await expect(page.getByText("take-b.wav")).toBeVisible();
  // a text file, and a playable type that is not this conversation's, keep
  // exactly the chip and the link they always had
  await expect(page.getByText("notes.txt")).toBeVisible();
  await expect(page.getByText("private.mp3")).toBeVisible();
  await expect(page.locator('[data-media-player] :text("private.mp3")')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /report/ })).toBeVisible();

  // the harness was asked in order, and never about a file with no player
  const asked = requests.filter(item => item.path.startsWith("/api/workspace-files") || item.path === "/api/media/resolve");
  expect(asked.some(item => item.path === "/api/workspace-files/root")).toBe(true);
  expect(asked.some(item => item.path === "/api/workspace-files/list")).toBe(true);
  expect(asked.filter(item => item.path === "/api/media/resolve").length).toBeGreaterThanOrEqual(3);
  // and only about files it has a player for: a .txt, a .md and a path from
  // outside this conversation are never named to the resolver at all
  expect([...new Set(resolved)].sort()).toEqual(["outputs/broken.wav", "outputs/take-a.wav", "outputs/take-b.wav"]);
  // no path was ever fetched as a URL
  expect(requests.filter(item => item.path.startsWith(ROOT) || item.path.startsWith("/Users/"))).toEqual([]);
});

test("nothing plays until a person asks, even with the autoplay policy wide open", async ({ page }) => {
  await open(page);
  const state = await players(page).first().evaluate((element: HTMLAudioElement) => ({
    autoplay: element.autoplay, paused: element.paused, played: element.played.length,
    preload: element.preload, controls: element.controls, time: element.currentTime,
  }));
  expect(state).toMatchObject({ autoplay: false, paused: true, played: 0, preload: "metadata", controls: true, time: 0 });
  // metadata really did load: the card knows how long the file is
  await expect.poll(() => players(page).first().evaluate((element: HTMLAudioElement) => element.duration)).toBeGreaterThan(1);
  await expect(page.getByText("0:30").first()).toBeVisible();
  await page.waitForTimeout(500);
  expect(await players(page).first().evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
});

test("starting one card pauses the other, and seeking asks for a later range", async ({ page }) => {
  await open(page);
  await play(page, 0);
  expect(await players(page).nth(1).evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);

  await play(page, 1);
  await expect.poll(() => players(page).nth(0).evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  expect(await players(page).nth(1).evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);

  // seek near the end: the browser asks for bytes it does not have yet
  await players(page).nth(1).evaluate((element: HTMLAudioElement) => { element.currentTime = element.duration - 3; });
  await expect.poll(() => players(page).nth(1).evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(20);
  const ranged = requests.filter(item => item.range && /^bytes=[1-9]/.test(item.range));
  expect(ranged.length).toBeGreaterThan(0);
  expect(ranged.every(item => item.status === 206)).toBe(true);
});

test("bytes that will not decode say so and keep Save a copy", async ({ page }) => {
  await open(page);
  const broken = page.locator('[data-media-player-state="unplayable"]');
  await expect(broken).toHaveCount(1);
  await expect(broken).toContainText("broken.wav");
  await expect(broken).toContainText(/Playback stopped|cannot play this format/i);
  await expect(broken.getByRole("link", { name: /Save a copy/ })).toBeVisible();
});

test("a capability that expired mid-listen is renewed in place, and playback carries on where it was", async ({ page }) => {
  // Resolve answers with a capability the card's clock will call expired one
  // second from now (its margin is 15 s); the harness itself keeps honouring
  // it until it is revoked below, the way a real token is fine until its exp.
  await fetch(`${origin}/__control?ttl=16000`);
  try {
    await open(page);
    const player = players(page).nth(1);
    await play(page, 1);
    await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(1);
    const askedBefore = resolved.filter(item => item === "outputs/take-b.wav").length;
    const firstCap = requests.find(item => item.status === 206 && item.path.includes(assetFor("take-b.wav").id))?.cap;
    expect(firstCap).toMatch(/^mc1\.gen1/);

    // The harness stops honouring every token issued so far.
    await fetch(`${origin}/__control?revoke=1`);
    // A seek far ahead needs bytes the element has not buffered: the request
    // goes out with the spent token and comes back 403.
    await player.evaluate((element: HTMLAudioElement) => { element.currentTime = element.duration - 3; });
    await expect.poll(() => requests.filter(item => item.status === 403).length).toBeGreaterThan(0);

    // The card asked the harness again, moved to the fresh token, put the
    // position back and kept playing — no dead card, no restart from 0:00.
    await expect.poll(() => resolved.filter(item => item === "outputs/take-b.wav").length).toBeGreaterThan(askedBefore);
    await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(290);
    await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
    await expect(player).toHaveAttribute("src", /cap=mc1\.gen2/);
    await expect(page.locator('[data-media-player-state="unplayable"]')).toHaveCount(1); // still only broken.wav
    const renewed = requests.filter(item => item.status === 206 && item.path.includes(assetFor("take-b.wav").id) && (item.cap ?? "").startsWith("mc1.gen2"));
    expect(renewed.length).toBeGreaterThan(0);
    // Save a copy now points at the fresh token as well.
    const card = page.locator('[data-media-player="audio"]').filter({ hasText: "take-b.wav" });
    await expect(card.getByRole("link", { name: /Save a copy/ })).toHaveAttribute("href", /cap=mc1\.gen2/);
  } finally {
    await fetch(`${origin}/__control?ttl=600000`);
  }
});

test("Save a copy on a card that stopped playing renews its link the same way the player's does", async ({ page }) => {
  // Fix round 1: the cannot-play and post-failure cards handed out the very
  // link the harness would refuse once the capability lapsed. Here the
  // capability lapses by the card's clock one second in, and the harness
  // stops honouring it; the click must go to the harness for a fresh token
  // and save through that, never through the spent one.
  await fetch(`${origin}/__control?ttl=16000`);
  try {
    await open(page);
    const broken = page.locator('[data-media-player-state="unplayable"]').filter({ hasText: "broken.wav" });
    await expect(broken).toHaveCount(1);
    const link = broken.getByRole("link", { name: /Save a copy/ });
    // Earlier tests may already have revoked once: read the generation the
    // card holds now rather than assume it.
    await expect(link).toHaveAttribute("href", /cap=mc1\.gen\d+/);
    const spent = capGeneration(new URL(String(await link.getAttribute("href")), origin).searchParams.get("cap"));
    // Past the card's expiry margin; then every token issued so far is refused.
    await page.waitForTimeout(1_500);
    await fetch(`${origin}/__control?revoke=1`);
    const asked = resolved.filter(item => item === "outputs/broken.wav").length;
    const id = assetFor("broken.wav").id;
    const download = page.waitForEvent("download");
    await link.click();
    const saved = await download;
    expect(capGeneration(new URL(saved.url()).searchParams.get("cap"))).toBe(spent + 1);
    expect(saved.suggestedFilename()).toBe("broken.wav");
    expect(resolved.filter(item => item === "outputs/broken.wav").length).toBe(asked + 1);
    // The spent token was never followed: no 403 for this file.
    expect(requests.filter(item => item.path.includes(id) && item.status === 403)).toEqual([]);
    await expect(link).toHaveAttribute("href", new RegExp(`cap=mc1\\.gen${spent + 1}`));
  } finally {
    await fetch(`${origin}/__control?ttl=600000`);
  }
});

test("a file that will not decode is reported once, not asked about again and again", async ({ page }) => {
  await open(page);
  // broken.wav's bytes fail in the decoder; its capability is live and the
  // failure is the bytes' own, so the card must not go back to the harness.
  const asked = resolved.filter(item => item === "outputs/broken.wav").length;
  await page.waitForTimeout(1_000);
  expect(resolved.filter(item => item === "outputs/broken.wav").length).toBe(asked);
  await expect(page.locator('[data-media-player-state="unplayable"]').filter({ hasText: "broken.wav" })).toHaveCount(1);
});

test("closing the thread pauses the player and lets its bytes go", async ({ page }) => {
  await open(page);
  await play(page, 0);
  await page.evaluate(() => {
    (window as unknown as { kept: HTMLAudioElement }).kept = document.querySelectorAll<HTMLAudioElement>('[data-testid="media-player-audio"]')[0]!;
  });
  await page.getByTestId("toggle").click();
  await expect(players(page)).toHaveCount(0);
  const after = await page.evaluate(() => {
    const element = (window as unknown as { kept: HTMLAudioElement }).kept;
    return { paused: element.paused, src: element.getAttribute("src"), connected: element.isConnected };
  });
  expect(after).toEqual({ paused: true, src: null, connected: false });
});
