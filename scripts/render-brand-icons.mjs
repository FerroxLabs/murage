// Rasterise brand/app-icon.svg into every icon artefact the desktop build ships.
//
// WHY ELECTRON AND NOT A LIBRARY. The repo already depends on Electron, and
// Electron is Chromium — the same renderer that will draw this SVG in the app.
// Adding sharp/resvg/librsvg to turn one vector into twelve PNGs would be a new
// native dependency in the build path for a job the tree can already do, and a
// second SVG engine is a second set of rounding differences. `qlmanage` was the
// other candidate and is wrong for this: it produces THUMBNAILS, letterboxing
// non-square output and refusing exact pixel sizes.
//
// WHY NOT ICONUTIL FOR EVERYTHING. iconutil builds .icns from an .iconset and
// nothing else — Windows .ico has no macOS tool at all, so it is assembled here.
// ICO has embedded-PNG support (Vista onward) which electron-builder and every
// current Windows shell read, so each entry is simply the PNG for that size.
//
// Usage:  node scripts/render-brand-icons.mjs [--check]
//         --check renders and compares against what is on disk without writing,
//         so CI can fail when the vector and the shipped rasters disagree.
import { app, BrowserWindow } from "electron";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Two switches, both load-bearing, both found by failing:
//
// Software rendering, because offscreen compositing was the first attempt and
// dies here with `UnknownVizError`. A hidden window with the GPU out of the path
// is simpler and deterministic, which is what an icon pipeline wants — the same
// bytes on any machine.
app.disableHardwareAcceleration();
// Device scale 1, because this is a Retina Mac: a 16px window captured as 32x32
// and the size assertion below caught it. Without this every icon ships at twice
// its nominal size, which no assertion downstream would notice — a 32px image in
// icon_16x16.png is still a valid PNG.
app.commandLine.appendSwitch("force-device-scale-factor", "1");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SOURCE = join(ROOT, "brand", "app-icon.svg");
const ICONSET = join(ROOT, "build", "icon.iconset");
const CHECK = process.argv.includes("--check");

/** The macOS iconset contract: every name Apple's tooling expects, and the pixel
 *  size each one actually is. `@2x` is a naming convention, not a scale factor
 *  applied at render time — icon_32x32@2x.png is a 64px image. */
const ICONSET_FILES = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_64x64.png", 64],
  ["icon_64x64@2x.png", 128],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

/** Sizes Windows shells actually pick from. 256 is the largest ICO entry that
 *  is universally understood; beyond it the shell falls back to the next down. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * Assemble PNG buffers into an .ico.
 *
 * Layout: a 6-byte header, then one 16-byte directory entry per image, then the
 * image data. A dimension of 256 is written as 0 — the field is one byte, so 256
 * does not fit and 0 is how the format spells it. Getting that wrong yields an
 * icon Windows silently declines to draw.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette size, 0 for true colour
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/** One rasterising routine, shared by the square icon and the maskable one.
 *  `__SRC__` and `__SIZES__` are substituted before it is evaluated in the page. */
const RENDER = `(async () => {
  const img = new Image();
  img.src = __SRC__;
  await img.decode();
  const out = {};
  for (const size of __SIZES__) {
    const ss = size * 4;
    const big = new OffscreenCanvas(ss, ss);
    const bx = big.getContext("2d");
    bx.clearRect(0, 0, ss, ss);
    bx.drawImage(img, 0, 0, ss, ss);
    const c = new OffscreenCanvas(size, size);
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = "high";
    x.clearRect(0, 0, size, size);
    x.drawImage(big, 0, 0, size, size);
    const buf = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
    let s = "";
    for (const b of buf) s += String.fromCharCode(b);
    out[size] = btoa(s);
  }
  return out;
})()`;

const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);

async function main() {
  const svg = readFileSync(SOURCE, "utf8");
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

  const sizes = [...new Set([...ICONSET_FILES.map(([, s]) => s), ...ICO_SIZES, 180, 192, 1024])].sort(
    (a, b) => a - b,
  );

  // Rasterise in a CANVAS rather than with `capturePage`. capturePage was the
  // first approach and is wrong twice over on this host: it returns a 2x bitmap
  // on Retina whatever `force-device-scale-factor` says, and a transparent
  // window under software rendering intermittently dies with `UnknownVizError`.
  // A canvas has neither problem — it is exactly the pixels asked for, with a
  // real alpha channel, and the window never has to be composited at all.
  //
  // Each icon is drawn at 4x and stepped down, which is supersampling: a stroked
  // glyph at 16px has far cleaner edges this way than drawn straight to 16px.
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  await win.loadURL("data:text/html,<body></body>");
  const encoded = await win.webContents.executeJavaScript(
    RENDER.replace("__SRC__", JSON.stringify(dataUrl)).replace("__SIZES__", JSON.stringify(sizes)),
  );

  const rendered = new Map();
  for (const size of sizes) {
    const png = Buffer.from(encoded[String(size)], "base64");
    // PNG stores width and height as big-endian uint32 at bytes 16 and 20. Read
    // them back rather than trusting the canvas: a silently doubled icon is a
    // valid PNG and nothing downstream would ever complain.
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    if (w !== size || h !== size) throw new Error(`${size}px rendered as ${w}x${h}`);
    rendered.set(size, png);
  }

  // The PWA set the browser door and phone home screen use. Rendered from the
  // SAME vector so a phone icon can never drift from the desktop one.
  const pwa = [
    ["public/icons/murage-180.png", 180],
    ["public/icons/murage-192.png", 192],
    ["public/icons/murage-512.png", 512],
  ];

  // Maskable icons come from a DIFFERENT vector: the ground bleeds edge to edge,
  // because Android and iOS crop these to their own shape. Baking a squircle in
  // would be cropped twice and read as a rounded rect floating inside a circle.
  const maskSvg = readFileSync(join(ROOT, "brand", "app-icon-maskable.svg"), "utf8");
  const maskUrl = `data:image/svg+xml;base64,${Buffer.from(maskSvg).toString("base64")}`;
  // Same window, deliberately: creating a second BrowserWindow after destroying
  // the first raced and failed the data-URL load with ERR_FAILED.
  const maskEncoded = await win.webContents.executeJavaScript(
    RENDER.replace("__SRC__", JSON.stringify(maskUrl)).replace("__SIZES__", JSON.stringify([192, 512])),
  );
  win.destroy();

  const writes = [];
  mkdirSync(ICONSET, { recursive: true });
  for (const [rel, size] of pwa) writes.push([join(ROOT, rel), rendered.get(size)]);
  for (const size of [192, 512]) {
    writes.push([
      join(ROOT, "public", "icons", `murage-maskable-${size}.png`),
      Buffer.from(maskEncoded[String(size)], "base64"),
    ]);
  }
  for (const [name, size] of ICONSET_FILES) writes.push([join(ICONSET, name), rendered.get(size)]);
  writes.push([join(ROOT, "electron", "resources", "app-icon.png"), rendered.get(1024)]);
  writes.push([
    join(ROOT, "build", "icon.ico"),
    buildIco(ICO_SIZES.map((size) => ({ size, png: rendered.get(size) }))),
  ]);

  let drift = 0;
  for (const [path, buf] of writes) {
    const before = existsSync(path) ? sha(readFileSync(path)) : "absent";
    const after = sha(buf);
    const changed = before !== after;
    if (changed) drift += 1;
    console.log(`${changed ? "~" : " "} ${path.slice(ROOT.length + 1).padEnd(38)} ${before} -> ${after}`);
    if (!CHECK) writeFileSync(path, buf);
  }

  console.log(
    CHECK
      ? `\n--check: ${drift} file(s) would change. Nothing written.`
      : `\nWrote ${writes.length} file(s). Now run:\n  iconutil -c icns build/icon.iconset -o build/icon.icns`,
  );
  app.exit(CHECK && drift > 0 ? 1 : 0);
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});
