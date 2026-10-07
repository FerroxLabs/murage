// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Speaker rows for a room. Several bots share one transcript, so each bot
// turn opens with its name, and a turn that answers something other than the
// row right above it says what, with a jump back to that message.
import { ChevronRight, CornerUpLeft } from "lucide-react";

import { BotAvatar } from "./Avatar";
import { CommAvatar } from "./CommAvatar";
import { normalizeState } from "@/lib/mascot";
import { replySnippet } from "@/lib/replies";
import { replyingToName } from "@/lib/room-speakers";
import { CHIP, CHIP_NAME } from "@/lib/transcript-chrome";
import { cn } from "@/lib/cn";
import type { Bot, EmberColor, Message } from "@/state/store";

/** 16px ember + name, once per bot turn. */
export function RoomSpeakerLabel({
  bot,
  name,
  color,
  replyTo,
  onJump,
}: {
  bot?: Bot;
  name: string;
  color: EmberColor;
  /** The message this turn answers, when it is not the row right above. */
  replyTo?: Message;
  onJump?: () => void;
}) {
  const who = replyTo ? replyingToName(replyTo) : "";
  const snippet = replyTo ? replySnippet(replyTo.text ?? replyTo.tool?.name ?? "", 120) : "";
  return (
    <div data-testid="room-speaker" data-row-chrome="" className="mt-1 flex min-w-0 items-center gap-1.5 pl-0.5">
      <BotAvatar
        bot={bot ?? ({ color } as Bot)}
        state={normalizeState(bot?.mascotExpression) ?? "happy"}
        size={16}
        motion="none"
        motionKey={0}
        animated={false}
      />
      <span className="shrink-0 text-[11px] font-medium text-ink-secondary">{name}</span>
      {replyTo && (
        <button
          type="button"
          onClick={onJump}
          title={snippet}
          aria-label={`${name} is replying to ${who}: ${snippet}. Show that message`}
          className="-my-1 flex min-h-6 min-w-0 items-center gap-1 rounded px-1.5 text-[11px] text-ink-secondary/80 hover:bg-raised hover:text-ink focus-visible:text-ink"
        >
          <CornerUpLeft size={11} aria-hidden="true" className="shrink-0" />
          <span className="truncate">replying to {who}</span>
        </button>
      )}
    </div>
  );
}

/** A room's "Messaged @X" chip: opens the pair room where that exchange
 * lives, the same as the chip in a direct chat. */
export function RoomCommChip({
  label,
  comm,
  bots,
  onOpen,
}: {
  label: string;
  comm: NonNullable<Message["comm"]>;
  bots: Parameters<typeof CommAvatar>[0]["bots"];
  onOpen: () => void;
}) {
  return (
    <div className="flex justify-start">
      <button
        type="button"
        onClick={onOpen}
        title={`Open the conversation with ${comm.withName}`}
        data-testid="tool-chip"
        className={cn(CHIP, "text-left text-ink-secondary hover:bg-raised hover:text-ink")}
      >
        <span className="shrink-0">
          <CommAvatar comm={comm} bots={bots} />
        </span>
        <span data-testid="tool-chip-name" className={CHIP_NAME}>{label}</span>
        <ChevronRight size={13} aria-hidden="true" className="shrink-0" />
      </button>
    </div>
  );
}
