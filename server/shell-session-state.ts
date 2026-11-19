import { admitShellPlace, copyShellCwdState, type ShellCwdState } from "../shared/sensitive-globs.ts";
import type { RuntimeEvent } from "./contracts.ts";

export interface ShellSessionIdentity { thread: string; provider: string; native: string; incarnation: number }
/** `replacements`: at most one pending P1 replacement per open request and at
 * most SHELL_MAX_OPEN_REQUESTS per record (rev 3.2 section 3), keyed
 * [turn, request]. They are dropped on completion, turn end or retire. */
export interface ShellSessionRecord {
  identity: ShellSessionIdentity; state: ShellCwdState; active: boolean; replacements: Map<string, ShellCwdState>;
  /** Ruling H2: `nextSeq` hands out a monotonic number at prepare time (`claim`); `installedSeq` is the newest write that
   * reached `state` (a publish or a P1 commit). A publish whose number is not newer is stale and is dropped. */
  nextSeq: number; installedSeq: number;
}
export const SHELL_MAX_OPEN_REQUESTS = 16;
interface Launch { thread: string; provider: string; cwd?: string; identity?: ShellSessionIdentity; turn?: string; record?: ShellSessionRecord }
const tuple = (identity: ShellSessionIdentity) => JSON.stringify([identity.thread, identity.provider, identity.native, identity.incarnation]);
const turnKey = (thread: string, provider: string, turn: string) => JSON.stringify([thread, provider, turn]);
const unknown = (): ShellCwdState => ({ targets: new Map(), unknown: "shell session attribution or launch folder unavailable" });

/** Live identities only. Permission lookup is constant-time and never walks
 * messages or earlier turns. Retired record objects cannot be resurrected. */
export class ShellSessionRegistry {
  private replacementSeq = new WeakMap<ShellCwdState, number>();
  private records = new Map<string, ShellSessionRecord>();
  private launches = new Map<string, Launch>();
  private turns = new Map<string, ShellSessionRecord | null>();
  private accepted = new Map<string, Launch>();
  private starts = new Map<string, ShellSessionIdentity>();
  private completed = new Set<string>();
  private retiredTurns = new Set<string>();

  launch(generation: string, launch: Omit<Launch, "turn" | "cwd">): void {
    this.launches.set(generation, { ...launch });
  }
  cancelLaunch(generation: string): void { this.launches.delete(generation); }
  /** The launch exists only while `send` (the adapter call) runs: it is registered when the call starts, accepted
   * when the engine takes the turn and cancelled on any failure, so a dispatch refused earlier leaves nothing. */
  dispatch<T extends { turnId: string }>(generation: string, launch: Omit<Launch, "turn" | "cwd">, send: () => Promise<T>, spawnCwd: (accepted: T) => string | undefined): Promise<T> {
    this.launch(generation, launch);
    let sent: Promise<T>;
    try { sent = send(); } catch (error) { this.cancelLaunch(generation); return Promise.reject(error); }
    return sent.then(accepted => { this.accept(generation, accepted.turnId, spawnCwd(accepted)); return accepted; }, error => { this.cancelLaunch(generation); throw error; });
  }
  /** `spawnCwd` is P-SPAWN (A:17-25): the folder the driver handed to spawn. It seeds the record only when this
   * acceptance creates it; none means the record starts unknown (rev 3.2 S2'). */
  accept(generation: string, turn: string, spawnCwd?: string): void {
    const launch = this.launches.get(generation);
    if (!launch) return;
    this.launches.delete(generation);
    launch.turn = turn;
    launch.cwd = spawnCwd;
    const key = turnKey(launch.thread, launch.provider, turn);
    if (this.retiredTurns.has(key) || this.completed.has(key)) return;
    if (this.accepted.has(key) || this.turns.has(key)) { this.turns.set(key, null); return; }
    this.accepted.set(key, launch);
    const identity = this.starts.get(key) ?? launch.identity;
    if (identity) this.bind(launch, identity);
    this.starts.delete(key);
  }
  started(identity: ShellSessionIdentity, turn: string | undefined): void {
    if (!turn) return;
    const key = turnKey(identity.thread, identity.provider, turn);
    if (this.retiredTurns.has(key) || this.completed.has(key)) return;
    const launch = this.accepted.get(key);
    if (!launch) {
      // Before acceptance, retain only the event's exact identity. It cannot
      // authorize a permission until its dispatch is attributed.
      if (this.starts.size < 256) this.starts.set(key, identity);
      return;
    }
    this.bind(launch, identity);
  }
  private bind(launch: Launch, identity: ShellSessionIdentity): void {
    if (launch.record && !launch.record.active) return;
    if (!launch.turn || launch.thread !== identity.thread || launch.provider !== identity.provider) return;
    const key = turnKey(identity.thread, identity.provider, launch.turn);
    const prior = this.turns.get(key);
    if (prior && tuple(prior.identity) !== tuple(identity)) { this.turns.set(key, null); return; }
    let record = this.records.get(tuple(identity));
    if (!record) {
      // S2': a record with no recorded start begins unknown
      record = { identity: { ...identity }, active: true, state: launch.cwd ? { targets: new Map([[launch.cwd, "recorded launch folder"]]) } : unknown(), replacements: new Map(), nextSeq: 0, installedSeq: 0 };
      this.records.set(tuple(identity), record);
    }
    launch.record = record;
    this.turns.set(key, record);
  }
  select(thread: string, provider: string | undefined, turn: string | undefined): ShellSessionRecord | undefined {
    if (!provider || !turn) return;
    const key = turnKey(thread, provider, turn);
    if (this.completed.has(key)) return;
    const record = this.turns.get(key);
    return record?.active ? record : undefined;
  }
  complete(thread: string, provider: string | undefined, turn: string | undefined): void {
    if (provider && turn) {
      const key = turnKey(thread, provider, turn);
      // A turn's open requests end with it: their replacements never commit.
      const record = this.turns.get(key);
      if (record) for (const request of [...record.replacements.keys()]) if (JSON.parse(request)[0] === turn) record.replacements.delete(request);
      this.completed.add(key); this.accepted.delete(key); this.starts.delete(key);
    }
  }
  /** P1: keep this request's replacement until its completion. A 17th open
   * request keeps none, so its completion commits nothing (fail closed). */
  propose(record: ShellSessionRecord | undefined, turn: string | undefined, request: string | undefined, replacement: ShellCwdState): boolean {
    if (!record?.active || !turn || !request || this.records.get(tuple(record.identity)) !== record) return false;
    const key = JSON.stringify([turn, request]);
    if (!record.replacements.has(key) && record.replacements.size >= SHELL_MAX_OPEN_REQUESTS) return false;
    const candidate = copyShellCwdState(replacement);
    // Concurrent commands have no proven execution order. Neither may clear unknown.
    if (record.replacements.size) {
      candidate.install = false;
      for (const pending of record.replacements.values()) pending.install = false;
    }
    this.replacementSeq.set(candidate, record.installedSeq);
    record.replacements.set(key, candidate);
    return true;
  }
  /** P1 commit (r5:83, :93 with S-a/S-b): only a completion that reports exit
   * status 0 commits, and a commit only UNIONS its final set into the places.
   * It clears `unknown` and `capped` only when it installs an exact absolute
   * cwd (its last cd was absolute or handed-HOME `~/`). Any other end drops it. */
  completeRequest(thread: string, provider: string | undefined, turn: string | undefined, request: string | undefined, exitCode: number | undefined): boolean {
    if (!provider || !turn || !request) return false;
    const record = this.turns.get(turnKey(thread, provider, turn));
    return this.commit(record ?? undefined, turn, request, exitCode);
  }
  commit(record: ShellSessionRecord | undefined, turn: string, request: string, exitCode: number | undefined): boolean {
    if (!record) return false;
    const key = JSON.stringify([turn, request]);
    const replacement = record.replacements.get(key);
    record.replacements.delete(key);
    if (!replacement || exitCode !== 0 || !record.active || this.records.get(tuple(record.identity)) !== record) return false;
    const next = copyShellCwdState(record.state);
    if (replacement.install && this.replacementSeq.get(replacement) === record.installedSeq) { delete next.unknown; delete next.capped; delete next.kShown; }
    for (const [path, reason] of replacement.targets) admitShellPlace(next, path, reason);
    if (replacement.dotglob) next.dotglob = true;
    record.state = next;
    // a commit is a write too: any preparation claimed before it is now stale
    record.installedSeq = ++record.nextSeq;
    return true;
  }
  exit(thread: string, provider: string | undefined, turn: string | undefined): void {
    if (!provider || !turn) return;
    const record = this.turns.get(turnKey(thread, provider, turn));
    if (record) this.retire(thread, provider, record);
  }
  snapshot(record: ShellSessionRecord | undefined): ShellCwdState {
    return record?.active ? copyShellCwdState(record.state) : unknown();
  }
  /** Ruling H2: take the next sequence number for a preparation, at the moment it starts reading the record. */
  claim(record: ShellSessionRecord | undefined): number {
    return record?.active ? ++record.nextSeq : 0;
  }
  /** Install a prepared state only if its sequence is newer than the installed one. A stale, repeated or unnumbered
   * publish is dropped (false) and never clears `unknown`; the caller then judges the call on unknown. */
  publish(record: ShellSessionRecord | undefined, state: ShellCwdState, seq: number): boolean {
    if (!record?.active || this.records.get(tuple(record.identity)) !== record) return false;
    if (!Number.isSafeInteger(seq) || seq <= record.installedSeq) return false;
    record.installedSeq = seq;
    record.state = state;
    return true;
  }
  retire(thread?: string, provider?: string, exact?: ShellSessionRecord): void {
    const matches = (entry: { thread: string; provider: string }) => (thread === undefined || entry.thread === thread) && (provider === undefined || entry.provider === provider);
    for (const [key, record] of this.records) if (exact ? record === exact : matches(record.identity)) {
      record.active = false;
      record.state = unknown();
      record.replacements.clear();
      this.records.delete(key);
    }
    // Completed turn bindings are inert identity tombstones. Do not walk
    // them on a reset: a turn's work must not grow with session history.
    for (const [key, launch] of this.accepted) if (exact ? launch.record === exact : matches(launch)) {
      this.retiredTurns.add(key); this.accepted.delete(key); this.starts.delete(key);
    }
    for (const [key, launch] of this.launches) if (exact ? launch.identity && tuple(launch.identity) === tuple(exact.identity) : matches(launch)) this.launches.delete(key);
    for (const [key, identity] of this.starts) if (exact ? tuple(identity) === tuple(exact.identity) : matches(identity)) this.starts.delete(key);
  }
}

/** The exit status a driver's tool completion reports, or undefined when the
 * driver reports none. X3 r5:93 build condition, by driver:
 * - codex: item.completed `result.exitCode` for a commandExecution
 *   (server/drivers/codex.ts, the commandExecution item.completed emit),
 *   linked to its request by item id (request.opened `itemId`).
 * - every other driver: none, so it never replaces (P1 stays additive). */
export function shellExitStatus(event: RuntimeEvent): number | undefined {
  if (event.type !== "item.completed" || event.itemType !== "tool" || event.provider !== "codex") return undefined;
  const result = event.result as { exitCode?: unknown } | undefined;
  return result && typeof result === "object" && typeof result.exitCode === "number" ? result.exitCode : undefined;
}

export class PendingShellJudgement extends Error {}
