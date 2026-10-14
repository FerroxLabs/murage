// Open and Show-in-folder reach the desktop shell over IPC. Electron wraps a
// refusal in its channel text ("Error invoking remote method '...': Error:
// ..."), and a local server that is momentarily busy surfaces as a timeout.
// People see one plain sentence either way: the server's own wording when it
// gave one, and "Murage is busy" for a timeout.

const IPC_REJECTION = /^Error invoking remote method ['"][^'"\r\n]+['"]:\s*/i;
const TIMEOUT = /\b(?:TimeoutError|AbortError)\b|operation was aborted due to timeout|\btimed? ?out\b/i;

export const NATIVE_ACTION_BUSY = "Murage is busy finishing something. Try again in a moment.";

export function isNativeActionTimeout(cause: unknown): boolean {
  return TIMEOUT.test(cause instanceof Error ? `${cause.name} ${cause.message}` : String(cause ?? ""));
}

export function nativeActionMessage(cause: unknown, fallback: string): string {
  if (isNativeActionTimeout(cause)) return NATIVE_ACTION_BUSY;
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const text = raw.replace(IPC_REJECTION, "").replace(/^(?:[A-Za-z]*Error):\s*/, "").trim();
  return text || fallback;
}

/** Runs one native action. A timeout is retried once after a short wait; any
 * remaining failure is rethrown as an Error carrying the plain sentence. */
export async function runNativeAction(call: () => Promise<void>, fallback: string, waitMs = 1200): Promise<void> {
  try { return await call(); }
  catch (first) {
    if (isNativeActionTimeout(first)) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
      try { return await call(); } catch (second) { throw new Error(nativeActionMessage(second, fallback)); }
    }
    throw new Error(nativeActionMessage(first, fallback));
  }
}
