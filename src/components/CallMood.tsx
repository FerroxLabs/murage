// The call screen's mood: two washes behind everything, each with its
// opacity set per frame from the live levels. The whole ground turns cool
// blue while the owner talks (a full-screen base plus a wash rising from
// the foot of the screen, where the owner's words appear); the bot's own
// hue floods out from the avatar while it talks. Opacity only, so the
// compositor does the work; the smoother is the only easing, so a phrase
// lights the screen while it is still being said.
import { useEffect, useRef } from "react";

import { auraTicker } from "@/lib/aura-ticker";
import { LevelSmoother } from "@/lib/audio-level";
import { AMBER, frameLevel, MOOD_PEAK, OWNER_BLUE, rgba, type AuraPhase, type Rgb } from "@/lib/call-aura";
import { useActiveSkin } from "@/lib/use-active-skin";
import type { CallSignals } from "./CallAura";

/** The mood's smoothing: quick enough that a one-second phrase reaches its
 *  peak, slow enough on the way down that the pauses in a sentence hold. */
const ATTACK_MS = 160;
const RELEASE_MS = 1100;

export function CallMood({ phase, color, signals }: { phase: AuraPhase; color: Rgb; signals?: CallSignals }) {
  const ownerRef = useRef<HTMLDivElement>(null);
  const botRef = useRef<HTMLDivElement>(null);
  const amber = phase === "held" || phase === "reconnecting";
  const muted = phase === "muted";
  const peak = MOOD_PEAK[useActiveSkin()];
  // One pair of smoothers for the whole call, not one per phase: a wash that
  // is still fading when the phase turns (the owner's, as the bot starts to
  // answer) carries on fading from where it was, instead of starting again
  // from nothing and rising back toward a voice that has only just gone.
  const ownerSmoother = useRef<LevelSmoother | null>(null);
  const botSmoother = useRef<LevelSmoother | null>(null);
  ownerSmoother.current ??= new LevelSmoother(ATTACK_MS, RELEASE_MS);
  botSmoother.current ??= new LevelSmoother(ATTACK_MS, RELEASE_MS);

  useEffect(() => {
    const ownerEl = ownerRef.current;
    const botEl = botRef.current;
    const owner = ownerSmoother.current;
    const bot = botSmoother.current;
    if (!ownerEl || !botEl || !owner || !bot) return;
    const started = performance.now();
    if (muted || amber) {
      // painted still: the next live phase rises from nothing, as shown
      owner.reset();
      bot.reset();
      ownerEl.style.opacity = "0";
      botEl.style.opacity = amber ? (0.25 * peak).toFixed(3) : "0";
      return;
    }
    const frame = (now: number, dt: number) => {
      const step = dt || 16;
      const ownerLevel = signals?.owner.level() ?? 0;
      const botLevel =
        phase === "speaking"
          ? frameLevel({ phase, t: now - started, bot: signals?.bot.level() ?? 0, hearing: signals?.bot.hearing() ?? false, owner: 0 })
          : 0;
      ownerEl.style.opacity = (owner.push(ownerLevel, step) * peak).toFixed(3);
      botEl.style.opacity = (bot.push(botLevel, step) * peak).toFixed(3);
    };
    return auraTicker().subscribe(frame);
  }, [phase, muted, amber, signals, peak]);

  const botColor = amber ? AMBER : color;
  return (
    // -z-10: the washes paint beneath every in-flow sibling (the name, the
    // caption, the controls), which an absolutely positioned layer at z-auto
    // would otherwise cover, pinking the red Hang up and dimming Mute. The
    // parent must be a stacking context (`isolate`) or the washes would drop
    // behind its own background and vanish.
    <div aria-hidden="true" data-call-mood={phase} className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div
        ref={botRef}
        data-mood="bot"
        className="absolute inset-0 opacity-0"
        style={{
          background: [
            `radial-gradient(ellipse 130% 105% at 50% 36%, ${rgba(botColor, 0.62)} 0%, ${rgba(botColor, 0.34)} 35%, ${rgba(botColor, 0.12)} 70%, ${rgba(botColor, 0)} 100%)`,
            `linear-gradient(${rgba(botColor, 0.1)}, ${rgba(botColor, 0.1)})`,
          ].join(", "),
        }}
      />
      <div
        ref={ownerRef}
        data-mood="owner"
        className="absolute inset-0 opacity-0"
        style={{
          background: [
            `radial-gradient(ellipse 140% 95% at 50% 90%, ${rgba(OWNER_BLUE, 0.62)} 0%, ${rgba(OWNER_BLUE, 0.34)} 40%, ${rgba(OWNER_BLUE, 0.1)} 72%, ${rgba(OWNER_BLUE, 0)} 100%)`,
            `linear-gradient(${rgba(OWNER_BLUE, 0.1)}, ${rgba(OWNER_BLUE, 0.1)})`,
          ].join(", "),
        }}
      />
    </div>
  );
}
