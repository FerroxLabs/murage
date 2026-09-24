#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Menu bar / system tray icons, drawn from the galaxy strokes in
// brand/app-icon.svg (lucide `galaxy`, ISC) on a transparent background.
//
// The app icon itself is an orange galaxy on a black tile. Resized to 18px
// and marked as a macOS template image, the tile's opaque pixels became a
// solid white square in the menu bar. These are the strokes alone.
//
// Deterministic and dependency free: the paths are flattened to polylines,
// every pixel is supersampled against the stroke outline, and the PNG and
// PNG-in-ICO containers are written with node:zlib. Re-running this script
// produces byte-identical files, and `--check` fails when the checked-in
// files differ from what it would write.
//
//   node scripts/build-tray-icons.mjs          write electron/resources/tray/*
//   node scripts/build-tray-icons.mjs --check  verify them
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SVG = path.join(root, "brand/app-icon.svg");
const OUT = path.join(root, "electron/resources/tray");
const ORANGE = [0xff, 0x6b, 0x35];
const BLACK = [0, 0, 0];
const ATTENTION = [0xe5, 0x48, 0x4d];
// Menu bar glyphs are drawn with ~1.5pt strokes at 18pt. Lucide's own
// default (2 of 24) lands exactly there at 18px; the brand tile's 1.7 reads
// thin and grey once shrunk. Colour tray icons share the weight.
const STROKE = 2;
const SAMPLES = 8;

// ── the glyph, read from the brand SVG so the two can never drift ──────
function readGlyph() {
  const svg = fs.readFileSync(SVG, "utf8");
  const group = svg.match(/<g\b[^>]*>([\s\S]*?)<\/g>/);
  if (!group) throw new Error("brand/app-icon.svg: galaxy group not found");
  const paths = [...group[1].matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(match => match[1]);
  const circles = [...group[1].matchAll(/<circle\b[^>]*\bcx="([\d.]+)"[^>]*\bcy="([\d.]+)"[^>]*\br="([\d.]+)"/g)]
    .map(match => ({ cx: Number(match[1]), cy: Number(match[2]), r: Number(match[3]) }));
  if (paths.length !== 4 || circles.length !== 1) throw new Error("brand/app-icon.svg: galaxy shape changed; review this script");
  return { polylines: paths.flatMap(flatten), circles };
}

/** SVG path data to polylines (M, m, A, a, H, h, L, l; enough for lucide galaxy).
 * Arc flags may be written without separators ("014.029"), as lucide does. */
function flatten(d) {
  // Raw text tokens: a flag is ONE character, and lucide writes the two
  // flags and the next number with no separator ("00-8.008", "0111.977").
  const tokens = d.match(/[MmAaHhLlZz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const lines = [];
  let line = null, x = 0, y = 0, command = null, i = 0;
  const isCommand = token => /^[A-Za-z]$/.test(token);
  const number = () => { const token = tokens[i++]; if (token === undefined || isCommand(token)) throw new Error(`bad path near ${token}`); return Number(token); };
  const flag = () => {
    const token = tokens[i];
    if (token === undefined || !/^[01]/.test(token)) throw new Error(`bad arc flag ${token}`);
    if (token.length === 1) i++; else tokens[i] = token.slice(1);
    return Number(token[0]);
  };
  while (i < tokens.length) {
    if (isCommand(tokens[i])) command = tokens[i++];
    const relative = command === command.toLowerCase();
    switch (command.toUpperCase()) {
      case "M": {
        const nx = number(), ny = number();
        x = relative ? x + nx : nx; y = relative ? y + ny : ny;
        line = [[x, y]]; lines.push(line); command = relative ? "l" : "L"; break;
      }
      case "L": { const nx = number(), ny = number(); x = relative ? x + nx : nx; y = relative ? y + ny : ny; line.push([x, y]); break; }
      case "H": { const nx = number(); x = relative ? x + nx : nx; line.push([x, y]); break; }
      case "A": {
        const rx = number(), ry = number(), rotation = number();
        const large = flag(), sweep = flag();
        let tx = number(), ty = number();
        if (relative) { tx += x; ty += y; }
        line.push(...arcPoints(x, y, rx, ry, rotation, large, sweep, tx, ty));
        x = tx; y = ty; break;
      }
      case "Z": line.push([...line[0]]); break;
      default: throw new Error(`unsupported path command ${command}`);
    }
  }
  return lines;
}

/** Endpoint-to-centre arc conversion (SVG 1.1 implementation notes F.6.5). */
function arcPoints(x1, y1, rx, ry, degrees, large, sweep, x2, y2) {
  const phi = degrees * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = factor * (rx * y1p) / ry, cyp = factor * -(ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const start = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const steps = Math.max(8, Math.ceil(Math.abs(delta) * 48));
  const points = [];
  for (let step = 1; step <= steps; step++) {
    const t = start + delta * step / steps;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    points.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
  return points;
}

function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const vx = bx - ax, vy = by - ay, length = vx * vx + vy * vy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / length));
  const qx = ax + t * vx - px, qy = ay + t * vy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

/** Coverage (0..1) per pixel in 24-unit viewBox space, `size` px square. */
function rasterize(glyph, size, { dot } = {}) {
  const scale = size / 24, half = STROKE / 2;
  const segments = glyph.polylines.flatMap(line => line.length === 1 ? [[line[0], line[0]]] : line.slice(1).map((point, index) => [line[index], point]));
  const galaxy = new Float64Array(size * size), badge = new Float64Array(size * size);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let inGalaxy = 0, inBadge = 0;
    for (let sy = 0; sy < SAMPLES; sy++) for (let sx = 0; sx < SAMPLES; sx++) {
      const ux = (px + (sx + 0.5) / SAMPLES) / scale, uy = (py + (sy + 0.5) / SAMPLES) / scale;
      if (dot) {
        const distance = Math.hypot(ux - dot.cx, uy - dot.cy);
        if (distance <= dot.r) { inBadge++; continue; }
        if (distance <= dot.r + dot.gap) continue; // a clear ring keeps the dot legible
      }
      let hit = glyph.circles.some(circle => Math.hypot(ux - circle.cx, uy - circle.cy) <= circle.r);
      for (let s = 0; !hit && s < segments.length; s++) hit = segmentDistance(ux, uy, segments[s][0], segments[s][1]) <= half;
      if (hit) inGalaxy++;
    }
    galaxy[py * size + px] = inGalaxy / (SAMPLES * SAMPLES);
    badge[py * size + px] = inBadge / (SAMPLES * SAMPLES);
  }
  return { galaxy, badge };
}

function rgba(size, layers) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let index = 0; index < size * size; index++) {
    let alpha = 0, r = 0, g = 0, b = 0;
    for (const { coverage, color } of layers) {
      const a = coverage[index];
      if (!a) continue;
      // coverage layers never overlap (the badge clears its ring), so a sum is exact
      r += color[0] * a; g += color[1] * a; b += color[2] * a; alpha += a;
    }
    if (alpha > 0) { r /= alpha; g /= alpha; b /= alpha; }
    pixels.set([Math.round(r), Math.round(g), Math.round(b), Math.round(Math.min(1, alpha) * 255)], index * 4);
  }
  return pixels;
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buffer => { let c = 0xffffffff; for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA, no interlace
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
/** PNG-compressed ICO entries (Windows Vista and later). */
function ico(images) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8); entry.writeUInt32LE(offset, 12);
    offset += data.length; return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(image => image.data)]);
}

export function buildTrayIcons() {
  const glyph = readGlyph();
  const files = new Map();
  const draw = (size, color, attention) => {
    const { galaxy, badge } = rasterize(glyph, size, attention ? { dot: { cx: 20.5, cy: 3.5, r: 3.5, gap: 1.2 } } : {});
    return png(size, rgba(size, [{ coverage: galaxy, color }, { coverage: badge, color: ATTENTION }]));
  };
  // macOS: black on transparent, marked as a template image at runtime.
  files.set("trayTemplate.png", draw(18, BLACK));
  files.set("trayTemplate@2x.png", draw(36, BLACK));
  for (const [name, attention] of [["tray", false], ["tray-attention", true]]) {
    const sizes = [16, 22, 24, 32, 48];
    const images = sizes.map(size => ({ size, data: draw(size, ORANGE, attention) }));
    for (const image of images) files.set(`${name}-${image.size}.png`, image.data);
    files.set(`${name}.ico`, ico(images.filter(image => image.size !== 22)));
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = buildTrayIcons();
  if (process.argv.includes("--check")) {
    const stale = [...files].filter(([name, data]) => { try { return !fs.readFileSync(path.join(OUT, name)).equals(data); } catch { return true; } });
    if (stale.length) { console.error(`Tray icons are out of date: ${stale.map(([name]) => name).join(", ")}. Run node scripts/build-tray-icons.mjs`); process.exit(1); }
    console.log(`Tray icons match (${files.size} files).`);
  } else {
    fs.mkdirSync(OUT, { recursive: true });
    for (const [name, data] of files) fs.writeFileSync(path.join(OUT, name), data);
    console.log(`Wrote ${files.size} tray icons to ${path.relative(root, OUT)}`);
  }
}
