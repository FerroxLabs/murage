// G3/A6: what ending or redoing a Telegram pairing does to the messages still on their way, in the words the sheet shows.
// A message accepted or queued and not yet sent is cancelled. One being sent at that moment may or may not have been delivered.
// The counts are the server's own (status.pending, status.uncertain); this only turns them into one sentence.
export function endPairingNote(status: { pending: number; uncertain: number } | null | undefined): string {
  const pending = status?.pending ?? 0;
  const uncertain = status?.uncertain ?? 0;
  const parts = [
    pending > 0 ? `${pending === 1 ? "1 waiting message is" : `${pending} waiting messages are`} cancelled and will not be sent.` : "Nothing is waiting to be sent.",
    "A message being sent at that moment may or may not have been delivered.",
  ];
  if (uncertain > 0) parts.push(`${uncertain === 1 ? "1 earlier message" : `${uncertain} earlier messages`} may or may not have been delivered and will not be sent again.`);
  return parts.join(" ");
}
