#!/usr/bin/env node
// Reads the minimum macOS version out of every Mach-O in a packaged Murage.app, from the bytes only.
// Nothing is launched. Usage: mac-minos-report.mjs <Murage.app> [--limit <x.y>] [--allow <regex>]
// Exit 1 when a binary asks for a newer macOS than the limit (default: the app's LSMinimumSystemVersion).
// --allow names paths that are known to sit above the limit, so a new one still fails.
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LC_VERSION_MIN_MACOSX = 0x24, LC_BUILD_VERSION = 0x32, PLATFORM_MACOS = 1;
const FAT_MAGICS = new Set([0xcafebabe, 0xcafebabf]);
const version = (v) => `${v >>> 16}.${(v >>> 8) & 0xff}.${v & 0xff}`;
const rank = (text) => text.split(".").map(Number).reduce((sum, part, index) => sum + (part || 0) * 1000 ** (2 - index), 0);

function sliceMinos(fd, offset) {
  const head = Buffer.alloc(32);
  if (readSync(fd, head, 0, 32, offset) < 32 || head.readUInt32LE(0) !== 0xfeedfacf) return null;
  const count = head.readUInt32LE(16), size = head.readUInt32LE(20);
  const commands = Buffer.alloc(size);
  readSync(fd, commands, 0, size, offset + 32);
  for (let at = 0, i = 0; i < count && at + 8 <= size; i += 1) {
    const cmd = commands.readUInt32LE(at), cmdsize = commands.readUInt32LE(at + 4);
    if (cmdsize < 8) return null;
    if (cmd === LC_BUILD_VERSION && commands.readUInt32LE(at + 8) === PLATFORM_MACOS) return { minos: version(commands.readUInt32LE(at + 12)), sdk: version(commands.readUInt32LE(at + 16)) };
    if (cmd === LC_VERSION_MIN_MACOSX) return { minos: version(commands.readUInt32LE(at + 8)), sdk: version(commands.readUInt32LE(at + 12)) };
    at += cmdsize;
  }
  return { minos: null, sdk: null };
}

export function fileSlices(path) {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(8);
    if (readSync(fd, head, 0, 8, 0) < 8) return [];
    if (head.readUInt32LE(0) === 0xfeedfacf) return [sliceMinos(fd, 0)].filter(Boolean);
    const magic = head.readUInt32BE(0), count = head.readUInt32BE(4);
    // Java class files share the fat magic; a real fat header holds a handful of slices.
    if (!FAT_MAGICS.has(magic) || count === 0 || count > 8) return [];
    const wide = magic === 0xcafebabf, entry = wide ? 32 : 20, table = Buffer.alloc(entry * count);
    readSync(fd, table, 0, table.length, 8);
    const slices = [];
    for (let i = 0; i < count; i += 1) {
      const offset = wide ? Number(table.readBigUInt64BE(i * entry + 8)) : table.readUInt32BE(i * entry + 8);
      const slice = sliceMinos(fd, offset);
      if (slice) slices.push(slice);
    }
    return slices;
  } finally { closeSync(fd); }
}

function* walk(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name), stat = lstatSync(path);
    if (stat.isDirectory()) yield* walk(path);
    else if (stat.isFile() && stat.size >= 32) yield path;
  }
}

export function reportApp(app) {
  const plist = readFileSync(join(app, "Contents/Info.plist"), "utf8");
  const floor = /<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  const binaries = [];
  for (const path of walk(app)) {
    const slices = fileSlices(path);
    if (!slices.length) continue;
    const known = slices.map((s) => s.minos).filter(Boolean).sort((a, b) => rank(b) - rank(a));
    binaries.push({ path: path.slice(app.length + 1), minos: known[0] ?? null, sdk: slices[0].sdk });
  }
  const histogram = {};
  for (const { minos } of binaries) histogram[minos ?? "none"] = (histogram[minos ?? "none"] ?? 0) + 1;
  return { floor, count: binaries.length, histogram, binaries };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [app, ...rest] = process.argv.slice(2);
  if (!app) { console.error("usage: mac-minos-report.mjs <Murage.app> [--limit <x.y>] [--allow <regex>]"); process.exit(2); }
  const option = (name) => { const at = rest.indexOf(name); return at < 0 ? undefined : rest[at + 1]; };
  const report = reportApp(app);
  const limit = option("--limit") ?? report.floor;
  if (!limit) { console.error("no LSMinimumSystemVersion and no --limit"); process.exit(2); }
  const allow = option("--allow") ? new RegExp(option("--allow")) : null;
  const above = report.binaries.filter((b) => b.minos && rank(b.minos) > rank(limit));
  const failing = above.filter((b) => !allow?.test(b.path));
  console.log(JSON.stringify({ ...report, limit, above, failing: failing.map((b) => b.path) }, null, 1));
  process.exit(failing.length ? 1 : 0);
}
