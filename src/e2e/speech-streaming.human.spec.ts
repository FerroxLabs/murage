// The speaker plays a sentence while it is still downloading. The real
// speaker module runs in a real browser; the voice route is a local stand-in
// that sends a real mp3 slowly (a third, a pause, the rest), the way a voice
// service sends audio as it makes it. Nothing here touches a key.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

/** 3 s of a 330 Hz tone, mp3 (made with ffmpeg's sine source). */
const TONE = readFileSync(fileURLToPath(new URL("./speech-streaming-tone.mp3", import.meta.url)));
/** How long the stand-in waits before sending the rest of the clip. */
const HOLD_MS = 2_000;

let server: ViteDevServer, origin: string, cache: string;
/** When the stand-in sent its last byte, and whether the player hung up first. */
const sent = { lastByteAt: 0, hungUp: false, requests: 0 };

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-speech-stream-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    optimizeDeps: { noDiscovery: true },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [{
      name: "speech-streaming-fixture",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const path = req.url?.split("?")[0];
          if (path === "/__speak") {
            res.setHeader("content-type", "text/html");
            return res.end(`<script type="module">
              import { speaker } from "/src/lib/tts/index.ts";
              window.__heard = { firstSoundAt: 0, statuses: [] };
              // the speaker's clip is not in the page: watch every media element's clock
              const play = HTMLMediaElement.prototype.play;
              HTMLMediaElement.prototype.play = function () {
                this.addEventListener("timeupdate", () => {
                  if (this.currentTime > 0 && !window.__heard.firstSoundAt) window.__heard.firstSoundAt = performance.timeOrigin + performance.now();
                });
                return play.call(this);
              };
              speaker.subscribe((s) => window.__heard.statuses.push(s.status + (s.error ? ":" + s.error : "")));
              window.__speaker = speaker;
            </script>`);
          }
          if (path === "/api/tts/prepare") {
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify({ ready: true, utterances: ["One sentence."] }));
          }
          if (path !== "/api/tts/speak") return next();
          sent.requests += 1;
          res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "no-store" });
          const first = Math.floor(TONE.length / 3);
          res.write(TONE.subarray(0, first));
          let finished = false;
          res.on("close", () => { if (!finished) sent.hungUp = true; });
          setTimeout(() => {
            if (res.destroyed) return;
            finished = true;
            sent.lastByteAt = Date.now();
            res.end(TONE.subarray(first));
          }, HOLD_MS);
        });
      },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });
test.beforeEach(() => Object.assign(sent, { lastByteAt: 0, hungUp: false, requests: 0 }));

async function open(page: Page) {
  // the speaker plays without a click, as the desktop app does
  await page.goto(`${origin}/__speak`);
  await page.waitForFunction(() => Boolean((window as any).__speaker));
}

test("sound starts before the sentence has finished downloading, and the whole clip plays", async ({ page }) => {
  await open(page);
  const finished = page.evaluate(() => (window as any).__speaker.speak("One sentence."));
  await page.waitForFunction(() => (window as any).__heard.firstSoundAt > 0, undefined, { timeout: 10_000 });
  await finished;
  const heard = await page.evaluate(() => (window as any).__heard);
  // audible while the rest was still held back
  expect(sent.lastByteAt).toBeGreaterThan(0);
  expect(heard.firstSoundAt).toBeLessThan(sent.lastByteAt);
  // and it played to the end: no error, back to idle
  expect(heard.statuses.filter((s: string) => s.includes(":"))).toEqual([]);
  expect(heard.statuses.at(-1)).toBe("idle");
  expect(heard.statuses).toContain("speaking");
});

test("interrupting a sentence mid-download hangs up on the voice service", async ({ page }) => {
  await open(page);
  void page.evaluate(() => (window as any).__speaker.speak("One sentence."));
  await page.waitForFunction(() => (window as any).__heard.firstSoundAt > 0, undefined, { timeout: 10_000 });
  await page.evaluate(() => (window as any).__speaker.stop());
  await expect.poll(() => sent.hungUp, { timeout: 5_000 }).toBe(true);
  expect(sent.lastByteAt).toBe(0);
  expect(await page.evaluate(() => (window as any).__heard.statuses.at(-1))).toBe("idle");
});
