/** Responses from concurrent status reads may arrive after a newer action. */
export function acceptBrowserGeneration(current: number | undefined, next: unknown): boolean {
  return typeof next === "number" && Number.isSafeInteger(next) && next > 0 && (current === undefined || next >= current);
}
/** Only this frame-read race is expected. Authentication, privacy and input
 * refusals remain visible even when they also use an HTTP conflict status. */
export function expectedStaleBrowserFrame(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 409 && error.message === "Browser frame generation is stale";
}
