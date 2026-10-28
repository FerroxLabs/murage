// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The desktop Sentinel host (1.0.9, GAP-SENTINEL-109 sections 3.3, 6.4, 8.4, 10). Electron's main process owns:
//
//  - The producer root: initialize() runs at the data owner's boundary, BEFORE any backup capture is admitted, through
//    the bundled producer boundary (dist-server/health/host-boundary.js, the same HealthPublisher the server uses). It
//    starts the desktop producer (desktop.current.ndjson: boot/shutdown, suspend/resume, registration and schedule
//    outcome, backup transition counts) and the backup-status manifest producer, fed by the desktop coordinator's
//    onCommitted observer (backupCommitted). A closed-app backup run writes only inside an already initialized root.
//  - Registration: reconcile() writes the descriptor and brings this installation's OS schedule to the installed
//    executable and a staged entry (electron/sentinel-schedule.mjs), at first compatible install, after an update and
//    after a move (the previous installation's registration, and only that one, is removed). Quitting never unregisters.
//  - Proof and freshness: check() proves the registration with a heartbeat newer than it, rolls an update back when no
//    such heartbeat arrives, and writes <outputRoot>/host-status.json. A heartbeat older than 30 minutes while the
//    machine has been awake for 30 minutes is the host's S10 coverage note (the scanner cannot report its own absence):
//    host-status.json says `heartbeat: "stale"` and the desktop producer counts `coverage/schedule-failed` once.
//  - Native pages (section 8.4): THE SERVER IS THE ONE DELIVERY OWNER. It claims each page intent from its ledger
//    (server/sentinel/delivery.ts) and sends it as the ordinary notify frame to the owner's desktop renderer, which shows
//    one native notification per delivery id (src/lib/notify.ts showHealthPage). main.mjs does NOT inject `delivery`
//    here, so deliverPages() below answers null and claims nothing. The adapter stays for a future host that must show
//    pages without a renderer; it would be injected INSTEAD of the renderer path, onto the server's same two ledger
//    calls (never a second ledger), so one intent can never be claimed twice:
//
//      delivery.claimNextPage(): Promise<{ deliveryId: string, titleKey: string, bodyKey: string } | null>
//      delivery.ack(deliveryId: string, outcome: "delivered" | "suppressed"): Promise<void>
//
//    A crash between claim and ack leaves the server-side intent `uncertain`; the host never re-sends it.
//
// host-status.json (owner-only, in the Sentinel output root, enums and times only) is the fixed file the server's
// owner API reads for the host's view: { version: 1, installationId, at, registration, mechanism, heartbeat,
// heartbeatAt, rootState }.
import { execFile, spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  APPRUN_NO_SANDBOX, createSentinelScheduleProvider, proveSentinelRegistration, readRegistrationRecord, reconcileSentinelRegistration, writeRegistrationRecord,
} from "./sentinel-schedule.mjs";

export const SENTINEL_HOST_STATUS_FILE = "host-status.json";
export const SENTINEL_LAST_INSTALLATION_FILE = "sentinel-installation.json";
export const HEARTBEAT_STALE_MS = 30 * 60_000;
export const HOST_CHECK_INTERVAL_MS = 15 * 60_000;
export const PAGE_POLL_INTERVAL_MS = 2 * 60_000;
export const FIRST_RECONCILE_DELAY_MS = 60_000;
/** One generic text for every page: nothing on a lock screen says what or whose. */
export const PAGE_NOTIFICATION = Object.freeze({ title: "Murage", body: "Something in Murage needs a look. Open Murage to see it." });
const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const ID = /^[0-9a-f]{16,64}$/;
const ENV_ALLOWLIST = ["HOME", "USERPROFILE", "LOCALAPPDATA", "XDG_STATE_HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT", "WINDIR", "LANG", "TZ"];

/** The bundled boundary inside a packaged app (resources/server/health/host-boundary.js). */
export const packagedBoundaryPath = resourcesPath => path.join(resourcesPath, "server", "health", "host-boundary.js");
export const packagedEntryPath = resourcesPath => path.join(resourcesPath, "server", "sentinel", "cli.js");

export function scannerEnvironment(env = process.env) {
  const out = {};
  for (const key of ENV_ALLOWLIST) { const value = env[key]; if (typeof value === "string" && value.length <= 4096 && !value.includes("\0")) out[key] = value; }
  out.ELECTRON_RUN_AS_NODE = "1";
  return out;
}

/** Runs `<exe> <entry> <descriptor> --check-install` and answers its exit code (null when it could not run). */
export function defaultProbe({ executable, platform = process.platform, env = process.env, timeoutMs = 20_000 }) {
  return (descriptorPath, entry) => new Promise(resolve => {
    const args = [entry, descriptorPath, "--check-install", ...(platform === "linux" ? [APPRUN_NO_SANDBOX] : [])];
    execFile(executable, args, { env: scannerEnvironment(env), timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 64 * 1024 }, error => {
      if (!error) { resolve(0); return; }
      resolve(typeof error.code === "number" && !error.killed ? error.code : null);
    });
  });
}

/** Starts the independent `--watch` supervisor, detached so it outlives this app. Answers its pid or null. */
export function defaultSpawnWatcher({ executable, platform = process.platform, env = process.env }) {
  return (descriptorPath, entry) => {
    try {
      const child = spawnProcess(executable, [entry, descriptorPath, "--watch", ...(platform === "linux" ? [APPRUN_NO_SANDBOX] : [])], { detached: true, stdio: "ignore", windowsHide: true, shell: false, env: scannerEnvironment(env) });
      child.on("error", () => {});
      child.unref();
      return child.pid ?? null;
    } catch { return null; }
  };
}

function writeOwnedJson(file, value, platform) {
  const temp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  if (platform !== "win32") chmodSync(temp, 0o600);
  renameSync(temp, file);
}

/**
 * options: {
 *   dataDir            the owned DATA_DIR (the data owner's selection)
 *   resourcesPath      packaged resources (boundary and entry come from there) or loadBoundary/entrySource
 *   executable         the stable installed executable (APPIMAGE when set, else the app executable)
 *   home, env, configHome, userData, platform, uid, now
 *   captureActive()    true while a backup capture runs (the root is never created then)
 *   closed             true for a closed-app backup run: no root creation, no producer timer, no registration
 *   bindingCurrent()   async: is the latest verification's folder and key the one backups use now? true or false
 *                      when checked, null when it cannot be checked (electron/backup-schedule-host.mjs bindingCurrent)
 *   loadBoundary(), provider, probe, spawnWatcher, scheduleRun, Notification, delivery, log, setInterval, clearInterval
 * }
 */
export function createSentinelHost(options) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const log = line => { try { options.log?.(line); } catch { /* logging never changes anything here */ } };
  const every = options.setInterval ?? ((fn, ms) => { const handle = setInterval(fn, ms); handle.unref?.(); return handle; });
  const stopEvery = options.clearInterval ?? (handle => clearInterval(handle));
  const p = platform === "win32" ? path.win32 : path.posix;

  let boundary = null;
  let publisher = null;
  let counters = null;
  let runtime = null;
  let backupProducer = null;
  let installationId = null;
  let installationRoot = null;
  let outputRoot = null;
  let provider = null;
  let registration = { state: "unregistered", mechanism: null, revision: null, reason: null };
  let heartbeat = { state: "waiting", at: null };
  let staleNoted = false;
  let awakeSince = now();
  let suspended = false;
  let lastBackupKey = null;
  let liveBinding = null;
  let bindingChain = Promise.resolve(null);
  let watcherPid = null;
  let fallbackRemoved = false;
  let timers = [];
  let busy = null;
  let pagesShown = 0;
  let disabled = null;

  const loadBoundary = options.loadBoundary ?? (async () => import(pathToFileURL(packagedBoundaryPath(options.resourcesPath)).href));
  const entrySource = () => options.entrySource ?? packagedEntryPath(options.resourcesPath);

  function scheduleProvider() {
    if (provider) return provider;
    let userSid = options.userSid ?? null;
    if (platform === "win32" && !userSid && typeof boundary?.currentUserSid === "function") userSid = boundary.currentUserSid();
    provider = options.provider ?? createSentinelScheduleProvider({ platform, home: options.home, configHome: options.configHome, uid: options.uid ?? process.getuid?.() ?? -1, userSid, env, ...(options.scheduleRun ? { run: options.scheduleRun } : {}) });
    return provider;
  }

  function count(code) { try { counters?.recordCounter("coverage", code, "none"); } catch { /* counts never throw into the app */ } }

  function writeHostStatus() {
    if (!outputRoot || !installationId) return false;
    try {
      writeOwnedJson(p.join(outputRoot, SENTINEL_HOST_STATUS_FILE), {
        version: 1, installationId, at: now(), registration: registration.state, mechanism: registration.mechanism,
        heartbeat: heartbeat.state, heartbeatAt: heartbeat.at, rootState: publisher?.state ?? "absent",
      }, platform);
      return true;
    } catch { return false; }
  }

  function publishCommitted(state, binding) {
    try {
      if (!backupProducer) return null;
      liveBinding = binding;
      const status = backupProducer.onCommitted(state);
      // Desktop backup transition counts (desktop.current.ndjson), once per changed outcome like the manifest's line.
      if (counters) {
        const outcome = boundary.backupOutcome(state);
        const key = `${outcome.result}:${outcome.code}:${state?.revision}`;
        if (key !== lastBackupKey) {
          lastBackupKey = key;
          counters.recordCounter("backup", outcome.result, "none");
          if (outcome.result === "failed") counters.recordCounter("backup", outcome.code, "none");
        }
      }
      return status;
    } catch { return null; }
  }

  const host = {
    get installationId() { return installationId; },
    get outputRoot() { return outputRoot; },
    get rootState() { return publisher?.state ?? "absent"; },
    get registration() { return { ...registration }; },

    /** The owned initialization boundary (before capture admission). Never throws. Answers the root state. */
    async initialize() {
      try {
        boundary = await loadBoundary();
        installationRoot = realpathSync.native(options.dataDir);
        installationId = boundary.sentinelInstallationId(installationRoot);
        publisher = new boundary.HealthPublisher({
          dataDir: installationRoot, platform,
          // A closed-app run never creates the root: it writes only inside one an open app initialized.
          deferWhileCaptureActive: () => options.closed === true || options.captureActive?.() === true,
        });
        const state = publisher.initialize();
        // The live folder/key check answers per commit (backupCommitted below); null only when it cannot be checked.
        backupProducer = boundary.createBackupStatusProducer({ publisher, installationId, bindingMatches: () => liveBinding, log: line => log(`[sentinel] ${line}`) });
        if (!options.closed && state === "ready") {
          counters = new boundary.HealthCounters({ producer: "desktop", detectors: ["coverage", "backup"] });
          runtime = boundary.startHealthProducer({ publisher, installationId, producer: "desktop", counters });
        }
        outputRoot = boundary.defaultOutputRoot(installationId, { platform, env, home: options.home });
        // A fresh Linux account may have no XDG state folder yet (~/.local/state); the XDG spec says to create it 0700.
        // macOS Application Support and Windows LOCALAPPDATA always exist. ensureOutputRoot creates the two levels below.
        if (outputRoot && platform === "linux") {
          try { mkdirSync(p.dirname(p.dirname(outputRoot)), { recursive: true, mode: 0o700 }); } catch { /* reconcile reports output-root-create */ }
        }
        log(`[sentinel] health root ${state}`);
        return state;
      } catch {
        disabled = "boundary";
        log("[sentinel] health root waiting: the producer boundary did not load");
        return "absent";
      }
    },

    /** The desktop coordinator's onCommitted observer: publish the backup manifest after the durable commit. With
     *  options.bindingCurrent (the backup host's live folder/key check, async), each commit waits for that answer and
     *  commits publish in order; the call then answers a promise of the status. Never throws or rejects. */
    backupCommitted(state) {
      if (typeof options.bindingCurrent !== "function") return publishCommitted(state, null);
      const next = bindingChain.then(async () => {
        let binding = null;
        try { const answer = await options.bindingCurrent(); binding = answer === true || answer === false ? answer : null; } catch { binding = null; }
        return publishCommitted(state, binding);
      }).catch(() => null);
      bindingChain = next;
      return next;
    },

    suspend() {
      suspended = true;
      try { counters?.setLifecycle("suspending"); } catch { /* counts only */ }
    },
    resume() {
      suspended = false;
      awakeSince = now();
      try { counters?.setLifecycle("resumed"); } catch { /* counts only */ }
    },

    /** Brings the OS registration to this executable and entry (section 10.2). Never throws. */
    async reconcile() {
      if (!boundary || !installationId || !outputRoot || options.closed) return registration;
      if (busy) return busy;
      busy = (async () => {
        const providerNow = scheduleProvider();
        await host.forgetMovedInstallation();
        const executable = options.executable;
        const deps = {
          platform, uid: options.uid ?? process.getuid?.() ?? -1, installationId, installationRoot, outputRoot, executable, entrySource: entrySource(),
          provider: providerNow, boundary, now,
          probe: options.probe ?? defaultProbe({ executable, platform, env }),
        };
        const before = registration.revision;
        let result = await reconcileSentinelRegistration(deps).catch(() => ({ state: "registration-needed", mechanism: null, revision: null, reason: "internal" }));
        if (result.state === "registration-needed" && ["no-user-manager", "scheduler-refused", "readback"].includes(result.reason)) result = await host.fallback(result);
        else if (result.state === "registered" && watcherPid !== null) host.stopWatcher();
        registration = result;
        if (result.revision !== before) count("registration");
        count(result.state === "registration-needed" ? "schedule-failed" : "schedule-ok");
        log(`[sentinel] registration ${result.state}${result.reason ? ` ${result.reason}` : ""}`);
        writeHostStatus();
        return result;
      })().finally(() => { busy = null; });
      return busy;
    },

    /** OS refusal: the independent supervisor, plus (Linux) an owning-user autostart entry so it returns at sign-in. */
    async fallback(result) {
      const descriptorPath = p.join(outputRoot, boundary.DESCRIPTOR_FILE);
      const loaded = boundary.loadDescriptor(descriptorPath, { platform });
      if (!loaded.ok) return result;
      const spawnWatcher = options.spawnWatcher ?? defaultSpawnWatcher({ executable: options.executable, platform, env });
      let mechanism = "supervisor";
      let created = true;
      if (platform === "linux") {
        try {
          const prior = await scheduleProvider().readFallback(loaded.value, descriptorPath).catch(() => null);
          created = !(prior && boundary.registrationMatches(prior, loaded.value, descriptorPath));
          if (created) await scheduleProvider().installFallback(loaded.value, descriptorPath);
          mechanism = "autostart";
        } catch { mechanism = "supervisor"; created = true; }
      }
      // An existing autostart entry already started this session's supervisor at sign-in: never a second one.
      if (created && watcherPid === null) watcherPid = spawnWatcher(descriptorPath, loaded.value.executable.entry);
      if (watcherPid === null && !(mechanism === "autostart" && !created)) {
        return { ...result, mechanism: null, reason: "scheduling-unavailable" };
      }
      const record = readRegistrationRecord(outputRoot, { platform, uid: options.uid ?? process.getuid?.() ?? -1 });
      const state = mechanism === "autostart" ? "registered" : "registration-needed";
      try {
        writeRegistrationRecord(outputRoot, {
          installationId, state, mechanism, revision: loaded.value.scheduleRevision, registeredAt: record?.mechanism === mechanism && record?.registeredAt ? record.registeredAt : now(), provenAt: null,
          current: { path: loaded.value.executable.path, entry: loaded.value.executable.entry, sha256: loaded.value.executable.sha256, revision: loaded.value.scheduleRevision },
          previous: record?.previous ?? null, reason: result.reason,
        }, { platform });
      } catch { /* the next reconcile rewrites it */ }
      return { state, mechanism, revision: loaded.value.scheduleRevision, reason: result.reason };
    },

    stopWatcher() {
      if (watcherPid === null) return;
      try { process.kill(watcherPid); } catch { /* already gone */ }
      watcherPid = null;
    },

    /** A moved installation: remove the previous installation's registration (only its names), remember this one. */
    async forgetMovedInstallation() {
      if (!options.userData) return null;
      const file = p.join(options.userData, SENTINEL_LAST_INSTALLATION_FILE);
      let previous = null;
      try { const value = JSON.parse(readFileSync(file, "utf8")); if (ID.test(value?.installationId)) previous = value.installationId; } catch { previous = null; }
      if (previous === installationId) return null;
      if (previous) { try { await scheduleProvider().remove(previous); log("[sentinel] removed the registration of the previous installation folder"); } catch { /* retried at the next start */ return null; } }
      try { mkdirSync(options.userData, { recursive: true }); writeOwnedJson(file, { version: 1, installationId }, platform); } catch { /* retried at the next start */ }
      return previous;
    },

    /** Proof, rollback and the host-side freshness note. Never throws. */
    async check() {
      if (!boundary || !outputRoot || options.closed) return heartbeat;
      try {
        const uid = options.uid ?? process.getuid?.() ?? -1;
        const proof = await proveSentinelRegistration({
          platform, uid, outputRoot, provider: scheduleProvider(), boundary, now, awakeSince,
          rollback: async previous => {
            // Re-register the previous identity (its staged copy is kept) as the next revision.
            const result = await reconcileSentinelRegistration({
              platform, uid, installationId, installationRoot, outputRoot, executable: previous.path, entrySource: previous.entry, provider: scheduleProvider(), boundary, now,
              probe: options.probe ?? defaultProbe({ executable: previous.path, platform, env }),
            });
            log(`[sentinel] update rolled back: ${result.state}`);
            return result;
          },
        });
        registration = { ...registration, state: proof.state };
        // Linux: a proven systemd timer replaces the autostart fallback; its entry goes so the next sign-in starts no
        // second scanner (the running supervisor stops by itself when the descriptor's revision moves on).
        if (proof.state === "proven" && platform === "linux" && registration.mechanism === "systemd" && !fallbackRemoved) {
          fallbackRemoved = true;
          try { await scheduleProvider().removeFallback?.(installationId); } catch { fallbackRemoved = false; }
        }
        const at = now();
        const awakeLong = !suspended && at - awakeSince >= HEARTBEAT_STALE_MS;
        const stale = proof.heartbeatAt === null ? awakeLong : at - proof.heartbeatAt > HEARTBEAT_STALE_MS && awakeLong;
        heartbeat = { state: stale ? "stale" : proof.heartbeatAt === null ? "waiting" : "fresh", at: proof.heartbeatAt };
        if (stale && !staleNoted) { staleNoted = true; count("schedule-failed"); log("[sentinel] health checks are waiting for a fresh scan"); }
        if (!stale) staleNoted = false;
      } catch { heartbeat = { state: "waiting", at: heartbeat.at }; }
      writeHostStatus();
      return heartbeat;
    },

    /** Claims at most one page and shows it. Never throws; never re-sends an uncertain claim. */
    async deliverPages() {
      const delivery = options.delivery;
      if (!delivery || options.closed) return null;
      let claim;
      try { claim = await delivery.claimNextPage(); } catch { return null; }
      if (!claim) return null;
      if (!TOKEN.test(String(claim.deliveryId ?? ""))) return null;
      let outcome = "suppressed";
      try {
        const Notification = options.Notification;
        if (Notification && (typeof Notification.isSupported !== "function" || Notification.isSupported())) {
          const notice = new Notification({ title: PAGE_NOTIFICATION.title, body: PAGE_NOTIFICATION.body, silent: false });
          if (typeof options.onPageClick === "function") notice.on?.("click", () => { try { options.onPageClick(); } catch { /* focus only */ } });
          notice.show();
          outcome = "delivered";
          pagesShown++;
        }
      } catch { outcome = "suppressed"; }
      try { await delivery.ack(claim.deliveryId, outcome); } catch { /* stays uncertain on the server: never re-sent */ }
      return outcome;
    },

    /** Background work after startup: first reconcile shortly after launch, proof every 15 min, pages every 2 min. */
    startBackground() {
      if (options.closed || timers.length || disabled) return;
      const firstDelay = options.firstReconcileDelayMs ?? FIRST_RECONCILE_DELAY_MS;
      const first = setTimeout(() => { void host.reconcile().then(() => host.check()); }, firstDelay);
      first.unref?.();
      timers.push({ timeout: first });
      timers.push({ interval: every(() => { if (!suspended) void host.check(); }, HOST_CHECK_INTERVAL_MS) });
      timers.push({ interval: every(() => { if (!suspended) void host.deliverPages(); }, PAGE_POLL_INTERVAL_MS) });
    },

    /** Quit: flush the desktop producer. Never unregisters Sentinel and never stops a scanner. */
    async shutdown() {
      // A commit still waiting on its folder/key answer publishes first, bounded so quitting never waits on it.
      await Promise.race([bindingChain, new Promise(resolve => { const t = setTimeout(resolve, 2_000); t.unref?.(); })]);
      for (const timer of timers.splice(0)) { if (timer.timeout) clearTimeout(timer.timeout); if (timer.interval) stopEvery(timer.interval); }
      if (runtime) { const current = runtime; runtime = null; try { await boundary.stopHealthProducer(current); } catch { /* best effort */ } }
    },

    /** Owner-requested removal of THIS installation's registration (never on quit). State is preserved. */
    async removeRegistration() {
      if (!installationId) return { removed: [] };
      host.stopWatcher();
      return scheduleProvider().remove(installationId);
    },

    /** Owner-selected diagnostics: enums and counts only. */
    diagnosticsSummary() {
      const ageMinutes = heartbeat.at === null ? null : Math.max(0, Math.floor((now() - heartbeat.at) / 60_000));
      return {
        available: !disabled && !!boundary,
        rootState: publisher?.state ?? "absent",
        rootDeferred: publisher?.deferredCount ?? 0,
        registration: registration.state,
        mechanism: registration.mechanism ?? "none",
        revision: registration.revision ?? 0,
        heartbeat: heartbeat.state,
        heartbeatAgeMinutes: ageMinutes === null ? "none" : Math.min(ageMinutes, 10_080),
        pagesShown,
      };
    },
  };
  return host;
}
