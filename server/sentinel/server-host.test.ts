// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The server's Sentinel wiring (GAP-SENTINEL-109 sections 3.3, 6.4 and 8): the health root is initialized at the data
// owner's boundary and never while a capture runs; setup failure costs coverage only; the minute delivery pass takes
// page intents, shows generic pages to an owner stream, and makes the digest; the Inbox block is bounded.
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthPageNotification } from "../../shared/notification-preferences.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { localSlot } from "./delivery.ts";
import { publishView, viewFromStore } from "./publication.ts";
import { INST, T0, cleanupFixtures, issueRecord, makeInstall } from "./scan-fixtures.ts";
import { captureActiveFromControl, cardRows, startServerSentinel, type ServerSentinelOptions } from "./server-host.ts";
import { SentinelStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => { cleanupFixtures(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const posixOnly = process.platform === "win32" ? it.skip : it;
const temp = () => { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-sentinel-host-"))); dirs.push(dir); return dir; };

function options(dataDir: string, overrides: Partial<ServerSentinelOptions> = {}): ServerSentinelOptions {
  return {
    dataDir, captureActive: () => false, observe: () => null, prefs: () => undefined, timeZone: () => "UTC",
    ownerStreams: () => true, send: () => true, timers: false, ...overrides,
  };
}

describe("startup at the data owner's boundary", () => {
  posixOnly("initializes the health root and starts the producer", async () => {
    const data = temp();
    const host = startServerSentinel(options(data));
    expect(host.installationId).toMatch(/^[0-9a-f]{32}$/);
    expect(host.publisher?.state).toBe("ready");
    expect(host.runtime).not.toBeNull();
    expect(existsSync(join(data, "health"))).toBe(true);
    await host.stop();
  });

  posixOnly("never creates the root while a backup capture is running, and startup goes on", async () => {
    const data = temp();
    const host = startServerSentinel(options(data, { captureActive: () => true }));
    expect(existsSync(join(data, "health"))).toBe(false);
    expect(host.runtime).toBeNull();
    expect(host.inbox().status).toBe("waiting");
    await host.stop();
  });

  it("a data directory that cannot be resolved costs health coverage only", async () => {
    const host = startServerSentinel(options(join(temp(), "missing")));
    expect(host.installationId).toBeNull();
    expect(() => host.tick()).not.toThrow();
    await expect(host.publishStats()).resolves.toBeUndefined();
    await expect(host.stop()).resolves.toBeUndefined();
  });

  it("reads the capture phase from the desktop backup host's coordinator; unknown counts as running", () => {
    expect(captureActiveFromControl(undefined)).toBe(false);
    const control = temp();
    expect(captureActiveFromControl(control)).toBe(false);
    writeFileSync(join(control, "backup-coordinator.json"), "{not json", { mode: 0o600 });
    expect(captureActiveFromControl(control)).toBe(true);
  });
});

describe("the minute delivery pass", () => {
  function scanner(count: number) {
    const fx = makeInstall();
    const opened = SentinelStore.open(fx.descriptor.outputRoot, { installationId: INST });
    if (opened.status !== "ok") throw new Error(opened.status);
    const store = opened.store;
    store.commit({ issues: Array.from({ length: count }, (_, i) => issueRecord(i + 1, { severity: "high" })) });
    publishView(fx.descriptor.outputRoot, viewFromStore(store, T0, "running", "complete", T0, T0));
    return { fx, store, locate: () => ({ ok: true as const, value: { installationId: INST, outputRoot: fx.descriptor.outputRoot } }) };
  }

  posixOnly("takes new page intents and shows them to an owner stream with generic text only", async () => {
    const { fx, store, locate } = scanner(2);
    const data = temp();
    const sent: HealthPageNotification[] = [];
    let now = T0;
    let streams = false;
    const host = startServerSentinel(options(data, { locate, now: () => now, ownerStreams: () => streams, send: n => { sent.push(n); return true; } }));
    host.tick(); // nothing to take yet
    store.commit({ intents: [{ id: "page-1", fingerprint: issueRecord(1).issue.fingerprint, episode: 1, delivery: "page", reason: "page", titleKey: "health.backup.not-protected", createdAt: T0 }] });
    publishView(fx.descriptor.outputRoot, viewFromStore(store, T0 + 60_000, "running", "complete", T0, T0));
    now += 60_000;
    host.tick();
    expect(sent).toHaveLength(0); // no owner session yet: the page waits
    streams = true;
    host.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "health-page", title: "Murage", route: "health" });
    host.tick();
    expect(sent).toHaveLength(1);
    store.close();
    await host.stop();
  });

  posixOnly("pages an intent the first scan committed before the server's first pass", async () => {
    const { fx, store, locate } = scanner(1);
    store.commit({ intents: [{ id: "page-first", fingerprint: issueRecord(1).issue.fingerprint, episode: 1, delivery: "page", reason: "page", titleKey: "health.backup.not-protected", createdAt: T0 }] });
    publishView(fx.descriptor.outputRoot, viewFromStore(store, T0, "running", "complete", T0, T0));
    const sent: HealthPageNotification[] = [];
    const host = startServerSentinel(options(temp(), { locate, now: () => T0, send: n => { sent.push(n); return true; } }));
    host.tick();
    expect(sent).toHaveLength(1);
    store.close();
    await host.stop();
  });

  posixOnly("makes the digest at 09:00 and carries it, with at most five rows, on the owner's Inbox block", async () => {
    const { store, locate } = scanner(8);
    const data = temp();
    let now = localSlot("2026-10-28", 540, "UTC") - 60_000;
    const digests: string[] = [];
    const host = startServerSentinel(options(data, { locate, now: () => now, onDigest: d => digests.push(d.id) }));
    host.tick();
    expect(digests).toHaveLength(0);
    now += 60_000;
    host.tick();
    expect(digests).toHaveLength(1);
    const inbox = host.inbox();
    expect(inbox.status).toBe("ready");
    expect(inbox.rows.length).toBeLessThanOrEqual(5);
    expect(inbox.digest?.id).toBe(digests[0]);
    expect(Buffer.byteLength(JSON.stringify(inbox))).toBeLessThan(32 * 1024);
    host.tick();
    expect(digests).toHaveLength(1);
    store.close();
    await host.stop();
  });

  it("orders card rows by impact, then recency", () => {
    const rows = cardRows({ schemaVersion: 1, storeRevision: 1, publishedAt: T0, summary: {} as never, rows: [
      { fingerprint: "a", severity: "low", lastSeenAt: 3, state: "open" }, { fingerprint: "b", severity: "high", lastSeenAt: 1, state: "open" },
      { fingerprint: "c", severity: "high", lastSeenAt: 2, state: "recovering" }, { fingerprint: "d", severity: "high", lastSeenAt: 9, state: "resolved" },
    ] as never });
    expect(rows.map(r => r.fingerprint)).toEqual(["c", "b", "a"]);
    expect(cardRows(null)).toEqual([]);
  });
});
