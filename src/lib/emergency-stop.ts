// The harness's emergency stop (`POST /api/local-computer/interrupt`) answers
// 200 even when it could not confirm every stop, so the Linux panel can still
// disable the driver afterwards. The body carries the truth; this turns it
// into the one line the person sees.

/** A plain sentence when some task did not confirm it stopped, else null. */
export function emergencyStopWarning(result: unknown): string | null {
  if (!result || typeof result !== "object" || (result as { ok?: unknown }).ok !== false) return null;
  const failed = (result as { failed?: unknown }).failed;
  const count = Array.isArray(failed) ? failed.length : 0;
  const subject = count === 1 ? "1 task did" : count > 1 ? `${count} tasks did` : "Some tasks did";
  return `${subject} not confirm ${count === 1 ? "it" : "they"} stopped. Restart Murage if a bot is still using this computer.`;
}
