// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The stop target of one MCP server generation: its durable record (mcp-stop-records.ts), its platform proof (mcp-stop-proof.ts), and
// the platform kill. ChatMcpDescendants (chat-mcp-client.ts) drives it; mcp-stop-recovery.ts re-proves it after an UNKNOWN.
//   Cloud    kill = the stored scope's cgroup.kill, never a pid; proof = cloudProof on the stored unit and cgroup path.
//   Windows  kill = TerminateJobObject on the stored job name (stopWindowsJob), never a pid; proof = windowsProof.
//   Desktop  kill = per-pair signals through a verified handle (never a process group); proof = desktopProof after a completed capture.
import { readFile, readdir, writeFile } from "node:fs/promises";
import type { HelperRequest, HelperRunner, WarmHelper } from "./mcp-stop-helper.ts";
import { loadExclusionAddon, requireWindowsAddon } from "../engine-exclusion.ts";
import { stopWindowsJob } from "../memory/pip-job.ts";
import { realEnvironment } from "../cloud-home/cloud-process-hooks.ts";
import { procBootId, procPidNs, procTable, procVisibilityFacts } from "./process-tree.ts";
import {
  cloudProof, desktopCapture, desktopCaptureMany, desktopProof, type DesktopCaptured, type DesktopProofResult, signalPair, windowsProof,
  type CloudProofEnv, type DesktopEnv, type DesktopRow, type StartKind, type JobQuery, type Pair, type SignalEnv, type StopRecord, type StopState,
  type WindowsContainment, type WindowsProofEnv,
} from "./mcp-stop-proof.ts";
import type { ProbeOutcome } from "./mcp-stop-recovery.ts";
import type { StopRecordStore } from "./mcp-stop-records.ts";

// ------------------------------------------------------------------------------------------------------------ real environments

export const realCloudProofEnv = (signal?: AbortSignal): CloudProofEnv => ({
  readText: (path) => readFile(path, "utf8"),
  listDirs: async (path) => (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  systemctlShow: (unit) => realEnvironment.systemctlShow(unit),
  now: () => Date.now(),
  ...(signal ? { signal } : {}),
});

/** Windows: the job opened by name WITHOUT terminating it. `jobQuery` is a new addon call (native/engine-exclusion/exclusion.c). An addon
 *  without it answers `error`, which is UNKNOWN: a build that cannot query never claims a stop. */
export const realWindowsProofEnv = (): WindowsProofEnv => ({
  async queryJob(name): Promise<JobQuery> {
    try {
      const query = requireWindowsAddon().jobQuery;
      if (typeof query !== "function") return { kind: "error" };
      const answer = await query(name);
      if (answer.state === "absent") return { kind: "notFound" };
      if (answer.state === "present") return { kind: "opened", count: typeof answer.activeProcesses === "number" ? answer.activeProcesses : null };
      return { kind: "error" };
    } catch { return { kind: "error" }; }
  },
});

/** The live-queried containment facts of a job this process holds (jobInspect: QueryInformationJobObject + GetHandleInformation). */
export function inspectJobContainment(job: unknown, now: () => number = Date.now): WindowsContainment | null {
  try {
    const inspect = requireWindowsAddon().jobInspect;
    if (typeof inspect !== "function") return null;
    const facts = inspect(job as never);
    return { source: "live-query", killOnClose: facts.killOnClose === true, breakawayClear: facts.breakawayOk === false, silentBreakawayClear: facts.silentBreakawayOk === false, inheritable: facts.handleInheritable !== false, queriedAt: now(), contained: false };
  } catch { return null; }
}

const rowFromProc = (row: { pid: number; ppid: number; start: string; state: string; threads: number }): DesktopRow => ({ ...row, startKind: "proc" });
export function realDesktopEnv(platform: "linux" | "darwin", rootPid: number | null, signal?: AbortSignal): DesktopEnv {
  if (platform === "linux") {
    return {
      platform,
      bootId: async () => procBootId(),
      pidns: async () => procPidNs(),
      visibility: async () => procVisibilityFacts(rootPid),
      table: async (abort) => (await procTable("/proc", undefined, abort ?? signal))?.map(rowFromProc) ?? null,
      ...(signal ? { signal } : {}),
    };
  }
  return {
    platform,
    bootId: async () => loadExclusionAddon()?.bootId?.() ?? null,
    pidns: async () => null,
    visibility: async () => ({ hidepid: false, sameNs: true }),
    // libproc start time (seconds with microseconds) from the addon; a row whose start could not be read is only an lstart-grade identity
    table: async (abort) => {
      if ((abort ?? signal)?.aborted) return null;
      const addon = loadExclusionAddon();
      if (!addon) return null;
      try {
        return addon.processes().map((row): DesktopRow => ({ pid: row.pid, ppid: row.ppid, start: `libproc:${row.start.toFixed(6)}`, startKind: row.start > 0 ? "libproc" : "lstart", state: "R", threads: null }));
      } catch { return null; }
    },
    ...(signal ? { signal } : {}),
  };
}

/** The identity read for one pid, off the server's loop: Linux reads the one stat file asynchronously; macOS asks the helper (the native
 *  listing never runs in the server). null = cannot be read (lstart-grade or unreadable), "absent" = the pid is gone. */
export function realSignalEnv(platform: "linux" | "darwin", residual: (event: string) => void = (event) => console.warn(`[chat-mcp] ${event}`), helper?: HelperRunner): SignalEnv {
  return {
    platform,
    // no native pidfd binding ships on this platform today: the documented check-then-signal window (U3) is the only path
    identity: async (pid) => {
      if (platform === "linux") {
        try {
          const text = await readFile(`/proc/${pid}/stat`, "utf8");
          const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
          return /^\d+$/.test(rest[19] ?? "") ? { start: `proc:${rest[19]}`, kind: "proc" as const } : null;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return code === "ENOENT" || code === "ESRCH" ? "absent" as const : null;
        }
      }
      const answer = await helper?.({ op: "identity", platform, pid }).catch(() => null) as { identity: { start: string; kind: StartKind } | "absent" | null } | null | undefined;
      return answer ? answer.identity : null;
    },
    kill: (pid, signal) => { process.kill(pid, signal); },
    residual,
  };
}

/** Cloud: cgroup.kill on the stored scope (the scope's cgroup is delegated to the server). Never signals a pid. */
export async function cloudKillScope(cgroupPath: string): Promise<void> { await writeFile(`${cgroupPath}/cgroup.kill`, "1"); }

// ---------------------------------------------------------------------------------------------------------------- stop targets

export interface StopTarget {
  readonly record: StopRecord;
  /** U1: remember the server's current descendants (appended to the persisted union). Never blocks a call. */
  track(signal?: AbortSignal): Promise<void>;
  /** R2: the pre-stop capture, then STOPPING. false = the capture is UNKNOWN (it stays UNKNOWN after the kill). */
  capture(signal?: AbortSignal): Promise<boolean>;
  /** One proof now (the live stop's own, in process). */
  prove(signal?: AbortSignal): Promise<ProbeOutcome>;
  kill(signal: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export interface TargetDeps {
  store?: StopRecordStore | null;
  cloudEnv?: (signal?: AbortSignal) => CloudProofEnv;
  windowsEnv?: () => WindowsProofEnv;
  desktopEnv?: (platform: "linux" | "darwin", root: number | null, signal?: AbortSignal) => DesktopEnv;
  signalEnv?: (platform: "linux" | "darwin") => SignalEnv;
  /** The server's only way to enumerate processes (mcp-stop-helper.ts): a helper child, killed at its cap. Absent = unknown, never a sync read. */
  helper?: HelperRunner;
  /** R8-C: how a relay gets its warm capture helper (mcp-stop-runtime.ts startRelayWarmHelper); null = none, spawn on demand. */
  warmHelper?: (() => WarmHelper) | null;
  /** True inside the helper child itself, where the direct (synchronous) enumeration is the point and the child is what gets killed. */
  direct?: boolean;
  cloudKill?: (cgroupPath: string) => Promise<void>;
  windowsKill?: (jobName: string) => Promise<boolean>;
}

class Held {
  record: StopRecord;
  readonly store: StopRecordStore | null;
  constructor(record: StopRecord, store: StopRecordStore | null | undefined) { this.record = record; this.store = store ?? null; }
  save(next: StopRecord): void { this.record = next; this.store?.save(next); }
  advance(to: StopState): void {
    if (this.store) this.record = this.store.advance(this.record, to); else this.record = { ...this.record, state: to };
  }
}

const unionPairs = (known: Pair[], seen: Pair[]): Pair[] => {
  const out = new Map(known.map((pair) => [`${pair.pid}:${pair.start}`, pair]));
  for (const pair of seen) if (!out.has(`${pair.pid}:${pair.start}`)) out.set(`${pair.pid}:${pair.start}`, pair);
  return [...out.values()];
};

export class DesktopStopTarget implements StopTarget {
  readonly #held: Held;
  readonly #deps: TargetDeps;
  readonly #platform: "linux" | "darwin";
  readonly #root: number;
  constructor(record: StopRecord, root: number, platform: "linux" | "darwin", deps: TargetDeps = {}) {
    this.#held = new Held(record, deps.store); this.#deps = deps; this.#platform = platform; this.#root = root;
  }
  get record(): StopRecord { return this.#held.record; }
  /** An injected or direct environment (tests; the helper child). null on the server: it enumerates only through the helper. */
  #localEnv(signal?: AbortSignal): DesktopEnv | null {
    if (this.#deps.desktopEnv) return this.#deps.desktopEnv(this.#platform, this.#root, signal);
    return this.#deps.direct ? realDesktopEnv(this.#platform, this.#root, signal) : null;
  }

  /** One capture plus the final table (for the REPARENTED flags), bounded: in the helper child on the server, never in this process. */
  async #capture(signal?: AbortSignal): Promise<{ found: Awaited<ReturnType<typeof desktopCapture>>; rows: DesktopRow[] | null } | null> {
    const env = this.#localEnv(signal);
    if (env) {
      const found = await desktopCapture(this.#root, env).catch(() => null);
      return { found, rows: found ? await env.table().catch(() => null) : null };
    }
    const answer = await this.#deps.helper?.({ op: "capture", platform: this.#platform, rootPid: this.#root }, signal).catch(() => null) as { found: Awaited<ReturnType<typeof desktopCapture>>; rows: DesktopRow[] | null } | null | undefined;
    return answer && typeof answer === "object" && "found" in answer ? answer : null;
  }

  async track(signal?: AbortSignal): Promise<void> {
    const captured = await this.#capture(signal);
    const found = captured?.found;
    if (!captured || !found) return;
    const current = this.#held.record;
    const d = current.desktop ?? { pairs: [], captureCompleted: false };
    const pairs = unionPairs(d.pairs, found.pairs);
    // a remembered pair that is still itself but whose parent is outside the union was reparented: flagged, kept until a re-stat proves it gone
    const union = new Set(pairs.map((pair) => pair.pid));
    const byPid = new Map((captured.rows ?? []).map((row) => [row.pid, row]));
    const root = d.rootPair ?? found.root;
    const flagged = pairs.map((pair) => {
      const row = byPid.get(pair.pid);
      const isRoot = pair.pid === root.pid && pair.start === root.start;
      return !pair.reparented && !isRoot && row && row.start === pair.start && !union.has(row.ppid) ? { ...pair, reparented: true } : pair;
    });
    this.#held.save({ ...current, desktop: { ...d, pairs: flagged, rootPair: root, context: d.context ?? found.context, captureCompleted: d.captureCompleted } });
  }

  async capture(signal?: AbortSignal): Promise<boolean> {
    return this.applyCapture((await this.#capture(signal))?.found ?? null);
  }

  /** The helper this target's pre-stop capture would run in, or null when it captures locally (tests, the helper child itself): only a
   *  helper capture can join a relay's shared captureMany (captureTargets). */
  get sharedCapture(): { helper: HelperRunner; platform: "linux" | "darwin"; rootPid: number } | null {
    if (this.#deps.desktopEnv || this.#deps.direct || !this.#deps.helper) return null;
    return { helper: this.#deps.helper, platform: this.#platform, rootPid: this.#root };
  }

  /** R2: persist one pre-stop capture answer, then STOPPING. null (unknown) leaves the capture incomplete for good. */
  applyCapture(found: DesktopCaptured | null): boolean {
    const current = this.#held.record;
    const d = current.desktop ?? { pairs: [], captureCompleted: false };
    if (!found) { this.#held.save({ ...current, desktop: { ...d, captureCompleted: false } }); this.#held.advance("STOPPING"); return false; }
    this.#held.save({ ...current, desktop: { pairs: unionPairs(d.pairs, found.pairs), rootPair: d.rootPair ?? found.root, context: found.context, captureCompleted: true } });
    this.#held.advance("STOPPING");
    return true;
  }

  async prove(signal?: AbortSignal): Promise<ProbeOutcome> {
    const env = this.#localEnv(signal);
    let result: DesktopProofResult;
    if (env) result = await desktopProof(this.#held.record, env);
    else return this.applyProof(await this.#deps.helper?.({ op: "desktopProof", record: this.#held.record }, signal).catch(() => null));
    return this.#persistProof(result);
  }

  /** The helper this target's post-kill proof would run in, or null when it proves locally: only a helper proof can join a ProofBatch. */
  get sharedProof(): HelperRunner | null {
    if (this.#deps.desktopEnv || this.#deps.direct || !this.#deps.helper) return null;
    return this.#deps.helper;
  }

  /** One helper's proof answer for this target: anything that is not a proof result is unknown, never gone. */
  applyProof(answer: unknown): ProbeOutcome {
    if (!answer || typeof answer !== "object" || !("verdict" in answer)) return { v: "unknown", why: "the proof helper gave no answer" };
    return this.#persistProof(answer as DesktopProofResult);
  }

  #persistProof(result: DesktopProofResult): ProbeOutcome {
    // U1: a descendant first seen by a post-kill pass joins the persisted union at once, so a later reparent cannot lose it.
    if (result.discovered?.length && this.#held.record.desktop) {
      const d = this.#held.record.desktop;
      this.#held.save({ ...this.#held.record, desktop: { ...d, pairs: unionPairs(d.pairs, result.discovered) } });
    }
    if (result.reparented.length) {
      const flagged = new Set(result.reparented.map((pair) => `${pair.pid}:${pair.start}`));
      const d = this.#held.record.desktop!;
      this.#held.save({ ...this.#held.record, desktop: { ...d, pairs: d.pairs.map((pair) => flagged.has(`${pair.pid}:${pair.start}`) ? { ...pair, reparented: true } : pair) } });
    }
    return { ...result.verdict, ...(result.reparented.length ? { reparented: result.reparented } : {}) };
  }

  async kill(signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    const env = (this.#deps.signalEnv ?? ((platform) => realSignalEnv(platform, undefined, this.#deps.helper)))(this.#platform);
    const d = this.#held.record.desktop;
    if (!d) return;
    for (const pair of d.pairs) await signalPair(pair, signal, env);
  }
}

/** The pre-stop captures of one relay stop (R8 as amended 2026-11-17: one request per relay stop, not one per helper child). Desktop targets
 *  that capture through the same helper share ONE helper child and one enumeration (captureMany); every other target captures alone. The
 *  proof strength is each target's own: the shared helper is still killed at the caller's abort, and a missing, short or malformed answer
 *  is unknown (false) for every root it should have covered, never a smaller answer. One answer per target, in order. */
export async function captureTargets(targets: readonly StopTarget[], signal?: AbortSignal, warm?: WarmHelper | null): Promise<boolean[]> {
  const groups = new Map<HelperRunner, Map<"linux" | "darwin", number[]>>();
  const shared = targets.map((target) => target instanceof DesktopStopTarget ? target.sharedCapture : null);
  shared.forEach((entry, i) => {
    if (!entry) return;
    const byPlatform = groups.get(entry.helper) ?? groups.set(entry.helper, new Map()).get(entry.helper)!;
    (byPlatform.get(entry.platform) ?? byPlatform.set(entry.platform, []).get(entry.platform)!).push(i);
  });
  const out: Array<Promise<boolean>> = targets.map((target, i) => shared[i] ? Promise.resolve(false) : target.capture(signal).catch(() => false));
  // R8-C (C1/C3): the relay's warm helper answers the whole capture when it is ready (no spawn on the stop path); otherwise each group
  // spawns its on-demand helper exactly as before, under the same cap, failing closed the same way
  const viaWarm = warm?.ready ? warm.run : null;
  for (const [helper, byPlatform] of groups) {
    for (const [platform, indexes] of byPlatform) {
      // a lone root keeps its own "capture" request: the same one helper child, the same answer
      if (indexes.length === 1 && !viaWarm) { out[indexes[0]!] = targets[indexes[0]!]!.capture(signal).catch(() => false); continue; }
      const answer = (viaWarm ?? helper)({ op: "captureMany", platform, rootPids: indexes.map((i) => shared[i]!.rootPid) }, signal).catch(() => null)
        .then((value) => {
          const found = value && typeof value === "object" && "found" in value ? (value as { found: unknown }).found : null;
          if (!Array.isArray(found) || found.length !== indexes.length) return null;
          return found.map((one: unknown) => one && typeof one === "object" && "root" in one && Array.isArray((one as DesktopCaptured).pairs) ? one as DesktopCaptured : null);
        });
      indexes.forEach((i, k) => { out[i] = answer.then((found) => (targets[i] as DesktopStopTarget).applyCapture(found?.[k] ?? null)); });
    }
  }
  return Promise.all(out);
}

/** The post-kill proofs of one relay stop (R8 amendment B2, like captureTargets): desktop targets proving through the same helper share
 *  ONE helper child per round (proveMany), and one round runs at a time; a proof asked while a round runs joins the next one. Each proof
 *  window stays the caller's own: its signal ends its wait as unknown at its own cap, and the shared helper is killed once every proof it
 *  carries was aborted. A missing, short or malformed answer is unknown for every target it should have covered. */
export class ProofBatch {
  #pending: Array<{ target: DesktopStopTarget; helper: HelperRunner; signal?: AbortSignal; resolve: (outcome: ProbeOutcome) => void }> = [];
  #running = false;

  prove(target: StopTarget, signal?: AbortSignal): Promise<ProbeOutcome> {
    const helper = target instanceof DesktopStopTarget ? target.sharedProof : null;
    if (!helper) return target.prove(signal);
    return new Promise<ProbeOutcome>((resolve) => {
      this.#pending.push({ target: target as DesktopStopTarget, helper, signal, resolve });
      if (!this.#running) { this.#running = true; setTimeout(() => { void this.#round(); }, 0); }
    });
  }

  async #round(): Promise<void> {
    const taken = this.#pending.splice(0).filter((entry) => {
      if (!entry.signal?.aborted) return true;
      entry.resolve({ v: "unknown", why: "the proof passed its cap" });
      return false;
    });
    const groups = new Map<HelperRunner, typeof taken>();
    for (const entry of taken) (groups.get(entry.helper) ?? groups.set(entry.helper, []).get(entry.helper)!).push(entry);
    await Promise.all([...groups].map(async ([helper, entries]) => {
      // a lone proof keeps its own "desktopProof" request: the same one helper child, the same answer
      if (entries.length === 1) { const [one] = entries; one!.resolve(await one!.target.prove(one!.signal).catch((): ProbeOutcome => ({ v: "unknown", why: "the proof threw" }))); return; }
      const controller = new AbortController();
      let open = entries.length;
      for (const entry of entries) entry.signal?.addEventListener("abort", () => { if (--open === 0) controller.abort(); }, { once: true });
      const value = await helper({ op: "proveMany", records: entries.map((entry) => entry.target.record) }, controller.signal).catch(() => null);
      const answers = value && typeof value === "object" && "answers" in value ? (value as { answers: unknown }).answers : null;
      const complete = Array.isArray(answers) && answers.length === entries.length;
      for (const [k, entry] of entries.entries()) {
        try { entry.resolve(entry.target.applyProof(complete ? answers[k] : null)); } catch { entry.resolve({ v: "unknown", why: "the proof helper gave no answer" }); }
      }
    }));
    if (this.#pending.length) await this.#round();
    else this.#running = false;
  }
}

export class CloudStopTarget implements StopTarget {
  readonly #held: Held;
  readonly #deps: TargetDeps;
  constructor(record: StopRecord, deps: TargetDeps = {}) { this.#held = new Held(record, deps.store); this.#deps = deps; }
  get record(): StopRecord { return this.#held.record; }
  async track(): Promise<void> { /* the cgroup is the containment: nothing to remember */ }
  async capture(): Promise<boolean> { this.#held.advance("STOPPING"); return true; }
  prove(signal?: AbortSignal): Promise<ProbeOutcome> { return cloudProof(this.#held.record, (this.#deps.cloudEnv ?? realCloudProofEnv)(signal)); }
  async kill(signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    const stored = this.#held.record.cloud;
    if (stored && signal === "SIGKILL") await (this.#deps.cloudKill ?? cloudKillScope)(stored.cgroupPath);
  }
}

export class WindowsStopTarget implements StopTarget {
  readonly #held: Held;
  readonly #deps: TargetDeps;
  constructor(record: StopRecord, deps: TargetDeps = {}) { this.#held = new Held(record, deps.store); this.#deps = deps; }
  get record(): StopRecord { return this.#held.record; }
  async track(): Promise<void> { /* the job is the containment: nothing to remember */ }
  async capture(): Promise<boolean> { this.#held.advance("STOPPING"); return true; }
  prove(): Promise<ProbeOutcome> { return windowsProof(this.#held.record, (this.#deps.windowsEnv ?? realWindowsProofEnv)()); }
  async kill(signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    const stored = this.#held.record.windows;
    if (stored && signal === "SIGKILL") await (this.#deps.windowsKill ?? ((name) => stopWindowsJob(name)))(stored.jobName);
  }
}

/** The platform kill from a stored record alone (the recovery path after a restart, when no live target exists). */
export async function killByRecord(record: StopRecord, deps: TargetDeps = {}): Promise<void> {
  if (record.platform === "cloud") return new CloudStopTarget(record, { ...deps, store: null }).kill("SIGKILL");
  if (record.platform === "windows") return new WindowsStopTarget(record, { ...deps, store: null }).kill("SIGKILL");
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  return new DesktopStopTarget(record, record.desktop?.rootPair?.pid ?? 0, platform, { ...deps, store: null }).kill("SIGKILL");
}

/** One proof from a stored record alone (what a probe helper runs). */
export async function proveByRecord(record: StopRecord, deps: TargetDeps = {}, signal?: AbortSignal): Promise<ProbeOutcome> {
  if (record.platform === "cloud") return new CloudStopTarget(record, { ...deps, store: null }).prove(signal);
  if (record.platform === "windows") return new WindowsStopTarget(record, { ...deps, store: null }).prove();
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  return new DesktopStopTarget(record, record.desktop?.rootPair?.pid ?? 0, platform, { ...deps, store: null, direct: true }).prove(signal);
}

/** What the helper child runs (drivers/mcp-stop-probe.ts). Direct, synchronous-capable enumeration is allowed HERE because this is the
 *  process that gets SIGKILL at the cap; the server never calls this. A bare StopRecord (no `op`) is a "prove". */
export async function runHelperRequest(input: unknown): Promise<unknown> {
  const request = (input && typeof input === "object" && "op" in input ? input : { op: "prove", record: input }) as HelperRequest;
  if (request.op === "prove") return proveByRecord(request.record as StopRecord);
  if (request.op === "desktopProof") {
    const record = request.record as StopRecord;
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    return desktopProof(record, realDesktopEnv(platform, record.desktop?.rootPair?.pid ?? null));
  }
  if (request.op === "proveMany") {
    const records = (Array.isArray(request.records) ? request.records : []) as StopRecord[];
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    return { answers: await Promise.all(records.map((record) => desktopProof(record, realDesktopEnv(platform, record.desktop?.rootPair?.pid ?? null)).catch(() => null))) };
  }
  if (request.op === "capture") {
    const env = realDesktopEnv(request.platform, request.rootPid);
    const found = await desktopCapture(request.rootPid, env).catch(() => null);
    return { found, rows: found ? await env.table().catch(() => null) : null };
  }
  if (request.op === "captureMany") {
    const rootPids = Array.isArray(request.rootPids) ? request.rootPids : [];
    const found = await desktopCaptureMany(rootPids, realDesktopEnv(request.platform, null), (rootPid) => realDesktopEnv(request.platform, rootPid).visibility())
      .catch(() => rootPids.map(() => null));
    return { found };
  }
  if (request.op === "identity") {
    if (request.platform === "linux") return { identity: null };
    const row = loadExclusionAddon()?.processes().find((candidate) => candidate.pid === request.pid);
    return { identity: row ? (row.start > 0 ? { start: `libproc:${row.start.toFixed(6)}`, kind: "libproc" } : null) : "absent" };
  }
  return { v: "unknown", why: "unknown helper request" };
}
