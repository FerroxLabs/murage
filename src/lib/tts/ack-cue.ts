// Calls used to play a cached "Mm." in the bot's voice the moment the owner
// finished speaking. Through a real voice it came out as a drawn-out "Hmmm"
// at the start of every reply, so it is gone: the wait is now silent, the
// avatar's inhale shows the bot heard, and only a slow turn says a short
// real phrase ("One sec."), from call-ack.
//
// What is left here clears the old clips from the browser's own store, so
// nothing from that recipe lingers on disk.

export const OLD_CUE_DB = "murage-voice-cues";

/** Drop the stored "Mm." clips. Best effort: blocked or missing storage
 *  just means there is nothing to clear. */
export function dropOldAckCues(idb: Pick<IDBFactory, "deleteDatabase"> | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB): void {
  try {
    idb?.deleteDatabase(OLD_CUE_DB);
  } catch {
    // nothing to clear
  }
}
