import { BotAvatar, type BotAvatarProps } from "./Avatar";
import { CallAura, useAvatarAura, type CallSignals } from "./CallAura";
import { auraPhaseFor, type AuraPhase, type CallPhase } from "@/lib/call-aura";
import type { EmberState } from "@/lib/mascot";
import { cn } from "@/lib/cn";

export const CALL_AVATAR_SIZE = 220;

export function CallAvatar({
  bot,
  phase,
  held = false,
  inhale = false,
  connecting = false,
  muted = false,
  lost = false,
  signals,
}: {
  bot: BotAvatarProps["bot"];
  phase: CallPhase;
  held?: boolean;
  inhale?: boolean;
  connecting?: boolean;
  muted?: boolean;
  lost?: boolean;
  signals?: CallSignals;
}) {
  // held (the iPhone's engine is paused for a phone call or the like): idle,
  // whatever phase the call was in
  const state = held ? "idle" : phase === "listening" ? "listening" : phase === "speaking" ? "sending" : phase === "sending" ? "thinking" : "working";
  const aura = useAvatarAura(bot);
  const auraPhase = auraPhaseFor({ phase, connecting, muted, held, lost });
  // inhale: heard, and about to speak. A slow, small swell shown only when the
  // wait has run past a moment (inhale.ts); still for people who prefer less motion.
  return <div className={`relative isolate transition-transform duration-[600ms] ease-out ${inhale && !held ? "scale-[1.035]" : ""}`} data-call-avatar-phase={phase} data-call-held={held ? "true" : undefined} data-call-inhale={inhale && !held ? "true" : undefined}>
    {/* the aura's shimmer (thinking, working) is the waiting indicator; it
        follows the avatar's own shape, where a round ring did not */}
    <CallAura phase={auraPhase} size={CALL_AVATAR_SIZE} aura={aura} variant={aura.custom ? "full" : "soft"} signals={signals} />
    <BotAvatar bot={bot} state={state} size={CALL_AVATAR_SIZE} animated trackPointer presentation={aura.presentation} />
  </div>;
}

/** One member of a room call: the one talking (or working) carries the
 *  full aura, the others a quiet one. */
export function MemberCallAvatar({
  member,
  state,
  phase,
  focused,
  working,
  signals,
  size = 94,
}: {
  member: BotAvatarProps["bot"];
  state: EmberState;
  phase: AuraPhase;
  focused: boolean;
  working: boolean;
  signals?: CallSignals;
  size?: number;
}) {
  const aura = useAvatarAura(member);
  return (
    <div className={cn("relative isolate", !focused && "opacity-90")} data-member-aura={focused ? "strong" : "soft"}>
      <CallAura
        phase={focused ? phase : "listening"}
        size={size}
        aura={aura}
        variant={focused && aura.custom ? "full" : "soft"}
        strength={focused ? 1 : 0.55}
        signals={focused ? signals : undefined}
      />
      <BotAvatar
        bot={member}
        state={state}
        size={size}
        animated
        motion={working ? "working" : "none"}
        motionKey={working ? 1 : 0}
        presentation={aura.presentation}
      />
    </div>
  );
}
