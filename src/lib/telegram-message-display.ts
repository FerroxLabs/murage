const OPEN = "[UNTRUSTED TELEGRAM CHANNEL MESSAGE]\n";
const CLOSE = "\n[/UNTRUSTED TELEGRAM CHANNEL MESSAGE]";

/** Presentation only: the envelope remains intact in storage and model input.
 * Only a whole-message envelope is recognized; quoted examples stay literal.
 */
export function telegramMessageDisplay(text: string): { body: string } | null {
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE) || text.length < OPEN.length + CLOSE.length) return null;
  return { body: text.slice(OPEN.length, -CLOSE.length) };
}
