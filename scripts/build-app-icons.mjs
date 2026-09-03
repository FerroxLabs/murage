#!/usr/bin/env node
// Regenerates every browser-facing icon from `public/app-icon.svg`.
//
// One-shot: the outputs are committed, and nothing in the build or the test
// gates runs this. It exists so the icon set can be rebuilt from the mark
// rather than hand-cropped the next time the mark changes — run
// `node scripts/build-app-icons.mjs` and commit what it writes.
//
// Three families, because the platforms mask differently and a single file
// cannot satisfy all three:
//
//   any        — the mark as designed, rounded corners and transparency intact.
//                What a desktop install prompt and a browser tab show.
//   maskable   — Android crops an adaptive icon to a shape of its own choosing
//                and only guarantees the central 80%-diameter circle survives.
//                A transparent-cornered icon there gets the launcher's default
//                background showing through the corners, so this family is
//                flattened full-bleed onto the mark's own body colour and the
//                glyph is scaled to sit inside that circle. Measured: the glyph
//                spans 85.6% of the tile's width, so at 0.80 scale its furthest
//                corner sits 0.383 from centre against a 0.40 budget.
//   apple      — iOS ignores `manifest.webmanifest` icons for the home screen
//                and re-rounds whatever `apple-touch-icon` points at. Handing
//                it pre-rounded transparent corners produces a double-rounded
//                tile with light fringing, so this one is flattened too, at
//                full size, and iOS applies the only corner radius.
//
// The source SVG is a 1024px wrapper around a single embedded PNG whose mark
// is 1003x937 and sits flush to the top — 66px of the canvas below it is
// empty. Every output here is trimmed to the mark and re-centred on a square,
// which is why they are not just resizes of the source.
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(root, "public", "app-icon.svg");
const ICONS = path.join(root, "public", "icons");

/** The mark's own body colour, sampled from the flat area inside the
 * squircle. Used as the flattened ground so the squircle's edge disappears
 * into it and the tile reads as one solid shape rather than a badge on a
 * background. */
const BODY = { r: 15, g: 16, b: 22 };

/** How much of a maskable tile the mark occupies. See the note above. */
const MASKABLE_SCALE = 0.8;

/** The mark, trimmed of the source's empty margin and re-centred on a square
 * canvas, at 1024px with transparency intact. Everything else derives from
 * this. */
async function master() {
  const trimmed = await sharp(SOURCE, { density: 512 })
    .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .trim({ threshold: 24 })
    .toBuffer({ resolveWithObject: true });
  const side = Math.max(trimmed.info.width, trimmed.info.height);
  return sharp(trimmed.data)
    .extend({
      top: Math.floor((side - trimmed.info.height) / 2),
      bottom: Math.ceil((side - trimmed.info.height) / 2),
      left: Math.floor((side - trimmed.info.width) / 2),
      right: Math.ceil((side - trimmed.info.width) / 2),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .resize(1024, 1024)
    .png()
    .toBuffer();
}

/** Transparent, as designed. */
const any = (src, size) => sharp(src).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

/** Flattened full-bleed onto BODY, with the mark inset by `scale`. */
async function flat(src, size, scale) {
  const inner = Math.round(size * scale);
  const mark = await sharp(src).resize(inner, inner).toBuffer();
  const offset = Math.round((size - inner) / 2);
  return sharp({
    create: { width: size, height: size, channels: 4, background: { ...BODY, alpha: 1 } },
  })
    .composite([{ input: mark, top: offset, left: offset }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** A minimal ICO carrying PNG payloads.
 *
 * Hand-rolled rather than pulled from a package: the format is a 6-byte header
 * and a 16-byte directory entry per image, and PNG-in-ICO has been read by
 * every browser since IE11. `favicon.ico` exists only for the clients that ask
 * for it by name without reading the document's <link>. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette colours
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

const src = await master();
await mkdir(ICONS, { recursive: true });

const written = [];
const write = async (name, data) => {
  const file = name === "favicon.ico" ? path.join(root, "public", name) : path.join(ICONS, name);
  await writeFile(file, data);
  written.push(`${path.relative(root, file)}  ${(data.length / 1024).toFixed(1)}KB`);
};

await write("murage-192.png", await any(src, 192));
await write("murage-512.png", await any(src, 512));
await write("murage-maskable-192.png", await flat(src, 192, MASKABLE_SCALE));
await write("murage-maskable-512.png", await flat(src, 512, MASKABLE_SCALE));
await write("murage-180.png", await flat(src, 180, 1));
await write(
  "favicon.ico",
  ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await any(src, size) })))),
);

console.log(written.join("\n"));
