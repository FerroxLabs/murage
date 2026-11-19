/**
 * Runs a test body and then its cleanup request. A cleanup problem (a throw or a
 * failure status) never replaces the body's own failure and never passes silently:
 * it is appended to the body's error, or thrown when the body passed.
 */
export async function cleanupAfter<T>(
  body: () => Promise<T>,
  cleanup: () => Promise<{ status: number; body?: unknown }>,
  label = "cleanup",
): Promise<T> {
  let value: T | undefined, failed = false, failure: unknown;
  try { value = await body(); } catch (error) { failed = true; failure = error; }
  let problem: string | null = null;
  try {
    const response = await cleanup();
    if (!(response.status >= 200 && response.status < 300))
      problem = `${label} answered HTTP ${response.status}: ${JSON.stringify(response.body ?? null).slice(0, 2000)}`;
  } catch (error) {
    problem = `${label} threw: ${String(error)}`;
  }
  if (failed) {
    if (problem && failure instanceof Error) failure.message += `\n[${problem}]`;
    throw failure;
  }
  if (problem) throw new Error(problem);
  return value as T;
}
