import { labelWorkCollection } from "./work-collections.ts";
export type SubmissionRefusalContext = Readonly<{ priorSubmissionReleased: boolean }>;
/** PROVISIONAL INTERFACE: F2 names the mandatory gate but not its TS setter.
 * Both methods must synchronously COMMIT or throw before returning authority. */
export interface SubmissionPersistenceGate {
  invocation(fencedWrites: boolean): void;
  write(ordinal: number): void;
}

/** Only a trusted callback refusal proves an invoked adapter did not submit. */
export class TurnSubmissionBoundary {
  private readonly inert?: () => boolean;
  constructor(inert?: () => boolean) { this.inert = inert; }
  private state: "not-started" | "unknown" | "refused" = "not-started";
  private refusal: unknown;
  private checks: Array<() => void> = [];
  private accepted = false;
  private onLateRefusal?: (refusal: unknown, context: SubmissionRefusalContext) => void;
  private lateRefusalNotified = false;
  private passed?: () => void;
  private notWrittenListeners: Array<() => void> = [];
  /** One record per submission attempt of the logical turn (1.0.19 D1). A passed `beforeSubmit` opens a `fenced` attempt (the write it
   * released may have happened); a refused one is recorded `unwritten` (the fence ran ahead of any write). The driver reports on the id it
   * was handed: `written`, `uncertain` (a write failed partway, or any doubt) or `unwritten` (proven zero bytes). Only an explicit id can
   * turn a released attempt `unwritten`; `released` and `canRetry` are derived from the whole set, never from the last attempt. */
  private attempts: Array<{ id: number; state: "fenced" | "written" | "uncertain" | "unwritten" }> = [];
  private nextAttempt = 1;
  /** Historical release count remains monotone for the newer replay seal contract. */
  private released = 0;
  /** The attempt count at the last withdrawal: a refusal that finds every attempt unwritten withdraws once for that set, never again. */
  private withdrawnAt = 0;
  private withdrawIfEveryAttemptUnwritten() {
    if (this.attempts.length === 0 || !this.everyAttemptUnwritten || this.withdrawnAt === this.attempts.length) return;
    this.withdrawnAt = this.attempts.length;
    this.notWritten();
  }
  private openAttempt(state: "fenced" | "unwritten"): number { const id = this.nextAttempt++; this.attempts.push({ id, state }); return id; }
  private get everyAttemptUnwritten() { return this.attempts.every(a => a.state === "unwritten"); }
  /** The attempt's driver says its bytes went out. */
  attemptWritten(id: number | void): boolean {
    const attempt = this.attempts.find(entry => entry.id === id);
    if (!attempt || attempt.state === "unwritten") return false;
    attempt.state = "written";
    return true;
  }
  /** The attempt's write failed partway, or any doubt: it may have started, so nothing rebuilds and nothing is withdrawn. */
  attemptUncertain(id: number | void) { const a = this.attempts.find(x => x.id === (id as number | undefined)); if (a && a.state !== "unwritten" && a.state !== "written") a.state = "uncertain"; }
  /** Proven zero bytes for THIS attempt only. The delivery bookkeeping is withdrawn only when every attempt of the turn is unwritten. */
  attemptNotWritten(id: number | void) {
    const a = this.attempts.find(x => x.id === (id as number | undefined));
    if (!a || a.state !== "fenced") return;
    a.state = "unwritten";
    this.withdrawIfEveryAttemptUnwritten();
  }
  /** State only: a launch attempt (the process started, no prompt bytes) is proven unwritten. Unlike `attemptNotWritten` it withdraws nothing:
   * a driver calls it right BEFORE the prompt's own fence, so that a refusal at that fence is classified (onLateRefusal) against settled attempts,
   * not against a launch attempt that is still "fenced". The stamp is withdrawn only by the refusal itself or by `attemptNotWritten`. */
  attemptSettled(id: number | void) { const a = this.attempts.find(x => x.id === (id as number | undefined)); if (a && a.state === "fenced") a.state = "unwritten"; }
  private replayDisabled = false;
  /** A consumed single-use application may finish its write but cannot be sent again. */
  disallowReplay(): void { this.replayDisabled = true; }
  private confirmedWrite = false;
  noteEngineWrite() { this.confirmedWrite = true; }
  get hasConfirmedSubmission() { return this.confirmedWrite; }
  get hasReleasedSubmission() { return this.attempts.some(a => a.state !== "unwritten"); }
  private refusalContext(): SubmissionRefusalContext { return Object.freeze({ priorSubmissionReleased: this.hasReleasedSubmission }); }
  /** Set by `sealUnwritten` or `sealForReplay`: every later `beforeSubmit` of this turn refuses before it validates or releases anything. */
  private sealed = false;
  private terminal = false;
  private invoked = false;
  /** Only Murage's preparation, before calling the adapter, proves that no
   * engine work exists. An invoked adapter may act before its first write. */
  get preparing() { return !this.invoked && !this.accepted && this.released === 0; }
  refusePreparation(error: unknown): boolean {
    if (!this.preparing || this.terminal) return false;
    this.sealed = true; this.state = "refused"; this.refusal = error;
    return true;
  }
  private persistence?: SubmissionPersistenceGate;
  private unfencedInvocation = false;
  setPersistenceGate(gate: SubmissionPersistenceGate): void {
    if (this.state !== "not-started") throw new Error("submission already started");
    this.persistence = gate;
  }
  started(fencedWrites = false) {
    this.invoked = true;
    // This is separate from onPassed: a failed durable gate never releases work.
    try { this.persistence?.invocation(fencedWrites); }
    catch (error) { this.state = "unknown"; this.seal(error); throw error; }
    this.unfencedInvocation = Boolean(this.persistence) && !fencedWrites;
    this.state = "unknown";
  }
  invoke<T>(operation: () => T, fencedWrites = false): T {
    this.started(fencedWrites);
    return operation();
  }
  /** A further check run on every submission, after the caller's own. */
  alsoCheck(check: () => void) { this.checks.push(check); }
  /** The server accepted the provider turn. An adapter that writes after
   * handing its id back (ACP, Codex) can still be refused at that write;
   * `onLateRefusal` carries prior release classification. Only verified unwritten
   * dispatches may rebuild automatically; a refused resend preserves any earlier
   * released or confirmed submission. */
  acceptedBy(onLateRefusal?: (refusal: unknown, context: SubmissionRefusalContext) => void) { this.accepted = true; this.onLateRefusal = onLateRefusal; }
  /** Heard after every submission whose checks all passed: the prompt is released to the adapter's write. */
  onPassed(passed: () => void) { this.passed = passed; }
  /** Heard on explicit unwritten evidence, or a refusal before any write was released. A later refusal cannot withdraw an earlier release. */
  onNotWritten(listener: () => void) { this.notWrittenListeners[0] = listener; }
  /** A further listener, heard after the first: the durable send ledger withdraws what the released write recorded. */
  alsoOnNotWritten(listener: () => void) { this.notWrittenListeners.push(listener); }
  /** The adapter says the write its last passed `beforeSubmit` released did not happen. */
  notWritten() { for (const listener of this.notWrittenListeners) { try { listener(); } catch { /* a listener never decides the submission */ } } }
  private preparationScope = false;
  /** Run the same synchronous checks before process setup without classifying
   * them as prompt release. A subsequent actual write must check again. */
  prepare(validate: () => void) {
    const previous = this.preparationScope;
    this.preparationScope = true;
    try { validate(); } finally { this.preparationScope = previous; }
  }
  /** Every adapter write calls this, every time: validation is never skipped
   * because an earlier write or acceptance passed. */
  beforeSubmit(validate: () => void): number | void {
    this.beforePrepare(validate);
    // A compatibility preparation scope validates but cannot release a prompt.
    if (this.preparationScope) return;
    try { this.persistence?.write(this.released + 1); }
    catch (error) { this.seal(error); throw error; }
    this.released++;
    const id = this.openAttempt("fenced");
    try { this.passed?.(); } catch { /* a listener never decides the submission */ }
    return id;
  }
  /** Setup validation is not a prompt release. Every write must still call beforeSubmit after setup awaits. */
  beforePrepare(validate: () => void) {
    if (this.sealed) { if (!this.hasReleasedSubmission) this.notWritten(); throw this.refusal; }
    try {
      if (this.inert?.()) throw Object.assign(new Error("This bot starts when the reply finishes or after your review."), { status: 409, code: "bot_staged" });
      validate(); for (const check of this.checks) check();
    }
    catch (error) {
      this.state = "refused"; this.refusal = error;
      if (this.accepted && !this.lateRefusalNotified) { this.lateRefusalNotified = true; try { this.onLateRefusal?.(error, this.refusalContext()); } catch { /* the refusal itself still stands */ } }
      this.openAttempt("unwritten");
      this.withdrawIfEveryAttemptUnwritten();
      throw error;
    }
  }
  /** DELETE-REVOKE-SCOPE (a): a refusal at acceptance (the adapter handed its id back, the server refused the turn) on an adapter that
   * declares `fencedWrites` (every write carrying the turn goes through beforeSubmit) while no write was ever released is positive proof
   * that nothing was submitted. In one synchronous step the boundary turns refused with that error and is sealed, so the stopped adapter
   * can never write the old prompt later, and the caller may rebuild the turn. Anything else (no flag, a released write, a state other
   * than unknown) proves nothing: false, and the boundary is left as it was. */
  sealUnwritten(error: unknown, fencedWrites: boolean | undefined): boolean {
    if (fencedWrites !== true || this.state !== "unknown" || this.hasReleasedSubmission || this.accepted) return false;
    this.state = "refused"; this.refusal = error; this.sealed = true;
    return true;
  }
  /** A ledger seal (revoke) of an accepted turn on an adapter that declares `fencedWrites`: every write goes through beforeSubmit, which this seal
   * now refuses, so with no write released, none confirmed and no unfenced invocation, nothing of the old prompt can ever be written. The boundary
   * turns refused (sealed, not terminal) and the caller may rebuild. Anything else proves nothing: false, boundary untouched. */
  sealFencedUnwritten(error: unknown, fencedWrites: boolean | undefined): boolean {
    if (fencedWrites !== true || this.state !== "unknown" || this.terminal || this.replayDisabled || this.released !== 0
      || this.hasReleasedSubmission || this.confirmedWrite || this.unfencedInvocation) return false;
    this.sealed = true; this.refuse(error);
    return true;
  }
  /** Proof, for a setup failure with no provider turn handed back, that the admission never launched engine work: the same proof the
   * unwritten seals use. The adapter declares `fencedWrites` (every write goes through beforeSubmit), no write was released, none was
   * confirmed and no unfenced invocation happened. Anything else (an unfenced or invoked-without-fence adapter, a released or confirmed
   * write) proves nothing: false, and the caller keeps the held thread / the turn id-checked interrupt. Reads only, never changes state. */
  provenNotLaunched(fencedWrites: boolean | undefined): boolean {
    return fencedWrites === true && !this.hasReleasedSubmission && !this.confirmedWrite && !this.unfencedInvocation;
  }
  /** Writes released to the adapter, even if it later reports notWritten. */
  get releasedWrites(): number { return this.released; }
  /** Prove retryability and seal the old prompt in one synchronous step. Sealing alone is never proof. */
  sealForReplay(error: unknown, opts: { requireNoRelease: boolean }): "sealed" | "unproven" {
    // The newer submission contract forbids replay after any released or confirmed write.
    // requireNoRelease=false cannot relax that protection.
    if (!this.canRetry || this.hasConfirmedSubmission || (opts.requireNoRelease && this.released !== 0)) return "unproven";
    // A refusal can itself be undefined or null. State and the shared seal record its presence.
    if (this.state !== "refused" && !this.sealed) this.refusal = error;
    this.sealed = true;
    return "sealed";
  }
  /** A refusal that happened before the adapter wrote (the send fence runs ahead of beforeSubmit): the same state beforeSubmit leaves. */
  refuse(error: unknown) {
    this.state = "refused"; this.refusal = error;
    if (this.accepted && !this.lateRefusalNotified) { this.lateRefusalNotified = true; try { this.onLateRefusal?.(error, this.refusalContext()); } catch { /* the refusal itself still stands */ } }
    // The outer fence (assertEngineInput) refuses ahead of the boundary's own beforeSubmit: once the launch attempts have settled and every one
    // of them is unwritten, the prompt never went out, so the stamp is withdrawn here (once; the driver's later attemptNotWritten is then a no-op).
    this.withdrawIfEveryAttemptUnwritten();
  }
  /** Terminal retained refusal is never evidence authorizing a setup retry. */
  seal(error: unknown = new Error("turn stopped")) {
    this.terminal = true;
    this.sealed = true;
    this.state = "refused";
    this.refusal = error;
  }
  assertNotRefused() { if (this.state === "refused") throw this.refusal; }
  /** What refused the submission, if anything did: a late settlement reads its own line from it (U22 G20 backup refusals). */
  get refusedWith(): unknown { return this.state === "refused" ? this.refusal : undefined; }
  get canRetry() { return !this.replayDisabled && !this.terminal && this.state !== "unknown" && !this.hasReleasedSubmission && !this.unfencedInvocation; }
}

/** Close the Stop-vs-provider-handshake race shared by direct and room turns.
 * An interrupt before the adapter publishes its active process may be a no-op;
 * recheck cancellation after setup and await exact-turn cleanup. */
export async function guardTurnDispatch<T>(
  started: Promise<T>,
  cancelled: () => boolean,
  stopAfterSetup: (value: T) => Promise<void>,
  accepted?: (value: T) => void,
): Promise<{ value: T; cancelled: boolean }> {
  const value = await started;
  if (!cancelled()) {
    try { accepted?.(value); }
    catch (error) {
      // A provider may already own a process/retry. Validation failure must
      // not release its caller's busy/lease state before exact-turn teardown.
      await stopAfterSetup(value);
      throw error;
    }
    return { value, cancelled: false };
  }
  await stopAfterSetup(value);
  return { value, cancelled: true };
}

/** Bounded tombstones for provider turns cancelled during asynchronous
 * startup. Their late completion/session events must not settle a newer turn
 * that reused the same conversation thread. */
export class RetiredTurnRegistry {
  readonly #turnIds = labelWorkCollection("RetiredTurnRegistry.turnIds", new Set<string>());
  readonly #limit: number;

  constructor(limit = 4_096) {
    this.#limit = limit;
  }

  retire(turnId: string): void {
    this.#turnIds.add(turnId);
    while (this.#turnIds.size > this.#limit) {
      const oldest = this.#turnIds.values().next().value;
      if (oldest === undefined) break;
      this.#turnIds.delete(oldest);
    }
  }

  has(turnId: string | undefined): boolean {
    return turnId !== undefined && this.#turnIds.has(turnId);
  }
}

/** Thread gate for the narrow interval after Stop wins but before an async
 * adapter returns the provider turn id that can be retired. Multiple queued
 * room operations may share a thread, so ownership is reference-counted.
 *
 * A broken adapter is allowed to leave its sendTurn promise pending forever.
 * The gate therefore expires each owner independently: by then any turn id
 * observed during the vulnerable handshake has been moved to the longer-lived
 * RetiredTurnRegistry, while a replacement turn's new id can flow normally. */
export class PendingTurnCancellations {
  readonly #ownersByThread = labelWorkCollection("PendingTurnCancellations.ownersByThread", new Map<
    string,
    Map<string, ReturnType<typeof setTimeout>>
  >());
  readonly #clearWaitersByThread = labelWorkCollection("PendingTurnCancellations.clearWaitersByThread", new Map<string, Set<() => void>>());
  readonly #ttlMs: number;

  constructor(ttlMs = 30_000) {
    this.#ttlMs = Math.max(1, Math.floor(ttlMs));
  }

  mark(threadId: string, ownerId: string): void {
    const owners = this.#ownersByThread.get(threadId) ?? labelWorkCollection("PendingTurnCancellations.owners", new Map<string, ReturnType<typeof setTimeout>>());
    const previous = owners.get(ownerId);
    if (previous) clearTimeout(previous);
    const expiry = setTimeout(() => {
      // A clear + re-mark may have installed a newer timer for the same
      // owner. The stale callback must not clear that renewed quarantine.
      if (this.#ownersByThread.get(threadId)?.get(ownerId) !== expiry) return;
      this.clear(threadId, ownerId);
    }, this.#ttlMs);
    expiry.unref?.();
    owners.set(ownerId, expiry);
    this.#ownersByThread.set(threadId, owners);
  }

  clear(threadId: string, ownerId: string): void {
    const owners = this.#ownersByThread.get(threadId);
    const expiry = owners?.get(ownerId);
    if (expiry) clearTimeout(expiry);
    owners?.delete(ownerId);
    if (owners?.size !== 0) return;
    this.#ownersByThread.delete(threadId);
    const waiters = this.#clearWaitersByThread.get(threadId);
    this.#clearWaitersByThread.delete(threadId);
    for (const resolve of waiters ?? []) resolve();
  }

  /** Do not overlap a replacement dispatch with the ambiguous pre-id window.
   * Re-check after every wake: a cancellation can be renewed in the same
   * microtask turn that clears an older owner. Each owner has its own bounded
   * expiry, so a broken adapter cannot strand this await forever. */
  async waitForClear(threadId: string): Promise<void> {
    while (this.has(threadId)) {
      await new Promise<void>((resolve) => {
        const waiters = this.#clearWaitersByThread.get(threadId) ?? labelWorkCollection("PendingTurnCancellations.waiters", new Set<() => void>());
        waiters.add(resolve);
        this.#clearWaitersByThread.set(threadId, waiters);
        // clear() cannot interleave with this synchronous block, but keeping
        // the second check makes the registration safe if the implementation
        // later gains an externally supplied scheduler.
        if (!this.has(threadId)) {
          waiters.delete(resolve);
          if (waiters.size === 0) this.#clearWaitersByThread.delete(threadId);
          resolve();
        }
      });
    }
  }

  has(threadId: string): boolean {
    return this.#ownersByThread.has(threadId);
  }
}

/** Apply the two-stage cancellation quarantine. While the unresolved
 * handshake owns the thread, every event is ignored and any stable provider
 * turn id it reveals is retired. After the bounded gate expires, that old id
 * remains ignored but an unrelated replacement id is admitted. */
export function isTurnEventQuarantined(
  pending: PendingTurnCancellations,
  retired: RetiredTurnRegistry,
  event: { threadId: string; turnId?: string },
): boolean {
  if (retired.has(event.turnId)) return true;
  if (!pending.has(event.threadId)) return false;
  if (event.turnId) retired.retire(event.turnId);
  return true;
}

/** PROVISIONAL INTERFACE: batch adapter for F1/F2. Reload only evidence
 * revisions; never replace the immutable binding captured at queue selection. */
export function attemptSubmissionGate(
  store: import("./send-attempt-state.ts").SendAttemptStore,
  bindings: readonly import("./send-attempt-state.ts").BindingKey[],
): SubmissionPersistenceGate {
  return {
    invocation(fencedWrites) {
      store.transaction(() => {
        for (const key of bindings) store.recordInvocation(key, store.byId(key.attemptId)?.revision ?? -1, fencedWrites);
      });
    },
    write(ordinal) {
      store.transaction(() => {
        for (const key of bindings) store.releaseWrite(key, store.byId(key.attemptId)?.revision ?? -1, ordinal);
      });
    },
  };
}
