/** Whether this Enter sends the message.
 *
 * Mouse and keyboard: Enter sends, Shift+Enter is a newline (unchanged).
 * Touch: Return is a newline and the arrow button sends — a phone keyboard
 * has no Shift+Return, so without this there is no way to write two lines.
 * ⌘/Ctrl+Enter still sends on touch, for a tablet with a keyboard attached.
 * Never mid-composition: that Enter commits an IME candidate. */
export function enterSends(
  key: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean },
  touch: boolean,
): boolean {
  if (key.key !== "Enter" || key.isComposing) return false;
  if (touch) return key.metaKey || key.ctrlKey;
  return !key.shiftKey;
}
