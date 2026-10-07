// Whether this device can start a call, and what to say when it cannot.
// A bot call can be heard by a Mac's own dictation or by hosted transcription
// (Flux, or the owner's own OpenAI or Groq key) on any platform. A channel
// call is driven only by the Mac's speech helper (GroupCall has no CallMic),
// so offering it on a phone, Windows or Linux put the call on "Listening"
// forever with no microphone (callbar-rereview3.md A9).

export const MAC_ONLY_LABEL = "Channel calls are available in Murage on a Mac";
export const MAC_ONLY_REASON = "Channel calls use your Mac's own speech recognition, so they can only be started from Murage on a Mac. You can still call a single bot from here.";

export function callSupport(options: { macSpeech: boolean; hostedSpeech: boolean; macOnly: boolean }): {
  supported: boolean;
  label: string | null;
  reason: string | null;
} {
  if (options.macOnly && !options.macSpeech) return { supported: false, label: MAC_ONLY_LABEL, reason: MAC_ONLY_REASON };
  return { supported: options.macSpeech || options.hostedSpeech, label: null, reason: null };
}

/** The channel-call button is for a desktop. A phone, or any page without
 *  the desktop bridge (no `window.muragebox`), can never place a channel
 *  call, so a disabled button there is only a dot and a pop-up about
 *  something it cannot fix. A desktop that cannot call yet (Windows, Linux)
 *  keeps its button, which explains itself. */
export function showsGroupCallButton(o: { desktopBridge: boolean; phone: boolean }): boolean {
  return o.desktopBridge && !o.phone;
}

/** Where the "Call unavailable" panel's left edge goes, in px from the
 *  button's own left edge. It hangs from the button's right edge, then is
 *  clamped so both its sides stay `margin` inside the viewport, wherever the
 *  button is. A viewport narrower than the panel gets a narrower panel (the
 *  panel is also capped with max-w), and still starts inside the margin. */
export function helpPanelLeft(button: { left: number; right: number }, viewportWidth: number, panelWidth = 280, margin = 12): number {
  const width = Math.min(panelWidth, viewportWidth - margin * 2);
  const wanted = button.right - width;
  const clamped = Math.max(margin, Math.min(wanted, viewportWidth - margin - width));
  return clamped - button.left;
}
