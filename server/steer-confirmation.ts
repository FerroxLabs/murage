/** The one unconfirmed steered message a late engine echo names, by the id the
 * server sent the steer under. Never the oldest, and only from the thread the
 * caller passes (the echo's own). Null when nothing matches. */
export function steerToConfirm<M extends { id: string; role: string; steerUnconfirmed?: boolean; steerId?: string }>(
  threadMessages: readonly M[],
  interjectionId: unknown,
): M | null {
  if (typeof interjectionId !== "string" || interjectionId.length === 0) return null;
  return threadMessages.find((m) => m.role === "user" && m.steerUnconfirmed === true && m.steerId === interjectionId) ?? null;
}
