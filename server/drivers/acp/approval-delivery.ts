import type { Writable } from "node:stream";
import type { RuntimeEvent, RuntimeEventListener } from "../../contracts.ts";

export type ApprovalDeliveryFailure = { ok: false; reason: string; terminal: boolean };
export type ApprovalDeliveryResult = { ok: true } | ApprovalDeliveryFailure;
export type ApprovalWriteCallback = (error?: Error | null, accepted?: boolean) => void;

/** Only fixed categories leave the transport: an engine error may contain secrets. */
export function approvalWriteReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return ["EPIPE", "EBADF", "ECONNRESET", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"].includes(code ?? "")
    ? code! : "write_failed";
}

export class ApprovalDeliveryError extends Error {
  readonly status = 503;
  readonly reason: string;
  readonly terminal: boolean;
  constructor(reason: string, terminal: boolean) {
    super(terminal
      ? "The engine stopped before approval delivery could be confirmed. Start a new turn to continue."
      : reason === "delivery_pending" ? "Your earlier answer is still being delivered."
      : reason === "approval_expired" ? "This approval request expired."
      : reason === "approval_cancelled" ? "Your Allow answer was cancelled."
      : "Your approval could not be delivered. The request is still waiting; please try again.");
    this.reason = reason;
    this.terminal = terminal;
  }
}

/** A false write() return means backpressure, not failure. Only its callback confirms delivery. */
export function writeAcpResponse(stream: Writable | null | undefined, obj: unknown, done: ApprovalWriteCallback): void {
  if (!stream || stream.destroyed || stream.writableEnded || !stream.writable) {
    done(Object.assign(new Error("Engine input is closed"), { code: "ERR_STREAM_DESTROYED" }), false);
    return;
  }
  let reported = false;
  const report: ApprovalWriteCallback = (error, accepted) => {
    if (reported) return;
    reported = true;
    done(error, accepted);
  };
  try { stream.write(JSON.stringify(obj) + "\n", error => report(error, true)); }
  catch (error) { report(error instanceof Error ? error : new Error("Write failed"), false); }
}

/** At most 3 writes, 500ms each, with 150/300ms backoff (1950ms total).
 * Retry only before stream acceptance. Callback errors and missing callbacks
 * cannot prove the engine did not read the line; never resend an accepted grant.
 */
export async function deliverApproval(
  write: (done: ApprovalWriteCallback) => void,
  alive: () => boolean,
  signal: AbortSignal,
  onLateResult?: (result: ApprovalDeliveryResult) => void,
): Promise<ApprovalDeliveryResult> {
  let reason = "write_failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted || !alive()) return { ok: false, reason: "engine_stopped", terminal: true };
    const result = await new Promise<ApprovalDeliveryResult>((resolve) => {
      let finished = false;
      let timedOut = false;
      const finish = (result: ApprovalDeliveryResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", stopped);
        resolve(result);
      };
      const stopped = () => finish({ ok: false, reason: "engine_stopped", terminal: true });
      const timer = setTimeout(() => {
        timedOut = alive() && !signal.aborted;
        finish({ ok: false, reason: timedOut ? "delivery_pending" : "engine_stopped", terminal: !timedOut });
      }, 500);
      signal.addEventListener("abort", stopped, { once: true });
      write((error, accepted = true) => {
        const result: ApprovalDeliveryResult = error
          ? { ok: false, reason: approvalWriteReason(error), terminal: accepted || !alive() }
          : { ok: true };
        if (timedOut) { timedOut = false; onLateResult?.(result); }
        else finish(result);
      });
    });
    if (result.ok || result.terminal || result.reason === "delivery_pending") return result;
    reason = result.reason;
    if (attempt < 2) await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, 150 * (attempt + 1));
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  return { ok: false, reason, terminal: signal.aborted || !alive() };
}

/** Keep asynchronous policy replies tied to the request and turn that opened them. */
export function watchApprovalRequest(opened: RuntimeEvent, subscribe: (listener: RuntimeEventListener) => () => void) {
  let live = true;
  const dispose = subscribe(event => {
    if (event.threadId !== opened.threadId) return;
    if (event.type === "turn.started" && (event.turnId !== opened.turnId || event.providerInstanceId !== opened.providerInstanceId)) live = false;
    if (event.providerInstanceId !== opened.providerInstanceId) return;
    if ((event.type === "request.resolved" && event.requestId === opened.requestId && event.turnId === opened.turnId)
      || (event.type === "turn.completed" && event.turnId === opened.turnId)
      || (event.type === "session.exited" && (!event.turnId || event.turnId === opened.turnId))) live = false;
  });
  return {
    live: () => live,
    canFallback: (error: unknown) => live && !(error instanceof ApprovalDeliveryError && error.terminal),
    dispose,
  };
}

/** An automatic denial has no human card to retry from. Surface failure and stop its turn. */
export async function denyAutomaticApproval(
  respond: () => Promise<unknown>,
  stop: () => Promise<unknown>,
  live: () => boolean,
  notice: (message: string) => void,
): Promise<void> {
  try { await respond(); }
  catch {
    if (!live()) return;
    notice("The denial could not be delivered. This turn is being stopped.");
    try { await stop(); }
    catch { notice("The engine did not confirm stopping. Check the engine before starting another turn."); }
  }
}
