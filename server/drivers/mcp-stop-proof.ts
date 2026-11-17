// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MCP server stop proof (nlrace design rev5, section V is the contract). "Proven gone" has exactly the sources below, per platform;
// everything else is UNKNOWN, and UNKNOWN keeps the bot quarantined (P1) and enters bounded recovery (P2, mcp-stop-recovery.ts).
//   Cloud    cloudProof     the STORED scope unit and cgroup path: recursive cgroup.procs read in full, plus a successful systemctl show.
//   Windows  windowsProof   the job opened by the STORED name: active count 0, or not-found under a live-queried containment record.
//   Desktop  desktopProof   a direct identity check of EVERY recorded (pid, start) pair on two agreeing table passes after the kill.
// Every function here is pure over an injected environment (the real one is in mcp-stop-env.ts), so each rule has a witness that runs
// on any host. Nothing here ever reads the empty result of a process-list walk as a verdict.

export type Verdict = { v: "gone" } | { v: "alive"; why: string } | { v: "unknown"; why: string };
export const GONE: Verdict = { v: "gone" };
export const unknown = (why: string): Verdict => ({ v: "unknown", why });
export const alive = (why: string): Verdict => ({ v: "alive", why });

export type StopState = "PLANNED" | "SPAWNING" | "RUNNING" | "STOPPING";
export type StopPlatform = "cloud" | "windows" | "desktop";
/** One observed process: the pid and its native start identity (Linux /proc starttime, macOS libproc start time). */
export interface Pair { pid: number; start: string; reparented?: boolean }
export interface DesktopContext {
  /** Linux /proc/sys/kernel/random/boot_id; macOS kern.bootsessionuuid. */
  bootId: string;
  /** The scanner's own pid namespace inode (Linux), recorded before the kill. */
  pidns: string | null;
  /** The visibility facts used: /proc mounted without hidepid, the root in the scanner's namespace. */
  visibility: { hidepid: boolean; sameNs: boolean };
}
/** What the Windows job was LIVE-QUERIED to hold after it existed and before the child ran (V3). A source citation never fills it. */
export interface WindowsContainment {
  source: "live-query";
  killOnClose: boolean;
  breakawayClear: boolean;
  silentBreakawayClear: boolean;
  inheritable: boolean;
  queriedAt: number;
  /** Set only after the process was put inside the job and before it was released to run. A failed assign leaves it false. */
  contained: boolean;
}
export interface StopRecord {
  version: 1;
  /** The quarantine owner key assertRelayAvailable uses (botId ?? threadId). */
  owner: string;
  generation: number;
  platform: StopPlatform;
  state: StopState;
  /** Desktop: the boot id when the record was PLANNED (finding 8). Early records have no desktop context yet; a different boot id still proves the
   *  machine rebooted, so a crash before any tracking resolves after a reboot (V2/T1). */
  bootId?: string;
  cloud?: { unit: string; cgroupPath: string; contained: boolean };
  windows?: { jobName: string; containment?: WindowsContainment; reconstructed?: boolean };
  desktop?: { pairs: Pair[]; rootPair?: Pair; context?: DesktopContext; captureCompleted: boolean };
}

const errCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

// ---------------------------------------------------------------------------------------------------------------- Cloud (V1)

export interface CloudProofBudget { maxDirs: number; maxDepth: number; ms: number }
export const CLOUD_PROOF_BUDGET: CloudProofBudget = { maxDirs: 256, maxDepth: 8, ms: 5_000 };
export interface CloudProofEnv {
  readText(path: string): Promise<string>;
  listDirs(path: string): Promise<string[]>;
  /** Output of `systemctl show -p ActiveState -p LoadState <unit>`; rejects when it cannot run or times out. */
  systemctlShow(unit: string): Promise<string>;
  now(): number;
  budget?: CloudProofBudget;
  signal?: AbortSignal;
}
const SCOPE_UNIT = /^murage-mcp-[0-9a-f]{16}\.scope$/u;
export const MCP_SCOPE_UNIT_PATTERN = SCOPE_UNIT;
/** A unit name this proof accepts: only one chosen and stored before the spawn (the planned name), never a reconstructed one. */
export const mcpScopeUnitValid = (unit: string): boolean => SCOPE_UNIT.test(unit);

type CloudWalk = { kind: "dirGone" } | { kind: "pids"; nonEmpty: boolean } | { kind: "unknown"; why: string };
/** Reads every cgroup.procs under the STORED scope path to completion (async, budgeted, aborts). A descendant that disappears, a
 *  short read or any other error is unknown; only ENOENT on the stored scope path itself is "directory gone". */
async function cloudWalk(base: string, env: CloudProofEnv): Promise<CloudWalk> {
  const budget = env.budget ?? CLOUD_PROOF_BUDGET;
  const began = env.now();
  let dirs = 0;
  let nonEmpty = false;
  const visit = async (dir: string, depth: number): Promise<string | "gone" | null> => {
    if (env.signal?.aborted) return "aborted";
    if (++dirs > budget.maxDirs || depth > budget.maxDepth || env.now() - began > budget.ms) return "budget exhausted";
    await new Promise<void>((resolve) => setImmediate(resolve));
    let text: string;
    try { text = await env.readText(`${dir}/cgroup.procs`); } catch (error) {
      if (errCode(error) === "ENOENT") return depth === 0 ? "gone" : "a descendant cgroup vanished during the read";
      return `cgroup.procs read failed (${errCode(error) ?? "error"})`;
    }
    if (text !== "" && !text.endsWith("\n")) return "short read of cgroup.procs";
    for (const token of text.split("\n")) {
      if (token === "") continue;
      if (!/^[1-9][0-9]{0,9}$/u.test(token)) return "malformed cgroup.procs";
      nonEmpty = true;
    }
    let children: string[];
    try { children = await env.listDirs(dir); } catch (error) { return `cgroup directory listing failed (${errCode(error) ?? "error"})`; }
    for (const child of [...children].sort()) {
      const stop = await visit(`${dir}/${child}`, depth + 1);
      if (stop !== null) return stop;
    }
    return null;
  };
  const stop = await visit(base, 0);
  if (stop === "gone") return { kind: "dirGone" };
  if (stop !== null) return { kind: "unknown", why: stop };
  return { kind: "pids", nonEmpty };
}

function unitState(text: string): "inactive" | "active" {
  const rows = new Map(text.split("\n").map((line) => line.split(/=(.*)/su).slice(0, 2) as [string, string]));
  return ["inactive", "failed"].includes(rows.get("ActiveState") ?? "") || rows.get("LoadState") === "not-found" ? "inactive" : "active";
}

/** V1. The MCP Cloud proof: its own entry point, separate from confirmStopped and listTree. */
export async function cloudProof(record: StopRecord, env: CloudProofEnv): Promise<Verdict> {
  const stored = record.cloud;
  if (!stored || !mcpScopeUnitValid(stored.unit) || !stored.cgroupPath.endsWith(`/${stored.unit}`)) return unknown("no scope identity stored for this spawn");
  // PLANNED: nothing was started, so the planned identity must be absent from systemd and the cgroup tree.
  // SPAWNING or later without a containment record: unknown, even when the cgroup is empty or missing (V2).
  if (record.state !== "PLANNED" && !stored.contained) return unknown("spawn attempted without a containment record");
  let shown: string;
  try { shown = await env.systemctlShow(stored.unit); } catch { return unknown("systemctl show failed or timed out"); }
  if (!/^ActiveState=/mu.test(shown) && !/^LoadState=/mu.test(shown)) return unknown("systemctl show gave no unit state");
  const inactive = unitState(shown) === "inactive";
  const walk = await cloudWalk(stored.cgroupPath, env);
  if (walk.kind === "unknown") return unknown(walk.why);
  if (record.state === "PLANNED") return walk.kind === "dirGone" && inactive ? GONE : unknown("a planned scope exists");
  if (walk.kind === "pids" && walk.nonEmpty) return alive("the scope's cgroup still lists processes");
  return inactive ? GONE : unknown("the scope is empty but systemd still reports it active");
}

// -------------------------------------------------------------------------------------------------------------- Windows (V3)

export type JobQuery = { kind: "notFound" } | { kind: "opened"; count: number | null } | { kind: "error" };
export interface WindowsProofEnv { queryJob(name: string): Promise<JobQuery> }
const containmentComplete = (c: WindowsContainment | undefined): boolean =>
  !!c && c.source === "live-query" && c.queriedAt > 0 && c.contained && c.killOnClose && c.breakawayClear && c.silentBreakawayClear && !c.inheritable;

/** V3. The job is opened by the STORED name; the answer comes from the job, never from a process list. */
export async function windowsProof(record: StopRecord, env: WindowsProofEnv): Promise<Verdict> {
  const stored = record.windows;
  if (!stored) return unknown("no job identity stored for this spawn");
  let answer: JobQuery;
  try { answer = await env.queryJob(stored.jobName); } catch { return unknown("the job query failed"); }
  if (answer.kind === "error") return unknown("OpenJobObject failed for a reason other than not-found");
  if (answer.kind === "opened") {
    if (answer.count === null || !Number.isInteger(answer.count) || answer.count < 0) return unknown("the job opened but its process count is unreadable");
    if (answer.count > 0) return alive(`${answer.count} process(es) still in the job`);
    // count 0: a job whose spawn has begun but whose containment is not recorded may be empty only because nothing is in it yet.
    if (record.state === "SPAWNING" && !containmentComplete(stored.containment)) return unknown("empty job during a spawn that is not recorded contained");
    return GONE;
  }
  if (record.state === "PLANNED") return GONE; // spawn not attempted and the job does not exist
  if (stored.reconstructed) return unknown("not-found on a reconstructed job name");
  return containmentComplete(stored.containment) ? GONE : unknown("the job is absent but the creation record is not complete");
}

// ------------------------------------------------------------------------------------------------------------------ Desktop

export type StartKind = "proc" | "libproc" | "lstart";
export interface DesktopRow { pid: number; ppid: number; start: string; startKind: StartKind; state: string; threads: number | null }
export interface DesktopEnv {
  platform: "linux" | "darwin";
  bootId(): Promise<string | null>;
  /** The scanner's pid namespace inode (Linux), null where there is none. */
  pidns(): Promise<string | null>;
  /** True when every process is visible to this scanner (no hidepid, the recorded root in this namespace). */
  visibility(): Promise<{ hidepid: boolean; sameNs: boolean } | null>;
  /** ONE full-table pass: budgeted, chunked, aborting. null = unknown (an unreadable entry, a parse miss, budget, abort). */
  table(signal?: AbortSignal): Promise<DesktopRow[] | null>;
  signal?: AbortSignal;
}

export type PairClass = "gone" | "alive" | "unknown";
/** R1 per pair, with R7 (zombie rule per platform) and R9 (a one-second lstart is no identity). */
export function classifyPair(pair: Pair, row: DesktopRow | undefined, platform: "linux" | "darwin", inTree: (ppid: number) => boolean, isRoot: boolean): { cls: PairClass; reparented: boolean } {
  if (!row) return { cls: "gone", reparented: false };
  if (row.startKind === "lstart") return { cls: "unknown", reparented: false };
  if (row.start !== pair.start) return { cls: "gone", reparented: false };
  if (row.state === "Z" && (platform === "darwin" || row.threads === 1)) return { cls: "gone", reparented: false };
  if (!isRoot && !inTree(row.ppid)) return { cls: "unknown", reparented: true };
  return { cls: "alive", reparented: false };
}

/** `discovered`: descendants first seen in the post-kill passes; the caller appends them to the persisted U1 union (nlrace4a, Astra 2). */
export interface DesktopProofResult { verdict: Verdict; reparented: Pair[]; discovered?: Pair[] }

/** R1/R2/T1/V2. One verdict over the whole U1 union, on two full-table passes that agree. */
export async function desktopProof(record: StopRecord, env: DesktopEnv): Promise<DesktopProofResult> {
  const none = (verdict: Verdict): DesktopProofResult => ({ verdict, reparented: [] });
  const d = record.desktop;
  if (!d) return none(unknown("no pairs stored for this bot"));
  const boot = await env.bootId().catch(() => null);
  if (boot === null) return none(unknown("the boot id cannot be read"));
  const recordedBoot = d.context?.bootId ?? record.bootId;
  if (recordedBoot !== undefined && recordedBoot !== boot) return none(GONE); // T1/V2: the machine rebooted, every recorded pair is gone (any state)
  if (record.state !== "STOPPING" || !d.captureCompleted) return none(unknown("no completed pre-stop capture for this record"));
  if (!d.context) return none(unknown("no identity context stored"));
  // an empty descendant set is NEVER a verdict (R1): the root pair is always in the union, so a record without one proves nothing
  if (!d.rootPair || !d.pairs.some((pair) => pair.pid === d.rootPair!.pid && pair.start === d.rootPair!.start)) return none(unknown("the union has no root pair"));
  const ns = await env.pidns().catch(() => null);
  if (d.context.pidns !== null && ns !== d.context.pidns) return none(unknown("the pid namespace differs from the recorded one"));
  const vis = await env.visibility().catch(() => null);
  if (!vis || vis.hidepid || !vis.sameNs) return none(unknown("process visibility is not established"));
  const pairs = d.pairs;
  const pids = new Set(pairs.map((pair) => pair.pid));
  const root = d.rootPair;
  const pass = async (): Promise<{ cls: Map<number, PairClass>; reparented: Pair[]; fresh: number[]; freshPairs: Pair[]; freshUnstable: boolean } | null> => {
    const rows = await env.table(env.signal).catch(() => null);
    if (!rows) return null;
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const cls = new Map<number, PairClass>();
    const reparented: Pair[] = [];
    for (const pair of pairs) {
      const isRoot = root !== undefined && pair.pid === root.pid && pair.start === root.start;
      const out = classifyPair(pair, byPid.get(pair.pid), env.platform, (ppid) => pids.has(ppid), isRoot);
      cls.set(pair.pid, out.cls);
      if (out.reparented) reparented.push(pair);
    }
    // a new descendant of a recorded pair that is still itself, and that no pair names
    const fresh: number[] = [];
    const freshPairs: Pair[] = [];
    let freshUnstable = false;
    for (const row of rows) {
      if (pids.has(row.pid) || row.state === "Z") continue;
      const parent = pairs.find((pair) => pair.pid === row.ppid);
      const parentRow = parent ? byPid.get(parent.pid) : undefined;
      if (parent && parentRow && parentRow.start === parent.start && !(parentRow.state === "Z" && (env.platform === "darwin" || parentRow.threads === 1))) { fresh.push(row.pid); if (row.startKind === "lstart") freshUnstable = true; else freshPairs.push({ pid: row.pid, start: row.start }); }
    }
    return { cls, reparented, fresh: fresh.sort((a, b) => a - b), freshPairs, freshUnstable };
  };
  const first = await pass();
  if (!first) return none(unknown("the first post-kill table pass gave no answer"));
  const second = await pass();
  if (!second) return none(unknown("the second post-kill table pass gave no answer"));
  for (const pair of pairs) if (first.cls.get(pair.pid) !== second.cls.get(pair.pid)) return { verdict: unknown("two passes disagree on a pair"), reparented: second.reparented };
  if (first.fresh.join(",") !== second.fresh.join(",")) return { verdict: unknown("two passes disagree on new descendants"), reparented: second.reparented };
  const classes = pairs.map((pair) => second.cls.get(pair.pid));
  const discovered = second.freshPairs;
  if (second.freshUnstable) return { verdict: unknown("a new descendant has no fine-grained identity"), reparented: second.reparented, discovered };
  if (classes.includes("unknown")) return { verdict: unknown("a recorded pair cannot be judged (reparented or no fine-grained identity)"), reparented: second.reparented, discovered };
  if (classes.includes("alive") || second.fresh.length) return { verdict: alive("a recorded pair or a new descendant is still running"), reparented: second.reparented, discovered };
  return { verdict: GONE, reparented: [] };
}

/** R2: the pre-stop capture. Two passes must give the identical descendant set and the same root identity (B4); a pid from the
 *  first pass that reappears with a ppid outside the tree is a reparent (B6) and makes the capture unknown. Returns the pairs
 *  (root included) and the identity context, or null when the capture is unknown. */
export async function desktopCapture(rootPid: number, env: DesktopEnv): Promise<DesktopCaptured | null> {
  return (await desktopCaptureMany([rootPid], env))[0] ?? null;
}
export type DesktopCaptured = { root: Pair; pairs: Pair[]; context: DesktopContext };

/** R2 for every root of one relay stop (R8 as amended 2026-11-17): the same two table passes judge each root, so N roots cost one
 *  enumeration instead of N. Each root is judged exactly as desktopCapture judges it alone (its own visibility, its own tree in both
 *  passes); one answer per root, in order, and null for a root that is unknown. An unreadable pass is unknown for every root. */
export async function desktopCaptureMany(rootPids: readonly number[], env: DesktopEnv,
  visibility: (rootPid: number) => Promise<{ hidepid: boolean; sameNs: boolean } | null> = () => env.visibility()): Promise<Array<DesktopCaptured | null>> {
  const none = (): null[] => rootPids.map(() => null);
  const boot = await env.bootId().catch(() => null);
  const ns = await env.pidns().catch(() => null);
  const vis = await Promise.all(rootPids.map((rootPid) => visibility(rootPid).catch(() => null)));
  if (boot === null) return none();
  const live = rootPids.map((_, i) => { const v = vis[i]; return !!v && !v.hidepid && v.sameNs; });
  if (!live.some(Boolean)) return none();
  const take = async (): Promise<Array<Map<number, DesktopRow> | null> | null> => {
    const rows = await env.table(env.signal).catch(() => null);
    if (!rows) return null;
    const children = new Map<number, DesktopRow[]>();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    for (const row of rows) (children.get(row.ppid) ?? children.set(row.ppid, []).get(row.ppid)!).push(row);
    return rootPids.map((rootPid, i) => {
      const rootRow = live[i] ? byPid.get(rootPid) : undefined;
      if (!rootRow) return null;
      const out = new Map<number, DesktopRow>([[rootPid, rootRow]]);
      const queue = [rootPid];
      while (queue.length) for (const child of children.get(queue.pop()!) ?? []) if (!out.has(child.pid)) { out.set(child.pid, child); queue.push(child.pid); }
      return out;
    });
  };
  const first = await take();
  const second = first?.some(Boolean) ? await take() : null;
  if (!first || !second) return none();
  return rootPids.map((rootPid, i): DesktopCaptured | null => {
    const a = first[i], b = second[i];
    if (!a || !b || a.size !== b.size) return null;
    for (const [pid, row] of a) {
      const other = b.get(pid);
      if (!other || other.start !== row.start || other.startKind === "lstart" || row.startKind === "lstart") return null;
    }
    const pairs: Pair[] = [...b.values()].map((row) => ({ pid: row.pid, start: row.start }));
    return { root: { pid: rootPid, start: b.get(rootPid)!.start }, pairs, context: { bootId: boot, pidns: ns, visibility: vis[i]! } };
  });
}

// ----------------------------------------------------------------------------------------------------------------- Signalling (U3)

/** A verified per-process handle (Linux pidfd). open() pins the pid; send() signals exactly that process. */
export interface PidHandle { start(): Promise<string | null>; send(signal: NodeJS.Signals): void; close(): void }
export interface SignalEnv {
  platform: "linux" | "darwin";
  /** Linux pidfd_open through a native binding; null when the platform or the build has none. */
  openHandle?(pid: number): Promise<PidHandle | null>;
  /** The native identity of `pid` now: its start string, "absent", or null when it cannot be read or is only an lstart. */
  identity(pid: number): Promise<{ start: string; kind: StartKind } | "absent" | null>;
  kill(pid: number, signal: NodeJS.Signals): void;
  residual(event: string): void;
}
export type SignalOutcome = "sent" | "skipped" | "residual";

/** U3: one pair, signalled through a verified per-process handle. NEVER a process group, on any desktop path. A mismatch sends
 *  nothing; without a pidfd the identity is re-read right before and right after kill(pid), and a change after is a residual event
 *  that never counts as proof. */
export async function signalPair(pair: Pair, signal: NodeJS.Signals, env: SignalEnv): Promise<SignalOutcome> {
  if (!Number.isInteger(pair.pid) || pair.pid <= 1) return "skipped";
  const handle = env.platform === "linux" ? await env.openHandle?.(pair.pid).catch(() => null) ?? null : null;
  if (handle) {
    try {
      if ((await handle.start()) !== pair.start) return "skipped";
      handle.send(signal);
      return "sent";
    } catch { return "skipped"; } finally { handle.close(); }
  }
  const before = await env.identity(pair.pid);
  if (before === null || before === "absent" || before.kind === "lstart" || before.start !== pair.start) return "skipped";
  try { env.kill(pair.pid, signal); } catch { return "skipped"; }
  const after = await env.identity(pair.pid);
  if (after !== "absent" && (after === null || after.start !== pair.start)) { env.residual(`pid ${pair.pid} changed identity around the signal`); return "residual"; }
  return "sent";
}
