// P3 (settings v10): what the renderer learns about removing a phone. One shape for "Remove" and "Check again":
// the overall state, the notifications step the harness recorded, and `uncertain` when the companion could not tell
// whether its request landed (a timeout or a closed connection after the request left), so the page never says "Removed" on a guess.
const STATES = new Set(["pending", "removed", "abandoned", "unknown"]);
const STEP = new Set(["not-sent", "harness-queued", "confirmed", "abandoned", "nothing", "unknown"]);

export function removalStatusOf(recorded, { uncertain = false } = {}) {
  const r = recorded && typeof recorded === "object" ? recorded : null;
  const state = r && STATES.has(r.state) ? r.state : "unknown";
  const notifications = r && STEP.has(r.notifications) ? r.notifications : "unknown";
  const removalId = r && typeof r.removalId === "string" && /^[\w-]{1,64}$/.test(r.removalId) ? r.removalId : undefined;
  return { state, notifications, ...(removalId ? { removalId } : {}), uncertain: uncertain || (state === "unknown" && notifications === "unknown") };
}

/** A failure of the control call: an HTTP status means the sidecar answered (the outcome is known: it refused); anything else means the request may have landed. */
export const controlOutcomeUncertain = (error) => !(error && typeof error === "object" && Number.isInteger(error.status));
