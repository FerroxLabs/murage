import { useSyncExternalStore } from "react";

import { onLocalVoiceProgress, speaker, type LoadProgress, type SpeechSnapshot } from "./index";

/** Live speaker state. useSyncExternalStore rather than a context: the
 * speaker is a window-wide singleton with no provider to hang off, and
 * only the components that actually render voice UI should re-render when
 * an utterance changes. */
export function useSpeech(): SpeechSnapshot {
  return useSyncExternalStore(
    (fn) => speaker.subscribe(fn),
    () => speaker.state,
    () => speaker.state,
  );
}

let lastProgress: LoadProgress | null = null;
const progressWatchers = new Set<() => void>();
onLocalVoiceProgress((p) => {
  lastProgress = p;
  for (const fn of [...progressWatchers]) fn();
});

/** First-run download progress for the local voice — null once it is
 * cached, which is the normal case after the very first use. */
export function useLocalVoiceProgress(): LoadProgress | null {
  return useSyncExternalStore(
    (fn) => {
      progressWatchers.add(fn);
      return () => progressWatchers.delete(fn);
    },
    () => lastProgress,
    () => lastProgress,
  );
}
