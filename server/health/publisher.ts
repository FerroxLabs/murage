// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The producer root DATA_DIR/health and everything written below it (1.0.9, GAP-SENTINEL-109 sections 3.3, 6.4, 9).
//
// Root state machine (section 6.4):
//   absent -> initializing        initialize() at the data owner's boundary, BEFORE a backup capture is admitted
//   initializing -> ready         exact `health: excluded` inventory row, canonical parent, real directory (no link or
//                                 reparse point), owner-only permissions (POSIX mode, or a verified owner-only DACL on
//                                 Windows); creates only the fixed root, never a parent
//   ready -> publishing -> ready  one appended window line or one atomically replaced manifest
//   any -> publication-deferred   root missing while a capture runs, identity/permission mismatch, or a write failure;
//                                 valid prior children stay, coverage says so, the product operation is untouched
//   deferred -> ready             the same root revalidates at the next publication, or initialize() runs again;
//                                 the next window carries an explicit gap. A missing root is recreated only by
//                                 initialize(), and never while a capture is active.
//
// Files (shared/health-protocol.mjs HEALTH_FILES): `<producer>.current.ndjson`, rotated to `.previous` at 1 MiB (two
// segments per producer), complete lines only, appended asynchronously with no fsync; manifests replaced through a
// temporary child inside health/ and a rename. Cleanup removes only publisher-owned names, never recursively, and never
// the root. Nothing here throws into the caller: failures defer publication and are counted.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { HEALTH_DIR, HEALTH_FILES, HEALTH_LIMITS, encodeWindowLine, parseWindowLine, type OperationalWindow, type DetectorName, type CoverageValue } from "../../shared/health-protocol.mjs";
import { renameWithRetry } from "../atomic.ts";
import { classifyDataDirEntry, type DataDirEntry } from "../data-dir-inventory.ts";
import { windowsAclCheck, windowsAclRestrict, type AclCheck, type AclVerdict } from "../sentinel/win-acl.ts";
import { serverHealthCounters, type HealthCounters } from "./counters.ts";

export type HealthRootState = "absent" | "initializing" | "ready" | "publishing" | "publication-deferred";
export type HealthProducerName = "server" | "desktop";
export type DeferReason = "capture-active" | "classification" | "parent" | "not-directory" | "link" | "owner" | "permissions" | "identity" | "missing" | "write-failed" | "budget";

/** The installation's token key, beside health/ (never inside it, so the scanner never sees it): 64 hex characters. */
export const HEALTH_KEY_FILE = "health-key";
const KEY_TEXT = /^[0-9a-f]{64}\n?$/;

/** Temporary children: `.tmp-<16 hex>.<ext>` inside health/. The only names cleanup removes besides retired generations. */
export const HEALTH_TEMP_PATTERN = /^\.tmp-[0-9a-f]{16}\.(?:json|sqlite(?:-journal|-wal|-shm)?)$/;
/** Each producer gets half of the shared 8 KiB/min (section 4.1): at most one full record per minute each. */
export const PRODUCER_BYTES_PER_MINUTE = HEALTH_LIMITS.producerBytesPerMinute / 2;
const DAY_MS = 24 * 60 * 60_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SEGMENTS: Record<HealthProducerName, { current: string; previous: string }> = {
  server: { current: HEALTH_FILES.serverCurrent, previous: HEALTH_FILES.serverPrevious },
  desktop: { current: HEALTH_FILES.desktopCurrent, previous: HEALTH_FILES.desktopPrevious },
};

export interface HealthPublisherOptions {
  dataDir: string;
  /** True while a backup capture is in progress: the root is never created then (its membership must stay as it began). */
  deferWhileCaptureActive?: () => boolean;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** The inventory classification (injectable for tests); the real one is data-dir-inventory.ts. */
  classify?: (name: string) => DataDirEntry | undefined;
  /** Windows owner-only DACL verdict for the root (default: icacls by SID, server/sentinel/win-acl.ts). */
  aclCheck?: AclCheck;
  /** Windows DACL restriction to owner-only (default: icacls). */
  aclRestrict?: (path: string) => boolean;
}

interface ProducerSegment { size: number; needsNewline: boolean; tokens: number; refilledAt: number; pendingOmitted: number; chain: Promise<boolean> }

export class HealthPublisher {
  private readonly options: HealthPublisherOptions;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private rootPath: string | null = null;
  private identity: { dev: number; ino: number } | null = null;
  private stateValue: HealthRootState = "absent";
  private reason: DeferReason | null = null;
  private gapPending = false;
  /** Windows: the root's DACL was verified owner-only for this identity (checked again after any deferral). */
  private aclVerified = false;
  private readonly segments = new Map<HealthProducerName, ProducerSegment>();
  private dayStart = 0;
  private dayBytes = 0;
  /** Publications refused or lost since start (diagnostics and tests). */
  deferredCount = 0;

  constructor(options: HealthPublisherOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
  }

  get state(): HealthRootState { return this.stateValue; }
  get deferReason(): DeferReason | null { return this.reason; }
  /** The canonical root once initialized; null before. */
  get root(): string | null { return this.rootPath; }
  private captureActive(): boolean { try { return this.options.deferWhileCaptureActive?.() === true; } catch { return true; } }

  /** The owned initialization boundary (section 6.4). Call before capture admission; it may be called again after a restore,
   *  a rebind or a deferral. Answers the resulting state. Never throws. */
  initialize(): HealthRootState {
    this.stateValue = "initializing";
    try {
      const entry = (this.options.classify ?? classifyDataDirEntry)(HEALTH_DIR);
      if (!entry || entry.backup !== "excluded" || entry.skip !== undefined) return this.defer("classification");
      let parent: string;
      try { parent = realpathSync(this.options.dataDir); } catch { return this.defer("parent"); }
      const parentStat = lstatSync(parent);
      if (!parentStat.isDirectory()) return this.defer("parent");
      const root = join(parent, HEALTH_DIR);
      let stat = lstatOrNull(root);
      if (!stat) {
        if (this.captureActive()) return this.defer("capture-active");
        try { mkdirSync(root, { mode: 0o700 }); } catch { return this.defer("write-failed"); }
        stat = lstatOrNull(root);
        if (!stat) return this.defer("missing");
      }
      this.aclVerified = false;
      const checked = this.checkRoot(root, stat, true);
      if (checked) return this.defer(checked);
      this.rootPath = root;
      this.identity = { dev: stat.dev, ino: stat.ino };
      if (!this.captureActive()) this.removeInterruptedTemps();
      this.segments.clear();
      this.gapPending = false;
      this.reason = null;
      this.stateValue = "ready";
      return this.stateValue;
    } catch { return this.defer("write-failed"); }
  }

  /** The installation's persisted token key (DATA_DIR/health-key), made once when absent: 32 random bytes as hex, owner-only,
   *  written exclusively and never overwritten. Tokens a fingerprint is keyed on (extractor sources, scopes) are derived
   *  under it, so they stay the same across restarts. Null when it cannot be read or made, or when it is absent while a
   *  backup capture runs (then the caller keeps its per-process key). Never throws. */
  loadTokenKey(): Buffer | null {
    try {
      const path = join(realpathSync(this.options.dataDir), HEALTH_KEY_FILE);
      const read = (): Buffer | null => {
        let fd: number | undefined;
        try {
          fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65) return null;
          if (this.platform !== "win32") {
            const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
            if ((uid !== undefined && Number(stat.uid) !== uid) || (Number(stat.mode) & 0o077) !== 0) return null;
          }
          const buffer = Buffer.alloc(Number(stat.size));
          const n = readSync(fd, buffer, 0, buffer.length, 0);
          const text = buffer.subarray(0, n).toString("utf8");
          return KEY_TEXT.test(text) ? Buffer.from(text.slice(0, 64), "hex") : null;
        } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
      };
      // Windows: the mode sets no DACL, so the key gets the root's owner-only restriction and check, before it is read
      // (a key an earlier restriction left unreadable is repaired, never overwritten); anything else is refused.
      const ownerOnly = () => this.platform !== "win32" || this.ownerOnlyAcl(path);
      if (lstatOrNull(path)) return ownerOnly() ? read() : null; // a present but unusable key is never overwritten
      if (this.captureActive()) return null;
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      try { writeSync(fd, `${randomBytes(32).toString("hex")}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      return ownerOnly() ? read() : null;
    } catch { return null; }
  }

  /** Windows: true when `path` has the owner-only DACL, restricting it once first when it does not. */
  private ownerOnlyAcl(path: string): boolean {
    const check = this.options.aclCheck ?? ((target: string) => windowsAclCheck(target));
    if (safeVerdict(check, path) === "owner-only") return true;
    const restrict = this.options.aclRestrict ?? ((target: string) => windowsAclRestrict(target));
    let restricted = false;
    try { restricted = restrict(path); } catch { restricted = false; }
    return restricted && safeVerdict(check, path) === "owner-only";
  }

  /** The last epoch this producer published, read from the tail of its current segment (0 when none). */
  lastEpoch(producer: HealthProducerName): number {
    if (!this.rootPath) return 0;
    const tail = readTail(join(this.rootPath, SEGMENTS[producer].current), HEALTH_LIMITS.recordBytes * 2);
    if (!tail) return 0;
    const lines = tail.split("\n");
    lines.pop(); // the part after the last newline is not a complete record
    for (let index = lines.length - 1; index >= 0; index--) {
      const parsed = parseWindowLine(lines[index]!);
      if (parsed.ok) return parsed.value.epoch;
    }
    return 0;
  }

  /** Appends one window to the producer's current segment. Asynchronous, no fsync; resolves false when the window was
   *  not written (deferred root, budget, write failure). The next written window then says what was lost. */
  appendWindow(producer: HealthProducerName, window: OperationalWindow): Promise<boolean> {
    const segment = this.segment(producer);
    const run = segment.chain.then(() => this.append(producer, segment, window), () => this.append(producer, segment, window));
    segment.chain = run.catch(() => false);
    return segment.chain;
  }

  /** Atomically replaces a fixed manifest (backup-status.json, db-stats-current.json) with `text`. Synchronous and small;
   *  never on a turn path. */
  replaceManifest(name: string, text: string): boolean {
    if (name !== HEALTH_FILES.backupStatus && name !== HEALTH_FILES.dbStatsManifest) return false;
    if (!this.ensureReady()) return false;
    const bytes = Buffer.from(text, "utf8");
    if (!this.chargeDay(bytes.length)) { this.deferredCount++; return false; }
    this.stateValue = "publishing";
    const temp = this.tempPath("json");
    try {
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameWithRetry(temp, join(this.rootPath!, name));
      this.stateValue = "ready";
      return true;
    } catch {
      try { unlinkSync(temp); } catch { /* an interrupted temp is removed at the next initialization */ }
      this.defer("write-failed");
      return false;
    }
  }

  /** Reads a fixed manifest back (the publisher's own previous projection); null when absent or unreadable. */
  readManifest(name: string): unknown {
    if (!this.rootPath) return null;
    if (name !== HEALTH_FILES.backupStatus && name !== HEALTH_FILES.dbStatsManifest) return null;
    const text = readTail(join(this.rootPath, name), HEALTH_LIMITS.statsSnapshotBytes, true);
    if (text === null) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  /** A fresh temporary child path inside the root (for the stats generation builder). */
  tempPath(extension: "json" | "sqlite"): string {
    return join(this.rootPath ?? "", `.tmp-${randomBytes(8).toString("hex")}.${extension}`);
  }

  /** Charges bytes written outside appendWindow/replaceManifest (a sealed stats generation) to the daily budget. */
  chargeDay(bytes: number): boolean {
    const now = this.now();
    if (now - this.dayStart >= DAY_MS || now < this.dayStart) { this.dayStart = now; this.dayBytes = 0; }
    if (this.dayBytes + bytes > HEALTH_LIMITS.producerBytesPerDay) return false;
    this.dayBytes += bytes;
    return true;
  }

  /** Revalidates the root for a publication: the same directory identity, still a real owner-only folder. From
   *  publication-deferred it resumes (with a gap) only when the very same root is back in order. */
  ensureReady(): boolean {
    if (this.stateValue === "absent" || this.stateValue === "initializing" || !this.rootPath || !this.identity) return false;
    const stat = lstatOrNull(this.rootPath);
    if (!stat) { this.defer(this.captureActive() ? "capture-active" : "missing"); return false; }
    if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) { this.defer("identity"); return false; }
    const checked = this.checkRoot(this.rootPath, stat, false);
    if (checked) { this.defer(checked); return false; }
    if (this.stateValue === "publication-deferred") { this.stateValue = "ready"; this.reason = null; this.gapPending = true; }
    return true;
  }

  /** Removes a publisher-owned child by exact name (never a directory, never recursive). */
  removeOwned(name: string): boolean {
    if (!this.rootPath || name.includes("/") || name.includes("\\")) return false;
    const path = join(this.rootPath, name);
    const stat = lstatOrNull(path);
    if (!stat || stat.isDirectory()) return false;
    try { unlinkSync(path); return true; } catch { return false; } // a Windows sharing refusal is retried next time
  }

  /** Bounded listing of the root's children (publisher-owned name filtering is the caller's). */
  listChildren(): string[] {
    if (!this.rootPath) return [];
    try { return readdirSync(this.rootPath).slice(0, 256); } catch { return []; }
  }

  // -------------------------------------------------------------------------

  private defer(reason: DeferReason): HealthRootState {
    this.aclVerified = false;
    this.reason = reason;
    this.stateValue = "publication-deferred";
    return this.stateValue;
  }

  /** Null when the root is acceptable, else why not. `repair` tightens permissions on a root this user owns. */
  private checkRoot(root: string, stat: Stats, repair: boolean): DeferReason | null {
    if (stat.isSymbolicLink()) return "link";
    if (!stat.isDirectory()) return "not-directory";
    try { if (realpathSync(root) !== root) return "link"; } catch { return "missing"; }
    if (this.platform === "win32") {
      // Owner-only DACL (protected, not inherited, only this user, SYSTEM and Administrators). mkdir's mode sets no
      // DACL on Windows: a root this user may repair is restricted, then checked again. Anything but owner-only defers.
      if (this.aclVerified) return null;
      const check = this.options.aclCheck ?? ((path: string) => windowsAclCheck(path));
      let verdict = safeVerdict(check, root);
      if (verdict !== "owner-only" && repair) {
        const restrict = this.options.aclRestrict ?? ((path: string) => windowsAclRestrict(path));
        let restricted = false;
        try { restricted = restrict(root); } catch { restricted = false; }
        if (restricted) verdict = safeVerdict(check, root);
      }
      if (verdict !== "owner-only") return "permissions";
      this.aclVerified = true;
      return null;
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && Number(stat.uid) !== uid) return "owner";
    if ((Number(stat.mode) & 0o077) !== 0) {
      if (!repair) return "permissions";
      try { chmodSync(root, 0o700); } catch { return "permissions"; }
      const again = lstatOrNull(root);
      if (!again || (Number(again.mode) & 0o077) !== 0) return "permissions";
    }
    return null;
  }

  private removeInterruptedTemps(): void {
    for (const name of this.listChildren()) if (HEALTH_TEMP_PATTERN.test(name)) this.removeOwned(name);
  }

  private segment(producer: HealthProducerName): ProducerSegment {
    let segment = this.segments.get(producer);
    if (!segment) {
      segment = { size: 0, needsNewline: false, tokens: PRODUCER_BYTES_PER_MINUTE, refilledAt: this.now(), pendingOmitted: 0, chain: Promise.resolve(true) };
      if (this.rootPath) {
        const path = join(this.rootPath, SEGMENTS[producer].current);
        const stat = lstatOrNull(path);
        if (stat?.isFile()) {
          segment.size = Number(stat.size);
          const last = readTail(path, 1);
          segment.needsNewline = last !== null && last.length > 0 && last !== "\n";
        }
      }
      this.segments.set(producer, segment);
    }
    return segment;
  }

  private refill(segment: ProducerSegment): void {
    const now = this.now();
    const elapsed = Math.max(0, now - segment.refilledAt);
    segment.tokens = Math.min(PRODUCER_BYTES_PER_MINUTE, segment.tokens + (elapsed * PRODUCER_BYTES_PER_MINUTE) / HEALTH_LIMITS.windowMs);
    segment.refilledAt = now;
  }

  private async append(producer: HealthProducerName, segment: ProducerSegment, window: OperationalWindow): Promise<boolean> {
    const lose = () => { segment.pendingOmitted++; this.deferredCount++; return false; };
    if (!this.ensureReady()) return lose();
    let value = window;
    if (segment.pendingOmitted > 0 || this.gapPending) value = markLoss(value, segment.pendingOmitted, this.gapPending);
    const encoded = encodeWindowLine(value);
    if (!encoded.ok) return lose();
    const line = (segment.needsNewline ? "\n" : "") + encoded.value;
    const bytes = Buffer.byteLength(line);
    this.refill(segment);
    if (bytes > segment.tokens) { this.reason = "budget"; return lose(); }
    if (!this.chargeDay(bytes)) { this.reason = "budget"; return lose(); }
    segment.tokens -= bytes;
    const names = SEGMENTS[producer];
    const current = join(this.rootPath!, names.current);
    this.stateValue = "publishing";
    try {
      if (segment.size > 0 && segment.size + bytes > HEALTH_LIMITS.producerSegmentBytes) {
        renameWithRetry(current, join(this.rootPath!, names.previous));
        segment.size = 0;
      }
      const handle = await open(current, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW, 0o600);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("HEALTH_SEGMENT_REPLACED");
        await handle.write(line);
      } finally { await handle.close(); }
      segment.size += bytes;
      segment.needsNewline = false;
      segment.pendingOmitted = 0;
      this.gapPending = false;
      if (this.stateValue === "publishing") this.stateValue = "ready";
      return true;
    } catch {
      segment.needsNewline = true; // a partial write must not glue onto the next record
      this.defer("write-failed");
      return lose();
    }
  }
}

/** The window that follows lost ones: never complete, every detector it names partial, the loss counted. */
function markLoss(window: OperationalWindow, lostWindows: number, gap: boolean): OperationalWindow {
  const coverage: Partial<Record<DetectorName, CoverageValue>> = {};
  for (const [detector, value] of Object.entries(window.coverageByDetector) as [DetectorName, CoverageValue][]) coverage[detector] = value === "unavailable" ? value : "partial";
  const counters = gap || lostWindows > 0 ? [{ detector: "coverage" as const, engineKind: "none" as const, code: "gap", value: Math.max(1, lostWindows) }, ...window.counters] : window.counters;
  return { ...window, complete: false, omitted: window.omitted + lostWindows, coverageByDetector: coverage, counters };
}

function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); } catch { return null; }
}

function safeVerdict(check: AclCheck, path: string): AclVerdict {
  try { return check(path); } catch { return "unknown"; }
}

/** Up to `limit` bytes from the end (or the start, when `whole`) of a regular, unlinked-elsewhere file; null when absent. */
function readTail(path: string, limit: number, whole = false): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const size = Number(stat.size);
    if (whole && size > limit) return null;
    const length = Math.min(limit, size);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, read).toString("utf8");
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

// ---------------------------------------------------------------------------
// Server producer wiring (lane C calls these from the data owner's startup and shutdown).
// ---------------------------------------------------------------------------
export interface ProducerRuntime { publisher: HealthPublisher; counters: HealthCounters; producer: HealthProducerName; timer: ReturnType<typeof setInterval> | null }

/** Initializes the root and starts the minute roll-up for one producer. Call after initialize() at the owner's boundary;
 *  answers null (and publishes nothing) when the root is not ready. The timer is unref'd and never throws. */
export function startHealthProducer(options: { publisher: HealthPublisher; installationId: string; producer?: HealthProducerName; counters?: HealthCounters; intervalMs?: number }): ProducerRuntime | null {
  const producer = options.producer ?? "server";
  const counters = options.counters ?? serverHealthCounters;
  if (options.publisher.state !== "ready" && options.publisher.initialize() !== "ready") return null;
  const key = options.publisher.loadTokenKey();
  if (key) counters.setInstallationKey(key);
  counters.startEpoch(options.installationId, options.publisher.lastEpoch(producer));
  const runtime: ProducerRuntime = { publisher: options.publisher, counters, producer, timer: null };
  runtime.timer = setInterval(() => { void publishWindows(runtime); }, options.intervalMs ?? HEALTH_LIMITS.windowMs);
  runtime.timer.unref?.();
  return runtime;
}

/** One roll-up and its appends (the timer's body; tests call it directly). */
export async function publishWindows(runtime: ProducerRuntime, now?: number): Promise<number> {
  let written = 0;
  try {
    for (const window of runtime.counters.rollUp(now)) if (await runtime.publisher.appendWindow(runtime.producer, window)) written++;
  } catch { /* a health publication never throws into the app */ }
  return written;
}

/** Orderly stop: flush the open and held windows with a `stopping` lifecycle, then stop the timer. */
export async function stopHealthProducer(runtime: ProducerRuntime): Promise<void> {
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  try {
    runtime.counters.setLifecycle("stopping");
    for (const window of runtime.counters.flush()) await runtime.publisher.appendWindow(runtime.producer, window);
  } catch { /* best effort at shutdown */ }
}
