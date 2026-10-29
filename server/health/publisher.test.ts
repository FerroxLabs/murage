// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HEALTH_FILES, HEALTH_LIMITS, encodeWindowLine, parseWindowLine, type OperationalWindow } from "../../shared/health-protocol.mjs";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { HealthCounters } from "./counters.ts";
import { HEALTH_KEY_FILE, HEALTH_TEMP_PATTERN, HealthPublisher, PRODUCER_BYTES_PER_MINUTE, publishWindows, startHealthProducer, stopHealthProducer } from "./publisher.ts";

const INSTALL = "b".repeat(32);
const T0 = Date.parse("2026-10-27T10:00:00Z");
const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
function dataDir() { const dir = mkdtempSync(join(tmpdir(), "murage-health-publisher-")); dirs.push(dir); return dir; }
function window(seq: number, extra: Partial<OperationalWindow> = {}): OperationalWindow {
  return { schemaVersion: 1, installationId: INSTALL, producer: "server", epoch: 100, seq, startAt: T0 + seq * 60_000, endAt: T0 + (seq + 1) * 60_000, activeMs: 60_000, complete: true, omitted: 0, coverageByDetector: { backup: "complete" }, counters: [], facts: [], lifecycle: "running", ...extra };
}
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);

describe("producer root state machine", () => {
  it("absent -> ready: creates only the fixed root, owner-only, inside the canonical data folder", () => {
    const data = dataDir();
    const publisher = new HealthPublisher({ dataDir: data });
    expect(publisher.state).toBe("absent");
    expect(publisher.initialize()).toBe("ready");
    expect(readdirSync(data)).toEqual(["health"]);
    expect(lstatSync(join(data, "health")).isDirectory()).toBe(true);
    if (posix) expect(statSync(join(data, "health")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(data, "health"))).toEqual([]);
  });

  it("Windows: the root's DACL is restricted to owner-only and checked; not owner-only defers publication", () => {
    // Restriction works: one restrict, a passing recheck, then ready; later writes reuse the verdict (no spawn per append).
    let verdict: "owner-only" | "broad" | "unknown" = "broad";
    let checks = 0, restricts = 0;
    const repaired = new HealthPublisher({
      dataDir: dataDir(), platform: "win32",
      aclCheck: () => { checks++; return verdict; },
      aclRestrict: () => { restricts++; verdict = "owner-only"; return true; },
    });
    expect(repaired.initialize()).toBe("ready");
    expect([checks, restricts]).toEqual([2, 1]);
    expect(repaired.replaceManifest(HEALTH_FILES.backupStatus, "{}")).toBe(true);
    expect(repaired.replaceManifest(HEALTH_FILES.backupStatus, "{}")).toBe(true);
    expect(checks).toBe(2);

    // Restriction refused, or the recheck still broad, or the check itself unknown or throwing: deferred, nothing written.
    const cases: Array<{ check: () => "owner-only" | "broad" | "unknown"; restrict: () => boolean }> = [
      { check: () => "broad", restrict: () => false },
      { check: () => "broad", restrict: () => true },
      { check: () => "unknown", restrict: () => true },
      { check: () => { throw new Error("icacls missing"); }, restrict: () => { throw new Error("icacls missing"); } },
    ];
    for (const c of cases) {
      const data = dataDir();
      const publisher = new HealthPublisher({ dataDir: data, platform: "win32", aclCheck: c.check, aclRestrict: c.restrict });
      expect(publisher.initialize()).toBe("publication-deferred");
      expect(publisher.deferReason).toBe("permissions");
      expect(publisher.replaceManifest(HEALTH_FILES.backupStatus, "{}")).toBe(false);
      expect(existsSync(join(data, "health", HEALTH_FILES.backupStatus))).toBe(false);
    }
  });

  it("never creates the root while a capture is active; the capture's membership stays as it began", () => {
    const data = dataDir();
    let capturing = true;
    const publisher = new HealthPublisher({ dataDir: data, deferWhileCaptureActive: () => capturing });
    expect(publisher.initialize()).toBe("publication-deferred");
    expect(publisher.deferReason).toBe("capture-active");
    expect(existsSync(join(data, "health"))).toBe(false);
    expect(publisher.replaceManifest(HEALTH_FILES.backupStatus, "{}")).toBe(false);
    expect(existsSync(join(data, "health"))).toBe(false);
    capturing = false;
    expect(publisher.initialize()).toBe("ready");
    expect(existsSync(join(data, "health"))).toBe(true);
  });

  it("a capture-active owner that throws is treated as capturing (never creates)", () => {
    const data = dataDir();
    const publisher = new HealthPublisher({ dataDir: data, deferWhileCaptureActive: () => { throw new Error("unknown"); } });
    expect(publisher.initialize()).toBe("publication-deferred");
    expect(existsSync(join(data, "health"))).toBe(false);
  });

  it("refuses without the exact excluded inventory row", () => {
    for (const entry of [undefined, { backup: "record" as const, why: "x" }, { backup: "excluded" as const, why: "x", skip: "unrecognised" as const }]) {
      const data = dataDir();
      const publisher = new HealthPublisher({ dataDir: data, classify: () => entry });
      expect(publisher.initialize()).toBe("publication-deferred");
      expect(publisher.deferReason).toBe("classification");
      expect(existsSync(join(data, "health"))).toBe(false);
    }
  });

  it.skipIf(!posix)("refuses a redirected root (a link to another folder) and a root that is a file", () => {
    const data = dataDir(), outside = dataDir();
    symlinkSync(outside, join(data, "health"));
    const linked = new HealthPublisher({ dataDir: data });
    expect(linked.initialize()).toBe("publication-deferred");
    expect(linked.deferReason).toBe("link");
    expect(readdirSync(outside)).toEqual([]);
    const fileData = dataDir();
    writeFileSync(join(fileData, "health"), "not a folder");
    const file = new HealthPublisher({ dataDir: fileData });
    expect(file.initialize()).toBe("publication-deferred");
    expect(file.deferReason).toBe("not-directory");
  });

  it.skipIf(!posix)("tightens a broadly readable root this user owns to 0700 at initialization", () => {
    const data = dataDir();
    mkdirSync(join(data, "health"), { mode: 0o755 });
    chmodSync(join(data, "health"), 0o755);
    expect(new HealthPublisher({ dataDir: data }).initialize()).toBe("ready");
    expect(statSync(join(data, "health")).mode & 0o777).toBe(0o700);
  });

  it("a replaced root defers publication; the next initialization resumes it", async () => {
    const data = dataDir();
    const publisher = new HealthPublisher({ dataDir: data });
    publisher.initialize();
    mkdirSync(join(data, "replacement"), { mode: 0o700 }); // made while the old root exists, so it cannot reuse its inode
    removeTempDirSync(join(data, "health"));
    expect(await publisher.appendWindow("server", window(0))).toBe(false);
    expect(publisher.state).toBe("publication-deferred");
    expect(existsSync(join(data, "health"))).toBe(false); // a normal publication never recreates it
    renameSync(join(data, "replacement"), join(data, "health"));
    expect(await publisher.appendWindow("server", window(1))).toBe(false); // another directory: identity changed
    expect(publisher.deferReason).toBe("identity");
    expect(publisher.initialize()).toBe("ready");
    expect(await publisher.appendWindow("server", window(2))).toBe(true);
  });

  it("removes interrupted temporary children at initialization, and nothing else", () => {
    const data = dataDir();
    mkdirSync(join(data, "health"), { mode: 0o700 });
    const names = [".tmp-0123456789abcdef.json", ".tmp-0123456789abcdef.sqlite", ".tmp-0123456789abcdef.sqlite-journal", "backup-status.json", "notes.txt", ".tmp-short.json"];
    for (const name of names) writeFileSync(join(data, "health", name), "x", { mode: 0o600 });
    new HealthPublisher({ dataDir: data }).initialize();
    expect(readdirSync(join(data, "health")).sort()).toEqual([".tmp-short.json", "backup-status.json", "notes.txt"]);
    expect(HEALTH_TEMP_PATTERN.test(".tmp-0123456789abcdef.json")).toBe(true);
  });
});

describe("segments and manifests", () => {
  it("appends complete lines only, owner-only, and reads back the last epoch", async () => {
    const data = dataDir();
    let now = T0;
    const publisher = new HealthPublisher({ dataDir: data, now: () => now });
    publisher.initialize();
    expect(publisher.lastEpoch("server")).toBe(0);
    expect(await publisher.appendWindow("server", window(0))).toBe(true);
    now += 60_000;
    expect(await publisher.appendWindow("server", window(1))).toBe(true);
    const file = join(data, "health", HEALTH_FILES.serverCurrent);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(lines(file).map(line => parseWindowLine(line).ok)).toEqual([true, true]);
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(publisher.lastEpoch("server")).toBe(100);
  });

  it("a torn last line from a crash never glues onto the next record", async () => {
    const data = dataDir();
    mkdirSync(join(data, "health"), { mode: 0o700 });
    const file = join(data, "health", HEALTH_FILES.serverCurrent);
    writeFileSync(file, '{"schemaVersion":1,"install', { mode: 0o600 });
    const publisher = new HealthPublisher({ dataDir: data });
    publisher.initialize();
    expect(publisher.lastEpoch("server")).toBe(0);
    expect(await publisher.appendWindow("server", window(0))).toBe(true);
    const all = lines(file);
    expect(all).toHaveLength(2);
    expect(parseWindowLine(all[0]!).ok).toBe(false);
    expect(parseWindowLine(all[1]!).ok).toBe(true);
  });

  it(`rotates to previous at ${HEALTH_LIMITS.producerSegmentBytes} bytes and keeps two segments only`, async () => {
    const data = dataDir();
    let now = T0;
    const publisher = new HealthPublisher({ dataDir: data, now: () => now });
    mkdirSync(join(data, "health"), { mode: 0o700 });
    const current = join(data, "health", HEALTH_FILES.serverCurrent), previous = join(data, "health", HEALTH_FILES.serverPrevious);
    writeFileSync(previous, "old previous\n", { mode: 0o600 });
    writeFileSync(current, "x".repeat(HEALTH_LIMITS.producerSegmentBytes - 10) + "\n", { mode: 0o600 });
    publisher.initialize();
    expect(await publisher.appendWindow("server", window(0))).toBe(true);
    expect(statSync(previous).size).toBe(HEALTH_LIMITS.producerSegmentBytes - 9);
    expect(lines(current)).toHaveLength(1);
    expect(readdirSync(join(data, "health")).sort()).toEqual([HEALTH_FILES.serverCurrent, HEALTH_FILES.serverPrevious].sort());
    // A line that exactly fills the segment does not rotate; the next one does.
    const encoded = encodeWindowLine(window(1));
    if (!encoded.ok) throw new Error("encode");
    const bytes = Buffer.byteLength(encoded.value);
    writeFileSync(current, "y".repeat(HEALTH_LIMITS.producerSegmentBytes - bytes - 1) + "\n", { mode: 0o600 });
    const again = new HealthPublisher({ dataDir: data, now: () => now });
    again.initialize();
    expect(await again.appendWindow("server", window(1))).toBe(true);
    expect(statSync(current).size).toBe(HEALTH_LIMITS.producerSegmentBytes);
    expect(statSync(previous).size).toBe(HEALTH_LIMITS.producerSegmentBytes - 9);
    now += 60_000;
    expect(await again.appendWindow("server", window(2))).toBe(true);
    expect(statSync(previous).size).toBe(HEALTH_LIMITS.producerSegmentBytes);
    expect(lines(current)).toHaveLength(1);
  });

  it(`spends at most ${PRODUCER_BYTES_PER_MINUTE} bytes a minute per producer; what does not fit is counted in the next record`, async () => {
    const data = dataDir();
    let now = T0;
    const publisher = new HealthPublisher({ dataDir: data, now: () => now });
    publisher.initialize();
    const big = window(0, { counters: Array.from({ length: 32 }, (_, index) => ({ detector: "extraction" as const, engineKind: "claude" as const, code: "complete", value: index, sourceKey: index.toString(16).padStart(32, "0") })) });
    expect(await publisher.appendWindow("server", big)).toBe(true);
    expect(await publisher.appendWindow("server", { ...big, seq: 1 })).toBe(false); // the bucket is spent
    expect(await publisher.appendWindow("desktop", { ...window(0), producer: "desktop" })).toBe(true); // its own half
    now += 60_000;
    expect(await publisher.appendWindow("server", window(2))).toBe(true);
    const last = parseWindowLine(lines(join(data, "health", HEALTH_FILES.serverCurrent)).at(-1)!);
    expect(last.ok && last.value).toMatchObject({ seq: 2, complete: false, omitted: 1, coverageByDetector: { backup: "partial" } });
    expect(last.ok && last.value.counters[0]).toEqual({ detector: "coverage", engineKind: "none", code: "gap", value: 1 });
  });

  it("replaces a manifest atomically through a temporary child inside health/, and only the fixed names", () => {
    const data = dataDir();
    const publisher = new HealthPublisher({ dataDir: data });
    publisher.initialize();
    expect(publisher.replaceManifest(HEALTH_FILES.backupStatus, JSON.stringify({ a: 1 }))).toBe(true);
    expect(publisher.replaceManifest(HEALTH_FILES.backupStatus, JSON.stringify({ a: 2 }))).toBe(true);
    expect(publisher.readManifest(HEALTH_FILES.backupStatus)).toEqual({ a: 2 });
    expect(readdirSync(join(data, "health"))).toEqual([HEALTH_FILES.backupStatus]);
    if (posix) expect(statSync(join(data, "health", HEALTH_FILES.backupStatus)).mode & 0o777).toBe(0o600);
    expect(publisher.replaceManifest("../escape.json", "{}")).toBe(false);
    expect(publisher.replaceManifest("server.current.ndjson", "{}")).toBe(false);
    expect(readdirSync(data)).toEqual(["health"]);
  });
});

describe("server producer runtime", () => {
  it("starts a new epoch above the last published one, publishes minute windows and flushes on stop", async () => {
    const data = dataDir();
    let now = T0;
    const publisher = new HealthPublisher({ dataDir: data, now: () => now });
    publisher.initialize();
    await publisher.appendWindow("server", { ...window(0), epoch: Math.floor(T0 / 1000) + 50 });
    const counters = new HealthCounters({ producer: "server", now: () => now });
    const runtime = startHealthProducer({ publisher, installationId: INSTALL, counters, intervalMs: 3_600_000 })!;
    expect(runtime).not.toBeNull();
    expect(counters.currentEpoch).toBe(Math.floor(T0 / 1000) + 51);
    now += 60_000;
    counters.recordCounter("backup", "verified", "none");
    expect(await publishWindows(runtime)).toBe(1); // the baseline, carrying boot and the counter
    now += 60_000;
    expect(await publishWindows(runtime)).toBe(0); // quiet: held for combination
    now += 60_000;
    await stopHealthProducer(runtime);
    const records = lines(join(data, "health", HEALTH_FILES.serverCurrent)).map(line => parseWindowLine(line));
    expect(records.every(record => record.ok)).toBe(true);
    const values = records.map(record => (record.ok ? record.value : null)!);
    expect(values.slice(1).map(value => value.lifecycle)).toEqual(["running", "running", "stopping"]);
    expect(values[1]!.complete).toBe(false);
    expect(values.at(-1)!.counters).toContainEqual({ detector: "coverage", engineKind: "none", code: "shutdown", value: 1 });
  });

  it("the token key lives beside health/, owner-only, made once and kept across restarts; tokens a fingerprint uses stay the same", () => {
    const data = dataDir();
    const first = new HealthPublisher({ dataDir: data });
    first.initialize();
    const a = new HealthCounters({ producer: "server" });
    startHealthProducer({ publisher: first, installationId: INSTALL, counters: a, intervalMs: 3_600_000 })!.timer?.unref?.();
    const keyFile = join(data, HEALTH_KEY_FILE);
    expect(readFileSync(keyFile, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
    if (posix) expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(data, "health"))).not.toContain(HEALTH_KEY_FILE);
    const keyText = readFileSync(keyFile, "utf8");
    // A restart: a new publisher and new counters on the same data folder.
    const second = new HealthPublisher({ dataDir: data });
    second.initialize();
    const b = new HealthCounters({ producer: "server" });
    const runtime = startHealthProducer({ publisher: second, installationId: INSTALL, counters: b, intervalMs: 3_600_000 })!;
    if (runtime.timer) clearInterval(runtime.timer);
    expect(readFileSync(keyFile, "utf8")).toBe(keyText);
    expect(b.deriveStableToken("extractor", "connection-1")).toBe(a.deriveStableToken("extractor", "connection-1"));
    expect(b.deriveToken("turn", "t-1")).not.toBe(a.deriveToken("turn", "t-1"));
  });

  it("a token key that is unusable is never overwritten, and none is made while a capture runs", () => {
    const data = dataDir();
    let capturing = false;
    const publisher = new HealthPublisher({ dataDir: data, deferWhileCaptureActive: () => capturing });
    publisher.initialize();
    capturing = true;
    expect(publisher.loadTokenKey()).toBeNull();
    expect(existsSync(join(data, HEALTH_KEY_FILE))).toBe(false);
    capturing = false;
    writeFileSync(join(data, HEALTH_KEY_FILE), "not a key\n", { mode: 0o600 });
    expect(publisher.loadTokenKey()).toBeNull();
    expect(readFileSync(join(data, HEALTH_KEY_FILE), "utf8")).toBe("not a key\n");
  });

  it("Windows: the token key gets the owner-only DACL, and a key that cannot have it is refused", () => {
    let verdict: "owner-only" | "broad" = "broad";
    const restricted: string[] = [];
    const data = dataDir();
    const publisher = new HealthPublisher({ dataDir: data, platform: "win32", aclCheck: () => verdict, aclRestrict: path => { restricted.push(path); verdict = "owner-only"; return true; } });
    expect(publisher.loadTokenKey()).toHaveLength(32);
    expect(restricted).toEqual([join(realpathSync(data), HEALTH_KEY_FILE)]);
    const refusing = new HealthPublisher({ dataDir: data, platform: "win32", aclCheck: () => "broad", aclRestrict: () => false });
    expect(refusing.loadTokenKey()).toBeNull();
    expect(existsSync(join(data, HEALTH_KEY_FILE))).toBe(true);
  });

  it("Windows: a present key is restricted before it is read, so a key an earlier restriction left unreadable is repaired, not lost", () => {
    // An unreadable mode stands in for the empty DACL an (OI)(CI) grant once left on the key file; the injected restriction
    // makes it readable again, as the plain file grant does on Windows. Root can read anything, so it proves nothing there.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const data = dataDir();
    const keyFile = join(realpathSync(data), HEALTH_KEY_FILE);
    const keyText = `${"ab".repeat(32)}\n`;
    writeFileSync(keyFile, keyText, { mode: 0o600 });
    chmodSync(keyFile, 0o000);
    let verdict: "owner-only" | "broad" = "broad";
    const publisher = new HealthPublisher({ dataDir: data, platform: "win32", aclCheck: () => verdict, aclRestrict: path => { chmodSync(path, 0o600); verdict = "owner-only"; return true; } });
    expect(publisher.loadTokenKey()?.toString("hex")).toBe("ab".repeat(32));
    expect(readFileSync(keyFile, "utf8")).toBe(keyText);
  });

  it("does not start when the root cannot be initialized", () => {
    const data = dataDir();
    const publisher = new HealthPublisher({ dataDir: data, deferWhileCaptureActive: () => true });
    expect(startHealthProducer({ publisher, installationId: INSTALL, counters: new HealthCounters({ producer: "server" }) })).toBeNull();
    expect(existsSync(join(data, "health"))).toBe(false);
  });
});
