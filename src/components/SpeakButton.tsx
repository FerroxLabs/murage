import { Loader2, Square, Volume2 } from "lucide-react";

import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { cn } from "@/lib/cn";

/** Read one message aloud. Hover-revealed beside the copy control, and it
 * becomes a stop button while this message is the one speaking — the same
 * button, because "speak" and "shut up" are the same intent twice. */
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
  const speech = useSpeech();
  const mine = speech.messageId === messageId && speech.status !== "idle";
  const preparing = mine && speech.status === "preparing";

  const label = mine ? "Stop speaking" : "Read this aloud";
  return (
    <button
      onClick={() => {
        if (mine) return speaker.stop();
        void speaker.speak(text, { botId, messageId, voiceId });
      }}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md p-1.5 text-ink-secondary transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-focus-within:opacity-100",
        // stays visible while speaking — a stop button you have to hunt for
        // is not a stop button
        mine ? "text-accent opacity-100" : "opacity-0 group-hover:opacity-100",
        className,
      )}
    >
      {preparing ? <Loader2 size={14} className="animate-spin" /> : mine ? <Square size={14} className="fill-current" /> : <Volume2 size={14} />}
    </button>
  );
}
