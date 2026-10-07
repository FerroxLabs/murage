// One frame loop for everything the call screen animates (the aura, the
// mood washes, the read-along): a single requestAnimationFrame, capped at
// 30 frames a second, that stops while the document is hidden and while
// nobody is subscribed. Injectable clocks and schedulers so the pause and
// the cap are unit-tested without a browser.

export interface TickerHost {
  request(fn: (now: number) => void): number;
  cancel(handle: number): void;
  hidden(): boolean;
  onVisibility(fn: () => void): () => void;
  now(): number;
}

const browserHost = (): TickerHost => ({
  request: (fn) => window.requestAnimationFrame(fn),
  cancel: (handle) => window.cancelAnimationFrame(handle),
  hidden: () => typeof document !== "undefined" && document.hidden,
  onVisibility: (fn) => {
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  },
  now: () => performance.now(),
});

export const FRAME_MS = 1000 / 30;

export class AuraTicker {
  private readonly listeners = new Set<(now: number, dt: number) => void>();
  private handle: number | null = null;
  /** The last frame delivered, or null before the first. */
  private last: number | null = null;
  private offVisibility: (() => void) | null = null;
  private readonly host: TickerHost;

  constructor(host?: TickerHost) {
    this.host = host ?? browserHost();
  }

  /** Called every frame while visible; `dt` is the ms since the last frame
   *  (0 on the first). Returns the unsubscribe. */
  subscribe(fn: (now: number, dt: number) => void): () => void {
    this.listeners.add(fn);
    if (this.listeners.size === 1) {
      this.offVisibility = this.host.onVisibility(() => this.sync());
    }
    this.sync();
    return () => {
      this.listeners.delete(fn);
      this.sync();
      if (!this.listeners.size) {
        this.offVisibility?.();
        this.offVisibility = null;
      }
    };
  }

  /** True while a frame is scheduled. */
  get running(): boolean {
    return this.handle !== null;
  }

  private sync() {
    const wanted = this.listeners.size > 0 && !this.host.hidden();
    if (wanted && this.handle === null) {
      this.last = null;
      this.handle = this.host.request(this.frame);
    } else if (!wanted && this.handle !== null) {
      this.host.cancel(this.handle);
      this.handle = null;
    }
  }

  private readonly frame = (now: number) => {
    this.handle = null;
    if (!this.listeners.size || this.host.hidden()) return;
    this.handle = this.host.request(this.frame);
    // the cap: skip frames that come sooner than 30 a second allows
    if (this.last !== null && now - this.last < FRAME_MS - 1) return;
    const dt = this.last === null ? 0 : now - this.last;
    this.last = now;
    for (const fn of [...this.listeners]) fn(now, dt);
  };
}

let shared: AuraTicker | null = null;

/** The window's one loop. */
export function auraTicker(): AuraTicker {
  return (shared ??= new AuraTicker());
}
