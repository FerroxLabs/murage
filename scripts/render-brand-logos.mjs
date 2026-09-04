// Bake brand/logo-{light,dark}.svg into the two wordmark PNGs the app shows.
//
// WHY PNG AND NOT THE SVG DIRECTLY. Onboarding.tsx renders the wordmark through
// an <img>, and an SVG loaded that way is an isolated document: it cannot reach
// the page's fonts. The lockup sets MURAGE in Sora 800, so shipping the SVG would
// silently fall back to whatever generic sans the machine has — the letterforms
// would differ per user, which is the one thing a wordmark may not do. Baking
// resolves Sora once, here, at build time. That is also what the assets being
// replaced already did; Onboarding.tsx:228 calls it "baked ink, not a tintable
// glyph", which is why there are two files rather than one tinted by CSS.
//
// Rendered at 3x the 56px display height so it stays crisp on Retina, using the
// same OffscreenCanvas path as render-brand-icons.mjs — see that file's header
// for why capturePage and qlmanage are both wrong for this.
//
// Usage:  node scripts/render-brand-logos.mjs [--check]
import { app, BrowserWindow } from "electron";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

app.disableHardwareAcceleration();

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CHECK = process.argv.includes("--check");

/** Display height is 56px (`h-14`); 3x keeps it sharp on any display we ship to.
 *  Named for the theme the file is USED on, not the ink colour it contains. */
const HEIGHT = 168;
const JOBS = [
  // skin === "light" asks for murage-logo-dark.png — dark ink for a light card.
  ["logo-light.svg", "murage-logo-dark.png"],
  // everything else gets the white-ink version.
  ["logo-dark.svg", "murage-logo.png"],
];

const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 12);

async function main() {
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  await win.loadURL("data:text/html,<body></body>");

  // Sora has to be resolvable to Chromium or the bake is worthless. Ask before
  // drawing, rather than shipping a silent Helvetica fallback that nobody
  // notices until the wordmark looks subtly wrong in the installer.
  const hasSora = await win.webContents.executeJavaScript(
    `document.fonts.check('800 40px Sora')`,
  );
  if (!hasSora) {
    throw new Error(
      "Sora is not available to this renderer, so MURAGE would bake in a fallback face. " +
        "Install Sora (https://fonts.google.com/specimen/Sora) and re-run.",
    );
  }

  let drift = 0;
  for (const [src, out] of JOBS) {
    const svg = readFileSync(join(ROOT, "brand", src), "utf8");
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    const b64 = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(dataUrl)};
      await img.decode();
      const h = ${HEIGHT};
      const w = Math.round(h * (img.naturalWidth / img.naturalHeight));
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext("2d");
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = "high";
      x.clearRect(0, 0, w, h);
      x.drawImage(img, 0, 0, w, h);
      const buf = new Uint8Array(await (await c.convertToBlob({type:"image/png"})).arrayBuffer());
      let s = ""; for (const b of buf) s += String.fromCharCode(b);
      return btoa(s);
    })()`);

    const png = Buffer.from(b64, "base64");
    const h = png.readUInt32BE(20);
    if (h !== HEIGHT) throw new Error(`${out} rendered ${h}px tall, expected ${HEIGHT}`);

    const path = join(ROOT, "public", out);
    const before = existsSync(path) ? sha(readFileSync(path)) : "absent";
    const after = sha(png);
    if (before !== after) drift += 1;
    console.log(
      `${before !== after ? "~" : " "} public/${out.padEnd(24)} ${before} -> ${after}  ` +
        `${png.readUInt32BE(16)}x${h}`,
    );
    if (!CHECK) writeFileSync(path, png);
  }

  win.destroy();
  console.log(CHECK ? `\n--check: ${drift} file(s) would change.` : `\nWrote ${JOBS.length} file(s).`);
  app.exit(CHECK && drift > 0 ? 1 : 0);
}

app.whenReady().then(main).catch((error) => {
  console.error(String(error?.message ?? error));
  app.exit(1);
});
