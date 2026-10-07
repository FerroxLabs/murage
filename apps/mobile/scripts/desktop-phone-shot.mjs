#!/usr/bin/env node
// Regenerates the picture of the desktop's Settings, then "Phone and other
// devices" that the phone's "Get your code ready" screen shows
// (src/assets/desktop-phone-{light,dark}.webp), and the manifest the
// staleness test reads (src/assets/desktop-phone-shot.json).
//
// Run it from anywhere after the desktop page changes:
//   node apps/mobile/scripts/desktop-phone-shot.mjs [--evidence <dir>]
// --evidence also saves whole-page PNGs (on, off, the confirm dialog; light
// and dark) for a review.
//
// What it does: serves the repo's own src/ with the root's Vite (React and
// Tailwind, no config file, so no /api proxy to any running Murage) on
// 127.0.0.1:28470, opens scripts/desktop-phone-shot/fixture.html in headless
// Chromium, draws the highlight round the switch and the code, crops, and
// encodes WebP in the page. Everything on the page is made up (see
// fixture.tsx): no real login, code or address can reach the picture.
import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const ROOT = resolve(MOBILE, "../..");
const ASSETS = join(MOBILE, "src/assets");
const PORT = 28470;
/** Each picture stays small: it ships inside the app. */
const MAX_BYTES = 100 * 1024;
const WIDTH = 760;
const SCALE = 1.5;
/** Forge Orange, the desktop's dark accent, readable on both themes. */
const HIGHLIGHT = "#ff6b35";
/** A fixed clock, language and zone: a rerun with no page change writes the same files. */
const CLOCK = new Date("2026-01-05T09:00:00Z");
const STEADY = { locale: "en-US", timezoneId: "UTC" };

const evidenceAt = process.argv.indexOf("--evidence");
const evidenceArg = evidenceAt > 0 ? process.argv[evidenceAt + 1] : undefined;
if (evidenceAt > 0 && !evidenceArg) throw new Error("--evidence needs a directory");
const evidence = evidenceArg ? resolve(evidenceArg) : null;

const rootRequire = createRequire(join(ROOT, "package.json"));
const { createServer } = await import(pathToFileURL(join(ROOT, "node_modules/vite/dist/node/index.js")).href);
const react = (await import(pathToFileURL(rootRequire.resolve("@vitejs/plugin-react")).href)).default;
const tailwindcss = (await import(pathToFileURL(rootRequire.resolve("@tailwindcss/vite")).href)).default;
const { chromium } = rootRequire("@playwright/test");

const server = await createServer({
  configFile: false,
  root: ROOT,
  logLevel: "warn",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": join(ROOT, "src") } },
  server: { host: "127.0.0.1", port: PORT, strictPort: true, hmr: false },
});
await server.listen();
const base = `http://127.0.0.1:${PORT}/apps/mobile/scripts/desktop-phone-shot/fixture.html`;

const browser = await chromium.launch();
try {
  const shots = {};
  let strings = null;
  let size = null;
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: WIDTH + 140, height: 1400 }, deviceScaleFactor: SCALE, colorScheme: theme, ...STEADY });
    await page.clock.setFixedTime(CLOCK); // the same "Expires at" every run, so the same bytes
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${base}?state=on&theme=${theme}`);
    await page.waitForSelector('[aria-label="Browser sign-in QR code"] svg', { timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    if (errors.length) throw new Error(`the fixture threw: ${errors.join("; ")}`);

    // The strings the picture shows, read from what was drawn.
    const drawn = await page.evaluate(() => {
      const root = document.querySelector('[data-shot="page"]');
      const title = root.querySelector("h2");
      const toggle = root.querySelector('[role="switch"][aria-label^="Turn on"]');
      const row = toggle.parentElement; // the label and the switch
      const label = row.querySelector(".text-ink");
      const subtitle = label.nextElementSibling;
      const qr = root.querySelector('[aria-label="Browser sign-in QR code"]');
      const code = qr.parentElement; // the QR and the typed code beside it
      const card = [...root.querySelectorAll("h3, div")].find((node) => node.textContent === "Sign in on another device" && node.children.length === 0);
      let cardBox = card;
      while (cardBox && !cardBox.contains(qr)) cardBox = cardBox.parentElement;
      return {
        strings: { title: title.textContent.trim(), switchLabel: label.textContent.trim(), switchSubtitle: subtitle.textContent.trim(), cardTitle: card.textContent.trim() },
        boxes: [title, row, code, cardBox].map((node) => {
          const box = node.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        }),
      };
    });
    const [titleBox, rowBox, codeBox, cardBox] = drawn.boxes;
    strings ??= drawn.strings;
    if (JSON.stringify(strings) !== JSON.stringify(drawn.strings)) throw new Error("the two themes drew different words");

    // The highlight, drawn into the page so it is part of the picture.
    await page.evaluate(({ boxes, color }) => {
      for (const box of boxes) {
        const ring = document.createElement("div");
        const pad = 6;
        Object.assign(ring.style, {
          position: "absolute",
          left: `${box.x - pad + window.scrollX}px`,
          top: `${box.y - pad + window.scrollY}px`,
          width: `${box.width + pad * 2}px`,
          height: `${box.height + pad * 2}px`,
          border: `3px solid ${color}`,
          borderRadius: "14px",
          boxShadow: `0 0 0 4px ${color}33`,
          pointerEvents: "none",
          zIndex: "60",
        });
        document.body.append(ring);
      }
    }, { boxes: [rowBox, codeBox], color: HIGHLIGHT });

    const margin = 16;
    const clip = {
      x: Math.floor(cardBox.x - margin),
      y: Math.floor(titleBox.y - margin),
      width: Math.ceil(cardBox.width + margin * 2),
      height: Math.ceil(cardBox.y + cardBox.height - titleBox.y + margin * 2),
    };
    const png = await page.screenshot({ clip, type: "png", animations: "disabled", caret: "hide" });
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, `desktop-phone-shot-${theme}.png`), png);
    }

    // WebP, encoded by Chromium: the quality comes down until it fits.
    const webp = await page.evaluate(async ({ data, max }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);
      let out = "";
      for (let quality = 0.86; quality >= 0.4; quality -= 0.06) {
        out = canvas.toDataURL("image/webp", quality);
        if (!out.startsWith("data:image/webp")) throw new Error("this Chromium cannot encode WebP");
        if (out.length * 0.75 <= max) break;
      }
      return { out: out.slice(out.indexOf(",") + 1), width: canvas.width, height: canvas.height };
    }, { data: png.toString("base64"), max: MAX_BYTES * 0.6 });
    const bytes = Buffer.from(webp.out, "base64");
    if (bytes.length > MAX_BYTES) throw new Error(`${theme}: ${bytes.length} bytes is over ${MAX_BYTES}`);
    size ??= { width: webp.width, height: webp.height };
    const file = `desktop-phone-${theme}.webp`;
    mkdirSync(ASSETS, { recursive: true });
    writeFileSync(join(ASSETS, file), bytes);
    shots[theme] = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    await page.close();
  }

  // The staleness test (src/desktop-shot.test.ts) compares these strings
  // with CompanionSection.tsx, and the hashes with the files.
  const manifest = {
    note: "Written by scripts/desktop-phone-shot.mjs. Rerun it when the desktop page changes.",
    strings,
    width: size.width,
    height: size.height,
    shots,
  };
  writeFileSync(join(ASSETS, "desktop-phone-shot.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [theme, shot] of Object.entries(shots)) console.log(`${theme}: ${shot.file} ${shot.bytes} bytes, ${size.width}x${size.height}`);

  if (evidence) {
    for (const theme of ["light", "dark"]) {
      for (const state of ["on", "off", "confirm"]) {
        const page = await browser.newPage({ viewport: { width: 1100, height: 1900 }, colorScheme: theme, ...STEADY });
        await page.clock.setFixedTime(CLOCK);
        await page.goto(`${base}?state=${state}&theme=${theme}`);
        await page.waitForSelector(state === "on" ? '[aria-label="Browser sign-in QR code"] svg' : state === "confirm" ? '[role="dialog"]' : '[role="switch"]', { timeout: 60_000 });
        await page.evaluate(() => document.fonts.ready);
        writeFileSync(join(evidence, `desktop-${state}-${theme}.png`), await page.screenshot({ fullPage: true }));
        await page.close();
      }
    }
    console.log(`evidence: ${evidence}`);
  }
} finally {
  await browser.close();
  await server.close();
}

// A last look at the sizes, so a bad run is loud.
for (const theme of ["light", "dark"]) {
  const bytes = statSync(join(ASSETS, `desktop-phone-${theme}.webp`)).size;
  if (bytes > MAX_BYTES) throw new Error(`${theme} is ${bytes} bytes`);
}
