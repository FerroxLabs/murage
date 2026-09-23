// The REAL Silero model through the app's own build path (Vite, the ONNX
// runtime's WebAssembly, the model from public/): a beep is not speech,
// spoken words are. The call's other specs fake the model; this one proves
// the real one loads and decides in a browser.
import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

let server: ViteDevServer, origin: string, cache: string;
const root = fileURLToPath(new URL("../..", import.meta.url));

test.beforeAll(async () => {
  cache = mkdtempSync(join(tmpdir(), "murage-vad-vite-"));
  server = await createServer({
    root,
    cacheDir: cache,
    configFile: false,
    logLevel: "error",
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [{
      name: "vad-fixture",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/__vad") return next();
          res.setHeader("content-type", "text/html");
          res.end(`<script type="module">import { SileroVad } from "/src/lib/silero-vad.ts"; window.__vad = SileroVad;</script>`);
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

/** 16 kHz mono samples of spoken words, from the Mac's own voice. */
function speech(): number[] | null {
  if (process.platform !== "darwin") return null;
  const file = join(cache, "speech.wav");
  execFileSync("say", ["-o", file, "--data-format=LEI16@16000", "Hold on a second, what about the stock market today?"]);
  if (!existsSync(file)) return null;
  const buf = readFileSync(file);
  let at = 12;
  while (buf.toString("ascii", at, at + 4) !== "data") at += 8 + buf.readUInt32LE(at + 4);
  const size = buf.readUInt32LE(at + 4);
  return Array.from(new Int16Array(buf.buffer.slice(buf.byteOffset + at + 8, buf.byteOffset + at + 8 + size)), (v) => v / 32768);
}

test("the real model loads in the browser and tells a beep from speech", async ({ page }) => {
  await page.goto(`${origin}/__vad`);
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__vad))).toBe(true);
  const beep = Array.from({ length: 16_000 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 1_000 * i) / 16_000));
  const words = speech();
  const result = await page.evaluate(async ({ beep, words }) => {
    const Vad = (window as any).__vad;
    const judge = async (samples: number[]) => {
      const vad = await Vad.load();
      if (!vad) return null;
      const scores: number[] = [];
      for (let i = 0; i + 1024 <= samples.length; i += 1024) scores.push(await vad.push(Float32Array.from(samples.slice(i, i + 1024))));
      return scores;
    };
    return { beep: await judge(beep), words: words ? await judge(words) : null };
  }, { beep, words });
  expect(result.beep).not.toBeNull();
  expect(Math.max(...result.beep!)).toBeLessThan(0.3);
  if (result.words) {
    const speechy = result.words.filter((p: number) => p >= 0.7).length / result.words.length;
    expect(speechy).toBeGreaterThan(0.5);
  }
});
