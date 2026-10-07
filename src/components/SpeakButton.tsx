import { Loader2, Square, Volume2 } from "lucide-react";

import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { isReading, readAloudLabel, toggleReadAloud } from "@/lib/read-aloud";

/** Read one reply aloud. Hover-revealed beside the copy control, and it
 * becomes Stop while this message is the one being read: "read" and "stop"
 * are the same intent twice.
 *
 * Hidden when the workspace has no voice endpoint at all, the same check the
 * call button uses (`tts.configured`): a control that can only fail is noise.
 * With an endpoint but no voice picked for this bot it stays, disabled, saying
 * what it needs. What is read (code left out) and the one-at-a-time rule live
 * in src/lib/read-aloud.ts. */
export function SpeakButton({
  text,
  botId,
  messageId,
  voiceId,
  className,
}: {
  text: string;
  botId?: string;
  messageId: string;
  voiceId?: string;
  className?: string;
}) {
  const { state } = useStore();
  const speech = useSpeech();
  const tts = state.config?.tts;
  const configured = Boolean(tts?.configured);
  if (!configured) return null;
  const ready = Boolean(voiceId || tts?.voice);
  const mine = isReading(speech, messageId);
  const preparing = mine && speech.status === "preparing";

  const label = readAloudLabel({ playing: mine, ready });
  return (
    <button
      onClick={() => toggleReadAloud(speaker, { text, botId, messageId, voiceId })}
      disabled={!ready && !mine}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md p-1.5 text-ink-secondary transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-focus-within:opacity-100 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-secondary",
        // stays visible while speaking: a stop button you have to hunt for
        // is not a stop button
        mine ? "text-accent opacity-100" : "opacity-0 group-hover:opacity-100",
        className,
      )}
    >
      {preparing ? <Loader2 size={14} className="animate-spin" /> : mine ? <Square size={14} className="fill-current" /> : <Volume2 size={14} />}
    </button>
  );
}
