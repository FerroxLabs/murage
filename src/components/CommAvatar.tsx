import type { Message } from "@/state/store";
import { BotAvatar, type BotAvatarProps } from "./Avatar";

/** Resolve the peer by stable identity, never by a historical display name. */
export function CommAvatar({ comm, bots }: {
  comm: NonNullable<Message["comm"]>;
  bots: readonly (BotAvatarProps["bot"] & { id: string })[];
}) {
  const peer = bots.find(bot => bot.id === comm.withBotId);
  return <BotAvatar bot={peer ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} motion="none" motionKey={0} />;
}
