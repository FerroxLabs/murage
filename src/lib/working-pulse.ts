// The working pulse: a soft, neutral tick that plays on a call while the bot
// is doing something and nobody is speaking, the way a phone assistant makes
// a quiet clicking sound while it looks something up. Silence on a call reads
// as a dropped line; a voice filling every gap reads as chatter. A pulse says
// "still here, still working" without saying anything.
//
// Synthesised with Web Audio: no file to ship, no network, and it stops the
// instant it is told to. It is only ever started for real work (a turn the
// engine is running), never as decoration.

// Same sound as the approved 0.1.59 mockup: a soft two-part blip about once
// a second.
const INTERVAL_MS = 950;

export class WorkingPulse {
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    try {
      this.context ??= new AudioContext();
      void this.context.resume();
    } catch {
      return; // no audio device: the call still works, just quietly
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  /** A soft two-part blip: a heartbeat, not a beep. */
  private tick(): void {
    const ctx = this.context;
    if (!ctx) return;
    const at = ctx.currentTime + 0.01;
    this.blip(ctx, at, 620, 0.07);
    this.blip(ctx, at + 0.11, 740, 0.045);
  }

  private blip(ctx: AudioContext, at: number, freq: number, peak: number): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, at);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.82, at + 0.12);
    filter.type = "lowpass";
    filter.frequency.value = 1800;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    osc.connect(filter).connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.2);
  }
}
