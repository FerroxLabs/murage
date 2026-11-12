export type SubmissionRefusalContext = Readonly<{ priorSubmissionReleased: boolean }>;
/** Only a trusted callback refusal proves an invoked adapter did not submit. */
export class TurnSubmissionBoundary {
  private readonly inert?: () => boolean;
  constructor(inert?: () => boolean) { this.inert = inert; }
  private state: "not-started" | "unknown" | "refused" = "not-started";
  private refusal: unknown;
  private checks: Array<() => void> = [];
  private accepted = false;
  private onLateRefusal?: (refusal: unknown, context: SubmissionRefusalContext) => void;
  private passed?: () => void;
  private notWrittenListener?: () => void;
  /** Writes a passed `beforeSubmit` released to the adapter. Never reset: a write that was released may have happened. */
  private released = 0;
  private confirmedWrite = false;
  noteEngineWrite() { this.confirmedWrite = true; }
  get hasConfirmedSubmission() { return this.confirmedWrite; }
  get hasReleasedSubmission() { return this.released > 0; }
  private refusalContext(): SubmissionRefusalContext { return Object.freeze({ priorSubmissionReleased: this.hasReleasedSubmission }); }
  /** Set by `sealUnwritten` or `sealForReplay`: every later `beforeSubmit` of this turn refuses before it validates or releases anything. */
  private sealed = false;
  started() { this.state = "unknown"; }
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
  onNotWritten(listener: () => void) { this.notWrittenListener = listener; }
  /** The adapter says the write its last passed `beforeSubmit` released did not happen. */
  notWritten() { try { this.notWrittenListener?.(); } catch { /* a listener never decides the submission */ } }
  private preparing = false;
  /** Run the same synchronous checks before process setup without classifying
   * them as prompt release. A subsequent actual write must check again. */
  prepare(validate: () => void) {
    const previous = this.preparing;
    this.preparing = true;
    try { validate(); } finally { this.preparing = previous; }
  }
  /** Every adapter write calls this, every time: validation is never skipped
   * because an earlier write or acceptance passed. */
  beforeSubmit(validate: () => void) {
    this.beforePrepare(validate);
    // A compatibility preparation scope validates but cannot release a prompt.
    if (this.preparing) return;
    this.released++;
    try { this.passed?.(); } catch { /* a listener never decides the submission */ }
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
      if (this.accepted) { try { this.onLateRefusal?.(error, this.refusalContext()); } catch { /* the refusal itself still stands */ } }
      if (!this.hasReleasedSubmission) this.notWritten();
      throw error;
    }
  }
  /** DELETE-REVOKE-SCOPE (a): a refusal at acceptance (the adapter handed its id back, the server refused the turn) on an adapter that
   * declares `fencedWrites` (every write carrying the turn goes through beforeSubmit) while no write was ever released is positive proof
   * that nothing was submitted. In one synchronous step the boundary turns refused with that error and is sealed, so the stopped adapter
   * can never write the old prompt later, and the caller may rebuild the turn. Anything else (no flag, a released write, a state other
   * than unknown) proves nothing: false, and the boundary is left as it was. */
  sealUnwritten(error: unknown, fencedWrites: boolean | undefined): boolean {
    if (fencedWrites !== true || this.state !== "unknown" || this.released !== 0 || this.accepted) return false;
    this.state = "refused"; this.refusal = error; this.sealed = true;
    return true;
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
    if (this.accepted) { try { this.onLateRefusal?.(error, this.refusalContext()); } catch { /* the refusal itself still stands */ } }
  }
  assertNotRefused() { if (this.state === "refused") throw this.refusal; }
  /** What refused the submission, if anything did: a late settlement reads its own line from it (U22 G20 backup refusals). */
  get refusedWith(): unknown { return this.state === "refused" ? this.refusal : undefined; }
  get canRetry() { return this.state !== "unknown" && !this.hasReleasedSubmission; }
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
  readonly #turnIds = new Set<string>();
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
  readonly #ownersByThread = new Map<
    string,
    Map<string, ReturnType<typeof setTimeout>>
  >();
  readonly #clearWaitersByThread = new Map<string, Set<() => void>>();
  readonly #ttlMs: number;

  constructor(ttlMs = 30_000) {
    this.#ttlMs = Math.max(1, Math.floor(ttlMs));
  }

  mark(threadId: string, ownerId: string): void {
    const owners = this.#ownersByThread.get(threadId) ?? new Map<string, ReturnType<typeof setTimeout>>();
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
        const waiters = this.#clearWaitersByThread.get(threadId) ?? new Set<() => void>();
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
