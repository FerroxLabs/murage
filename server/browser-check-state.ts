// Per-turn state of the "Checking the browser" note.
//
//   checking -> verified | unavailable-continue | stopped(user|host|desktop)
//            |  failed-retry | interrupted (boot only)
//
// The FIRST terminal event wins: once a turn's note has left "checking", a
// later event (a host stop arriving after the person's, a verification that
// rejects after a stop, the turn's own terminal handling) never rewrites it.
// The one refinement allowed is naming WHY a stop happened: a stop recorded
// as the person's (the default when nothing else claimed it) can be
// attributed to the host or a desktop action, because that is the same stop
// described more truthfully, not a second event.
//
// Every check-driven transition names the note it belongs to: a check that was
// replaced by a newer turn can still settle ITS OWN note, and never the
// replacement's. Host stop and the turn's terminal event act on the thread's
// current turn.
//
// The fallback wording ("this turn ran without it") is published only from
// unavailable-continue, and only after the turn is confirmed still live.
import { BROWSER_CHECKED_REASON, BROWSER_CHECK_FAILED_REASON, browserUnavailableActivityName } from "../shared/browser-unavailable.ts";
import { STOPPED_MID_DESKTOP_ACTION, hostStoppedActivityName } from "../shared/host-stop.ts";

export type BrowserCheckPhase = "checking" | "verified" | "unavailable-continue" | "stopped" | "failed-retry" | "interrupted";
export type BrowserCheckStopReason = "user" | "host" | "desktop";

interface Entry { threadId: string; noteId: string; phase: BrowserCheckPhase; stop?: { reason: BrowserCheckStopReason; hostReason?: string } }

export interface BrowserCheckNotes {
  /** Rewrite the note row in place (persisted and broadcast by the caller). */
  patch(threadId: string, noteId: string, tool: { name: string; ok: boolean }): void;
}

const STOPPED_NOTE = "Stopped by you";

export class BrowserCheckTurns {
  private readonly byThread = new Map<string, Entry>();
  /** Every note still owned by a check, including one a newer turn replaced as the thread's current. */
  private readonly byNote = new Map<string, Entry>();
  private readonly notes: BrowserCheckNotes;
  constructor(notes: BrowserCheckNotes) { this.notes = notes; }

  /** A turn's checking note is on screen. A newer turn replaces an older entry. */
  begin(threadId: string, noteId: string): void {
    const entry: Entry = { threadId, noteId, phase: "checking" };
    // A replaced entry that already settled has nothing left to say; one still checking keeps settling its own note.
    const prior = this.byThread.get(threadId);
    if (prior && prior.phase !== "checking") this.byNote.delete(prior.noteId);
    this.byThread.set(threadId, entry);
    this.byNote.set(noteId, entry);
  }

  /** The entry a check-driven transition may act on: only the one bound to that note. */
  private own(threadId: string, noteId: string): Entry | undefined {
    const entry = this.byNote.get(noteId);
    return entry && entry.threadId === threadId ? entry : undefined;
  }

  /** A settled entry that is no longer the thread's current turn has nothing left to refine. */
  private release(threadId: string, entry: Entry): void {
    if (this.byThread.get(threadId) !== entry) this.byNote.delete(entry.noteId);
  }
  phase(threadId: string): BrowserCheckPhase | undefined { return this.byThread.get(threadId)?.phase; }
  stopReason(threadId: string): BrowserCheckStopReason | undefined { return this.byThread.get(threadId)?.stop?.reason; }

  private write(threadId: string, entry: Entry, name: string, ok: boolean): void {
    try { this.notes.patch(threadId, entry.noteId, { name, ok }); } catch { /* the note is progress only */ }
  }

  private stopName(entry: Entry): { name: string; ok: boolean } {
    const stop = entry.stop;
    if (stop?.reason === "host") return { name: hostStoppedActivityName(stop.hostReason ?? ""), ok: false };
    if (stop?.reason === "desktop") return { name: STOPPED_MID_DESKTOP_ACTION, ok: true };
    return { name: STOPPED_NOTE, ok: true };
  }

  private settleStopped(threadId: string, entry: Entry, stop: NonNullable<Entry["stop"]>): void {
    entry.phase = "stopped";
    entry.stop = stop;
    const { name, ok } = this.stopName(entry);
    this.write(threadId, entry, name, ok);
  }

  /** The check finished and the turn has its browser. A no-op if the turn already left "checking". */
  verified(threadId: string, noteId: string): BrowserCheckPhase | undefined {
    const entry = this.own(threadId, noteId);
    if (!entry || entry.phase !== "checking") return entry?.phase;
    entry.phase = "verified";
    this.write(threadId, entry, browserUnavailableActivityName(BROWSER_CHECKED_REASON), true);
    this.release(threadId, entry);
    return entry.phase;
  }

  /** The turn goes on without the browser. The fallback wording is written only if the turn is still live; otherwise the turn was stopped. */
  continueWithout(threadId: string, noteId: string, reason: string, stillLive: () => boolean): BrowserCheckPhase | undefined {
    const entry = this.own(threadId, noteId);
    if (!entry || entry.phase !== "checking") return entry?.phase;
    if (!stillLive()) { this.settleStopped(threadId, entry, { reason: "user" }); this.release(threadId, entry); return entry.phase; }
    entry.phase = "unavailable-continue";
    this.write(threadId, entry, browserUnavailableActivityName(reason), true);
    this.release(threadId, entry);
    return entry.phase;
  }

  /** The turn was stopped during the check (cause unknown here: the person's stop unless a host or desktop stop claims it). */
  stopped(threadId: string, noteId: string): BrowserCheckPhase | undefined {
    const entry = this.own(threadId, noteId);
    if (!entry || entry.phase !== "checking") return entry?.phase;
    this.settleStopped(threadId, entry, { reason: "user" });
    // A stop stays refinable (host or desktop naming) only while it is the thread's current turn.
    this.release(threadId, entry);
    return entry.phase;
  }

  /** The turn failed during the check: say the check did not finish (never the fallback wording). */
  failed(threadId: string, noteId: string): BrowserCheckPhase | undefined {
    const entry = this.own(threadId, noteId);
    if (!entry || entry.phase !== "checking") return entry?.phase;
    entry.phase = "failed-retry";
    this.write(threadId, entry, browserUnavailableActivityName(BROWSER_CHECK_FAILED_REASON), true);
    this.release(threadId, entry);
    return entry.phase;
  }

  /** The host stopped the turn (not the person). True when the checking note carries that stop line, so no second line is appended. */
  hostStop(threadId: string, hostReason: string): boolean {
    const entry = this.byThread.get(threadId);
    if (!entry) return false;
    if (entry.phase === "checking") { this.settleStopped(threadId, entry, { reason: "host", hostReason }); return true; }
    if (entry.phase !== "stopped") return false;
    // Already stopped: the same stop, named truthfully. A stop the host or desktop already named stays as it was.
    if (entry.stop?.reason === "user") this.settleStopped(threadId, entry, { reason: "host", hostReason });
    return true;
  }

  /** The turn's terminal event. True when the checking note carries the stop line (the caller appends none). Forgets the turn. */
  terminal(threadId: string, outcome: { stopped: boolean; desktopAction: boolean }): boolean {
    const entry = this.byThread.get(threadId);
    if (!entry) return false;
    this.byThread.delete(threadId);
    this.byNote.delete(entry.noteId);
    if (entry.phase === "checking") {
      if (!outcome.stopped) { entry.phase = "failed-retry"; this.write(threadId, entry, browserUnavailableActivityName(BROWSER_CHECK_FAILED_REASON), true); return false; }
      this.settleStopped(threadId, entry, { reason: outcome.desktopAction ? "desktop" : "user" });
      return true;
    }
    if (entry.phase !== "stopped" || !outcome.stopped) return false;
    if (outcome.desktopAction && entry.stop?.reason === "user") this.settleStopped(threadId, entry, { reason: "desktop" });
    return true;
  }
}

type CheckResult = null | { unavailable: string } | object;

/** Run one turn's browser check and settle its note. `inner` registers the note with `turns.begin` (and sets `check.id`) when it shows one. */
export async function runBrowserCheck<R extends CheckResult>(
  turns: BrowserCheckTurns,
  threadId: string,
  stillValid: () => boolean,
  inner: (check: { id?: string }) => Promise<R>,
): Promise<R | (R & { noted: true })> {
  const check: { id?: string } = {};
  let result: R;
  try {
    result = await inner(check);
  } catch (error) {
    if (check.id) turns.failed(threadId, check.id);
    throw error;
  }
  const unavailable = result !== null && "unavailable" in result;
  // The fallback only goes out for a turn that is still live; a verification that rejected after a stop is a stop.
  if (unavailable && !stillValid()) { if (check.id) turns.stopped(threadId, check.id); return null as R; }
  if (!check.id) return result;
  if (result === null) { turns.stopped(threadId, check.id); return result; }
  if (unavailable) {
    const phase = turns.continueWithout(threadId, check.id, String((result as { unavailable: string }).unavailable), stillValid);
    return phase === "unavailable-continue" ? { ...result, noted: true } : (null as R);
  }
  turns.verified(threadId, check.id);
  return result;
}
