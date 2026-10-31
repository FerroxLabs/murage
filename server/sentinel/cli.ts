// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Sentinel service entry (1.0.9, GAP-SENTINEL-109 sections 3.1, 10.1 and 10.2). Bundled to server/sentinel/cli.js
// and run by the installed executable with ELECTRON_RUN_AS_NODE=1 (desktop) or the pinned Node (self-host):
//
//   cli <descriptor.json> --once           one supervised child scan (5 s wall deadline), then exit
//   cli <descriptor.json> --watch          child scans every 120 s + installation jitter, until stopped or retired
//   cli <descriptor.json> --check-install  print registration and heartbeat state as one JSON line
//
// No other arguments, options or environment switches. The environment is scrubbed to an allowlist first. This module's
// import graph never reaches server startup, the live database opener, a driver, credential-bearing config or any
// network module (cli-imports.test.ts walks it). Registration readers are injected: lane C supplies the launchd,
// Task Scheduler and systemd readers.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HEALTH_LIMITS } from "../../shared/health-protocol.mjs";
import { loadDescriptor, type SentinelDescriptor } from "./paths.ts";
import { readPublishedView } from "./publication.ts";
import { recordScanFailure, runScan, type ScanOptions, type ScanStatus } from "./scan.ts";
import { SentinelStore } from "./store.ts";
import { CHILD_FLAG, EXIT, WatchSupervisor, allowlistedEnv, isFailedAttempt, runChildScan, scrubEnvironment, type ChildSpec, type SpawnChild } from "./supervisor.ts";

export type CliMode = "--once" | "--watch" | "--check-install";
const MODES: readonly CliMode[] = ["--once", "--watch", "--check-install"];

/** What an OS scheduler actually has registered for this installation (section 10.1: read, never assumed). */
export interface RegistrationState {
  mechanism: "launchd" | "task-scheduler" | "systemd" | "autostart" | "supervisor";
  registered: boolean;
  executable: string | null;
  args: readonly string[] | null;
  /** The owning account as the scheduler reports it, or null when unknown. */
  owner: string | null;
  /** The schedule revision recorded with the registration, or null. */
  revision: number | null;
  /** Last run result code, or null when it never ran. */
  lastResult: number | null;
}
export type RegistrationReader = (descriptor: SentinelDescriptor) => RegistrationState | null | Promise<RegistrationState | null>;

let defaultReaders: RegistrationReader[] = [];
/** Lane C installs the OS registration readers here (or passes them to main()). */
export function setDefaultRegistrationReaders(readers: readonly RegistrationReader[]): void { defaultReaders = [...readers]; }

export type InstallState = "proven" | "registered" | "registration-needed" | "unregistered";
export interface CheckInstallReport {
  descriptor: "ok" | string;
  installationId: string | null;
  registrations: Array<RegistrationState & { matches: boolean }>;
  heartbeatAt: number | null;
  heartbeatAgeMs: number | null;
  heartbeatFresh: boolean;
  scanner: string | null;
  state: InstallState;
}

export interface CliDeps {
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  now?: () => number;
  execPath?: string;
  /** Script path the child re-runs (default process.argv[1]). */
  entry?: string;
  execArgv?: readonly string[];
  spawnChild?: SpawnChild;
  deadlineMs?: number;
  registrationReaders?: readonly RegistrationReader[];
  scan?: Partial<Omit<ScanOptions, "descriptor">>;
  /** --watch: resolves when the supervisor should stop (default: SIGTERM/SIGINT). */
  untilStopped?: () => Promise<void>;
  /** --watch: the timer between scans (tests). */
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export const STATUS_EXIT: Readonly<Record<ScanStatus, number>> = Object.freeze({
  published: EXIT.ok, "no-op": EXIT.ok, "already-running": EXIT.alreadyRunning, "upgrade-needed": EXIT.upgradeNeeded, unavailable: EXIT.unavailable,
  "budget-exhausted": EXIT.budgetExhausted, "output-refused": EXIT.outputRefused, failed: EXIT.failed,
});

/** An AppImage's AppRun adds `--no-sandbox` unless some argument already is one, and Node refuses that option BEFORE the
 * script, so the Linux registration passes it LAST (the same lesson as electron/backup-closed-profile.mjs). It is
 * accepted there only, as the single trailing argument, and means nothing to the scanner. */
export const APPRUN_NO_SANDBOX = "--no-sandbox";

/** Parses exactly `<descriptor> <mode>` (on Linux, optionally followed by APPRUN_NO_SANDBOX). */
export function parseArgs(argv: readonly string[], platform: NodeJS.Platform = process.platform): { descriptor: string; mode: CliMode } | null {
  if (platform === "linux" && argv.length === 3 && argv[2] === APPRUN_NO_SANDBOX) argv = argv.slice(0, 2);
  if (argv.length !== 2) return null;
  const [descriptor, mode] = argv as [string, string];
  if (!MODES.includes(mode as CliMode) || descriptor.startsWith("-")) return null;
  return { descriptor, mode: mode as CliMode };
}

/** Does a registration run exactly this installation's entry with this descriptor, at this schedule revision? */
export function registrationMatches(reg: RegistrationState, descriptor: SentinelDescriptor, descriptorPath: string): boolean {
  if (!reg.registered || reg.executable !== descriptor.executable.path || !reg.args) return false;
  const args = [...reg.args];
  const entryAt = args.indexOf(descriptor.executable.entry);
  if (entryAt < 0 || args[entryAt + 1] !== descriptorPath || !["--once", "--watch"].includes(args[entryAt + 2] ?? "")) return false;
  return reg.revision === descriptor.scheduleRevision;
}

export async function checkInstall(descriptorPath: string, deps: CliDeps = {}): Promise<CheckInstallReport> {
  const now = (deps.now ?? Date.now)();
  const loaded = loadDescriptor(descriptorPath, { create: false });
  if (!loaded.ok) return { descriptor: loaded.reason, installationId: null, registrations: [], heartbeatAt: null, heartbeatAgeMs: null, heartbeatFresh: false, scanner: null, state: "unregistered" };
  const d = loaded.value;
  const registrations: CheckInstallReport["registrations"] = [];
  for (const reader of deps.registrationReaders ?? defaultReaders) {
    try {
      const reg = await reader(d);
      if (reg) registrations.push({ ...reg, matches: registrationMatches(reg, d, descriptorPath) });
    } catch { /* an unreadable registration is not a registration */ }
  }
  let heartbeatAt: number | null = null;
  const opened = SentinelStore.open(d.outputRoot, { installationId: d.installationId, readOnly: true });
  if (opened.store) { try { heartbeatAt = opened.store.meta<number>("heartbeat_at"); } catch { heartbeatAt = null; } finally { opened.store.close(); } }
  const age = heartbeatAt === null ? null : Math.max(0, now - heartbeatAt);
  // A heartbeat is written at most every 15 min by a running scanner; two intervals plus a cadence is still fresh.
  const fresh = age !== null && age <= 2 * HEALTH_LIMITS.heartbeatMinIntervalMs + HEALTH_LIMITS.scanCadenceMs + HEALTH_LIMITS.scanJitterMaxMs;
  const matching = registrations.some(r => r.matches);
  const state: InstallState = matching && fresh ? "proven" : matching ? "registered" : registrations.some(r => r.registered) ? "registration-needed" : "unregistered";
  return {
    descriptor: "ok", installationId: d.installationId, registrations, heartbeatAt, heartbeatAgeMs: age, heartbeatFresh: fresh,
    scanner: readPublishedView(d.outputRoot)?.summary.scanner ?? null, state,
  };
}

function childSpec(descriptorPath: string, deps: CliDeps): ChildSpec {
  const env = allowlistedEnv(deps.env ?? process.env);
  env[CHILD_FLAG] = "1";
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  const entry = deps.entry ?? process.argv[1] ?? "";
  return { execPath: deps.execPath ?? process.execPath, args: [...(deps.execArgv ?? process.execArgv), entry, descriptorPath, "--once"], env };
}

const stopSignal = () => new Promise<void>(resolve => { process.once("SIGTERM", () => resolve()); process.once("SIGINT", () => resolve()); });

/** The entry. Answers the process exit code. */
export async function main(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const env = deps.env ?? process.env;
  const args = parseArgs(argv);
  if (!args) { out(JSON.stringify({ status: "usage" })); return EXIT.usage; }
  if (args.mode === "--check-install") {
    const report = await checkInstall(args.descriptor, deps);
    out(JSON.stringify(report));
    return report.state === "proven" ? EXIT.ok : EXIT.notProven;
  }
  const loaded = loadDescriptor(args.descriptor, { create: false });
  if (!loaded.ok) { out(JSON.stringify({ status: "descriptor-refused", reason: loaded.reason })); return EXIT.usage; }
  const descriptor = loaded.value;
  const now = deps.now ?? Date.now;

  if (args.mode === "--once" && env[CHILD_FLAG] === "1") {
    // The supervised child: one scan in this process.
    try {
      const outcome = runScan({ ...(deps.scan ?? {}), descriptor });
      out(JSON.stringify({ status: outcome.status, revision: outcome.revision, coverage: outcome.coverage }));
      return STATUS_EXIT[outcome.status];
    } catch {
      out(JSON.stringify({ status: "failed" }));
      return EXIT.failed;
    }
  }

  const spec = childSpec(args.descriptor, deps);
  if (args.mode === "--once") {
    const result = await runChildScan(spec, { ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}), ...(deps.spawnChild ? { spawnChild: deps.spawnChild } : {}) });
    if (isFailedAttempt(result)) recordScanFailure(descriptor.outputRoot, now());
    out(JSON.stringify({ status: result.timedOut ? "deadline" : "done", code: result.code }));
    return result.code ?? EXIT.failed;
  }

  // The watcher keeps going while the descriptor still names this installation at the revision it started with.
  const stillOwned = () => {
    const again = loadDescriptor(args.descriptor, { create: false });
    return again.ok && again.value.installationId === descriptor.installationId && again.value.scheduleRevision === descriptor.scheduleRevision;
  };
  let retire = () => {};
  const retired = new Promise<void>(resolve => { retire = resolve; });
  const supervisor = new WatchSupervisor({
    spec, installationId: descriptor.installationId, now, stillOwned, onRetire: () => retire(),
    onFailure: at => recordScanFailure(descriptor.outputRoot, at),
    ...(deps.spawnChild ? { spawnChild: deps.spawnChild } : {}),
    ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
  });
  supervisor.start();
  await Promise.race([(deps.untilStopped ?? stopSignal)(), retired]);
  await supervisor.stop();
  return EXIT.ok;
}

/** True when argv[1] names this module. A Cloud home runs the checker through the /opt/murage symlink, while node loads
 *  the module by its real path, so both sides are compared as real paths (as server/cloud-home/supervisor.ts does). */
export function invokedAsMain(argv1: string | undefined, moduleUrl: string = import.meta.url): boolean {
  if (typeof argv1 !== "string" || !argv1) return false;
  try { return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (invokedAsMain(process.argv[1])) {
  scrubEnvironment(process.env);
  void main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
