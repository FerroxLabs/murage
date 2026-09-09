import { BotAvatar, type BotAvatarProps } from "./Avatar";

export function CallAvatar({ bot, phase }: { bot: BotAvatarProps["bot"]; phase: "listening" | "sending" | "working" | "speaking" }) {
  const waiting = phase === "sending" || phase === "working";
  const state = phase === "listening" ? "listening" : phase === "speaking" ? "sending" : phase === "sending" ? "thinking" : "working";
  return <div className="relative isolate" data-call-avatar-phase={phase}>
    {waiting && <span aria-hidden="true" data-testid="call-waiting-ring" className="pointer-events-none absolute -inset-3 rounded-full border border-accent/30 motion-safe:animate-pulse motion-safe:[animation-duration:3s]" />}
    <BotAvatar bot={bot} state={state} size={220} animated trackPointer />
  </div>;
}
