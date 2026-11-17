// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The process-wide pieces of the MCP stop proof: the durable record store, the bounded recovery, the spawn lifecycle that writes a
// record BEFORE a server starts, and the startup reconciliation that quarantines every undeleted record BEFORE any turn is admitted.
import { randomBytes } from "node:crypto";
import { MCP_CLOUD_UNAVAILABLE_TEXT } from "../turn-end.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { withHideInherit } from "../../shared/win-hide-child-process.mjs";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { loadExclusionAddon } from "../engine-exclusion.ts";
import { procBootId } from "./process-tree.ts";
import { engineJob, type EngineSpawnJob } from "../procs.ts";
import { MCP_SCOPE_UNIT_PATTERN, type StopPlatform, type StopRecord, type WindowsContainment, type Pair, type DesktopContext } from "./mcp-stop-proof.ts";
import { McpStopRecovery, realRecoveryClock, type ProbeHandle, type ProbeOutcome, type RecoveryDeps } from "./mcp-stop-recovery.ts";
import { WarmHelper, makeHelperRunner, type HelperRunner } from "./mcp-stop-helper.ts";
import { StopRecordStore, ownerOfRecordFile } from "./mcp-stop-records.ts";
import {
  CloudStopTarget, DesktopStopTarget, WindowsStopTarget, inspectJobContainment, killByRecord, type StopTarget, type TargetDeps,
} from "./mcp-stop-target.ts";

export const CLOUD_MCP_SLICE_PATH = "murage.slice/murage-turns.slice";

interface RuntimeState {
  store: StopRecordStore | null;
  recovery: McpStopRecovery | null;
  targetDeps: TargetDeps;
  recoveryDeps: Partial<RecoveryDeps>;
  health: (item: { owner: string; reason: string; day: number }) => void;
  ownerHeld: (owner: string, key: string) => void;
  ownerReleased: (owner: string, key: string) => void;
  generation: number;
}
const state: RuntimeState = {
  store: null, recovery: null, targetDeps: {}, recoveryDeps: {},
  health: (item) => console.warn(`[mcp-stop] health: bot ${item.owner} ${item.reason}`),
  ownerHeld: () => {}, ownerReleased: () => {}, generation: 0,
};

/** Wires the runtime. The server calls this once at startup with its data dir; tests pass their own pieces. */
export function configureMcpStop(options: { dir?: string; store?: StopRecordStore | null; targetDeps?: TargetDeps; recoveryDeps?: Partial<RecoveryDeps>;
  health?: RuntimeState["health"]; ownerHeld?: RuntimeState["ownerHeld"]; ownerReleased?: RuntimeState["ownerReleased"] } = {}): void {
  state.store = options.store !== undefined ? options.store : options.dir ? new StopRecordStore(options.dir) : state.store;
  if (options.targetDeps) state.targetDeps = options.targetDeps;
  if (options.recoveryDeps) state.recoveryDeps = options.recoveryDeps;
  if (options.health) state.health = options.health;
  if (options.ownerHeld) state.ownerHeld = options.ownerHeld;
  if (options.ownerReleased) state.ownerReleased = options.ownerReleased;
  state.recovery = null;
}
export function resetMcpStopForTests(): void {
  state.store = null; state.recovery = null; state.targetDeps = {}; state.recoveryDeps = {}; state.generation = 0;
  state.health = (item) => console.warn(`[mcp-stop] health: bot ${item.owner} ${item.reason}`);
  state.ownerHeld = () => {}; state.ownerReleased = () => {};
}
export const mcpStopStore = (): StopRecordStore | null => state.store;
let defaultHelper: HelperRunner | null = null;
/** The server's only enumeration path (nlrace finding 4): a helper child per request, killed at its cap. */
const serverHelper = (): HelperRunner => defaultHelper ??= makeHelperRunner({ script: SPAWNED_PROXIES.mcpStopProbe });
/** R8-C (C1): a new warm capture helper for one relay, started now. Tests inject theirs (targetDeps.warmHelper); a test that injects only
 *  a spawn-per-request helper gets none, and a relay without one spawns on demand exactly as before. */
export function startRelayWarmHelper(): WarmHelper | null {
  const factory = state.targetDeps.warmHelper;
  const warm = factory !== undefined ? factory?.() ?? null : state.targetDeps.helper ? null : new WarmHelper({ script: SPAWNED_PROXIES.mcpStopProbe });
  warm?.start();
  return warm;
}
export const mcpStopTargetDeps = (): TargetDeps => ({ helper: serverHelper(), ...state.targetDeps, store: state.store });

/** A probe attempt as its own helper child process (V4): it reads the record on stdin, runs the platform proof, writes one JSON verdict. */
export function launchProbeHelper(record: StopRecord, signal: AbortSignal): ProbeHandle {
  let child: ChildProcess | undefined;
  let exitedResolve!: () => void;
  const exited = new Promise<void>((resolve) => { exitedResolve = resolve; });
  const result = new Promise<ProbeOutcome>((resolve) => {
    try {
      child = spawn(process.execPath, ["--experimental-strip-types", SPAWNED_PROXIES.mcpStopProbe],
        withHideInherit({ stdio: ["pipe", "pipe", "ignore"], env: { ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH ?? "" }, signal }));
    } catch { exitedResolve(); resolve({ v: "unknown", why: "the probe helper could not start" }); return; }
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => { if (out.length < 65_536) out += chunk.toString("utf8"); });
    child.once("error", () => { resolve({ v: "unknown", why: "the probe helper failed" }); });
    child.once("close", () => {
      exitedResolve();
      try { const parsed = JSON.parse(out.trim()) as ProbeOutcome; resolve(parsed && ["gone", "alive", "unknown"].includes(parsed.v) ? parsed : { v: "unknown", why: "the probe helper answered nothing usable" }); }
      catch { resolve({ v: "unknown", why: "the probe helper answered nothing usable" }); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(record));
  });
  return {
    result,
    kill: () => { try { child?.kill("SIGKILL"); } catch { /* already gone */ } },
    alive: () => child !== undefined && child.exitCode === null && child.signalCode === null,
    exited,
  };
}

export function mcpStopRecovery(): McpStopRecovery {
  return state.recovery ??= new McpStopRecovery({
    clock: realRecoveryClock,
    launch: launchProbeHelper,
    reKill: (record) => killByRecord(record, mcpStopTargetDeps()),
    save: (record) => state.store?.save(record),
    release: (record) => { state.store?.delete(record); state.ownerReleased(record.owner, `${record.owner}\0${record.generation}`); },
    health: (item) => state.health(item),
    log: (line) => console.warn(`[mcp-stop] ${line}`),
    ...state.recoveryDeps,
  });
}

/** Hands an unproven stop to the bounded recovery. Resolves when (and only when) a probe proves it gone. */
export function enrollUnprovenStop(record: StopRecord, options: { immediate?: boolean } = {}): Promise<void> {
  state.ownerHeld(record.owner, `${record.owner}\0${record.generation}`);
  return mcpStopRecovery().enroll(record, options);
}

/** Startup reconciliation, BEFORE any turn is admitted: every undeleted record puts its bot in quarantine (synchronously) and then runs the
 *  platform proof at once. Returns the owners quarantined and every record file that could not be read (never deleted). */
export function reconcileMcpStopRecords(): { owners: string[]; corrupt: string[]; settled: Promise<void> } {
  if (!state.store) return { owners: [], corrupt: [], settled: Promise.resolve() };
  const { records, corrupt } = state.store.list();
  // A record file that cannot be read or parsed still names its owner: that bot is quarantined at startup (fail closed) and the file is never
  // deleted by this code, so the hold stays until the file is dealt with by hand. A name that is not one of ours holds nobody.
  for (const name of corrupt) {
    const owner = ownerOfRecordFile(name);
    if (owner === null) { console.warn(`[mcp-stop] ignoring ${name}: not a stop record file name`); continue; }
    state.ownerHeld(owner, `${owner}\0corrupt\0${name}`);
    console.warn(`[mcp-stop] the stop record ${name} cannot be read; its bot stays quarantined until the file is resolved`);
  }
  const settled = Promise.all(records.map((record) => enrollUnprovenStop(record, { immediate: true }))).then(() => undefined);
  return { owners: [...new Set(records.map((record) => record.owner))], corrupt, settled };
}

// ------------------------------------------------------------------------------------------------------------------- lifecycle

export interface PlanInput {
  owner: string;
  platform: StopPlatform;
  /** Windows: the job name the spawn will create (chosen and stored before the spawn). */
  jobName?: string;
  /** Cloud: the scope unit and the cgroup path chosen before the spawn. */
  cloud?: { unit: string; cgroupPath: string };
  bootId?: string;
}

/** This machine's boot id, read once (a few bytes at spawn planning, never on the stop path). Linux boot_id; macOS bootsessionuuid. */
let cachedBootId: string | null | undefined;
function ownBootId(): string | null {
  if (cachedBootId !== undefined) return cachedBootId;
  try { cachedBootId = process.platform === "darwin" ? loadExclusionAddon()?.bootId?.() ?? null : procBootId(); } catch { cachedBootId = null; }
  return cachedBootId;
}
export const newMcpScopeUnit = (): string => `murage-mcp-${randomBytes(8).toString("hex")}.scope`;
export function planCloudScope(cgroupRoot = "/sys/fs/cgroup"): { unit: string; cgroupPath: string } {
  const unit = newMcpScopeUnit();
  if (!MCP_SCOPE_UNIT_PATTERN.test(unit)) throw new Error("MCP_SCOPE_UNIT_INVALID");
  return { unit, cgroupPath: `${cgroupRoot}/${CLOUD_MCP_SLICE_PATH}/${unit}` };
}

/** One server generation's record, from PLANNED (before anything exists) through SPAWNING (durable before exec) to RUNNING. */
export class McpStopLifecycle {
  #record: StopRecord;
  readonly #store: StopRecordStore | null;
  #target: StopTarget | null = null;
  private constructor(record: StopRecord, store: StopRecordStore | null) { this.#record = record; this.#store = store; }

  /** PLANNED: written durably BEFORE the spawn. */
  static plan(input: PlanInput, deps: { store?: StopRecordStore | null } = {}): McpStopLifecycle {
    const store = deps.store === undefined ? state.store : deps.store;
    const generation = Date.now() * 1000 + (state.generation++ % 1000);
    const record: StopRecord = {
      version: 1, owner: input.owner, generation, platform: input.platform, state: "PLANNED",
      ...(input.platform === "cloud" && input.cloud ? { cloud: { ...input.cloud, contained: false } } : {}),
      ...(input.platform === "windows" && input.jobName ? { windows: { jobName: input.jobName } } : {}),
      ...(input.platform === "desktop" ? { desktop: { pairs: [], captureCompleted: false } } : {}),
      ...(input.platform === "desktop" ? (() => { const bootId = input.bootId ?? ownBootId(); return bootId ? { bootId } : {}; })() : {}),
    };
    store?.plan(record);
    return new McpStopLifecycle(record, store);
  }
  get record(): StopRecord { return this.#record; }

  /** SPAWNING: the record is fsynced (file and directory) BEFORE exec. Throws when it could not be made durable (the spawn must not run). */
  spawning(): void { this.#record = this.#store ? this.#store.advance(this.#record, "SPAWNING") : { ...this.#record, state: "SPAWNING" }; }
  #save(next: StopRecord): void { this.#record = next; this.#store?.save(next); }
  /** Windows: the live-queried creation facts, fsynced after the job existed and before the child ran. */
  windowsCreated(containment: WindowsContainment): void {
    if (!this.#record.windows) return;
    this.#save({ ...this.#record, windows: { ...this.#record.windows, containment } });
  }
  /** Windows: set only after the process was put inside the job and before it is released. */
  windowsContained(): void {
    const w = this.#record.windows;
    if (!w?.containment) return;
    this.#save({ ...this.#record, windows: { ...w, containment: { ...w.containment, contained: true } } });
  }
  /** Cloud: the child was seen inside the stored scope. */
  cloudContained(): void {
    if (!this.#record.cloud) return;
    this.#save({ ...this.#record, cloud: { ...this.#record.cloud, contained: true } });
  }
  /** RUNNING: the server exists. Desktop records the root pair and the identity context before the first turn is served. */
  running(root: { pair?: Pair; context?: DesktopContext } = {}): void {
    let next = this.#store ? this.#store.advance(this.#record, "RUNNING") : { ...this.#record, state: "RUNNING" as const };
    if (next.desktop && root.pair) next = { ...next, desktop: { ...next.desktop, rootPair: root.pair, pairs: [root.pair], ...(root.context ? { context: root.context } : {}) } };
    this.#save(next);
  }
  /** The spawn failed before anything could run: the planned identity is proven by the platform rule (PLANNED only). */
  abandonedBeforeSpawn(): void { this.#store?.delete(this.#record); }

  /** The stop target (created once; ChatMcpDescendants drives it). */
  target(rootPid: number | undefined): StopTarget {
    if (this.#target) return this.#target;
    const deps = { ...mcpStopTargetDeps(), store: this.#store };
    const record = this.#record;
    this.#target = record.platform === "cloud" ? new CloudStopTarget(record, deps)
      : record.platform === "windows" ? new WindowsStopTarget(record, deps)
        : new DesktopStopTarget(record, rootPid ?? 0, process.platform === "darwin" ? "darwin" : "linux", deps);
    return this.#target;
  }
  /** After a clean proof: the record is deleted (only ever after PROVEN GONE). */
  provenGone(): void { this.#store?.delete(this.#record); }
}

// ----------------------------------------------------------------------------------------------------------------- spawn planning

/** What the owner reads when a launch is refused on Cloud: plain words; the code stays on `code` for logs. */
export { MCP_CLOUD_UNAVAILABLE_TEXT };
export class McpScopeUnavailableError extends Error {
  readonly code = "MCP_CLOUD_SCOPE_UNAVAILABLE";
  constructor() { super(MCP_CLOUD_UNAVAILABLE_TEXT); }
}
/** Cloud (A1): a server-owned MCP server runs in its OWN transient scope, created by the launcher that owns scope creation. Until that
 *  launcher mode is installed there is no scope to start one in, and the design fails closed: the server is not started (and the failure
 *  is reported), never started outside a scope. `spawn` returns the child only after it is inside the stored scope. */
export interface CloudMcpScopeLauncher {
  available(): boolean;
  spawn(scope: { unit: string; cgroupPath: string }, command: string, args: string[], env: Record<string, string>, cwd: string): ChildProcess;
}
let cloudScopeLauncher: CloudMcpScopeLauncher | null = null;
export function setCloudMcpScopeLauncher(launcher: CloudMcpScopeLauncher | null): void { cloudScopeLauncher = launcher; }
export const cloudMcpScopeLauncher = (): CloudMcpScopeLauncher | null => cloudScopeLauncher;

export interface McpSpawnPlan {
  life: McpStopLifecycle;
  /** The engine job for a Windows or POSIX spawn (carries the containment hooks on Windows); undefined on Cloud. */
  job: EngineSpawnJob | undefined;
  cloud?: { unit: string; cgroupPath: string };
}
export function planMcpSpawn(owner: string, options: { posixHostPower?: boolean; platform?: NodeJS.Platform; cloud?: boolean } = {}): McpSpawnPlan {
  const platform = options.platform ?? process.platform;
  const cloud = platform === "linux" && (options.cloud ?? process.env.MURAGE_CLOUD_ROLE === "home");
  if (cloud) {
    if (!cloudScopeLauncher?.available()) throw new McpScopeUnavailableError();
    const scope = planCloudScope();
    return { life: McpStopLifecycle.plan({ owner, platform: "cloud", cloud: scope }), job: undefined, cloud: scope };
  }
  const job = engineJob(options.posixHostPower === undefined ? {} : { posixHostPower: options.posixHostPower });
  if (platform === "win32") {
    if (!job?.name) throw new Error("ECONTAIN");
    const life = McpStopLifecycle.plan({ owner, platform: "windows", jobName: job.name });
    const containment = {
      // A build that cannot inspect the job (no jobInspect, or an unreadable answer) still launches: the job (KILL_ON_JOB_CLOSE) exists either
      // way. It simply records no containment, so a later "job absent" after a restart is UNKNOWN (V3), never gone; a live count still proves.
      created: (handle: unknown) => { const facts = inspectJobContainment(handle); if (facts) life.windowsCreated(facts); else console.warn("[mcp-stop] the job's containment facts could not be read; the stop proof will not accept an absent job as gone"); },
      contained: () => life.windowsContained(),
    };
    return { life, job: { ...job, containment } as EngineSpawnJob };
  }
  return { life: McpStopLifecycle.plan({ owner, platform: "desktop" }), job };
}

/** Runs one planned spawn: SPAWNING is durable before `start` (the exec) runs; RUNNING (and Cloud's containment) after it returned a child. A
 *  spawn that throws leaves its SPAWNING record in place: the process may exist, so the stop is proven or quarantined, never forgotten. */
export function spawnPlanned(plan: McpSpawnPlan, start: (plan: McpSpawnPlan) => ChildProcess): ChildProcess {
  plan.life.spawning();
  const child = start(plan);
  if (plan.life.record.platform === "cloud") plan.life.cloudContained();
  plan.life.running();
  return child;
}
