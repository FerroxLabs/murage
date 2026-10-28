// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The server's Sentinel wiring (1.0.9, GAP-SENTINEL-109 sections 3.3, 6.4, 8 and 9): one call from server/index.ts at
// the data owner's initialization boundary, one stop() from the orderly shutdown list.
//
//   start   right after the data-dir lease and ensureDirs(), before any backup capture can be admitted (captures need the
//           running server's idle claim, or the lease this process now holds): HealthPublisher.initialize() creates the
//           fixed health/ root; startHealthProducer() starts the unref'd minute roll-up (off every turn path).
//   stats   every 15 min (first after 1 min), one sealed statistics generation from storageObservation(); the build runs
//           in the stats publisher's worker.
//   backup  the backup status manifest is published by the coordinator that commits backups. On the desktop that is the
//           Electron backup host (electron/main.mjs), which passes createBackupStatusProducer().onCommitted to its
//           BackupCoordinator; the server has no committing coordinator of its own.
//   deliver every minute: read the published view (<= 16 KiB), take new page intents into the delivery ledger when the
//           view moved (or every 10 min), deliver ready pages to a connected owner stream, and make the digest when due.
//   stop    stopHealthProducer() flushes the open window with a `stopping` lifecycle; timers are cleared.
//
// Initialization failure affects health coverage only: nothing here throws into startup, a turn, a backup or shutdown.
import { BackupCoordinator } from "../backup-coordinator.ts";
import { realpathSync } from "node:fs";
import { sentinelInstallationIdOf } from "../../shared/sentinel-installation.mjs";
import type { HealthPageNotification } from "../../shared/notification-preferences.ts";
import { DIGEST_ROWS, severityRank, type HealthDigest, type HealthInbox, type SentinelView, type ViewRow } from "../../shared/sentinel-view.ts";
import { HealthPublisher, startHealthProducer, stopHealthProducer, type ProducerRuntime } from "../health/publisher.ts";
import { StatsPublisher, type DbStatsObservationRow } from "../health/stats-publisher.ts";
import { HealthDelivery, deliverPages } from "./delivery.ts";
import { locateSentinel, readOwnerView, type LocateResult } from "./owner-api.ts";
import { readPageIntents, readPublishedView } from "./publication.ts";

export const STATS_INTERVAL_MS = 15 * 60_000;
export const STATS_FIRST_DELAY_MS = 60_000;
export const DELIVERY_INTERVAL_MS = 60_000;
export const INTENT_RESYNC_MS = 10 * 60_000;
export const LOCATE_CACHE_MS = 60_000;

/** Coordinator phases during which a capture holds the installation's membership. */
const CAPTURE_PHASES = new Set(["claiming", "capturing", "offline-claimed"]);

/** Whether the desktop backup host's coordinator says a capture is under way (unknown counts as active). */
export function captureActiveFromControl(controlDirectory: string | undefined): boolean {
  if (!controlDirectory) return false;
  try { return CAPTURE_PHASES.has(new BackupCoordinator({ stateDirectory: controlDirectory }).status().phase); }
  catch { return true; }
}

export interface ServerSentinelOptions {
  dataDir: string;
  captureActive: () => boolean;
  /** The messages database observation (database.ts storageObservation), or null when closed. */
  observe: () => DbStatsObservationRow | null;
  /** cfg.notifications, live. */
  prefs: () => unknown;
  /** The digest's time zone: the host's on desktop and self-host, owner.timeZone on Cloud. */
  timeZone: () => string;
  /** An owner stream (unscoped SSE client) is connected. */
  ownerStreams: () => boolean;
  /** Broadcasts the page on the existing notify path; true when an owner stream received it. */
  send: (notification: HealthPageNotification) => boolean;
  /** A new digest was made (the Inbox re-reads). */
  onDigest?: (digest: HealthDigest) => void;
  now?: () => number;
  /** Tests: no timers. */
  timers?: boolean;
  locate?: () => LocateResult;
}

export interface ServerSentinel {
  installationId: string | null;
  publisher: HealthPublisher | null;
  runtime: ProducerRuntime | null;
  delivery: HealthDelivery | null;
  /** One delivery pass (the minute timer's body). */
  tick(): void;
  /** One statistics publication (the 15-minute timer's body). */
  publishStats(): Promise<void>;
  /** Health for an owner's Inbox read. Never attach this to a less privileged response. */
  inbox(): HealthInbox;
  /** Where the owner API reads from (cached for a minute). */
  locate(): LocateResult;
  stop(): Promise<void>;
}

/** Unresolved rows for a card: impact, then recency, at most DIGEST_ROWS. */
export function cardRows(view: SentinelView | null): ViewRow[] {
  if (!view) return [];
  return view.rows.filter(row => row.state !== "resolved")
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.lastSeenAt - a.lastSeenAt)
    .slice(0, DIGEST_ROWS);
}

export function startServerSentinel(options: ServerSentinelOptions): ServerSentinel {
  const now = options.now ?? Date.now;
  const timers: ReturnType<typeof setInterval>[] = [];
  let installationId: string | null = null;
  let publisher: HealthPublisher | null = null;
  let runtime: ProducerRuntime | null = null;
  let stats: StatsPublisher | null = null;
  let delivery: HealthDelivery | null = null;
  try {
    // The running server's data directory exists: one that does not resolve costs health coverage only.
    let canonical: string | null = null;
    try { canonical = realpathSync.native(options.dataDir); } catch { canonical = null; }
    installationId = canonical ? sentinelInstallationIdOf(canonical) : null;
    if (installationId) {
      publisher = new HealthPublisher({ dataDir: options.dataDir, deferWhileCaptureActive: options.captureActive });
      runtime = startHealthProducer({ publisher, installationId });
      stats = new StatsPublisher({ publisher, installationId });
      delivery = new HealthDelivery({ dataDir: options.dataDir, installationId, now });
      delivery.start();
    }
  } catch (error) {
    console.warn("health checks: setup did not finish; Murage runs as usual and Health reports waiting coverage", error instanceof Error ? error.name : "");
  }

  let located: { at: number; result: LocateResult } | null = null;
  const locate = (): LocateResult => {
    if (options.locate) return options.locate();
    const at = now();
    if (!located || at - located.at > LOCATE_CACHE_MS) located = { at, result: locateSentinel(options.dataDir) };
    return located.result;
  };

  let syncedRevision: number | null = null;
  let syncedAt = 0;
  const tick = () => {
    if (!delivery || !installationId) return;
    try {
      const where = locate();
      if (!where.ok) return;
      const view = readPublishedView(where.value.outputRoot);
      const at = now();
      if (view && (view.storeRevision !== syncedRevision || at - syncedAt > INTENT_RESYNC_MS)) {
        delivery.sync(() => readPageIntents(where.value.outputRoot, where.value.installationId));
        syncedRevision = view.storeRevision;
        syncedAt = at;
      }
      deliverPages(delivery, { prefs: options.prefs, now: () => new Date(now()), ownerSessionPresent: options.ownerStreams, send: options.send });
      const digest = delivery.maybeDigest(view, options.timeZone());
      if (digest) options.onDigest?.(digest);
    } catch { /* delivery never throws into the server */ }
  };

  const publishStats = async () => {
    if (!stats) return;
    try {
      const row = options.observe();
      if (row) await stats.publishStatsGeneration({ at: now(), rows: [row] });
    } catch { /* coverage only */ }
  };

  if (options.timers !== false && installationId) {
    const statsTimer = setInterval(() => { void publishStats(); }, STATS_INTERVAL_MS);
    statsTimer.unref?.();
    timers.push(statsTimer);
    const first = setTimeout(() => { void publishStats(); }, STATS_FIRST_DELAY_MS);
    first.unref?.();
    timers.push(first as unknown as ReturnType<typeof setInterval>);
    const deliveryTimer = setInterval(tick, DELIVERY_INTERVAL_MS);
    deliveryTimer.unref?.();
    timers.push(deliveryTimer);
  }

  return {
    installationId, publisher, runtime, delivery, tick, publishStats, locate,
    inbox(): HealthInbox {
      try {
        const where = locate();
        if (!where.ok) return { status: where.reason === "descriptor-missing" || where.reason === "output-root" ? "waiting" : "unavailable", summary: null, rows: [], digest: delivery?.currentDigest() ?? null };
        // The owner's view: the host's stale heartbeat or registration-needed reads as waiting coverage.
        const view = readOwnerView(where.value);
        return { status: view ? "ready" : "waiting", summary: view?.summary ?? null, rows: cardRows(view), digest: delivery?.currentDigest() ?? null };
      } catch { return { status: "unavailable", summary: null, rows: [], digest: null }; }
    },
    async stop() {
      for (const timer of timers.splice(0)) { clearInterval(timer); clearTimeout(timer as unknown as ReturnType<typeof setTimeout>); }
      if (runtime) await stopHealthProducer(runtime);
    },
  };
}
