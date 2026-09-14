import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { browserBundlePaths, browserBundleSpec } from "./browser-bundle-release.ts";

// Derived from the exact pinned arm64 upstream assets and compared byte-for-byte
// with the signed 0.1.53 bundle. No x64 or general Mach-O normalization is implied.
export const MAC_BROWSER_PAYLOADS = {
  engine: { signatureCommand: 2200, signatureOffset: 12267216, linkeditCommand: 1600, payloadSha256: "361320726d8e5ab0a8703449225943b5c350c6aec20db0c86a1415ae6393cb44" },
  chrome: { signatureCommand: 9176, signatureOffset: 165593360, linkeditCommand: 3352, payloadSha256: "103235dc0c917ffbaa9a45cc261e4e6ad20466751c5752debed96d7fa70a22b0" },
} as const;
type Image = keyof typeof MAC_BROWSER_PAYLOADS;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function verifyMacBrowserImage(bytes: Buffer, image: Image): boolean {
  try {
    const pin = MAC_BROWSER_PAYLOADS[image];
    const { signatureCommand: s, signatureOffset: end, linkeditCommand: l } = pin;
    if (bytes.length < end + 12 || bytes.length > end + 2 * 1024 ** 2
      || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c || bytes.readUInt32LE(12) !== 2
      || bytes.readUInt32LE(s) !== 0x1d || bytes.readUInt32LE(s + 4) !== 16 || bytes.readUInt32LE(s + 8) !== end
      || bytes.readUInt32LE(s + 12) !== bytes.length - end
      || bytes.readUInt32LE(l) !== 0x19 || bytes.readUInt32LE(l + 4) !== 72
      || bytes.toString("ascii", l + 8, l + 24) !== "__LINKEDIT\0\0\0\0\0\0"
      || bytes.readUInt32LE(l + 56) !== 1 || bytes.readUInt32LE(l + 60) !== 1 || bytes.readUInt32LE(l + 64) !== 0) return false;
    const offset = bytes.readBigUInt64LE(l + 40), size = bytes.readBigUInt64LE(l + 48), virtual = bytes.readBigUInt64LE(l + 32);
    if (offset > BigInt(end) || offset + size !== BigInt(bytes.length) || virtual < size || virtual > size + 16384n) return false;
    const tail = bytes.subarray(end), length = tail.readUInt32BE(4), count = tail.readUInt32BE(8);
    if (tail.readUInt32BE(0) !== 0xfade0cc0 || !count || count > 64 || length > tail.length || length < 12 + count * 8 || tail.length - length > 65536) return false;
    const ranges = [{ start: 0, end: 12 + count * 8 }], slots = new Set<number>();
    for (let i = 0; i < count; i++) {
      const slot = tail.readUInt32BE(12 + i * 8), start = tail.readUInt32BE(16 + i * 8);
      if (slots.has(slot) || start < 12 + count * 8 || start + 8 > length) return false;
      slots.add(slot);
      const size = tail.readUInt32BE(start + 4);
      if (size < 8 || start + size > length) return false;
      ranges.push({ start, end: start + size });
    }
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) if (ranges[i].start < ranges[i - 1].end) return false;
    const payload = Buffer.from(bytes.subarray(0, end));
    // Only these three fields changed in both observed raw/signed pairs.
    payload.writeUInt32LE(0, s + 12);
    payload.writeBigUInt64LE(BigInt(end) - offset, l + 32);
    payload.writeBigUInt64LE(BigInt(end) - offset, l + 48);
    return sha(payload) === pin.payloadSha256;
  } catch { return false; }
}

const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const requirement = '=anchor apple generic and certificate leaf[subject.OU] = "PX6SP9GPWJ"';

/** Fixed packaged-host admission, not a renderer-configurable trust callback.
 * Open observations detect replacement; these are not deny-write handles. */
export function verifyPackagedMacBrowser(resources: string, currentExecutable = process.execPath): boolean {
  const held: { file: string; fd: number; stat: Stats }[] = [];
  let accepted = false;
  try {
    const root = resolve(resources), contents = dirname(root), app = dirname(contents);
    if (basename(root) !== "Resources" || basename(contents) !== "Contents" || basename(app) !== "Murage.app" || realpathSync(root) !== root) return false;
    const executable = realpathSync(currentExecutable);
    if (!executable.startsWith(join(contents, "MacOS") + sep) && !executable.startsWith(join(contents, "Frameworks") + sep)) return false;
    const paths = browserBundlePaths(join(root, "browser-engine"), "darwin-arm64"), spec = browserBundleSpec("darwin-arm64");
    for (const directory of [paths.directory, paths.licenses]) if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) return false;
    const read = (file: string, limit: number) => {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > limit || realpathSync(file) !== file) throw new Error("Invalid packaged browser file");
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      held.push({ file, fd, stat });
      if (!same(stat, fstatSync(fd))) throw new Error("Packaged browser changed while opening");
      return readFileSync(fd);
    };
    const { files, ...recorded } = JSON.parse(read(paths.manifest, 2 * 1024 ** 2).toString("utf8"));
    if (JSON.stringify(recorded) !== JSON.stringify(spec) || !Array.isArray(files)) return false;
    for (const [image, file, relative, rawHash, rawSize] of [
      ["engine", paths.engine, spec.engine.executable, spec.engine.sha256, spec.engine.bytes],
      ["chrome", paths.chrome, spec.chrome.executable, spec.chrome.executableSha256, 166887216],
    ] as const) {
      const records = files.filter((entry: { path?: unknown }) => entry?.path === relative);
      if (records.length !== 1 || records[0].kind !== "file" || records[0].sha256 !== rawHash || records[0].bytes !== rawSize
        || !verifyMacBrowserImage(read(file, MAC_BROWSER_PAYLOADS[image].signatureOffset + 2 * 1024 ** 2), image)) return false;
    }
    for (const file of [app, paths.engine, paths.chrome]) {
      const result = spawnSync("/usr/bin/codesign", ["--verify", "--strict", "-R", requirement, file], { encoding: "utf8", timeout: 10000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] });
      if (result.status !== 0 || result.error) return false;
    }
    accepted = held.every(({ file, fd, stat }) => same(stat, fstatSync(fd)) && same(stat, lstatSync(file)) && realpathSync(file) === file);
  } catch { accepted = false; }
  finally {
    for (const { fd } of held) { try { closeSync(fd); } catch { accepted = false; } }
  }
  return accepted;
}
