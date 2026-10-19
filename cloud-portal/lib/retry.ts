// A billing change in progress holds the home briefly (the control plane answers 409 home_busy). The customer should not have to notice:
// the action is tried again a few times, a moment apart, before it gives up with a plain message.
export const BUSY_RETRIES = 3;
export const BUSY_DELAY_MS = 400;
export async function retryWhileBusy<T>(run: () => Promise<T>, delayMs = BUSY_DELAY_MS, retries = BUSY_RETRIES): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await run(); }
    catch (e) {
      // Matched by shape, not class, so this file stays importable anywhere.
      const busy = typeof e === "object" && e !== null && (e as { code?: unknown }).code === "home_busy";
      if (!busy || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
