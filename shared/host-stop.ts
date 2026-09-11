// A turn the host stops on its own — not the person's Stop button — settles
// as cancelled with no error card, and the conversation says why it ended
// (STOP1). The notice is one activity message whose tool name carries this
// prefix, the same way a failed turn's chip carries "error:". The prefix is
// the whole contract between the server and the transcripts: a stopped
// notice is never an error (no red card, no Retry) and is never a tool run
// (it stays visible in a 1:1 thread with Settings → Tool calls off).
export const HOST_STOPPED_PREFIX = "stopped:";

/** The activity tool name for a host-initiated stop. */
export function hostStoppedActivityName(reason: string): string {
  return `${HOST_STOPPED_PREFIX} ${reason.trim()}`;
}

/** The reason carried by a host-stop notice, or undefined for any other
 * activity name (a tool run, a comm chip, an "error:" chip). */
export function hostStoppedReason(name: string | undefined | null): string | undefined {
  if (typeof name !== "string" || !name.startsWith(HOST_STOPPED_PREFIX)) return undefined;
  const reason = name.slice(HOST_STOPPED_PREFIX.length).trim();
  return reason || undefined;
}
