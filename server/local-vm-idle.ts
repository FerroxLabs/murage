/** How long a Local VM may sit unused before its disposable container is removed.
 *
 * The container is a memory cost for as long as it runs, so with nothing that
 * could come back for it the window is short. While a routine of a bot that
 * works on a VM is switched on (an overnight run must still find its desktop),
 * the long window keeps it. */
export const LOCAL_VM_IDLE_SHORT_MS = 60 * 60_000;
export const LOCAL_VM_IDLE_LONG_MS = 8 * 60 * 60_000;

/** A one-shot thing already promised to a conversation: a snooze that wakes it at a set time, or a wake it is still owed from
 * a hand-off. Either may bring a turn back to the VM after the short window has passed. */
export function taskMayReturn(task: { snoozedUntil?: number; askerWakes?: unknown }, now: number): boolean {
  return (typeof task.snoozedUntil === "number" && task.snoozedUntil > now) || task.askerWakes !== undefined;
}

/** The idle window for the current state of the machine. */
export function localVmIdleWindowMs(workMayReturn: boolean): number {
  return workMayReturn ? LOCAL_VM_IDLE_LONG_MS : LOCAL_VM_IDLE_SHORT_MS;
}

/** Renewable idle deadline for one Local VM.
 *
 * Activity resets the window. The window may be a function: it is read again
 * when the timer fires, so a window that grew meanwhile (a routine was switched
 * on) re-arms for the rest of it, and the first look is at `firstCheckMs` so a
 * window that shrank is noticed at once. The caller decides how to suspend or
 * recycle the disposable VM, and an active turn or lifecycle operation defers
 * that work for another full window instead of racing current work.
 */
export class LocalVmIdleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private touchedAt = 0;
  private readonly idleMs: number | (() => number);
  private readonly firstCheckMs: number | undefined;
  private readonly isBusy: () => boolean;
  private readonly suspend: () => Promise<void>;

  constructor(idleMs: number | (() => number), isBusy: () => boolean, suspend: () => Promise<void>, firstCheckMs?: number) {
    if (typeof idleMs === "number" && (!Number.isFinite(idleMs) || idleMs <= 0)) throw new Error("Local VM idle timeout must be positive");
    this.idleMs = idleMs;
    this.firstCheckMs = firstCheckMs;
    this.isBusy = isBusy;
    this.suspend = suspend;
  }

  private window(): number {
    const value = typeof this.idleMs === "function" ? this.idleMs() : this.idleMs;
    return Number.isFinite(value) && value > 0 ? value : LOCAL_VM_IDLE_LONG_MS;
  }

  touch(): void {
    this.cancel();
    this.touchedAt = Date.now();
    const first = typeof this.idleMs === "function" && this.firstCheckMs !== undefined ? Math.min(this.firstCheckMs, this.window()) : this.window();
    this.arm(first);
  }

  private arm(delayMs: number): void {
    this.timer = setTimeout(() => void this.expire(), delayMs);
    this.timer.unref?.();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async expire(): Promise<void> {
    this.timer = null;
    if (typeof this.idleMs === "function" && !this.isBusy()) {
      const remaining = this.touchedAt + this.window() - Date.now();
      if (remaining > 1_000) {
        this.arm(remaining);
        return;
      }
    }
    if (this.isBusy()) {
      this.touch();
      return;
    }
    try {
      await this.suspend();
    } catch {
      // A transient runtime failure must not disable the cost/resource
      // backstop forever. Retry after a fresh full idle window.
      this.touch();
    }
  }
}
