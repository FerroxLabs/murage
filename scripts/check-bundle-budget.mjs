// The first-paint payload budget (spec §6).
//
// A phone opening Murage over cellular downloads index.html, the entry chunk,
// every chunk the entry statically imports, and their CSS before it can draw a
// message. That set is what this measures, compressed the way the door will
// send it (brotli), after `vite build` and against the manifest Vite writes
// (vite.config.ts `build.manifest`). Chunks behind `lazy()` or `import()` are
// not counted; that is the point of them.
//
// It also fails a script or stylesheet the browser door would refuse. The door
// serves `/assets/` by an exact name pattern (companion/src/routes.ts
// BROWSER_STATIC), so a chunk named with a dot in its stem 404s on a phone and
// works on the desktop, which no desktop test would notice.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

/** 750 KiB at brotli quality 11. Set after the E1–E3 splits from the measured
 *  pre-split first paint (~900–950 KiB); the reasoning is in the plan that
 *  introduced it. Lower it when the first paint shrinks; never raise it to
 *  make a regression pass. */
export const FIRST_PAINT_BROTLI_BUDGET = 750 * 1024;

/** The door's `/assets/` pattern for the file types this checks (js, css). */
export const DOOR_ASSET = /^assets\/[\w-]+\.(?:js|css|woff2|svg|png|json)$/;

export function brotliSize(bytes) {
  return brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength },
  }).byteLength;
}

/** The files the first paint loads: the entry chunk, its static imports
 *  (transitively), and their CSS. Dynamic imports are not followed. */
export function firstPaintFiles(manifest, entry = "index.html") {
  const files = new Set();
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`the Vite manifest has no chunk "${key}"`);
    if (key !== entry || chunk.file) files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const next of chunk.imports ?? []) visit(next);
  };
  visit(entry);
  return [...files].sort();
}

function readManifest(distDir) {
  const path = join(distDir, ".vite", "manifest.json");
  if (!existsSync(path)) {
    throw new Error(`${path} is missing: build with vite.config.ts build.manifest on, then run this again`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function checkBudget(distDir, budget = FIRST_PAINT_BROTLI_BUDGET) {
  const manifest = readManifest(distDir);
  const files = ["index.html", ...firstPaintFiles(manifest)].map((file) => {
    const bytes = readFileSync(join(distDir, file));
    return { file, raw: bytes.byteLength, brotli: brotliSize(bytes) };
  });
  const total = files.reduce((sum, entry) => sum + entry.brotli, 0);
  const emitted = new Set(Object.values(manifest).flatMap((chunk) => [chunk.file, ...(chunk.css ?? [])]));
  const doorMisses = [...emitted].filter((file) => /\.(?:js|css)$/.test(file) && !DOOR_ASSET.test(file)).sort();
  return { ok: total <= budget && doorMisses.length === 0, total, budget, files, doorMisses };
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const distDir = process.argv[2] ?? fileURLToPath(new URL("../dist", import.meta.url));
  const result = checkBudget(distDir);
  for (const entry of result.files) process.stdout.write(`  ${kib(entry.brotli).padStart(11)} br  ${kib(entry.raw).padStart(11)} raw  ${entry.file}\n`);
  process.stdout.write(`First paint: ${kib(result.total)} brotli, budget ${kib(result.budget)}.\n`);
  if (result.total > result.budget) {
    process.stderr.write(`Over the first-paint budget by ${kib(result.total - result.budget)}. Something reached from src/main.tsx statically that should load on first use (see src/first-paint.test.ts).\n`);
  }
  if (result.doorMisses.length) {
    process.stderr.write(`The browser door would refuse these chunks (companion/src/routes.ts BROWSER_STATIC):\n${result.doorMisses.map((file) => `  ${file}`).join("\n")}\n`);
  }
  if (!result.ok) process.exitCode = 1;
}
