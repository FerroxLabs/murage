import { execFile } from "node:child_process";
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

const identityOf = (file: string, s: Stats) => `${file}|${s.dev}|${s.ino}|${s.size}|${s.mtimeMs}|${s.ctimeMs}`;
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const requirement = '=anchor apple generic and certificate leaf[subject.OU] = "PX6SP9GPWJ"';


type Verdict = { key: string; ok: boolean } | { key: string; promise: Promise<void> };
const verdicts = new Map<string, Verdict>();
const inflight = new Set<Promise<void>>();
/** Codesign runs that ended without an answer (timeout, could not start): how many in a row, and not before when to try again. Per tool, reset by any answer or any change to the file. */
const retries = new Map<string, { key: string; failures: number; notBefore: number }>();
const RETRY_DELAYS_MS = [30_000, 120_000, 300_000];
/** For tests: forget every remembered verdict. */
export function clearMacBrowserCodesignCache() { verdicts.clear(); inflight.clear(); retries.clear(); }
const CODESIGN_TIMEOUT_MS = 120_000;
/** How long one caller waits on the shared check: a little over the longest codesign run. */
const CHECK_WAIT_MS = CODESIGN_TIMEOUT_MS + 15_000;
/** The remembered answer for one tool, keyed on its path, device, inode, size, mtime and ctime so any change asks again. Starts the check when there is none. */
function toolSignature(file: string, stat: Stats, start: boolean): "ok" | "bad" | "pending" | "unfinished" {
  const key = identityOf(file, stat);
  const known = verdicts.get(file);
  if (known && known.key === key) return "ok" in known ? (known.ok ? "ok" : "bad") : "pending";
  // A look that only reads the outcome of the run it waited on never starts another one: a run that ended without an answer is "unfinished".
  if (!start) return "unfinished";
  // A run that ended without an answer is not tried again at once: every turn would otherwise restart a minutes-long codesign.
  const wait = retries.get(file);
  if (wait && wait.key === key && Date.now() < wait.notBefore) return "unfinished";
  const entry: { key: string; promise: Promise<void> } = { key, promise: undefined as unknown as Promise<void> };
  // Registered before the run starts, so a codesign that cannot even start clears its own entry instead of leaving it "pending" for good.
  verdicts.set(file, entry);
  entry.promise = new Promise<void>(resolve => {
    try {
      execFile("/usr/bin/codesign", ["--verify", "--strict", "-R", requirement, file], { encoding: "utf8", timeout: CODESIGN_TIMEOUT_MS, maxBuffer: 65536 }, error => {
        // A refusal by codesign is remembered; a timeout or a failure to start is not, so the next look tries again.
        const refused = !!error && typeof (error as { code?: unknown }).code === "number";
        if (verdicts.get(file) === entry) { if (!error) verdicts.set(file, { key, ok: true }); else if (refused) verdicts.set(file, { key, ok: false }); else verdicts.delete(file); }
        if (!error || refused) retries.delete(file); else noteUnanswered(file, key);
        resolve();
      });
    } catch { if (verdicts.get(file) === entry) verdicts.delete(file); noteUnanswered(file, key); resolve(); }
  }).finally(() => inflight.delete(entry.promise));
  inflight.add(entry.promise);
  return "pending";
}
function noteUnanswered(file: string, key: string) {
  const before = retries.get(file), failures = before && before.key === key ? before.failures + 1 : 1;
  retries.set(file, { key, failures, notBefore: Date.now() + RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1] });
}
/** A hiccup of the machine (too many open files, a busy disk), not a verdict on the files. */
class CheckNotFinished extends Error {}
const TRANSIENT_FS = new Set(["EMFILE", "ENFILE", "EAGAIN", "EBUSY", "EINTR", "EIO", "ETIMEDOUT", "ENOMEM", "EDEADLK"]);
/** "ok": both tools passed. "failed": a real refusal (wrong place, manifest or bytes that do not match, codesign said no).
 * "checking": codesign is still running. "unfinished": the check could not be completed (timeout, could not start, busy disk, files moving) and says nothing about the install: ask again. */
export type PackagedMacBrowserState = "ok" | "checking" | "failed" | "unfinished";
/** Fixed packaged-host admission, not a renderer-configurable trust callback.
 * Open observations detect replacement; these are not deny-write handles.
 * `start: false` reads the outcome of a run already finished and never launches codesign. */
export function packagedMacBrowserState(resources: string, currentExecutable = process.execPath, start = true): PackagedMacBrowserState {
  const held: { file: string; fd: number; stat: Stats }[] = [];
  let accepted = false, checking = false, unfinished = false;
  try {
    const root = resolve(resources), contents = dirname(root), app = dirname(contents);
    if (basename(root) !== "Resources" || basename(contents) !== "Contents" || basename(app) !== "Murage.app" || realpathSync(root) !== root) return "failed";
    const executable = realpathSync(currentExecutable);
    if (!executable.startsWith(join(contents, "MacOS") + sep) && !executable.startsWith(join(contents, "Frameworks") + sep)) return "failed";
    const paths = browserBundlePaths(join(root, "browser-engine"), "darwin-arm64"), spec = browserBundleSpec("darwin-arm64");
    for (const directory of [paths.directory, paths.licenses]) if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) return "failed";
    const open = (file: string, limit: number) => {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > limit || realpathSync(file) !== file) throw new Error("Invalid packaged browser file");
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      held.push({ file, fd, stat });
      if (!same(stat, fstatSync(fd))) throw new CheckNotFinished("Packaged browser changed while opening");
      return fd;
    };
    const read = (file: string, limit: number) => readFileSync(open(file, limit));
    const { files, ...recorded } = JSON.parse(read(paths.manifest, 2 * 1024 ** 2).toString("utf8"));
    if (JSON.stringify(recorded) !== JSON.stringify(spec) || !Array.isArray(files)) return "failed";
    for (const [image, file, relative, rawHash, rawSize] of [
      ["engine", paths.engine, spec.engine.executable, spec.engine.sha256, spec.engine.bytes],
      ["chrome", paths.chrome, spec.chrome.executable, spec.chrome.executableSha256, 166887216],
    ] as const) {
      const records = files.filter((entry: { path?: unknown }) => entry?.path === relative);
      if (records.length !== 1 || records[0].kind !== "file" || records[0].sha256 !== rawHash || records[0].bytes !== rawSize) return "failed";
      // Every full admission reads and hashes the bytes of the descriptor it holds open; nothing earlier vouches for them.
      if (!verifyMacBrowserImage(read(file, MAC_BROWSER_PAYLOADS[image].signatureOffset + 2 * 1024 ** 2), image)) return "failed";
    }
    // Only the two tools are codesigned, never the whole app: that takes 17 s warm and 37 s cold on a real Mac, always past the old bound,
    // so it refused every install. The app itself is bound by name and location above (Murage.app, running from its own Contents/MacOS).
    // The codesign runs once, off the event loop, and is remembered per binary (path, size, mtime, inode).
    const states = [paths.engine, paths.chrome].map(file => toolSignature(file, held.find(entry => entry.file === file)!.stat, start));
    if (states.includes("bad")) return "failed";
    if (states.includes("pending")) { checking = true; return "checking"; }
    if (states.includes("unfinished")) { unfinished = true; return "unfinished"; }
    accepted = held.every(({ file, fd, stat }) => same(stat, fstatSync(fd)) && same(stat, lstatSync(file)) && realpathSync(file) === file);
    // The tools passed but a file moved while they were looked at: nothing was refused, so look again next time.
    if (!accepted) unfinished = true;
  } catch (error) {
    accepted = false;
    if (error instanceof CheckNotFinished || TRANSIENT_FS.has((error as NodeJS.ErrnoException)?.code ?? "")) unfinished = true;
  }
  finally {
    for (const { fd } of held) { try { closeSync(fd); } catch { accepted = false; unfinished = true; } }
  }
  return accepted ? "ok" : checking ? "checking" : unfinished ? "unfinished" : "failed";
}
/** True only once both tools have passed. Never blocks: a first call starts the check and answers false. */
export function verifyPackagedMacBrowser(resources: string, currentExecutable = process.execPath): boolean { return packagedMacBrowserState(resources, currentExecutable) === "ok"; }
/** Waits (bounded) on the one shared check, never starting a second codesign for the same file, and says how it ended:
 * "ok", "failed" (a real refusal) or "unfinished" (it could not finish in the time, or a run timed out or could not start). */
export async function checkPackagedMacBrowserAsync(resources: string, currentExecutable = process.execPath, waitMs = CHECK_WAIT_MS, cancelled?: () => boolean): Promise<"ok" | "failed" | "unfinished"> {
  const deadline = Date.now() + waitMs;
  let start = true;
  for (let round = 0; round < 4; round++) {
    const state = packagedMacBrowserState(resources, currentExecutable, start);
    if (state !== "checking") return state;
    if (cancelled?.()) return "unfinished";
    const left = deadline - Date.now();
    if (left <= 0) return "unfinished";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watch: ReturnType<typeof setInterval> | undefined;
    const ran = await Promise.race([Promise.all([...inflight]).then(() => true), new Promise<boolean>(done => {
      timer = setTimeout(() => done(false), left);
      // A caller that has been cancelled (its turn was stopped) stops waiting; the shared run carries on for everyone else.
      if (cancelled) watch = setInterval(() => { if (cancelled()) done(false); }, 250);
    })]);
    if (timer) clearTimeout(timer);
    if (watch) clearInterval(watch);
    if (!ran) return "unfinished";
    start = false;
  }
  return "unfinished";
}
/** Waits on the one shared check (no second codesign is started) and answers whether the browser passed. */
export async function verifyPackagedMacBrowserAsync(resources: string, currentExecutable = process.execPath): Promise<boolean> {
  return (await checkPackagedMacBrowserAsync(resources, currentExecutable)) === "ok";
}
