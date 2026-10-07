// The "inhale": a soft change in the bot's presence that says "I heard you,
// I am about to speak" when the wait is long enough to notice. It appears
// only once INHALE_AFTER_MS has passed with no audio started, so a fast reply
// never shows it (no flicker), and ends the moment audio starts.

export const INHALE_AFTER_MS = 300;

export interface InhaleTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const real: InhaleTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Inhale {
  private handle: unknown = null;
  private shown = false;

  constructor(
    private readonly onChange: (on: boolean) => void,
    private readonly timers: InhaleTimers = real,
    private readonly afterMs = INHALE_AFTER_MS,
  ) {}

  get on(): boolean {
    return this.shown;
  }

  /** The acknowledgement just went out: start waiting for audio. */
  start(): void {
    this.cancel();
    this.handle = this.timers.set(() => {
      this.handle = null;
      this.shown = true;
      this.onChange(true);
    }, this.afterMs);
  }

  /** Audio started, or the turn ended: no inhale, or end the one showing. */
  cancel(): void {
    if (this.handle !== null) {
      this.timers.clear(this.handle);
      this.handle = null;
    }
    if (this.shown) {
      this.shown = false;
      this.onChange(false);
    }
  }
}
